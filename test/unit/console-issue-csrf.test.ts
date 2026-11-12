// コンソールログイン: CSRF トークン（docs/specs/console-login-portal.md §9.5）。
// HMAC-SHA256(csrf_key, version|AUD|sub|iat) で AUD に束縛し、期限は 10 分（司令塔の決定）。
import { beforeAll, describe, expect, it } from "vitest";
import {
  CSRF_TOKEN_VERSION,
  CSRF_TTL_SECONDS,
  type CsrfResult,
  createCsrfToken,
  importCsrfKey,
  verifyCsrfToken,
} from "../../src/console/issue/csrf";

// 秘密と AUD は実行時に組み立てる（直書きしない）
const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const NOW = 1_800_000_000;
const SUB = "11111111-2222-3333-4444-555555555555";
const audA = randomHex(32);
const audB = randomHex(32);

let key: CryptoKey;
let otherKey: CryptoKey;
beforeAll(async () => {
  key = await importCsrfKey(randomHex(32));
  otherKey = await importCsrfKey(randomHex(32));
});

const reasonOf = (r: CsrfResult) => (r.ok ? "ok" : r.reason);

describe("AUD への束縛", () => {
  it("チーム A の AUD で作ったトークンをチーム B で使うと csrf_failed", async () => {
    const token = await createCsrfToken(key, { aud: audA, sub: SUB }, NOW);
    const r = await verifyCsrfToken(key, token, { aud: audB, sub: SUB }, NOW + 1);
    expect(r).toMatchObject({ ok: false, status: 403, code: "csrf_failed", reason: "mismatch" });
  });

  it("同じ AUD・同じ sub なら通る", async () => {
    const token = await createCsrfToken(key, { aud: audA, sub: SUB }, NOW);
    expect(await verifyCsrfToken(key, token, { aud: audA, sub: SUB }, NOW + 1)).toEqual({
      ok: true,
    });
  });

  it("別の利用者（sub 違い）は mismatch", async () => {
    const token = await createCsrfToken(key, { aud: audA, sub: SUB }, NOW);
    const r = await verifyCsrfToken(key, token, { aud: audA, sub: `${SUB}0` }, NOW + 1);
    expect(reasonOf(r)).toBe("mismatch");
  });

  it("別の鍵で作ったトークンは mismatch", async () => {
    const token = await createCsrfToken(otherKey, { aud: audA, sub: SUB }, NOW);
    expect(reasonOf(await verifyCsrfToken(key, token, { aud: audA, sub: SUB }, NOW))).toBe(
      "mismatch",
    );
  });

  it("トークンに AUD と sub をそのまま載せない", async () => {
    const token = await createCsrfToken(key, { aud: audA, sub: SUB }, NOW);
    expect(token).not.toContain(audA);
    expect(token).not.toContain(SUB);
    expect(token.startsWith(`${CSRF_TOKEN_VERSION}.`)).toBe(true);
  });
});

describe("期限（10 分）", () => {
  it("期限は 600 秒", () => {
    expect(CSRF_TTL_SECONDS).toBe(600);
  });

  it("発行から 600 秒ちょうどは通り、601 秒は expired", async () => {
    const token = await createCsrfToken(key, { aud: audA, sub: SUB }, NOW);
    const b = { aud: audA, sub: SUB };
    expect(reasonOf(await verifyCsrfToken(key, token, b, NOW + 600))).toBe("ok");
    expect(await verifyCsrfToken(key, token, b, NOW + 601)).toMatchObject({
      ok: false,
      status: 403,
      code: "csrf_failed",
      reason: "expired",
    });
  });

  it("発行時刻を書き換えて延命すると mismatch（MAC に発行時刻を含む）", async () => {
    const token = await createCsrfToken(key, { aud: audA, sub: SUB }, NOW);
    const [v, , mac] = token.split(".");
    const extended = `${v}.${NOW + 3000}.${mac}`;
    expect(
      reasonOf(await verifyCsrfToken(key, extended, { aud: audA, sub: SUB }, NOW + 3001)),
    ).toBe("mismatch");
  });

  it("未来の発行時刻（時計ずれ 30 秒を超える）は not_yet_valid", async () => {
    const b = { aud: audA, sub: SUB };
    const token = await createCsrfToken(key, b, NOW + 31);
    expect(reasonOf(await verifyCsrfToken(key, token, b, NOW))).toBe("not_yet_valid");
    const near = await createCsrfToken(key, b, NOW + 30);
    expect(reasonOf(await verifyCsrfToken(key, near, b, NOW))).toBe("ok");
  });
});

describe("形式", () => {
  const b = () => ({ aud: audA, sub: SUB });

  it("ない・空は missing", async () => {
    expect(reasonOf(await verifyCsrfToken(key, null, b(), NOW))).toBe("missing");
    expect(reasonOf(await verifyCsrfToken(key, undefined, b(), NOW))).toBe("missing");
    expect(reasonOf(await verifyCsrfToken(key, "", b(), NOW))).toBe("missing");
  });

  it("壊れた形は malformed", async () => {
    const good = await createCsrfToken(key, b(), NOW);
    const [, iat, mac] = good.split(".");
    for (const t of [
      "x",
      `v2.${iat}.${mac}`,
      `${CSRF_TOKEN_VERSION}.${iat}`,
      `${CSRF_TOKEN_VERSION}.${iat}.${mac}.x`,
      `${CSRF_TOKEN_VERSION}.abc.${mac}`,
      `${CSRF_TOKEN_VERSION}.-1.${mac}`,
      `${CSRF_TOKEN_VERSION}.${iat}.${mac?.slice(1)}`,
      `${CSRF_TOKEN_VERSION}.${iat}.${mac}=`,
      `${CSRF_TOKEN_VERSION}.${iat}.${"+".repeat(43)}`,
      ` ${good}`,
    ]) {
      expect(reasonOf(await verifyCsrfToken(key, t, b(), NOW)), t).toBe("malformed");
    }
  });

  it("MAC の 1 文字を変えると mismatch", async () => {
    const good = await createCsrfToken(key, b(), NOW);
    const [v, iat, mac = ""] = good.split(".");
    const first = mac[0] === "A" ? "B" : "A";
    const tampered = `${v}.${iat}.${first}${mac.slice(1)}`;
    expect(reasonOf(await verifyCsrfToken(key, tampered, b(), NOW))).toBe("mismatch");
  });

  it("区切り（|）を含む AUD・sub では作らず、検証も通さない（束縛の取り違えを防ぐ）", async () => {
    await expect(createCsrfToken(key, { aud: `${audA}|x`, sub: SUB }, NOW)).rejects.toThrow();
    await expect(createCsrfToken(key, { aud: audA, sub: "" }, NOW)).rejects.toThrow();
    const token = await createCsrfToken(key, b(), NOW);
    expect(reasonOf(await verifyCsrfToken(key, token, { aud: audA, sub: `${SUB}|` }, NOW))).toBe(
      "mismatch",
    );
    expect(reasonOf(await verifyCsrfToken(key, token, { aud: "", sub: SUB }, NOW))).toBe(
      "mismatch",
    );
  });
});

describe("鍵", () => {
  it("32 バイト未満・空の秘密は受け付けない（fail closed）", async () => {
    await expect(importCsrfKey("")).rejects.toThrow();
    await expect(importCsrfKey("a".repeat(31))).rejects.toThrow();
  });

  it("鍵の文面をエラーに出さない", async () => {
    const short = randomHex(8);
    await expect(importCsrfKey(short)).rejects.not.toThrow(short);
  });
});
