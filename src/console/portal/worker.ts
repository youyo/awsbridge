// コンソールログイン（ポータルの Worker の工場）: 階層（Standard / Admin）に共通の経路・画面・発行の振り分け。
// 設計: docs/specs/console-login-portal.md §3・§9・§10・§11。階層ごとのエントリ（standard/worker.ts・admin/worker.ts）が、
// 階層・署名の部品・issuer の文書を渡してこの工場を呼ぶ。この工場は階層ごとの鍵の扱い・issuer の文書の中身・OIDC を知らない。
//
//   issuer のホスト   境界の issuer の文書。スペックが渡す serveIssuer が処理する（Standard は境界ごと、Admin は Admin の issuer の /admin）
//   ポータルのホスト  ポータルの経路（portal/routes.ts。パス方式 R-P が既定、設定でホスト方式 R-H）
//   それ以外のホスト  404
//
// teamPathOnly（Admin）: 設定を確かめたら、env を読む前に、チームのパス（またはチームのホスト）と isIssuerDoc の経路以外を 404 にする（G-6）。
// 生成物と secret は最初の要求で検査し、壊れていればどの経路も 500 server_misconfigured（ログは種別だけ）。
// 試験用の差し替え（PortalOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import type { JWTVerifyGetKey } from "jose";
import type { Tier } from "../constants";
import { withSecurityHeaders } from "../http/headers";
import { verifyConsoleAccess } from "../issue/access";
import { createCsrfToken, importCsrfKey } from "../issue/csrf";
import { stsEndpoint } from "../issue/federation";
import type { TokenSigner } from "../issue/signer";
import type { WorkerConfig } from "../types";
import { assetResponse, isAssetName, isStaticResponse } from "./assets";
import { handleLogin, type LoginRateLimiter } from "./login";
import {
  cliPage,
  errorPage,
  expiredPage,
  htmlResponse,
  listPage,
  loginFormPage,
  loginGetPage,
  QUERY_MAX,
  tierMark,
} from "./pages";
import { matchPortal, type PortalRoute } from "./routes";
import { readWorkerConfig, WorkerConfigError } from "./worker-config";

/** 階層に共通の変数・secret・binding。階層ごとの env はこれを広げる。 */
export type PortalEnv = {
  /** vars: Access のチームドメイン（https://<team>.cloudflareaccess.com）。 */
  ACCESS_TEAM_DOMAIN?: string;
  /** vars: 停止スイッチ。未設定・空・false・0 以外は発行を止める（503 login_disabled）。 */
  LOGIN_DISABLED?: string;
  /** vars: STS の地域の endpoint のリージョン（既定 us-east-1。グローバルの endpoint は使わない）。 */
  STS_REGION?: string;
  /** secret: CSRF トークンの HMAC の鍵（32 バイト以上。署名鍵と別）。 */
  CONSOLE_CSRF_KEY?: string;
  /** binding: Workers の Rate Limiting（利用者ごとの回数の制限）。 */
  LOGIN_RATE_LIMITER?: LoginRateLimiter;
};

export type PortalOverrides = {
  /** Access の certs の代わり（試験用）。 */
  getAccessKey?: JWTVerifyGetKey;
  /** STS・getSigninToken を呼ぶ fetch（試験用）。 */
  fetch?: typeof fetch;
  /** epoch ミリ秒（試験用）。 */
  now?: () => number;
};

/** env の誤り（種別だけを持つ。値は入れない）。階層ごとの buildTier も、これを投げて 500 にする。 */
export class EnvError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`invalid console env: ${kind}`);
    this.kind = kind;
  }
}

/**
 * issuer のホストの要求を処理する。処理しない（issuer のホストでない・文書の経路でない）なら undefined を返し、
 * ポータルの経路に進む（issuer とポータルが同じホストのときは、issuer の文書のパスを先に見る）。
 */
export type IssuerHandler = (
  url: URL,
  ctx: { isRead: boolean; requestId: string | undefined },
) => Promise<Response | undefined>;

/** 入口（S0）の画面を描く処理に渡す文脈。 */
export type EntryContext = {
  config: WorkerConfig;
  accessTeamDomain: string;
  getAccessKey?: JWTVerifyGetKey | undefined;
  now: () => number;
  requestId: string | undefined;
  /** 入口の静的なファイル（/assets/<name>）の名前。無ければ入口の画面（/）。 */
  asset?: string | undefined;
};

/**
 * 入口（S0。GET・HEAD の /）を描く処理。Standard だけが渡す（表示用の生成物はこの処理の中だけで読む）。
 * 共通の工場は表示用の照合のコードと生成物を import しない（Admin のバンドルに入れないため）。
 */
export type EntryHandler = (req: Request, ctx: EntryContext) => Promise<Response>;

/** 階層ごとの部品。env から作る。 */
export type TierPart = {
  signer: TokenSigner;
  /** 境界の issuer の文書（Standard は境界ごと、Admin は Admin の issuer のホストの /admin。X1 の決裁で A-3 = I-B）。 */
  serveIssuer?: IssuerHandler;
  /**
   * Access JWT の iat からの経過時間の上限（秒）。渡せば画面と発行の両方で見る（Admin だけ。X1 の決裁 (f)）。
   * 渡さなければ見ない（Standard の振る舞いは変えない）。
   */
  accessMaxAgeSeconds?: number;
  /**
   * デプロイ後の確認（GET <team-base>/key-check）。Access JWT の検証と回数の制限（LOGIN_RATE_LIMITER、
   * キー <階層>-key-check:<sub>。Admin は admin-key-check:、Standard は standard-key-check:）の後ろで呼ぶ。
   * team はパスのチーム（Access JWT の検証済み）。渡さない階層は、この経路を JWT の検証の前に 404 にする。
   */
  keyCheck?: (ctx: { team: string }) => Promise<unknown>;
};

export type PortalWorkerSpec<Env extends PortalEnv> = {
  tier: Tier;
  /** true: チームのパス以外を、env を読む前（処理の最初）に 404 にする。入口（/）も持たない。 */
  teamPathOnly?: boolean;
  /**
   * teamPathOnly のとき、処理の最初の 404 の例外にする issuer の文書の経路（設定だけで判定する。env は読まない）。
   * Admin は Admin の issuer のホストの 2 つの文書のパスだけ。
   */
  isIssuerDoc?(url: URL, config: WorkerConfig): boolean;
  /** 入口（/）の画面。渡さなければ入口は 404。 */
  serveEntry?: EntryHandler;
  /** 階層ごとの env の検査と部品の作成。誤りは EnvError（種別だけ）で投げる。 */
  buildTier(env: Env, config: WorkerConfig): Promise<TierPart> | TierPart;
};

export const DEFAULT_STS_REGION = "us-east-1";

type Runtime = {
  config: WorkerConfig;
  accessTeamDomain: string;
  stsRegion: string;
  csrfKey: CryptoKey;
  part: TierPart;
};

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

export const misconfigured = (requestId: string | undefined, mark?: string): Response =>
  htmlResponse(errorPage("server_misconfigured", { requestId, mark }), 500);

export const methodNotAllowed = (
  allow: string,
  requestId: string | undefined,
  mark?: string,
): Response =>
  htmlResponse(errorPage("method_not_allowed", { requestId, mark }), 405, { Allow: allow });

export function createPortalWorker<Env extends PortalEnv>(
  rawConfig: unknown,
  spec: PortalWorkerSpec<Env>,
  o: PortalOverrides = {},
) {
  const tier = spec.tier;
  const mark = tierMark(tier);
  const now = o.now ?? (() => Date.now());
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));
  let configResult: { ok: true; config: WorkerConfig } | { ok: false; kind: string } | undefined;
  const runtimes = new WeakMap<object, Promise<Runtime | EnvError>>();

  const loadConfig = () => {
    if (!configResult) {
      try {
        configResult = { ok: true, config: readWorkerConfig(rawConfig, tier) };
      } catch (e) {
        configResult = { ok: false, kind: e instanceof WorkerConfigError ? e.kind : "unknown" };
      }
    }
    return configResult;
  };

  async function buildRuntime(config: WorkerConfig, env: Env): Promise<Runtime> {
    const accessTeamDomain = readTeamDomain(env.ACCESS_TEAM_DOMAIN);
    const stsRegion =
      env.STS_REGION === undefined || env.STS_REGION === "" ? DEFAULT_STS_REGION : env.STS_REGION;
    try {
      stsEndpoint(stsRegion);
    } catch {
      throw new EnvError("sts_region");
    }
    const part = await spec.buildTier(env, config);
    let csrfKey: CryptoKey;
    try {
      csrfKey = await importCsrfKey(env.CONSOLE_CSRF_KEY ?? "");
    } catch {
      throw new EnvError("csrf_key");
    }
    return { config, accessTeamDomain, stsRegion, csrfKey, part };
  }

  const loadRuntime = (config: WorkerConfig, env: Env): Promise<Runtime | EnvError> => {
    let p = runtimes.get(env);
    if (!p) {
      p = buildRuntime(config, env).catch((e: unknown) =>
        e instanceof EnvError ? e : new EnvError("unknown"),
      );
      runtimes.set(env, p);
    }
    return p;
  };

  async function route(req: Request, env: Env): Promise<Response> {
    const requestId = req.headers.get("Cf-Ray") ?? undefined;

    const c = loadConfig();
    if (!c.ok) {
      console.error(`config: invalid console config: ${c.kind}`);
      return misconfigured(requestId, mark);
    }
    const url = new URL(req.url);

    // 処理の最初（Admin）: チームのパスと issuer の文書のパス以外は 404。env・Access JWT は見ない（G-6）
    let early: PortalRoute | undefined;
    if (spec.teamPathOnly) {
      early = matchPortal(url, c.config);
      if (early?.kind !== "team") {
        if (!spec.isIssuerDoc?.(url, c.config))
          return htmlResponse(errorPage("not_found", { requestId, mark }), 404);
        early = undefined;
      }
    }

    const rt = await loadRuntime(c.config, env);
    if (rt instanceof EnvError) {
      console.error(`config: invalid console env: ${rt.kind}`);
      return misconfigured(requestId, mark);
    }
    const { config } = rt;
    const isRead = req.method === "GET" || req.method === "HEAD";

    // issuer の文書（Standard だけ。URL のホストとパスの完全一致）
    if (rt.part.serveIssuer) {
      const res = await rt.part.serveIssuer(url, { isRead, requestId });
      if (res) return res;
    }

    // ポータルの経路（issuer とポータルが同じホストのときは、issuer の文書のパスを先に見た）
    const portal = early ?? matchPortal(url, config);
    if (!portal || portal.kind === "not_found") {
      return htmlResponse(errorPage("not_found", { requestId, mark }), 404);
    }
    return portalRoute(req, env, rt, portal, requestId, isRead);
  }

  async function portalRoute(
    req: Request,
    env: Env,
    rt: Runtime,
    portal: Exclude<PortalRoute, { kind: "not_found" }>,
    requestId: string | undefined,
    isRead: boolean,
  ): Promise<Response> {
    const { config } = rt;
    const loginDisabled = isLoginDisabled(env.LOGIN_DISABLED);
    if (portal.kind === "entry") {
      // 入口は Standard だけ（Admin は処理の最初で 404）。静的なファイルは許可リストの名前だけ
      if (!spec.serveEntry || (portal.asset !== undefined && !isAssetName(portal.asset)))
        return htmlResponse(errorPage("not_found", { requestId, mark }), 404);
      if (!isRead) return methodNotAllowed("GET, HEAD", requestId, mark);
      return spec.serveEntry(req, {
        config,
        accessTeamDomain: rt.accessTeamDomain,
        getAccessKey: o.getAccessKey,
        now,
        requestId,
        asset: portal.asset,
      });
    }
    const { team, teamBase, teamOrigin, page } = portal;
    const errOpts = { requestId, teamBase, supportUrl: config.portal.supportUrl, mark };

    if (page === "login" && !isRead) {
      if (req.method !== "POST") return methodNotAllowed("GET, HEAD, POST", requestId, mark);
      const out = await handleLogin(req, {
        tier,
        config,
        team,
        teamOrigin,
        accessTeamDomain: rt.accessTeamDomain,
        loginDisabled,
        csrfKey: rt.csrfKey,
        signer: rt.part.signer,
        rateLimiter: env.LOGIN_RATE_LIMITER,
        stsRegion: rt.stsRegion,
        fetch: doFetch,
        now,
        log: (line) => console.log(line),
        getAccessKey: o.getAccessKey,
        accessMaxAgeSeconds: rt.part.accessMaxAgeSeconds,
      });
      if (out.ok) return new Response(null, { status: 302, headers: { Location: out.location } });
      return htmlResponse(errorPage(out.code, errOpts), out.status);
    }

    if (page === "asset" && !isAssetName(portal.asset ?? ""))
      return htmlResponse(errorPage("not_found", errOpts), 404);
    // デプロイ後の確認は持つ階層だけ。持たない階層は JWT の検証の前に 404
    if (page === "key-check" && !rt.part.keyCheck)
      return htmlResponse(errorPage("not_found", errOpts), 404);
    if (!isRead) return methodNotAllowed("GET, HEAD", requestId, mark);

    // チームのパスの画面（GET /login・/expired・S1・S2・S3）と静的なファイルは、Access JWT を確かめてから描く（G-6 の原則。
    // JWT がない・AUD が未知・チームが違えば断る。S2 の CSRF トークンにも aud と sub が要る）
    const access = await verifyConsoleAccess(
      req.headers.get("Cf-Access-Jwt-Assertion"),
      team,
      { teamDomain: rt.accessTeamDomain, teams: config.teams, entryAud: config.portal.entryAud },
      {
        ...(o.getAccessKey ? { getKey: o.getAccessKey } : {}),
        now: Math.floor(now() / 1000),
        ...(rt.part.accessMaxAgeSeconds !== undefined
          ? { maxAgeSeconds: rt.part.accessMaxAgeSeconds }
          : {}),
      },
    );
    if (!access.ok) return htmlResponse(errorPage(access.code, errOpts), access.status);

    if (page === "key-check" && rt.part.keyCheck) {
      // 回数の制限（利用者ごと。キーは検証済みの Access の sub）。binding がない・例外なら返さない
      const limiter = env.LOGIN_RATE_LIMITER;
      if (!limiter || typeof limiter.limit !== "function")
        return htmlResponse(errorPage("server_misconfigured", errOpts), 500);
      let allowed: boolean;
      try {
        allowed =
          (await limiter.limit({ key: `${spec.tier}-key-check:${access.sub}` })).success === true;
      } catch {
        return htmlResponse(errorPage("temporarily_unavailable", errOpts), 503);
      }
      if (!allowed) return htmlResponse(errorPage("rate_limited", errOpts), 429);
      return new Response(JSON.stringify(await rt.part.keyCheck({ team })), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (page === "asset") return assetResponse(portal.asset ?? "") as Response;
    if (page === "login") return htmlResponse(loginGetPage(teamBase, mark));
    if (page === "expired") return htmlResponse(expiredPage(teamBase, mark));

    const params = new URL(req.url).searchParams;
    if (page === "list") {
      const q = (params.get("q") ?? "").slice(0, QUERY_MAX);
      return htmlResponse(listPage({ config, tier, team, teamBase, q, mark }));
    }
    const account = config.accounts.find((a) => a.accountId === portal.accountId);
    const roles = (account?.roles ?? []).flatMap((r) => {
      const role = config.roles.find((x) => x.name === r.role);
      return role && r.teams.includes(team) ? [{ role, sessionSeconds: r.sessionSeconds }] : [];
    });
    if (!account || roles.length === 0) return htmlResponse(errorPage("not_listed", errOpts), 404);
    const roleParam = params.get("role") ?? undefined;
    const newCsrf = () =>
      createCsrfToken(rt.csrfKey, { aud: access.aud, sub: access.sub }, Math.floor(now() / 1000));

    if (page === "cli") {
      // ロールの指定があればこのチームのロールであること。無ければ 1 つならそれ、複数なら選ぶリンク
      const selected =
        roleParam !== undefined
          ? roles.find((r) => r.role.name === roleParam)
          : roles.length === 1
            ? roles[0]
            : undefined;
      if (roleParam !== undefined && !selected)
        return htmlResponse(errorPage("not_listed", errOpts), 404);
      return htmlResponse(
        cliPage({
          config,
          tier,
          team,
          teamBase,
          account,
          roles,
          selected,
          csrf: selected ? await newCsrf() : undefined,
          mark,
        }),
      );
    }

    const csrf = await newCsrf();
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
        mark,
      }),
    );
  }

  return {
    async fetch(req: Request, env: Env): Promise<Response> {
      let res: Response;
      try {
        res = await route(req, typeof env === "object" && env !== null ? env : ({} as Env));
      } catch {
        // 想定外の例外は発行しない側に倒す（詳細は出さない）
        console.error("console: unexpected error");
        res = misconfigured(req.headers.get("Cf-Ray") ?? undefined, mark);
      }
      // 静的なファイル（CSS・JS。秘密を含まない）だけはキャッシュを許す。それ以外は no-store
      const secured = withSecurityHeaders(res, isStaticResponse(res) ? "static" : "page");
      return req.method === "HEAD"
        ? new Response(null, { status: secured.status, headers: secured.headers })
        : secured;
    },
  };
}
