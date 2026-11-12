// コンソールログイン: 検査の道具の判定（純粋な関数）。設計: docs/specs/console-login.md §4.8（構造の要件）・
// §4.9（検査の道具）・§6.3（1 人停止の予約名）。cto の回答 U-15、Sol のレビュー 2026-11-12 の B（採った指摘）。
// 読み取り（aws CLI）は scripts/console/inspect.ts。node の API を使わない。
// どの Worker のエントリからも import しない（test/unit/console-layout.test.ts で確かめる）。
//
// 信頼ポリシーは**承認済みの厳格な形だけを許す許可リスト方式**: Allow の文は 1 つだけで、Principal・Action・Condition の
// すべてのキーと値を、期待する形と組で照合する（余分な文・キー・演算子・値はすべて誤り）。同じ意味になる書き方の違い
// （Statement が 1 つのオブジェクト・1 要素の配列と文字列・集合の並び・Action の大文字小文字）だけは同じとみなす。
// Deny の文はあってよいが、常に効く Deny（強すぎる Deny）は誤り、判定しきれないものは人が見る警告にする。
//
// 結果（Finding）は種別のコードとロール名・構造の場所だけを持ち、値（email・SourceIdentity）を入れない。
// アカウント ID は出力のときに伏せる（formatReport）。

import type { ConsoleConfig, ConsoleRole } from "./config";
import { AUDIENCE, ROLE_PATH_PREFIX, rolePath, TEAM_TAG_KEY, TIERS, type Tier } from "./constants";
import { generateConsoleArtifacts } from "./generate";
import { guardPolicyDocument } from "./guard";
import { GUARD_POLICY_NAME, GUARD_POLICY_PATH, STOP_USER_INLINE_POLICY_NAME } from "./reserved";
import { stopValues } from "./stops";

export type RoleSnapshot = {
  roleName: string;
  path: string;
  arn: string;
  maxSessionDuration?: number;
  /** 信頼ポリシー（JSON として解釈したもの）。 */
  trustPolicy: unknown;
  /** 付いている管理ポリシー。読んでいなければ undefined。 */
  attachedPolicies?: { policyName: string; policyArn: string }[];
  /** インラインポリシー（名前と文書）。読んでいなければ undefined。 */
  inlinePolicies?: { policyName: string; document: unknown }[];
};

/** 顧客管理ポリシーの今の既定の版（GetPolicy の DefaultVersionId と GetPolicyVersion の文書）。 */
export type ManagedPolicySnapshot = { arn: string; defaultVersionId: string; document: unknown };

export type AccountSnapshot = {
  accountId: string;
  /** ARN のパーティション（aws など）。 */
  partition: string;
  /** IAM の OIDC プロバイダーの ARN。 */
  providers: string[];
  /** アカウントのすべてのロール（ListRoles）。設定のロールとコンソール用のプロバイダーを信頼するロールは詳細つき。 */
  roles: RoleSnapshot[];
  managedPolicies: ManagedPolicySnapshot[];
};

export type Severity = "error" | "warning" | "note";
export type Finding = { severity: Severity; code: string; role?: string; detail?: string };
export type InspectResult = {
  accountId: string;
  /** 設定（とインベントリ）で、このアカウントの配る種類が分かったか。 */
  known: boolean;
  findings: Finding[];
};

export type InspectInput = {
  config: ConsoleConfig;
  snapshot: AccountSnapshot;
  /** placement: ou の Organization のインベントリ（console:config:generate と同じ形。任意）。 */
  inventory?: unknown;
  /** 有効な 1 人停止の SourceIdentity の一覧（任意）。渡すと全ロールに Deny があるかを確かめる（U-15 (c)）。 */
  stops?: string[];
};

// ---- 値の扱い ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 文字列か文字列の配列を、配列にする（それ以外の形は undefined）。IAM は 1 要素の配列を文字列で返しうる。 */
function asList(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

const sameKeys = (o: Obj, keys: string[]) => sameSet(Object.keys(o), keys);

/** IAM の Action のワイルドカード（* と ?）の照合。大文字小文字を区別しない。 */
function actionMatches(pattern: string, action: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("")
      .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
    "i",
  );
  return re.test(action);
}

/** 文の並び（Statement が 1 つのオブジェクトでも配列にする）。形が違えば undefined。 */
function statements(doc: Obj): Obj[] | undefined {
  const s = doc.Statement;
  const list = Array.isArray(s) ? s : isObj(s) ? [s] : undefined;
  if (!list?.every(isObj)) return undefined;
  return list as Obj[];
}

// ---- 信頼ポリシー ----

const TRUST_ACTIONS = ["sts:AssumeRoleWithWebIdentity", "sts:TagSession", "sts:SetSourceIdentity"];
const OP_EQ = "StringEquals";
const OP_TAGKEYS = "ForAllValues:StringEquals";
const OP_NULL = "Null";
const TEAM_KEY = `aws:RequestTag/${TEAM_TAG_KEY}`;
const TAG_KEYS_KEY = "aws:TagKeys";
const SI_KEY = "sts:SourceIdentity";

type TrustExpect = {
  /** その階層のプロバイダーの ARN。 */
  providerArn: string;
  /** 条件キーに使う issuer（https:// を除いた <host>/<path>）。 */
  issuer: string;
  /** 信頼ポリシーに書いてよいチーム（その種類でそのロールに割り当てたチーム）。 */
  allowedTeams: string[];
  /** 割り当てたのに信頼ポリシーに無ければ警告にするチーム（種類が分からなければ空）。 */
  assignedTeams: string[];
};

type Issue = { severity: Severity; code: string; detail?: string };

const SI_FALSE = (v: unknown) =>
  v === "false" || v === false || (Array.isArray(v) && v.length === 1 && v[0] === "false");

/** 承認済みの Allow の文と 1 つずつ照合する。 */
function checkAllow(st: Obj, at: string, e: TrustExpect, out: Issue[]): void {
  const err = (code: string, detail: string) => out.push({ severity: "error", code, detail });
  for (const k of Object.keys(st))
    if (!["Sid", "Effect", "Principal", "Action", "Condition"].includes(k))
      err("trust_statement_key", `${at}.${k}`);

  const p = st.Principal;
  const fed = isObj(p) && sameKeys(p, ["Federated"]) ? asList(p.Federated) : undefined;
  if (!fed || !sameSet(fed, [e.providerArn])) err("trust_principal", `${at}.Principal`);

  const actions = asList(st.Action)?.map((a) => a.toLowerCase());
  if (
    !actions ||
    !sameSet(
      actions,
      TRUST_ACTIONS.map((a) => a.toLowerCase()),
    )
  )
    err("trust_action", `${at}.Action`);

  const c = st.Condition;
  if (!isObj(c)) {
    err("trust_condition_operator", `${at}.Condition`);
    return;
  }
  for (const op of Object.keys(c))
    if (![OP_EQ, OP_TAGKEYS, OP_NULL].includes(op))
      err("trust_condition_operator", `${at}.Condition.${op}`);

  // StringEquals: aud と チームのタグの値だけ
  const audKey = `${e.issuer}:aud`;
  const eq = c[OP_EQ];
  if (!isObj(eq)) {
    err("trust_aud", `${at}.Condition.${OP_EQ}`);
    err("trust_team", `${at}.Condition.${OP_EQ}`);
  } else {
    for (const k of Object.keys(eq))
      if (k !== audKey && k !== TEAM_KEY)
        err(
          k.endsWith(":aud") ? "trust_aud" : "trust_condition_key",
          `${at}.Condition.${OP_EQ}.${k}`,
        );
    const aud = asList(eq[audKey]);
    if (!aud || !sameSet(aud, [AUDIENCE])) err("trust_aud", `${at}.Condition.${OP_EQ}.${audKey}`);
    const teams = asList(eq[TEAM_KEY]);
    if (!teams || teams.length === 0 || !teams.every((t) => e.allowedTeams.includes(t)))
      err("trust_team", `${at}.Condition.${OP_EQ}.${TEAM_KEY}`);
    else {
      const missing = e.assignedTeams.filter((t) => !teams.includes(t));
      if (missing.length > 0)
        out.push({
          severity: "warning",
          code: "trust_team_missing",
          detail: `${at}.Condition.${OP_EQ}.${TEAM_KEY}: ${missing.join(",")}`,
        });
    }
  }

  // ForAllValues:StringEquals: aws:TagKeys はチームのタグのキーだけ
  const tk = c[OP_TAGKEYS];
  const tkv = isObj(tk) && sameKeys(tk, [TAG_KEYS_KEY]) ? asList(tk[TAG_KEYS_KEY]) : undefined;
  if (!tkv || !sameSet(tkv, [TEAM_TAG_KEY])) err("trust_tag_keys", `${at}.Condition.${OP_TAGKEYS}`);

  // Null: SourceIdentity 必須
  const nl = c[OP_NULL];
  if (!(isObj(nl) && sameKeys(nl, [SI_KEY]) && SI_FALSE(nl[SI_KEY])))
    err("trust_source_identity", `${at}.Condition.${OP_NULL}`);
}

/** Deny の文が、承認済みの Allow で入るセッションに常に効くか（効くなら強すぎる Deny）。判定しきれなければ "review"。 */
function denyEffect(st: Obj, e: TrustExpect): "none" | "always" | "review" {
  if (st.NotPrincipal !== undefined || st.NotAction !== undefined) return "review";
  const p = st.Principal;
  const principals =
    p === "*" ? ["*"] : isObj(p) ? Object.values(p).flatMap((v) => asList(v) ?? []) : [];
  if (!principals.some((x) => x === "*" || x === e.providerArn)) return "none";
  const actions = asList(st.Action) ?? [];
  if (!TRUST_ACTIONS.some((a) => actions.some((pat) => actionMatches(pat, a)))) return "none";
  const c = st.Condition;
  if (c === undefined) return "always";
  if (!isObj(c)) return "review";
  // 条件がすべて、承認済みの Allow が必ず満たす条件（同じ演算子・キーで、値が Allow の値を含む）なら常に効く
  const implied: Record<string, Record<string, string[]>> = {
    [OP_EQ]: { [`${e.issuer}:aud`]: [AUDIENCE] },
    [OP_TAGKEYS]: { [TAG_KEYS_KEY]: [TEAM_TAG_KEY] },
    [OP_NULL]: { [SI_KEY]: ["false"] },
  };
  for (const [op, body] of Object.entries(c)) {
    if (!isObj(body)) return "review";
    for (const [k, v] of Object.entries(body)) {
      const need = implied[op]?.[k];
      const have = op === OP_NULL && v === false ? ["false"] : asList(v);
      if (!need || !have || !need.every((x) => have.includes(x))) return "review";
    }
  }
  return "always";
}

/** 信頼ポリシーを、承認済みの厳格な形と照合する。 */
export function checkTrustPolicy(doc: unknown, e: TrustExpect): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, detail?: string) =>
    out.push({ severity: "error", code, ...(detail !== undefined ? { detail } : {}) });
  if (!isObj(doc)) {
    err("trust_parse");
    return out;
  }
  for (const k of Object.keys(doc))
    if (!["Version", "Statement", "Id"].includes(k)) err("trust_top_key", k);
  if (doc.Version !== "2012-10-17") err("trust_version", "Version");
  const list = statements(doc);
  if (!list) {
    err("trust_parse", "Statement");
    return out;
  }
  const allows: [Obj, string][] = [];
  list.forEach((st, i) => {
    const at = `Statement[${i}]`;
    if (st.Effect === "Allow") allows.push([st, at]);
    else if (st.Effect === "Deny") {
      const d = denyEffect(st, e);
      if (d === "always") err("trust_deny_always", at);
      else if (d === "review")
        out.push({ severity: "warning", code: "trust_deny_review", detail: at });
    } else err("trust_effect", `${at}.Effect`);
  });
  if (allows.length === 0) err("trust_allow_missing", "Statement");
  if (allows.length > 1) err("trust_allow_extra", allows.map(([, at]) => at).join(","));
  for (const [st, at] of allows) checkAllow(st, at, e, out);
  return out;
}

// ---- アカウント ----

type Expected = {
  role: ConsoleRole;
  /** その種類でそのロールに割り当てたチーム（種類が分からなければ、設定のどれかの種類で割り当てたチームすべて）。 */
  teams: string[];
};

const issuerOf = (url: string) => url.replace(/^https:\/\//, "");
const hostOf = (issuer: string) => issuer.split("/")[0] ?? issuer;

// ---- 文書の照合・形 ----

const SCALAR_KEYS = new Set(["", "Version", "Id", "Sid", "Effect"]);

/**
 * 同じ意味の書き方の違いをそろえる: Statement を配列に、値の文字列を 1 要素の配列に、文字列の並びを並べ替える。
 * 演算子・条件キー・値そのものは変えない。
 */
function canon(v: unknown, key = ""): unknown {
  if (typeof v === "string") return SCALAR_KEYS.has(key) ? v : [v];
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === "string" ? x : canon(x)));
    if (items.every((x) => typeof x === "string")) return [...new Set(items as string[])].sort();
    return items.map((x) => JSON.stringify(x)).sort();
  }
  if (isObj(v)) {
    if (key === "Statement") return canon([v], key);
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canon(v[k], k)]),
    );
  }
  return v;
}
const samePolicy = (a: unknown, b: unknown) =>
  JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * 条件のない全拒否があるか。ロールがほとんど何もできなくなる（強すぎる Deny）。
 * Action "*" か NotAction（挙げたもの以外のすべて）で、Resource "*" の、条件のない Deny。
 */
function denyAll(doc: unknown): boolean {
  if (!isObj(doc)) return false;
  return (statements(doc) ?? []).some(
    (st) =>
      st.Effect === "Deny" &&
      st.Condition === undefined &&
      st.NotResource === undefined &&
      (st.NotAction !== undefined || (asList(st.Action) ?? []).includes("*")) &&
      (asList(st.Resource) ?? []).includes("*"),
  );
}

/**
 * Allow の文で、コンソール用のプロバイダー（ホストが一致）を信頼しているか。だれでも（* や NotPrincipal）を信頼する文は、
 * AssumeRoleWithWebIdentity を許す（NotAction を含む）ときだけ数える（sts:AssumeRole だけの文はコンソールの JWT では入れない）。
 */
function trustsConsole(doc: unknown, hosts: string[]): boolean {
  if (!isObj(doc)) return false;
  for (const st of statements(doc) ?? []) {
    if (st.Effect !== "Allow") continue;
    const webIdentity =
      st.NotAction !== undefined ||
      (asList(st.Action) ?? []).some((a) => actionMatches(a, "sts:AssumeRoleWithWebIdentity"));
    if (webIdentity && (st.NotPrincipal !== undefined || st.Principal === "*")) return true;
    if (!isObj(st.Principal)) continue;
    for (const [k, v] of Object.entries(st.Principal))
      for (const x of asList(v) ?? []) {
        if (webIdentity && x === "*" && (k === "AWS" || k === "Federated")) return true;
        const m = /:oidc-provider\/(.+)$/.exec(x);
        if (m?.[1] !== undefined && hosts.includes(hostOf(m[1]))) return true;
      }
  }
  return false;
}

/** Standard の階層のロールに付いていれば警告する、既知の広い AWS 管理ポリシー（§4.9 の「強さ」）。 */
export const BROAD_MANAGED_POLICIES = [
  "AdministratorAccess",
  "PowerUserAccess",
  "IAMFullAccess",
  "AdministratorAccess-Amplify",
  "AdministratorAccess-AWSElasticBeanstalk",
  "AWSOrganizationsFullAccess",
];
const awsManagedName = (arn: string) =>
  /^arn:[\w-]+:iam::aws:policy\/(?:.+\/)?([^/]+)$/.exec(arn)?.[1];

// ---- アカウント ----

export function inspectAccount(input: InspectInput): InspectResult {
  const { config, snapshot: s } = input;
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, role?: string, detail?: string) =>
    findings.push({
      severity,
      code,
      ...(role !== undefined ? { role } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });

  const consoleHosts = [
    ...new Set(
      config.boundaries.flatMap((b) =>
        [b.issuers.standard, b.issuers.admin].flatMap((u) =>
          u !== undefined ? [hostOf(issuerOf(u))] : [],
        ),
      ),
    ),
  ];
  const isConsoleProvider = (arn: string) => {
    const m = /:oidc-provider\/(.+)$/.exec(arn);
    return m?.[1] !== undefined && consoleHosts.includes(hostOf(m[1]));
  };
  const finish = (known: boolean): InspectResult => {
    add("note", "limit_inline_not_evaluated");
    add("note", "limit_customer_managed_not_evaluated");
    add("note", "limit_point_in_time");
    add("note", "limit_single_account");
    return { accountId: s.accountId, known, findings };
  };

  // 署名を置くアカウント: コンソールログインのプロバイダーとロールを置かない（cto の決裁 (5)(b)）
  if (config.signing.accountIds.includes(s.accountId)) {
    for (const p of s.providers)
      if (isConsoleProvider(p)) add("error", "signing_account_provider", undefined, p);
    for (const r of s.roles)
      if (r.path.startsWith(ROLE_PATH_PREFIX) || trustsConsole(r.trustPolicy, consoleHosts))
        add("error", "signing_account_role", r.roleName);
      else if (!isObj(r.trustPolicy)) add("warning", "trust_unreadable", r.roleName);
    return finish(false);
  }

  const art = generateConsoleArtifacts(config, {
    mode: "check",
    generatedAt: "inspect",
    ...(input.inventory !== undefined ? { inventory: input.inventory } : {}),
  });
  const rows = TIERS.flatMap((t) =>
    (art.worker[t]?.accounts ?? []).filter((a) => a.accountId === s.accountId),
  );
  const known = rows.length > 0;
  // 設定に無いアカウント: 取り違えたプロファイルで「誤りなし」にしないよう、誤りにする（検査は続ける）
  if (!known) add("error", "account_not_in_config");
  const boundaryName = rows[0]?.boundary;
  const boundaries = config.boundaries.filter((b) => !known || b.name === boundaryName);
  // 守りの部品のプロバイダーの Deny が守るホストの組（候補）。Admin の階層のあるアカウント（Admin の行があり、境界に
  // Admin の issuer がある）では [Standard, Admin] の 2 つ、無ければ Standard だけ（base に AdminIssuerHost を渡すのは
  // Admin を配るアカウントだけ）。設定に無いアカウントは、どの境界のどちらの形も受ける。
  // Admin の部品は Admin の階層があるときだけ作られるので、いつも Admin のホストを含む形で照合する
  const hasAdminRow = art.worker.admin?.accounts.some((a) => a.accountId === s.accountId) ?? false;
  const guardHostSets = boundaries.flatMap((b) => {
    const std = hostOf(issuerOf(b.issuers.standard));
    const admin = b.issuers.admin !== undefined ? hostOf(issuerOf(b.issuers.admin)) : undefined;
    if (admin === undefined) return [[std]];
    if (!known) return [[std], [std, admin]];
    return hasAdminRow ? [[std, admin]] : [[std]];
  });

  // このアカウントで期待するロール（種類が分からなければ、設定のすべてのロールを候補にする）
  const expected = new Map<string, Expected>();
  if (known) {
    for (const row of rows)
      for (const r of row.roles) {
        const role = config.roles.find((x) => x.name === r.role);
        if (role) expected.set(role.roleName, { role, teams: [...r.teams] });
      }
  } else {
    for (const role of config.roles) {
      const teams = [
        ...new Set(
          config.kinds.flatMap((k) => k.assign.find((a) => a.role === role.name)?.teams ?? []),
        ),
      ];
      expected.set(role.roleName, { role, teams });
    }
  }

  const providerArn = (issuer: string) =>
    `arn:${s.partition}:iam::${s.accountId}:oidc-provider/${issuer}`;
  const guardArn = (t: Tier) =>
    `arn:${s.partition}:iam::${s.accountId}:policy${GUARD_POLICY_PATH}${GUARD_POLICY_NAME[t]}`;
  const tierIssuers = (tier: Tier) =>
    boundaries.flatMap((b) => {
      const url = b.issuers[tier];
      return url !== undefined ? [issuerOf(url)] : [];
    });

  const seen = new Set<string>();
  for (const r of s.roles) {
    const exp = expected.get(r.roleName);
    if (!exp) {
      // 棚卸し: 設定に無い（またはこのアカウントの種類で割り当てていない）のに、コンソール用のパスにあるか、
      // コンソール用のプロバイダーを信頼するロール（STS で直接引き受けられうる）
      if (r.path.startsWith(ROLE_PATH_PREFIX) || trustsConsole(r.trustPolicy, consoleHosts))
        add("error", "unlisted_role", r.roleName);
      // 信頼ポリシーを読めない（文字列のまま）ロールは、プロバイダーを信頼しているか分からないので人が見る
      else if (!isObj(r.trustPolicy)) add("warning", "trust_unreadable", r.roleName);
      continue;
    }
    seen.add(r.roleName);
    const tier = exp.role.tier;
    const name = r.roleName;

    if (r.path !== rolePath(tier)) add("error", "path_mismatch", name, rolePath(tier));

    // 信頼ポリシー。種類が分からないときは、境界の候補のうち Principal と合うものを選ぶ
    const issuers = tierIssuers(tier);
    const trustText = JSON.stringify(r.trustPolicy);
    const issuer = issuers.find((i) => trustText.includes(`"${providerArn(i)}"`)) ?? issuers[0];
    if (issuer === undefined) add("error", "issuer_unknown", name, tier);
    else
      for (const i of checkTrustPolicy(r.trustPolicy, {
        providerArn: providerArn(issuer),
        issuer,
        allowedTeams: exp.teams,
        assignedTeams: known ? exp.teams : [],
      }))
        add(i.severity, i.code, name, i.detail);

    // 管理ポリシー: 守りの部品（付いていること・今の既定の版の中身）、強すぎる Deny、広い管理ポリシー
    if (r.attachedPolicies === undefined) add("error", "role_unreadable", name, "attached");
    else {
      const arns = r.attachedPolicies.map((p) => p.policyArn);
      const want = guardArn(tier);
      if (!arns.includes(want)) add("error", "guard_missing", name, GUARD_POLICY_NAME[tier]);
      else {
        const mp = s.managedPolicies.find((p) => p.arn === want);
        if (!mp) add("error", "guard_unreadable", name, GUARD_POLICY_NAME[tier]);
        else if (
          !guardHostSets
            .filter((hosts) => tier !== "admin" || hosts.length > 1)
            .some((issuerHosts) =>
              samePolicy(
                mp.document,
                guardPolicyDocument(tier, {
                  partition: s.partition,
                  accountId: s.accountId,
                  issuerHosts,
                }),
              ),
            )
        )
          add(
            "error",
            "guard_version_mismatch",
            name,
            `${GUARD_POLICY_NAME[tier]}@${mp.defaultVersionId}`,
          );
      }
      for (const t of TIERS)
        if (t !== tier && arns.includes(guardArn(t)))
          add("warning", "guard_other_tier", name, GUARD_POLICY_NAME[t]);
      for (const arn of arns) {
        const aws = awsManagedName(arn);
        if (aws !== undefined) {
          if (tier === "standard" && BROAD_MANAGED_POLICIES.includes(aws))
            add("warning", "broad_managed_policy", name, aws);
          continue;
        }
        if (TIERS.some((t) => guardArn(t) === arn)) continue;
        const mp = s.managedPolicies.find((p) => p.arn === arn);
        if (mp && denyAll(mp.document)) add("error", "deny_all", name, arn);
      }
    }

    // インライン: 予約名の衝突・強すぎる Deny。停止中の確認（U-15 (c)）
    let stopped: string[] | undefined;
    if (r.inlinePolicies === undefined) add("error", "role_unreadable", name, "inline");
    else
      for (const ip of r.inlinePolicies) {
        if (ip.policyName.toLowerCase() === STOP_USER_INLINE_POLICY_NAME.toLowerCase()) {
          const v = stopValues(ip.document);
          if (v === undefined) add("error", "stop_reserved_conflict", name, ip.policyName);
          else stopped = v;
        } else if (denyAll(ip.document)) add("error", "deny_all", name, ip.policyName);
      }
    if (input.stops !== undefined) {
      const have = stopped ?? [];
      const stops = input.stops;
      const missing = stops.filter((v) => !have.includes(v)).length;
      const extra = have.filter((v) => !stops.includes(v)).length;
      if (missing > 0) add("error", "stop_missing", name, String(missing));
      if (extra > 0) add("warning", "stop_extra", name, String(extra));
    } else if (stopped !== undefined) add("note", "stop_present", name, String(stopped.length));

    if (r.maxSessionDuration !== undefined && r.maxSessionDuration !== exp.role.sessionSeconds)
      add("warning", "session_mismatch", name, String(r.maxSessionDuration));
  }

  if (known) {
    for (const [roleName, exp] of expected)
      if (!seen.has(roleName)) add("error", "role_missing", roleName, exp.role.tier);
    const tiers = new Set([...expected.values()].map((e) => e.role.tier));
    for (const tier of TIERS) {
      if (!tiers.has(tier)) continue;
      const issuer = tierIssuers(tier)[0];
      if (issuer !== undefined && !s.providers.includes(providerArn(issuer)))
        add("error", "provider_missing", undefined, tier);
    }
  }

  return finish(known);
}

// ---- 出力 ----

/** アカウント ID（12 桁）と email を伏せる。 */
export function redact(text: string): string {
  return text
    .replace(/(?<!\d)\d{12}(?!\d)/g, "<account>")
    .replace(/[^\s@"'<>,;:()[\]]+@[^\s@"'<>,;:()[\]]+/g, "<email>");
}

const LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARN ", note: "NOTE " };

/** 結果を 1 行ずつの文字列にする（伏せ字済み）。最後に件数の行。 */
export function formatReport(r: InspectResult, label?: string): string {
  const order: Severity[] = ["error", "warning", "note"];
  // アカウント ID は末尾 4 桁だけ（取り違えたプロファイルに気づけるように）
  const masked = `****${r.accountId.slice(-4)}`;
  const lines = [
    `account: ${masked}${label !== undefined ? ` ${label}` : ""} (in config: ${r.known ? "yes" : "no"})`,
  ];
  for (const sev of order)
    for (const f of r.findings.filter((x) => x.severity === sev))
      lines.push([LABEL[sev], f.code, f.role ?? "-", f.detail ?? ""].join("  ").trimEnd());
  const n = (sev: Severity) => r.findings.filter((x) => x.severity === sev).length;
  lines.push(`errors: ${n("error")}, warnings: ${n("warning")}`);
  return redact(lines.join("\n"));
}
