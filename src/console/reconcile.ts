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
//   error   record_read_incomplete    発行記録（API）を、別の経路の件数まで読み切れなかった窓（c2。cto の受け入れ条件 a）
//   error   coverage_gap              前回の確認済みの区間の終わりより、今回の読み始めが後（間に読んでいない区間がある）
//   error   assume_time_gap           対になった引き受けの時刻が、発行の時刻から「JWT の寿命＋時計ずれ」を超えて後、または時計ずれを超えて前
//   error   identity_mismatch         発行記録の利用者と、CloudTrail の SourceIdentity の伏せ字が食い違う（弱い一致: 先頭 1 文字と末尾のドメイン）
//   error   identity_not_compared_admin Administrator の階層（admin）の対で、記録か引き受けのどちらかに利用者が無く、比べられなかった
//   warning jti_reused                同じ jti で 2 回以上引き受けた
//   warning record_without_assume     引き受けがあるはずの記録に、引き受けが無い
//   warning aux_mismatch              補助のキー（AccessKeyId・RequestId・AssumedRoleId の伏せ字）が食い違う
//   warning unverifiable              記録の保持より古く、記録の無い引き受け（件数。決裁 (a)。1 件以上なら終了コードは 1）
//   warning window_exceeds_retention  さかのぼりが記録の保持より長い
//   note    pending                   反映の遅れ（lagSeconds）より新しく、まだ引き受けが見えない記録
//   note    record_sts_failed_no_event STS が失敗した記録で、引き受けのイベントが無い（失敗はイベント履歴に出ないことがある）
//   note    assume_failed             失敗した引き受け（errorCode）の件数
//   note    identity_not_compared     記録か引き受けのどちらかに利用者が無く、SourceIdentity を比べられなかった対の件数（全階層）
//
// 時間の検査と利用者の検査は誤り（cto の決裁 G2-A 条件 c5 の Q1、2026-11-17。前は警告）。当たったら停止スイッチで発行を止め、
// 該当の発行と引き受けを調べ、技術の判断者に上げる（README の突き合わせの節）。
// 所見にしない表示（同じ決裁）: 対の発行からの時間差（秒）の階層ごとの最小・最大・件数（Q1 の記録）、コンソール以外として除外した
// 引き受けの件数（Q2。期待値は手順で確かめる）、Administrator の階層の発行の件数と各時刻（Q4）。
// 「Administrator の階層」は admin の階層（記録の tier・記録のチームの階層・ロールのパス /awsbridge-console/admin/ のどれか。
// P2（B）の設計メモ §9.1: プロバイダーは階層を持たない（Standard と Admin の階層で同じ issuer）ので、プロバイダーで階層を決めない）。
// 突き合わせの入力にはロールごとの区別が無いので、Admin の階層のロールすべて（Administrator のロールに限らない）を含む。

import { ROLE_PATH_PREFIX, rolePath, TIERS, type Tier } from "./constants";
import { TOKEN_TTL_SECONDS } from "./issue/claims";
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
  /** 所見の元になった引き受けか記録の時刻（epoch ミリ秒）。出力の最も古い誤りの行に使う（所見の行には出さない）。 */
  at?: number;
};

export const DEFAULT_LAG_SECONDS = 300;
/** JWT の寿命（秒）。発行から引き受けまでの正規の最長（iat + 300 = exp）。 */
export const JWT_LIFETIME_SECONDS = TOKEN_TTL_SECONDS;
/**
 * 時計ずれの許容（秒）。Worker の時計と CloudTrail の時計の差。既定 60 秒（CloudTrail の eventTime は秒単位、
 * Worker の iat は秒に切り捨て）。② の実測では正規の差がこの範囲に収まり、c5 で誤りに上げた。CLI の --clock-skew-seconds で変えられる。
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
/** Workers Logs の保持（Workers Paid）。② の発行記録の置き場所（cto の決裁）。 */
export const DEFAULT_RETENTION_DAYS = 7;
/** 既定のさかのぼり（保持より短く。決裁 (a)）。 */
export const DEFAULT_LOOKBACK_DAYS = 6;
/**
 * 状態から読み始めを決めるときの重なり（秒）。前回の確認済みの区間の終わりより、これだけ前から読み直す（CloudTrail の反映が
 * 遅れた引き受けを拾う）。反映の遅れ（lag）とは別の値。既定 24 時間・下限 1 時間（推測の値。実測で直す）。CLI の --overlap-seconds。
 */
export const DEFAULT_OVERLAP_SECONDS = 86_400;
export const MIN_OVERLAP_SECONDS = 3_600;

/**
 * 読み始めとその決め方。option は --since、state は「確認済みの区間の終わり − 重なり」、lookback は既定のさかのぼり
 * （状態が無い初回か、終わり − 重なりがさかのぼりより前のとき。後者は coveredUntil を持つ）。
 */
export type ReadStart =
  | { basis: "option"; since: number }
  | { basis: "state"; since: number; coveredUntil: number; overlapSeconds: number }
  | { basis: "lookback"; since: number; lookbackDays: number; coveredUntil?: number };

/**
 * 読み始め = max(今 − さかのぼり, 確認済みの区間の終わり − 重なり)。since（--since）を渡せばそれが勝つ。状態が無ければさかのぼり。
 * 古い区間を含む長い窓の照会が間引かれて（sampleInterval > 1）読み切れなくなるのを避ける緩和策（原因は未確認: 保存の間引きか
 * 照会の間引きかを区別していない）。穴の判定（coverage_gap）は reconcile の側のままで、ここで決めた読み始めは終わり以前なので穴にならない。
 * 重なりが下限（MIN_OVERLAP_SECONDS）より短ければ RangeError（黙って広げない）。
 */
export function decideReadStart(o: {
  now: number;
  since?: number | undefined;
  coveredUntil?: number | undefined;
  overlapSeconds?: number | undefined;
  lookbackDays?: number | undefined;
}): ReadStart {
  const overlapSeconds = o.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  if (!Number.isInteger(overlapSeconds) || overlapSeconds < MIN_OVERLAP_SECONDS)
    throw new RangeError(`the overlap must be at least ${MIN_OVERLAP_SECONDS} seconds`);
  if (o.since !== undefined) return { basis: "option", since: o.since };
  const lookbackDays = o.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const lookback = o.now - lookbackDays * 86_400_000;
  if (o.coveredUntil === undefined) return { basis: "lookback", since: lookback, lookbackDays };
  const fromState = o.coveredUntil - overlapSeconds * 1000;
  return fromState > lookback
    ? { basis: "state", since: fromState, coveredUntil: o.coveredUntil, overlapSeconds }
    : { basis: "lookback", since: lookback, lookbackDays, coveredUntil: o.coveredUntil };
}

/** 読み始めの 1 行（決め方と実際の時刻。UTC）。 */
export function formatReadStart(s: ReadStart): string {
  const iso = (t: number) => new Date(t).toISOString();
  const how =
    s.basis === "option"
      ? "--since"
      : s.basis === "state"
        ? `from the state: confirmed until ${iso(s.coveredUntil)} minus overlap ${s.overlapSeconds}s`
        : s.coveredUntil === undefined
          ? `default lookback ${s.lookbackDays}d; no confirmed interval on record`
          : `default lookback ${s.lookbackDays}d; the confirmed interval ends ${iso(s.coveredUntil)}, the overlap would go back further`;
  return `read start: ${iso(s.since)} (${how})`;
}

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
  /** 設定の issuer（境界ごとに 1 つ。階層で分けない）。 */
  issuers: readonly { url: string }[];
  /** 設定のチーム（名前 → 階層）。記録のチームの階層を、記録の tier とロールのパスの階層と比べる（§9.1）。 */
  teams: readonly { name: string; tier: Tier }[];
  regions: { read: readonly string[]; unread: readonly string[] };
  lines: { truncated: readonly string[]; unreadable: readonly string[]; total: number };
  /** 発行記録の API の読み取りで、件数（別の経路）まで読み切れなかった窓（1 件 1 行の説明）。 */
  incompleteReads?: readonly string[];
  /** 記録をどこから読んだか。 */
  source: "api" | "file";
  lagSeconds?: number;
  retentionDays?: number;
  /** 時計ずれの許容（秒。既定 DEFAULT_CLOCK_SKEW_SECONDS）。 */
  clockSkewSeconds?: number;
  /** 前回の成功した実行の「確認済みの区間の終わり」（epoch ミリ秒）。状態が無い（初回）なら undefined。 */
  previousCoveredUntil?: number;
};

/** 確認済みの区間との関係。first_run は状態が無い初回（穴なしとして扱う）。 */
export type Coverage =
  | { status: "first_run" }
  | { status: "continuous"; previous: number }
  | { status: "gap"; previous: number };

export type ReconcileSummary = {
  source: "api" | "file";
  accountId: string;
  window: { since: number; until: number };
  retentionDays: number;
  lagSeconds: number;
  clockSkewSeconds: number;
  coverage: Coverage;
  /** SourceIdentity を比べた対の数と、比べられなかった対の数（うち Administrator の階層）。 */
  identityCompared: number;
  identityNotCompared: number;
  identityNotComparedAdmin: number;
  /** 対になった（成功した）引き受けの、発行からの時間差（秒）の階層ごとの件数・最小・最大（Q1 の記録用）。 */
  timeFromIssue: Record<Tier, TimeFromIssue>;
  /** コンソール以外として除外した引き受け（AssumeRoleWithWebIdentity）の件数（Q2）。 */
  excludedAssumes: number;
  /** Administrator の階層の発行記録（このアカウント・読んだ期間）の時刻（epoch ミリ秒）と結果。時刻の順（Q4）。 */
  adminIssues: { at: number; result: string }[];
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

export type TimeFromIssue = { count: number; min?: number; max?: number };

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
  const clockSkewSeconds = i.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const retentionCutoff = i.now - retentionDays * 86_400_000;
  const findings: ReconFinding[] = [];
  const add = (f: ReconFinding) => findings.push(f);

  // 設定の issuer（ホスト/パス）とホスト、チーム → 階層
  const configured = new Set(i.issuers.map((x) => providerId(x.url)));
  const consoleHosts = new Set([...configured].map(hostOf));
  const teamTier = new Map(i.teams.map((t) => [t.name, t.tier]));

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
  let identityCompared = 0;
  let identityNotCompared = 0;
  let identityNotComparedAdmin = 0;
  const deltas: Record<Tier, number[]> = { standard: [], admin: [] };
  const when = (t: number) => new Date(t).toISOString();

  // ---- 引き受けの側 ----
  for (const e of consoleEvents) {
    const role = roleParts(e.roleArn);
    const base = {
      ...(e.tokenId !== undefined ? { jti: maskJti(e.tokenId) } : {}),
      ...(role !== undefined ? { role: role.name } : {}),
      at: e.time,
    };
    const at = `${e.region} ${when(e.time)}`;
    const roleTier = pathTier(role?.path);

    // プロバイダー: 設定に無ければ誤り（同じホストの別のパスも別の IAM のプロバイダー）。プロバイダーは階層を持たない
    const pid = e.provider !== undefined ? providerId(e.provider) : undefined;
    if (pid === undefined || !configured.has(pid))
      add({
        severity: "error",
        code: "provider_not_in_config",
        ...base,
        detail: `${at} provider=${pid ?? "-"}`,
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
    // 時間: 引き受けの時刻 − 発行の時刻（iat。無い記録は記録の時刻 at。at は STS の応答のあとに書くので、前向きの差は少し小さく出る）。
    // 後ろに寿命＋ずれを超える（JWT の寿命の外での引き受け、同じ jti の使い回し）か、前にずれを超える（発行の前の引き受け。
    // 時計の異常か、作られた JWT に記録を合わせた形）なら、向きを detail に出す同じ所見にする。どちらも誤り（c5 の Q1）。
    // 記録のチームの階層（設定に無いチームは記録の側で team_not_in_config）: 記録の tier・ロールのパスの階層と違えば誤り
    const recTeamTier = teamTier.get(r.team);
    if (
      recTeamTier !== undefined &&
      (recTeamTier !== r.tier || (roleTier !== undefined && recTeamTier !== roleTier))
    )
      add({
        severity: "error",
        code: "team_tier_mismatch",
        ...base,
        detail: `${at} team=${recTeamTier} record=${r.tier} role=${roleTier ?? "-"} (${r.pos})`,
      });
    // 対の階層: 記録の tier・記録のチームの階層・ロールのパスのどれかが admin なら admin（食い違いで Admin の比べ漏れを隠さない）
    const pairTier: Tier =
      r.tier === "admin" || recTeamTier === "admin" || roleTier === "admin" ? "admin" : "standard";
    const issuedAt = r.iat !== undefined ? r.iat * 1000 : r.at;
    const deltaSeconds = Math.round((e.time - issuedAt) / 1000);
    deltas[pairTier].push(deltaSeconds);
    if (deltaSeconds > JWT_LIFETIME_SECONDS + clockSkewSeconds || deltaSeconds < -clockSkewSeconds)
      add({
        severity: "error",
        code: "assume_time_gap",
        ...base,
        detail: `${at} ${deltaSeconds > 0 ? "+" : ""}${deltaSeconds}s from issue (allowed -${clockSkewSeconds}s..+${JWT_LIFETIME_SECONDS + clockSkewSeconds}s) (${r.pos})`,
      });
    // 利用者: 記録の伏せ字と CloudTrail の SourceIdentity の伏せ字。両方あるときだけ比べる（弱い一致: 先頭 1 文字と末尾のドメイン）
    if (r.identity !== undefined && e.sourceIdentity !== undefined) {
      identityCompared++;
      if (r.identity !== e.sourceIdentity)
        add({
          severity: "error",
          code: "identity_mismatch",
          ...base,
          detail: `${at} the record's user and the event's SourceIdentity differ (masked) (${r.pos})`,
        });
    } else {
      identityNotCompared++;
      // Administrator の階層は比べられないこと自体を誤りにする（c5 の Q1）
      if (pairTier === "admin") {
        identityNotComparedAdmin++;
        add({
          severity: "error",
          code: "identity_not_compared_admin",
          ...base,
          detail: `${at} no user on the record or no SourceIdentity on the event (${r.pos})`,
        });
      }
    }
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
  if (identityNotCompared > 0)
    add({
      severity: "note",
      code: "identity_not_compared",
      detail: `${identityNotCompared} matched pairs without the user on the record or the SourceIdentity on the event`,
    });
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
  // 設定に無いチームの記録（このアカウント・読んだ期間。引き受けの有無によらない）
  for (const r of thisAccount)
    if (r.at >= i.window.since && r.at <= i.window.until && !teamTier.has(r.team))
      add({
        severity: "error",
        code: "team_not_in_config",
        ...(r.jti !== undefined ? { jti: maskJti(r.jti) } : {}),
        detail: `${when(r.at)} (${r.pos})`,
        at: r.at,
      });
  let pending = 0;
  for (const r of thisAccount) {
    if (r.jti === undefined) continue;
    if (r.at < i.window.since || r.at > i.window.until) continue;
    if (unread.has(r.stsRegion)) continue; // region_unread の誤りで知らせる
    if (eventsByJti.has(r.jti)) continue;
    const base = {
      jti: maskJti(r.jti),
      detail: `${r.stsRegion} ${when(r.at)} (${r.pos})`,
      at: r.at,
    };
    if (r.at > i.now - lagSeconds * 1000) {
      pending++;
      add({ severity: "note", code: "pending", ...base });
    } else if (expectsAssume(r))
      add({ severity: "warning", code: "record_without_assume", ...base });
    else add({ severity: "note", code: "record_sts_failed_no_event", ...base });
  }

  // Administrator の階層の発行（Q4）: このアカウント・読んだ期間の admin の記録。結果も出す（失敗した発行も数える）
  const adminIssues = thisAccount
    .filter((r) => r.tier === "admin" && r.at >= i.window.since && r.at <= i.window.until)
    .map((r) => ({ at: r.at, result: r.result }))
    .sort((a, b) => a.at - b.at);

  // ---- 入力の欠け ----
  for (const region of i.regions.unread)
    add({ severity: "error", code: "region_unread", detail: region });
  for (const pos of i.lines.truncated)
    add({ severity: "error", code: "record_line_truncated", detail: pos });
  for (const pos of i.lines.unreadable)
    add({ severity: "error", code: "record_line_unreadable", detail: pos });
  for (const w of i.incompleteReads ?? [])
    add({ severity: "error", code: "record_read_incomplete", detail: w });
  // 確認済みの区間: 前回の終わりより今回の読み始めが後なら、間の区間はどの実行も確かめていない（誤り）。状態が無い初回は穴なし
  const coverage: Coverage =
    i.previousCoveredUntil === undefined
      ? { status: "first_run" }
      : i.window.since > i.previousCoveredUntil
        ? { status: "gap", previous: i.previousCoveredUntil }
        : { status: "continuous", previous: i.previousCoveredUntil };
  if (coverage.status === "gap")
    add({
      severity: "error",
      code: "coverage_gap",
      detail: `the previous confirmed interval ends ${when(coverage.previous)} but this run starts ${when(i.window.since)} (${Math.round((i.window.since - coverage.previous) / 3_600_000)}h not read)`,
    });
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
      clockSkewSeconds,
      coverage,
      identityCompared,
      identityNotCompared,
      identityNotComparedAdmin,
      timeFromIssue: { standard: summarize(deltas.standard), admin: summarize(deltas.admin) },
      excludedAssumes: i.events.length - consoleEvents.length,
      adminIssues,
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

function summarize(list: readonly number[]): TimeFromIssue {
  return list.length === 0
    ? { count: 0 }
    : { count: list.length, min: Math.min(...list), max: Math.max(...list) };
}

/**
 * 終了コード: 1 は誤りがあるか、検証できない引き受け（unverifiable）が 1 件以上あるとき。それ以外は 0（実行できないときの 2 は CLI）。
 * 検証できない引き受けは所見の区分では警告のままだが、「誤り 0 にもしない」（cto の決裁 (a)）ので 0 で終わらせない（司令塔の判断 2026-11-13）。
 */
export function reconcileExitCode(r: ReconcileResult): 0 | 1 {
  return r.findings.some((f) => f.severity === "error") || r.summary.unverifiable > 0 ? 1 : 0;
}

/**
 * 時刻を持つ誤り（引き受けか記録の時刻のあるもの）のうち最も古い時刻。無ければ undefined。
 * 検出した誤りは状態に残らない（状態は進めないだけ）ので、この時刻が既定の窓（今 − 6 日）から外れると、次の実行では読まれない
 * （--overlap-seconds や --since を変えても外れうる）。その前に所見を道具の外に記録させるために出す。
 */
export function oldestErrorAt(r: ReconcileResult): number | undefined {
  const times = r.findings
    .filter((f) => f.severity === "error" && f.at !== undefined)
    .map((f) => f.at as number);
  return times.length === 0 ? undefined : Math.min(...times);
}

/**
 * 成功した実行（終了コード 0）が進める「確認済みの区間の終わり」。成功でなければ undefined（進めない）。
 * 終わりは「今回の終わり − 反映の遅れ（lag）」: 最後の lag の間は CloudTrail の反映が間に合わず、まだ判定していない（pending）。
 * 前回が先なら戻さない。誤りがある実行や検証できない引き受けがある実行で進めると、誤りが次の実行の区間の外に出て埋もれるので進めない
 * （穴の誤りが出た実行も、誤りなので進めない。直すには、読み始めを前回の終わり以前に戻して回す）。
 * 保証はその実行で読んだ窓の中だけ: 検出した誤りは状態に残らず、時刻が窓の外へ出れば次の実行で読まれず進む（oldestErrorAt）。
 */
export function nextCoveredUntil(
  r: ReconcileResult,
  previous: number | undefined,
): number | undefined {
  if (reconcileExitCode(r) !== 0) return undefined;
  const settled = r.summary.window.until - r.summary.lagSeconds * 1000;
  return previous === undefined ? settled : Math.max(previous, settled);
}

// ---- 出力 ----

/** アカウント ID（12 桁）と email を伏せる（jti は所見の時点で先頭 8 文字だけ）。 */
export function redactReconcile(text: string): string {
  return text
    .replace(/(?<!\d)\d{12}(?!\d)/g, "<account>")
    .replace(/[^\s@"'<>,;:()[\]]+@[^\s@"'<>,;:()[\]]+/g, "<email>");
}

const LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARN ", note: "NOTE " };

function coverageLine(c: Coverage): string {
  const iso = (t: number) => new Date(t).toISOString();
  if (c.status === "first_run")
    return "coverage: first run (no confirmed interval on record; treated as no gap)";
  if (c.status === "continuous")
    return `coverage: continuous (the previous confirmed interval ends ${iso(c.previous)})`;
  return `coverage: GAP (the previous confirmed interval ends ${iso(c.previous)}; this run starts later)`;
}

const timeFromIssueText = (t: TimeFromIssue) =>
  t.count === 0 ? "n=0" : `n=${t.count} min ${t.min}s max ${t.max}s`;

/** 結果を 1 行ずつの文字列にする（伏せ字済み）。最後に件数の行。 */
export function formatReconcileReport(
  r: ReconcileResult,
  o: { label?: string; apiCount?: number | undefined; start?: ReadStart | undefined } = {},
): string {
  const s = r.summary;
  const iso = (t: number) => new Date(t).toISOString();
  const lines = [
    `account: ****${s.accountId.slice(-4)}${o.label !== undefined ? ` ${o.label}` : ""}`,
    `source: ${s.source}${s.source === "api" ? " (Cloudflare Workers Observability telemetry query)" : ""}${o.apiCount !== undefined ? ` api count ${o.apiCount}` : ""}`,
    `window: ${iso(s.window.since)} .. ${iso(s.window.until)} (retention: ${s.retentionDays}d, lag: ${s.lagSeconds}s)`,
    ...(o.start !== undefined ? [formatReadStart(o.start)] : []),
    `regions: read ${s.regionsRead}/${s.regionsTotal}`,
    `records: ${s.records} (this account ${s.recordsThisAccount}, lines ${s.lines}), console assumes: ${s.consoleAssumes} (failed ${s.failedAssumes}), matched: ${s.matched}`,
    `unverifiable: ${s.unverifiable}, truncated lines: ${s.truncatedLines}, unreadable lines: ${s.unreadableLines}, pending: ${s.pending}`,
    `time check: lifetime ${JWT_LIFETIME_SECONDS}s + clock skew ${s.clockSkewSeconds}s (error)`,
    `time from issue: ${TIERS.map((t) => `${t} ${timeFromIssueText(s.timeFromIssue[t])}`).join(", ")}`,
    `identity: compared ${s.identityCompared}, not compared ${s.identityNotCompared} (admin ${s.identityNotComparedAdmin})`,
    `excluded assumes (not console): ${s.excludedAssumes}`,
    `admin issues: ${s.adminIssues.length}${s.adminIssues.length > 0 ? ` (${s.adminIssues.map((x) => `${iso(x.at)} ${x.result}`).join(", ")})` : ""}`,
    coverageLine(s.coverage),
  ];
  const oldest = oldestErrorAt(r);
  if (oldest !== undefined)
    lines.push(
      `oldest error finding: ${iso(oldest)} (it leaves the default window of ${DEFAULT_LOOKBACK_DAYS}d after ${iso(oldest + DEFAULT_LOOKBACK_DAYS * 86_400_000)}; record the findings outside the tool today)`,
    );
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
