// 外から取った issuer の discovery と JWKS が、設定の公開鍵と一致するかの判定（src/console/exposure.ts。純粋な関数）。
// 誤りにするもの: HTTP 200 以外・リダイレクト（追わない）・取得の失敗・JSON でない・形が違う・issuer / jwks_uri の違い・
// 鍵の増減・鍵の中身（n など）の違い。一致のときだけ ok。応答の値（n・kid・issuer の文字列）は出力に入れない。
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DocResponse,
  exposureExitCode,
  formatExposure,
  judgeDiscovery,
  judgeJwks,
} from "../../src/console/exposure";
import { importGraph } from "./import-graph";

const ISSUER = "https://id.example.com/standard";
const key = (kid: string, n = `n-${kid}`) => ({
  kty: "RSA" as const,
  n,
  e: "AQAB",
  kid,
  alg: "RS256" as const,
  use: "sig" as const,
});
const A = key("kid-a");
const B = key("kid-b");

const doc = (json: unknown, status = 200): DocResponse => ({ kind: "response", status, json });
const good = (issuer = ISSUER) =>
  doc({
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["id_token"],
  });
const bad = (checks: { ok: boolean }[]) => checks.some((c) => !c.ok);
const allOk = (checks: { ok: boolean }[]) => checks.length > 0 && checks.every((c) => c.ok);

describe("judgeDiscovery", () => {
  it("issuer と jwks_uri が合い、HTTP 200 なら一致", () => {
    expect(allOk(judgeDiscovery(ISSUER, good()))).toBe(true);
  });

  it("issuer が違えば誤り（末尾のスラッシュ違いも）", () => {
    expect(bad(judgeDiscovery(ISSUER, good("https://evil.example.com/standard")))).toBe(true);
    expect(bad(judgeDiscovery(ISSUER, good(`${ISSUER}/`)))).toBe(true);
  });

  it("jwks_uri が違えば誤り", () => {
    const r = doc({ issuer: ISSUER, jwks_uri: "https://evil.example.com/jwks.json" });
    const checks = judgeDiscovery(ISSUER, r);
    expect(bad(checks)).toBe(true);
    expect(
      checks
        .filter((c) => !c.ok)
        .map((c) => c.message)
        .join(" "),
    ).toContain("jwks_uri");
  });

  it("HTTP 200 以外は誤り（404・500）", () => {
    expect(bad(judgeDiscovery(ISSUER, doc({ issuer: ISSUER }, 404)))).toBe(true);
    expect(bad(judgeDiscovery(ISSUER, doc({ issuer: ISSUER }, 500)))).toBe(true);
  });

  it("リダイレクトは追わずに誤り（本文が正しくても）", () => {
    const r: DocResponse = {
      kind: "response",
      status: 302,
      location: "https://other.example.com/x",
      json: { issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` },
    };
    const checks = judgeDiscovery(ISSUER, r);
    expect(bad(checks)).toBe(true);
    expect(checks.map((c) => c.message).join(" ")).toContain("リダイレクト");
  });

  it("JSON でない（json が undefined）・オブジェクトでない・取得の失敗は誤り", () => {
    expect(bad(judgeDiscovery(ISSUER, { kind: "response", status: 200 }))).toBe(true);
    expect(bad(judgeDiscovery(ISSUER, doc(["x"])))).toBe(true);
    expect(bad(judgeDiscovery(ISSUER, doc(null)))).toBe(true);
    expect(bad(judgeDiscovery(ISSUER, { kind: "error", reason: "timeout" }))).toBe(true);
  });
});

describe("judgeJwks", () => {
  it("設定の鍵と同じ（順序が違ってもよい）なら一致", () => {
    expect(allOk(judgeJwks([A, B], doc({ keys: [B, A] })))).toBe(true);
    expect(allOk(judgeJwks([A], doc({ keys: [A] })))).toBe(true);
  });

  it("鍵が増えていたら誤り（余分な鍵）", () => {
    const checks = judgeJwks([A], doc({ keys: [A, B] }));
    expect(bad(checks)).toBe(true);
    expect(checks.map((c) => c.message).join(" ")).toContain("設定に無い");
  });

  it("鍵が減っていたら誤り（欠けた鍵）", () => {
    const checks = judgeJwks([A, B], doc({ keys: [A] }));
    expect(bad(checks)).toBe(true);
    expect(checks.map((c) => c.message).join(" ")).toContain("無い");
  });

  it("kid が同じでも n が違えば誤り（差し替え）", () => {
    const checks = judgeJwks([A], doc({ keys: [{ ...A, n: "n-other" }] }));
    expect(bad(checks)).toBe(true);
    expect(checks.map((c) => c.message).join(" ")).toContain("n");
  });

  it("e・kty・alg・use の違い、余分なメンバーも誤り", () => {
    for (const k of [
      { ...A, e: "AQAC" },
      { ...A, kty: "EC" },
      { ...A, alg: "RS384" },
      { ...A, use: "enc" },
      { ...A, d: "secret" },
    ])
      expect(bad(judgeJwks([A], doc({ keys: [k] })))).toBe(true);
  });

  it("kid の重複・kid の無い鍵・keys が配列でない・空は誤り", () => {
    expect(bad(judgeJwks([A], doc({ keys: [A, A] })))).toBe(true);
    expect(bad(judgeJwks([A], doc({ keys: [{ ...A, kid: undefined }] })))).toBe(true);
    expect(bad(judgeJwks([A], doc({ keys: "x" })))).toBe(true);
    expect(bad(judgeJwks([A], doc({ keys: [] })))).toBe(true);
    expect(bad(judgeJwks([A], doc({})))).toBe(true);
  });

  it("期待の鍵が 0 本なら誤り（空の JWKS と空の期待を一致にしない）", () => {
    for (const r of [doc({ keys: [] }), doc({ keys: [A] })]) {
      const checks = judgeJwks([], r);
      expect(bad(checks)).toBe(true);
      expect(allOk(checks)).toBe(false);
    }
  });

  it("HTTP 200 以外・リダイレクト・JSON でない・取得の失敗は誤り", () => {
    expect(bad(judgeJwks([A], doc({ keys: [A] }, 404)))).toBe(true);
    expect(
      bad(
        judgeJwks([A], {
          kind: "response",
          status: 301,
          location: "https://x",
          json: { keys: [A] },
        }),
      ),
    ).toBe(true);
    expect(bad(judgeJwks([A], { kind: "response", status: 200 }))).toBe(true);
    expect(bad(judgeJwks([A], { kind: "error", reason: "dns" }))).toBe(true);
  });

  it("誤りの文に応答の値（n・応答の kid）を入れない。端末の制御文字も出さない", () => {
    const evil = {
      ...key("\u001b[31mEVIL-kid-with-a-very-long-name-xxxxxxxxxxxxxxxx", "SECRET-N-VALUE"),
    };
    const checks = judgeJwks([A], doc({ keys: [A, evil, { ...B, n: "ANOTHER-N-VALUE" }] }));
    const text = checks.map((c) => c.message).join("\n");
    expect(text).not.toContain("SECRET-N-VALUE");
    expect(text).not.toContain("ANOTHER-N-VALUE");
    expect(text).not.toContain("\u001b");
  });
});

describe("formatExposure と終了コード", () => {
  const ok = { ok: true, message: "OK の文" };
  const ng = { ok: false, message: "NG の文" };

  it("全部 ok なら 0、ひとつでも誤りなら 1", () => {
    expect(exposureExitCode([{ label: "a", issuer: ISSUER, checks: [ok] }])).toBe(0);
    expect(
      exposureExitCode([
        { label: "a", issuer: ISSUER, checks: [ok] },
        { label: "b", issuer: ISSUER, checks: [ok, ng] },
      ]),
    ).toBe(1);
  });

  it("対象が 0 件は一致にしない（1）", () => {
    expect(exposureExitCode([])).toBe(1);
  });

  it("出力は [OK] / [NG] の行と結論。アカウント ID・email は伏せる", () => {
    const text = formatExposure([
      {
        label: "Standard 境界 managed",
        issuer: ISSUER,
        checks: [ok, { ok: false, message: "x 012345678901 a@example.com" }],
      },
    ]);
    expect(text).toContain("[OK] OK の文");
    expect(text).toContain("[NG]");
    expect(text).toContain(ISSUER);
    expect(text).not.toContain("012345678901");
    expect(text).not.toContain("a@example.com");
  });
});

describe("置き場所", () => {
  const root = new URL("../../", import.meta.url).pathname;

  it("どの Worker のエントリからも届かず、IAM の検査の判定（inspect.ts）にも依存しない", () => {
    for (const entry of [
      "src/index.ts",
      "src/console/standard/index.ts",
      "src/console/admin/index.ts",
    ]) {
      const files = importGraph(join(root, entry)).files.map((f) => relative(root, f));
      expect(files, entry).not.toContain("src/console/exposure.ts");
    }
    const own = importGraph(join(root, "scripts/console/exposure-check.ts")).files.map((f) =>
      relative(root, f),
    );
    // 陽性の対照: CLI は判定の部品に届いている
    expect(own).toContain("src/console/exposure.ts");
    expect(own).not.toContain("src/console/inspect.ts");
  });
});
