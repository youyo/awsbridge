// 人間の AWS ログイン: チーム・ロール・アカウントの種類を定義する設定ファイルのスキーマと検証。
// 設計: docs/specs/human-login-portal.md §11（設定ファイル）。上流はスキーマ・例・生成の道具だけを持ち、実際の値は下流に置く。
// MCP 用 Worker（src/index.ts）からは import しない（cto の D2。test/unit/human-layout.test.ts と test/e2e/human-bundle.test.ts で確かめる）。
// 副作用のない純粋関数だけを置く（node の API を使わない。生成の CLI は scripts/human/config.ts）。
// エラーは「キーのパス」と「種別」だけで表し、設定の値（AUD・email・アカウント ID など）を文面に出さない。
// パスに入る、利用者が書いたキー（未知のキー・assign などのマップのキー）は、名前の形でなければ <redacted> にする（safeKey）。

export const HUMAN_SCHEMA_VERSION = 1;
/** セッションタグのキー（チーム）。cto の D9 で名前空間つきに決めた。 */
export const TEAM_TAG_KEY = "awsbridge_team";
/** 人間用のロールの IAM パス。 */
export const ROLE_PATH = "/awsbridge-human/";
export const SESSION_SECONDS_MIN = 900;
export const SESSION_SECONDS_MAX = 43200;

export type Tier = "standard" | "admin";
export const TIERS: readonly Tier[] = ["standard", "admin"];
export type EmailMode = "full" | "masked" | "hidden";
export type Routing = "path" | "host";

export type TeamAccess = { groupObjectIds: string[] } | { policyIds: string[] } | { aud: string };

export type HumanTeam = { name: string; displayName: string; tier: Tier; access: TeamAccess };

export type HumanRole = {
  name: string;
  roleName: string;
  displayName: string;
  tier: Tier;
  sessionSeconds: number;
  managedPolicyArns: string[];
  inlinePolicyFiles: string[];
};

export type HumanKind = {
  name: string;
  displayName: string;
  /** ロール → 受け付けるチーム（書いた順）。 */
  assign: { role: string; teams: string[] }[];
};

export type HumanBoundary = { name: string; issuers: { standard: string; admin?: string } };

export type HumanAccount = { accountId: string; name: string; kind: string; email?: string };

type OrganizationBase = { name: string; displayName: string; boundary: string };
export type HumanOuOrganization = OrganizationBase & {
  placement: "ou";
  inventoryRoleArn: string;
  kindOus: { kind: string; ouIds: string[] }[];
};
export type HumanAccountsOrganization = OrganizationBase & {
  placement: "accounts";
  accounts: HumanAccount[];
};
export type HumanOrganization = HumanOuOrganization | HumanAccountsOrganization;

export type HumanPortal = {
  standardOrigin: string;
  adminOrigin?: string;
  routing: Routing;
  regions?: { allowed: string[]; default: string };
  supportUrl?: string;
  /** 入口のアプリの AUD（Terraform を使わない構成で手書きする。階層ごと）。 */
  entryAud: { standard?: string; admin?: string };
};

export type HumanConfig = {
  schemaVersion: 1;
  portal: HumanPortal;
  teams: HumanTeam[];
  roles: HumanRole[];
  kinds: HumanKind[];
  boundaries: HumanBoundary[];
  organizations: HumanOrganization[];
  inventory: { accountEmail: { managed: EmailMode; partner: EmailMode } };
};

export type HumanConfigIssueCode =
  | "json"
  | "type"
  | "required"
  | "unknown_key"
  | "empty"
  | "schema_version"
  | "pattern"
  | "enum"
  | "range"
  | "url"
  | "origin"
  | "workers_dev"
  | "origin_same"
  | "admin_origin_missing"
  | "region_default"
  | "access_shape"
  | "unknown_team"
  | "unknown_role"
  | "unknown_kind"
  | "unknown_boundary"
  | "unknown_organization"
  | "duplicate"
  | "tier_mismatch"
  | "boundary_tier_missing"
  | "placement"
  | "param_collision"
  | "aud_missing"
  | "aud_mismatch"
  | "entry_aud_missing"
  | "ou_nested"
  // 以下は警告
  | "unassigned_team"
  | "unassigned_role"
  | "unassigned_accounts"
  | "inventory_missing";

/** 誤り・警告の 1 件。path はキーのパス（例 teams[1].name）。値は持たない。 */
export type HumanConfigIssue = { path: string; code: HumanConfigIssueCode; count?: number };

export const formatIssue = (i: HumanConfigIssue): string =>
  `${i.path}: ${i.code}${i.count !== undefined ? ` (${i.count})` : ""}`;

/** 設定の誤り。メッセージはキーのパスと種別だけで、設定の値を含めない（ログに出してよい）。 */
export class HumanConfigError extends Error {
  readonly issues: HumanConfigIssue[];
  constructor(issues: HumanConfigIssue[]) {
    super(`invalid human config:\n${issues.map((i) => `  ${formatIssue(i)}`).join("\n")}`);
    this.name = "HumanConfigError";
    this.issues = issues;
  }
}

// ---- 値の形 ----

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/; // チーム・ロール・Organization（タグの値・URL のパス・Access アプリの名前に使う）
const KIND_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const BOUNDARY_RE = /^(managed|partner:[a-z][a-z0-9-]{0,31})$/;
const IAM_ROLE_NAME_RE = /^[\w+=,.@-]{1,64}$/;
const AWS_MANAGED_POLICY_RE = /^arn:aws(-[a-z]+)*:iam::aws:policy\/[\w+=,.@/-]{1,512}$/;
const ROLE_ARN_RE = /^arn:aws(-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const OU_RE = /^ou-[0-9a-z]{4,32}-[a-z0-9]{8,32}$/;
export const ACCOUNT_ID_RE = /^\d{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AUD_RE = /^[A-Za-z0-9]{16,128}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const ACCOUNT_NAME_MAX = 50;
const DISPLAY_NAME_MAX = 100;

export const isEmail = (s: string) => s.length >= 6 && s.length <= 64 && EMAIL_RE.test(s);

/** ロールの name から StackSets のパラメーター名を作る（read-only → ReadOnlyTeams）。 */
export function teamsParameterName(roleName: string): string {
  return `${roleName
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")}Teams`;
}

// ---- 検証の道具 ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export class IssueList {
  readonly items: HumanConfigIssue[] = [];
  add(path: string, code: HumanConfigIssueCode, count?: number): void {
    this.items.push(count === undefined ? { path, code } : { path, code, count });
  }
}

/** オブジェクトであることと、未知のキーがないことを確かめる。 */
export function readObj(
  v: unknown,
  path: string,
  keys: readonly string[],
  out: IssueList,
): Obj | undefined {
  if (!isObj(v)) {
    out.add(path, "type");
    return undefined;
  }
  for (const k of Object.keys(v)) if (!keys.includes(k)) out.add(join(path, k), "unknown_key");
  return v;
}

/** 利用者がキーを書くマップ（assign・kindOus など）を、書いた順の [キー, 値] にする。 */
export function readMap(v: unknown, path: string, out: IssueList): [string, unknown][] | undefined {
  if (!isObj(v)) {
    out.add(path, "type");
    return undefined;
  }
  return Object.keys(v).map((k) => [k, v[k]]);
}

/**
 * 利用者が書いたキー（未知のキー・assign や kindOus のキーなど）をパスに出してよい形にする。
 * 名前の形でないもの（長い・記号を含む・アカウント ID のような 12 桁の数字を含む）は <redacted> にする。
 * AUD を逆向きに書いた・email をキーにした、といった誤りで値がログに出ないようにするため。
 */
export const safeKey = (key: string) =>
  /^[A-Za-z0-9_$:-]{1,32}$/.test(key) && !/\d{12}/.test(key) ? key : "<redacted>";

export const join = (path: string, key: string) => {
  const k = safeKey(key);
  return path === "$" ? k : `${path}.${k}`;
};

type StrOpts = { required?: boolean; re?: RegExp; max?: number };

export function readStr(o: Obj, key: string, path: string, out: IssueList, opts: StrOpts = {}) {
  const p = join(path, key);
  if (!Object.hasOwn(o, key) || o[key] === undefined) {
    if (opts.required) out.add(p, "required");
    return undefined;
  }
  return checkStr(o[key], p, out, opts);
}

function checkStr(v: unknown, p: string, out: IssueList, opts: StrOpts = {}): string | undefined {
  if (typeof v !== "string" || v === "") {
    out.add(p, "type");
    return undefined;
  }
  if ((opts.re && !opts.re.test(v)) || (opts.max !== undefined && v.length > opts.max)) {
    out.add(p, "pattern");
    return undefined;
  }
  return v;
}

function readStrArray(
  v: unknown,
  p: string,
  out: IssueList,
  opts: StrOpts & { nonEmpty?: boolean } = {},
): string[] | undefined {
  if (v === undefined && opts.required) {
    out.add(p, "required");
    return undefined;
  }
  if (!Array.isArray(v)) {
    out.add(p, "type");
    return undefined;
  }
  if (opts.nonEmpty && v.length === 0) out.add(p, "empty");
  const seen = new Set<string>();
  const result: string[] = [];
  v.forEach((item, i) => {
    const s = checkStr(item, `${p}[${i}]`, out, opts);
    if (s === undefined) return;
    if (seen.has(s)) out.add(`${p}[${i}]`, "duplicate");
    seen.add(s);
    result.push(s);
  });
  return result;
}

function readEnum<T extends string>(
  o: Obj,
  key: string,
  path: string,
  values: readonly T[],
  out: IssueList,
): T | undefined {
  if (!Object.hasOwn(o, key) || o[key] === undefined) return undefined;
  const v = o[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    out.add(join(path, key), "enum");
    return undefined;
  }
  return v as T;
}

function readArray(o: Obj, key: string, path: string, out: IssueList): unknown[] {
  const p = join(path, key);
  const v = o[key];
  if (v === undefined) {
    out.add(p, "required");
    return [];
  }
  if (!Array.isArray(v)) {
    out.add(p, "type");
    return [];
  }
  if (v.length === 0) out.add(p, "empty");
  return v;
}

/** 名前の重複を見つける（2 つ目以降の位置に duplicate）。 */
class Names {
  private readonly seen = new Set<string>();
  check(name: string | undefined, path: string, out: IssueList): void {
    if (name === undefined) return;
    if (this.seen.has(name)) out.add(path, "duplicate");
    this.seen.add(name);
  }
}

function checkOrigin(v: string | undefined, p: string, out: IssueList): string | undefined {
  if (v === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    out.add(p, "origin");
    return undefined;
  }
  // 末尾のドット（FQDN の形）も同じホストとして扱う
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "workers.dev" || host.endsWith(".workers.dev")) {
    out.add(p, "workers_dev");
    return undefined;
  }
  if (u.protocol !== "https:" || u.origin !== v) {
    out.add(p, "origin");
    return undefined;
  }
  return v;
}

function checkHttpsUrl(v: string | undefined, p: string, out: IssueList, issuer: boolean) {
  if (v === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    out.add(p, "url");
    return undefined;
  }
  const ok =
    u.protocol === "https:" &&
    u.username === "" &&
    u.password === "" &&
    (!issuer ||
      (u.search === "" &&
        u.hash === "" &&
        !v.endsWith("/") &&
        v === u.origin + (u.pathname === "/" ? "" : u.pathname)));
  if (!ok) {
    out.add(p, "url");
    return undefined;
  }
  return v;
}

// ---- 各項目 ----

function parsePortal(raw: unknown, out: IssueList): HumanPortal | undefined {
  if (raw === undefined) {
    out.add("portal", "required");
    return undefined;
  }
  const keys = ["standardOrigin", "adminOrigin", "routing", "regions", "supportUrl", "entryAud"];
  const o = readObj(raw, "portal", keys, out);
  if (!o) return undefined;
  const standardOrigin = checkOrigin(
    readStr(o, "standardOrigin", "portal", out, { required: true }),
    "portal.standardOrigin",
    out,
  );
  const adminOrigin = checkOrigin(
    readStr(o, "adminOrigin", "portal", out),
    "portal.adminOrigin",
    out,
  );
  const routing = readEnum(o, "routing", "portal", ["path", "host"] as const, out) ?? "path";
  const supportUrl = checkHttpsUrl(
    readStr(o, "supportUrl", "portal", out),
    "portal.supportUrl",
    out,
    false,
  );
  let regions: HumanPortal["regions"];
  if (o.regions !== undefined) {
    const r = readObj(o.regions, "portal.regions", ["allowed", "default"], out);
    if (r) {
      const allowed = readStrArray(r.allowed, "portal.regions.allowed", out, {
        re: REGION_RE,
        nonEmpty: true,
        required: true,
      });
      const def = readStr(r, "default", "portal.regions", out, { required: true, re: REGION_RE });
      if (allowed && def !== undefined && !allowed.includes(def))
        out.add("portal.regions.default", "region_default");
      if (allowed && def !== undefined) regions = { allowed, default: def };
    }
  }
  const entryAud: HumanPortal["entryAud"] = {};
  if (o.entryAud !== undefined) {
    const e = readObj(o.entryAud, "portal.entryAud", TIERS, out);
    if (e) {
      for (const t of TIERS) {
        const a = readStr(e, t, "portal.entryAud", out, { re: AUD_RE });
        if (a !== undefined) entryAud[t] = a;
      }
    }
  }
  if (standardOrigin === undefined) return undefined;
  return {
    standardOrigin,
    ...(adminOrigin !== undefined ? { adminOrigin } : {}),
    routing,
    ...(regions !== undefined ? { regions } : {}),
    ...(supportUrl !== undefined ? { supportUrl } : {}),
    entryAud,
  };
}

function parseTeam(raw: unknown, p: string, out: IssueList): HumanTeam | undefined {
  const o = readObj(raw, p, ["name", "displayName", "tier", "access"], out);
  if (!o) return undefined;
  const name = readStr(o, "name", p, out, { required: true, re: NAME_RE });
  const displayName = readStr(o, "displayName", p, out, { max: DISPLAY_NAME_MAX });
  const tier = readEnum(o, "tier", p, TIERS, out) ?? "standard";
  let access: TeamAccess | undefined;
  const ap = join(p, "access");
  if (o.access === undefined) out.add(ap, "required");
  else {
    const a = readObj(o.access, ap, ["groupObjectIds", "policyIds", "aud"], out);
    if (a) {
      const present = ["groupObjectIds", "policyIds", "aud"].filter((k) => a[k] !== undefined);
      if (present.length !== 1) out.add(ap, "access_shape");
      else if (a.aud !== undefined) {
        const aud = readStr(a, "aud", ap, out, { re: AUD_RE });
        if (aud !== undefined) access = { aud };
      } else {
        const key = present[0] as "groupObjectIds" | "policyIds";
        const ids = readStrArray(a[key], join(ap, key), out, { re: UUID_RE, nonEmpty: true });
        if (ids) access = key === "groupObjectIds" ? { groupObjectIds: ids } : { policyIds: ids };
      }
    }
  }
  if (name === undefined || access === undefined) return undefined;
  return { name, displayName: displayName ?? name, tier, access };
}

function parseRole(raw: unknown, p: string, out: IssueList): HumanRole | undefined {
  const keys = ["name", "roleName", "displayName", "tier", "sessionSeconds", "permissions"];
  const o = readObj(raw, p, keys, out);
  if (!o) return undefined;
  const name = readStr(o, "name", p, out, { required: true, re: NAME_RE });
  const roleName = readStr(o, "roleName", p, out, { required: true, re: IAM_ROLE_NAME_RE });
  const displayName = readStr(o, "displayName", p, out, { max: DISPLAY_NAME_MAX });
  const tier = readEnum(o, "tier", p, TIERS, out) ?? "standard";
  let sessionSeconds: number | undefined;
  const sp = join(p, "sessionSeconds");
  if (o.sessionSeconds === undefined) out.add(sp, "required");
  else if (typeof o.sessionSeconds !== "number") out.add(sp, "type");
  else if (
    !Number.isInteger(o.sessionSeconds) ||
    o.sessionSeconds < SESSION_SECONDS_MIN ||
    o.sessionSeconds > SESSION_SECONDS_MAX
  )
    out.add(sp, "range");
  else sessionSeconds = o.sessionSeconds;
  let managedPolicyArns: string[] = [];
  let inlinePolicyFiles: string[] = [];
  const pp = join(p, "permissions");
  if (o.permissions === undefined) out.add(pp, "required");
  else {
    const perm = readObj(o.permissions, pp, ["managedPolicyArns", "inlinePolicyFiles"], out);
    if (perm?.managedPolicyArns !== undefined)
      managedPolicyArns =
        readStrArray(perm.managedPolicyArns, join(pp, "managedPolicyArns"), out, {
          re: AWS_MANAGED_POLICY_RE,
        }) ?? [];
    if (perm?.inlinePolicyFiles !== undefined)
      inlinePolicyFiles =
        readStrArray(perm.inlinePolicyFiles, join(pp, "inlinePolicyFiles"), out, {
          // 下流のリポジトリ内の相対パス（絶対パスと .. は受け付けない）
          re: /^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/,
        }) ?? [];
  }
  if (name === undefined || roleName === undefined || sessionSeconds === undefined)
    return undefined;
  return {
    name,
    roleName,
    displayName: displayName ?? name,
    tier,
    sessionSeconds,
    managedPolicyArns,
    inlinePolicyFiles,
  };
}

function parseKind(raw: unknown, p: string, out: IssueList): HumanKind | undefined {
  const o = readObj(raw, p, ["name", "displayName", "assign"], out);
  if (!o) return undefined;
  const name = readStr(o, "name", p, out, { required: true, re: KIND_RE });
  const displayName = readStr(o, "displayName", p, out, { max: DISPLAY_NAME_MAX });
  const assign: HumanKind["assign"] = [];
  const ap = join(p, "assign");
  if (o.assign === undefined) out.add(ap, "required");
  else {
    for (const [role, teams] of readMap(o.assign, ap, out) ?? []) {
      const list = readStrArray(teams, join(ap, role), out, { nonEmpty: true });
      if (list) assign.push({ role, teams: list });
    }
  }
  if (name === undefined) return undefined;
  return { name, displayName: displayName ?? name, assign };
}

function parseBoundary(raw: unknown, p: string, out: IssueList): HumanBoundary | undefined {
  const o = readObj(raw, p, ["name", "issuers"], out);
  if (!o) return undefined;
  const name = readStr(o, "name", p, out, { required: true, re: BOUNDARY_RE });
  const ip = join(p, "issuers");
  let issuers: HumanBoundary["issuers"] | undefined;
  if (o.issuers === undefined) out.add(ip, "required");
  else {
    const i = readObj(o.issuers, ip, TIERS, out);
    if (i) {
      const standard = checkHttpsUrl(
        readStr(i, "standard", ip, out, { required: true }),
        join(ip, "standard"),
        out,
        true,
      );
      const admin = checkHttpsUrl(readStr(i, "admin", ip, out), join(ip, "admin"), out, true);
      if (standard !== undefined) issuers = { standard, ...(admin !== undefined ? { admin } : {}) };
    }
  }
  if (name === undefined || issuers === undefined) return undefined;
  return { name, issuers };
}

function parseAccount(raw: unknown, p: string, out: IssueList): HumanAccount | undefined {
  const o = readObj(raw, p, ["accountId", "name", "kind", "email"], out);
  if (!o) return undefined;
  const accountId = readStr(o, "accountId", p, out, { required: true, re: ACCOUNT_ID_RE });
  const name = readStr(o, "name", p, out, { required: true, max: ACCOUNT_NAME_MAX });
  const kind = readStr(o, "kind", p, out, { required: true, re: KIND_RE });
  const email = readStr(o, "email", p, out);
  if (email !== undefined && !isEmail(email)) out.add(join(p, "email"), "pattern");
  if (accountId === undefined || name === undefined || kind === undefined) return undefined;
  return { accountId, name, kind, ...(email !== undefined && isEmail(email) ? { email } : {}) };
}

function parseOrganization(raw: unknown, p: string, out: IssueList): HumanOrganization | undefined {
  const base = ["name", "displayName", "boundary", "placement"];
  if (!isObj(raw)) {
    out.add(p, "type");
    return undefined;
  }
  const placement = readEnum(raw, "placement", p, ["ou", "accounts"] as const, out);
  if (raw.placement === undefined) out.add(join(p, "placement"), "required");
  const extra =
    placement === "ou"
      ? ["inventoryRoleArn", "kindOus"]
      : placement === "accounts"
        ? ["accounts"]
        : ["inventoryRoleArn", "kindOus", "accounts"];
  const o = readObj(raw, p, [...base, ...extra], out);
  if (!o) return undefined;
  const name = readStr(o, "name", p, out, { required: true, re: NAME_RE });
  const displayName = readStr(o, "displayName", p, out, { max: DISPLAY_NAME_MAX });
  const boundary = readStr(o, "boundary", p, out, { required: true, re: BOUNDARY_RE });
  if (name === undefined || boundary === undefined || placement === undefined) return undefined;
  const common = { name, displayName: displayName ?? name, boundary };
  if (placement === "ou") {
    const inventoryRoleArn = readStr(o, "inventoryRoleArn", p, out, {
      required: true,
      re: ROLE_ARN_RE,
    });
    const kp = join(p, "kindOus");
    const kindOus: HumanOuOrganization["kindOus"] = [];
    if (o.kindOus === undefined) out.add(kp, "required");
    else {
      const entries = readMap(o.kindOus, kp, out) ?? [];
      if (isObj(o.kindOus) && entries.length === 0) out.add(kp, "empty");
      for (const [kind, ous] of entries) {
        const ouIds = readStrArray(ous, join(kp, kind), out, { re: OU_RE, nonEmpty: true });
        if (ouIds) kindOus.push({ kind, ouIds });
      }
    }
    if (inventoryRoleArn === undefined) return undefined;
    return { ...common, placement, inventoryRoleArn, kindOus };
  }
  const accounts: HumanAccount[] = [];
  readArray(o, "accounts", p, out).forEach((a, i) => {
    const acc = parseAccount(a, `${join(p, "accounts")}[${i}]`, out);
    if (acc) accounts.push(acc);
  });
  return { ...common, placement, accounts };
}

function parseInventory(raw: unknown, out: IssueList): HumanConfig["inventory"] {
  // 既定はすべて表示（Q-P9 の決定: 社員だけが使う前提で、管理外の先方の email も出す）
  const accountEmail: HumanConfig["inventory"]["accountEmail"] = {
    managed: "full",
    partner: "full",
  };
  if (raw === undefined) return { accountEmail };
  const o = readObj(raw, "inventory", ["accountEmail"], out);
  if (o?.accountEmail !== undefined) {
    const e = readObj(o.accountEmail, "inventory.accountEmail", ["managed", "partner"], out);
    if (e) {
      const modes = ["full", "masked", "hidden"] as const;
      accountEmail.managed = readEnum(e, "managed", "inventory.accountEmail", modes, out) ?? "full";
      accountEmail.partner = readEnum(e, "partner", "inventory.accountEmail", modes, out) ?? "full";
    }
  }
  return { accountEmail };
}

// ---- 全体と、項目をまたぐ検査 ----

function collect<T>(
  o: Obj,
  key: string,
  out: IssueList,
  parse: (raw: unknown, p: string, out: IssueList) => T | undefined,
): { items: (T | undefined)[] } {
  return { items: readArray(o, key, "$", out).map((raw, i) => parse(raw, `${key}[${i}]`, out)) };
}

const TOP_KEYS = [
  "$schema",
  "schemaVersion",
  "portal",
  "teams",
  "roles",
  "kinds",
  "boundaries",
  "organizations",
  "inventory",
];

/**
 * 設定ファイルを検証し、既定値を補った形にする。誤りが 1 つでもあれば HumanConfigError（全件）。
 * 警告（どの種類にも割り当てられていないチーム・ロール）は戻り値で返す。
 */
export function parseHumanConfig(input: unknown): {
  config: HumanConfig;
  warnings: HumanConfigIssue[];
} {
  const out = new IssueList();
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new HumanConfigError([{ path: "$", code: "json" }]);
    }
  }
  const o = readObj(raw, "$", TOP_KEYS, out);
  if (!o) throw new HumanConfigError(out.items);
  if (o.schemaVersion === undefined) out.add("schemaVersion", "required");
  else if (o.schemaVersion !== HUMAN_SCHEMA_VERSION) out.add("schemaVersion", "schema_version");
  if (o.$schema !== undefined && typeof o.$schema !== "string") out.add("$schema", "type");

  const portal = parsePortal(o.portal, out);
  const teams = collect(o, "teams", out, parseTeam).items;
  const roles = collect(o, "roles", out, parseRole).items;
  const kinds = collect(o, "kinds", out, parseKind).items;
  const boundaries = collect(o, "boundaries", out, parseBoundary).items;
  const organizations = collect(o, "organizations", out, parseOrganization).items;
  const inventory = parseInventory(o.inventory, out);

  const warnings = new IssueList();
  crossCheck({ portal, teams, roles, kinds, boundaries, organizations }, out, warnings);

  if (out.items.length > 0 || !portal) throw new HumanConfigError(out.items);
  const config: HumanConfig = {
    schemaVersion: 1,
    portal,
    teams: teams as HumanTeam[],
    roles: roles as HumanRole[],
    kinds: kinds as HumanKind[],
    boundaries: boundaries as HumanBoundary[],
    organizations: organizations as HumanOrganization[],
    inventory,
  };
  return { config, warnings: warnings.items };
}

type ParsedParts = {
  portal: HumanPortal | undefined;
  teams: (HumanTeam | undefined)[];
  roles: (HumanRole | undefined)[];
  kinds: (HumanKind | undefined)[];
  boundaries: (HumanBoundary | undefined)[];
  organizations: (HumanOrganization | undefined)[];
};

function crossCheck(c: ParsedParts, out: IssueList, warnings: IssueList): void {
  // 名前の重複
  const dup = <T>(items: (T | undefined)[], key: string, get: (t: T) => string) => {
    const names = new Names();
    items.forEach((t, i) => {
      if (t) names.check(get(t), `${key}[${i}].name`, out);
    });
  };
  dup(c.teams, "teams", (t) => t.name);
  dup(c.roles, "roles", (r) => r.name);
  dup(c.kinds, "kinds", (k) => k.name);
  dup(c.boundaries, "boundaries", (b) => b.name);
  dup(c.organizations, "organizations", (o) => o.name);
  const roleNames = new Names();
  c.roles.forEach((r, i) => {
    if (r) roleNames.check(r.roleName, `roles[${i}].roleName`, out);
  });
  // StackSets のパラメーター名の衝突（名前そのものの重複は上で duplicate にする）
  const params = new Map<string, string>();
  c.roles.forEach((r, i) => {
    if (!r) return;
    const param = teamsParameterName(r.name);
    const prev = params.get(param);
    if (prev !== undefined && prev !== r.name) out.add(`roles[${i}].name`, "param_collision");
    if (prev === undefined) params.set(param, r.name);
  });

  // AUD の重複（手書きのチームの AUD と入口の AUD）
  const auds = new Names();
  c.teams.forEach((t, i) => {
    if (t && "aud" in t.access) auds.check(t.access.aud, `teams[${i}].access.aud`, out);
  });
  for (const t of TIERS) {
    const a = c.portal?.entryAud[t];
    if (a !== undefined) auds.check(a, `portal.entryAud.${t}`, out);
  }

  // issuer の URL の重複（境界 × 階層で鍵を分けるため。cto の D3）
  const issuers = new Names();
  c.boundaries.forEach((b, i) => {
    if (!b) return;
    for (const t of TIERS) {
      const u = b.issuers[t];
      if (u !== undefined) issuers.check(u, `boundaries[${i}].issuers.${t}`, out);
    }
  });

  // ポータルのオリジンと Admin の階層
  const usesAdmin =
    c.teams.some((t) => t?.tier === "admin") || c.roles.some((r) => r?.tier === "admin");
  if (c.portal) {
    if (usesAdmin && c.portal.adminOrigin === undefined)
      out.add("portal.adminOrigin", "admin_origin_missing");
    if (c.portal.adminOrigin !== undefined && c.portal.adminOrigin === c.portal.standardOrigin)
      out.add("portal.adminOrigin", "origin_same");
  }

  // kinds[].assign の参照と階層
  const teamByName = new Map(c.teams.filter((t) => t).map((t) => [t?.name, t as HumanTeam]));
  const roleByName = new Map(c.roles.filter((r) => r).map((r) => [r?.name, r as HumanRole]));
  const assignedTeams = new Set<string>();
  const assignedRoles = new Set<string>();
  c.kinds.forEach((k, ki) => {
    if (!k) return;
    for (const { role, teams } of k.assign) {
      const ap = join(`kinds[${ki}].assign`, role);
      const r = roleByName.get(role);
      if (!r) out.add(ap, "unknown_role");
      else assignedRoles.add(role);
      teams.forEach((team, ti) => {
        const t = teamByName.get(team);
        if (!t) out.add(`${ap}[${ti}]`, "unknown_team");
        else {
          assignedTeams.add(team);
          if (r && r.tier !== t.tier) out.add(`${ap}[${ti}]`, "tier_mismatch");
        }
      });
    }
  });
  c.teams.forEach((t, i) => {
    if (t && !assignedTeams.has(t.name)) warnings.add(`teams[${i}]`, "unassigned_team");
  });
  c.roles.forEach((r, i) => {
    if (r && !assignedRoles.has(r.name)) warnings.add(`roles[${i}]`, "unassigned_role");
  });

  // organizations の参照・境界・アカウント ID と OU の重複
  const kindByName = new Map(c.kinds.filter((k) => k).map((k) => [k?.name, k as HumanKind]));
  const boundaryByName = new Map(
    c.boundaries.filter((b) => b).map((b) => [b?.name, b as HumanBoundary]),
  );
  const accountIds = new Names();
  const ouIds = new Names();
  c.organizations.forEach((org, oi) => {
    if (!org) return;
    const p = `organizations[${oi}]`;
    const boundary = boundaryByName.get(org.boundary);
    if (!boundary) out.add(`${p}.boundary`, "unknown_boundary");
    if (org.placement === "ou" && org.boundary.startsWith("partner:"))
      out.add(`${p}.placement`, "placement");
    const usedKinds: string[] = [];
    if (org.placement === "ou") {
      for (const { kind, ouIds: ids } of org.kindOus) {
        const kp = join(`${p}.kindOus`, kind);
        if (!kindByName.has(kind)) out.add(kp, "unknown_kind");
        else usedKinds.push(kind);
        ids.forEach((id, i) => {
          ouIds.check(id, `${kp}[${i}]`, out);
        });
      }
    } else {
      org.accounts.forEach((a, ai) => {
        accountIds.check(a.accountId, `${p}.accounts[${ai}].accountId`, out);
        if (!kindByName.has(a.kind)) out.add(`${p}.accounts[${ai}].kind`, "unknown_kind");
        else usedKinds.push(a.kind);
      });
    }
    // 境界にない階層の issuer が要る割り当て（例: 管理外の先方の種類に Admin のロール）
    if (boundary) {
      const needs = new Set<Tier>();
      for (const kn of usedKinds)
        for (const { role } of kindByName.get(kn)?.assign ?? []) {
          const r = roleByName.get(role);
          if (r) needs.add(r.tier);
        }
      if ([...needs].some((t) => boundary.issuers[t] === undefined))
        out.add(p, "boundary_tier_missing");
    }
  });
}
