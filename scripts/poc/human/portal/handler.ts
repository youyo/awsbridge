// PoC のポータル Worker（awsbridge-human-poc-portal）の処理。自社ドメインの Custom Domain に置く PoC 専用で、本番のポータルではない。
//
// 経路:
//   GET  /{std,admin}/.well-known/openid-configuration・jwks.json  N9 のパス付き issuer（Access は Bypass）
//   GET  /whoami、/t/<team>/whoami                                 N1: 検証した Access JWT の aud と、そこから決めたチーム（JSON）
//   GET  /、/t/<team>/（?refresh=<秒> で自動再読み込み）          同じ内容の HTML。チームのページにはログインのフォーム
//   POST /t/<team>/login                                           N10: Access JWT → AUD からチーム → 自前 JWT → STS → getSigninToken → 302
//   GET  /t/<team>/login、/t/<team>/expired                        案内だけ（発行しない）
//   GET  /t/<team>/poc-token                                       PoC 専用（POC_TOKEN_ENDPOINT=enabled のときだけ）。検証できて
//                                                                  チームが一致した生の Access JWT を添付ファイルで返す（B4: 失効済み
//                                                                  JWT の持ち込みの確認用）。設計書の本番の Worker には入れない
//
// 守ること: チームは検証した Access JWT の AUD だけから決める（パスは食い違いの検出だけ）。未知の AUD には発行しない。
// 一時認証情報・サインイントークン・JWT は応答の本文とログに出さない（ログイン URL は Location にだけ入れる）。
// ロールは設定 ROLES から選ばせるが、チームでは絞らない（入れるかどうかは信頼ポリシーに判断させ、拒否を観察する）。
import {
  createRemoteJWKSet,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { publicJwkOf } from "../../../../src/keys";
import { buildDiscovery } from "../../../../src/oidc";
import { parseAssumeRoleResponse, parseStsError } from "../../../../src/sts-xml";
import {
  assumeRoleWithWebIdentityParams,
  consoleDestination,
  FEDERATION_ENDPOINT,
  getSigninTokenParams,
  humanSessionName,
  loginUrl,
  parseSigninTokenResponse,
  stsEndpoint,
} from "../claims";
import {
  checkLoginRequest,
  escapeHtml,
  issuerFor,
  maskEmail,
  normalizePortalBase,
  PORTAL_DEFAULTS,
  parseAudMap,
  parseRoles,
  signPortalToken,
  type Tier,
  teamFromAud,
  teamFromPath,
} from "./lib";

export interface PortalEnv {
  /** https://awsbridge-human-poc-portal.<自社ドメインのゾーン>（issuer の土台。ポータルのオリジン） */
  PORTAL_BASE: string;
  /** https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** {"<aud>": "<team>"}（Terraform の出力から deploy.ts が作る） */
  ACCESS_AUD_MAP?: string;
  /** 入口のアプリの AUD（既知だが、どのチームにも対応しない） */
  ACCESS_ENTRY_AUD?: string;
  /** STS に渡す JWT の aud（既定 awsbridge-human-poc-portal） */
  AUDIENCE?: string;
  REGION?: string;
  /** [{"label": "...", "arn": "..."}] */
  ROLES?: string;
  /** getSigninToken の SessionDuration（秒。空なら付けない） */
  SESSION_DURATION?: string;
  /** secret: 階層ごとの署名鍵（秘密鍵 JWK の JSON） */
  SIGNING_JWK_STD?: string;
  SIGNING_JWK_ADMIN?: string;
  /** E2E 用。http://127.0.0.1 / http://localhost のときだけ使う */
  STS_ENDPOINT?: string;
  FEDERATION_ENDPOINT?: string;
  /** PoC 専用。"enabled" のときだけ GET /t/<team>/poc-token を開ける（deploy.ts --poc-token）。本番の Worker には入れない */
  POC_TOKEN_ENDPOINT?: string;
}

export interface PortalDeps {
  fetch: typeof fetch;
  /** Access の署名鍵の解決（テスト用）。省略時はチームドメインの /cdn-cgi/access/certs */
  accessKey?: JWTVerifyGetKey;
  /** epoch 秒（テスト用） */
  now?: () => number;
}

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const CLOCK_TOLERANCE_SECONDS = 30;

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://signin.aws.amazon.com https://*.signin.aws.amazon.com https://console.aws.amazon.com https://*.console.aws.amazon.com; frame-ancestors 'none'; base-uri 'none'";

const isLocalUrl = (s: string | undefined): s is string =>
  s !== undefined && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(s);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function html(title: string, body: string, status = 200, refresh?: number): Response {
  const meta = refresh ? `<meta http-equiv="refresh" content="${refresh}">` : "";
  const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8">${meta}<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}table{border-collapse:collapse}td,th{border:1px solid #999;padding:.2rem .5rem;text-align:left;font-family:monospace}</style>
</head><body><p>awsbridge PoC（人間のログイン）のポータル。本番ではない。</p><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(page, {
    status,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
    },
  });
}

function errorPage(status: number, code: string): Response {
  return html(`エラー: ${code}`, `<p>HTTP ${status} <code>${escapeHtml(code)}</code></p>`, status);
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

// ---- Access JWT ----

const jwksCache = new Map<string, JWTVerifyGetKey>();

function accessTeamDomain(env: PortalEnv): string {
  const d = (env.ACCESS_TEAM_DOMAIN ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(d) && !isLocalUrl(d))
    throw new Error("ACCESS_TEAM_DOMAIN");
  return d;
}

interface AccessResult {
  ok: boolean;
  payload?: JWTPayload;
  error?: string;
}

async function verifyAccess(req: Request, env: PortalEnv, deps: PortalDeps): Promise<AccessResult> {
  const token = req.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false, error: "missing" };
  const domain = accessTeamDomain(env);
  let getKey = deps.accessKey ?? jwksCache.get(domain);
  if (!getKey) {
    getKey = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
    jwksCache.set(domain, getKey);
  }
  try {
    // aud はここでは検査せず、teamFromAud で既知の AUD と突き合わせる（M2 で未知の aud も観察するため。署名・iss・exp は検証する）
    const { payload } = await jwtVerify(token, getKey, {
      issuer: domain,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      ...(deps.now ? { currentDate: new Date(deps.now() * 1000) } : {}),
    });
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: (e as { code?: string }).code ?? "invalid" };
  }
}

interface Whoami {
  verified: boolean;
  error?: string;
  path: string;
  path_team: string | null;
  aud: string[];
  entry_aud: boolean;
  aud_team: string | null;
  aud_error?: string;
  team_match: boolean;
  email: string | null;
  iat: number | null;
  exp: number | null;
  now: number;
}

function whoamiOf(path: string, access: AccessResult, env: PortalEnv, now: number): Whoami {
  const pathTeam = teamFromPath(path) ?? null;
  if (!access.ok || !access.payload)
    return {
      verified: false,
      error: access.error ?? "invalid",
      path,
      path_team: pathTeam,
      aud: [],
      entry_aud: false,
      aud_team: null,
      team_match: false,
      email: null,
      iat: null,
      exp: null,
      now,
    };
  const p = access.payload;
  const aud = typeof p.aud === "string" ? [p.aud] : Array.isArray(p.aud) ? p.aud : [];
  const team = teamFromAud(aud, parseAudMap(env.ACCESS_AUD_MAP ?? "{}"));
  const email = typeof p.email === "string" ? p.email : null;
  return {
    verified: true,
    path,
    path_team: pathTeam,
    aud,
    entry_aud: env.ACCESS_ENTRY_AUD !== undefined && aud.includes(env.ACCESS_ENTRY_AUD),
    aud_team: team.ok ? team.team : null,
    ...(team.ok ? {} : { aud_error: team.code }),
    team_match: team.ok && team.team === pathTeam,
    email: email === null ? null : maskEmail(email),
    iat: typeof p.iat === "number" ? p.iat : null,
    exp: typeof p.exp === "number" ? p.exp : null,
    now,
  };
}

function whoamiTable(w: Whoami): string {
  const iso = (t: number | null) => (t === null ? "-" : new Date(t * 1000).toISOString());
  const rows: [string, string][] = [
    ["verified", String(w.verified)],
    ["error", w.error ?? "-"],
    ["path_team（パスのチーム）", w.path_team ?? "-"],
    ["aud", w.aud.join(", ") || "-"],
    ["entry_aud（入口のアプリの AUD）", String(w.entry_aud)],
    ["aud_team（AUD から決めたチーム）", w.aud_team ?? `- (${w.aud_error ?? ""})`],
    ["team_match", String(w.team_match)],
    ["email", w.email ?? "-"],
    ["iat（Access JWT の発行）", iso(w.iat)],
    ["exp", iso(w.exp)],
    ["now（Worker）", iso(w.now)],
  ];
  return `<table>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}</table>`;
}

// ---- issuer の文書 ----

function signingJwk(env: PortalEnv, tier: Tier): JWK | undefined {
  const raw = tier === "std" ? env.SIGNING_JWK_STD : env.SIGNING_JWK_ADMIN;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as JWK;
  } catch {
    return undefined;
  }
}

async function issuerDocument(
  env: PortalEnv,
  base: string,
  tier: Tier,
  doc: "openid-configuration" | "jwks.json",
): Promise<Response> {
  const jwk = signingJwk(env, tier);
  if (!jwk) return json({ error: "server_misconfigured" }, 500);
  let body: unknown;
  try {
    body =
      doc === "openid-configuration"
        ? buildDiscovery(issuerFor(base, tier))
        : { keys: [await publicJwkOf(jwk)] };
  } catch {
    return json({ error: "server_misconfigured" }, 500);
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "max-age=300" },
  });
}

// ---- ログイン ----

const SI_RE = /^[\w+=,.@-]{2,64}$/;

async function login(
  req: Request,
  env: PortalEnv,
  deps: PortalDeps,
  base: string,
  pathTeam: string,
): Promise<Response> {
  const fail = (status: number, code: string, extra: Record<string, unknown> = {}) => {
    log({ event: "login", team: pathTeam, outcome: "error", code, ...extra });
    return errorPage(status, code);
  };
  const access = await verifyAccess(req, env, deps);
  if (!access.ok || !access.payload) return fail(401, "unauthorized");
  const team = teamFromAud(access.payload.aud, parseAudMap(env.ACCESS_AUD_MAP ?? "{}"));
  if (!team.ok)
    return fail(403, team.code === "ambiguous_audience" ? "unknown_audience" : team.code);
  if (team.team !== pathTeam) return fail(403, "team_mismatch", { aud_team: team.team });
  const bad = checkLoginRequest({
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    contentType: req.headers.get("content-type"),
    expectedOrigin: new URL(base).origin,
  });
  if (bad) return fail(bad.status, bad.code);

  const form = new URLSearchParams(await req.text());
  const role = parseRoles(env.ROLES).find((r) => r.label === form.get("role"));
  if (!role) return fail(404, "not_listed");
  const email = access.payload.email;
  if (typeof email !== "string" || !SI_RE.test(email)) return fail(403, "identity_unsupported");
  const jwk = signingJwk(env, "std");
  if (!jwk) return fail(500, "server_misconfigured");

  const region = env.REGION || PORTAL_DEFAULTS.region;
  const token = await signPortalToken({
    privateJwk: jwk,
    issuer: issuerFor(base, "std"),
    audience: env.AUDIENCE || PORTAL_DEFAULTS.audience,
    subject: email,
    team: team.team,
    sourceIdentity: email,
    ...(deps.now ? { now: deps.now() } : {}),
  });
  const ctx = {
    role: role.label,
    sub: maskEmail(email),
    access_iat: access.payload.iat ?? null,
  };

  // STS（署名なし。DurationSeconds は付けない = ロールの既定 1 時間）
  let status = 0;
  let xml = "";
  try {
    const res = await deps.fetch(
      isLocalUrl(env.STS_ENDPOINT) ? env.STS_ENDPOINT : stsEndpoint(region),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: assumeRoleWithWebIdentityParams({
          roleArn: role.arn,
          roleSessionName: humanSessionName(email),
          webIdentityToken: token,
        }).toString(),
      },
    );
    status = res.status;
    xml = await res.text();
  } catch {
    return fail(503, "temporarily_unavailable", ctx);
  }
  const creds = status === 200 ? parseAssumeRoleResponse(xml) : undefined;
  if (!creds) {
    const code = parseStsError(xml)?.code ?? "Unknown";
    if (code === "AccessDenied") return fail(403, "sts_denied", { ...ctx, sts: code });
    if (["InvalidIdentityToken", "IDPRejectedClaim", "ExpiredTokenException"].includes(code))
      return fail(502, "upstream_auth_failed", { ...ctx, sts: code });
    return fail(503, "temporarily_unavailable", { ...ctx, sts: code, status });
  }

  // getSigninToken（GET。PoC-A で SessionDuration つきが通った形）
  const fed = isLocalUrl(env.FEDERATION_ENDPOINT) ? env.FEDERATION_ENDPOINT : FEDERATION_ENDPOINT;
  const sd =
    env.SESSION_DURATION && /^\d+$/.test(env.SESSION_DURATION)
      ? Number(env.SESSION_DURATION)
      : undefined;
  let signinToken: string | undefined;
  try {
    const res = await deps.fetch(`${fed}?${getSigninTokenParams(creds, sd)}`, { method: "GET" });
    signinToken = res.status === 200 ? parseSigninTokenResponse(await res.text()) : undefined;
  } catch {
    signinToken = undefined;
  }
  if (!signinToken) return fail(502, "signin_failed", ctx);

  log({ event: "login", team: team.team, outcome: "ok", session_duration: sd ?? null, ...ctx });
  const location = loginUrl({
    signinToken,
    issuer: `${base}/t/${team.team}/expired`,
    destination: consoleDestination(region),
    endpoint: fed,
  });
  return new Response(null, { status: 302, headers: { ...COMMON_HEADERS, location } });
}

// ---- PoC 専用: 生の Access JWT ----

/** B4 の持ち込み用に、検証できてチームが一致した Access JWT をそのまま返す。トークンはログに出さない。 */
async function pocToken(
  req: Request,
  env: PortalEnv,
  deps: PortalDeps,
  pathTeam: string,
): Promise<Response> {
  const access = await verifyAccess(req, env, deps);
  if (!access.ok || !access.payload) {
    log({ event: "poc_token", team: pathTeam, outcome: "error", code: "unauthorized" });
    return json({ error: "unauthorized" }, 401);
  }
  const team = teamFromAud(access.payload.aud, parseAudMap(env.ACCESS_AUD_MAP ?? "{}"));
  if (!team.ok || team.team !== pathTeam) {
    const code = team.ok ? "team_mismatch" : team.code;
    log({ event: "poc_token", team: pathTeam, outcome: "error", code });
    return json({ error: code }, 403);
  }
  const email = access.payload.email;
  log({
    event: "poc_token",
    team: team.team,
    outcome: "ok",
    sub: typeof email === "string" ? maskEmail(email) : null,
    access_iat: access.payload.iat ?? null,
  });
  return new Response(`${req.headers.get(ACCESS_JWT_HEADER)}\n`, {
    headers: {
      ...COMMON_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="awsbridge-poc-access-jwt.txt"',
    },
  });
}

// ---- 入口 ----

const DOC_RE = /^\/(std|admin)\/\.well-known\/(openid-configuration|jwks\.json)$/;

export async function handlePortalRequest(
  req: Request,
  env: PortalEnv,
  deps: PortalDeps,
): Promise<Response> {
  let base: string;
  try {
    base = normalizePortalBase(env.PORTAL_BASE);
    parseAudMap(env.ACCESS_AUD_MAP ?? "{}");
    parseRoles(env.ROLES);
  } catch {
    return json({ error: "server_misconfigured" }, 500);
  }
  const url = new URL(req.url);
  const path = url.pathname;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const readOnly = req.method === "GET" || req.method === "HEAD";

  const doc = DOC_RE.exec(path);
  if (doc) {
    if (!readOnly) return new Response("method not allowed", { status: 405 });
    return issuerDocument(env, base, doc[1] as Tier, doc[2] as "openid-configuration");
  }

  const pathTeam = teamFromPath(path);
  const isWhoami =
    path === "/whoami" || (pathTeam !== undefined && path === `/t/${pathTeam}/whoami`);
  const isPage =
    path === "/" ||
    (pathTeam !== undefined && (path === `/t/${pathTeam}` || path === `/t/${pathTeam}/`));
  const isLogin = pathTeam !== undefined && path === `/t/${pathTeam}/login`;
  const isExpired = pathTeam !== undefined && path === `/t/${pathTeam}/expired`;
  const isPocToken =
    env.POC_TOKEN_ENDPOINT === "enabled" &&
    pathTeam !== undefined &&
    path === `/t/${pathTeam}/poc-token`;
  if (!isWhoami && !isPage && !isLogin && !isExpired && !isPocToken)
    return new Response("not found", { status: 404 });

  try {
    accessTeamDomain(env);
  } catch {
    return json({ error: "server_misconfigured" }, 500);
  }

  if (isLogin && req.method === "POST") return login(req, env, deps, base, pathTeam as string);
  if (!readOnly) return new Response("method not allowed", { status: 405 });
  if (isPocToken) return pocToken(req, env, deps, pathTeam as string);

  if (isLogin)
    return html(
      "もう一度選んでください",
      `<p>ログインは発行しません（GET）。<a href="/t/${escapeHtml(pathTeam as string)}/">チームのページ</a>から選び直してください。</p>`,
    );
  if (isExpired)
    return html(
      "コンソールのセッションが切れました",
      `<p><a href="/t/${escapeHtml(pathTeam as string)}/">チームのページ</a>からもう一度ログインしてください。</p>`,
    );

  const access = await verifyAccess(req, env, deps);
  const w = whoamiOf(path, access, env, now);
  log({
    event: "whoami",
    path,
    verified: w.verified,
    aud_team: w.aud_team,
    path_team: w.path_team,
    entry_aud: w.entry_aud,
    access_iat: w.iat,
    sub: w.email,
  });
  if (isWhoami) return json(w, w.verified ? 200 : 401);

  const refreshRaw = Number(url.searchParams.get("refresh"));
  const refresh =
    Number.isInteger(refreshRaw) && refreshRaw >= 5 && refreshRaw <= 600 ? refreshRaw : undefined;
  const roles = parseRoles(env.ROLES);
  const formHtml =
    pathTeam === undefined
      ? `<p>チームのページ: ${Object.values(parseAudMap(env.ACCESS_AUD_MAP ?? "{}"))
          .map((t) => `<a href="/t/${escapeHtml(t)}/">${escapeHtml(t)}</a>`)
          .join(" / ")}</p>`
      : `<h2>コンソールにログイン（N10）</h2>
<form method="post" action="/t/${escapeHtml(pathTeam)}/login">
${roles.map((r, i) => `<label><input type="radio" name="role" value="${escapeHtml(r.label)}"${i === 0 ? " checked" : ""}> ${escapeHtml(r.label)}</label><br>`).join("\n")}
<button type="submit">コンソールを開く</button></form>
<p>チームは Access JWT の AUD から決めます（このページのパスではない）。ロールの一覧はチームで絞っていないので、信頼ポリシーが拒否すると sts_denied になります。</p>`;
  return html(
    pathTeam === undefined ? "入口" : `チーム ${pathTeam}`,
    `${whoamiTable(w)}${formHtml}`,
    w.verified ? 200 : 401,
    refresh,
  );
}
