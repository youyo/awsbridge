// コンソールログイン: 1 つの設定ファイルから、Worker 用（階層ごと）・StackSets 用・Access の検査用の生成物を作る。
// 設計: docs/specs/console-login-portal.md §5.2（一覧の形）・§9.10（分離）・§11.4（生成するもの）・§11.5（検査の順）・§11.6（誤りの扱い）。
// 副作用のない純粋関数だけを置く（ファイルの読み書きは scripts/console/config.ts）。MCP 用 Worker からは import しない。
//
// 分離の約束（§9.10・§11.2）: Worker 用の生成物には、その階層のチーム・ロール・境界の issuer・一覧の行だけを入れる。
// 種類の定義（kinds）・Entra のグループの Object ID・Access のポリシー ID・権限ポリシー・OU・他の階層の AUD は入れない。

import {
  ACCOUNT_ID_RE,
  AUD_RE,
  AUDIENCE,
  type ConsoleConfig,
  ConsoleConfigError,
  type ConsoleConfigIssue,
  type ConsoleRole,
  type EmailMode,
  IssueList,
  isEmail,
  join,
  ROLE_PATH_PREFIX,
  type Routing,
  readMap,
  readObj,
  readStr,
  rolePath,
  TEAM_TAG_KEY,
  TIERS,
  type Tier,
  teamsParameterName,
} from "./config";

export type GenerateMode = "check" | "deploy";

export type GenerateOptions = {
  /** check: PR の検査（AUD がなくても誤りにしない）。deploy: デプロイ用（その階層のチームの AUD が要る）。 */
  mode: GenerateMode;
  generatedAt: string;
  sourceRevision?: string;
  /** Terraform の出力: { teams: { <チーム>: <AUD> }, entry?: { standard?, admin? } }。渡すと check でも AUD の対応まで検査する。 */
  auds?: unknown;
  /** placement: ou の Organization のアカウント: { <Organization>: [{ accountId, name, email?, ouPath, status? }] }。 */
  inventory?: unknown;
};

type Meta = { schemaVersion: 1; generatedAt: string; sourceRevision?: string };

export type WorkerTeam = { name: string; displayName: string; aud?: string };
export type WorkerRole = {
  name: string;
  roleName: string;
  displayName: string;
  sessionSeconds: number;
};
export type WorkerAccountRole = {
  role: string;
  roleArn: string;
  teams: string[];
  sessionSeconds: number;
};
export type WorkerAccount = {
  accountId: string;
  name: string;
  email?: string;
  orgLabel: string;
  boundary: string;
  kind: string;
  roles: WorkerAccountRole[];
};
export type WorkerConfig = Meta & {
  tier: Tier;
  tagKey: string;
  portal: {
    origin: string;
    /** もう一方の階層のポータル（静的なリンクだけに使う。§8）。 */
    peerOrigin?: string;
    routing: Routing;
    regions?: { allowed: string[]; default: string };
    supportUrl?: string;
    entryAud?: string;
  };
  teams: WorkerTeam[];
  roles: WorkerRole[];
  boundaries: { name: string; issuer: string }[];
  organizations: { name: string; displayName: string }[];
  accounts: WorkerAccount[];
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
export type StackSetsParams = Meta & {
  tagKey: string;
  /** OIDC プロバイダーの ClientIdList と信頼ポリシーの <issuer>:aud に入れる値。 */
  audience: string;
  /** ロールのパスの接頭辞（停止用の SCP の条件に使う）。ロールごとのパスは roles[].rolePath。 */
  rolePathPrefix: string;
  roles: StackSetsRole[];
  /** 基盤の StackSet（Organization ごとの OIDC プロバイダー）。 */
  providers: {
    organization: string;
    boundary: string;
    issuers: { standard: string; admin?: string };
  }[];
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
  origins: { standard: string; admin?: string };
  entryAud: { standard?: string; admin?: string };
  teams: AccessTeam[];
};

export type ConsoleArtifacts = {
  worker: { standard: WorkerConfig; admin?: WorkerConfig };
  stacksets: StackSetsParams;
  access: AccessSummary;
  warnings: ConsoleConfigIssue[];
};

// ---- AUD ----

type ResolvedAuds = { teams: Map<string, string>; entry: { standard?: string; admin?: string } };

function parseAudInput(
  raw: unknown,
  out: IssueList,
): { teams: Map<string, string>; entry: Partial<Record<Tier, string>> } {
  const result = { teams: new Map<string, string>(), entry: {} as Partial<Record<Tier, string>> };
  const o = readObj(raw, "auds", ["teams", "entry"], out);
  if (!o) return result;
  if (o.teams !== undefined) {
    const teams = readMap(o.teams, "auds.teams", out) ?? [];
    for (const [name, v] of teams) {
      const aud = readStr({ [name]: v }, name, "auds.teams", out, { re: AUD_RE });
      if (aud !== undefined) result.teams.set(name, aud);
    }
  }
  if (o.entry !== undefined) {
    const e = readObj(o.entry, "auds.entry", TIERS, out);
    if (e)
      for (const t of TIERS) {
        const aud = readStr(e, t, "auds.entry", out, { re: AUD_RE });
        if (aud !== undefined) result.entry[t] = aud;
      }
  }
  return result;
}

function resolveAuds(
  config: ConsoleConfig,
  raw: unknown,
  requireAud: boolean,
  out: IssueList,
): ResolvedAuds {
  const input =
    raw === undefined ? { teams: new Map<string, string>(), entry: {} } : parseAudInput(raw, out);
  const known = new Set(config.teams.map((t) => t.name));
  for (const name of input.teams.keys())
    if (!known.has(name)) out.add(join("auds.teams", name), "unknown_team");

  const resolved: ResolvedAuds = { teams: new Map(), entry: {} };
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
  for (const tier of TIERS) {
    const manual = config.portal.entryAud[tier];
    const fromTf = input.entry[tier];
    if (manual !== undefined && fromTf !== undefined && manual !== fromTf)
      out.add(`portal.entryAud.${tier}`, "aud_mismatch");
    const aud = fromTf ?? manual;
    const teamCount = config.teams.filter((t) => t.tier === tier).length;
    if (aud === undefined) {
      // 入口のアプリはチームが 2 つ以上のときだけ要る（1 つならそのチームのアプリで守る。§11.7）
      if (requireAud && teamCount >= 2) out.add(`portal.entryAud.${tier}`, "entry_aud_missing");
      continue;
    }
    use(aud, fromTf !== undefined ? `auds.entry.${tier}` : `portal.entryAud.${tier}`);
    resolved.entry[tier] = aud;
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
      // 停止中・閉鎖待ちのアカウントは一覧に出さない（状態がなければ有効とみなす）
      if (status !== undefined && status !== "ACTIVE") return;
      const path = ouPath;
      const kinds = [
        ...new Set(
          org.kindOus.filter((k) => k.ouIds.some((ou) => path.includes(ou))).map((k) => k.kind),
        ),
      ];
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

function buildWorker(
  config: ConsoleConfig,
  tier: Tier,
  auds: ResolvedAuds,
  listed: Listed[],
  meta: Meta,
): WorkerConfig {
  const { portal } = config;
  const origin = tier === "standard" ? portal.standardOrigin : (portal.adminOrigin as string);
  const peer = tier === "standard" ? portal.adminOrigin : portal.standardOrigin;
  const roles = config.roles.filter((r) => r.tier === tier);
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
  const shownOrgs = new Set(accounts.map((a) => a.orgLabel));
  const entryAud = auds.entry[tier];
  return {
    ...meta,
    tier,
    tagKey: TEAM_TAG_KEY,
    portal: {
      origin,
      ...(peer !== undefined ? { peerOrigin: peer } : {}),
      routing: portal.routing,
      ...(portal.regions !== undefined
        ? { regions: { allowed: [...portal.regions.allowed], default: portal.regions.default } }
        : {}),
      ...(portal.supportUrl !== undefined ? { supportUrl: portal.supportUrl } : {}),
      ...(entryAud !== undefined ? { entryAud } : {}),
    },
    teams: config.teams
      .filter((t) => t.tier === tier)
      .map((t) => {
        const aud = auds.teams.get(t.name);
        return { name: t.name, displayName: t.displayName, ...(aud !== undefined ? { aud } : {}) };
      }),
    roles: roles.map((r) => ({
      name: r.name,
      roleName: r.roleName,
      displayName: r.displayName,
      sessionSeconds: r.sessionSeconds,
    })),
    boundaries: config.boundaries.flatMap((b) => {
      const issuer = b.issuers[tier];
      return issuer !== undefined ? [{ name: b.name, issuer }] : [];
    }),
    organizations: config.organizations
      .filter((o) => shownOrgs.has(o.name))
      .map((o) => ({ name: o.name, displayName: o.displayName })),
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
      issuers: { ...(boundaries.get(o.boundary)?.issuers ?? { standard: "" }) },
    })),
    assignments,
  };
}

function buildAccess(config: ConsoleConfig, auds: ResolvedAuds, meta: Meta): AccessSummary {
  return {
    ...meta,
    routing: config.portal.routing,
    origins: {
      standard: config.portal.standardOrigin,
      ...(config.portal.adminOrigin !== undefined ? { admin: config.portal.adminOrigin } : {}),
    },
    entryAud: { ...auds.entry },
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

/**
 * 検証済みの設定から生成物を作る。誤り（AUD の欠落・食い違い・重複、インベントリの不正など）は ConsoleConfigError（全件）。
 * Standard の生成物は常に作り、Admin の生成物は Admin の階層のチームがあるときだけ作る。
 */
export function generateConsoleArtifacts(
  config: ConsoleConfig,
  options: GenerateOptions,
): ConsoleArtifacts {
  const out = new IssueList();
  const warnings = new IssueList();
  const meta: Meta = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    ...(options.sourceRevision !== undefined ? { sourceRevision: options.sourceRevision } : {}),
  };
  const requireAud = options.mode === "deploy" || options.auds !== undefined;
  const auds = resolveAuds(config, options.auds, requireAud, out);
  const listed = listAccounts(config, options.inventory, options.mode, out, warnings);
  if (out.items.length > 0) throw new ConsoleConfigError(out.items);
  const hasAdmin = config.teams.some((t) => t.tier === "admin");
  return {
    worker: {
      standard: buildWorker(config, "standard", auds, listed, meta),
      ...(hasAdmin ? { admin: buildWorker(config, "admin", auds, listed, meta) } : {}),
    },
    stacksets: buildStackSets(config, meta),
    access: buildAccess(config, auds, meta),
    warnings: warnings.items,
  };
}
