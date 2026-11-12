// コンソールログイン: Worker が読む発行用の生成物（worker.<tier>.json）の検査（docs/specs/console-login-portal.md §9.10・§11.6）。
// 生成器（generate.ts）が誤りを止めるので、ここは「生成物が壊れていない・取り違えていない」ことの多重の防御。
// 壊れている・他の階層の行やチームが混ざっている・purpose が issue でないときは WorkerConfigError（種別だけ。値は持たない）。
// 設定の解析器（config.ts）・生成器は import しない（Worker のバンドルに引き込まないため）。node の API を使わない。
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
  type Tier,
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

/**
 * 発行用の生成物を検査して返す。`tier` はこのデプロイの階層（Standard の Worker は "standard"）。
 * 行の ARN は、この階層のロールのパスとロール名から作った値と完全一致すること（他の階層の行の混入を弾く）。
 * 行のチームはこの生成物のチームの表にあること（他の階層のチームの混入を弾く）。
 */
export function readWorkerConfig(raw: unknown, tier: Tier): WorkerConfig {
  check(isObj(raw), "not_object");
  check(raw.purpose === "issue", "purpose");
  check(raw.tier === tier, "tier");
  check(raw.schemaVersion === CONSOLE_SCHEMA_VERSION, "schema_version");
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
  check(portal.peerOrigin === undefined || isHttpsOrigin(portal.peerOrigin), "portal_peer_origin");
  check(portal.peerOrigin !== portal.origin, "portal_peer_origin");
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
  const teamNames = new Set(teams.map((t) => t.name as string));

  check(Array.isArray(raw.roles), "roles");
  for (const r of raw.roles) {
    check(isObj(r) && isStr(r.name) && NAME_RE.test(r.name), "role_name");
    check(isStr(r.roleName) && ROLE_NAME_RE.test(r.roleName), "role_iam_name");
    check(typeof r.displayName === "string", "role_display_name");
    check(isSessionSeconds(r.sessionSeconds), "role_session_seconds");
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
      // 他の階層の行（ロールのパスが違う）や、別のロールの ARN を弾く
      check(
        r.roleArn === `arn:aws:iam::${a.accountId}:role${rolePath(tier)}${role.roleName as string}`,
        "row_tier",
      );
      check(
        Array.isArray(r.teams) &&
          r.teams.length > 0 &&
          r.teams.every((t) => typeof t === "string" && teamNames.has(t)),
        "row_team",
      );
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
