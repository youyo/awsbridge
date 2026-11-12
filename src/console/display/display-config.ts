// コンソールログイン（表示用）: 表示用の生成物（display.standard.json）の検査（docs/specs/console-login-portal.md §5.2・§9.10）。
// 入口の一覧（S0。U2）の表示だけに使う。発行の経路（portal/login.ts・issue/*）はこのモジュールを import しない。
// 壊れている・取り違えている（purpose が display でない、発行用の値が混ざっている）ときは DisplayConfigError（種別だけ）。
// 表示用の生成物の誤りは入口の画面だけを止め、チームのページと発行には影響させない（発行が表示用の値に依存しないように）。
// 設定の解析器（config.ts）・生成器は import しない。node の API を使わない。
import { ACCOUNT_ID_RE, CONSOLE_SCHEMA_VERSION, NAME_RE, TIERS, type Tier } from "../constants";
import type { DisplayConfig } from "../types";

export class DisplayConfigError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`invalid console display: ${kind}`);
    this.name = "DisplayConfigError";
    this.kind = kind;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);

function check(cond: unknown, kind: string): asserts cond {
  if (!cond) throw new DisplayConfigError(kind);
}

function isHttpsOrigin(v: unknown): v is string {
  if (typeof v !== "string" || v === "") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.origin === v;
  } catch {
    return false;
  }
}

/** 表示用の行が持ってはならない、発行に使える値のキー（取り違えの検出）。 */
const ISSUE_ONLY_KEYS = ["aud", "roleArn", "issuer", "entryAud", "tagKey", "boundaries"];

/** 表示用の生成物を検査して返す。 */
export function readDisplayConfig(raw: unknown): DisplayConfig {
  check(isObj(raw), "not_object");
  check(raw.purpose === "display", "purpose");
  check(raw.tier === "standard", "tier");
  check(raw.schemaVersion === CONSOLE_SCHEMA_VERSION, "schema_version");
  for (const k of ISSUE_ONLY_KEYS) check(!Object.hasOwn(raw, k), "issue_value");

  const portal = raw.portal;
  check(isObj(portal), "portal");
  check(isHttpsOrigin(portal.origin), "portal_origin");
  check(portal.adminOrigin === undefined || isHttpsOrigin(portal.adminOrigin), "admin_origin");
  check(portal.adminOrigin !== portal.origin, "admin_origin");
  check(portal.routing === "path" || portal.routing === "host", "portal_routing");
  check(!Object.hasOwn(portal, "entryAud"), "issue_value");

  check(Array.isArray(raw.teams) && raw.teams.length > 0, "teams");
  const teamNames = new Set<string>();
  for (const t of raw.teams) {
    check(isObj(t) && typeof t.name === "string" && NAME_RE.test(t.name), "team_name");
    check(typeof t.displayName === "string" && isTier(t.tier), "team");
    check(!Object.hasOwn(t, "aud"), "issue_value");
    check(!teamNames.has(t.name), "team_duplicate");
    teamNames.add(t.name);
  }

  check(Array.isArray(raw.roles), "roles");
  const roleNames = new Set<string>();
  for (const r of raw.roles) {
    check(isObj(r) && typeof r.name === "string" && NAME_RE.test(r.name), "role_name");
    check(typeof r.displayName === "string" && isTier(r.tier), "role");
    check(!Object.hasOwn(r, "roleName"), "issue_value");
    roleNames.add(r.name);
  }

  check(Array.isArray(raw.groups), "groups");
  for (const g of raw.groups) {
    check(isObj(g) && typeof g.objectId === "string" && g.objectId !== "", "group");
    check(g.objectId === g.objectId.toLowerCase(), "group_case");
    check(
      Array.isArray(g.teams) && g.teams.every((t) => typeof t === "string" && teamNames.has(t)),
      "group_team",
    );
  }

  check(Array.isArray(raw.organizations), "organizations");
  check(Array.isArray(raw.accounts), "accounts");
  for (const a of raw.accounts) {
    check(isObj(a) && isTier(a.tier), "account_tier");
    check(typeof a.accountId === "string" && ACCOUNT_ID_RE.test(a.accountId), "account_id");
    check(typeof a.name === "string", "account_name");
    check(typeof a.orgLabel === "string" && typeof a.kind === "string", "account_labels");
    check(a.email === undefined || typeof a.email === "string", "account_email");
    // 表示用の Administrator の行は email を持たない（司令塔の決定）
    check(a.tier === "standard" || a.email === undefined, "admin_email");
    check(Array.isArray(a.roles) && a.roles.length > 0, "account_roles");
    for (const r of a.roles as unknown[]) {
      check(isObj(r) && typeof r.role === "string" && roleNames.has(r.role), "row_role");
      check(!Object.hasOwn(r, "roleArn"), "issue_value");
      check(
        Array.isArray(r.teams) && r.teams.every((t) => typeof t === "string" && teamNames.has(t)),
        "row_team",
      );
    }
  }
  return raw as unknown as DisplayConfig;
}
