// Cloudflare Access のアプリの設定の検査の CLI: pnpm tsx scripts/console/access-inspect.ts
// mise タスク console:access:inspect から呼ぶ。生成物の access.json（console:config:generate）の入口とチームの AUD を使い、
// Cloudflare API を読んで（GET だけ。書き込まない）、アプリが在るか・対象が合うか・Cookie Path が有効かを確かめる。
// 判定の本体は src/console/access-inspect.ts（純粋な関数）。設計: docs/specs/console-login.md §5.4。
// 環境変数（既定値はここで補う。mise.toml の [env] には置かない）:
//   AWSBRIDGE_CONSOLE_OUT_DIR                  生成物の置き場所（既定 .generated/console。access.json を読む）
//   AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID     Cloudflare のアカウント ID（32 桁の 16 進）
//   AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN        Cloudflare API のトークン（Access: Apps and Policies の Read だけ）。
//                                              wrangler の OAuth には落とさない（権限の範囲が違う）。無ければ止まる
//   AWSBRIDGE_CONSOLE_ACCESS_CF_API_BASE       試験用の宛先（http://127.0.0.1:<port> だけ）
// 出力に AUD・トークン・アカウント ID を出さない。終了コード: 0 誤りなし / 1 誤りあり / 2 検査できない（入力・API の失敗）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAccessReport, inspectAccessApps } from "../../src/console/access-inspect";
import { fetchAccessApps, InputError, parseAccessSummary } from "./access-inspect-lib";
import { ACCOUNT_RE, apiBaseFromVar } from "./key-tool-common";

async function main(): Promise<number> {
  const env = process.env;
  const outDir = env.AWSBRIDGE_CONSOLE_OUT_DIR || ".generated/console";
  const accountId = env.AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID;
  if (!accountId || !ACCOUNT_RE.test(accountId))
    throw new InputError(
      "AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID（Cloudflare のアカウント ID。32 桁の 16 進）を mise.local.toml などに設定してください",
    );
  const token = env.AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN;
  if (!token)
    throw new InputError(
      "AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN（Access: Apps and Policies の Read だけのトークン）を mise.local.toml などに設定してください",
    );
  const apiBase = apiBaseFromVar(env, "AWSBRIDGE_CONSOLE_ACCESS_CF_API_BASE");

  const path = join(outDir, "access.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new InputError(
      `${path} を読めません（先に mise run console:config:generate を実行してください）`,
    );
  }
  const summary = parseAccessSummary(raw);
  const apps = await fetchAccessApps(
    { fetch: (i, init) => fetch(i, init) },
    apiBase,
    accountId,
    token,
  );
  const findings = inspectAccessApps({ summary, apps });
  console.log(formatAccessReport(findings));
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // 例外の文にはトークン・AUD を入れていない
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 2;
  },
);
