// コンソールログインの Worker（1 つ）で、Admin の階層のチームを境界の鍵で発行するときの振る舞い（P2（B）の設計メモ §5・§7.3）。
// P2 で Admin の Worker と Admin の鍵・vars・issuer を消したので、その試験（console-admin-worker-key.test.ts）を書き直した。弱めない。
//   - 境界ごとの鍵（Workers の secret_key 型）で署名して STS → getSigninToken → 302。STS に渡した JWT は境界の issuer の JWKS
//     （Standard と同じ issuer・同じ鍵）で検証でき、タグのチームは Admin のチーム
//   - 境界の鍵が無い・使えない・vars の公開鍵と合わないなら 503 signing_unavailable（ほかの境界の鍵で代用しない。X14）
//   - Access JWT の iat からの経過時間の上限（既定 15 分。ADMIN_ACCESS_MAX_AGE_SECONDS）は Admin の階層のチームだけ（X6）
//   - デプロイ後の確認（GET <team-base>/key-check）の回数の制限のキーはパスのチームの階層（X11）
// 試験の鍵は手元の WebCrypto で取り出せない形に作る（本番の secret_key と同じ CryptoKey の形）。
import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIENCE, TEAM_TAG_KEY } from "../../src/console/constants";
import { AWS_SOURCE_IDENTITY_CLAIM, AWS_TAGS_CLAIM } from "../../src/console/issue/claims";
import { createConsoleWorker } from "../../src/console/worker/worker";
import {
  ADMIN_ENTRY,
  ADMIN_TEAM,
  AUDS,
  baseEnv,
  createHarness,
  EMAIL,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  makeStandardKey,
  PORTAL,
  PORTAL_HOST,
  STD_ISSUER,
  SUB,
  standardKeyEnv,
  type TestKey,
  workerConfig,
} from "./console-worker-harness";

const ADMIN_AUD = AUDS.teams[ADMIN_TEAM] as string;
const INFRA = AUDS.teams.infra as string;
const TEAM_PATH = `/t/${ADMIN_TEAM}`;

let b: TestKey;
beforeAll(async () => {
  b = await makeStandardKey();
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

const managed = () => h.stdKeys.managed as TestKey;
const partner = () => h.stdKeys["partner:partner-x"] as TestKey;

/** 鍵の vars を差し替えた env（ほかは baseEnv と同じ）。 */
function keyedEnv(keys: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const env = baseEnv(h, extra);
  for (const k of Object.keys(env)) if (k.startsWith("CONSOLE_KEY_")) delete env[k];
  return { ...env, ...keys };
}

const worker = () =>
  createConsoleWorker(workerConfig(), { getAccessKey: h.getAccessKey, fetch: h.fetch });

async function post(
  env: Record<string, unknown>,
  p: { iat?: number; aud?: string; path?: string; entry?: string } = {},
) {
  const aud = p.aud ?? ADMIN_AUD;
  const jwt = await h.accessJwt({ aud, email: EMAIL, ...(p.iat ? { iat: p.iat } : {}) });
  const csrf = await h.csrf(aud);
  return worker().fetch(
    loginRequest({
      host: PORTAL_HOST,
      path: p.path ?? `${TEAM_PATH}/login`,
      origin: PORTAL,
      jwt,
      form: { entry: p.entry ?? ADMIN_ENTRY, region: "ap-northeast-1", csrf },
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

describe("生成物の対照: Admin の階層の行も境界の issuer（Standard と同じ）", () => {
  it("境界の issuer は境界ごとに 1 つで、Admin の issuer は無い", () => {
    expect(workerConfig().boundaries).toEqual([
      { name: "managed", issuer: STD_ISSUER },
      { name: "partner:partner-x", issuer: "https://id.example.com/p/partner-x/console" },
    ]);
  });
});

describe("Admin の階層のチーム: 境界の鍵で 9 段目で署名して 302（擬似 STS）", () => {
  it("STS に渡した JWT は境界の issuer の JWKS（Worker が出すもの。Viewer と同じ）で検証でき、iss・aud・exp=iat+300・kid・タグ（Admin のチーム）・SourceIdentity を持つ", async () => {
    const env = baseEnv(h);
    const res = await post(env);
    expect(res.status, await res.clone().text()).toBe(302);
    expect(h.seen.sts).toHaveLength(1);
    expect(h.seen.signin).toHaveLength(1);
    const sts = h.seen.sts[0] as URLSearchParams;
    expect(sts.get("RoleArn")).toBe(
      "arn:aws:iam::333333333333:role/awsbridge-console/admin/FederatedAdministrator",
    );
    const token = sts.get("WebIdentityToken") as string;
    const jwks = (await (
      await get(ISSUER_HOST, "/console/.well-known/jwks.json", env)
    ).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: STD_ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
    });
    expect(decodeProtectedHeader(token).kid).toBe(managed().kid);
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
    const env = baseEnv(h);
    expect((await post(env)).status).toBe(302);
    expect((await post(env)).status).toBe(302);
    const jti = h.seen.sts.map((p) => {
      const t = p.get("WebIdentityToken") as string;
      return JSON.parse(atob((t.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/")))
        .jti;
    });
    expect(new Set(jti).size).toBe(2);
  });

  it("差し替えの間（JWKS に新旧 2 つ、署名は新しい鍵）も 302（Viewer と Administrator の両方に効く 1 つの鍵）", async () => {
    const env = keyedEnv(
      standardKeyEnv(
        { managed: b, "partner:partner-x": partner() },
        { managed: [managed(), b], "partner:partner-x": [partner()] },
      ),
    );
    expect((await post(env)).status).toBe(302);
    const token = (h.seen.sts[0] as URLSearchParams).get("WebIdentityToken") as string;
    expect(decodeProtectedHeader(token).kid).toBe(b.kid);
  });
});

describe("X14: 行の境界の鍵が無い・使えなければ 503 signing_unavailable（ほかの境界の鍵で代用しない。STS を呼ばない）", () => {
  it("managed の今の鍵が無い（partner の鍵だけある）なら、Admin の行（managed）は 503", async () => {
    const env = keyedEnv(
      standardKeyEnv(
        { "partner:partner-x": partner() },
        { managed: [managed()], "partner:partner-x": [partner()] },
      ),
    );
    const res = await post(env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
    noIssue();
  });

  it("503 の発行記録は tier admin・result signing_unavailable・team は Admin のチーム。email は出ない", async () => {
    const res = await post(baseEnv(h, { [managed().binding]: undefined }));
    expect(res.status).toBe(503);
    const line = logs.find((l) => l.includes('"console_issue"'));
    expect(line).toBeDefined();
    const rec = JSON.parse(line as string);
    expect(rec.tier).toBe("admin");
    expect(rec.result).toBe("signing_unavailable");
    expect(rec.team).toBe(ADMIN_TEAM);
    expect(rec.target.accountId).toBe("333333333333");
    expect(logs.join("\n")).not.toContain(EMAIL);
  });

  it.each([
    ["バインディングが無い", undefined],
    ["バインディングが文字列（secret_text の JWK）", JSON.stringify({ kty: "RSA", d: "x" })],
    ["バインディングが JWK のオブジェクト", { kty: "RSA", n: "x", e: "AQAB", d: "y" }],
  ])("%s なら 503", async (_n, value) => {
    const env = baseEnv(h, { [managed().binding]: value });
    const res = await post(env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
    noIssue();
  });

  it("取り出せる秘密鍵（extractable true）なら 503", async () => {
    const x = await makeStandardKey(true);
    const env = keyedEnv(standardKeyEnv({ managed: x, "partner:partner-x": partner() }));
    expect((await post(env)).status).toBe(503);
    noIssue();
  });

  it("鍵だけ替えて公開鍵（vars）を替え忘れた（自己検証が合わない）なら 503", async () => {
    const res = await post(baseEnv(h, { [managed().binding]: b.privateKey }));
    expect(res.status).toBe(503);
    noIssue();
    expect(logs.join("\n")).toContain("console_key_self_verify_failed");
  });
});

describe("ADMIN_ACCESS_MAX_AGE_SECONDS の形の誤りは 500 server_misconfigured（どの階層のチームでも）", () => {
  it.each([
    ["数でない", "15m"],
    ["小さすぎる", "59"],
    ["大きすぎる", "86401"],
  ])("%s", async (_n, v) => {
    const env = baseEnv(h, { ADMIN_ACCESS_MAX_AGE_SECONDS: v });
    for (const p of [{}, { aud: INFRA, path: "/t/infra/login", entry: "333333333333:readonly" }]) {
      const res = await post(env, p);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("server_misconfigured");
    }
    noIssue();
  });
});

describe("X6: Access JWT の iat からの経過時間の上限（既定 15 分）は Admin の階層のチームだけ", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("Admin のチームのパスで iat が 15 分より前なら POST も画面も 401 too_old（鍵があっても発行しない）", async () => {
    const res = await post(baseEnv(h), { iat: now() - 901 });
    expect(res.status).toBe(401);
    expect(logs.join("\n")).toContain('"too_old"');
    noIssue();
    const jwt = await h.accessJwt({ aud: ADMIN_AUD, iat: now() - 901 });
    for (const page of ["/", "/a/333333333333", "/login", "/key-check"]) {
      expect(
        (await get(PORTAL_HOST, `${TEAM_PATH}${page}`, baseEnv(h), { jwt })).status,
        page,
      ).toBe(401);
    }
  });

  it("対照: 同じ古さの Standard のチームのパスは通る（上限を見ない）", async () => {
    const res = await post(baseEnv(h), {
      iat: now() - 3000,
      aud: INFRA,
      path: "/t/infra/login",
      entry: "333333333333:readonly",
    });
    expect(res.status).toBe(302);
    const jwt = await h.accessJwt({ aud: INFRA, iat: now() - 3000 });
    expect((await get(PORTAL_HOST, "/t/infra/", baseEnv(h), { jwt })).status).toBe(200);
  });

  it("iat が 14 分前なら通る", async () => {
    expect((await post(baseEnv(h), { iat: now() - 840 })).status).toBe(302);
  });

  it("ADMIN_ACCESS_MAX_AGE_SECONDS で上限を変えられる（600 なら 11 分前は 401）", async () => {
    const env = baseEnv(h, { ADMIN_ACCESS_MAX_AGE_SECONDS: "600" });
    expect((await post(env, { iat: now() - 660 })).status).toBe(401);
    expect((await post(env, { iat: now() - 540 })).status).toBe(302);
  });

  it("上限はパスのチームの階層で選ぶ: Admin のチームのパスに Standard の AUD の古い JWT は 401（上限が先）、Standard のパスに Admin の AUD は 403 team_mismatch", async () => {
    const old = now() - 3000;
    const a = await post(baseEnv(h), { iat: old, aud: INFRA });
    expect(a.status).toBe(401);
    const s = await post(baseEnv(h), {
      iat: old,
      aud: ADMIN_AUD,
      path: "/t/infra/login",
      entry: "333333333333:readonly",
    });
    expect(s.status).toBe(403);
    expect(await s.text()).toContain("team_mismatch");
    noIssue();
  });
});

describe("デプロイ後の確認: GET <team-base>/key-check（Access の検証の後ろ。鍵の性質と kid だけ）", () => {
  it("X11: 回数の制限のキーはパスのチームの階層（admin-key-check:<sub>・standard-key-check:<sub>）。制限を超えたら 429・binding が無ければ 500・例外は 503", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const keys: string[] = [];
    const limiter = (success: boolean) => ({
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success };
      },
    });
    const okRes = await get(
      PORTAL_HOST,
      `${TEAM_PATH}/key-check`,
      baseEnv(h, { LOGIN_RATE_LIMITER: limiter(true) }),
      { jwt },
    );
    expect(okRes.status).toBe(200);
    expect(keys).toEqual([`admin-key-check:${SUB}`]);
    const std = await get(
      PORTAL_HOST,
      "/t/infra/key-check",
      baseEnv(h, { LOGIN_RATE_LIMITER: limiter(true) }),
      { jwt: await h.accessJwt({ aud: INFRA }) },
    );
    expect(std.status).toBe(200);
    expect(keys).toEqual([`admin-key-check:${SUB}`, `standard-key-check:${SUB}`]);
    const limited = await get(
      PORTAL_HOST,
      `${TEAM_PATH}/key-check`,
      baseEnv(h, { LOGIN_RATE_LIMITER: limiter(false) }),
      { jwt },
    );
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("rate_limited");
    const none = await get(
      PORTAL_HOST,
      `${TEAM_PATH}/key-check`,
      baseEnv(h, { LOGIN_RATE_LIMITER: undefined }),
      { jwt },
    );
    expect(none.status).toBe(500);
    const thrown = await get(
      PORTAL_HOST,
      `${TEAM_PATH}/key-check`,
      baseEnv(h, {
        LOGIN_RATE_LIMITER: {
          limit: async () => {
            throw new Error("x");
          },
        },
      }),
      { jwt },
    );
    expect(thrown.status).toBe(503);
  });

  it("X11: Admin のチームの key-check を Standard のチームの AUD で開くと 403 team_mismatch（回数を数えない）。JWT が無ければ 401", async () => {
    const keys: string[] = [];
    const env = baseEnv(h, {
      LOGIN_RATE_LIMITER: {
        limit: async (o: { key: string }) => {
          keys.push(o.key);
          return { success: true };
        },
      },
    });
    expect((await get(PORTAL_HOST, `${TEAM_PATH}/key-check`, env)).status).toBe(401);
    const res = await get(PORTAL_HOST, `${TEAM_PATH}/key-check`, env, {
      jwt: await h.accessJwt({ aud: INFRA }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("team_mismatch");
    expect(keys).toEqual([]);
  });

  it("Admin のチームの JWT なら、そのチームの行がある境界（managed だけ）の鍵の性質を返す（鍵の中身・署名は返さない）", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const res = await get(PORTAL_HOST, `${TEAM_PATH}/key-check`, baseEnv(h), { jwt });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text) as { boundaries: Record<string, Record<string, unknown>> };
    // Admin の階層のロールは managed の境界だけ（admin_boundary）なので、partner の鍵は出さない
    expect(Object.keys(body.boundaries)).toEqual(["managed"]);
    expect(body.boundaries.managed).toMatchObject({
      configured: true,
      kid: managed().kid,
      extractable: false,
      exportKey: "rejected",
      selfVerify: "ok",
    });
    expect(text).not.toContain(partner().kid);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{100,}/);
    noIssue();
  });

  it("POST は 405", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    expect(
      (await get(PORTAL_HOST, `${TEAM_PATH}/key-check`, baseEnv(h), { jwt, method: "POST" }))
        .status,
    ).toBe(405);
  });
});
