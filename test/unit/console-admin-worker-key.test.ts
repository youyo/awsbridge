// コンソールログインの Admin の Worker に Admin の署名の部品（X1 の決裁）をつないだときの振る舞い。
//   - 鍵（Workers の secret_key 型 = 取り出せない CryptoKey のバインディング）と vars（ADMIN_CURRENT_KEY・ADMIN_PUBLIC_JWKS）が
//     揃えば 9 段目で署名して STS → getSigninToken → 302。STS に渡した JWT は Admin の issuer の JWKS で検証できる
//   - Admin の issuer の文書（discovery・JWKS）は Admin の issuer のホスト（Standard の issuer・ポータルと別のホスト）の /admin で出す（A-3 = I-B）
//   - 鍵が無い・使えない・vars の公開鍵と合わないなら 503 signing_unavailable（STS を呼ばない）。vars の形の誤りは 500
//   - Access JWT の iat からの経過時間の上限（既定 15 分。ACCESS_MAX_AGE_SECONDS）
//   - デプロイ後の確認（GET <team-base>/key-check）は Access の検証の後ろで、鍵の性質と kid だけを返す
// 試験の鍵は手元の WebCrypto で取り出せない形に作る（本番の secret_key と同じ CryptoKey の形）。
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingNameForKid, type PublicJwk } from "../../src/console/admin/key";
import { createAdminWorker } from "../../src/console/admin/worker";
import { AUDIENCE, TEAM_TAG_KEY } from "../../src/console/constants";
import { AWS_SOURCE_IDENTITY_CLAIM, AWS_TAGS_CLAIM } from "../../src/console/issue/claims";
import { createStandardWorker } from "../../src/console/standard/worker";
import { buildDiscovery } from "../../src/oidc";
import {
  ADMIN_ENTRY,
  ADMIN_HOST,
  ADMIN_PORTAL,
  ADMIN_TEAM,
  AUDS,
  adminConfig,
  adminEnv,
  baseEnv,
  createHarness,
  EMAIL,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  PORTAL_HOST,
  SUB,
  standardConfig,
} from "./console-standard-harness";

const ADMIN_ISSUER = "https://admin-id.example.com/admin";
const ADMIN_ISSUER_HOST = "admin-id.example.com";
const ADMIN_AUD = AUDS.teams[ADMIN_TEAM] as string;
const TEAM_PATH = `/t/${ADMIN_TEAM}`;

type TestKey = { privateKey: CryptoKey; publicJwk: PublicJwk; kid: string; binding: string };

async function makeKey(extractable = false): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    extractable,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = await calculateJwkThumbprint({ kty: "RSA", n: pub.n as string, e: pub.e as string });
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: "RSA", n: pub.n as string, e: "AQAB", kid, alg: "RS256", use: "sig" },
    kid,
    binding: bindingNameForKid(kid),
  };
}

let a: TestKey;
let b: TestKey;
beforeAll(async () => {
  a = await makeKey();
  b = await makeKey();
});

let h: Harness;
let logs: string[];
beforeEach(async () => {
  h = await createHarness();
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

/** 鍵つきの env。current の鍵で署名し、jwks を公開する。binding の値は差し替えられる。 */
function keyedEnv(
  o: {
    current?: TestKey;
    jwks?: TestKey[];
    bindingValue?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const current = o.current ?? a;
  return adminEnv(h, {
    ADMIN_CURRENT_KEY: JSON.stringify({ binding: current.binding, kid: current.kid }),
    ADMIN_PUBLIC_JWKS: JSON.stringify((o.jwks ?? [current]).map((k) => k.publicJwk)),
    [current.binding]: "bindingValue" in o ? o.bindingValue : current.privateKey,
    ...(o.extra ?? {}),
  });
}

const worker = (config: unknown = adminConfig()) =>
  createAdminWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });

async function post(env: Record<string, unknown>, p: { iat?: number } = {}) {
  const jwt = await h.accessJwt({ aud: ADMIN_AUD, email: EMAIL, ...(p.iat ? { iat: p.iat } : {}) });
  const csrf = await h.csrf(ADMIN_AUD);
  return worker().fetch(
    loginRequest({
      host: ADMIN_HOST,
      path: `${TEAM_PATH}/login`,
      origin: ADMIN_PORTAL,
      jwt,
      form: { entry: ADMIN_ENTRY, region: "ap-northeast-1", csrf },
    }),
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

describe("生成物の対照: Admin の issuer は Standard の issuer と別のホストの /admin", () => {
  it("Admin の生成物の境界の issuer", () => {
    expect(adminConfig().boundaries).toEqual([{ name: "managed", issuer: ADMIN_ISSUER }]);
    expect(ADMIN_ISSUER_HOST).not.toBe(ISSUER_HOST);
  });
});

describe("Admin の Worker: 鍵があれば 9 段目で署名して 302（擬似 STS）", () => {
  it("STS に渡した JWT は Admin の issuer の JWKS（Worker が出すもの）で検証でき、iss・aud・exp=iat+300・kid・タグ・SourceIdentity を持つ", async () => {
    const env = keyedEnv();
    const res = await post(env);
    expect(res.status, await res.clone().text()).toBe(302);
    expect(res.headers.get("Location")).toMatch(
      /^https:\/\/signin\.aws\.amazon\.com\/federation\?/,
    );
    expect(h.seen.sts).toHaveLength(1);
    expect(h.seen.signin).toHaveLength(1);
    const sts = h.seen.sts[0] as URLSearchParams;
    expect(sts.get("RoleArn")).toBe(
      "arn:aws:iam::333333333333:role/awsbridge-console/admin/FederatedAdministrator",
    );
    const token = sts.get("WebIdentityToken") as string;
    const jwks = (await (
      await get(ADMIN_ISSUER_HOST, "/admin/.well-known/jwks.json", env)
    ).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: ADMIN_ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
    });
    expect(decodeProtectedHeader(token).kid).toBe(a.kid);
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
    expect(payload.sub).toBe(EMAIL);
    expect(payload[AWS_TAGS_CLAIM]).toEqual({ principal_tags: { [TEAM_TAG_KEY]: [ADMIN_TEAM] } });
    expect(payload[AWS_SOURCE_IDENTITY_CLAIM]).toBe(EMAIL);
    const rec = logs.find((l) => l.includes('"console_issue"') && l.includes('"ok"'));
    expect(rec).toBeDefined();
    // 鍵・JWT・email はログに出ない
    const all = logs.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(EMAIL);
  });

  it("2 回の発行の jti は違う", async () => {
    const env = keyedEnv();
    expect((await post(env)).status).toBe(302);
    expect((await post(env)).status).toBe(302);
    const jti = h.seen.sts.map((p) => {
      const t = p.get("WebIdentityToken") as string;
      return JSON.parse(atob((t.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/")))
        .jti;
    });
    expect(new Set(jti).size).toBe(2);
  });

  it("差し替えの間（JWKS に新旧 2 つ、署名は新しい鍵）も 302", async () => {
    const env = keyedEnv({ current: b, jwks: [a, b] });
    expect((await post(env)).status).toBe(302);
    const token = (h.seen.sts[0] as URLSearchParams).get("WebIdentityToken") as string;
    expect(decodeProtectedHeader(token).kid).toBe(b.kid);
  });
});

describe("Admin の Worker: 鍵が使えなければ 503 signing_unavailable（STS を呼ばない）", () => {
  it("ADMIN_CURRENT_KEY が無ければ 503（従来どおり。公開鍵だけあっても）", async () => {
    expect((await post(adminEnv(h))).status).toBe(503);
    const res = await post(adminEnv(h, { ADMIN_PUBLIC_JWKS: JSON.stringify([a.publicJwk]) }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
    noIssue();
  });

  it.each([
    ["バインディングが無い", undefined],
    ["バインディングが文字列（secret_text の JWK）", JSON.stringify({ kty: "RSA", d: "x" })],
    ["バインディングが JWK のオブジェクト", { kty: "RSA", n: "x", e: "AQAB", d: "y" }],
  ])("%s なら 503", async (_n, value) => {
    const res = await post(keyedEnv({ bindingValue: value }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
    noIssue();
  });

  it("取り出せる秘密鍵（extractable true）なら 503", async () => {
    const x = await makeKey(true);
    expect((await post(keyedEnv({ current: x }))).status).toBe(503);
    noIssue();
  });

  it("鍵だけ替えて公開鍵（vars）を替え忘れた（自己検証が合わない）なら 503", async () => {
    const res = await post(keyedEnv({ bindingValue: b.privateKey }));
    expect(res.status).toBe(503);
    noIssue();
    expect(logs.join("\n")).toContain("admin_key_self_verify_failed");
  });
});

describe("Admin の Worker: vars の形の誤りは 500 server_misconfigured", () => {
  it.each([
    ["ADMIN_CURRENT_KEY が JSON でない", { ADMIN_CURRENT_KEY: "nope" }],
    [
      "ADMIN_CURRENT_KEY の名前が規則と違う",
      () => ({
        ADMIN_CURRENT_KEY: JSON.stringify({ binding: b.binding, kid: a.kid }),
        ADMIN_PUBLIC_JWKS: JSON.stringify([a.publicJwk]),
      }),
    ],
    [
      "今の kid が公開鍵に無い",
      () => ({
        ADMIN_CURRENT_KEY: JSON.stringify({ binding: a.binding, kid: a.kid }),
        ADMIN_PUBLIC_JWKS: JSON.stringify([b.publicJwk]),
      }),
    ],
    [
      "今の鍵があるのに公開鍵が無い",
      () => ({ ADMIN_CURRENT_KEY: JSON.stringify({ binding: a.binding, kid: a.kid }) }),
    ],
    [
      "公開鍵に秘密の成分",
      () => ({ ADMIN_PUBLIC_JWKS: JSON.stringify([{ ...a.publicJwk, d: "x" }]) }),
    ],
    ["ACCESS_MAX_AGE_SECONDS が数でない", { ACCESS_MAX_AGE_SECONDS: "15m" }],
    ["ACCESS_MAX_AGE_SECONDS が小さすぎる", { ACCESS_MAX_AGE_SECONDS: "59" }],
    ["ACCESS_MAX_AGE_SECONDS が大きすぎる", { ACCESS_MAX_AGE_SECONDS: "86401" }],
  ])("%s", async (_n, extra) => {
    const env = adminEnv(h, typeof extra === "function" ? extra() : extra);
    const res = await post(env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("server_misconfigured");
    noIssue();
  });
});

describe("Admin の Worker: Access JWT の iat からの経過時間の上限（既定 15 分）", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("iat が 15 分より前なら POST も画面も 401（鍵があっても発行しない）", async () => {
    const res = await post(keyedEnv(), { iat: now() - 901 });
    expect(res.status).toBe(401);
    noIssue();
    const jwt = await h.accessJwt({ aud: ADMIN_AUD, iat: now() - 901 });
    for (const page of ["/", "/a/333333333333", "/login"]) {
      expect((await get(ADMIN_HOST, `${TEAM_PATH}${page}`, keyedEnv(), { jwt })).status, page).toBe(
        401,
      );
    }
  });

  it("iat が 14 分前なら通る", async () => {
    expect((await post(keyedEnv(), { iat: now() - 840 })).status).toBe(302);
  });

  it("ACCESS_MAX_AGE_SECONDS で上限を変えられる（600 なら 11 分前は 401）", async () => {
    const env = keyedEnv({ extra: { ACCESS_MAX_AGE_SECONDS: "600" } });
    expect((await post(env, { iat: now() - 660 })).status).toBe(401);
    expect((await post(env, { iat: now() - 540 })).status).toBe(302);
  });

  it("Standard の Worker は上限を見ない（古い iat でも従来どおり）", async () => {
    const std = createStandardWorker(standardConfig(), {
      getAccessKey: h.getAccessKey,
      fetch: h.fetch,
    });
    const jwt = await h.accessJwt({ aud: AUDS.teams.infra as string, iat: now() - 3000 });
    const res = await std.fetch(
      new Request(`https://${PORTAL_HOST}/t/infra/`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      baseEnv(h),
    );
    expect(res.status).toBe(200);
  });
});

describe("Admin の issuer の文書（Admin の issuer のホストの /admin。Standard の issuer のホストではない）", () => {
  it("discovery は Standard と同じ形で issuer と jwks_uri が Admin の issuer", async () => {
    const res = await get(ADMIN_ISSUER_HOST, "/admin/.well-known/openid-configuration", keyedEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual(buildDiscovery(ADMIN_ISSUER));
  });

  it("JWKS は vars の公開鍵（新旧 2 つ）だけで、秘密の成分を持たない", async () => {
    const res = await get(
      ADMIN_ISSUER_HOST,
      "/admin/.well-known/jwks.json",
      keyedEnv({ current: b, jwks: [a, b] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toEqual([a.publicJwk, b.publicJwk]);
    for (const k of body.keys)
      for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(k).not.toHaveProperty(m);
  });

  it("鍵のバインディングが無くても（公開鍵の vars だけでも）文書は出せる", async () => {
    const env = adminEnv(h, { ADMIN_PUBLIC_JWKS: JSON.stringify([a.publicJwk]) });
    expect((await get(ADMIN_ISSUER_HOST, "/admin/.well-known/jwks.json", env)).status).toBe(200);
  });

  it("公開鍵の vars が無ければ 404（公開する鍵が無い）", async () => {
    for (const doc of ["jwks.json", "openid-configuration"]) {
      expect((await get(ADMIN_ISSUER_HOST, `/admin/.well-known/${doc}`, adminEnv(h))).status).toBe(
        404,
      );
    }
  });

  it("HEAD は 200 で本文なし、POST は 405", async () => {
    const env = keyedEnv();
    const head = await get(ADMIN_ISSUER_HOST, "/admin/.well-known/jwks.json", env, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const p = await get(ADMIN_ISSUER_HOST, "/admin/.well-known/jwks.json", env, { method: "POST" });
    expect(p.status).toBe(405);
  });

  it.each([
    "/",
    "/admin",
    "/admin/",
    "/.well-known/jwks.json",
    "/.well-known/openid-configuration",
    "/standard/.well-known/jwks.json",
    "/admin/.well-known/jwks.json/x",
    "/admin/x",
    `${TEAM_PATH}/`,
    `${TEAM_PATH}/login`,
    `${TEAM_PATH}/key-check`,
  ])("Admin の issuer のホストの %s は 404（チームのパスにも届かない）", async (path) => {
    for (const method of ["GET", "POST"]) {
      expect(
        (await get(ADMIN_ISSUER_HOST, path, keyedEnv(), { method })).status,
        `${method} ${path}`,
      ).toBe(404);
    }
    noIssue();
  });

  it("issuer のホストの文書でない経路は env を読む前に 404（env が壊れていても）。文書の経路は env が壊れていれば 500", async () => {
    expect((await get(ADMIN_ISSUER_HOST, "/admin/x", {})).status).toBe(404);
    expect((await get(ADMIN_ISSUER_HOST, "/admin/.well-known/jwks.json", {})).status).toBe(500);
  });

  it("ポータルのホスト・Standard の issuer のホストでは Admin の文書を出さない（404）", async () => {
    for (const host of [ADMIN_HOST, ISSUER_HOST, PORTAL_HOST]) {
      for (const doc of ["jwks.json", "openid-configuration"]) {
        expect((await get(host, `/admin/.well-known/${doc}`, keyedEnv())).status, host).toBe(404);
      }
    }
  });

  it("Standard の Worker は Admin の issuer のホストの文書を出さない（404）", async () => {
    const std = createStandardWorker(standardConfig(), {
      getAccessKey: h.getAccessKey,
      fetch: h.fetch,
    });
    for (const doc of ["jwks.json", "openid-configuration"]) {
      const res = await std.fetch(
        new Request(`https://${ADMIN_ISSUER_HOST}/admin/.well-known/${doc}`),
        baseEnv(h),
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("デプロイ後の確認: GET <team-base>/key-check（Access の検証の後ろ。鍵の性質と kid だけ）", () => {
  it("回数の制限: LOGIN_RATE_LIMITER をキー admin-key-check:<Access の sub> で使い、制限を超えたら 429・binding が無ければ 500・例外は 503", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const keys: string[] = [];
    const limiter = (success: boolean) => ({
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success };
      },
    });
    const okRes = await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({ extra: { LOGIN_RATE_LIMITER: limiter(true) } }),
      { jwt },
    );
    expect(okRes.status).toBe(200);
    expect(keys).toEqual([`admin-key-check:${SUB}`]);
    const limited = await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({ extra: { LOGIN_RATE_LIMITER: limiter(false) } }),
      { jwt },
    );
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("rate_limited");
    const none = await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({ extra: { LOGIN_RATE_LIMITER: undefined } }),
      { jwt },
    );
    expect(none.status).toBe(500);
    expect(await none.text()).toContain("server_misconfigured");
    const thrown = await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({
        extra: {
          LOGIN_RATE_LIMITER: {
            limit: async () => {
              throw new Error("x");
            },
          },
        },
      }),
      { jwt },
    );
    expect(thrown.status).toBe(503);
    // JWT が無ければ制限の前に 401（回数を数えない）
    keys.length = 0;
    await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({ extra: { LOGIN_RATE_LIMITER: limiter(true) } }),
    );
    expect(keys).toEqual([]);
  });

  it("Access JWT が無ければ 401、Standard のチームの AUD なら 403（外から叩けない）", async () => {
    expect((await get(ADMIN_HOST, `${TEAM_PATH}/key-check`, keyedEnv())).status).toBe(401);
    const jwt = await h.accessJwt({ aud: AUDS.teams.infra as string });
    expect((await get(ADMIN_HOST, `${TEAM_PATH}/key-check`, keyedEnv(), { jwt })).status).toBe(403);
  });

  it("Admin のチームの JWT なら、取り出せない・exportKey が失敗する・自己検証が通ることを返す（鍵の中身・署名は返さない）", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const res = await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({ current: b, jwks: [a, b] }),
      { jwt },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      configured: true,
      binding: b.binding,
      kid: b.kid,
      present: true,
      usable: true,
      extractable: false,
      usages: ["sign"],
      exportKey: "rejected",
      selfVerify: "ok",
      publicKids: [a.kid, b.kid],
    });
    expect(text).not.toMatch(/[A-Za-z0-9_-]{100,}/);
    noIssue();
  });

  it("鍵が無い・合わないことも返す（configured false・selfVerify failed）", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const none = await get(ADMIN_HOST, `${TEAM_PATH}/key-check`, adminEnv(h), { jwt });
    expect(await none.json()).toEqual({ configured: false, publicKids: [] });
    const wrong = await get(
      ADMIN_HOST,
      `${TEAM_PATH}/key-check`,
      keyedEnv({ bindingValue: b.privateKey }),
      { jwt },
    );
    expect(await wrong.json()).toMatchObject({
      configured: true,
      usable: true,
      selfVerify: "failed",
    });
  });

  it("POST は 405", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    expect(
      (await get(ADMIN_HOST, `${TEAM_PATH}/key-check`, keyedEnv(), { jwt, method: "POST" })).status,
    ).toBe(405);
  });

  it("Standard の Worker の key-check は Standard の境界の鍵だけを返し、Admin の鍵・vars を見ない（Admin の JWT は通らない）", async () => {
    const std = createStandardWorker(standardConfig(), {
      getAccessKey: h.getAccessKey,
      fetch: h.fetch,
    });
    const env = baseEnv(h, keyedEnv());
    const stdJwt = await h.accessJwt({ aud: AUDS.teams.infra as string });
    const res = await std.fetch(
      new Request(`https://${PORTAL_HOST}/t/infra/key-check`, {
        headers: { "Cf-Access-Jwt-Assertion": stdJwt },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Object.keys((JSON.parse(text) as { boundaries: object }).boundaries).sort()).toEqual([
      "managed",
      "partner:partner-x",
    ]);
    expect(text).not.toContain(a.kid);
    expect(text).not.toContain("ADMIN");
    const adminJwt = await h.accessJwt({ aud: ADMIN_AUD });
    const denied = await std.fetch(
      new Request(`https://${PORTAL_HOST}/t/infra/key-check`, {
        headers: { "Cf-Access-Jwt-Assertion": adminJwt },
      }),
      env,
    );
    expect(denied.status).toBe(403);
  });
});
