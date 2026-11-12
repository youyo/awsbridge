// コンソールログイン（Admin）の CSRF の鍵（CONSOLE_CSRF_KEY。secret_text）の投入: pnpm tsx scripts/console/secrets-admin.ts [--yes]
// mise タスク console:secrets:admin から呼ぶ。本体は secrets-lib.ts（Standard の console:secrets:standard と同じ）。署名鍵は入れない
// （console:admin-key:put。secret_key）。cto の決裁 G2 の論点 5。
// --yes が無ければ何をするかの表示だけ。鍵はこの道具の中で作って Cloudflare API で入れ、ファイルに書かない・出力しない。
// 環境変数は console:admin-key と同じ（AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID・AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN・
// AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE・AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG。トークンが無ければ wrangler の OAuth）。
// Standard 用の変数は読まない。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { adminKeySettings, type Deps } from "./admin-key-lib";
import { runCsrfPut } from "./secrets-lib";
import { wranglerOAuthToken } from "./wrangler-oauth";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  const env = process.env;
  const s = await adminKeySettings(env, (p) => readFileSync(p, "utf8"));
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    token: async () => env.AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN || wranglerOAuthToken(),
    print: (line) => console.log(line),
  };
  return runCsrfPut(s, deps, { yes: values.yes === true, tier: "admin" });
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
