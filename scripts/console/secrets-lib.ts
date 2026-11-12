// console:secrets:standard の本体（CLI は secrets.ts）。コンソールログインの Standard の Worker の CSRF の鍵（CONSOLE_CSRF_KEY）を入れる。
// 署名鍵は境界ごとの secret_key（console:standard-key:put）に移した（cto の決裁「Standard も secret_key に揃える」）。CSRF の鍵は secret_text のまま。
// 鍵はこの道具の中で作り（32 バイトの乱数を 16 進 64 文字に）、Cloudflare API の PUT .../secrets（secret_text）で入れる。
// ファイルに書かない・出力しない。--yes が無ければ表示だけ（API・トークンを使わない）。同じ名前が secret_text 以外なら入れない。
// トークンと宛先は Standard の署名鍵の道具と同じ（AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN。Admin のトークンは読まない）。
import { cfApi, cfErrors, isObj } from "./key-tool-common";
import type { Deps, Settings } from "./standard-key-lib";

export const CSRF_SECRET_NAME = "CONSOLE_CSRF_KEY";
/** CSRF の鍵のバイト数（src/console/issue/csrf.ts の下限 32 バイト）。 */
const CSRF_BYTES = 32;

export async function runCsrfPut(s: Settings, d: Deps, o: { yes: boolean }): Promise<number> {
  const target = `Worker ${s.scriptName}（${s.wranglerConfigPath}）`;
  if (!o.yes) {
    d.print("console:secrets:standard（表示だけ。--yes を付けると実行する）:");
    d.print(
      `  ${CSRF_SECRET_NAME}: ${CSRF_BYTES} バイトの乱数をこの道具の中で作り、Cloudflare API で ${target} に secret_text として入れる（ファイルに書かない・表示しない）`,
    );
    d.print("  作り直すと、開いている画面の CSRF トークンは使えなくなる（画面を開き直せば戻る）");
    d.print(
      "署名鍵はこの道具では入れない。境界ごとに mise run console:standard-key:put（secret_key）",
    );
    return 0;
  }
  const url = `${s.apiBase}/accounts/${s.accountId}/workers/scripts/${s.scriptName}/secrets`;
  const token = await d.token();
  const list = await cfApi(d, token, "GET", url);
  const items =
    list.status === 200 && isObj(list.json) && Array.isArray(list.json.result)
      ? list.json.result
      : undefined;
  if (!items) {
    d.print(`[NG] secret の一覧を読めない（HTTP ${list.status}）。何もしていない`);
    return 1;
  }
  const same = items.find((x) => isObj(x) && x.name === CSRF_SECRET_NAME) as
    | Record<string, unknown>
    | undefined;
  if (same && same.type !== "secret_text") {
    d.print(`[NG] ${CSRF_SECRET_NAME} が secret_text でない（${String(same.type)}）。入れない`);
    return 1;
  }
  let text = [...crypto.getRandomValues(new Uint8Array(CSRF_BYTES))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  try {
    const put = await cfApi(d, token, "PUT", url, {
      name: CSRF_SECRET_NAME,
      type: "secret_text",
      text,
    });
    const result = isObj(put.json) ? put.json.result : undefined;
    const ok =
      put.status >= 200 &&
      put.status < 300 &&
      isObj(put.json) &&
      put.json.success === true &&
      isObj(result) &&
      result.name === CSRF_SECRET_NAME &&
      result.type === "secret_text";
    if (!ok) {
      d.print(
        `[NG] PUT が失敗した（HTTP ${put.status}）: ${cfErrors(put.json).split(text).join("[REDACTED]")}`,
      );
      return 1;
    }
    d.print(`[OK] ${target} に ${CSRF_SECRET_NAME}（secret_text）を入れた。値は表示しない`);
    return 0;
  } finally {
    text = "";
  }
}
