// 突き合わせの道具の発行記録の読み取り（Cloudflare の API）: Workers Logs の照会だけを呼ぶ。
//   POST {base}/accounts/{account_id}/workers/observability/telemetry/query（cto の決裁 (d)(e)）
// ここは Cloudflare の API の形の前提を 1 か所にまとめたファイル。形は Cloudflare の API の仕様（OpenAPI）と実物の応答（2026-11-16）で確かめた。
// 前提にしていること:
//   - 本文: queryId（必須）・timeframe { from, to }（epoch ミリ秒。必須）・view・limit（最大 2000）
//           parameters.filters（$workers.scriptName の eq を or でつなぐ）・offset（前のページの最後の $metadata.id）・offsetDirection "next"
//   - events の view の応答: { success: true, result: { events: { events: [...], count }, statistics: { abr_level? } } }。
//           events[] は $metadata.id・$workers.scriptName・$workers.truncated・source（構造化済みのオブジェクトか文字列）を持つ
//           （読み方は src/console/reconcile-input.ts）
//   - calculations の view（parameters.calculations [{ operator: "count" }]）の応答:
//           { result: { calculations: [{ aggregates: [{ count, sampleInterval }] }], statistics: { abr_level? } } }
//   - 切られた印: 仕様は $workers.truncated、文書は $cloudflare.truncated。どちらも見る
//
// 読み落とし（c2。2026-11-16 に実物で確かめた。cto の受け入れ条件 a・d）:
//   - 原因: events の view は、読む量が多い照会（長い窓）で読み取りの時点の間引き（Adaptive Bit Rate。statistics.abr_level）を使う。
//     6 日の窓（standard＋admin）は abr_level 10 で 614 行を返し（statistics.rows_read は約 438 万。一致する行 6460 よりずっと多いので、
//     他の Worker のログも走査していると見る [推測]）、limit（2000）より少ないのでページ送りも終わる。
//     同じ窓の calculations の count は abr_level 1・sampleInterval 1 で 6460。1 日の窓でも行の多い日は abr_level 10（491 行 / count 5084）。
//     2 時間の窓はほぼ abr_level 1 で count と一致したが、admin だけの 2 時間の敷き詰め（73 窓）で 1 窓だけ abr_level > 1 が出た
//     （行数は count と一致。events と calculations のどちらだったかは未確認）。窓の長さでは間引かれないことを保証できない。
//     対象の Worker を増やすと行が減ったのも、走査する量や負荷で間引きの段が変わるため [推測]（段の決め方は文書に無い）。
//   - 一次情報: API の仕様（https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/）
//     statistics.abr_level「The level of Adaptive Bit Rate (ABR) sampling used for the query. If empty the ABR level is 1」、
//     calculations の count「Estimated number of matching events: the sum of the sample intervals of the stored events.
//     It equals the number of stored events when sampleInterval is 1」。sampleInterval は保存された行の間引きの倍率として説明され、
//     abr_level とは別。2026-11-19 に、古い区間を含む照会で sampleInterval > 1 を見た（窓全体に掛かっていた）。それが保存の時点の間引きか
//     照会の時点の間引きかは未確認（短い窓に割ると 1 に戻るかは実測で確かめる）。ABR の説明: https://developers.cloudflare.com/analytics/faq/graphql-api-inconsistent-results/
//   - events.count: 仕様は「Total number of events matching the query (may exceed the number returned due to limits)」だが、
//     実物は返したページの行数だった（limit 100 で 100/100/…/79、間引かれた 6 日の窓で 614）。全件の数としては使えない
//   - $metadata.id は一意でない（同じミリ秒の別の行が同じ id を持つ例を 2 時間の窓で 4 件見た）。重複を消さず、行数で比べる
//   - offset: 仕様は「Pass the $metadata.id of the last event ... to fetch the next page」だけで、同じ id の行が複数あるときに
//     どこから続けるか（最初の一致の次か、同じ id をまとめて飛ばすか）は書かれていない [未確認]。取りこぼし・取り直しのどちらも起きうるとみなす
//   - timeframe の両端は含まれない（from < 時刻 < to。実物で確かめた。文書には無い）。割るときは (from, mid+1) と (mid, to) にする
//   - 同じ照会の count が 1 回だけ違う値（290。前後は 286）を返したことがある。原因は未確認。合わなければ数え直す・割る
// 直し方: 窓ごとに calculations の count（abr_level 1・sampleInterval 1 のときだけ信用する）を先に得て、events の行数が
//   その数に届くまで窓を半分に割って読む。件数が limit を超える窓もページ送りより先に割る（カーソルの id が一意でないため）。
//   件数が limit 以下でもページが満杯（数えたあとに行が増えた）なら、割れる窓ではページ送りせずに割る。
//   ページ送りは割れない窓（最小の幅）だけ。そこでは、前のページに出た id が後のページに再び出たら incomplete（cursor ambiguous）にし、
//   2 ページ以上読んだときは読み終えたあとに数え直して、行数がその数にも届くことを求める（同じ id の行をまとめて飛ばされ、
//   あとから入った行がその欠けを埋めた場合を見逃さないため）。
//   件数の間引き（sampleInterval > 1。保存の時点か照会の時点かは未確認）は件数が 0 でも信用しない（早期に終えず incomplete）。
//   最小の幅（既定 1 分）まで割っても届かなければ、その窓を incomplete に入れて返す（CLI が誤り record_read_incomplete にし、終了コード 1）。
//   行数が count を超えるのは、count のあとに取り込まれた行（今に近い窓）として受け入れる（読み落としではない）。
// トークン: 仕様では telemetry/query は「Workers Observability Write」しか受け付けない。読み取りだけ（Read）で通るかは ② で確かめる。
// トークンは戻り値・例外の文に入れない。宛先の上書きは手元（127.0.0.1）の試験用だけ（key-tool-common.ts の apiBaseFromVar）。
import { cfApi, cfErrors } from "./key-tool-common";

export const TELEMETRY_PAGE_LIMIT = 2000;
const MAX_PAGES = 500;
/** 割る窓の最小の幅（既定）。これより狭い窓は割らずに読み直す。 */
export const MIN_WINDOW_MS = 60_000;
/** 1 回の実行で呼ぶ照会の上限（暴走の止め。Cloudflare API の全体の上限 1200 回 / 5 分より少なくした [推測: 上限の値はこの作業では確かめていない]）。 */
const MAX_REQUESTS = 1000;
const QUERY_ID = "awsbridge-console-reconcile";

export const telemetryQueryPath = (accountId: string) =>
  `/accounts/${accountId}/workers/observability/telemetry/query`;

const workerFilters = (workers: readonly string[]) => ({
  filterCombination: "or",
  filters: workers.map((w) => ({
    key: "$workers.scriptName",
    operation: "eq",
    type: "string",
    value: w,
  })),
});

export function telemetryQueryBody(o: {
  from: number;
  to: number;
  workers: readonly string[];
  offset?: string;
  limit?: number;
}): Record<string, unknown> {
  return {
    queryId: QUERY_ID,
    view: "events",
    timeframe: { from: o.from, to: o.to },
    limit: o.limit ?? TELEMETRY_PAGE_LIMIT,
    parameters: workerFilters(o.workers),
    ...(o.offset !== undefined ? { offset: o.offset, offsetDirection: "next" } : {}),
  };
}

/** 件数の照会（calculations の view の count。events と同じ絞り込み）。 */
export function telemetryCountBody(o: {
  from: number;
  to: number;
  workers: readonly string[];
}): Record<string, unknown> {
  return {
    queryId: QUERY_ID,
    view: "calculations",
    timeframe: { from: o.from, to: o.to },
    parameters: {
      ...workerFilters(o.workers),
      calculations: [{ operator: "count", alias: "n" }],
    },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** statistics.abr_level（無ければ 1。仕様「If empty the ABR level is 1」）。 */
function abrOf(result: Obj | undefined): number {
  const st = isObj(result?.statistics) ? result.statistics : undefined;
  const v = st?.abr_level;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
}

function resultOf(json: unknown): Obj {
  if (!isObj(json) || json.success !== true) throw new Error("telemetry query: not successful");
  if (!isObj(json.result)) throw new Error("telemetry query: unexpected response");
  return json.result;
}

/** events の view の 1 ページ（形が違えば例外）。 */
function pageOf(json: unknown): { events: unknown[]; abr: number } {
  const result = resultOf(json);
  const ev = isObj(result.events) ? result.events : undefined;
  if (!ev || !Array.isArray(ev.events)) throw new Error("telemetry query: unexpected response");
  return { events: ev.events, abr: abrOf(result) };
}

/** calculations の view の count（形が違えば例外）。aggregates が空なら 0。 */
function countOf(json: unknown): { count: number; sampleInterval: number; abr: number } {
  const result = resultOf(json);
  const calcs = result.calculations;
  if (!Array.isArray(calcs) || !isObj(calcs[0]) || !Array.isArray(calcs[0].aggregates))
    throw new Error("telemetry query: unexpected count response");
  const agg = calcs[0].aggregates[0];
  if (agg === undefined) return { count: 0, sampleInterval: 1, abr: abrOf(result) };
  const count = isObj(agg) ? agg.count : undefined;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
    throw new Error("telemetry query: unexpected count response");
  // 実物で見たのは count > 0 で sampleInterval 1 だけ（2026-11-16）。[未確認] count 0 のときの値と、欠けたときの意味。
  // 0 や欠落は間引きなし（1）とみなす（試験の偽の応答は count 0 で 0 を返す）。
  const si = isObj(agg) && typeof agg.sampleInterval === "number" ? agg.sampleInterval : 1;
  return { count, sampleInterval: si, abr: abrOf(result) };
}

const idOf = (event: unknown): string | undefined => {
  const md = isObj(event) && isObj(event.$metadata) ? event.$metadata : undefined;
  return typeof md?.id === "string" && md.id !== "" ? md.id : undefined;
};
const lastId = (events: unknown[]): string | undefined => idOf(events[events.length - 1]);

export type IssueLogQuery = {
  base: string;
  /** Cloudflare のアカウント ID（32 桁の 16 進）。 */
  accountId: string;
  token: string;
  workers: readonly string[];
  /** epoch ミリ秒。 */
  from: number;
  to: number;
  /** 試験用。既定 2000。 */
  pageLimit?: number;
  /** 試験用。割る窓の最小の幅（既定 MIN_WINDOW_MS）。 */
  minWindowMs?: number;
  /** 試験用。照会の回数の上限（既定 1000）。 */
  maxRequests?: number;
};

/** 件数（別の経路）まで読めなかった窓。 */
export type IncompleteRead = {
  /** timeframe（epoch ミリ秒。両端は含まない）。 */
  from: number;
  to: number;
  /** 件数の経路（calculations の count）の数。 */
  expected: number;
  /** events の view で読んだ行数。 */
  read: number;
  reason: string;
};

/** 誤り record_read_incomplete の detail（伏せる値は入らない）。 */
export const formatIncompleteRead = (x: IncompleteRead): string =>
  `${new Date(x.from).toISOString()}..${new Date(x.to).toISOString()} read ${x.read} of ${x.expected} (${x.reason})`;

export type IssueLogRead = {
  events: unknown[];
  /** 件数の経路で数えた行の合計（読んだ窓の count の和）。 */
  count: number;
  /** events の view のページ数。 */
  pages: number;
  /** 行を読んだ窓の数。 */
  windows: number;
  /** 照会の回数（件数と行の両方）。 */
  requests: number;
  incomplete: IncompleteRead[];
};

type Count = { count: number; sampleInterval: number; abr: number };

/**
 * 期間の Worker のイベントをすべて読む。窓ごとに件数（calculations の count）を先に得て、events の行数がそれに届くまで
 * 窓を半分に割る（読み取りの時点の間引き abr_level > 1 を避ける）。読み切れない窓は incomplete に入れて返す（例外にしない）。
 * API の失敗・形の違い・照会の回数の超過は例外（空の読み取りとして扱わない）。
 */
export async function queryIssueLogs(
  d: { fetch: typeof fetch },
  q: IssueLogQuery,
): Promise<IssueLogRead> {
  const limit = q.pageLimit ?? TELEMETRY_PAGE_LIMIT;
  const minWindow = q.minWindowMs ?? MIN_WINDOW_MS;
  const maxRequests = q.maxRequests ?? MAX_REQUESTS;
  const url = `${q.base}${telemetryQueryPath(q.accountId)}`;
  const out: IssueLogRead = {
    events: [],
    count: 0,
    pages: 0,
    windows: 0,
    requests: 0,
    incomplete: [],
  };

  const call = async (body: Record<string, unknown>): Promise<unknown> => {
    if (++out.requests > maxRequests)
      throw new Error(`telemetry query: more than ${maxRequests} requests`);
    const res = await cfApi(d, q.token, "POST", url, body);
    if (res.status !== 200)
      throw new Error(`telemetry query failed (HTTP ${res.status}): ${cfErrors(res.json)}`);
    return res.json;
  };
  const countWindow = async (from: number, to: number): Promise<Count> =>
    countOf(await call(telemetryCountBody({ from, to, workers: q.workers })));
  /**
   * events の view を最後まで読む。abr は読んだページの最大。
   * paging が false なら満杯のページで止めて full を返す（呼び手が窓を割る）。
   * paging が true なら最後の $metadata.id でページ送りし、前のページに出た id が再び出たら ambiguous を返して止める。
   */
  const readEvents = async (
    from: number,
    to: number,
    paging: boolean,
  ): Promise<{
    rows: unknown[];
    abr: number;
    pages: number;
    full: boolean;
    ambiguous: boolean;
  }> => {
    const rows: unknown[] = [];
    const seenIds = new Set<string>();
    let abr = 1;
    let offset: string | undefined;
    for (let pages = 1; pages <= MAX_PAGES; pages++) {
      const body = telemetryQueryBody({
        from,
        to,
        workers: q.workers,
        limit,
        ...(offset !== undefined ? { offset } : {}),
      });
      const p = pageOf(await call(body));
      out.pages++;
      abr = Math.max(abr, p.abr);
      const ids = p.events.map(idOf).filter((id): id is string => id !== undefined);
      const ambiguous = ids.some((id) => seenIds.has(id));
      rows.push(...p.events);
      if (p.events.length < limit) return { rows, abr, pages, full: false, ambiguous };
      if (!paging) return { rows, abr, pages, full: true, ambiguous: false };
      const next = lastId(p.events);
      if (next === undefined || next === offset)
        throw new Error("telemetry query: the page cursor did not advance");
      if (ambiguous) return { rows, abr, pages, full: false, ambiguous };
      for (const id of ids) seenIds.add(id);
      offset = next;
    }
    throw new Error(`telemetry query: more than ${MAX_PAGES} pages`);
  };
  // 幅 2 以下は割っても狭くならない（(from, mid+1) が元と同じ）
  const canSplit = (from: number, to: number) => to - from > Math.max(minWindow, 2);
  const trusted = (c: Count) => c.abr <= 1;
  // 件数が 0 でも sampleInterval > 1 なら信用しない（早期に終えず incomplete にする）
  const intervalSampled = (c: Count) => c.sampleInterval > 1;
  const reliable = (c: Count) => trusted(c) && !intervalSampled(c);

  const readWindow = async (from: number, to: number, given?: Count): Promise<void> => {
    let c = given ?? (await countWindow(from, to));
    if (c.count === 0 && reliable(c)) return;
    const split = canSplit(from, to);
    if (!intervalSampled(c) && split && (!trusted(c) || c.count > limit)) {
      await splitWindow(from, to, c);
      return;
    }
    let last = { rows: [] as unknown[], abr: 1, pages: 0, full: false, ambiguous: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) c = await countWindow(from, to);
      // 割れる窓ではページ送りしない（満杯なら割る）。offset の id が一意でないため
      last = await readEvents(from, to, !split);
      if (last.full) {
        await splitWindow(from, to, c);
        return;
      }
      if (last.ambiguous) break; // id は変わらないので読み直しても同じ
      let enough = reliable(c) && last.rows.length >= c.count;
      if (enough && last.pages > 1) {
        // ページ送りの取りこぼしを、あとから入った行が埋めていないか（読み終えたあとの件数にも届くか）
        const after = await countWindow(from, to);
        if (after.count > c.count || !reliable(after)) c = after;
        enough = reliable(c) && last.rows.length >= c.count;
      }
      if (last.abr <= 1 && enough) {
        out.events.push(...last.rows);
        out.count += c.count;
        out.windows++;
        return;
      }
      // sampleInterval > 1 は、今は割らず読み直さずに incomplete にする（保存か照会かは未確認。割って戻るかは実測で確かめる）
      if (intervalSampled(c)) break;
      if (split) {
        await splitWindow(from, to, c);
        return;
      }
    }
    const reason = intervalSampled(c)
      ? `sampleInterval ${c.sampleInterval} (sampled at storage or at query; not confirmed)`
      : !trusted(c)
        ? `count sampled (abr_level ${c.abr})`
        : last.abr > 1
          ? `events sampled (abr_level ${last.abr})`
          : last.ambiguous
            ? "page cursor ambiguous (a $metadata.id repeated across pages)"
            : "short";
    out.events.push(...last.rows);
    out.count += c.count;
    out.windows++;
    out.incomplete.push({ from, to, expected: c.count, read: last.rows.length, reason });
  };

  // timeframe の両端は含まれないので、(from, mid+1) と (mid, to) に割ると mid の行はどちらか一方（左）だけに入る
  const splitWindow = async (from: number, to: number, parent: Count): Promise<void> => {
    const mid = Math.floor((from + to) / 2);
    const left = await countWindow(from, mid + 1);
    const right = await countWindow(mid, to);
    if (
      trusted(parent) &&
      trusted(left) &&
      trusted(right) &&
      left.count + right.count < parent.count
    ) {
      // 数え直して、それでも割った側の和が少なければ、境目の前提（両端を含まない）が崩れている
      const again = await countWindow(from, to);
      if (trusted(again) && left.count + right.count < again.count)
        out.incomplete.push({
          from,
          to,
          expected: again.count,
          read: left.count + right.count,
          reason: "split lost rows",
        });
    }
    await readWindow(from, mid + 1, left);
    await readWindow(mid, to, right);
  };

  await readWindow(q.from, q.to);
  return out;
}
