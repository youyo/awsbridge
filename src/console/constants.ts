// コンソールログイン: 固定の約束（定数・値の形・階層）。何も import しない（node の API も使わない）。
// Worker のエントリは、設定の解析器（config.ts）や生成器（generate.ts）をバンドルに引き込まないよう、このファイルと
// 契約の型（types.ts）だけを読む。設定の検証・生成に使う道具はここに置かない。
// 設計: docs/specs/console-login-portal.md §11.1（固定の約束）・console-login.md §3.4（SourceIdentity）。
// MCP 用 Worker（src/index.ts）からは import しない（test/unit/console-layout.test.ts と test/e2e/console-isolation.test.ts で確かめる）。

export const CONSOLE_SCHEMA_VERSION = 1;
/** セッションタグのキー（チーム）。cto の D9 で名前空間つきに決めた。 */
export const TEAM_TAG_KEY = "awsbridge_team";
/** OIDC の audience（全階層・全境界で 1 つ。MCP 用の awsbridge と重ならない）。 */
export const AUDIENCE = "awsbridge-console";
/** コンソールログイン用のロールの IAM パスの接頭辞（SCP・aws:PrincipalArn で「すべて」を止めるときに使う）。 */
export const ROLE_PATH_PREFIX = "/awsbridge-console/";
export const SESSION_SECONDS_MIN = 900;
export const SESSION_SECONDS_MAX = 43200;
/**
 * Admin の階層のロールの MaxSessionDuration（秒）。AWS が強制できる最短の 1 時間に固定する（G1 の決裁 A-8、G2 の決裁の論点 5）。
 * Admin の sessionSeconds（Worker が求める長さ）はこれ以下。これより短くするのは Worker の振る舞いで、AWS の強制ではない。
 */
export const ADMIN_MAX_SESSION_SECONDS = 3600;

export type Tier = "standard" | "admin";
export const TIERS: readonly Tier[] = ["standard", "admin"];
/** ロールの IAM パスに書く階層名（/awsbridge-console/std/・/admin/）。issuer のパス（/standard・/admin）とは別。 */
const TIER_SEGMENT: Record<Tier, string> = { standard: "std", admin: "admin" };
/** ロールの IAM パス（P-2: /awsbridge-console/<tier>/）。階層だけを止める SCP の条件に使える。 */
export const rolePath = (tier: Tier): string => `${ROLE_PATH_PREFIX}${TIER_SEGMENT[tier]}/`;
/** ロールの MaxSessionDuration。Admin は ADMIN_MAX_SESSION_SECONDS に固定、Standard は sessionSeconds（今まで通り）。 */
export const roleMaxSessionDuration = (role: { tier: Tier; sessionSeconds: number }): number =>
  role.tier === "admin" ? ADMIN_MAX_SESSION_SECONDS : role.sessionSeconds;

export type Routing = "path" | "host";

// ---- SourceIdentity の出どころ（console-login.md §3.4・U-14）----

/** 既定。利用者の email（小文字）。 */
export const DEFAULT_SOURCE_IDENTITY = "email";
/** 出どころ: `email`（既定）か、Access の身元の `custom.<名前>`。`sub` は受け付けない。 */
export type SourceIdentitySource = "email" | `custom.${string}`;
const SOURCE_IDENTITY_CUSTOM_RE = /^custom\.[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const isSourceIdentitySource = (v: unknown): v is SourceIdentitySource =>
  v === DEFAULT_SOURCE_IDENTITY || (typeof v === "string" && SOURCE_IDENTITY_CUSTOM_RE.test(v));

// ---- 値の形 ----

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/; // チーム・ロール・Organization（タグの値・URL のパス・Access アプリの名前に使う）
export const ACCOUNT_ID_RE = /^\d{12}$/;
export const AUD_RE = /^[A-Za-z0-9]{16,128}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string) => s.length >= 6 && s.length <= 64 && EMAIL_RE.test(s);
