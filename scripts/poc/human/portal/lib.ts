// PoC（人間のログイン）のポータル Worker（awsbridge-human-poc-portal）と、その手順のスクリプトが共有する純粋関数。
// 確かめること（scripts/poc/human/portal/README.md）:
//   N9  パス付き issuer（<base>/std と <base>/admin）を IAM の別々の OIDC プロバイダーにできるか
//   N1  同じホストのパス違い（/t/infra と /t/dev）の Access アプリで、Worker に届く Access JWT の aud が分かれるか
//   N10 Access → Worker（Access JWT の検証 → AUD からチーム → 自前 JWT の署名）→ STS → getSigninToken → コンソール
// Worker に入るので node:* を import しない。
import { importJWK, type JWK, SignJWT } from "jose";
import { thumbprintOf } from "../../../../src/keys";
import { sessionTagClaims, sourceIdentityClaim } from "../claims";

/** Worker・スタック・Access アプリの名前の接頭辞。破壊的な操作はこの名前にだけ効かせる。 */
export const PORTAL_PREFIX = "awsbridge-human-poc-portal";
/** PoC のポータル用のロール名の接頭辞（既存の PoC の AwsbridgeHumanPoc* とも別）。 */
export const PORTAL_ROLE_PREFIX = "AwsbridgeHumanPocPortal";
/** セッションタグのキー（cto の決裁: 名前空間つきの awsbridge_team）。 */
export const TEAM_TAG_KEY = "awsbridge_team";
export const PORTAL_DEFAULTS = {
  audience: "awsbridge-human-poc-portal",
  stackName: "awsbridge-human-poc-portal",
  region: "ap-northeast-1",
  awsProfile: "awsbridge",
} as const;

/**
 * ポータルの入口（= issuer）のホスト名の接頭辞。PoC 用のホストだけを受け付けるガードに使う。
 * awsbridge-console-poc は利用者が承認した PoC のホスト名（<prefix>.<zone>）。Worker・スタック・Access アプリの名前のガードは PORTAL_PREFIX のまま。
 */
export const PORTAL_HOST_PREFIXES = [PORTAL_PREFIX, "awsbridge-console-poc"] as const;

/** ホスト名が PoC 用の接頭辞（<prefix>.…）で始まるか。 */
export function hasPortalHostPrefix(host: string): boolean {
  return PORTAL_HOST_PREFIXES.some((p) => host.startsWith(`${p}.`));
}

export const TIERS = ["std", "admin"] as const;
export type Tier = (typeof TIERS)[number];

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const TEAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** ポータル Worker の URL（https://awsbridge-human-poc-portal.<subdomain>.workers.dev）を正規化する。末尾スラッシュは落とす。 */
export function normalizePortalBase(input: string): string {
  const s = input.replace(/\/+$/, "");
  const m = /^https:\/\/([^/?#:]+)$/.exec(s);
  const host = m?.[1];
  if (!host || !HOST_RE.test(host) || !hasPortalHostPrefix(host))
    throw new Error(
      `ポータルの URL は https://<${PORTAL_HOST_PREFIXES.join(" か ")}>.<ゾーン> の形（パス・ポート不可）`,
    );
  return s;
}

/** 階層ごとの issuer（<base>/std、<base>/admin。末尾スラッシュなし）。 */
export function issuerFor(base: string, tier: Tier): string {
  return `${normalizePortalBase(base)}/${tier}`;
}

/** issuer（https://<host>/<path>）から、IAM の条件キーとプロバイダー ARN に使う <host>/<path> を取り出す。 */
export function providerIdOf(issuer: string): string {
  const m = /^https:\/\/([a-z0-9.-]+)\/([a-z0-9-]+)$/.exec(issuer);
  if (!m)
    throw new Error(
      `パス付きの issuer（https://<host>/<path>、末尾スラッシュなし）ではない: '${issuer}'`,
    );
  return `${m[1]}/${m[2]}`;
}

/** PoC のポータルの OIDC プロバイダー（末尾が providerId と一致し、ホストが PoC のポータル）の ARN だけを受け付ける。 */
export function assertPortalProviderArn(arn: string, providerId: string): string {
  const m = /^arn:aws[a-z-]*:iam::\d{12}:oidc-provider\/(.+)$/.exec(arn);
  if (!m || m[1] !== providerId || !hasPortalHostPrefix(providerId))
    throw new Error(
      `PoC のポータルの OIDC プロバイダー（${PORTAL_HOST_PREFIXES.map((p) => `${p}.*`).join("・")}）ではない: '${arn}'`,
    );
  return arn;
}

/** PoC のポータルのロール（パスなし、名前が AwsbridgeHumanPocPortal で始まる）の ARN だけを受け付け、ロール名を返す。 */
export function assertPortalRoleArn(arn: string): string {
  const name = /^arn:aws[a-z-]*:iam::\d{12}:role\/([\w+=,.@-]+)$/.exec(arn)?.[1];
  if (!name?.startsWith(PORTAL_ROLE_PREFIX))
    throw new Error(`PoC のポータルのロール（${PORTAL_ROLE_PREFIX}*）ではない: '${arn}'`);
  return name;
}

/** スタック・Worker・Access アプリの名前（awsbridge-human-poc-portal または awsbridge-human-poc-portal-*）だけを受け付ける。 */
export function assertPortalName(name: string): void {
  if (name !== PORTAL_PREFIX && !name.startsWith(`${PORTAL_PREFIX}-`))
    throw new Error(
      `PoC のポータル用でない名前は扱わない: '${name}'（${PORTAL_PREFIX} で始まる名前だけ）`,
    );
}

/** {aud: team} の JSON（Terraform の出力 team_auds を反転したもの）を読む。 */
export function parseAudMap(raw: string): Record<string, string> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("AUD の対応が JSON ではない");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("AUD の対応は {aud: team} のオブジェクト");
  const out: Record<string, string> = {};
  const teams = new Set<string>();
  for (const [aud, team] of Object.entries(v)) {
    if (!/^[A-Za-z0-9]+$/.test(aud)) throw new Error("AUD は空でない英数字");
    if (typeof team !== "string" || !TEAM_RE.test(team))
      throw new Error("チーム名は小文字英数字とハイフン（32 文字まで）");
    if (teams.has(team)) throw new Error(`チーム ${team} の AUD が 2 つある`);
    teams.add(team);
    out[aud] = team;
  }
  return out;
}

export type TeamResult =
  | { ok: true; team: string }
  | { ok: false; code: "unknown_audience" | "ambiguous_audience" };

/** 検証済みの Access JWT の aud（文字列か配列）から、既知の AUD にちょうど 1 つ一致するチームを決める。 */
export function teamFromAud(aud: unknown, map: Record<string, string>): TeamResult {
  const list = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  const teams = new Set<string>();
  for (const a of list)
    if (typeof a === "string" && Object.hasOwn(map, a)) teams.add(map[a] as string);
  if (teams.size === 1) return { ok: true, team: [...teams][0] as string };
  return { ok: false, code: teams.size === 0 ? "unknown_audience" : "ambiguous_audience" };
}

/** /t/<team> と /t/<team>/... からチーム名を取り出す（経路の振り分けと食い違いの検出にだけ使う）。 */
export function teamFromPath(pathname: string): string | undefined {
  const team = /^\/t\/([^/]+)(\/.*)?$/.exec(pathname)?.[1];
  return team !== undefined && TEAM_RE.test(team) ? team : undefined;
}

export interface PortalRole {
  label: string;
  arn: string;
}

/** ログインで選べるロールの一覧（JSON 配列）。未設定・空は []。 */
export function parseRoles(raw: string | undefined): PortalRole[] {
  if (raw === undefined || raw.trim() === "") return [];
  const v: unknown = JSON.parse(raw);
  if (!Array.isArray(v)) throw new Error("ROLES は配列");
  const out: PortalRole[] = [];
  for (const item of v as { label?: unknown; arn?: unknown }[]) {
    if (typeof item?.label !== "string" || !/^[a-z0-9-]{1,32}$/.test(item.label))
      throw new Error("ROLES の label は小文字英数字とハイフン");
    if (typeof item.arn !== "string") throw new Error("ROLES の arn がない");
    assertPortalRoleArn(item.arn);
    if (out.some((r) => r.label === item.label)) throw new Error(`label ${item.label} が重複`);
    out.push({ label: item.label, arn: item.arn });
  }
  return out;
}

export interface PortalTokenParams {
  /** そのまま iss に入れる（N9 で末尾スラッシュつきも試すため、正規化しない） */
  issuer: string;
  audience: string;
  subject: string;
  /** セッションタグ awsbridge_team の値（省略するとタグなし） */
  team?: string;
  /** SourceIdentity（省略すると付けない） */
  sourceIdentity?: string;
  /** epoch seconds */
  now: number;
  ttlSeconds?: number;
}

/** STS に渡す JWT の claim。タグは入れ子形式・単一値。 */
export function portalTokenClaims(p: PortalTokenParams): Record<string, unknown> {
  if (!/^https:\/\/[^/?#]+(\/[^?#]*)?$/.test(p.issuer)) throw new Error("iss は https の URL");
  return {
    ...(p.team !== undefined ? sessionTagClaims({ [TEAM_TAG_KEY]: p.team }, "nested") : {}),
    ...(p.sourceIdentity !== undefined ? sourceIdentityClaim(p.sourceIdentity) : {}),
    iss: p.issuer,
    aud: p.audience,
    sub: p.subject,
    iat: p.now,
    exp: p.now + (p.ttlSeconds ?? 300),
  };
}

export async function signPortalToken(
  p: Omit<PortalTokenParams, "now"> & { privateJwk: JWK; now?: number },
): Promise<string> {
  const key = await importJWK({ ...p.privateJwk, alg: "RS256" }, "RS256");
  const kid = await thumbprintOf(p.privateJwk);
  const claims = portalTokenClaims({ ...p, now: p.now ?? Math.floor(Date.now() / 1000) });
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).sign(key);
}

export interface LoginRequestHeaders {
  origin: string | null;
  secFetchSite: string | null;
  contentType: string | null;
  /** ポータルのオリジン（設定の値。Host ヘッダーは使わない） */
  expectedOrigin: string;
}

/** POST /t/<team>/login の Origin と Content-Type を検査する。問題がなければ undefined。 */
export function checkLoginRequest(
  h: LoginRequestHeaders,
):
  | { status: 403; code: "forbidden_origin" }
  | { status: 415; code: "unsupported_media_type" }
  | undefined {
  if (h.origin === null || h.origin !== h.expectedOrigin)
    return { status: 403, code: "forbidden_origin" };
  if (h.secFetchSite !== null && h.secFetchSite !== "same-origin")
    return { status: 403, code: "forbidden_origin" };
  const ct = (h.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (ct !== "application/x-www-form-urlencoded")
    return { status: 415, code: "unsupported_media_type" };
  return undefined;
}

/** email を u***@***.com の形にする（画面とログに貼れるように）。email でなければ ***。 */
export function maskEmail(email: string): string {
  const m = /^([^@\s])[^@\s]*@[^@\s]+\.([A-Za-z]{2,})$/.exec(email);
  return m ? `${m[1]}***@***.${m[2]}` : "***";
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
