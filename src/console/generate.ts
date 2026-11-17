// コンソールログイン: 1 つの設定ファイルから、Worker 用・表示用・StackSets 用・Access の検査用の生成物を作る。
// 設計: docs/specs/console-login-portal.md §5.2（一覧の形）・§9.10（分離）・§11.4（生成するもの）・§11.5（検査の順）・§11.6（誤りの扱い）、
// P2（B）の設計メモ §2.4（Worker は 1 つ。発行用は worker.json 1 つで、チームとロールに tier を付ける）。
// 副作用のない純粋関数だけを置く（ファイルの読み書きは scripts/console/config.ts）。MCP 用 Worker からは import しない。
//
// 分離の約束（§9.10・§11.2）: 発行用（worker.json）には、チーム（AUD・tier）・ロール（tier）・境界の issuer・一覧の行だけを入れる。
// 種類の定義（kinds）・Entra のグループの Object ID・Access のポリシー ID・権限ポリシー・OU・退役したチーム名の台帳は入れない。
// 表示用の生成物（display.json）は、入口の一覧のための Administrator の行（表示用だけ。email なし）と Entra グループの
// Object ID → チームの対応表を持つ。AUD・Access のポリシー ID・issuer・roleArn は持たない（発行には使えない）。型は types.ts（契約）。
// 退役したチーム名の台帳（§7.1）は StackSets 用の生成物に今のチームと一緒に残し、次の生成で前回と比べる（台帳から名前を消せない）。

import {
  type ConsoleConfig,
  ConsoleConfigError,
  type ConsoleConfigIssue,
  type ConsoleRole,
  type EmailMode,
  IssueList,
  join,
  readMap,
  readObj,
  readStr,
  teamsParameterName,
} from "./config";
import {
  ACCOUNT_ID_RE,
  AUD_RE,
  AUDIENCE,
  isEmail,
  ROLE_PATH_PREFIX,
  type Routing,
  rolePath,
  TEAM_TAG_KEY,
  TIERS,
  type Tier,
} from "./constants";
import type {
  DisplayAccount,
  DisplayConfig,
  DisplayGroup,
  Meta,
  WorkerAccount,
  WorkerAccountRole,
  WorkerConfig,
} from "./types";

export type GenerateMode = "check" | "deploy";

export type GenerateOptions = {
  /** check: PR の検査（AUD がなくても誤りにしない）。deploy: デプロイ用（その階層のチームの AUD が要る）。 */
  mode: GenerateMode;
  generatedAt: string;
  sourceRevision?: string;
  /** Terraform の出力: { teams: { <チーム>: <AUD> }, entry?: <AUD> }。渡すと check でも AUD の対応まで検査する。 */
  auds?: unknown;
  /** placement: ou の Organization のアカウント: { <Organization>: [{ accountId, name, email?, ouPath, status? }] }。 */
  inventory?: unknown;
  /**
   * 前回の StackSets 用の生成物（stacksets.json）。台帳（teams・retiredTeams）を比べ、台帳から名前を消していないか・
   * 消したチームを台帳へ移したか・同じ名前の階層を変えていないかを確かめる。無ければ警告（ledger_previous_missing）。
   */
  previous?: unknown;
};

export type StackSetsRole = {
  name: string;
  roleName: string;
  tier: Tier;
  /** IAM のパス（P-2: /awsbridge-console/<tier>/）。 */
  rolePath: string;
  sessionSeconds: number;
  managedPolicyArns: string[];
  inlinePolicyFiles: string[];
  /** 種類の StackSet で、このロールの信頼ポリシーが受け付けるチームを渡すパラメーターの名前。 */
  teamsParameter: string;
};
/** 台帳の 1 件（チームの名前と階層）。 */
export type LedgerTeam = { name: string; tier: Tier };
export type StackSetsParams = Meta & {
  tagKey: string;
  /** OIDC プロバイダーの ClientIdList と信頼ポリシーの <issuer>:aud に入れる値。 */
  audience: string;
  /** ロールのパスの接頭辞（停止用の SCP の条件に使う）。ロールごとのパスは roles[].rolePath。 */
  rolePathPrefix: string;
  roles: StackSetsRole[];
  /** 基盤の StackSet（Organization ごとの OIDC プロバイダー。issuer は境界ごとに 1 つ）。 */
  providers: { organization: string; boundary: string; issuer: string }[];
  /** 今のチーム（名前と階層）。次の生成で台帳と比べる。 */
  teams: LedgerTeam[];
  /** 退役したチーム名の台帳（設定の retiredTeams）。次の生成で、ここにある名前が消えていないかを比べる。 */
  retiredTeams: LedgerTeam[];
  /** 種類の StackSet（種類 × Organization ごと）。値はチーム名のカンマ区切り。割り当てのないロールは空文字。 */
  assignments: {
    organization: string;
    kind: string;
    target: { ous: string[] } | { accounts: string[] };
    parameters: Record<string, string>;
  }[];
};

export type AccessTeam = {
  name: string;
  tier: Tier;
  groupObjectIds?: string[];
  policyIds?: string[];
  /** Terraform を使わず手で作ったアプリ（access.aud）。 */
  manualAud?: true;
  aud?: string;
};
export type AccessSummary = Meta & {
  routing: Routing;
  /** ポータルのオリジン（1 つ。チームのアプリは同じホストの /t/<チーム>）。 */
  origin: string;
  entryAud?: string;
  teams: AccessTeam[];
};

export type ConsoleArtifacts = {
  /** 発行用（worker.json）。 */
  worker: WorkerConfig;
  /** 表示用（display.json）。 */
  display: DisplayConfig;
  stacksets: StackSetsParams;
  access: AccessSummary;
  warnings: ConsoleConfigIssue[];
};

// ---- AUD ----

type ResolvedAuds = { teams: Map<string, string>; entry?: string };

function parseAudInput(
  raw: unknown,
  out: IssueList,
): { teams: Map<string, string>; entry?: string } {
  const result: { teams: Map<string, string>; entry?: string } = { teams: new Map() };
  const o = readObj(raw, "auds", ["teams", "entry"], out);
  if (!o) return result;
  if (o.teams !== undefined) {
    const teams = readMap(o.teams, "auds.teams", out) ?? [];
    for (const [name, v] of teams) {
      const aud = readStr({ [name]: v }, name, "auds.teams", out, { re: AUD_RE });
      if (aud !== undefined) result.teams.set(name, aud);
    }
  }
  const entry = readStr(o, "entry", "auds", out, { re: AUD_RE });
  if (entry !== undefined) result.entry = entry;
  return result;
}

function resolveAuds(
  config: ConsoleConfig,
  raw: unknown,
  requireAud: boolean,
  out: IssueList,
): ResolvedAuds {
  const input: { teams: Map<string, string>; entry?: string } =
    raw === undefined ? { teams: new Map<string, string>() } : parseAudInput(raw, out);
  const known = new Set(config.teams.map((t) => t.name));
  for (const name of input.teams.keys())
    if (!known.has(name)) out.add(join("auds.teams", name), "unknown_team");

  const resolved: ResolvedAuds = { teams: new Map() };
  const seen = new Set<string>();
  const use = (aud: string, path: string) => {
    if (seen.has(aud)) out.add(path, "duplicate");
    seen.add(aud);
  };
  config.teams.forEach((t, i) => {
    const manual = "aud" in t.access ? t.access.aud : undefined;
    const fromTf = input.teams.get(t.name);
    if (manual !== undefined && fromTf !== undefined && manual !== fromTf)
      out.add(`teams[${i}].access.aud`, "aud_mismatch");
    const aud = fromTf ?? manual;
    if (aud === undefined) {
      if (requireAud) out.add(`teams[${i}].access`, "aud_missing");
      return;
    }
    use(aud, fromTf !== undefined ? join("auds.teams", t.name) : `teams[${i}].access.aud`);
    resolved.teams.set(t.name, aud);
  });
  const manual = config.portal.entryAud;
  const fromTf = input.entry;
  if (manual !== undefined && fromTf !== undefined && manual !== fromTf)
    out.add("portal.entryAud", "aud_mismatch");
  const entry = fromTf ?? manual;
  if (entry === undefined) {
    // 入口のアプリは Standard の階層のチームが 2 つ以上のときだけ要る（1 つならそのチームのアプリで守る。§11.7。
    // ポータルの流れの決裁）。Admin の階層のチームの数は数えない
    const standardTeams = config.teams.filter((t) => t.tier === "standard").length;
    if (requireAud && standardTeams >= 2) out.add("portal.entryAud", "entry_aud_missing");
  } else {
    use(entry, fromTf !== undefined ? "auds.entry" : "portal.entryAud");
    resolved.entry = entry;
  }
  return resolved;
}

// ---- 一覧の行 ----

type Listed = {
  accountId: string;
  name: string;
  email?: string;
  organization: string;
  boundary: string;
  kind: string;
};

const OU_PATH_RE = /^(r-[0-9a-z]{4,32}|ou-[0-9a-z]{4,32}-[a-z0-9]{8,32})$/;

function listAccounts(
  config: ConsoleConfig,
  raw: unknown,
  mode: GenerateMode,
  out: IssueList,
  warnings: IssueList,
): Listed[] {
  const inventory = new Map<string, unknown>();
  if (raw !== undefined)
    for (const [org, rows] of readMap(raw, "inventory", out) ?? []) inventory.set(org, rows);
  for (const org of inventory.keys()) {
    const o = config.organizations.find((x) => x.name === org);
    if (!o) out.add(join("inventory", org), "unknown_organization");
    else if (o.placement !== "ou") out.add(join("inventory", org), "placement");
  }

  // 設定に書いたアカウント（placement: accounts）を先に入れ、インベントリとの重複を見つける
  const ids = new Set(
    config.organizations.flatMap((o) =>
      o.placement === "accounts" ? o.accounts.map((a) => a.accountId) : [],
    ),
  );
  const listed: Listed[] = [];
  for (const org of config.organizations) {
    const base = { organization: org.name, boundary: org.boundary };
    if (org.placement === "accounts") {
      for (const a of org.accounts) listed.push({ ...base, ...a });
      continue;
    }
    const ip = join("inventory", org.name);
    if (!inventory.has(org.name)) {
      if (mode === "deploy") warnings.add(ip, "inventory_missing");
      continue;
    }
    const rows = inventory.get(org.name);
    if (!Array.isArray(rows)) {
      out.add(ip, "type");
      continue;
    }
    let unassigned = 0;
    rows.forEach((row, i) => {
      const p = `${ip}[${i}]`;
      const o = readObj(row, p, ["accountId", "name", "email", "ouPath", "status"], out);
      if (!o) return;
      const accountId = readStr(o, "accountId", p, out, { required: true, re: ACCOUNT_ID_RE });
      const name = readStr(o, "name", p, out, { required: true, max: 50 });
      const email = readStr(o, "email", p, out);
      if (email !== undefined && !isEmail(email)) out.add(join(p, "email"), "pattern");
      const status = readStr(o, "status", p, out);
      let ouPath: string[] | undefined;
      if (o.ouPath === undefined) out.add(join(p, "ouPath"), "required");
      else if (!Array.isArray(o.ouPath) || !o.ouPath.every((x) => typeof x === "string"))
        out.add(join(p, "ouPath"), "type");
      else if (!o.ouPath.every((x) => OU_PATH_RE.test(x))) out.add(join(p, "ouPath"), "pattern");
      else ouPath = o.ouPath;
      if (accountId === undefined || name === undefined || ouPath === undefined) return;
      if (ids.has(accountId)) out.add(join(p, "accountId"), "duplicate");
      ids.add(accountId);
      const path = ouPath;
      const kinds = [
        ...new Set(
          org.kindOus.filter((k) => k.ouIds.some((ou) => path.includes(ou))).map((k) => k.kind),
        ),
      ];
      // 種類の OU に入るアカウントは、停止中でも StackSets の配る先になる。署名を置くアカウントなら誤り（cto の決裁 (5)(b)）
      if (kinds.length > 0 && config.signing.accountIds.includes(accountId))
        out.add(join(p, "accountId"), "signing_account");
      // 停止中・閉鎖待ちのアカウントは一覧に出さない（状態がなければ有効とみなす）
      if (status !== undefined && status !== "ACTIVE") return;
      if (kinds.length > 1) {
        // 種類の OU が入れ子になっている（同じロールが 2 つの StackSet から配られて衝突する。§11.6）
        out.add(p, "ou_nested");
        return;
      }
      const kind = kinds[0];
      if (kind === undefined) {
        unassigned += 1;
        return;
      }
      listed.push({
        ...base,
        accountId,
        name,
        kind,
        ...(email !== undefined && isEmail(email) ? { email } : {}),
      });
    });
    if (unassigned > 0) warnings.add(ip, "unassigned_accounts", unassigned);
  }
  return listed;
}

/** ローカル部の先頭 2 文字だけを残す（2 文字以下なら 1 文字）。§5.6。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

function emailFor(mode: EmailMode, email: string | undefined): { email?: string } {
  if (email === undefined || mode === "hidden") return {};
  return { email: mode === "masked" ? maskEmail(email) : email };
}

const roleArn = (accountId: string, role: ConsoleRole) =>
  `arn:aws:iam::${accountId}:role${rolePath(role.tier)}${role.roleName}`;

// ---- 生成 ----

/**
 * 一覧の行（アカウント × ロール）を展開する。tier を渡せばその階層のロールだけ（表示用の階層ごとの行）。
 * ロールが 1 つもないアカウントは入れない。
 */
function buildAccounts(
  config: ConsoleConfig,
  tier: Tier | undefined,
  listed: Listed[],
): WorkerAccount[] {
  const roles = tier === undefined ? config.roles : config.roles.filter((r) => r.tier === tier);
  const kinds = new Map(config.kinds.map((k) => [k.name, k]));
  const accounts: WorkerAccount[] = [];
  for (const a of listed) {
    const assign = kinds.get(a.kind)?.assign ?? [];
    const rowRoles: WorkerAccountRole[] = [];
    for (const r of roles) {
      const teams = assign.find((x) => x.role === r.name)?.teams;
      if (!teams || teams.length === 0) continue;
      rowRoles.push({
        role: r.name,
        roleArn: roleArn(a.accountId, r),
        teams: [...teams],
        sessionSeconds: r.sessionSeconds,
      });
    }
    if (rowRoles.length === 0) continue;
    const mode =
      a.boundary === "managed"
        ? config.inventory.accountEmail.managed
        : config.inventory.accountEmail.partner;
    accounts.push({
      accountId: a.accountId,
      name: a.name,
      ...emailFor(mode, a.email),
      orgLabel: a.organization,
      boundary: a.boundary,
      kind: a.kind,
      roles: rowRoles,
    });
  }
  return accounts;
}

const shownOrganizations = (config: ConsoleConfig, accounts: { orgLabel: string }[]) => {
  const shown = new Set(accounts.map((a) => a.orgLabel));
  return config.organizations
    .filter((o) => shown.has(o.name))
    .map((o) => ({ name: o.name, displayName: o.displayName }));
};

function buildWorker(
  config: ConsoleConfig,
  auds: ResolvedAuds,
  listed: Listed[],
  meta: Meta,
): WorkerConfig {
  const { portal } = config;
  const accounts = buildAccounts(config, undefined, listed);
  return {
    ...meta,
    purpose: "issue",
    tagKey: TEAM_TAG_KEY,
    identity: { sourceIdentity: config.identity.sourceIdentity },
    portal: {
      origin: portal.origin,
      routing: portal.routing,
      ...(portal.regions !== undefined
        ? { regions: { allowed: [...portal.regions.allowed], default: portal.regions.default } }
        : {}),
      ...(portal.supportUrl !== undefined ? { supportUrl: portal.supportUrl } : {}),
      ...(auds.entry !== undefined ? { entryAud: auds.entry } : {}),
    },
    teams: config.teams.map((t) => {
      const aud = auds.teams.get(t.name);
      return {
        name: t.name,
        displayName: t.displayName,
        tier: t.tier,
        ...(aud !== undefined ? { aud } : {}),
      };
    }),
    roles: config.roles.map((r) => ({
      name: r.name,
      roleName: r.roleName,
      displayName: r.displayName,
      tier: r.tier,
      sessionSeconds: r.sessionSeconds,
    })),
    boundaries: config.boundaries.map((b) => ({ name: b.name, issuer: b.issuer })),
    organizations: shownOrganizations(config, accounts),
    accounts,
  };
}

/**
 * 表示用の生成物（display.json）。入口の一覧（U2）の表示だけに使い、発行には使えない形にする:
 * AUD・Access のポリシー ID・issuer・タグのキー・roleArn を持たず、Administrator の行（表示用だけ）には email も入れない。
 */
function buildDisplay(config: ConsoleConfig, listed: Listed[], meta: Meta): DisplayConfig {
  const { portal } = config;
  const accounts: DisplayAccount[] = [];
  for (const tier of TIERS) {
    for (const a of buildAccounts(config, tier, listed)) {
      accounts.push({
        tier,
        accountId: a.accountId,
        name: a.name,
        // Administrator の行に email を入れない（司令塔の決定）。Standard の行は Worker 用と同じ規則
        ...(tier === "standard" && a.email !== undefined ? { email: a.email } : {}),
        orgLabel: a.orgLabel,
        boundary: a.boundary,
        kind: a.kind,
        roles: a.roles.map(({ role, teams, sessionSeconds }) => ({ role, teams, sessionSeconds })),
      });
    }
  }
  // Entra グループの Object ID（小文字にそろえる）→ チーム。同じグループを持つチームはまとめる
  const groups = new Map<string, DisplayGroup>();
  for (const t of config.teams) {
    if (!("groupObjectIds" in t.access)) continue;
    for (const id of t.access.groupObjectIds) {
      const key = id.toLowerCase();
      const g = groups.get(key) ?? { objectId: key, teams: [] };
      if (!g.teams.includes(t.name)) g.teams.push(t.name);
      groups.set(key, g);
    }
  }
  return {
    ...meta,
    purpose: "display",
    portal: {
      origin: portal.origin,
      routing: portal.routing,
      ...(portal.supportUrl !== undefined ? { supportUrl: portal.supportUrl } : {}),
    },
    teams: config.teams.map((t) => ({ name: t.name, displayName: t.displayName, tier: t.tier })),
    roles: config.roles.map((r) => ({
      name: r.name,
      displayName: r.displayName,
      tier: r.tier,
      sessionSeconds: r.sessionSeconds,
    })),
    groups: [...groups.values()],
    organizations: shownOrganizations(config, accounts),
    accounts,
  };
}

function buildStackSets(config: ConsoleConfig, meta: Meta): StackSetsParams {
  const kinds = new Map(config.kinds.map((k) => [k.name, k]));
  const parametersFor = (kind: string) => {
    const assign = kinds.get(kind)?.assign ?? [];
    return Object.fromEntries(
      config.roles.map((r) => [
        teamsParameterName(r.name),
        (assign.find((a) => a.role === r.name)?.teams ?? []).join(","),
      ]),
    );
  };
  const assignments: StackSetsParams["assignments"] = [];
  for (const org of config.organizations) {
    if (org.placement === "ou") {
      for (const { kind, ouIds } of org.kindOus)
        assignments.push({
          organization: org.name,
          kind,
          target: { ous: [...ouIds] },
          parameters: parametersFor(kind),
        });
    } else {
      const byKind = new Map<string, string[]>();
      for (const a of org.accounts)
        byKind.set(a.kind, [...(byKind.get(a.kind) ?? []), a.accountId]);
      for (const [kind, accounts] of byKind)
        assignments.push({
          organization: org.name,
          kind,
          target: { accounts },
          parameters: parametersFor(kind),
        });
    }
  }
  const boundaries = new Map(config.boundaries.map((b) => [b.name, b]));
  return {
    ...meta,
    tagKey: TEAM_TAG_KEY,
    audience: AUDIENCE,
    rolePathPrefix: ROLE_PATH_PREFIX,
    roles: config.roles.map((r) => ({
      name: r.name,
      roleName: r.roleName,
      tier: r.tier,
      rolePath: rolePath(r.tier),
      sessionSeconds: r.sessionSeconds,
      managedPolicyArns: [...r.managedPolicyArns],
      inlinePolicyFiles: [...r.inlinePolicyFiles],
      teamsParameter: teamsParameterName(r.name),
    })),
    providers: config.organizations.map((o) => ({
      organization: o.name,
      boundary: o.boundary,
      issuer: boundaries.get(o.boundary)?.issuer ?? "",
    })),
    assignments,
    teams: config.teams.map((t) => ({ name: t.name, tier: t.tier })),
    retiredTeams: config.retiredTeams.map((t) => ({ name: t.name, tier: t.tier })),
  };
}

function buildAccess(config: ConsoleConfig, auds: ResolvedAuds, meta: Meta): AccessSummary {
  return {
    ...meta,
    routing: config.portal.routing,
    origin: config.portal.origin,
    ...(auds.entry !== undefined ? { entryAud: auds.entry } : {}),
    teams: config.teams.map((t) => {
      const aud = auds.teams.get(t.name);
      const source =
        "groupObjectIds" in t.access
          ? { groupObjectIds: [...t.access.groupObjectIds] }
          : "policyIds" in t.access
            ? { policyIds: [...t.access.policyIds] }
            : { manualAud: true as const };
      return { name: t.name, tier: t.tier, ...source, ...(aud !== undefined ? { aud } : {}) };
    }),
  };
}

// ---- 退役したチーム名の台帳（前回の生成物との比較。§7.1）----

function readLedger(raw: unknown, key: string): LedgerTeam[] | undefined | null {
  const v = (raw as Record<string, unknown>)[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const out: LedgerTeam[] = [];
  for (const t of v) {
    if (typeof t !== "object" || t === null) return null;
    const { name, tier } = t as Record<string, unknown>;
    if (typeof name !== "string" || !(TIERS as readonly unknown[]).includes(tier)) return null;
    out.push({ name, tier: tier as Tier });
  }
  return out;
}

/**
 * 前回の StackSets 用の生成物の台帳と比べる。台帳から名前を消さない・消したチームは台帳へ移す・同じ名前の階層を変えない。
 * 前回が無い（新しいチェックアウトなど）ときは比べられないので警告にする（生成物は gitignore で、前回はその場所にしか無い）。
 */
function checkLedger(
  config: ConsoleConfig,
  previous: unknown,
  out: IssueList,
  warnings: IssueList,
) {
  if (previous === undefined) {
    warnings.add("previous", "ledger_previous_missing");
    return;
  }
  if (typeof previous !== "object" || previous === null || Array.isArray(previous)) {
    out.add("previous", "ledger_previous");
    return;
  }
  const prevTeams = readLedger(previous, "teams");
  const prevRetired = readLedger(previous, "retiredTeams");
  if (prevTeams === null || prevRetired === null) {
    out.add("previous", "ledger_previous");
    return;
  }
  if (prevTeams === undefined && prevRetired === undefined) {
    // P2 より前の形（台帳の項目が無い）。比べる相手が無い
    warnings.add("previous", "ledger_previous_missing");
    return;
  }
  const retired = new Set(config.retiredTeams.map((t) => t.name));
  const current = new Map(config.teams.map((t, i) => [t.name, { tier: t.tier, i }]));
  if ((prevRetired ?? []).some((t) => !retired.has(t.name)))
    out.add("retiredTeams", "retired_team_removed");
  for (const t of prevTeams ?? []) {
    const now = current.get(t.name);
    if (now === undefined) {
      if (!retired.has(t.name)) out.add("teams", "team_removed_not_retired");
    } else if (now.tier !== t.tier) out.add(`teams[${now.i}].tier`, "team_tier_changed");
  }
}

/**
 * 検証済みの設定から生成物を作る。誤り（AUD の欠落・食い違い・重複、インベントリの不正、台帳の食い違いなど）は
 * ConsoleConfigError（全件）。発行用の生成物は 1 つ（両階層）。
 */
export function generateConsoleArtifacts(
  config: ConsoleConfig,
  options: GenerateOptions,
): ConsoleArtifacts {
  const out = new IssueList();
  const warnings = new IssueList();
  const meta: Meta = {
    schemaVersion: 2,
    generatedAt: options.generatedAt,
    ...(options.sourceRevision !== undefined ? { sourceRevision: options.sourceRevision } : {}),
  };
  const requireAud = options.mode === "deploy" || options.auds !== undefined;
  const auds = resolveAuds(config, options.auds, requireAud, out);
  const listed = listAccounts(config, options.inventory, options.mode, out, warnings);
  checkLedger(config, options.previous, out, warnings);
  if (out.items.length > 0) throw new ConsoleConfigError(out.items);
  return {
    display: buildDisplay(config, listed, meta),
    worker: buildWorker(config, auds, listed, meta),
    stacksets: buildStackSets(config, meta),
    access: buildAccess(config, auds, meta),
    warnings: warnings.items,
  };
}
