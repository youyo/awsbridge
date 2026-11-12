// コンソールログインの発行: フェデレーション（getSigninToken とログイン URL）と、そこに渡す Issuer・Destination を作る関数。
// 流用元は scripts/poc/human/claims.ts と portal/lib.ts（import せずに写して直した）。Worker に入るので node:* を import しない。
// 設計: docs/specs/console-login-portal.md §6.1（流れ）・§6.3（Issuer と Destination）・§10.3。
//   Issuer は設定の origin とチームから作る（要求の値・Host ヘッダーを使わない）。
//   Destination は許可リストのリージョンだけ（利用者から URL を受け取らない）。
import { NAME_RE, type Routing, SESSION_SECONDS_MAX, SESSION_SECONDS_MIN } from "../constants";
import { IssueError } from "./errors";

export const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** 一時認証情報（getSigninToken に渡す 3 つ。ログに出さない）。 */
export type SigninCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

// ---- Issuer ----

/** チームの起点の URL（<team-base>）。パス方式は <origin>/t/<team>、ホスト方式は https://<team>.<host>。 */
function teamBase(portal: { origin: string; routing: Routing }, team: string): string {
  if (!NAME_RE.test(team)) throw new IssueError("server_misconfigured", "team name is invalid");
  let u: URL;
  try {
    u = new URL(portal.origin);
  } catch {
    throw new IssueError("server_misconfigured", "portal origin is not a URL");
  }
  if (u.protocol !== "https:" || u.origin !== portal.origin)
    throw new IssueError("server_misconfigured", "portal origin must be an https origin");
  return portal.routing === "host"
    ? `${u.protocol}//${team}.${u.host}`
    : `${portal.origin}/t/${team}`;
}

/** フェデレーションの Issuer（セッションが切れたときの戻り先。<team-base>/expired）。OIDC の issuer とは別物。 */
export function signinIssuer(portal: { origin: string; routing: Routing }, team: string): string {
  return `${teamBase(portal, team)}/expired`;
}

// ---- Destination ----

export type Regions = { allowed: string[]; default: string };
/** 設定に portal.regions がないときの許可リスト。 */
export const DEFAULT_REGIONS: Regions = { allowed: ["us-east-1"], default: "us-east-1" };

/** resolveRegion を通したリージョン（許可リストか既定）。consoleDestination はこの型だけを受ける。 */
export type AllowedRegion = string & { readonly __allowedRegion: true };

/** 要求のリージョンが許可リストにあればそれを、なければ（空・未指定・URL のような値を含めて）既定を返す。 */
export function resolveRegion(
  requested: string | null | undefined,
  regions?: Regions,
): AllowedRegion {
  const r = regions ?? DEFAULT_REGIONS;
  return (
    typeof requested === "string" && r.allowed.includes(requested) ? requested : r.default
  ) as AllowedRegion;
}

/** コンソールの入り口の URL。resolveRegion を通した値だけを受ける。形が崩れた値は実行時も例外（URL を組み立てない）。 */
export function consoleDestination(region: AllowedRegion): string {
  if (!REGION_RE.test(region)) throw new IssueError("server_misconfigured", "invalid region");
  return `https://${region}.console.aws.amazon.com/console/home?region=${region}`;
}

// ---- getSigninToken ----

/** getSigninToken のパラメーター（POST のフォーム本文）。SessionDuration は 900〜43200 秒。 */
export function getSigninTokenParams(
  creds: SigninCredentials,
  sessionSeconds: number,
): URLSearchParams {
  if (
    !Number.isInteger(sessionSeconds) ||
    sessionSeconds < SESSION_SECONDS_MIN ||
    sessionSeconds > SESSION_SECONDS_MAX
  )
    throw new IssueError("server_misconfigured", "SessionDuration is out of range");
  const params = new URLSearchParams({
    Action: "getSigninToken",
    SessionDuration: String(sessionSeconds),
  });
  params.set(
    "Session",
    JSON.stringify({
      sessionId: creds.accessKeyId,
      sessionKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    }),
  );
  return params;
}

/** getSigninToken の応答（{"SigninToken":"..."}）から token を取り出す。取り出せなければ undefined。 */
export function parseSigninTokenResponse(body: string): string | undefined {
  try {
    const v: unknown = JSON.parse(body);
    if (typeof v !== "object" || v === null) return undefined;
    const t = (v as { SigninToken?: unknown }).SigninToken;
    return typeof t === "string" && t !== "" ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * getSigninToken を呼ぶ（POST。認証情報を URL に出さない）。
 * 5xx・ネットワークエラーは temporarily_unavailable、それ以外の失敗は signin_failed（portal §9.4）。
 * 例外の詳細には、応答の本文・認証情報を入れない。
 */
export async function fetchSigninToken(opts: {
  credentials: SigninCredentials;
  sessionSeconds: number;
  /** 既定は FEDERATION_ENDPOINT（E2E で擬似のエンドポイントを指すときだけ変える）。 */
  endpoint?: string;
  fetch?: typeof fetch;
}): Promise<string> {
  const body = getSigninTokenParams(opts.credentials, opts.sessionSeconds);
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  let text: string;
  try {
    res = await doFetch(opts.endpoint ?? FEDERATION_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // リダイレクトは追わない（認証情報を含む本文を別の宛先に再送しない）。3xx は失敗（signin_failed）として扱う
      redirect: "manual",
    });
    text = await res.text();
  } catch {
    throw new IssueError("temporarily_unavailable", "getSigninToken request failed");
  }
  if (res.status >= 500)
    throw new IssueError("temporarily_unavailable", `getSigninToken status ${res.status}`);
  const token = res.ok ? parseSigninTokenResponse(text) : undefined;
  if (token === undefined)
    throw new IssueError("signin_failed", `getSigninToken status ${res.status}`);
  return token;
}

/** コンソールのログイン URL（15 分有効。機密として扱い、ログに書かない）。 */
export function loginUrl(p: {
  signinToken: string;
  issuer: string;
  destination: string;
  /** 既定は FEDERATION_ENDPOINT（E2E で擬似のエンドポイントを指すときだけ変える）。 */
  endpoint?: string;
}): string {
  const params = new URLSearchParams({
    Action: "login",
    Issuer: p.issuer,
    Destination: p.destination,
    SigninToken: p.signinToken,
  });
  return `${p.endpoint ?? FEDERATION_ENDPOINT}?${params}`;
}

// ---- STS の endpoint ----

/**
 * STS の地域の endpoint。リージョンは設定（グローバルの endpoint は使わない）。
 * CloudTrail の AssumeRoleWithWebIdentity はこの STS のリージョンに記録されるので、突き合わせの手順に書く。
 */
export function stsEndpoint(region: string): string {
  if (!REGION_RE.test(region)) throw new IssueError("server_misconfigured", "invalid STS region");
  return `https://sts.${region}.amazonaws.com/`;
}
