// G2 の時間差の集計（poc:g2:time-gap）の純粋関数。手順書 §3.2 の 6（ii-2）。I/O は scripts/poc/g2/time-gap.ts。
// 発行記録（console:reconcile の --records と同じ形。src/console/reconcile-input.ts で読む）と、CloudTrail の
// AssumeRoleWithWebIdentity（同じく parseAssumeEvent）を jti（= requestParameters.webIdentityTokenId）で結び、
// 差（eventTime − jwt.iat。秒）の分布を出す。console:reconcile の時間の検査（assume_time_gap）のしきい値を決め直す材料。
// 出力に jti・アカウント ID・email を出さない（件数と秒数だけ）。
import type { AssumeEvent, ReconRecord } from "../../../src/console/reconcile-input";
import { markdownTable } from "../human/cases";

export interface Distribution {
  count: number;
  min: number;
  median: number;
  p90: number;
  max: number;
}

/** 件数・最小・中央値（偶数は真ん中の 2 つの平均）・p90（最近順位法: 小さい順で ⌈0.9n⌉ 番目）・最大。空は undefined。 */
export function distribution(values: readonly number[]): Distribution | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const at = (i: number) => s[i] as number;
  const median = n % 2 === 1 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
  return { count: n, min: at(0), median, p90: at(Math.ceil(0.9 * n) - 1), max: at(n - 1) };
}

export interface GapCounts {
  /** 突き合わせに使った発行記録（成功・jti と iat あり・jti の重複を除く） */
  records: number;
  /** 突き合わせに使った引き受け（エラーなし・jti あり） */
  events: number;
  matched: number;
  recordsWithoutEvent: number;
  eventsWithoutRecord: number;
  /** 同じ jti の 2 つ目以降の引き受け（差は最初の引き受けで測る） */
  duplicateEvents: number;
  duplicateRecords: number;
  recordsNotOk: number;
  recordsWithoutIat: number;
  recordsWithoutJti: number;
  failedEvents: number;
  eventsWithoutTokenId: number;
}

export interface GapResult {
  matched: { tier: string; gapSeconds: number }[];
  counts: GapCounts;
}

export function pairGaps(
  records: readonly ReconRecord[],
  events: readonly AssumeEvent[],
): GapResult {
  const counts: GapCounts = {
    records: 0,
    events: 0,
    matched: 0,
    recordsWithoutEvent: 0,
    eventsWithoutRecord: 0,
    duplicateEvents: 0,
    duplicateRecords: 0,
    recordsNotOk: 0,
    recordsWithoutIat: 0,
    recordsWithoutJti: 0,
    failedEvents: 0,
    eventsWithoutTokenId: 0,
  };
  const byJti = new Map<string, ReconRecord>();
  for (const r of records) {
    if (r.result !== "ok") counts.recordsNotOk++;
    else if (r.jti === undefined) counts.recordsWithoutJti++;
    else if (r.iat === undefined) counts.recordsWithoutIat++;
    else if (byJti.has(r.jti)) counts.duplicateRecords++;
    else byJti.set(r.jti, r);
  }
  counts.records = byJti.size;
  const eventsByJti = new Map<string, AssumeEvent[]>();
  for (const e of events) {
    if (e.errorCode !== undefined) counts.failedEvents++;
    else if (e.tokenId === undefined) counts.eventsWithoutTokenId++;
    else {
      counts.events++;
      const list = eventsByJti.get(e.tokenId) ?? [];
      list.push(e);
      eventsByJti.set(e.tokenId, list);
    }
  }
  const matched: GapResult["matched"] = [];
  for (const [jti, r] of byJti) {
    const list = eventsByJti.get(jti);
    if (list === undefined) {
      counts.recordsWithoutEvent++;
      continue;
    }
    const first = [...list].sort((a, b) => a.time - b.time)[0] as AssumeEvent;
    counts.duplicateEvents += list.length - 1;
    matched.push({
      tier: String(r.tier),
      gapSeconds: (first.time - (r.iat as number) * 1000) / 1000,
    });
  }
  for (const jti of eventsByJti.keys()) if (!byJti.has(jti)) counts.eventsWithoutRecord++;
  counts.matched = matched.length;
  return { matched, counts };
}

export function formatTimeGap(r: GapResult): string {
  const c = r.counts;
  const lines = [
    `records: ${c.records}（成功でない ${c.recordsNotOk}・jti なし ${c.recordsWithoutJti}・iat なし ${c.recordsWithoutIat}・jti の重複 ${c.duplicateRecords} は除いた）`,
    `events: ${c.events}（失敗 ${c.failedEvents}・jti なし ${c.eventsWithoutTokenId} は除いた）`,
    `matched: ${c.matched} / records without event: ${c.recordsWithoutEvent} / events without record: ${c.eventsWithoutRecord} / duplicate events: ${c.duplicateEvents}`,
    "",
  ];
  const all = distribution(r.matched.map((m) => m.gapSeconds));
  if (all === undefined) {
    lines.push("対になった発行がないので、分布は出せない");
    return lines.join("\n");
  }
  const tiers = [...new Set(r.matched.map((m) => m.tier))];
  const rows: [string, Distribution][] = [["all", all]];
  for (const t of tiers)
    rows.push([
      t,
      distribution(r.matched.filter((m) => m.tier === t).map((m) => m.gapSeconds)) as Distribution,
    ]);
  lines.push(
    "差 = CloudTrail の eventTime − 発行の jwt.iat（秒）。中央値は偶数なら真ん中の 2 つの平均、p90 は最近順位法",
  );
  lines.push(
    markdownTable(
      ["階層", "件数", "最小", "中央値", "p90", "最大"],
      rows.map(([t, d]) => [
        t,
        String(d.count),
        String(d.min),
        String(d.median),
        String(d.p90),
        String(d.max),
      ]),
    ),
  );
  return lines.join("\n");
}
