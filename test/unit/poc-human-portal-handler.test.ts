import {
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { handlePortalRequest, type PortalEnv } from "../../scripts/poc/human/portal/handler";

// PoC のポータル Worker の処理。Access の JWKS・STS・Federation は差し替える（実 AWS / Cloudflare は呼ばない）。

const BASE = "https://awsbridge-human-poc-portal.example.workers.dev";
const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUD_INFRA = "a".repeat(64);
const AUD_DEV = "b".repeat(64);
const AUD_ENTRY = "c".repeat(64);
const ROLE_SHARED = "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalShared";
const ROLE_INFRA = "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalInfraOnly";
const EMAIL = "user@example.com";

let accessKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let stdJwk: JWK;
let adminJwk: JWK;
let env: PortalEnv;

beforeAll(async () => {
  accessKeys = await generateKeyPair("RS256", { extractable: true });
  stdJwk = await exportJWK(
    (await generateKeyPair("RS256", { modulusLength: 2048, extractable: true })).privateKey,
  );
  adminJwk = await exportJWK(
    (await generateKeyPair("RS256", { modulusLength: 2048, extractable: true })).privateKey,
  );
  env = {
    PORTAL_BASE: BASE,
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD_MAP: JSON.stringify({ [AUD_INFRA]: "infra", [AUD_DEV]: "dev" }),
    ACCESS_ENTRY_AUD: AUD_ENTRY,
    ROLES: JSON.stringify([
      { label: "shared", arn: ROLE_SHARED },
      { label: "infra-only", arn: ROLE_INFRA },
    ]),
    SESSION_DURATION: "3600",
    SIGNING_JWK_STD: JSON.stringify(stdJwk),
    SIGNING_JWK_ADMIN: JSON.stringify(adminJwk),
  };
});

async function accessJwt(
  aud: string | string[],
  opts: { email?: string; iss?: string; exp?: number; iat?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: opts.email ?? EMAIL, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? TEAM_DOMAIN)
    .setAudience(aud)
    .setSubject("user-uuid")
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 600)
    .sign(accessKeys.privateKey);
}

interface Seen {
  url: string;
  method: string;
  body: string;
}

const stsOk = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
<Credentials><AccessKeyId>ASIAEXAMPLEPORTAL</AccessKeyId><SecretAccessKey>secret-portal</SecretAccessKey><SessionToken>token-portal</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials>
<AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocPortalShared/human-user@example.com</Arn><AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
const stsErr = (code: string) =>
  `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>m</Message></Error></ErrorResponse>`;

function fakeFetch(opts: { stsStatus?: number; stsBody?: string; signin?: string } = {}) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    seen.push({ url, method: init?.method ?? "GET", body });
    if (url.startsWith("https://sts."))
      return new Response(opts.stsBody ?? stsOk, { status: opts.stsStatus ?? 200 });
    if (url.startsWith("https://signin.aws.amazon.com/federation"))
      return new Response(opts.signin ?? JSON.stringify({ SigninToken: "SIGNIN-TOKEN-X" }));
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { fetch: f, seen };
}

function deps(f = fakeFetch()) {
  return { fetch: f.fetch, accessKey: async () => accessKeys.publicKey };
}

async function req(
  path: string,
  init: RequestInit & { jwt?: string } = {},
  e: PortalEnv = env,
  d = deps(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.jwt) headers.set("Cf-Access-Jwt-Assertion", init.jwt);
  return handlePortalRequest(new Request(`${BASE}${path}`, { ...init, headers }), e, d);
}

function loginInit(jwt: string, body = "role=shared"): RequestInit & { jwt: string } {
  return {
    method: "POST",
    jwt,
    headers: {
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  };
}

describe("N9: パス付き issuer の discovery と JWKS（Access は Bypass。IAM が取りに来る）", () => {
  it("/std と /admin の discovery は issuer = <base>/<tier>、jwks_uri はその下", async () => {
    for (const tier of ["std", "admin"]) {
      const r = await req(`/${tier}/.well-known/openid-configuration`);
      expect(r.status, tier).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
      const d = (await r.json()) as { issuer: string; jwks_uri: string };
      expect(d.issuer).toBe(`${BASE}/${tier}`);
      expect(d.jwks_uri).toBe(`${BASE}/${tier}/.well-known/jwks.json`);
    }
  });
  it("JWKS は階層ごとの鍵の公開鍵だけ（std と admin で kid が違う、秘密成分を出さない）", async () => {
    const std = await (await req("/std/.well-known/jwks.json")).text();
    const admin = await (await req("/admin/.well-known/jwks.json")).text();
    expect(std).not.toContain(stdJwk.d as string);
    expect(admin).not.toContain(adminJwk.d as string);
    const kid = (s: string) => (JSON.parse(s) as { keys: { kid: string }[] }).keys[0]?.kid;
    expect(kid(std)).toBeTruthy();
    expect(kid(std)).not.toBe(kid(admin));
  });
  it("ホスト直下の /.well-known と、末尾スラッシュつきの /std/ の下は 404", async () => {
    for (const p of [
      "/.well-known/openid-configuration",
      "/.well-known/jwks.json",
      "/std//.well-known/jwks.json",
      "/other/.well-known/jwks.json",
    ])
      expect((await req(p)).status, p).toBe(404);
  });
  it("鍵がなければ 500（その階層の文書だけ）", async () => {
    const r = await req("/admin/.well-known/jwks.json", {}, { ...env, SIGNING_JWK_ADMIN: "" });
    expect(r.status).toBe(500);
    expect(
      (await req("/std/.well-known/jwks.json", {}, { ...env, SIGNING_JWK_ADMIN: "" })).status,
    ).toBe(200);
  });
});

describe("N1 (M2): whoami は検証した Access JWT の aud と、そこから決めたチームを返す", () => {
  it("/t/infra/whoami に infra の AUD で来れば aud_team = infra、path_team = infra", async () => {
    const r = await req("/t/infra/whoami", { jwt: await accessJwt(AUD_INFRA) });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({
      verified: true,
      path_team: "infra",
      aud: [AUD_INFRA],
      aud_team: "infra",
      team_match: true,
      entry_aud: false,
      email: "u***@***.com",
    });
    expect(typeof b.iat).toBe("number");
    expect(JSON.stringify(b)).not.toContain(EMAIL);
  });
  it("入口の AUD はどのチームにも対応しない（entry_aud = true、aud_error = unknown_audience）", async () => {
    const r = await req("/whoami", { jwt: await accessJwt(AUD_ENTRY) });
    expect(await r.json()).toMatchObject({
      verified: true,
      path_team: null,
      entry_aud: true,
      aud_team: null,
      aud_error: "unknown_audience",
    });
  });
  it("/t/infra/whoami に dev の AUD なら team_match = false（Access のパスの一致の観察用）", async () => {
    const b = (await (
      await req("/t/infra/whoami", { jwt: await accessJwt(AUD_DEV) })
    ).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ aud_team: "dev", path_team: "infra", team_match: false });
  });
  it("JWT がない・署名違い・iss 違い・期限切れは 401 で verified = false", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD_INFRA)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(other.privateKey);
    for (const jwt of [
      undefined,
      forged,
      await accessJwt(AUD_INFRA, { iss: "https://other.cloudflareaccess.com" }),
      await accessJwt(AUD_INFRA, { iat: 1000, exp: 2000 }),
    ]) {
      const r = await req("/t/infra/whoami", jwt ? { jwt } : {});
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ verified: false });
    }
  });
  it("チームのページ（HTML）は aud とチームを表示し、ログインのフォームを出す。?refresh= で自動再読み込み", async () => {
    const r = await req("/t/infra/?refresh=30", { jwt: await accessJwt(AUD_INFRA) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // ブラウザはフォーム送信後のリダイレクトの連鎖すべてに form-action を当てる（Chrome 系）。
    // サインインへの 302 と、サインインからコンソールへのリダイレクトの両方を許す（PoC の N10 で、コンソールを許さないと遷移が止まった）
    expect(r.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://signin.aws.amazon.com https://*.signin.aws.amazon.com https://console.aws.amazon.com https://*.console.aws.amazon.com",
    );
    const html = await r.text();
    expect(html).toContain(AUD_INFRA);
    expect(html).toContain('action="/t/infra/login"');
    expect(html).toContain('method="post"');
    expect(html).toContain('http-equiv="refresh" content="30"');
    expect(html).not.toContain(EMAIL);
  });
});

describe("N10: POST /t/<team>/login（Access JWT → AUD からチーム → 自前 JWT → STS → getSigninToken → 302）", () => {
  it("成功すると Federation の login URL に 302。Issuer は <base>/t/<team>/expired", async () => {
    const f = fakeFetch();
    const r = await req("/t/infra/login", loginInit(await accessJwt(AUD_INFRA)), env, deps(f));
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const loc = new URL(r.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe("https://signin.aws.amazon.com/federation");
    expect(loc.searchParams.get("Action")).toBe("login");
    expect(loc.searchParams.get("SigninToken")).toBe("SIGNIN-TOKEN-X");
    expect(loc.searchParams.get("Issuer")).toBe(`${BASE}/t/infra/expired`);
    expect(loc.searchParams.get("Destination")).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
    );
    // 本文に認証情報・トークンを出さない
    const text = await r.text();
    for (const s of ["secret-portal", "token-portal", "SIGNIN-TOKEN-X"])
      expect(text).not.toContain(s);
  });
  it("STS には std の鍵で署名した JWT（iss=<base>/std、タグ awsbridge_team=infra、SI=email）を、DurationSeconds なしで送る", async () => {
    const f = fakeFetch();
    await req("/t/infra/login", loginInit(await accessJwt(AUD_INFRA)), env, deps(f));
    const sts = f.seen.find((s) => s.url.startsWith("https://sts."));
    expect(sts?.url).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(sts?.method).toBe("POST");
    const form = new URLSearchParams(sts?.body);
    expect(form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(form.get("RoleArn")).toBe(ROLE_SHARED);
    expect(form.get("RoleSessionName")).toBe(`human-${EMAIL}`);
    expect(form.has("DurationSeconds")).toBe(false);
    const token = form.get("WebIdentityToken") ?? "";
    const pub = await importJWK(
      { kty: "RSA", n: stdJwk.n as string, e: stdJwk.e as string },
      "RS256",
    );
    const { payload } = await jwtVerify(token, pub, {
      issuer: `${BASE}/std`,
      audience: "awsbridge-human-poc-portal",
    });
    expect(payload.sub).toBe(EMAIL);
    expect(payload["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: { awsbridge_team: ["infra"] },
    });
    expect(payload["https://aws.amazon.com/source_identity"]).toBe(EMAIL);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(300);
  });
  it("getSigninToken は GET で SessionDuration を付ける（SESSION_DURATION が空なら付けない）", async () => {
    const f = fakeFetch();
    await req("/t/infra/login", loginInit(await accessJwt(AUD_INFRA)), env, deps(f));
    const fed = new URL(f.seen.find((s) => s.url.includes("federation"))?.url ?? "");
    expect(fed.searchParams.get("Action")).toBe("getSigninToken");
    expect(fed.searchParams.get("SessionDuration")).toBe("3600");
    const f2 = fakeFetch();
    await req(
      "/t/infra/login",
      loginInit(await accessJwt(AUD_INFRA)),
      { ...env, SESSION_DURATION: "" },
      deps(f2),
    );
    const fed2 = new URL(f2.seen.find((s) => s.url.includes("federation"))?.url ?? "");
    expect(fed2.searchParams.has("SessionDuration")).toBe(false);
  });
  it("チームは AUD から決める: dev の AUD で /t/dev/login ならタグは dev", async () => {
    const f = fakeFetch();
    const r = await req(
      "/t/dev/login",
      loginInit(await accessJwt(AUD_DEV), "role=infra-only"),
      env,
      deps(f),
    );
    expect(r.status).toBe(302);
    const form = new URLSearchParams(f.seen.find((s) => s.url.startsWith("https://sts."))?.body);
    expect(form.get("RoleArn")).toBe(ROLE_INFRA);
    expect(decodeJwt(form.get("WebIdentityToken") ?? "")["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: { awsbridge_team: ["dev"] },
    });
  });

  const cases: [
    string,
    () => Promise<[string, RequestInit & { jwt?: string }, PortalEnv?]>,
    number,
    string,
  ][] = [
    [
      "JWT なし",
      async () => {
        const { jwt: _jwt, ...init } = loginInit("");
        return ["/t/infra/login", init];
      },
      401,
      "unauthorized",
    ],
    [
      "入口の AUD",
      async () => ["/t/infra/login", loginInit(await accessJwt(AUD_ENTRY))],
      403,
      "unknown_audience",
    ],
    [
      "未知の AUD",
      async () => ["/t/infra/login", loginInit(await accessJwt("d".repeat(64)))],
      403,
      "unknown_audience",
    ],
    [
      "パスのチームと AUD のチームが違う",
      async () => ["/t/infra/login", loginInit(await accessJwt(AUD_DEV))],
      403,
      "team_mismatch",
    ],
    [
      "Origin なし",
      async () => {
        const i = loginInit(await accessJwt(AUD_INFRA));
        const h = new Headers(i.headers);
        h.delete("origin");
        return ["/t/infra/login", { ...i, headers: h }];
      },
      403,
      "forbidden_origin",
    ],
    [
      "Content-Type が JSON",
      async () => {
        const i = loginInit(await accessJwt(AUD_INFRA));
        const h = new Headers(i.headers);
        h.set("content-type", "application/json");
        return ["/t/infra/login", { ...i, headers: h }];
      },
      415,
      "unsupported_media_type",
    ],
    [
      "一覧にないロール",
      async () => ["/t/infra/login", loginInit(await accessJwt(AUD_INFRA), "role=nope")],
      404,
      "not_listed",
    ],
    [
      "email が SourceIdentity の制約に合わない",
      async () => [
        "/t/infra/login",
        loginInit(await accessJwt(AUD_INFRA, { email: "a b@example.com" })),
      ],
      403,
      "identity_unsupported",
    ],
    [
      "std の鍵がない",
      async () => [
        "/t/infra/login",
        loginInit(await accessJwt(AUD_INFRA)),
        { ...env, SIGNING_JWK_STD: "" },
      ],
      500,
      "server_misconfigured",
    ],
  ];
  for (const [name, mk, status, code] of cases) {
    it(`${name} → ${status} ${code}（STS を呼ばない）`, async () => {
      const [path, init, e] = await mk();
      const f = fakeFetch();
      const r = await req(path, init, e ?? env, deps(f));
      expect(r.status).toBe(status);
      expect(await r.text()).toContain(code);
      expect(f.seen.filter((s) => s.url.startsWith("https://sts."))).toHaveLength(0);
    });
  }

  it("STS の AccessDenied は 403 sts_denied（信頼ポリシーが拒否。認可は AWS 側）", async () => {
    const f = fakeFetch({ stsStatus: 403, stsBody: stsErr("AccessDenied") });
    const r = await req("/t/infra/login", loginInit(await accessJwt(AUD_INFRA)), env, deps(f));
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("sts_denied");
    expect(f.seen.some((s) => s.url.includes("federation"))).toBe(false);
  });
  it("STS の InvalidIdentityToken は 502 upstream_auth_failed、5xx は 503", async () => {
    const r1 = await req(
      "/t/infra/login",
      loginInit(await accessJwt(AUD_INFRA)),
      env,
      deps(fakeFetch({ stsStatus: 400, stsBody: stsErr("InvalidIdentityToken") })),
    );
    expect(r1.status).toBe(502);
    expect(await r1.text()).toContain("upstream_auth_failed");
    const r2 = await req(
      "/t/infra/login",
      loginInit(await accessJwt(AUD_INFRA)),
      env,
      deps(fakeFetch({ stsStatus: 503, stsBody: stsErr("ServiceUnavailable") })),
    );
    expect(r2.status).toBe(503);
  });
  it("getSigninToken の失敗は 502 signin_failed", async () => {
    const r = await req(
      "/t/infra/login",
      loginInit(await accessJwt(AUD_INFRA)),
      env,
      deps(fakeFetch({ signin: "<html>error</html>" })),
    );
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("signin_failed");
  });
  it("GET /t/<team>/login は発行しない（案内だけ）", async () => {
    const f = fakeFetch();
    const r = await req("/t/infra/login", { jwt: await accessJwt(AUD_INFRA) }, env, deps(f));
    expect(r.status).toBe(200);
    expect(f.seen).toHaveLength(0);
  });
});

describe("宛先の差し替え（E2E 用）は 127.0.0.1 / localhost だけ", () => {
  it("STS_ENDPOINT・FEDERATION_ENDPOINT が http://127.0.0.1 ならそこへ、それ以外の値は無視して本物へ", async () => {
    const f = fakeFetch();
    const e = {
      ...env,
      STS_ENDPOINT: "https://evil.example.com/sts",
      FEDERATION_ENDPOINT: "https://evil.example.com/federation",
    };
    await req("/t/infra/login", loginInit(await accessJwt(AUD_INFRA)), e, deps(f));
    expect(f.seen.map((s) => new URL(s.url).host)).toEqual([
      "sts.ap-northeast-1.amazonaws.com",
      "signin.aws.amazon.com",
    ]);
  });
});

describe("そのほかの経路", () => {
  it("/t/<team>/expired は案内、知らないパスは 404、POST /whoami は 405", async () => {
    const jwt = await accessJwt(AUD_INFRA);
    expect((await req("/t/infra/expired", { jwt })).status).toBe(200);
    expect((await req("/nope", { jwt })).status).toBe(404);
    expect((await req("/whoami", { jwt, method: "POST", body: "x" })).status).toBe(405);
  });
  it("設定（PORTAL_BASE）が不正なら 500", async () => {
    const r = await req(
      "/std/.well-known/jwks.json",
      {},
      { ...env, PORTAL_BASE: "https://awsbridge.example.workers.dev" },
    );
    expect(r.status).toBe(500);
  });
});
