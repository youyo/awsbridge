// 突き合わせの判定（純粋な関数。node:* を import しない）: 発行記録 × CloudTrail の AssumeRoleWithWebIdentity。
// 入力の読み取りは reconcile-input.ts、CLI は scripts/console/reconcile.ts（mise タスク console:reconcile）。
// 設計: docs/specs/console-login.md §5.6、console-login-admin.md §8。cto の決裁 2026-11-13（2 件）:
//   ★1 有効な全リージョンを読む（読めなかったリージョンは誤り）/ 設定に無いプロバイダーでの引き受けは誤り /
//   (a) 記録の保持期間（既定 7 日）より古い引き受けは「検証できない」として別に数える / (c) 切られた行は誤り。
//
// コンソールの引き受けだけに絞る: ロールのパスが /awsbridge-console/、またはプロバイダーのホストが設定の issuer のホスト。
// MCP 用の Worker の引き受け（同じ API）は除く。突き合わせは検知の材料で、完全性の証明ではない
// （侵害された Worker は偽の記録も書ける。console-login-admin.md §8）。
//
// 所見（severity）:
//   error   assume_without_record     記録に jti が無い引き受け（作られた JWT か、Worker の外からの発行）
//   error   provider_not_in_config    設定に無いプロバイダー（issuer のホストとパス）でコンソールの引き受け
//   error   tier_mismatch             記録の tier・プロバイダーの階層と、ロールのパスの階層が違う
//   error   role_mismatch             記録のロール ARN と引き受けたロールが違う
//   error   region_unread             読めなかったリージョン（★1）
//   error   record_line_truncated     切られた記録の行（決裁 (c)）
//   error   record_line_unreadable    読めない記録の行
//   warning jti_reused                同じ jti で 2 回以上引き受けた
//   warning record_without_assume     引き受けがあるはずの記録に、引き受けが無い
//   warning aux_mismatch              補助のキー（AccessKeyId・RequestId・AssumedRoleId の伏せ字）が食い違う
//   warning unverifiable              記録の保持より古く、記録の無い引き受け（件数。決裁 (a)）
//   warning window_exceeds_retention  さかのぼりが記録の保持より長い
//   note    pending                   反映の遅れ（lagSeconds）より新しく、まだ引き受けが見えない記録
//   note    record_sts_failed_no_event STS が失敗した記録で、引き受けのイベントが無い（失敗はイベント履歴に出ないことがある）
//   note    assume_failed             失敗した引き受け（errorCode）の件数
import { ROLE_PATH_PREFIX, rolePath, TIERS, type Tier } from "./constants";
import type { AssumeEvent, ReconRecord } from "./reconcile-input";

export type Severity = "error" | "warning" | "note";
export type ReconFinding = {
  severity: Severity;
  code: string;
  /** jti の先頭 8 文字（伏せ字）。 */
  jti?: string;
  /** ロールの名前（ARN の最後の部分）。 */
  role?: string;
  /** 位置（記録の行）・リージョン・時刻など。値（email など）は入れない。 */
  detail?: string;
};

export const DEFAULT_LAG_SECONDS = 300;
/** Workers Logs の保持（Workers Paid）。② の発行記録の置き場所（cto の決裁）。 */
export const DEFAULT_RETENTION_DAYS = 7;
/** 既定のさかのぼり（保持より短く。決裁 (a)）。 */
export const DEFAULT_LOOKBACK_DAYS = 6;

export type ReconcileInput = {
  records: readonly ReconRecord[];
  /** 読んだリージョンの AssumeRoleWithWebIdentity のイベント（コンソール以外も含んでよい）。 */
  events: readonly AssumeEvent[];
  /** CloudTrail を読んだ期間（epoch ミリ秒）。 */
  window: { since: number; until: number };
  /** epoch ミリ秒。 */
  now: number;
  /** プロファイルのアカウント（12 桁）。 */
  accountId: string;
  /** 設定の issuer（境界 × 階層）。 */
  issuers: readonly { url: string; tier: Tier }[];
  regions: { read: readonly string[]; unread: readonly string[] };
  lines: { truncated: readonly string[]; unreadable: readonly string[]; total: number };
  /** 記録をどこから読んだか。 */
  source: "api" | "file";
  lagSeconds?: number;
  retentionDays?: number;
};

export type ReconcileSummary = {
  source: "api" | "file";
  accountId: string;
  window: { since: number; until: number };
  retentionDays: number;
  lagSeconds: number;
  regionsRead: number;
  regionsTotal: number;
  lines: number;
  records: number;
  recordsThisAccount: number;
  consoleAssumes: number;
  failedAssumes: number;
  matched: number;
  unverifiable: number;
  pending: number;
  truncatedLines: number;
  unreadableLines: number;
};

export type ReconcileResult = { findings: ReconFinding[]; summary: ReconcileSummary };

/** jti の伏せ字（先頭 8 文字）。 */
export const maskJti = (jti: string): string => `${jti.slice(0, 8)}…`;

/** プロバイダーの識別（ARN・https:// の URL・ホストとパス）を「ホスト/パス」にそろえる。 */
export function providerId(v: string): string {
  return v
    .replace(/^arn:[\w-]+:iam::\d{12}:oidc-provider\//, "")
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
}
const hostOf = (id: string) => id.split("/")[0] ?? id;

/** ロール ARN のパス（/awsbridge-console/std/ など）と名前。 */
function roleParts(arn: string | undefined): { path: string; name: string } | undefined {
  const m = /^arn:[\w-]+:iam::\d{12}:role(\/(?:.*\/)?)([^/]+)$/.exec(arn ?? "");
  return m?.[1] !== undefined && m[2] !== undefined ? { path: m[1], name: m[2] } : undefined;
}
const pathTier = (path: string | undefined): Tier | undefined =>
  path === undefined ? undefined : TIERS.find((t) => path === rolePath(t));

/** 記録のアカウントがプロファイルのアカウントか（古い形の伏せ字は末尾 4 桁で見る）。 */
function sameAccount(recordAccount: string, accountId: string): boolean {
  if (/^\d{12}$/.test(recordAccount)) return recordAccount === accountId;
  const m = /^\*+(\d{4})$/.exec(recordAccount);
  return m?.[1] !== undefined && accountId.endsWith(m[1]);
}

/** 記録の値（伏せ字）と CloudTrail の値（同じ形の伏せ字）を比べる。どちらかが無ければ比べない。 */
const auxDiffers = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a !== b;

/** STS を呼んだ（引き受けのイベントがあるはず）記録か。ok か、STS の応答の AccessKeyId がある記録。 */
const expectsAssume = (r: ReconRecord) => r.result === "ok" || r.accessKeyId !== undefined;

export function reconcile(i: ReconcileInput): ReconcileResult {
  const lagSeconds = i.lagSeconds ?? DEFAULT_LAG_SECONDS;
  const retentionDays = i.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const retentionCutoff = i.now - retentionDays * 86_400_000;
  const findings: ReconFinding[] = [];
  const add = (f: ReconFinding) => findings.push(f);

  // 設定の issuer（ホスト/パス → 階層）とホスト
  const configured = new Map<string, Tier>();
  for (const x of i.issuers) configured.set(providerId(x.url), x.tier);
  const consoleHosts = new Set([...configured.keys()].map(hostOf));

  const isConsole = (e: AssumeEvent) =>
    (roleParts(e.roleArn)?.path.startsWith(ROLE_PATH_PREFIX) ?? false) ||
    (e.provider !== undefined && consoleHosts.has(hostOf(providerId(e.provider))));
  const consoleEvents = i.events.filter(isConsole);

  // 記録を jti で引く（全記録。アカウントが違っても対にする）
  const byJti = new Map<string, ReconRecord>();
  for (const r of i.records) if (r.jti !== undefined && !byJti.has(r.jti)) byJti.set(r.jti, r);

  const eventsByJti = new Map<string, AssumeEvent[]>();
  for (const e of consoleEvents)
    if (e.tokenId !== undefined)
      eventsByJti.set(e.tokenId, [...(eventsByJti.get(e.tokenId) ?? []), e]);

  let matched = 0;
  let unverifiable = 0;
  let failedAssumes = 0;
  const when = (t: number) => new Date(t).toISOString();

  // ---- 引き受けの側 ----
  for (const e of consoleEvents) {
    const role = roleParts(e.roleArn);
    const base = {
      ...(e.tokenId !== undefined ? { jti: maskJti(e.tokenId) } : {}),
      ...(role !== undefined ? { role: role.name } : {}),
    };
    const at = `${e.region} ${when(e.time)}`;
    const roleTier = pathTier(role?.path);

    // プロバイダー: 設定に無ければ誤り（同じホストの別のパスも別の IAM のプロバイダー）
    const pid = e.provider !== undefined ? providerId(e.provider) : undefined;
    const providerTier = pid !== undefined ? configured.get(pid) : undefined;
    if (pid === undefined || providerTier === undefined)
      add({
        severity: "error",
        code: "provider_not_in_config",
        ...base,
        detail: `${at} provider=${pid ?? "-"}`,
      });
    else if (roleTier !== undefined && providerTier !== roleTier)
      add({
        severity: "error",
        code: "tier_mismatch",
        ...base,
        detail: `${at} provider=${providerTier} role=${roleTier}`,
      });

    if (e.errorCode !== undefined) {
      failedAssumes++;
      continue;
    }

    const r = e.tokenId !== undefined ? byJti.get(e.tokenId) : undefined;
    if (!r) {
      if (e.time < retentionCutoff) {
        unverifiable++;
        continue;
      }
      add({
        severity: "error",
        code: "assume_without_record",
        ...base,
        detail: e.tokenId === undefined ? `${at} (no webIdentityTokenId)` : at,
      });
      continue;
    }
    matched++;
    if (roleTier !== undefined && r.tier !== roleTier)
      add({
        severity: "error",
        code: "tier_mismatch",
        ...base,
        detail: `${at} record=${r.tier} role=${roleTier} (${r.pos})`,
      });
    if (r.roleArn !== undefined && /\d{12}/.test(r.roleArn) && r.roleArn !== e.roleArn)
      add({
        severity: "error",
        code: "role_mismatch",
        ...base,
        detail: `${at} record role=${roleParts(r.roleArn)?.name ?? "-"} (${r.pos})`,
      });
    const aux = [
      auxDiffers(r.accessKeyId, e.accessKeyId) ? "accessKeyId" : undefined,
      auxDiffers(r.requestId, e.requestId) ? "requestId" : undefined,
      auxDiffers(r.assumedRoleId, e.assumedRoleId) ? "assumedRoleId" : undefined,
    ].filter((x) => x !== undefined);
    if (aux.length > 0)
      add({
        severity: "warning",
        code: "aux_mismatch",
        ...base,
        detail: `${at} ${aux.join(",")} (${r.pos})`,
      });
  }
  for (const [tokenId, list] of eventsByJti) {
    const ok = list.filter((e) => e.errorCode === undefined);
    if (ok.length >= 2)
      add({
        severity: "warning",
        code: "jti_reused",
        jti: maskJti(tokenId),
        detail: `${ok.length} assumes (${ok.map((e) => e.region).join(",")})`,
      });
  }
  if (unverifiable > 0)
    add({
      severity: "warning",
      code: "unverifiable",
      detail: `${unverifiable} assumes older than the record retention (${retentionDays}d)`,
    });
  if (failedAssumes > 0)
    add({ severity: "note", code: "assume_failed", detail: `${failedAssumes} assumes` });

  // ---- 記録の側 ----
  const unread = new Set(i.regions.unread);
  const thisAccount = i.records.filter((r) => sameAccount(r.accountId, i.accountId));
  let pending = 0;
  for (const r of thisAccount) {
    if (r.jti === undefined) continue;
    if (r.at < i.window.since || r.at > i.window.until) continue;
    if (unread.has(r.stsRegion)) continue; // region_unread の誤りで知らせる
    if (eventsByJti.has(r.jti)) continue;
    const base = { jti: maskJti(r.jti), detail: `${r.stsRegion} ${when(r.at)} (${r.pos})` };
    if (r.at > i.now - lagSeconds * 1000) {
      pending++;
      add({ severity: "note", code: "pending", ...base });
    } else if (expectsAssume(r))
      add({ severity: "warning", code: "record_without_assume", ...base });
    else add({ severity: "note", code: "record_sts_failed_no_event", ...base });
  }

  // ---- 入力の欠け ----
  for (const region of i.regions.unread)
    add({ severity: "error", code: "region_unread", detail: region });
  for (const pos of i.lines.truncated)
    add({ severity: "error", code: "record_line_truncated", detail: pos });
  for (const pos of i.lines.unreadable)
    add({ severity: "error", code: "record_line_unreadable", detail: pos });
  if (i.window.since < retentionCutoff)
    add({
      severity: "warning",
      code: "window_exceeds_retention",
      detail: `since ${when(i.window.since)} is older than the record retention (${retentionDays}d)`,
    });

  return {
    findings,
    summary: {
      source: i.source,
      accountId: i.accountId,
      window: i.window,
      retentionDays,
      lagSeconds,
      regionsRead: i.regions.read.length,
      regionsTotal: i.regions.read.length + i.regions.unread.length,
      lines: i.lines.total,
      records: i.records.length,
      recordsThisAccount: thisAccount.length,
      consoleAssumes: consoleEvents.length,
      failedAssumes,
      matched,
      unverifiable,
      pending,
      truncatedLines: i.lines.truncated.length,
      unreadableLines: i.lines.unreadable.length,
    },
  };
}

// ---- 出力 ----

/** アカウント ID（12 桁）と email を伏せる（jti は所見の時点で先頭 8 文字だけ）。 */
export function redactReconcile(text: string): string {
  return text
    .replace(/(?<!\d)\d{12}(?!\d)/g, "<account>")
    .replace(/[^\s@"'<>,;:()[\]]+@[^\s@"'<>,;:()[\]]+/g, "<email>");
}

const LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARN ", note: "NOTE " };

/** 結果を 1 行ずつの文字列にする（伏せ字済み）。最後に件数の行。 */
export function formatReconcileReport(
  r: ReconcileResult,
  o: { label?: string; apiCount?: number | undefined } = {},
): string {
  const s = r.summary;
  const iso = (t: number) => new Date(t).toISOString();
  const lines = [
    `account: ****${s.accountId.slice(-4)}${o.label !== undefined ? ` ${o.label}` : ""}`,
    `source: ${s.source}${s.source === "api" ? " (Cloudflare Workers Observability telemetry query)" : ""}${o.apiCount !== undefined ? ` api count ${o.apiCount}` : ""}`,
    `window: ${iso(s.window.since)} .. ${iso(s.window.until)} (retention: ${s.retentionDays}d, lag: ${s.lagSeconds}s)`,
    `regions: read ${s.regionsRead}/${s.regionsTotal}`,
    `records: ${s.records} (this account ${s.recordsThisAccount}, lines ${s.lines}), console assumes: ${s.consoleAssumes} (failed ${s.failedAssumes}), matched: ${s.matched}`,
    `unverifiable: ${s.unverifiable}, truncated lines: ${s.truncatedLines}, unreadable lines: ${s.unreadableLines}, pending: ${s.pending}`,
  ];
  const order: Severity[] = ["error", "warning", "note"];
  for (const sev of order)
    for (const f of r.findings.filter((x) => x.severity === sev))
      lines.push(
        [LABEL[sev], f.code, f.jti ?? "-", f.role ?? "-", f.detail ?? ""].join("  ").trimEnd(),
      );
  const n = (sev: Severity) => r.findings.filter((x) => x.severity === sev).length;
  lines.push(`errors: ${n("error")}, warnings: ${n("warning")}`);
  return redactReconcile(lines.join("\n"));
}
