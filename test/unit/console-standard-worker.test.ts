// コンソールログインの Standard の Worker: POST <team-base>/login の 9 段・経路・issuer の文書・画面。
// 設計: docs/specs/console-login-portal.md §3・§9（9 段・エラー・CSRF・応答ヘッダー）・§10・§11。
// 偽の Access（手元の鍵）・STS・getSigninToken を相手に、Worker の fetch を直接呼ぶ。
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIENCE } from "../../src/console/constants";
import { createStandardWorker } from "../../src/console/standard/worker";
import type { WorkerConfig } from "../../src/console/types";
import {
  ACCESS_KEY_ID,
  AUDS,
  adminConfig,
  baseEnv,
  CSRF_SECRET,
  createHarness,
  EMAIL,
  ENTRY,
  FEDERATION,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  PORTAL,
  PORTAL_HOST,
  SIGNIN_TOKEN,
  STD_ISSUER,
  standardConfig,
  standardKeyEnv,
  stsErrorXml,
  type TestKey,
} from "./console-standard-harness";

let h: Harness;
let logs: string[];

beforeEach(async () => {
  h = await createHarness();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const INFRA = AUDS.teams.infra as string;
const DEV = AUDS.teams.dev as string;

function worker(config: unknown = standardConfig()) {
  return createStandardWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });
}

type PostOpts = Partial<Parameters<typeof loginRequest>[0]> & {
  aud?: string | string[];
  email?: string;
  csrfAud?: string;
};

async function post(p: PostOpts = {}, env: Record<string, unknown> = baseEnv(h), config?: unknown) {
  const jwt =
    "jwt" in p ? p.jwt : await h.accessJwt({ aud: p.aud ?? INFRA, email: p.email ?? EMAIL });
  const csrf = await h.csrf(p.csrfAud ?? INFRA);
  const req = loginRequest({
    ...p,
    jwt,
    form: p.form ?? { entry: ENTRY, region: "ap-northeast-1", csrf },
  });
  return worker(config).fetch(req, env);
}

async function get(
  path: string,
  opts: { host?: string; jwt?: string; method?: string } = {},
  env: Record<string, unknown> = baseEnv(h),
  config?: unknown,
) {
  const headers = new Headers();
  if (opts.jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", opts.jwt);
  const req = new Request(`https://${opts.host ?? PORTAL_HOST}${path}`, {
    method: opts.method ?? "GET",
    headers,
  });
  return worker(config).fetch(req, env);
}

const noIssue = () => {
  expect(h.seen.sts).toHaveLength(0);
  expect(h.seen.signin).toHaveLength(0);
};

describe("POST /t/<team>/login: Access JWT の aud（最初の Red）", () => {
  it("aud が配列で 2 つ（既知のチームの AUD を含む）なら 403 unknown_audience で、STS を呼ばない", async () => {
    const res = await post({ aud: [INFRA, DEV] });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unknown_audience");
    noIssue();
  });

  it("対照: aud がちょうど 1 つ（このチームの AUD）なら 302 でコンソールのログイン URL に送る", async () => {
    const res = await post();
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(FEDERATION);
    expect(loc.searchParams.get("Action")).toBe("login");
    expect(h.seen.sts).toHaveLength(1);
    expect(h.seen.signin).toHaveLength(1);
  });
});

describe("POST /t/<team>/login: 通る経路の中身", () => {
  it("STS に行の ARN・console-<email>・行のセッションの長さを渡し、getSigninToken にも同じ長さを渡す", async () => {
    const res = await post();
    expect(res.status).toBe(302);
    const sts = h.seen.sts[0];
    expect(sts?.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(sts?.get("RoleArn")).toBe(
      "arn:aws:iam::333333333333:role/awsbridge-console/std/FederatedViewer",
    );
    expect(sts?.get("RoleSessionName")).toBe(`console-${EMAIL}`);
    expect(sts?.get("DurationSeconds")).toBe("43200");
    expect(h.seen.signin[0]?.get("SessionDuration")).toBe("43200");
    expect(h.seen.signin[0]?.get("Action")).toBe("getSigninToken");
  });

  it("STS に渡す JWT は境界の issuer・audience・チームのタグ・SourceIdentity を持ち、issuer の JWKS で検証できる", async () => {
    await post();
    const jwt = h.seen.sts[0]?.get("WebIdentityToken") ?? "";
    const jwksRes = await get("/standard/.well-known/jwks.json", { host: ISSUER_HOST });
    expect(jwksRes.status).toBe(200);
    const jwks = createLocalJWKSet((await jwksRes.json()) as { keys: [] });
    const { payload } = await jwtVerify(jwt, jwks, { issuer: STD_ISSUER, audience: AUDIENCE });
    expect(payload.sub).toBe(EMAIL);
    expect(payload["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: { awsbridge_team: ["infra"] },
    });
    expect(payload["https://aws.amazon.com/source_identity"]).toBe(EMAIL);
    expect(payload).not.toHaveProperty("azp");
  });

  it("Location の Issuer は設定のオリジンとチームの /expired、Destination は許可リストのリージョン", async () => {
    const loc = new URL((await post()).headers.get("Location") ?? "");
    expect(loc.searchParams.get("Issuer")).toBe(`${PORTAL}/t/infra/expired`);
    expect(loc.searchParams.get("Destination")).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
    );
    expect(loc.searchParams.get("SigninToken")).toBe(SIGNIN_TOKEN);
  });

  it("許可リストにないリージョン（URL を含む）は既定のリージョンに置き換える", async () => {
    const csrf = await h.csrf(INFRA);
    const res = await post({ form: { entry: ENTRY, region: "https://evil.example.com", csrf } });
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.searchParams.get("Destination")).toContain("region=ap-northeast-1");
  });

  it("302 にも no-store と CSP を付け、Host ヘッダーを Issuer に使わない", async () => {
    const res = await post();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("発行記録は構造化ログで伏せ字の形。ログイン URL・SigninToken・認証情報・email をそのまま出さない", async () => {
    await post();
    const line = logs.find((l) => l.includes('"console_issue"'));
    expect(line).toBeDefined();
    const rec = JSON.parse(line as string);
    expect(rec.result).toBe("ok");
    expect(rec.tier).toBe("standard");
    expect(rec.team).toBe("infra");
    // cto の決裁 2026-11-13: アカウント ID とロール ARN は全桁（突き合わせのキー。秘密ではない）。email は伏せる
    expect(rec.target.accountId).toBe("333333333333");
    expect(rec.target.roleArn).toMatch(/^arn:aws:iam::333333333333:role\//);
    expect(rec.sts.region).toBe("us-east-1");
    expect(rec.session.seconds).toBe(43200);
    const all = logs.join("\n");
    for (const s of [
      SIGNIN_TOKEN,
      ACCESS_KEY_ID,
      "unit-secret-value",
      "unit-session-value",
      EMAIL,
      CSRF_SECRET,
    ]) {
      expect(all).not.toContain(s);
    }
  });
});

describe("POST /t/<team>/login: 負の試験（代表）", () => {
  it("入口の AUD での POST は 403 unknown_audience", async () => {
    const res = await post({ aud: AUDS.entry.standard, csrfAud: AUDS.entry.standard });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unknown_audience");
    noIssue();
  });

  it("Admin の階層のチームの AUD は Standard では未知（403 unknown_audience）", async () => {
    const admin = AUDS.teams["infra-elevated"] as string;
    const res = await post({ aud: admin, csrfAud: admin });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unknown_audience");
    noIssue();
  });

  it("パスのチームと AUD のチームが違えば 403 team_mismatch", async () => {
    const res = await post({ path: "/t/dev/login" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("team_mismatch");
    noIssue();
  });

  it("Access JWT がなければ 401 unauthorized", async () => {
    const res = await post({ jwt: undefined });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("unauthorized");
    noIssue();
  });

  it("別のチーム（dev）のページの CSRF トークンは 403 csrf_failed", async () => {
    const res = await post({ csrfAud: DEV });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("csrf_failed");
    noIssue();
  });

  it("CSRF トークンがない・重ねて送られたら 403 csrf_failed", async () => {
    expect((await post({ form: { entry: ENTRY } })).status).toBe(403);
    const csrf = await h.csrf(INFRA);
    const res = await worker().fetch(
      new Request(`${PORTAL}/t/infra/login`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await h.accessJwt(),
          Origin: PORTAL,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `entry=${ENTRY}&csrf=${csrf}&csrf=${csrf}`,
      }),
      baseEnv(h),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("csrf_failed");
    noIssue();
  });

  it("Origin がなければ 403 forbidden_origin（MCP と違い、なければ拒否）", async () => {
    const res = await post({ origin: null });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("forbidden_origin");
    noIssue();
  });

  it("Origin が Admin のオリジン・Sec-Fetch-Site が same-origin でなければ 403 forbidden_origin", async () => {
    expect((await post({ origin: "https://admin-portal.example.com" })).status).toBe(403);
    expect((await post({ secFetchSite: "cross-site" })).status).toBe(403);
    noIssue();
  });

  it("Content-Type がフォームでなければ 415 unsupported_media_type", async () => {
    const res = await post({ contentType: "application/json" });
    expect(res.status).toBe(415);
    noIssue();
  });

  it("GET の /login は発行しない（案内だけ）", async () => {
    const res = await get("/t/infra/login", { jwt: await h.accessJwt() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("もう一度");
    expect(res.headers.get("Location")).toBeNull();
    noIssue();
  });

  it("GET の /login・/expired も Access JWT がない・AUD が未知・チームが違えば断る（案内は検証が通ったときだけ）", async () => {
    for (const path of ["/t/infra/login", "/t/infra/expired"]) {
      const none = await get(path);
      expect(none.status, path).toBe(401);
      expect(await none.text()).not.toContain("もう一度選んでください</h1>");
      const entry = await get(path, { jwt: await h.accessJwt({ aud: AUDS.entry.standard }) });
      expect(entry.status, path).toBe(403);
      expect(await entry.text()).toContain("unknown_audience");
      const other = await get(path, { jwt: await h.accessJwt({ aud: DEV }) });
      expect(other.status, path).toBe(403);
      expect((await get(path, { jwt: await h.accessJwt() })).status, path).toBe(200);
    }
    noIssue();
  });

  it("本文が 8 KB を超えたら 413 で、STS を呼ばない", async () => {
    const csrf = await h.csrf(INFRA);
    const big = { entry: ENTRY, csrf, pad: "x".repeat(8 * 1024) };
    const res = await post({ form: big });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("payload_too_large");
    noIssue();
    // Content-Length を偽っても（申告なし・小さく申告）、読んだ量で止める
    const req = new Request(`${PORTAL}/t/infra/login`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": await h.accessJwt(),
        Origin: PORTAL,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(new URLSearchParams(big).toString()));
          c.close();
        },
      }),
      // @ts-expect-error: Node の Request にストリームの本文を渡すときに要る
      duplex: "half",
    });
    expect((await worker().fetch(req, baseEnv(h))).status).toBe(413);
    noIssue();
    // 対照: 上限ちょうど以下なら通る
    const ok = await post({ form: { entry: ENTRY, csrf, pad: "x".repeat(1024) } });
    expect(ok.status).toBe(302);
  });

  it("POST・GET・HEAD 以外の /login は 405", async () => {
    const res = await post({ method: "PUT" });
    expect(res.status).toBe(405);
    noIssue();
  });

  it("停止スイッチ（LOGIN_DISABLED）が入っていれば、正しい要求でも 503 login_disabled", async () => {
    const res = await post({}, baseEnv(h, { LOGIN_DISABLED: "true" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("login_disabled");
    noIssue();
  });

  it("停止スイッチの値が false・0・空なら止めない。それ以外の値は止める側に倒す", async () => {
    for (const v of ["false", "0", ""]) {
      expect((await post({}, baseEnv(h, { LOGIN_DISABLED: v }))).status, v).toBe(302);
    }
    for (const v of ["1", "yes", "TRUE"]) {
      expect((await post({}, baseEnv(h, { LOGIN_DISABLED: v }))).status, v).toBe(503);
    }
  });

  it("Admin の行（このアカウントの Admin のロール）の entry は 404 not_listed", async () => {
    const csrf = await h.csrf(INFRA);
    const res = await post({ form: { entry: "333333333333:admin", csrf } });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_listed");
    noIssue();
  });

  it("このチームに割り当てのない行・形の崩れた entry・重ねた entry は 404 not_listed", async () => {
    const csrf = await h.csrf(INFRA);
    for (const entry of [
      "444444444444:developer",
      "333333333333",
      "x:readonly",
      "999999999999:readonly",
    ]) {
      const res = await post({ form: { entry, csrf } });
      expect(res.status, entry).toBe(404);
    }
    noIssue();
  });

  it("email が制約に合わない（56 文字超・許されない文字・小文字にすると ASCII に化ける文字）なら 403 identity_unsupported", async () => {
    for (const email of [
      `${"a".repeat(60)}@example.com`,
      "a b@example.com",
      "Kelvin@example.com",
    ]) {
      const res = await post({ email });
      expect(res.status, email).toBe(403);
      expect(await res.text()).toContain("identity_unsupported");
    }
    noIssue();
  });

  it("回数の制限を超えたら 429 rate_limited（キーは階層と Access の sub）", async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success: false };
      },
    };
    const res = await post({}, baseEnv(h, { LOGIN_RATE_LIMITER: limiter }));
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("rate_limited");
    expect(keys).toEqual(["standard:11111111-2222-4333-8444-555555555555"]);
    noIssue();
  });

  it("回数の制限の binding がなければ 500、例外なら 503 で、発行しない", async () => {
    expect((await post({}, baseEnv(h, { LOGIN_RATE_LIMITER: undefined }))).status).toBe(500);
    const broken = {
      limit: async () => {
        throw new Error("x");
      },
    };
    expect((await post({}, baseEnv(h, { LOGIN_RATE_LIMITER: broken }))).status).toBe(503);
    noIssue();
  });

  it("STS が AccessDenied なら 403 sts_denied、InvalidIdentityToken なら 502 upstream_auth_failed。getSigninToken は呼ばない", async () => {
    h.sts = { status: 403, body: stsErrorXml("AccessDenied") };
    let res = await post();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("sts_denied");
    h.sts = { status: 400, body: stsErrorXml("InvalidIdentityToken") };
    res = await post();
    expect(res.status).toBe(502);
    expect(h.seen.signin).toHaveLength(0);
    const rec = logs.filter((l) => l.includes('"console_issue"')).map((l) => JSON.parse(l));
    expect(rec.map((r) => r.result)).toEqual(["sts_denied", "upstream_auth_failed"]);
    expect(rec[0].jwt.jti).toBeDefined();
  });

  it("エラーの画面に内部の詳細（STS の本文）を出さない", async () => {
    h.sts = { status: 403, body: stsErrorXml("AccessDenied") };
    const res = await post();
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("sts_denied");
    expect(text).not.toContain("denied</Message>");
    expect(text).not.toContain("<Error>");
  });
});

describe("生成物と secret の検査（fail-closed）", () => {
  const mutate = (f: (c: WorkerConfig & Record<string, unknown>) => void) => {
    const c = standardConfig() as WorkerConfig & Record<string, unknown>;
    f(c);
    return c;
  };

  it.each([
    ["purpose が issue でない", mutate((c) => Object.assign(c, { purpose: "display" }))],
    ["Admin の階層の生成物", adminConfig()],
    [
      "Admin の行が混ざっている",
      mutate((c) => {
        c.accounts.push(...adminConfig().accounts);
      }),
    ],
    [
      "行の ARN が他の階層のパス",
      mutate((c) => {
        const r = c.accounts[0]?.roles[0];
        if (r) r.roleArn = r.roleArn.replace("/std/", "/admin/");
      }),
    ],
    [
      "行のチームが表にない（他の階層のチーム）",
      mutate((c) => {
        c.accounts[0]?.roles[0]?.teams.push("infra-elevated");
      }),
    ],
    [
      "チームの AUD が入口の AUD と同じ",
      mutate((c) => Object.assign(c.portal, { entryAud: INFRA })),
    ],
    ["壊れている（オブジェクトでない）", "not json"],
    ["schemaVersion が違う", mutate((c) => Object.assign(c, { schemaVersion: 2 }))],
    [
      "オリジンが https でない",
      mutate((c) => Object.assign(c.portal, { origin: "http://portal.example.com" })),
    ],
  ])("%s → どの経路も 500 server_misconfigured（値をログに出さない）", async (_name, config) => {
    const login = await post({}, baseEnv(h), config);
    expect(login.status).toBe(500);
    expect(await login.text()).toContain("server_misconfigured");
    const doc = await get(
      "/standard/.well-known/jwks.json",
      { host: ISSUER_HOST },
      baseEnv(h),
      config,
    );
    expect(doc.status).toBe(500);
    noIssue();
    const line = logs.find((l) => l.includes("invalid console config"));
    expect(line).toMatch(/^config: invalid console config: [a-z_]+$/);
  });

  it.each([
    ["今の署名鍵の vars の JSON が壊れている", { STANDARD_CURRENT_KEYS: "{" }],
    ["今の署名鍵の vars がない", { STANDARD_CURRENT_KEYS: undefined }],
    ["公開鍵の vars がない", { STANDARD_PUBLIC_JWKS: undefined }],
    ["公開鍵の vars の JSON が壊れている", { STANDARD_PUBLIC_JWKS: "[" }],
    ["CSRF の鍵が短い", { CONSOLE_CSRF_KEY: "short" }],
    ["チームドメインがない", { ACCESS_TEAM_DOMAIN: undefined }],
    ["チームドメインが https でない", { ACCESS_TEAM_DOMAIN: "http://unit.cloudflareaccess.com" }],
    ["STS のリージョンの形が崩れている", { STS_REGION: "https://evil.example.com" }],
  ])("%s → 500 server_misconfigured", async (_name, extra) => {
    const res = await post({}, baseEnv(h, extra));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("server_misconfigured");
    noIssue();
  });

  it("境界の鍵がない行は 503 signing_unavailable（その境界の JWKS は 500）", async () => {
    const env = baseEnv(
      h,
      standardKeyEnv({ "partner:partner-x": h.stdKeys["partner:partner-x"] as TestKey }),
    );
    delete env[(h.stdKeys.managed as TestKey).binding];
    const res = await post({}, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
    noIssue();
    expect((await get("/standard/.well-known/jwks.json", { host: ISSUER_HOST }, env)).status).toBe(
      500,
    );
    expect((await get("/partner-x/.well-known/jwks.json", { host: ISSUER_HOST }, env)).status).toBe(
      200,
    );
  });

  it("STS のリージョンは設定（STS_REGION）で地域の endpoint を選べる", async () => {
    const seen: string[] = [];
    const inner = h.fetch;
    const w = createStandardWorker(standardConfig(), {
      getAccessKey: h.getAccessKey,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        seen.push(url);
        return inner(
          url === "https://sts.ap-northeast-1.amazonaws.com/"
            ? "https://sts.us-east-1.amazonaws.com/"
            : input,
          init,
        );
      }) as typeof fetch,
    });
    const csrf = await h.csrf(INFRA);
    const res = await w.fetch(
      loginRequest({ jwt: await h.accessJwt(), form: { entry: ENTRY, csrf } }),
      baseEnv(h, { STS_REGION: "ap-northeast-1" }),
    );
    expect(res.status).toBe(302);
    expect(seen[0]).toBe("https://sts.ap-northeast-1.amazonaws.com/");
  });
});

describe("Host での振り分け", () => {
  it("issuer のホストでは、境界の issuer の discovery と JWKS だけを返す", async () => {
    const d = await get("/standard/.well-known/openid-configuration", { host: ISSUER_HOST });
    expect(d.status).toBe(200);
    const doc = (await d.json()) as { issuer: string; jwks_uri: string };
    expect(doc.issuer).toBe(STD_ISSUER);
    expect(doc.jwks_uri).toBe(`${STD_ISSUER}/.well-known/jwks.json`);
    const j = await get("/standard/.well-known/jwks.json", { host: ISSUER_HOST });
    const jwks = (await j.json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]?.kid).toBeTypeOf("string");
    expect(
      (await get("/partner-x/.well-known/openid-configuration", { host: ISSUER_HOST })).status,
    ).toBe(200);
  });

  it("issuer のホストから /t/*/login・ポータルの画面・他の階層の issuer・それ以外のパスには届かない（404）", async () => {
    const res = await post({ host: ISSUER_HOST });
    expect(res.status).toBe(404);
    noIssue();
    for (const path of [
      "/",
      "/t/infra/",
      "/t/infra/login",
      "/t/infra/a/333333333333",
      "/admin/.well-known/openid-configuration",
      "/standard/.well-known/openid-configuration/x",
      "/standard",
      "/.well-known/openid-configuration",
    ]) {
      expect((await get(path, { host: ISSUER_HOST })).status, path).toBe(404);
    }
  });

  it("issuer の文書は GET・HEAD だけ", async () => {
    const res = await get("/standard/.well-known/jwks.json", { host: ISSUER_HOST, method: "POST" });
    expect(res.status).toBe(405);
    const head = await get("/standard/.well-known/jwks.json", {
      host: ISSUER_HOST,
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("知らないホスト・ポータルのホストの issuer のパスは 404", async () => {
    expect((await post({ host: "evil.example.com" })).status).toBe(404);
    expect((await get("/standard/.well-known/jwks.json")).status).toBe(404);
    noIssue();
  });

  it("ポータルのホストで、設定にないチーム・Admin の階層のチーム・知らないパスは 404", async () => {
    for (const path of ["/t/nope/login", "/t/infra-elevated/login", "/t/INFRA/login", "/x"]) {
      const res = await post({ path });
      expect(res.status, path).toBe(404);
    }
    noIssue();
  });

  it("ホスト方式（routing: host）: <team>.<ホスト> の /login で発行し、Origin と Issuer はチームのホスト", async () => {
    const config = standardConfig();
    config.portal.routing = "host";
    const teamOrigin = "https://infra.portal.example.com";
    const res = await post(
      { host: "infra.portal.example.com", path: "/login", origin: teamOrigin },
      baseEnv(h),
      config,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.searchParams.get("Issuer")).toBe(`${teamOrigin}/expired`);
    const wrong = await post(
      { host: "infra.portal.example.com", path: "/login" },
      baseEnv(h),
      config,
    );
    expect(wrong.status).toBe(403);
    // ホスト方式ではパス方式の経路を持たない
    expect((await post({ path: "/t/infra/login" }, baseEnv(h), config)).status).toBe(404);
  });
});

describe("画面（S2・S4・S5 と経路の枠）", () => {
  it("S2: このチームのロールだけを選ぶフォーム（POST /t/<team>/login、CSRF つき）。送るとそのまま発行できる", async () => {
    const jwt = await h.accessJwt();
    const res = await get("/t/infra/a/333333333333", { jwt });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('action="/t/infra/login"');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="333333333333:readonly"');
    expect(html).not.toContain("333333333333:admin");
    expect(html).not.toMatch(/<script|style=/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeDefined();
    const done = await worker().fetch(
      loginRequest({ jwt, form: { entry: ENTRY, region: "us-east-1", csrf: csrf as string } }),
      baseEnv(h),
    );
    expect(done.status).toBe(302);
  });

  it("S2: リージョンの選択は許可リストだけ。設定の値はエスケープする", async () => {
    const config = standardConfig();
    const a = config.accounts.find((x) => x.accountId === "333333333333");
    if (a) a.name = '<img src=x onerror="alert(1)">';
    const html = await (
      await get("/t/infra/a/333333333333", { jwt: await h.accessJwt() }, baseEnv(h), config)
    ).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('value="ap-northeast-1"');
    expect(html).toContain('value="us-east-1"');
  });

  it("S2: Access JWT がなければ 401、このチームの行がないアカウントは 404 not_listed", async () => {
    expect((await get("/t/infra/a/333333333333")).status).toBe(401);
    const jwt = await h.accessJwt();
    const res = await get("/t/infra/a/555555555555", { jwt });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_listed");
    expect((await get("/t/infra/a/12345", { jwt })).status).toBe(404);
  });

  it("S2: 停止中は上部に案内を出す", async () => {
    const res = await get(
      "/t/infra/a/333333333333",
      { jwt: await h.accessJwt() },
      baseEnv(h, { LOGIN_DISABLED: "true" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("一時停止");
  });

  it("S4: エラーの画面は code と要求 ID（Cf-Ray）を出し、一覧へのリンクを置く", async () => {
    const req = loginRequest({
      jwt: await h.accessJwt(),
      form: { entry: "333333333333:admin", csrf: await h.csrf(INFRA) },
    });
    req.headers.set("Cf-Ray", "unit-ray-1");
    const res = await worker().fetch(req, baseEnv(h));
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain("not_listed");
    expect(html).toContain("unit-ray-1");
    expect(html).toContain('href="/t/infra/"');
  });

  it("S5（/expired）・S1（/t/<team>/）・S3（/cli）を返し、S0（/）は入口の JWT が無ければ断る（中身は console-portal-*.test.ts）", async () => {
    const jwt = await h.accessJwt();
    expect((await get("/t/infra/expired", { jwt })).status).toBe(200);
    expect((await get("/")).status).toBe(401);
    expect((await get("/t/infra/", { jwt })).status).toBe(200);
    expect((await get("/t/infra/a/333333333333/cli", { jwt })).status).toBe(200);
    // チームのページは Access JWT を確かめる
    expect((await get("/t/infra/")).status).toBe(401);
    expect((await get("/t/infra/", { jwt: await h.accessJwt({ aud: DEV }) })).status).toBe(403);
    // 画面は POST を受けない
    expect((await get("/t/infra/a/333333333333", { jwt, method: "POST" })).status).toBe(405);
  });
});

describe("JWT の claim（decodeJwt で中身だけ見る）", () => {
  it("jti は発行記録に完全な値で残す（CloudTrail の webIdentityTokenId との突き合わせの主キー）。email は伏せ字のまま", async () => {
    await post();
    const jwt = h.seen.sts[0]?.get("WebIdentityToken") ?? "";
    const jti = decodeJwt(jwt).jti as string;
    expect(jti.length).toBeGreaterThan(8);
    const rec = JSON.parse(logs.find((l) => l.includes('"console_issue"')) as string);
    expect(rec.jwt.jti).toBe(jti);
    expect(rec.target.accountId).toBe("333333333333");
    expect(rec.user.email).not.toBe(EMAIL);
  });

  it("発行記録に署名した鍵の kid（JWT のヘッダーと同じ）を残す", async () => {
    await post();
    const jwt = h.seen.sts[0]?.get("WebIdentityToken") ?? "";
    const kid = decodeProtectedHeader(jwt).kid;
    expect(typeof kid).toBe("string");
    const rec = JSON.parse(logs.find((l) => l.includes('"console_issue"')) as string);
    expect(rec.jwt.kid).toBe(kid);
  });

  it("発行記録に Worker の版 ID（binding CF_VERSION_METADATA の id）を残す。binding が無ければ項目を持たない", async () => {
    const versionId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    await post({}, baseEnv(h, { CF_VERSION_METADATA: { id: versionId, tag: "", timestamp: "" } }));
    const rec = JSON.parse(logs.find((l) => l.includes('"console_issue"')) as string);
    expect(rec.worker).toEqual({ versionId });
    logs.length = 0;
    await post();
    const rec2 = JSON.parse(logs.find((l) => l.includes('"console_issue"')) as string);
    expect(rec2).not.toHaveProperty("worker");
  });
});
