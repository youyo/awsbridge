// コンソールログイン（ポータルの Worker の工場）: 経路・画面・発行の振り分け。
// 設計: docs/specs/console-login-portal.md §3・§9・§10・§11、P2（B）の設計メモ §5・§7.2。
// P2: Worker は 1 つで、Standard と Admin の両方のチームを受ける。階層はデプロイではなく、要求ごとに
// 「パスのチーム → 生成物のそのチームの tier」で決める（パスのチームは検証済みの Access の AUD と一致しなければ断るので、根拠は AUD）。
// エントリ（worker/worker.ts）が署名の部品・issuer の文書を渡してこの工場を呼ぶ。この工場は鍵の扱い・issuer の文書の中身・OIDC を知らない。
//
//   issuer のホスト   境界の issuer の文書。スペックが渡す serveIssuer が処理する
//   ポータルのホスト  ポータルの経路（portal/routes.ts。パス方式 R-P が既定、設定でホスト方式 R-H）
//   それ以外のホスト  404
//
// 既知の経路以外は env を読む前に 404（G-6 の「チームのパス以外を処理の最初に 404」を Worker 全体に広げた形。§5）:
//   既知の経路 = 入口（/ と /assets/<許可リストの名前>）・既知のチームのパス（許可リストの静的なファイルを含む）・境界の issuer の 2 つの文書。
//   それ以外は設定だけで判定し、env も Access JWT も見ない。
// 階層ごとの違い（Admin の階層のチームだけ）: Access JWT の iat からの経過時間の上限（ADMIN_ACCESS_MAX_AGE_SECONDS）、
//   停止スイッチ ADMIN_LOGIN_DISABLED（止める側に倒す。LOGIN_DISABLED は全体）、回数の制限のキー（<階層>:<sub>）。
// 生成物と secret は最初の要求で検査し、壊れていればどの経路も 500 server_misconfigured（ログは種別だけ）。
// 試験用の差し替え（PortalOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import type { JWTVerifyGetKey } from "jose";
import type { Tier } from "../constants";
import { withSecurityHeaders } from "../http/headers";
import { verifyConsoleAccess } from "../issue/access";
import { createCsrfToken, importCsrfKey } from "../issue/csrf";
import { createEgress } from "../issue/egress";
import { stsEndpoint } from "../issue/federation";
import type { TokenSigner } from "../issue/signer";
import type { WorkerConfig } from "../types";
import { assetResponse, isAssetName, isStaticResponse } from "./assets";
import { handleLogin, type LoginRateLimiter } from "./login";
import {
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

/** ポータルの変数・secret・binding。エントリの env はこれを広げる。 */
export type PortalEnv = {
  /** vars: Access のチームドメイン（https://<team>.cloudflareaccess.com）。 */
  ACCESS_TEAM_DOMAIN?: string;
  /** vars: 停止スイッチ（全体）。未設定・空・false・0 以外は発行を止める（503 login_disabled）。 */
  LOGIN_DISABLED?: string;
  /** vars: Admin の階層のチームだけの停止スイッチ。読み方は LOGIN_DISABLED と同じ（止める側に倒す）。 */
  ADMIN_LOGIN_DISABLED?: string;
  /** vars: STS の地域の endpoint のリージョン（既定 us-east-1。グローバルの endpoint は使わない）。 */
  STS_REGION?: string;
  /** secret: CSRF トークンの HMAC の鍵（32 バイト以上。署名鍵と別）。 */
  CONSOLE_CSRF_KEY?: string;
  /** binding: Workers の Rate Limiting（利用者ごとの回数の制限）。 */
  LOGIN_RATE_LIMITER?: LoginRateLimiter;
  /** binding: Worker の版の情報（version_metadata）。id を発行記録に残す（無くても発行は止めない）。 */
  CF_VERSION_METADATA?: { id?: unknown };
};

/** 発行記録に残す Worker の版 ID（形の合わない値は残さない）。 */
const VERSION_ID_RE = /^[0-9A-Za-z-]{1,64}$/;
function workerVersionId(env: PortalEnv): string | undefined {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === "string" && VERSION_ID_RE.test(id) ? id : undefined;
}

export type PortalOverrides = {
  /** Access の certs の代わり（試験用）。 */
  getAccessKey?: JWTVerifyGetKey;
  /**
   * 外への通信の下の fetch（試験用）。渡しても、Access の certs・STS・getSigninToken の 3 つの宛先の検査と
   * redirect: manual は外への通信を集めた関数（issue/egress.ts）が掛ける。渡さなければ、呼ぶ時点の globalThis.fetch。
   */
  fetch?: typeof fetch;
  /** epoch ミリ秒（試験用）。 */
  now?: () => number;
};

/** env の誤り（種別だけを持つ。値は入れない）。エントリの buildPart も、これを投げて 500 にする。 */
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
  /** 外への通信を集めた関数（Access の certs を取るのに使う）。 */
  fetch: typeof fetch;
  now: () => number;
  requestId: string | undefined;
  /** 入口の静的なファイル（/assets/<name>）の名前。無ければ入口の画面（/）。 */
  asset?: string | undefined;
};

/**
 * 入口（S0。GET・HEAD の /）を描く処理（表示用の生成物はこの処理の中だけで読む）。
 * 共通の工場は表示用の照合のコードと生成物を import しない（発行の経路が表示の照合を import しない。U2）。
 */
export type EntryHandler = (req: Request, ctx: EntryContext) => Promise<Response>;

/** env から作る部品。 */
export type PortalPart = {
  signer: TokenSigner;
  /** 境界の issuer の文書。 */
  serveIssuer?: IssuerHandler;
  /**
   * Admin の階層のチームの Access JWT の iat からの経過時間の上限（秒。X1 の決裁 (f) を Admin の階層のチームに）。
   * 画面と発行の両方で、パスのチームが Admin の階層のときだけ見る。Standard の階層のチームでは見ない。
   */
  adminAccessMaxAgeSeconds: number;
  /**
   * デプロイ後の確認（GET <team-base>/key-check）。Access JWT の検証と回数の制限（LOGIN_RATE_LIMITER、
   * キー <パスのチームの階層>-key-check:<sub>）の後ろで呼ぶ。team はパスのチーム（Access JWT の検証済み）。
   */
  keyCheck?: (ctx: { team: string }) => Promise<unknown>;
};

export type PortalWorkerSpec<Env extends PortalEnv> = {
  /**
   * 境界の issuer の 2 つの文書の経路か（設定だけで判定する。env は読まない）。既知の経路以外を env を読む前に 404 にするのに使う。
   */
  isIssuerDoc(url: URL, config: WorkerConfig): boolean;
  /** 入口（/）の画面。渡さなければ入口は 404。 */
  serveEntry?: EntryHandler;
  /** env の検査と部品の作成。誤りは EnvError（種別だけ）で投げる。 */
  buildPart(env: Env, config: WorkerConfig): Promise<PortalPart> | PortalPart;
};

export const DEFAULT_STS_REGION = "us-east-1";

type Runtime = {
  config: WorkerConfig;
  accessTeamDomain: string;
  stsRegion: string;
  csrfKey: CryptoKey;
  part: PortalPart;
  /** 外への通信を集めた関数（宛先は Access の certs・STS・getSigninToken の 3 つだけ。§4.2）。 */
  egress: typeof fetch;
};

/** パスのチームの階層（生成物の teams[].tier）。生成物の検査を通ったので、既知のチームには必ずある。 */
export function teamTier(config: WorkerConfig, team: string): Tier | undefined {
  return config.teams.find((t) => t.name === team)?.tier;
}

/**
 * 既知の経路か（設定だけで判定する。env も Access JWT も見ない）。入口（/ と許可リストの /assets/<name>）・
 * 既知のチームのパス（静的なファイルは許可リストの名前だけ）・境界の issuer の 2 つの文書。
 */
function knownRoute(
  url: URL,
  config: WorkerConfig,
  isIssuerDoc: (url: URL, config: WorkerConfig) => boolean,
): PortalRoute | "issuer" | undefined {
  if (isIssuerDoc(url, config)) return "issuer";
  const r = matchPortal(url, config);
  if (!r || r.kind === "not_found") return undefined;
  if (r.asset !== undefined && !isAssetName(r.asset)) return undefined;
  return r;
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
  const now = o.now ?? (() => Date.now());
  let configResult: { ok: true; config: WorkerConfig } | { ok: false; kind: string } | undefined;
  const runtimes = new WeakMap<object, Promise<Runtime | EnvError>>();

  const loadConfig = () => {
    if (!configResult) {
      try {
        configResult = { ok: true, config: readWorkerConfig(rawConfig) };
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
    const part = await spec.buildPart(env, config);
    let csrfKey: CryptoKey;
    try {
      csrfKey = await importCsrfKey(env.CONSOLE_CSRF_KEY ?? "");
    } catch {
      throw new EnvError("csrf_key");
    }
    const egress = createEgress({ accessTeamDomain, stsRegion }, o.fetch);
    return { config, accessTeamDomain, stsRegion, csrfKey, part, egress };
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

  async function route(req: Request, getEnv: () => Env): Promise<Response> {
    const requestId = req.headers.get("Cf-Ray") ?? undefined;

    const c = loadConfig();
    if (!c.ok) {
      console.error(`config: invalid console config: ${c.kind}`);
      return misconfigured(requestId);
    }
    const url = new URL(req.url);

    // 処理の最初: 既知の経路以外は 404。env・Access JWT は見ない（設定だけで判定する）
    const known = knownRoute(url, c.config, spec.isIssuerDoc);
    if (known === undefined) return htmlResponse(errorPage("not_found", { requestId }), 404);

    const env = getEnv();
    const rt = await loadRuntime(c.config, env);
    if (rt instanceof EnvError) {
      console.error(`config: invalid console env: ${rt.kind}`);
      return misconfigured(requestId);
    }
    const isRead = req.method === "GET" || req.method === "HEAD";

    if (known === "issuer") {
      const res = rt.part.serveIssuer
        ? await rt.part.serveIssuer(url, { isRead, requestId })
        : undefined;
      return res ?? htmlResponse(errorPage("not_found", { requestId }), 404);
    }
    // ここに来るのは入口かチームのパス（knownRoute が not_found を返さない）
    return portalRoute(
      req,
      env,
      rt,
      known as Exclude<PortalRoute, { kind: "not_found" }>,
      requestId,
      isRead,
    );
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
    if (portal.kind === "entry") {
      // 入口。静的なファイルは許可リストの名前だけ（処理の最初で確かめ済み）
      if (!spec.serveEntry || (portal.asset !== undefined && !isAssetName(portal.asset)))
        return htmlResponse(errorPage("not_found", { requestId }), 404);
      if (!isRead) return methodNotAllowed("GET, HEAD", requestId);
      return spec.serveEntry(req, {
        config,
        accessTeamDomain: rt.accessTeamDomain,
        getAccessKey: o.getAccessKey,
        fetch: rt.egress,
        now,
        requestId,
        asset: portal.asset,
      });
    }
    const { team, teamBase, teamOrigin, page } = portal;
    // 階層は要求ごとに、パスのチームの階層で決める（パスのチームは Access の AUD と一致しなければ断る）
    const tier = teamTier(config, team);
    if (tier === undefined) return misconfigured(requestId);
    const mark = tierMark(tier);
    const errOpts = { requestId, teamBase, supportUrl: config.portal.supportUrl, mark };
    // 停止スイッチ: LOGIN_DISABLED は全体、ADMIN_LOGIN_DISABLED は Admin の階層のチームだけ（どちらも止める側に倒す）
    const loginDisabled =
      isLoginDisabled(env.LOGIN_DISABLED) ||
      (tier === "admin" && isLoginDisabled(env.ADMIN_LOGIN_DISABLED));
    // Access JWT の経過時間の上限は Admin の階層のチームだけ
    const accessMaxAgeSeconds = tier === "admin" ? rt.part.adminAccessMaxAgeSeconds : undefined;

    if (page === "login" && !isRead) {
      if (req.method !== "POST") return methodNotAllowed("GET, HEAD, POST", requestId, mark);
      const out = await handleLogin(req, {
        config,
        team,
        teamOrigin,
        accessTeamDomain: rt.accessTeamDomain,
        loginDisabled,
        csrfKey: rt.csrfKey,
        signer: rt.part.signer,
        rateLimiter: env.LOGIN_RATE_LIMITER,
        stsRegion: rt.stsRegion,
        fetch: rt.egress,
        now,
        log: (line) => console.log(line),
        getAccessKey: o.getAccessKey,
        accessMaxAgeSeconds,
        workerVersionId: workerVersionId(env),
      });
      if (out.ok) return new Response(null, { status: 302, headers: { Location: out.location } });
      return htmlResponse(errorPage(out.code, errOpts), out.status);
    }

    if (page === "asset" && !isAssetName(portal.asset ?? ""))
      return htmlResponse(errorPage("not_found", errOpts), 404);
    // デプロイ後の確認は部品が持つときだけ。持たなければ JWT の検証の前に 404
    if (page === "key-check" && !rt.part.keyCheck)
      return htmlResponse(errorPage("not_found", errOpts), 404);
    if (!isRead) return methodNotAllowed("GET, HEAD", requestId, mark);

    // チームのパスの画面（GET /login・/expired・S1・S2）と静的なファイルは、Access JWT を確かめてから描く（G-6 の原則。
    // JWT がない・AUD が未知・チームが違えば断る。S2 の CSRF トークンにも aud と sub が要る）
    const access = await verifyConsoleAccess(
      req.headers.get("Cf-Access-Jwt-Assertion"),
      team,
      { teamDomain: rt.accessTeamDomain, teams: config.teams, entryAud: config.portal.entryAud },
      {
        ...(o.getAccessKey ? { getKey: o.getAccessKey } : {}),
        fetch: rt.egress,
        now: Math.floor(now() / 1000),
        ...(accessMaxAgeSeconds !== undefined ? { maxAgeSeconds: accessMaxAgeSeconds } : {}),
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
          (await limiter.limit({ key: `${tier}-key-check:${access.sub}` })).success === true;
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
      return htmlResponse(listPage({ config, team, teamBase, q, mark }));
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
        // env は既知の経路と分かってから読む（読み出しを遅らせる。route の中で getEnv を呼ぶまで触らない）
        res = await route(req, () => (typeof env === "object" && env !== null ? env : ({} as Env)));
      } catch {
        // 想定外の例外は発行しない側に倒す（詳細は出さない）
        console.error("console: unexpected error");
        res = misconfigured(req.headers.get("Cf-Ray") ?? undefined);
      }
      // 静的なファイル（CSS・JS。秘密を含まない）だけはキャッシュを許す。それ以外は no-store
      const secured = withSecurityHeaders(res, isStaticResponse(res) ? "static" : "page");
      return req.method === "HEAD"
        ? new Response(null, { status: secured.status, headers: secured.headers })
        : secured;
    },
  };
}
