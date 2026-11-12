// 突き合わせの道具の発行記録の読み取り（Cloudflare の API）: Workers Logs の照会だけを呼ぶ。
//   POST {base}/accounts/{account_id}/workers/observability/telemetry/query（cto の決裁 (d)(e)）
// ここは Cloudflare の API の形の前提を 1 か所にまとめたファイル。形は Cloudflare の API の仕様（OpenAPI）から作った [推測]。
// ② の最初に実物の応答で確かめ、フィクスチャ（test/unit/console-reconcile-read.test.ts・test/e2e/console-reconcile-cli.test.ts）を取り直す。
// 前提にしていること:
//   - 本文: queryId（必須）・timeframe { from, to }（epoch ミリ秒。必須）・view "events"・limit（最大 2000）
//           parameters.filters（$workers.scriptName の eq を or でつなぐ）・offset（前のページの最後の $metadata.id）・offsetDirection "next"
//   - 応答: { success: true, result: { events: { events: [...], count? } } }。events[] は $metadata.id・$workers.scriptName・
//           $workers.truncated・source（構造化済みのオブジェクトか文字列）を持つ（読み方は src/console/reconcile-input.ts）
//   - 切られた印: 仕様は $workers.truncated、文書は $cloudflare.truncated。どちらも見る
//   - ページング: 件数が limit に満たないページで終わり。count の意味（全件か、そのページか）は未確認なので出力に出すだけ
// トークン: 仕様では telemetry/query は「Workers Observability Write」しか受け付けない。読み取りだけ（Read）で通るかは ② で確かめる。
// トークンは戻り値・例外の文に入れない。宛先の上書きは手元（127.0.0.1）の試験用だけ（key-tool-common.ts の apiBaseFromVar）。
import { cfApi, cfErrors } from "./key-tool-common";

export const TELEMETRY_PAGE_LIMIT = 2000;
const MAX_PAGES = 500;
const QUERY_ID = "awsbridge-console-reconcile";

export const telemetryQueryPath = (accountId: string) =>
  `/accounts/${accountId}/workers/observability/telemetry/query`;

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
    parameters: {
      filterCombination: "or",
      filters: o.workers.map((w) => ({
        key: "$workers.scriptName",
        operation: "eq",
        type: "string",
        value: w,
      })),
    },
    ...(o.offset !== undefined ? { offset: o.offset, offsetDirection: "next" } : {}),
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 応答の 1 ページ（形が違えば例外）。 */
function pageOf(json: unknown): { events: unknown[]; count?: number } {
  if (!isObj(json) || json.success !== true) throw new Error("telemetry query: not successful");
  const result = isObj(json.result) ? json.result : undefined;
  const ev = isObj(result?.events) ? result.events : undefined;
  if (!ev || !Array.isArray(ev.events)) throw new Error("telemetry query: unexpected response");
  return {
    events: ev.events,
    ...(typeof ev.count === "number" ? { count: ev.count } : {}),
  };
}

const lastId = (events: unknown[]): string | undefined => {
  const last = events[events.length - 1];
  const md = isObj(last) && isObj(last.$metadata) ? last.$metadata : undefined;
  return typeof md?.id === "string" && md.id !== "" ? md.id : undefined;
};

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
};

/** 期間の Worker のイベントをすべて読む。読み切れなければ例外（空の読み取りとして扱わない）。 */
export async function queryIssueLogs(
  d: { fetch: typeof fetch },
  q: IssueLogQuery,
): Promise<{ events: unknown[]; count?: number; pages: number }> {
  const limit = q.pageLimit ?? TELEMETRY_PAGE_LIMIT;
  const url = `${q.base}${telemetryQueryPath(q.accountId)}`;
  const events: unknown[] = [];
  let count: number | undefined;
  let offset: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const body = telemetryQueryBody({
      from: q.from,
      to: q.to,
      workers: q.workers,
      limit,
      ...(offset !== undefined ? { offset } : {}),
    });
    const res = await cfApi(d, q.token, "POST", url, body);
    if (res.status !== 200)
      throw new Error(`telemetry query failed (HTTP ${res.status}): ${cfErrors(res.json)}`);
    const p = pageOf(res.json);
    if (pages === 1 && p.count !== undefined) count = p.count;
    events.push(...p.events);
    if (p.events.length < limit)
      return { events, ...(count !== undefined ? { count } : {}), pages };
    const next = lastId(p.events);
    if (next === undefined || next === offset)
      throw new Error("telemetry query: the page cursor did not advance");
    offset = next;
  }
  throw new Error(`telemetry query: more than ${MAX_PAGES} pages`);
}
