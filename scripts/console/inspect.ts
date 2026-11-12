// 検査の道具の CLI: pnpm tsx scripts/console/inspect.ts --profile <AWS のプロファイル> [--stops <file>] [--account-id <id>]
// mise タスク console:inspect から呼ぶ。1 回で 1 アカウント（プロファイルのアカウント）を検査する。
// 読み取り（IAM の 8 種類の API）だけで、AWS に書き込まない。判定の本体は src/console/inspect.ts（純粋な関数）。
// 設計: docs/specs/console-login.md §4.8・§4.9・§6.3。
//
// 入力:
//   AWSBRIDGE_CONSOLE_CONFIG          設定ファイル（既定 config/console.json）
//   AWSBRIDGE_CONSOLE_INVENTORY_FILE  placement: ou の Organization のインベントリ（任意。console:config:generate と同じ形）
//   --stops <file>                    有効な 1 人停止の一覧 { "sourceIdentities": ["..."] }（任意。渡すと全ロールに Deny があるかを確かめる）
//   --account-id <id>                 期待するアカウント（任意。プロファイルのアカウントと違えば止まる）
// 出力は伏せ字（アカウント ID・email）。終了コード: 0 誤りなし / 1 誤りあり / 2 検査できない（入力・aws の失敗）。
// 限界: 手で回す検査は、検査のあとの改変を防がない。定期に回し、CloudTrail の変更の通知と組み合わせる（§4.9）。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConsoleConfigError, formatIssue, parseConsoleConfig } from "../../src/console/config";
import { formatReport, inspectAccount, redact } from "../../src/console/inspect";
import { type AwsRun, readAccountSnapshot } from "./inspect-read";

class InputError extends Error {}

function stop(message: string): never {
  console.error(redact(message));
  process.exit(2);
}

/** プロファイル名（先頭の - は拒否。引数と取り違えないように）。 */
const PROFILE_RE = /^[\w.+@][\w.+@-]{0,63}$/;
const ACCOUNT_RE = /^\d{12}$/;
const SOURCE_IDENTITY_RE = /^[\w+=,.@-]{2,64}$/;

/** aws CLI を非同期で呼ぶ（execFile。シェルを通さない）。失敗は伏せ字のエラーにする。 */
function awsRunner(profile: string): AwsRun {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "aws",
        // 名前は = の形で渡す（- で始まる値を別の引数と読ませない）
        [...args, `--profile=${profile}`, "--output", "json"],
        { env: process.env, timeout: 60_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const first = stderr.split("\n").find((l) => l.trim() !== "") ?? err.message;
            reject(new Error(`aws ${args[0]} ${args[1]} failed: ${first.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout === "" ? "null" : stdout));
          } catch {
            reject(new Error(`aws ${args[0]} ${args[1]}: could not parse the response`));
          }
        },
      );
    });
}

function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) throw new InputError(`${label} のファイルがありません: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new InputError(`${label}: json`);
  }
}

/** 停止の一覧（値は出さない。形の誤りは位置だけ）。 */
function readStops(path: string): string[] {
  const raw = readJson(path, "stops");
  const list =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).sourceIdentities
      : undefined;
  if (!Array.isArray(list)) throw new InputError("stops.sourceIdentities: type");
  list.forEach((v, i) => {
    if (typeof v !== "string" || !SOURCE_IDENTITY_RE.test(v))
      throw new InputError(`stops.sourceIdentities[${i}]: pattern`);
  });
  return [...new Set(list as string[])];
}

async function main(): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      options: {
        profile: { type: "string" },
        stops: { type: "string" },
        "account-id": { type: "string" },
      },
    }).values;
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  const profile = values.profile;
  if (!profile || !PROFILE_RE.test(profile))
    throw new InputError(
      "使い方: inspect.ts --profile <AWS のプロファイル> [--stops <file>] [--account-id <12 桁>]",
    );
  const expectAccountId = values["account-id"];
  if (expectAccountId !== undefined && !ACCOUNT_RE.test(expectAccountId))
    throw new InputError("--account-id は 12 桁の数字");

  const configPath = process.env.AWSBRIDGE_CONSOLE_CONFIG || "config/console.json";
  if (!existsSync(configPath)) throw new InputError(`設定ファイルがありません: ${configPath}`);
  const { config } = parseConsoleConfig(readFileSync(configPath, "utf8"));
  const invPath = process.env.AWSBRIDGE_CONSOLE_INVENTORY_FILE;
  const inventory = invPath ? readJson(invPath, "inventory") : undefined;
  const stops = values.stops !== undefined ? readStops(values.stops) : undefined;

  const snapshot = await readAccountSnapshot(awsRunner(profile), {
    roleNames: config.roles.map((r) => r.roleName),
    ...(expectAccountId !== undefined ? { expectAccountId } : {}),
  });
  const result = inspectAccount({
    config,
    snapshot,
    ...(inventory !== undefined ? { inventory } : {}),
    ...(stops !== undefined ? { stops } : {}),
  });
  console.log(formatReport(result, `profile ${profile}`));
  return result.findings.some((f) => f.severity === "error") ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ConsoleConfigError)
      stop(`設定の誤り:\n${e.issues.map((i) => `  ${formatIssue(i)}`).join("\n")}`);
    stop(e instanceof Error ? e.message : String(e));
  },
);
