// コンソールログイン（Standard）の CSRF の鍵（CONSOLE_CSRF_KEY。secret_text）の投入: pnpm tsx scripts/console/secrets.ts [--yes]
// mise タスク console:secrets:standard から呼ぶ。本体は secrets-lib.ts。署名鍵は入れない（console:standard-key:put。secret_key）。
// --yes が無ければ何をするかの表示だけ。鍵はこの道具の中で作って Cloudflare API で入れ、ファイルに書かない・出力しない。
// 環境変数は console:standard-key と同じ（AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID・AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN・
// AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG。トークンが無ければ wrangler の OAuth）。Admin 用の変数は読まない。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runCsrfPut } from "./secrets-lib";
import { type Deps, standardKeySettings, standardToken } from "./standard-key-lib";
import { wranglerOAuthToken } from "./wrangler-oauth";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  const env = process.env;
  const s = await standardKeySettings(env, (p) => readFileSync(p, "utf8"));
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    token: async () => standardToken(env) ?? wranglerOAuthToken(),
    print: (line) => console.log(line),
  };
  return runCsrfPut(s, deps, { yes: values.yes === true });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
