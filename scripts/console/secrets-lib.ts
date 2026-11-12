// console:secrets:standard と console:secrets:admin の本体（CLI は secrets.ts と secrets-admin.ts）。コンソールログインの
// Standard / Admin の Worker の CSRF の鍵（CONSOLE_CSRF_KEY）を入れる。Admin の分は cto の決裁 G2 の論点 5 で足した。
// 署名鍵は境界ごとの secret_key（console:standard-key:put）に移した（cto の決裁「Standard も secret_key に揃える」）。CSRF の鍵は secret_text のまま。
// 鍵はこの道具の中で作り（32 バイトの乱数を 16 進 64 文字に）、Cloudflare API の PUT .../secrets（secret_text）で入れる。
// ファイルに書かない・出力しない。--yes が無ければ表示だけ（API・トークンを使わない）。同じ名前が secret_text 以外なら入れない。
// トークンと宛先は、その階層の署名鍵の道具と同じ（Standard は AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN、Admin は
// AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN）。どちらの CLI も、もう一方の階層の変数を読まない。値は実行のたびに新しく作るので、
// Standard と Admin の Worker の CSRF の鍵は別の値になる。
import { cfApi, cfErrors, isObj, type ToolDeps } from "./key-tool-common";

/** 入れる先（両階層の Settings に共通の項目）。 */
export type CsrfTarget = {
  wranglerConfigPath: string;
  scriptName: string;
  accountId: string;
  apiBase: string;
};

export type CsrfTier = "standard" | "admin";

export const CSRF_SECRET_NAME = "CONSOLE_CSRF_KEY";
/** CSRF の鍵のバイト数（src/console/issue/csrf.ts の下限 32 バイト）。 */
const CSRF_BYTES = 32;

/** 署名鍵を入れる道具の案内（階層ごと）。 */
const SIGNING_KEY_HINT: Record<CsrfTier, string> = {
  standard:
    "署名鍵はこの道具では入れない。境界ごとに mise run console:standard-key:put（secret_key）",
  admin: "署名鍵はこの道具では入れない。mise run console:admin-key:put（secret_key）",
};

export async function runCsrfPut(
  s: CsrfTarget,
  d: ToolDeps,
  o: { yes: boolean; tier?: CsrfTier },
): Promise<number> {
  const tier = o.tier ?? "standard";
  const target = `Worker ${s.scriptName}（${s.wranglerConfigPath}）`;
  if (!o.yes) {
    d.print(`console:secrets:${tier}（表示だけ。--yes を付けると実行する）:`);
    d.print(
      `  ${CSRF_SECRET_NAME}: ${CSRF_BYTES} バイトの乱数をこの道具の中で作り、Cloudflare API で ${target} に secret_text として入れる（ファイルに書かない・表示しない）`,
    );
    if (tier === "admin")
      d.print(
        "  実行のたびに新しい乱数を作るので、Standard の Worker の CSRF の鍵と別の値になる（同じ値を手で入れない）",
      );
    d.print("  作り直すと、開いている画面の CSRF トークンは使えなくなる（画面を開き直せば戻る）");
    d.print(SIGNING_KEY_HINT[tier]);
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
