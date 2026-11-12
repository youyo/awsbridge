// コンソールログイン（Standard）の Worker secret の登録: pnpm tsx scripts/console/secrets.ts [--yes]
// mise タスク console:secrets:standard から呼ぶ。--yes が無ければ wrangler を呼ばず、何を入れるかだけを表示する（dry-run）。
//   入力: AWSBRIDGE_CONSOLE_KEY_FILE（既定 .secrets/console/signing-keys.json。console:keygen が作る）
//         AWSBRIDGE_CONSOLE_CSRF_KEY_FILE（既定 .secrets/console/csrf-key。無ければ --yes のときに 32 バイトのランダムを作る）
//   wrangler の設定: AWSBRIDGE_CONSOLE_WRANGLER_CONFIG（既定 wrangler.console-standard.jsonc。下流は自前の設定に切り替える）。
//     MCP 用の AWSBRIDGE_WRANGLER_CONFIG / AWSBRIDGE_WRANGLER_ENV には左右されない（--env は付けない）。
// 値は wrangler の標準入力に渡し、引数・ログには出さない。
import { spawnSync } from "node:child_process";
import { runSecrets, type SecretPutter } from "./secrets-lib";

const env = process.env;
const keyFile = env.AWSBRIDGE_CONSOLE_KEY_FILE || ".secrets/console/signing-keys.json";
const csrfKeyFile = env.AWSBRIDGE_CONSOLE_CSRF_KEY_FILE || ".secrets/console/csrf-key";
const wranglerConfig = env.AWSBRIDGE_CONSOLE_WRANGLER_CONFIG || "wrangler.console-standard.jsonc";

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => a !== "--yes");
if (unknown.length > 0) {
  console.error(`使い方: secrets.ts [--yes]（不明な引数: ${unknown.join(" ")}）`);
  process.exit(1);
}

const put: SecretPutter = (name, value) => {
  const r = spawnSync("bash", ["scripts/wrangler.sh", "secret", "put", name], {
    input: value,
    encoding: "utf8",
    env: { ...env, AWSBRIDGE_WRANGLER_CONFIG: wranglerConfig, AWSBRIDGE_WRANGLER_ENV: "" },
  });
  if (r.status === 0) return { ok: true };
  // wrangler の出力は、念のため値を伏せて短く返す
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" / ");
  return {
    ok: false,
    message: `wrangler が終了コード ${r.status ?? "?"} で終わりました ${tail}`.trim(),
  };
};

const result = await runSecrets({ keyFile, csrfKeyFile, confirm: argv.includes("--yes") }, put);
for (const l of result.lines) (result.ok ? console.log : console.error)(l);
if (!result.ok) process.exit(1);
