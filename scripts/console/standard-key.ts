// コンソールログインの Standard の署名鍵（Workers の secret_key 型。境界ごと）の運用の CLI:
//   pnpm tsx scripts/console/standard-key.ts <put|retire|check> [--yes] [--boundary NAME] [--binding NAME] [--team NAME]
// mise タスク console:standard-key:put / retire / check から呼ぶ。本体は standard-key-lib.ts。
// 人が手元で実行する（CI から実行しない）。鍵はこの道具のメモリの中で作って Cloudflare API で入れ、ファイルに書かない・出力しない。
// put と retire は --yes が無ければ何をするかの表示だけ。
// 環境変数（既定値はここで補う。mise.toml の [env] には置かない。Admin 用の AWSBRIDGE_CONSOLE_ADMIN_* は読まない）:
//   AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID   Cloudflare のアカウント ID（wrangler の設定の account_id でもよい）
//   AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN    Cloudflare API のトークン（Standard の Worker の secret だけを書ける権限。Admin 用と分ける）。
//                                              無ければ wrangler の OAuth（wrangler auth token）をメモリの中だけで使う
//   AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG Standard の Worker の wrangler の設定（既定 wrangler.console-standard.jsonc）
//   AWSBRIDGE_CONSOLE_OUT_DIR                  生成物の置き場所（既定 .generated/console。worker.standard.json で境界・issuer・ポータルを知る）
//   AWSBRIDGE_CONSOLE_STANDARD_ACCESS_TOKEN    check の key-check に使う Access のトークン（任意。cloudflared access token の値）
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type Deps,
  runCheck,
  runPut,
  runRetire,
  standardKeySettings,
  standardToken,
} from "./standard-key-lib";
import { wranglerOAuthToken } from "./wrangler-oauth";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: "boolean", default: false },
      boundary: { type: "string" },
      binding: { type: "string" },
      team: { type: "string" },
    },
  });
  const cmd = positionals[0];
  const env = process.env;
  const s = await standardKeySettings(env, (p) => readFileSync(p, "utf8"));
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    token: async () => standardToken(env) ?? wranglerOAuthToken(),
    print: (line) => console.log(line),
  };
  if (cmd === "put") {
    if (!values.boundary)
      throw new Error("--boundary <境界の名前>（例 managed・partner:<id>）が要る");
    return runPut(s, deps, { yes: values.yes === true, boundary: values.boundary });
  }
  if (cmd === "retire") {
    if (!values.binding) throw new Error("--binding <STANDARD_KEY_…> が要る");
    return runRetire(s, deps, { yes: values.yes === true, binding: values.binding });
  }
  if (cmd === "check")
    return runCheck(s, deps, {
      accessToken: env.AWSBRIDGE_CONSOLE_STANDARD_ACCESS_TOKEN || undefined,
      team: values.team,
    });
  throw new Error(
    "使い方: standard-key.ts <put|retire|check> [--yes] [--boundary NAME] [--binding NAME] [--team NAME]",
  );
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // 例外の文には鍵・トークンを入れていない
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
