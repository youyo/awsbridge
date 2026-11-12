// Access アプリの設定の検査の読み取り（scripts/console/access-inspect.ts から使う）。判定の本体は src/console/access-inspect.ts。
// Cloudflare API は GET /accounts/{id}/access/apps だけを呼ぶ（読み取り。書き込みはしない）。
// トークンは Authorization ヘッダーだけに入れ、戻り値・例外の文・出力に入れない。AUD の値も出力しない。
// Cloudflare API の宛先の上書きは手元（127.0.0.1）の試験用だけ（key-tool-common.ts の apiBaseFromVar）。

import type { AccessAppSnapshot } from "../../src/console/access-inspect";
import { TIERS } from "../../src/console/constants";
import type { AccessSummary } from "../../src/console/generate";
import { cfApi, cfErrors, isObj, type ToolDeps } from "./key-tool-common";

/** 入力（access.json など）の形の誤り。メッセージは位置だけで、値を入れない。 */
export class InputError extends Error {}

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function expectObj(v: unknown, where: string): Record<string, unknown> {
  if (!isObj(v)) throw new InputError(`access.json: ${where}: type`);
  return v;
}

const optionalStr = (o: Record<string, unknown>, k: string, where: string): string | undefined => {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new InputError(`access.json: ${where}.${k}: type`);
  return v;
};

/** 生成物 access.json（console:config:generate が書く）を読む。必要な項目の形だけ確かめる。 */
export function parseAccessSummary(raw: unknown): AccessSummary {
  const o = expectObj(raw, "(root)");
  const routing = o.routing;
  if (routing !== "path" && routing !== "host") throw new InputError("access.json: routing: enum");
  const origins = expectObj(o.origins, "origins");
  const standard = optionalStr(origins, "standard", "origins");
  if (standard === undefined) throw new InputError("access.json: origins.standard: required");
  const admin = optionalStr(origins, "admin", "origins");
  const entry = expectObj(o.entryAud, "entryAud");
  const entryAud: AccessSummary["entryAud"] = {};
  for (const t of TIERS) {
    const v = optionalStr(entry, t, "entryAud");
    if (v !== undefined) entryAud[t] = v;
  }
  if (!Array.isArray(o.teams)) throw new InputError("access.json: teams: type");
  const teams = o.teams.map((t, i): AccessSummary["teams"][number] => {
    const where = `teams[${i}]`;
    const to = expectObj(t, where);
    const name = optionalStr(to, "name", where);
    if (name === undefined || !/^[a-z][a-z0-9-]{0,31}$/.test(name))
      throw new InputError(`access.json: ${where}.name: pattern`);
    const tier = TIERS.find((x) => x === to.tier);
    if (tier === undefined) throw new InputError(`access.json: ${where}.tier: enum`);
    const aud = optionalStr(to, "aud", where);
    return { name, tier, ...(aud !== undefined ? { aud } : {}) };
  });
  return {
    schemaVersion: 1,
    generatedAt: "",
    routing,
    origins: { standard, ...(admin !== undefined ? { admin } : {}) },
    entryAud,
    teams,
  };
}

function apiError(where: string): Error {
  return new Error(`unexpected response: ${where}`);
}

/** apps の一覧（result）を検査に使う項目へ。aud を持たないもの（bookmark など）は読み飛ばす。 */
export function parseAccessApps(result: unknown): AccessAppSnapshot[] {
  if (!Array.isArray(result)) throw apiError("result");
  const apps: AccessAppSnapshot[] = [];
  for (const a of result) {
    if (!isObj(a) || typeof a.aud !== "string" || a.aud === "") continue;
    const fromDestinations = Array.isArray(a.destinations)
      ? a.destinations.flatMap((d) => (isObj(d) && typeof d.uri === "string" ? [d.uri] : []))
      : [];
    const destinations =
      fromDestinations.length > 0
        ? fromDestinations
        : typeof a.domain === "string" && a.domain !== ""
          ? [a.domain]
          : [];
    apps.push({
      aud: a.aud,
      type: typeof a.type === "string" ? a.type : "",
      destinations,
      pathCookie:
        typeof a.path_cookie_attribute === "boolean" ? a.path_cookie_attribute : undefined,
    });
  }
  return apps;
}

/** Access アプリを全ページ読む（GET だけ）。失敗は状態とエラーのコードだけの例外（トークンを入れない）。 */
export async function fetchAccessApps(
  d: Pick<ToolDeps, "fetch">,
  apiBase: string,
  accountId: string,
  token: string,
): Promise<AccessAppSnapshot[]> {
  const apps: AccessAppSnapshot[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${apiBase}/accounts/${accountId}/access/apps?page=${page}&per_page=${PAGE_SIZE}`;
    const r = await cfApi(d, token, "GET", url);
    if (r.status !== 200 || !isObj(r.json) || r.json.success !== true)
      throw new Error(`Cloudflare API GET access/apps: ${r.status} ${cfErrors(r.json)}`);
    const batch = r.json.result;
    apps.push(...parseAccessApps(batch));
    const info = isObj(r.json.result_info) ? r.json.result_info : {};
    const total = typeof info.total_pages === "number" ? info.total_pages : undefined;
    if (total !== undefined ? page >= total : !Array.isArray(batch) || batch.length < PAGE_SIZE)
      return apps;
  }
  throw new Error("Cloudflare API GET access/apps: too many pages");
}
