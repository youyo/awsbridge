// コンソールログインの Standard の Worker の署名鍵（cto の決裁「Standard も secret_key に揃える」）:
// 境界ごとの Workers の secret_key 型のバインディング（取り出せない CryptoKey）で署名し、vars の公開鍵で JWKS を出して自己検証する。
//   STANDARD_CURRENT_KEYS  境界 → 今の署名鍵 {binding: STANDARD_KEY_<16 進>, kid}
//   STANDARD_PUBLIC_JWKS   境界 → 公開鍵 JWK の配列（新旧 2 つまで）
// 振る舞い（9 段・エラーコード）は従来どおり: vars が無い・壊れている → 500、その境界の鍵が無い・使えない → 503 signing_unavailable。
import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIENCE } from "../../src/console/constants";
import { createStandardWorker } from "../../src/console/standard/worker";
import {
  AUDS,
  baseEnv,
  createHarness,
  EMAIL,
  ENTRY,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  makeStandardKey,
  PORTAL_HOST,
  STD_ISSUER,
  standardConfig,
  standardKeyEnv,
  type TestKey,
} from "./console-standard-harness";

const INFRA = AUDS.teams.infra as string;
/** infra のチームが Viewer で入れる、partner:partner-x の境界の行。 */
const PARTNER_ENTRY = "222222222222:readonly";
const PARTNER_ISSUER = "https://id.example.com/partner-x";

let h: Harness;
let logs: string[];
let managed: TestKey;
let partner: TestKey;
let next: TestKey;
beforeAll(async () => {
  next = await makeStandardKey();
});
beforeEach(async () => {
  h = await createHarness();
  managed = h.stdKeys.managed as TestKey;
  partner = h.stdKeys["partner:partner-x"] as TestKey;
  logs = [];
  const sink = (...x: unknown[]) => {
    logs.push(x.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(sink);
  vi.spyOn(console, "error").mockImplementation(sink);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const worker = () =>
  createStandardWorker(standardConfig(), { getAccessKey: h.getAccessKey, fetch: h.fetch });

async function post(env: Record<string, unknown>, entry = ENTRY) {
  const jwt = await h.accessJwt({ aud: INFRA, email: EMAIL });
  const csrf = await h.csrf(INFRA);
  return worker().fetch(
    loginRequest({ jwt, form: { entry, region: "ap-northeast-1", csrf } }),
    env,
  );
}

async function get(
  host: string,
  path: string,
  env: Record<string, unknown>,
  o: { jwt?: string; method?: string } = {},
) {
  const headers = new Headers();
  if (o.jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", o.jwt);
  return worker().fetch(
    new Request(`https://${host}${path}`, { method: o.method ?? "GET", headers }),
    env,
  );
}

const noIssue = () => {
  expect(h.seen.sts).toHaveLength(0);
  expect(h.seen.signin).toHaveLength(0);
};

const tokenAt = (i: number) => (h.seen.sts[i] as URLSearchParams).get("WebIdentityToken") as string;

async function jwksOf(env: Record<string, unknown>, path: string): Promise<JSONWebKeySet> {
  const res = await get(ISSUER_HOST, path, env);
  expect(res.status).toBe(200);
  return (await res.json()) as JSONWebKeySet;
}

describe("Standard の Worker: 境界ごとの取り出せない鍵で署名する", () => {
  it("managed の行は managed の鍵（kid）で署名し、その境界の issuer の JWKS で検証できる", async () => {
    const env = baseEnv(h);
    expect((await post(env)).status).toBe(302);
    const token = tokenAt(0);
    expect(decodeProtectedHeader(token).kid).toBe(managed.kid);
    const jwks = await jwksOf(env, "/standard/.well-known/jwks.json");
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: STD_ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
    // 鍵・JWT・email はログに出ない
    const all = logs.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(EMAIL);
  });

  it("partner の行は partner の鍵で署名し、managed の JWKS では検証できない（境界の鍵を混ぜない）", async () => {
    const env = baseEnv(h);
    expect((await post(env, PARTNER_ENTRY)).status).toBe(302);
    const token = tokenAt(0);
    expect(decodeProtectedHeader(token).kid).toBe(partner.kid);
    const own = await jwksOf(env, "/partner-x/.well-known/jwks.json");
    await jwtVerify(token, createLocalJWKSet(own), { issuer: PARTNER_ISSUER, audience: AUDIENCE });
    const other = await jwksOf(env, "/standard/.well-known/jwks.json");
    await expect(jwtVerify(token, createLocalJWKSet(other))).rejects.toThrow();
  });

  it("JWKS はその境界の vars の公開鍵だけ（新旧 2 つ）で、秘密の成分を持たない", async () => {
    const env = baseEnv(
      h,
      standardKeyEnv(h.stdKeys, { managed: [managed, next], "partner:partner-x": [partner] }),
    );
    const jwks = await jwksOf(env, "/standard/.well-known/jwks.json");
    expect(jwks.keys).toEqual([managed.publicJwk, next.publicJwk]);
    expect(JSON.stringify(jwks)).not.toMatch(/"(d|p|q|dp|dq|qi)"/);
    expect((await jwksOf(env, "/partner-x/.well-known/jwks.json")).keys).toEqual([
      partner.publicJwk,
    ]);
  });

  it("差し替えの間（JWKS に新旧 2 つ、署名は新しい鍵）も 302", async () => {
    const env = baseEnv(
      h,
      standardKeyEnv(
        { managed: next, "partner:partner-x": partner },
        { managed: [managed, next], "partner:partner-x": [partner] },
      ),
    );
    expect((await post(env)).status).toBe(302);
    expect(decodeProtectedHeader(tokenAt(0)).kid).toBe(next.kid);
  });
});

describe("Standard の Worker: その境界の鍵が使えなければ 503 signing_unavailable（STS を呼ばない）", () => {
  it.each([
    ["バインディングが無い", undefined],
    ["バインディングが文字列（secret_text の JWK）", JSON.stringify({ kty: "RSA", d: "x" })],
    ["バインディングが JWK のオブジェクト", { kty: "RSA", n: "x", e: "AQAB", d: "y" }],
  ])("%s なら 503", async (_n, value) => {
    const env = baseEnv(h, { [managed.binding]: value });
    const res = await post(env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
    noIssue();
    expect(logs.join("\n")).toContain("standard_key_unusable");
    // ほかの境界は影響を受けない
    expect((await post(env, PARTNER_ENTRY)).status).toBe(302);
  });

  it("取り出せる秘密鍵（extractable true）なら 503", async () => {
    const x = await makeStandardKey(true);
    const res = await post(baseEnv(h, standardKeyEnv({ ...h.stdKeys, managed: x })));
    expect(res.status).toBe(503);
    noIssue();
  });

  it("鍵だけ替えて公開鍵（vars）を替え忘れた（自己検証が合わない）なら 503", async () => {
    const res = await post(baseEnv(h, { [managed.binding]: partner.privateKey }));
    expect(res.status).toBe(503);
    noIssue();
    expect(logs.join("\n")).toContain("standard_key_self_verify_failed");
  });
});

describe("Standard の Worker: vars の形の誤りは 500 server_misconfigured", () => {
  const cur = (m: Record<string, { binding: string; kid: string }>) => JSON.stringify(m);
  it.each([
    ["STANDARD_CURRENT_KEYS が配列", () => ({ STANDARD_CURRENT_KEYS: "[]" })],
    ["STANDARD_CURRENT_KEYS が空のオブジェクト", () => ({ STANDARD_CURRENT_KEYS: "{}" })],
    [
      "名前が kid の規則と違う",
      () => ({
        STANDARD_CURRENT_KEYS: cur({ managed: { binding: partner.binding, kid: managed.kid } }),
      }),
    ],
    [
      "名前が Admin の接頭辞",
      () => ({
        STANDARD_CURRENT_KEYS: cur({
          managed: { binding: `ADMIN_KEY_${managed.binding.slice(-16)}`, kid: managed.kid },
        }),
      }),
    ],
    [
      "今の kid がその境界の公開鍵に無い（別の境界にはある）",
      () => standardKeyEnv({ managed }, { managed: [partner], "partner:partner-x": [managed] }),
    ],
    [
      "今の鍵がある境界に公開鍵が無い",
      () => standardKeyEnv({ managed, "partner:partner-x": partner }, { managed: [managed] }),
    ],
    [
      "同じ鍵が 2 つの境界にある",
      () =>
        standardKeyEnv(
          { managed, "partner:partner-x": managed },
          { managed: [managed], "partner:partner-x": [managed] },
        ),
    ],
    [
      "公開鍵に秘密の成分",
      () => ({
        STANDARD_PUBLIC_JWKS: JSON.stringify({
          managed: [{ ...managed.publicJwk, d: "x" }],
          "partner:partner-x": [partner.publicJwk],
        }),
      }),
    ],
    [
      "公開鍵が 3 つ",
      () =>
        standardKeyEnv(h.stdKeys, {
          managed: [managed, next, partner],
          "partner:partner-x": [partner],
        }),
    ],
    [
      "文字列の秘密鍵の secret（旧い CONSOLE_SIGNING_KEYS）だけがある",
      () => ({
        STANDARD_CURRENT_KEYS: undefined,
        STANDARD_PUBLIC_JWKS: undefined,
        CONSOLE_SIGNING_KEYS: JSON.stringify({ managed: { kty: "RSA" } }),
      }),
    ],
  ])("%s", async (_n, extra) => {
    const env = baseEnv(h, extra());
    const res = await post(env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("server_misconfigured");
    noIssue();
    expect((await get(ISSUER_HOST, "/standard/.well-known/jwks.json", env)).status).toBe(500);
    expect(logs.join("\n")).toContain("invalid console env: signing_keys");
  });
});

describe("デプロイ後の確認: GET <team-base>/key-check（Access の検証の後ろ。境界ごとの鍵の性質と kid だけ）", () => {
  it("Standard のチームの JWT なら、境界ごとに取り出せない・exportKey が失敗する・自己検証が通ることを返す", async () => {
    const jwt = await h.accessJwt({ aud: INFRA });
    const env = baseEnv(
      h,
      standardKeyEnv(h.stdKeys, { managed: [managed, next], "partner:partner-x": [partner] }),
    );
    const res = await get(PORTAL_HOST, "/t/infra/key-check", env, { jwt });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    const status = (k: TestKey, publicKids: string[]) => ({
      configured: true,
      binding: k.binding,
      kid: k.kid,
      present: true,
      usable: true,
      extractable: false,
      usages: ["sign"],
      exportKey: "rejected",
      selfVerify: "ok",
      publicKids,
    });
    expect(JSON.parse(text)).toEqual({
      boundaries: {
        managed: status(managed, [managed.kid, next.kid]),
        "partner:partner-x": status(partner, [partner.kid]),
      },
    });
    expect(text).not.toMatch(/[A-Za-z0-9_-]{100,}/);
    noIssue();
  });

  it("そのチームの行がある境界だけを返す（ほかの境界の名前と kid を出さない）", async () => {
    // dev のチームから partner の行を外した生成物
    const config = standardConfig();
    for (const a of config.accounts)
      if (a.boundary === "partner:partner-x")
        a.roles = a.roles
          .map((r) => ({ ...r, teams: r.teams.filter((t) => t !== "dev") }))
          .filter((r) => r.teams.length > 0);
    const w = createStandardWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });
    const dev = AUDS.teams.dev as string;
    const res = await w.fetch(
      new Request(`https://${PORTAL_HOST}/t/dev/key-check`, {
        headers: { "Cf-Access-Jwt-Assertion": await h.accessJwt({ aud: dev }) },
      }),
      baseEnv(h),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Object.keys((JSON.parse(text) as { boundaries: object }).boundaries)).toEqual([
      "managed",
    ]);
    expect(text).not.toContain("partner");
    expect(text).not.toContain(partner.kid);
  });

  it("鍵が無い境界・合わない鍵も返す（configured false・selfVerify failed）", async () => {
    const jwt = await h.accessJwt({ aud: INFRA });
    const env = baseEnv(h, {
      ...standardKeyEnv({ managed }),
      [managed.binding]: partner.privateKey,
    });
    const body = (await (await get(PORTAL_HOST, "/t/infra/key-check", env, { jwt })).json()) as {
      boundaries: Record<string, Record<string, unknown>>;
    };
    expect(body.boundaries.managed).toMatchObject({ configured: true, selfVerify: "failed" });
    expect(body.boundaries["partner:partner-x"]).toEqual({ configured: false, publicKids: [] });
  });

  it("回数の制限は LOGIN_RATE_LIMITER をキー standard-key-check:<Access の sub> で使う。JWT が無ければ 401（数えない）", async () => {
    const keys: string[] = [];
    const limiter = (success: boolean) => ({
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success };
      },
    });
    expect(
      (
        await get(
          PORTAL_HOST,
          "/t/infra/key-check",
          baseEnv(h, { LOGIN_RATE_LIMITER: limiter(true) }),
        )
      ).status,
    ).toBe(401);
    expect(keys).toEqual([]);
    const jwt = await h.accessJwt({ aud: INFRA });
    const limited = await get(
      PORTAL_HOST,
      "/t/infra/key-check",
      baseEnv(h, { LOGIN_RATE_LIMITER: limiter(false) }),
      { jwt },
    );
    expect(limited.status).toBe(429);
    expect(keys).toEqual([
      `standard-key-check:${(await import("./console-standard-harness")).SUB}`,
    ]);
  });

  it("POST は 405", async () => {
    const jwt = await h.accessJwt({ aud: INFRA });
    expect(
      (await get(PORTAL_HOST, "/t/infra/key-check", baseEnv(h), { jwt, method: "POST" })).status,
    ).toBe(405);
  });
});
