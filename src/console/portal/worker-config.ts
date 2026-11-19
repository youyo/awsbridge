// コンソールログイン: Worker が読む発行用の生成物（worker.json）の検査（docs/specs/console-login-portal.md §9.10・§11.6、
// P2（B）の設計メモ §2.3・§7.1）。生成器（generate.ts）が誤りを止めるので、ここは「生成物が壊れていない・取り違えていない」ことの多重の防御。
// 壊れている・行のチームとロールの階層が食い違う（row_team_tier）・行の ARN のパスがロールの階層と違う（row_tier）・
// Admin の階層のロールの行が managed 以外の境界にある（admin_boundary）・purpose が issue でない・schemaVersion が 2 でない
// ときは WorkerConfigError（種別だけ。値は持たない）。
// 設定の解析器（config.ts）・生成器は import しない（Worker のバンドルに引き込まないため）。node の API を使わない。

import type { Tier } from "../constants";
import {
  ACCOUNT_ID_RE,
  AUD_RE,
  CONSOLE_SCHEMA_VERSION,
  isSourceIdentitySource,
  NAME_RE,
  rolePath,
  SESSION_SECONDS_MAX,
  SESSION_SECONDS_MIN,
  TEAM_TAG_KEY,
  TIERS,
} from "../constants";
import type { WorkerConfig } from "../types";

/** 誤りの種別（ログに出す。値は入れない）。 */
export class WorkerConfigError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`invalid console config: ${kind}`);
    this.name = "WorkerConfigError";
    this.kind = kind;
  }
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const ROLE_NAME_RE = /^[\w+=,.@-]{1,64}$/;
const BOUNDARY_RE = /^(managed|partner:[a-z][a-z0-9-]{0,31})$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

function check(cond: unknown, kind: string): asserts cond {
  if (!cond) throw new WorkerConfigError(kind);
}

/** `https://<host>` の形そのもの（パス・末尾のスラッシュ・クエリなし）。 */
function isHttpsOrigin(v: unknown): v is string {
  if (!isStr(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.origin === v;
  } catch {
    return false;
  }
}

/** issuer の URL（https、クエリ・フラグメント・末尾の / なし）。 */
function isIssuerUrl(v: unknown): v is string {
  if (!isStr(v)) return false;
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      u.search === "" &&
      u.hash === "" &&
      !v.endsWith("/") &&
      u.username === "" &&
      u.password === "" &&
      `${u.origin}${u.pathname === "/" ? "" : u.pathname}` === v
    );
  } catch {
    return false;
  }
}

const isSessionSeconds = (v: unknown): v is number =>
  Number.isInteger(v) &&
  (v as number) >= SESSION_SECONDS_MIN &&
  (v as number) <= SESSION_SECONDS_MAX;

function uniq<T>(values: T[], kind: string): void {
  check(new Set(values).size === values.length, kind);
}

const isTier = (v: unknown): boolean => (TIERS as readonly unknown[]).includes(v);

/**
 * 発行用の生成物を検査して返す。チームとロールは tier（standard / admin）を持つ。
 * 行の ARN は、その行のロールの階層のパスとロール名から作った値と完全一致すること（row_tier）。
 * 行のチームはこの生成物のチームの表にあり（row_team）、どれもその行のロールと同じ階層であること（row_team_tier）。
 * Admin の階層のロールの行は managed の境界にだけ置ける（admin_boundary。設定の検査と同じ規則）。
 */
export function readWorkerConfig(raw: unknown): WorkerConfig {
  check(isObj(raw), "not_object");
  check(raw.purpose === "issue", "purpose");
  // P2 より前の階層ごとの生成物（schemaVersion 1。tier を持つ）は受けない
  check(raw.schemaVersion === CONSOLE_SCHEMA_VERSION, "schema_version");
  check(!Object.hasOwn(raw, "tier"), "tier");
  check(isStr(raw.generatedAt), "generated_at");
  check(
    raw.sourceRevision === undefined || typeof raw.sourceRevision === "string",
    "source_revision",
  );
  check(raw.tagKey === TEAM_TAG_KEY, "tag_key");
  check(isObj(raw.identity) && isSourceIdentitySource(raw.identity.sourceIdentity), "identity");

  const portal = raw.portal;
  check(isObj(portal), "portal");
  check(isHttpsOrigin(portal.origin), "portal_origin");
  check(!Object.hasOwn(portal, "peerOrigin"), "portal_peer_origin");
  check(portal.routing === "path" || portal.routing === "host", "portal_routing");
  if (portal.regions !== undefined) {
    const r = portal.regions;
    check(
      isObj(r) &&
        Array.isArray(r.allowed) &&
        r.allowed.length > 0 &&
        r.allowed.every((x) => typeof x === "string" && REGION_RE.test(x)) &&
        typeof r.default === "string" &&
        r.allowed.includes(r.default),
      "portal_regions",
    );
  }
  if (portal.supportUrl !== undefined) {
    let ok = false;
    try {
      ok = isStr(portal.supportUrl) && new URL(portal.supportUrl).protocol === "https:";
    } catch {}
    check(ok, "portal_support_url");
  }
  check(
    portal.entryAud === undefined || (isStr(portal.entryAud) && AUD_RE.test(portal.entryAud)),
    "portal_entry_aud",
  );

  check(Array.isArray(raw.teams) && raw.teams.length > 0, "teams");
  for (const t of raw.teams) {
    check(isObj(t) && isStr(t.name) && NAME_RE.test(t.name), "team_name");
    check(typeof t.displayName === "string", "team_display_name");
    check(isTier(t.tier), "team_tier");
    check(t.aud === undefined || (isStr(t.aud) && AUD_RE.test(t.aud)), "team_aud");
    check(t.aud === undefined || t.aud !== portal.entryAud, "team_aud_entry");
  }
  const teams = raw.teams as Obj[];
  uniq(
    teams.map((t) => t.name),
    "team_duplicate",
  );
  uniq(
    teams.flatMap((t) => (t.aud === undefined ? [] : [t.aud])),
    "team_aud_duplicate",
  );
  const teamTiers = new Map(teams.map((t) => [t.name as string, t.tier as string]));

  check(Array.isArray(raw.roles), "roles");
  for (const r of raw.roles) {
    check(isObj(r) && isStr(r.name) && NAME_RE.test(r.name), "role_name");
    check(isStr(r.roleName) && ROLE_NAME_RE.test(r.roleName), "role_iam_name");
    check(typeof r.displayName === "string", "role_display_name");
    check(isSessionSeconds(r.sessionSeconds), "role_session_seconds");
    check(isTier(r.tier), "role_tier");
  }
  const roles = raw.roles as Obj[];
  uniq(
    roles.map((r) => r.name),
    "role_duplicate",
  );
  const roleByName = new Map(roles.map((r) => [r.name as string, r]));

  check(Array.isArray(raw.boundaries) && raw.boundaries.length > 0, "boundaries");
  for (const b of raw.boundaries) {
    check(isObj(b) && isStr(b.name) && BOUNDARY_RE.test(b.name), "boundary_name");
    check(isIssuerUrl(b.issuer), "boundary_issuer");
  }
  const boundaries = raw.boundaries as Obj[];
  uniq(
    boundaries.map((b) => b.name),
    "boundary_duplicate",
  );
  uniq(
    boundaries.map((b) => b.issuer),
    "boundary_issuer_duplicate",
  );
  const boundaryNames = new Set(boundaries.map((b) => b.name as string));

  check(Array.isArray(raw.organizations), "organizations");
  for (const o of raw.organizations) {
    check(isObj(o) && isStr(o.name) && typeof o.displayName === "string", "organization");
  }

  check(Array.isArray(raw.accounts), "accounts");
  for (const a of raw.accounts) {
    check(
      isObj(a) && typeof a.accountId === "string" && ACCOUNT_ID_RE.test(a.accountId),
      "account_id",
    );
    check(typeof a.name === "string", "account_name");
    check(a.email === undefined || typeof a.email === "string", "account_email");
    check(typeof a.orgLabel === "string" && typeof a.kind === "string", "account_labels");
    check(typeof a.boundary === "string" && boundaryNames.has(a.boundary), "account_boundary");
    check(Array.isArray(a.roles) && a.roles.length > 0, "account_roles");
    for (const r of a.roles as unknown[]) {
      check(isObj(r) && typeof r.role === "string", "row_role");
      const role = roleByName.get(r.role);
      check(role !== undefined, "row_role_unknown");
      // ロールの階層と違うパスの ARN や、別のロールの ARN を弾く
      const tier = role.tier as Tier;
      check(
        r.roleArn === `arn:aws:iam::${a.accountId}:role${rolePath(tier)}${role.roleName as string}`,
        "row_tier",
      );
      check(
        Array.isArray(r.teams) &&
          r.teams.length > 0 &&
          r.teams.every((t) => typeof t === "string" && teamTiers.has(t)),
        "row_team",
      );
      // 行のチームはすべて、その行のロールと同じ階層（Standard のチームが Admin のロールの行に混ざるのを弾く）
      check(
        (r.teams as string[]).every((t) => teamTiers.get(t) === tier),
        "row_team_tier",
      );
      // Admin の階層のロールの行は managed の境界だけ（admin_boundary。管理外の先方に Administrator を配らない）
      check(tier !== "admin" || a.boundary === "managed", "admin_boundary");
      uniq(r.teams as string[], "row_team_duplicate");
      check(r.sessionSeconds === role.sessionSeconds, "row_session_seconds");
    }
    uniq(
      (a.roles as Obj[]).map((r) => r.role),
      "row_role_duplicate",
    );
  }
  uniq(
    (raw.accounts as Obj[]).map((a) => a.accountId),
    "account_duplicate",
  );
  return raw as unknown as WorkerConfig;
}
