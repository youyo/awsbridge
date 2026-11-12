// コンソールログインの Admin の署名鍵（Workers の secret_key 型）の運用の CLI: pnpm tsx scripts/console/admin-key.ts <put|retire|check> [--yes] [--binding NAME] [--team NAME]
// mise タスク console:admin-key:put / console:admin-key:retire / console:admin-key:check から呼ぶ。本体は admin-key-lib.ts。
// 人が手元で実行する（CI から実行しない）。鍵はこの道具のメモリの中で作って Cloudflare API で入れ、ファイルに書かない・出力しない。
// put と retire は --yes が無ければ何をするかの表示だけ。
// 環境変数（既定値はここで補う。mise.toml の [env] には置かない）:
//   AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID   Cloudflare のアカウント ID（wrangler の設定の account_id でもよい）
//   AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN    Cloudflare API のトークン（Admin の Worker の secret だけを書ける権限。Standard 用と分ける）。
//                                           無ければ wrangler の OAuth（wrangler auth token）をメモリの中だけで使う
//   AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG Admin の Worker の wrangler の設定（既定 wrangler.console-admin.jsonc）
//   AWSBRIDGE_CONSOLE_OUT_DIR               生成物の置き場所（既定 .generated/console。check が worker.admin.json を読む）
//   AWSBRIDGE_CONSOLE_ADMIN_ACCESS_TOKEN    check の key-check に使う Access のトークン（任意。cloudflared access token の値）
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { adminKeySettings, type Deps, runCheck, runPut, runRetire } from "./admin-key-lib";

function wranglerOAuthToken(): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  delete env.CLOUDFLARE_API_TOKEN;
  const r = spawnSync("pnpm", ["exec", "wrangler", "auth", "token", "--json"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0)
    throw new Error("wrangler auth token が失敗した（pnpm exec wrangler login を確かめる）");
  let token: unknown;
  try {
    token = (JSON.parse(r.stdout) as { token?: unknown }).token;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || token === "")
    throw new Error("wrangler auth token の出力に token が無い");
  return token;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: "boolean", default: false },
      binding: { type: "string" },
      team: { type: "string" },
    },
  });
  const cmd = positionals[0];
  const env = process.env;
  const s = await adminKeySettings(env, (p) => readFileSync(p, "utf8"));
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    token: async () => env.AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN || wranglerOAuthToken(),
    print: (line) => console.log(line),
  };
  if (cmd === "put") return runPut(s, deps, { yes: values.yes === true });
  if (cmd === "retire") {
    if (!values.binding) throw new Error("--binding <ADMIN_KEY_…> が要る");
    return runRetire(s, deps, { yes: values.yes === true, binding: values.binding });
  }
  if (cmd === "check")
    return runCheck(s, deps, {
      accessToken: env.AWSBRIDGE_CONSOLE_ADMIN_ACCESS_TOKEN || undefined,
      team: values.team,
    });
  throw new Error("使い方: admin-key.ts <put|retire|check> [--yes] [--binding NAME] [--team NAME]");
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
