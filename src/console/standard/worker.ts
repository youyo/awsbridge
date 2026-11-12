// コンソールログイン（Standard の Worker）: Host での振り分け・issuer の文書・ポータルの経路・発行（9 段）。
// 設計: docs/specs/console-login-portal.md §3・§9・§10・§11。エントリ（index.ts）は生成物を渡してこの工場を呼ぶだけ。
//
//   issuer のホスト   境界の issuer の /<path>/.well-known/openid-configuration と jwks.json だけ。それ以外は 404
//   ポータルのホスト  ポータルの経路（portal/routes.ts。パス方式 R-P が既定、設定でホスト方式 R-H）
//   それ以外のホスト  404
//
// 生成物と secret は最初の要求で検査し、壊れていればどの経路も 500 server_misconfigured（ログは種別だけ）。
// 試験用の差し替え（StandardOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import type { JWK, JWTVerifyGetKey } from "jose";
import { withSecurityHeaders } from "../http/headers";
import { verifyConsoleAccess } from "../issue/access";
import { createCsrfToken, importCsrfKey } from "../issue/csrf";
import { stsEndpoint } from "../issue/federation";
import { createStandardSigner, parseSigningKeys } from "../issue/sign-standard";
import type { TokenSigner } from "../issue/signer";
import { handleLogin, type LoginRateLimiter } from "../portal/login";
import {
  errorPage,
  expiredPage,
  htmlResponse,
  loginFormPage,
  loginGetPage,
  placeholderPage,
} from "../portal/pages";
import { matchPortal, type PortalRoute } from "../portal/routes";
import { readWorkerConfig, WorkerConfigError } from "../portal/worker-config";
import type { WorkerConfig } from "../types";
import { discoveryDocument, jwksDocument, matchIssuerDoc } from "./issuer";

/** Standard の Worker の変数・secret・binding（wrangler.console-standard.jsonc）。 */
export type StandardEnv = {
  /** vars: Access のチームドメイン（https://<team>.cloudflareaccess.com）。 */
  ACCESS_TEAM_DOMAIN?: string;
  /** vars: 停止スイッチ。未設定・空・false・0 以外は発行を止める（503 login_disabled）。 */
  LOGIN_DISABLED?: string;
  /** vars: STS の地域の endpoint のリージョン（既定 us-east-1。グローバルの endpoint は使わない）。 */
  STS_REGION?: string;
  /** secret: 境界の名前 → 秘密鍵 JWK の JSON。 */
  CONSOLE_SIGNING_KEYS?: string;
  /** secret: CSRF トークンの HMAC の鍵（32 バイト以上。署名鍵と別）。 */
  CONSOLE_CSRF_KEY?: string;
  /** binding: Workers の Rate Limiting（利用者ごとの回数の制限）。 */
  LOGIN_RATE_LIMITER?: LoginRateLimiter;
};

export type StandardOverrides = {
  /** Access の certs の代わり（試験用）。 */
  getAccessKey?: JWTVerifyGetKey;
  /** STS・getSigninToken を呼ぶ fetch（試験用）。 */
  fetch?: typeof fetch;
  /** epoch ミリ秒（試験用）。 */
  now?: () => number;
};

export const DEFAULT_STS_REGION = "us-east-1";
const TIER = "standard" as const;

type Runtime = {
  config: WorkerConfig;
  accessTeamDomain: string;
  stsRegion: string;
  csrfKey: CryptoKey;
  keys: Record<string, JWK>;
  signer: TokenSigner;
  jwks: Map<string, Promise<{ keys: JWK[] }>>;
};

class EnvError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`invalid console env: ${kind}`);
    this.kind = kind;
  }
}

/** 停止スイッチ: 未設定・空・false・0 だけを「動かす」とし、それ以外の値は止める側に倒す。 */
export function isLoginDisabled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === "" || s === "false" || s === "0");
}

function readTeamDomain(v: unknown): string {
  if (typeof v !== "string") throw new EnvError("access_team_domain");
  const trimmed = v.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.protocol === "https:" && u.origin === trimmed) return trimmed;
  } catch {}
  throw new EnvError("access_team_domain");
}

async function buildRuntime(config: WorkerConfig, env: StandardEnv): Promise<Runtime> {
  const accessTeamDomain = readTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const stsRegion =
    env.STS_REGION === undefined || env.STS_REGION === "" ? DEFAULT_STS_REGION : env.STS_REGION;
  try {
    stsEndpoint(stsRegion);
  } catch {
    throw new EnvError("sts_region");
  }
  let keys: Record<string, JWK>;
  try {
    keys = parseSigningKeys(env.CONSOLE_SIGNING_KEYS ?? "");
  } catch {
    throw new EnvError("signing_keys");
  }
  let csrfKey: CryptoKey;
  try {
    csrfKey = await importCsrfKey(env.CONSOLE_CSRF_KEY ?? "");
  } catch {
    throw new EnvError("csrf_key");
  }
  return {
    config,
    accessTeamDomain,
    stsRegion,
    csrfKey,
    keys,
    signer: createStandardSigner({ keys }),
    jwks: new Map(),
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const methodNotAllowed = (allow: string, requestId: string | undefined) =>
  htmlResponse(errorPage("method_not_allowed", { requestId }), 405, { Allow: allow });

export function createStandardWorker(rawConfig: unknown, o: StandardOverrides = {}) {
  const now = o.now ?? (() => Date.now());
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));
  let configResult: { ok: true; config: WorkerConfig } | { ok: false; kind: string } | undefined;
  const runtimes = new WeakMap<object, Promise<Runtime | EnvError>>();

  const loadConfig = () => {
    if (!configResult) {
      try {
        configResult = { ok: true, config: readWorkerConfig(rawConfig, TIER) };
      } catch (e) {
        configResult = { ok: false, kind: e instanceof WorkerConfigError ? e.kind : "unknown" };
      }
    }
    return configResult;
  };

  const loadRuntime = (config: WorkerConfig, env: StandardEnv): Promise<Runtime | EnvError> => {
    let p = runtimes.get(env);
    if (!p) {
      p = buildRuntime(config, env).catch((e: unknown) =>
        e instanceof EnvError ? e : new EnvError("unknown"),
      );
      runtimes.set(env, p);
    }
    return p;
  };

  async function route(req: Request, env: StandardEnv): Promise<Response> {
    const requestId = req.headers.get("Cf-Ray") ?? undefined;
    const misconfigured = () => htmlResponse(errorPage("server_misconfigured", { requestId }), 500);

    const c = loadConfig();
    if (!c.ok) {
      console.error(`config: invalid console config: ${c.kind}`);
      return misconfigured();
    }
    const rt = await loadRuntime(c.config, env);
    if (rt instanceof EnvError) {
      console.error(`config: invalid console env: ${rt.kind}`);
      return misconfigured();
    }
    const { config } = rt;
    const url = new URL(req.url);
    const isRead = req.method === "GET" || req.method === "HEAD";

    // issuer の文書（URL のホストとパスの完全一致だけ）
    const doc = matchIssuerDoc(url, config);
    if (doc && doc.kind !== "not_found") {
      if (!isRead) return methodNotAllowed("GET, HEAD", requestId);
      if (doc.kind === "discovery") return json(discoveryDocument(doc.issuer));
      const jwk = Object.hasOwn(rt.keys, doc.boundary) ? rt.keys[doc.boundary] : undefined;
      if (!jwk) {
        console.error("config: invalid console env: signing_key_missing");
        return misconfigured();
      }
      let p = rt.jwks.get(doc.boundary);
      if (!p) {
        p = jwksDocument(jwk);
        rt.jwks.set(doc.boundary, p);
        p.catch(() => rt.jwks.delete(doc.boundary));
      }
      try {
        return json(await p);
      } catch {
        console.error("config: invalid console env: signing_key");
        return misconfigured();
      }
    }

    // ポータルの経路（issuer とポータルが同じホストのときは、issuer の文書のパスを先に見た）
    const portal = matchPortal(url, config);
    if (!portal || portal.kind === "not_found") {
      return htmlResponse(errorPage("not_found", { requestId }), 404);
    }
    return portalRoute(req, env, rt, portal, requestId, isRead);
  }

  async function portalRoute(
    req: Request,
    env: StandardEnv,
    rt: Runtime,
    portal: Exclude<PortalRoute, { kind: "not_found" }>,
    requestId: string | undefined,
    isRead: boolean,
  ): Promise<Response> {
    const { config } = rt;
    const loginDisabled = isLoginDisabled(env.LOGIN_DISABLED);
    if (portal.kind === "entry") {
      if (!isRead) return methodNotAllowed("GET, HEAD", requestId);
      return htmlResponse(placeholderPage("AWS ログイン"));
    }
    const { team, teamBase, teamOrigin, page } = portal;
    const errOpts = { requestId, teamBase, supportUrl: config.portal.supportUrl };

    if (page === "login" && !isRead) {
      if (req.method !== "POST") return methodNotAllowed("GET, HEAD, POST", requestId);
      const out = await handleLogin(req, {
        tier: TIER,
        config,
        team,
        teamOrigin,
        accessTeamDomain: rt.accessTeamDomain,
        loginDisabled,
        csrfKey: rt.csrfKey,
        signer: rt.signer,
        rateLimiter: env.LOGIN_RATE_LIMITER,
        stsRegion: rt.stsRegion,
        fetch: doFetch,
        now,
        log: (line) => console.log(line),
        getAccessKey: o.getAccessKey,
      });
      if (out.ok) return new Response(null, { status: 302, headers: { Location: out.location } });
      return htmlResponse(errorPage(out.code, errOpts), out.status);
    }

    if (!isRead) return methodNotAllowed("GET, HEAD", requestId);

    // チームのパスの画面（GET /login・/expired・S1・S2・S3）は、Access JWT を確かめてから描く（G-6 の原則。
    // JWT がない・AUD が未知・チームが違えば断る。S2 の CSRF トークンにも aud と sub が要る）
    const access = await verifyConsoleAccess(
      req.headers.get("Cf-Access-Jwt-Assertion"),
      team,
      { teamDomain: rt.accessTeamDomain, teams: config.teams, entryAud: config.portal.entryAud },
      {
        ...(o.getAccessKey ? { getKey: o.getAccessKey } : {}),
        now: Math.floor(now() / 1000),
      },
    );
    if (!access.ok) return htmlResponse(errorPage(access.code, errOpts), access.status);

    if (page === "login") return htmlResponse(loginGetPage(teamBase));
    if (page === "expired") return htmlResponse(expiredPage(teamBase));

    if (page === "list") return htmlResponse(placeholderPage("一覧"));
    const account = config.accounts.find((a) => a.accountId === portal.accountId);
    const roles = (account?.roles ?? []).flatMap((r) => {
      const role = config.roles.find((x) => x.name === r.role);
      return role && r.teams.includes(team) ? [{ role, sessionSeconds: r.sessionSeconds }] : [];
    });
    if (!account || roles.length === 0) return htmlResponse(errorPage("not_listed", errOpts), 404);
    if (page === "cli") return htmlResponse(placeholderPage("CLI で使う", `${teamBase}/`));

    const roleParam = new URL(req.url).searchParams.get("role") ?? undefined;
    const csrf = await createCsrfToken(
      rt.csrfKey,
      { aud: access.aud, sub: access.sub },
      Math.floor(now() / 1000),
    );
    return htmlResponse(
      loginFormPage({
        config,
        team,
        teamBase,
        account,
        roles,
        selectedRole: roleParam,
        csrf,
        loginDisabled,
      }),
    );
  }

  return {
    async fetch(req: Request, env: StandardEnv): Promise<Response> {
      let res: Response;
      try {
        res = await route(req, typeof env === "object" && env !== null ? env : {});
      } catch {
        // 想定外の例外は発行しない側に倒す（詳細は出さない）
        console.error("console: unexpected error");
        res = htmlResponse(
          errorPage("server_misconfigured", { requestId: req.headers.get("Cf-Ray") ?? undefined }),
          500,
        );
      }
      const secured = withSecurityHeaders(res);
      return req.method === "HEAD"
        ? new Response(null, { status: secured.status, headers: secured.headers })
        : secured;
    },
  };
}
