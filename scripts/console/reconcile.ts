// 突き合わせの道具の CLI: 発行記録 × CloudTrail の AssumeRoleWithWebIdentity（mise タスク console:reconcile）。
//   pnpm tsx scripts/console/reconcile.ts --profile <AWS のプロファイル> (--records <file|dir> | --logs-api)
//     [--since <ISO 8601 | <n>d | <n>h>] [--until <ISO 8601>] [--account-id <12 桁>] [--retention-days <n>] [--lag-seconds <n>]
//     [--clock-skew-seconds <n>] [--state <file>] [--overlap-seconds <n>] [--init | --accept-unresolved --reason <text>]
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
//     AWSBRIDGE_CONSOLE_LOGS_WORKERS      Worker の名前（カンマ区切り。既定 awsbridge-console）
//     AWSBRIDGE_CONSOLE_LOGS_API_BASE     試験用（http://127.0.0.1:<port> だけ）
//     窓ごとに件数（calculations の count）を先に数え、行数が届くまで窓を割って読む（長い窓は読み取りの時点で間引かれるため。
//     reconcile-cf.ts の冒頭）。届かない窓は誤り record_read_incomplete（終了コード 1）。api count は件数の合計
// 状態の行（アカウントごと）が無ければ実行しない（state_missing・終了コード 2。ファイルが無ければ aws も呼ばない。cto の決裁 2026-11-19 i1）。
// 本当に初回なら人が --init を付けて 1 回回す（行があるのに --init は 2）。--init の実行は結果によらず行を書く（i2）。
// 読み始め: --since が無ければ max(今 − 6 日, min(確認済みの区間の終わり − 重なり, 未解決の所見の最も古い時刻 − 重なり))。--init の初回は 6 日
// （記録の保持 7 日より短く。決裁 (a)）。
// 重なりは --overlap-seconds（既定 86400 = 24 時間、下限 3600。反映の遅れ --lag-seconds とは別）。古い区間を含む長い窓の照会が
// 間引かれて（sampleInterval > 1）record_read_incomplete になるのを避ける緩和策（保存の間引きか照会の間引きかは未確認）。
// --since を渡せばそれが勝つ（全部を読み直す監査用）。出力の read start の行に、読み始めの決め方と時刻を出す。
// 時間の検査: 対になった引き受けの時刻が、発行の時刻から「JWT の寿命 300 秒＋時計ずれ（既定 60 秒。--clock-skew-seconds）」を超えて後ろ、
// または時計ずれを超えて前なら誤り（assume_time_gap）。利用者の食い違い（identity_mismatch）と、Administrator の階層で利用者を
// 比べられなかった対（identity_not_compared_admin）も誤り（cto の決裁 G2-A 条件 c5 の Q1）。
// 出力には、対の発行からの時間差の階層ごとの最小・最大・件数、コンソール以外として除外した引き受けの件数、
// Administrator の階層の発行の件数と各時刻（UTC）も出す（同じ決裁の Q1・Q2・Q4。所見にはしない）。
// 確認済みの区間: アカウントごとに「確認済みの区間の終わり」を状態のファイル（--state。既定 .secrets/console-reconcile-state.json。
// .secrets/ は gitignore）に残す。今回の読み始めが前回の終わりより後なら coverage_gap（誤り）。--init の初回は穴なし。
// 区間を進めるのは終了コード 0 の実行だけ（誤り・検証できない引き受けのある実行は進めない）。終了コード 1 の実行は、時刻を持つ誤りを錨
// （unresolved）として、時刻を持たない誤りを件数（untimed）として書き、次の実行は錨まで読み戻す（解決か受け入れまで消えない。h1〜h4・q3）。
// 受け入れ（--accept-unresolved --reason <理由>。人が打つ。定期実行に入れない）は照合の実行と一体で、所見ではなく区間に対して行う（区間の中の
// 時刻を持つ誤りは、記録に無かったものを含めて以後も誤りにならない。続き 4 の A1）。区間は前の実行までの錨と今回の coverage_gap から決め、
// accepted（確認済みとは別）として残す（q1・q2）。錨には作ったときの判定条件（時計ずれ・反映の遅れ）を残し、緩めた実行では解決にしない（B1）。
// 書く前に状態のファイルを読み直し、変わっていれば書かずに終了コード 2（同じファイルで同時に回さない。(5)）。
// ファイルにはアカウント ID・時刻・code の件数・判定条件だけを書く（理由の本文は書かない）。
// 出力は伏せ字（jti は先頭 8 文字、email は出さない、アカウント ID は末尾 4 桁）。
// 終了コード: 0 誤りなし / 1 誤りあり、または検証できない引き受けが 1 件以上 / 2 実行できない（入力・aws・API の失敗）。
// 限界: 突き合わせは検知の材料で、完全性の証明ではない。7 日以内に回さなかった発行は、あとから検証できない。
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { ConsoleConfigError, formatIssue, parseConsoleConfig } from "../../src/console/config";
import {
  type AcceptanceOutcome,
  acceptedAccountState,
  applyAcceptance,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_LAG_SECONDS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_OVERLAP_SECONDS,
  DEFAULT_RETENTION_DAYS,
  decideReadStart,
  formatReconcileReport,
  formatStateLines,
  MIN_OVERLAP_SECONDS,
  nextAccountState,
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
import {
  type AcceptedInterval,
  accountStateOf,
  parseReconcileState,
  ReconcileStateError,
  serializeReconcileState,
  withAccountState,
} from "../../src/console/reconcile-state";
import { apiBaseFromVar, ACCOUNT_RE as CF_ACCOUNT_RE } from "./key-tool-common";
import { formatIncompleteRead, queryIssueLogs } from "./reconcile-cf";
import {
  type AwsRun,
  guardRun,
  readAssumeEvents,
  readCallerAccount,
  readEnabledRegions,
} from "./reconcile-read";
import { writeStateFile } from "./reconcile-state-io";

class InputError extends Error {}

/** プロファイル名（先頭の - は拒否。引数と取り違えないように）。 */
const PROFILE_RE = /^[\w.+@][\w.+@-]{0,63}$/;
const ACCOUNT_RE = /^\d{12}$/;
const WORKER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** 確認済みの区間の状態ファイルの既定（.secrets/ は gitignore）。 */
const DEFAULT_STATE_FILE = ".secrets/console-reconcile-state.json";
/** 既定の Worker の名前（P2: コンソールの Worker は 1 つ）。 */
const DEFAULT_WORKERS = ["awsbridge-console"];
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

function nonNegativeInt(v: string | undefined, label: string, def: number): number {
  if (v === undefined) return def;
  if (!/^\d{1,6}$/.test(v)) throw new InputError(`${label} は 0 以上の整数`);
  return Number(v);
}

/** 状態のファイルを読む（無ければ空の状態。行が無ければ呼び出し側が state_missing で止める。壊れていれば実行しない: 穴を見落とさないため）。 */
function readState(path: string, now: number) {
  const text = readStateText(path);
  try {
    return { state: parseReconcileState(text, now), text };
  } catch (e) {
    if (e instanceof ReconcileStateError) throw new InputError(`${e.message}: ${path}`);
    throw e;
  }
}

/** 状態のファイルの中身（無ければ undefined）。書く前の読み直しにも使う（同時の実行の検知。続き 4 の (5)）。 */
function readStateText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
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
        "clock-skew-seconds": { type: "string" },
        state: { type: "string" },
        "overlap-seconds": { type: "string" },
        init: { type: "boolean" },
        "accept-unresolved": { type: "boolean" },
        reason: { type: "string" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  const usage =
    "使い方: reconcile.ts --profile <AWS のプロファイル> (--records <file|dir> | --logs-api) [--since <ISO|<n>d>] [--until <ISO>] [--account-id <12 桁>] [--retention-days <n>] [--lag-seconds <n>] [--clock-skew-seconds <n>] [--state <file>] [--overlap-seconds <n>] [--init | --accept-unresolved --reason <text>]";
  if (values.help === true) {
    console.log([usage, ...HELP].join("\n"));
    return 0;
  }
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
  const clockSkewSeconds = nonNegativeInt(
    values["clock-skew-seconds"] as string | undefined,
    "--clock-skew-seconds",
    DEFAULT_CLOCK_SKEW_SECONDS,
  );
  const overlapSeconds = positiveInt(
    values["overlap-seconds"] as string | undefined,
    "--overlap-seconds",
    DEFAULT_OVERLAP_SECONDS,
  );
  if (overlapSeconds < MIN_OVERLAP_SECONDS)
    throw new InputError(`--overlap-seconds は ${MIN_OVERLAP_SECONDS} 以上（1 時間以上）`);
  const statePath = typeof values.state === "string" ? values.state : DEFAULT_STATE_FILE;
  if (statePath.trim() === "") throw new InputError("--state はファイルのパス");
  const init = values.init === true;
  const acceptUnresolved = values["accept-unresolved"] === true;
  const reason =
    typeof values.reason === "string" ? values.reason.replace(/\s+/g, " ").trim() : undefined;
  if (init && acceptUnresolved)
    throw new InputError("--init と --accept-unresolved は同時に使えない");
  // 受け入れの実行は今まで判定した範囲の末尾まで読む（--until で過去に切ると untimed の末尾を読まずに受け入れうる。cto 続き 6 の s1）
  if (acceptUnresolved && typeof values.until === "string")
    throw new InputError(
      "--accept-unresolved cannot be used with --until (受け入れの実行に --until は付けられない)",
    );
  if (acceptUnresolved && (reason === undefined || reason === ""))
    throw new InputError("--accept-unresolved には --reason <理由>（空でない）が要る");
  if (!acceptUnresolved && reason !== undefined)
    throw new InputError("--reason は --accept-unresolved と一緒に使う");
  // 状態のファイルが無ければ、--init でない限り何も呼ばずに止める（黙って初回にしない。i1）。ロックとディレクトリを作る前（続き 6 の U6）
  if (!init && !existsSync(statePath)) throw new InputError(stateMissing(statePath));
  // 同じ状態のファイルで別の照合が動いていれば、何も読まずに止める（状態を読む前にロックを取る。続き 5 の R1）
  acquireLock(statePath);
  const now = Date.now();
  const sinceOption =
    typeof values.since === "string" ? parseTime(values.since, now, "--since") : undefined;
  const until = typeof values.until === "string" ? parseTime(values.until, now, "--until") : now;
  // 読み始めの下限（--since が無ければ状態で後ろにずれうるので、決めたあとにもう一度確かめる）
  if (!((sinceOption ?? now - DEFAULT_LOOKBACK_DAYS * 86_400_000) < until) || until > now + 60_000)
    throw new InputError("--since < --until <= 今 にする");

  // 設定の issuer（プロバイダー。境界ごとに 1 つ）とチームの階層
  const configPath = process.env.AWSBRIDGE_CONSOLE_CONFIG || "config/console.json";
  if (!existsSync(configPath)) throw new InputError(`設定ファイルがありません: ${configPath}`);
  const { config } = parseConsoleConfig(readFileSync(configPath, "utf8"));
  const issuers = config.boundaries.map((b) => ({ url: b.issuer }));
  const teams = config.teams.map((t) => ({ name: t.name, tier: t.tier }));

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
  // 確認済みの区間と未解決の所見（読めない状態のファイルは、CloudTrail を読む前に止める）
  const { state, text: stateText } = readState(statePath, now);
  const row = accountStateOf(state, accountId);
  // 行の単位で判定する（別のアカウントの行だけでも止める。i1）
  if (row === undefined && !init) throw new InputError(stateMissing(statePath));
  if (row !== undefined && init)
    throw new InputError(
      `--init: this account already has a row in the reconcile state file (${statePath}); run without --init`,
    );
  const previousCoveredUntil = row?.coveredUntil;
  // 読み始め: --since が勝つ。無ければ max(今 − 6 日, min(確認済みの区間の終わり − 重なり, 未解決の最も古い時刻 − 重なり))
  const start = decideReadStart({
    now,
    since: sinceOption,
    coveredUntil: previousCoveredUntil,
    overlapSeconds,
    oldestAnchor: row?.unresolved?.oldestAt,
    // 確認済みの区間の無い行は 6 日を読み直す（読み始めが今 − 6 日より後なら誤り。続き 4 の (1)）
    lookbackRequired: row !== undefined && row.coveredUntil === undefined,
    // 時刻を持たない誤りを記録した実行の窓まで戻す（その範囲を読み直さないと消えない。続き 5 の R4）
    untimedStart: row?.coveredUntil !== undefined ? row.untimed?.firstWindowStart : undefined,
  });
  const since = start.since;
  // 時刻を持たない誤りの読み直せない範囲の始まり（確認済みの行は記録した窓の始まり、無い行は見張りの始まり。続き 5 の w3・w5）
  const untimedStart =
    row === undefined
      ? undefined
      : row.coveredUntil !== undefined
        ? row.untimed?.firstWindowStart
        : row.watchStart;
  const untimedGone =
    untimedStart !== undefined &&
    untimedStart < now - DEFAULT_LOOKBACK_DAYS * 86_400_000 &&
    since > untimedStart;
  // 受け入れるもの（前の実行までの錨・今回の coverage_gap・今回の untimed_not_covered）が無ければ読まずに止める（q1）
  if (
    acceptUnresolved &&
    row?.unresolved === undefined &&
    !(previousCoveredUntil !== undefined && since > previousCoveredUntil) &&
    !untimedGone
  )
    throw new InputError(
      "--accept-unresolved: nothing to accept (no unresolved findings recorded, and no coverage gap or untimed range that cannot be read in this run)",
    );
  if (sinceOption !== undefined && values["overlap-seconds"] !== undefined)
    console.error("--since があるので --overlap-seconds は使わない");
  if (!(since < until))
    throw new InputError(
      "読み始め（確認済みの区間の終わり − 重なり）が --until 以後になる。--since を渡すか --until を後ろにする",
    );
  const regions = await readEnabledRegions(run);
  const trail = await readAssumeEvents(run, regions, { since, until });

  // 発行記録（CloudTrail を読んだあとに読む: 記録の側が後になるので、期間の端の取りこぼしが少ない）
  let read: RecordRead;
  let apiCount: number | undefined;
  let incompleteReads: string[] = [];
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
    // api count は件数の経路（calculations の count）の合計。lines（読んだ行）がこれより少ない窓は誤り（record_read_incomplete）
    apiCount = q.count;
    incompleteReads = q.incomplete.map(formatIncompleteRead);
    read = recordsFromLogEvents(q.events, "api", { workers });
  } else read = fileRead as RecordRead;

  const raw = reconcile({
    records: read.records,
    events: trail.events,
    window: { since, until },
    now,
    accountId,
    issuers,
    teams,
    regions: { read: trail.read, unread: trail.unread },
    lines: { truncated: read.truncated, unreadable: read.unreadable, total: read.lines },
    incompleteReads,
    source: api ? "api" : "file",
    lagSeconds,
    retentionDays,
    clockSkewSeconds,
    ...(previousCoveredUntil !== undefined ? { previousCoveredUntil } : {}),
    ...(init ? { coverageBasis: "init" as const } : {}),
    ...(row !== undefined && row.coveredUntil === undefined
      ? { coverageBasis: "unconfirmed" as const }
      : {}),
    ...(row?.unresolved !== undefined ? { anchors: row.unresolved } : {}),
    ...(row?.accepted !== undefined ? { accepted: row.accepted } : {}),
    ...(row?.watchStart !== undefined ? { watchStart: row.watchStart } : {}),
    ...(row?.coveredUntil !== undefined && row.untimed !== undefined
      ? { untimed: row.untimed }
      : {}),
  });
  // 受け入れ（照合の実行と一体）: 下げても誤りが残れば適用しない
  let result = raw;
  let acceptedInterval: AcceptedInterval | undefined;
  let acceptNote: string | undefined;
  let acceptedLines: string | undefined;
  let outcome: AcceptanceOutcome | undefined;
  if (acceptUnresolved) {
    const oc = applyAcceptance(raw, {
      anchors: row?.unresolved,
      coveredUntil: previousCoveredUntil,
      untimedStart,
      untimedSettledUntil: row?.untimed?.settledUntil,
      untimedCodes: row?.untimed?.codes,
    });
    outcome = oc;
    if (oc.status === "nothing") throw new InputError("--accept-unresolved: nothing to accept");
    if (oc.status === "applied") {
      result = oc.result;
      acceptedInterval = { ...oc.interval, acceptedAt: now, reasonGiven: true };
      const iso = (t: number) => new Date(t).toISOString();
      const widthSeconds = Math.round((oc.interval.until - oc.interval.from) / 1000);
      const what = `${iso(oc.interval.from)} .. ${iso(oc.interval.until)} (width ${widthSeconds}s; unverified; not confirmed; ${Object.keys(
        oc.interval.codes,
      )
        .sort()
        .map((c) => `${c}=${oc.interval.codes[c]}`)
        .join(", ")}; reason: ${reason})`;
      // 書く前は「まだ書いていない」。accepted: は状態を書けたあとに出す（続き 5 の R5）
      acceptNote = `acceptance (not yet written): ${what}`;
      acceptedLines = `accepted: ${what}\n${ACCEPT_MEANING}${
        widthSeconds > overlapSeconds
          ? `\nWARN  the accepted interval (width ${widthSeconds}s) is wider than the overlap (${overlapSeconds}s): every finding with a time inside it is not an error from now on`
          : ""
      }`;
    } else if (oc.status === "resolved")
      acceptNote =
        "accept: nothing to lower; the unresolved findings were read again with no errors and are resolved by this run (no accepted interval recorded)";
    else acceptNote = `accept: not applied (${oc.reason})`;
  }
  const code = reconcileExitCode(result);
  console.log(formatReconcileReport(result, { label: `profile ${profile}`, apiCount, start }));
  if (acceptNote !== undefined) console.log(redactReconcile(acceptNote));
  const notSaved = acceptedInterval !== undefined ? "; the acceptance was not saved" : "";
  // 終了コード 0 なら区間を進めて未解決を消し、0 でなければ未解決を書く（coveredUntil は進めない。h2）。--init の実行は結果によらず行を書く（i2）。
  // 受け入れの適用は別の経路（acceptedAccountState。続き 4 の (3)）
  const nextRow =
    outcome?.status === "applied"
      ? acceptedAccountState(row, outcome, { acceptedAt: now })
      : nextAccountState(row, result, {
          now,
          // --init の見張りの始まり: --since の読み始め、無ければこの実行の終わり（続き 5 の w1）
          ...(init ? { watchStart: sinceOption ?? until } : {}),
        });
  // 書く前に読み直し、最初に読んだ内容と違えば書かない（ロックの外で書き換えられた。今回の所見は上で出した。続き 4 の (5)）
  if (readStateText(statePath) !== stateText)
    throw new InputError(
      `the reconcile state file changed while this run was running (${statePath}); this run's findings are above but were not saved${notSaved}. Another run may be using the same file: do not run the reconciliation at the same time with the same state file, then run again`,
    );
  try {
    writeStateFile(statePath, serializeReconcileState(withAccountState(state, accountId, nextRow)));
  } catch {
    throw new Error(
      `could not write the reconcile state file: ${statePath} (the confirmed interval and the unresolved findings were not saved${notSaved})`,
    );
  }
  if (code !== 0)
    console.log(
      `state: not advanced (exit code ${code}; the confirmed interval moves only on a run with exit code 0; the unresolved findings are kept in ${statePath})`,
    );
  else
    console.log(
      `state: confirmed until ${new Date(nextRow.coveredUntil as number).toISOString()} (${statePath})`,
    );
  if (acceptedLines !== undefined) console.log(redactReconcile(acceptedLines));
  for (const line of formatStateLines(nextRow)) console.log(line);
  return code;
}

/** 取ったロックのファイル（自分が作ったものだけ。他者のロックは消さない）。 */
let heldLock: string | undefined;

function releaseLock(): void {
  if (heldLock === undefined) return;
  const lock = heldLock;
  heldLock = undefined;
  try {
    rmSync(lock, { force: true });
  } catch {
    // 消せなくても終わる（次の実行が止まり、文で知らせる）
  }
}

// 正常・誤り・実行できない（process.exit）では exit で消す。SIGINT・SIGTERM は消してから元の終わり方で終わる（続き 6 の U5）。
// SIGKILL や電源断では消せないので、残ったロックの扱いは README（照合が動いていないことを確かめてから消す）
process.on("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    releaseLock();
    process.kill(process.pid, signal);
  });

/**
 * 状態のファイルの隣のロック（<state>.lock）を排他で作る（中身は pid と開始時刻だけ。続き 5 の R1）。あれば、同じ状態のファイルで
 * 別の照合が動いているので止める（終了コード 2）。作れた時点で所有を記録し、中身の書き込みに失敗しても消す（続き 6 の U5）。
 * 書く前の読み直し（続き 4 の (5)）は、ロックを守らない書き手への検知として残す。
 */
function acquireLock(statePath: string): void {
  const lock = `${statePath}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new InputError(
        `another reconciliation is running with the same state file (lock: ${lock}). If none is running, check the lock file and remove it`,
      );
    throw e;
  }
  heldLock = lock;
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } finally {
    closeSync(fd);
  }
}

/** 受け入れの意味（出力と --help。続き 4 の A1）。 */
const ACCEPT_MEANING =
  "an interval is accepted, not findings: every finding with a time inside it, including ones not recorded before, is not an error from now on";

/** --help の説明（使い方の行のあと）。 */
const HELP = [
  "  --init                          the first run for an account with no row in the state file (a person runs it; not in any scheduled run)",
  "  --accept-unresolved --reason <text>",
  "                                  accepts an interval, not findings: the interval spans the unresolved findings recorded by earlier runs",
  "                                  and this run's coverage gap; every finding with a time inside it, including ones not recorded before,",
  "                                  is not an error from now on (a person runs it with a reason; not in any scheduled run;",
  "                                  it cannot be used with --until)",
  "  exit codes: 0 no errors / 1 errors or unverifiable assumptions / 2 could not run",
];

/** 状態の行が無いときの文（2 つの道。実値なし。i4）。 */
function stateMissing(path: string): string {
  return [
    `state_missing: the reconcile state file has no row for this account (${path}); refusing to treat this as a first run.`,
    "  - If this account was reconciled on another machine, move the whole state file from there (--state <file>).",
    "  - Only if this is really the first run for this account, a person runs it once with --init.",
  ].join("\n");
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
