// コンソールログイン: Access JWT の検証と AUD → チームの判定（docs/specs/console-login-portal.md §9.3 の 1・2、§9.4）。
// MCP 用の src/access.ts の verifyAccessJwt は aud を 1 つしか受けず、jose の audience の判定は「配列に含まれれば通す」ため、
// [既知, 未知] の aud を通してしまう。ここでは jose で署名・iss・exp を検証し（audience は渡さない）、
// 検証済みの payload の aud を自前で「ちょうど 1 つ・既知のチームの AUD」と判定する。
// 判定に使う値が読めない・壊れている・想定外の形のときは、すべて発行しない側に倒す（fail-closed）。
// 副作用のない関数だけを置く（JWKS の取得は jose に任せ、テストでは getKey を差し替える）。node の API を使わない。
import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/** exp / nbf に許す時計ずれ（秒）。MCP 用の検証と同じ値。 */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Access JWT（Cf-Access-Jwt-Assertion）の長さの上限（文字数。JWT は base64url と "." だけなので文字数 = バイト数）。
 * 16 KiB にした理由: Cloudflare Access のアプリのトークンは数百バイト〜1 KiB 程度（RS256 の署名 342 文字 + 少数の claim。
 * グループは JWT に入らず get-identity で取る）で、OIDC の追加の claim を足しても桁で余裕がある。一方、上限が無いと、
 * Access を通った利用者でも大きなヘッダーで base64 の復号・JSON の解析・RSA の検証を Worker にさせられる。
 * Cloudflare のリクエストヘッダーの上限（全体で 128 KB 程度）より十分小さく、正規のトークンを断らない値として選んだ。
 * 超えたものは署名の検証と JSON の解析の前に 401（reason: too_large）で断る（cto の決裁 G2 の論点 5）。
 */
export const ACCESS_JWT_MAX_LENGTH = 16 * 1024;

export type ConsoleAccessConfig = {
  /** `https://<team>.cloudflareaccess.com`（末尾のスラッシュは無視。パス・クエリは持たない） */
  teamDomain: string;
  /** このデプロイの階層のチーム。aud がないチームは、この階層では発行に使わない（未知として扱う） */
  teams: readonly { name: string; aud?: string | undefined }[];
  /** 入口のアプリの AUD。既知だが、どのチームにも対応しない（この AUD では発行しない） */
  entryAud?: string | undefined;
};

export type ConsoleAccessOptions = {
  /** 署名鍵の解決。省略時はチームドメインの certs（/cdn-cgi/access/certs）を取得する */
  getKey?: JWTVerifyGetKey;
  /** 現在時刻（epoch 秒。テスト用） */
  now?: number;
  /**
   * iat からの経過時間の上限（秒。正の整数）。渡したときだけ iat を必須にし、未来の iat（時計ずれの許容を超えるもの）と
   * 上限を超えた古い iat を 401 で断る。Admin の Worker だけが渡す（X1 の決裁 (f)。Admin の Access のセッションの長さ）。
   */
  maxAgeSeconds?: number;
};

export type ConsoleAccessIdentity = {
  /** AUD から決めたチーム（パスのチームと一致している） */
  team: string;
  /** 検証済みの JWT のただ 1 つの aud（CSRF トークンを束縛する値） */
  aud: string;
  /** Access の利用者 ID（空でない） */
  sub: string;
  /** 小文字に正規化した email */
  email: string;
  claims: JWTPayload;
};

export type ConsoleAccessUnauthorizedReason =
  | "missing"
  | "invalid"
  | "expired"
  | "service_token"
  | "identity_missing"
  | "too_old"
  | "iat_future"
  | "too_large";

export type ConsoleAccessFailure =
  | { ok: false; status: 401; code: "unauthorized"; reason: ConsoleAccessUnauthorizedReason }
  | { ok: false; status: 403; code: "unknown_audience" | "team_mismatch" }
  | { ok: false; status: 500; code: "server_misconfigured" };

export type ConsoleAccessResult = ({ ok: true } & ConsoleAccessIdentity) | ConsoleAccessFailure;

const unauthorized = (reason: ConsoleAccessUnauthorizedReason): ConsoleAccessFailure => ({
  ok: false,
  status: 401,
  code: "unauthorized",
  reason,
});
const forbidden = (code: "unknown_audience" | "team_mismatch"): ConsoleAccessFailure => ({
  ok: false,
  status: 403,
  code,
});
const MISCONFIGURED: ConsoleAccessFailure = {
  ok: false,
  status: 500,
  code: "server_misconfigured",
};

/** 設定を検査し、正規化したチームドメインと AUD → チームの表を返す。壊れていれば undefined。 */
function readConfig(
  cfg: ConsoleAccessConfig,
): { issuer: string; audTeam: Map<string, string> } | undefined {
  if (typeof cfg?.teamDomain !== "string" || !Array.isArray(cfg.teams)) return undefined;
  const trimmed = cfg.teamDomain.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== trimmed) return undefined;

  const audTeam = new Map<string, string>();
  const names = new Set<string>();
  for (const t of cfg.teams) {
    if (typeof t?.name !== "string" || t.name === "" || names.has(t.name)) return undefined;
    names.add(t.name);
    if (t.aud === undefined) continue;
    if (typeof t.aud !== "string" || t.aud === "" || audTeam.has(t.aud)) return undefined;
    audTeam.set(t.aud, t.name);
  }
  if (cfg.entryAud !== undefined) {
    if (typeof cfg.entryAud !== "string" || cfg.entryAud === "" || audTeam.has(cfg.entryAud))
      return undefined;
  }
  return { issuer: url.origin, audTeam };
}

// チームドメインごとに JWKS（と jose 内部の鍵キャッシュ）を使い回す
const jwksCache = new Map<string, JWTVerifyGetKey>();
function remoteJwks(issuer: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

/**
 * `POST <team-base>/login` などの発行の経路で、Access JWT を検証し、AUD からチームを決める。
 *
 * 順序（§9.3）: 設定の検査（500）→ 大きさの上限（401）→ 署名・iss・exp・利用者の種別（401）→ aud（403 unknown_audience）
 * → パスのチームとの一致（403 team_mismatch）。署名を検証する前に aud を見ない。
 *
 * @param pathTeam パス（ホスト）から取り出したチーム名。経路の振り分けにだけ使い、AUD のチームと食い違えば拒否する
 */
export async function verifyConsoleAccess(
  token: string | null | undefined,
  pathTeam: string,
  cfg: ConsoleAccessConfig,
  opts: ConsoleAccessOptions = {},
): Promise<ConsoleAccessResult> {
  const conf = readConfig(cfg);
  if (!conf) return MISCONFIGURED;
  const maxAge = opts.maxAgeSeconds;
  if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge > 0)) return MISCONFIGURED;
  if (typeof token !== "string" || token === "") return unauthorized("missing");
  // 大きさの上限（署名の検証・base64 の復号・JSON の解析の前）
  if (token.length > ACCESS_JWT_MAX_LENGTH) return unauthorized("too_large");

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  let payload: JWTPayload;
  try {
    // alg を RS256 に固定（none / HS256 へのすり替えを防ぐ）。audience は渡さず、下で自前で判定する
    ({ payload } = await jwtVerify(token, opts.getKey ?? remoteJwks(conf.issuer), {
      issuer: conf.issuer,
      algorithms: ["RS256"],
      requiredClaims: maxAge === undefined ? ["exp"] : ["exp", "iat"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(nowSec * 1000),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) return unauthorized("expired");
    // 署名・iss の不一致、JWKS の取得の失敗などはすべて fail closed
    return unauthorized("invalid");
  }

  // iat からの経過時間（Admin だけ）。exp・nbf は jwtVerify で見た
  if (maxAge !== undefined) {
    const iat = payload.iat;
    if (typeof iat !== "number" || !Number.isFinite(iat)) return unauthorized("invalid");
    if (iat > nowSec + CLOCK_TOLERANCE_SECONDS) return unauthorized("iat_future");
    if (nowSec - iat > maxAge) return unauthorized("too_old");
  }

  // アプリのトークン（type: app）だけを受け付ける（org はグローバルセッションのトークン）
  if (payload.type !== "app") return unauthorized("invalid");
  // サービストークン: common_name（Client ID）があり、sub が空文字。どちらかの印があれば人ではないとみなす
  if (Object.hasOwn(payload, "common_name")) return unauthorized("service_token");
  if (typeof payload.sub !== "string" || payload.sub === "") return unauthorized("service_token");
  if (typeof payload.email !== "string" || payload.email === "")
    return unauthorized("identity_missing");

  // aud はちょうど 1 つの文字列（文字列か、要素 1 つの配列）。重複を畳まない
  const auds: unknown[] =
    typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
  const aud = auds.length === 1 ? auds[0] : undefined;
  if (typeof aud !== "string" || aud === "") return forbidden("unknown_audience");
  // 入口の AUD は audTeam に入っていない（readConfig で重なりを弾いている）ので、ここで未知になる
  const team = conf.audTeam.get(aud);
  if (team === undefined) return forbidden("unknown_audience");
  if (team !== pathTeam) return forbidden("team_mismatch");

  return {
    ok: true,
    team,
    aud,
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    claims: payload,
  };
}
