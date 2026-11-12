// 突き合わせの道具の CLI: 発行記録 × CloudTrail の AssumeRoleWithWebIdentity（mise タスク console:reconcile）。
//   pnpm tsx scripts/console/reconcile.ts --profile <AWS のプロファイル> (--records <file|dir> | --logs-api)
//     [--since <ISO 8601 | <n>d | <n>h>] [--until <ISO 8601>] [--account-id <12 桁>] [--retention-days <n>] [--lag-seconds <n>]
// 1 回で 1 アカウント（プロファイルのアカウント）。CloudTrail は有効な全リージョンを読む（cto の決裁 ★1）。
// 呼ぶ aws は照会の 4 種類だけ（reconcile-read.ts の RECONCILE_READ_COMMANDS）、Cloudflare は照会の API だけ（reconcile-cf.ts）。
// 判定の本体は src/console/reconcile.ts（純粋な関数）。設計: docs/specs/console-login.md §5.6。
//
// 入力:
//   AWSBRIDGE_CONSOLE_CONFIG              設定ファイル（既定 config/console.json）。issuer（プロバイダー）と階層を読む
//   --records <file|dir>                  発行記録の NDJSON（生の行・Trace Events の包み・Workers Logs のイベント。.gz も読む）
//   --logs-api                            発行記録を Cloudflare の API（Workers Logs。保持 7 日）から読む:
//     AWSBRIDGE_CONSOLE_LOGS_TOKEN        API のトークン（環境変数だけ。wrangler の OAuth は使わない）
//     AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID   Cloudflare のアカウント ID（32 桁の 16 進）
//     AWSBRIDGE_CONSOLE_LOGS_WORKERS      Worker の名前（カンマ区切り。既定 awsbridge-console-standard,awsbridge-console-admin）
//     AWSBRIDGE_CONSOLE_LOGS_API_BASE     試験用（http://127.0.0.1:<port> だけ）
// 既定のさかのぼりは 6 日（記録の保持 7 日より短く。決裁 (a)）。
// 出力は伏せ字（jti は先頭 8 文字、email は出さない、アカウント ID は末尾 4 桁）。
// 終了コード: 0 誤りなし / 1 誤りあり、または検証できない引き受けが 1 件以上 / 2 実行できない（入力・aws・API の失敗）。
// 限界: 突き合わせは検知の材料で、完全性の証明ではない。7 日以内に回さなかった発行は、あとから検証できない。
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { ConsoleConfigError, formatIssue, parseConsoleConfig } from "../../src/console/config";
import { TIERS, type Tier } from "../../src/console/constants";
import {
  DEFAULT_LAG_SECONDS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_RETENTION_DAYS,
  formatReconcileReport,
  reconcile,
  reconcileExitCode,
  redactReconcile,
} from "../../src/console/reconcile";
import {
  mergeRecordReads,
  type RecordRead,
  readRecordLines,
  recordsFromLogEvents,
} from "../../src/console/reconcile-input";
import { apiBaseFromVar, ACCOUNT_RE as CF_ACCOUNT_RE } from "./key-tool-common";
import { queryIssueLogs } from "./reconcile-cf";
import {
  type AwsRun,
  guardRun,
  readAssumeEvents,
  readCallerAccount,
  readEnabledRegions,
} from "./reconcile-read";

class InputError extends Error {}

/** プロファイル名（先頭の - は拒否。引数と取り違えないように）。 */
const PROFILE_RE = /^[\w.+@][\w.+@-]{0,63}$/;
const ACCOUNT_RE = /^\d{12}$/;
const WORKER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_WORKERS = ["awsbridge-console-standard", "awsbridge-console-admin"];
/** 記録は CloudTrail の期間より少し広く読む（期間の端の発行と引き受けを取りこぼさない）。 */
const RECORD_MARGIN_MS = 15 * 60_000;

/** aws CLI を非同期で呼ぶ（execFile。シェルを通さない）。失敗は伏せ字のエラーにする。 */
function awsRunner(profile: string): AwsRun {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "aws",
        // 名前は = の形で渡す（- で始まる値を別の引数と読ませない）
        [...args, `--profile=${profile}`, "--output", "json"],
        // lookup-events は自動ページングと待ちで長くかかりうる
        { env: process.env, timeout: 600_000, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
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

/** 時刻: ISO 8601 か、今からさかのぼる <n>d・<n>h。 */
function parseTime(v: string, now: number, label: string): number {
  const rel = /^(\d{1,4})([dh])$/.exec(v);
  if (rel?.[1] !== undefined && rel[2] !== undefined)
    return now - Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000);
  const t = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(t))
    throw new InputError(`${label} は ISO 8601 か <n>d・<n>h`);
  return t;
}

function positiveInt(v: string | undefined, label: string, def: number): number {
  if (v === undefined) return def;
  if (!/^\d{1,6}$/.test(v) || Number(v) <= 0) throw new InputError(`${label} は正の整数`);
  return Number(v);
}

/** 発行記録のファイル（ディレクトリなら中の通常のファイルをすべて。.gz は展開）を読む。 */
function readRecordFiles(path: string, workers: readonly string[]): RecordRead {
  if (!existsSync(path)) throw new InputError(`記録のファイルがありません: ${path}`);
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => !f.startsWith("."))
        .sort()
        .map((f) => join(path, f))
        .filter((f) => statSync(f).isFile())
    : [path];
  if (files.length === 0) throw new InputError(`記録のファイルがありません: ${path}`);
  return mergeRecordReads(
    files.map((f) => {
      const raw = readFileSync(f);
      const text = new TextDecoder("utf-8").decode(f.endsWith(".gz") ? gunzipSync(raw) : raw);
      return readRecordLines(text, basename(f), { workers });
    }),
  );
}

function workerNames(env: NodeJS.ProcessEnv): string[] {
  const v = env.AWSBRIDGE_CONSOLE_LOGS_WORKERS;
  if (v === undefined || v.trim() === "") return DEFAULT_WORKERS;
  const list = v.split(",").map((x) => x.trim());
  if (list.some((x) => !WORKER_RE.test(x)))
    throw new InputError("AWSBRIDGE_CONSOLE_LOGS_WORKERS: Worker の名前（カンマ区切り）");
  return list;
}

async function main(): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      options: {
        profile: { type: "string" },
        records: { type: "string" },
        "logs-api": { type: "boolean" },
        since: { type: "string" },
        until: { type: "string" },
        "account-id": { type: "string" },
        "retention-days": { type: "string" },
        "lag-seconds": { type: "string" },
      },
    }).values;
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  const usage =
    "使い方: reconcile.ts --profile <AWS のプロファイル> (--records <file|dir> | --logs-api) [--since <ISO|<n>d>] [--until <ISO>] [--account-id <12 桁>] [--retention-days <n>] [--lag-seconds <n>]";
  const profile = typeof values.profile === "string" ? values.profile : undefined;
  if (!profile || !PROFILE_RE.test(profile)) throw new InputError(usage);
  const recordsPath = typeof values.records === "string" ? values.records : undefined;
  const useApi = values["logs-api"] === true;
  if ((recordsPath === undefined) === !useApi)
    throw new InputError(`記録の入力は --records か --logs-api のどちらか 1 つ\n${usage}`);
  const expectAccountId =
    typeof values["account-id"] === "string" ? values["account-id"] : undefined;
  if (expectAccountId !== undefined && !ACCOUNT_RE.test(expectAccountId))
    throw new InputError("--account-id は 12 桁の数字");
  const retentionDays = positiveInt(
    values["retention-days"] as string | undefined,
    "--retention-days",
    DEFAULT_RETENTION_DAYS,
  );
  const lagSeconds = positiveInt(
    values["lag-seconds"] as string | undefined,
    "--lag-seconds",
    DEFAULT_LAG_SECONDS,
  );
  const now = Date.now();
  const since =
    typeof values.since === "string"
      ? parseTime(values.since, now, "--since")
      : now - DEFAULT_LOOKBACK_DAYS * 86_400_000;
  const until = typeof values.until === "string" ? parseTime(values.until, now, "--until") : now;
  if (!(since < until) || until > now + 60_000)
    throw new InputError("--since < --until <= 今 にする");

  // 設定の issuer（プロバイダー）と階層
  const configPath = process.env.AWSBRIDGE_CONSOLE_CONFIG || "config/console.json";
  if (!existsSync(configPath)) throw new InputError(`設定ファイルがありません: ${configPath}`);
  const { config } = parseConsoleConfig(readFileSync(configPath, "utf8"));
  const issuers: { url: string; tier: Tier }[] = config.boundaries.flatMap((b) =>
    TIERS.flatMap((t) => {
      const url = b.issuers[t];
      return url !== undefined ? [{ url, tier: t }] : [];
    }),
  );

  const workers = workerNames(process.env);
  // API の入力は aws を呼ぶ前に確かめる（トークンを外へ送らない・空の読み取りにしない）
  let api: { base: string; accountId: string; token: string } | undefined;
  if (useApi) {
    let apiBase: string;
    try {
      apiBase = apiBaseFromVar(process.env, "AWSBRIDGE_CONSOLE_LOGS_API_BASE");
    } catch (e) {
      throw new InputError((e as Error).message);
    }
    const accountId = process.env.AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID ?? "";
    if (!CF_ACCOUNT_RE.test(accountId))
      throw new InputError(
        "AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID（Cloudflare のアカウント ID。32 桁の 16 進）が要る",
      );
    const token = process.env.AWSBRIDGE_CONSOLE_LOGS_TOKEN ?? "";
    if (token === "") throw new InputError("AWSBRIDGE_CONSOLE_LOGS_TOKEN（API のトークン）が要る");
    api = { base: apiBase, accountId, token };
  }
  const fileRead = recordsPath !== undefined ? readRecordFiles(recordsPath, workers) : undefined;

  // CloudTrail（プロファイルのアカウント・有効な全リージョン）
  const run = guardRun(awsRunner(profile));
  const accountId = await readCallerAccount(run);
  if (expectAccountId !== undefined && expectAccountId !== accountId)
    throw new InputError("the profile's account differs from --account-id");
  const regions = await readEnabledRegions(run);
  const trail = await readAssumeEvents(run, regions, { since, until });

  // 発行記録（CloudTrail を読んだあとに読む: 記録の側が後になるので、期間の端の取りこぼしが少ない）
  let read: RecordRead;
  let apiCount: number | undefined;
  if (api) {
    const q = await queryIssueLogs(
      { fetch },
      {
        ...api,
        workers,
        from: since - RECORD_MARGIN_MS,
        to: Math.min(until + RECORD_MARGIN_MS, Date.now()),
      },
    );
    apiCount = q.count;
    read = recordsFromLogEvents(q.events, "api", { workers });
  } else read = fileRead as RecordRead;

  const result = reconcile({
    records: read.records,
    events: trail.events,
    window: { since, until },
    now,
    accountId,
    issuers,
    regions: { read: trail.read, unread: trail.unread },
    lines: { truncated: read.truncated, unreadable: read.unreadable, total: read.lines },
    source: api ? "api" : "file",
    lagSeconds,
    retentionDays,
  });
  console.log(formatReconcileReport(result, { label: `profile ${profile}`, apiCount }));
  return reconcileExitCode(result);
}

function stop(message: string): never {
  console.error(redactReconcile(message));
  process.exit(2);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ConsoleConfigError)
      stop(`設定の誤り:\n${e.issues.map((i) => `  ${formatIssue(i)}`).join("\n")}`);
    stop(e instanceof Error ? e.message : String(e));
  },
);
