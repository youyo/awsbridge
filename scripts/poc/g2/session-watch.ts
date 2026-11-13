// G2 のセッションの見張り（mise タスク poc:g2:session-watch）。手順書 §2.6・ii-1c・ii-5・追 1。
//   pnpm tsx scripts/poc/g2/session-watch.ts --profile <名前> [--profile <名前> ...] [--operation "s3api list-buckets"]
//     [--interval 10] [--count 0] [--duration 0] [--timeout 30] [--since <ISO>]
// aws login などのプロファイルで、読み取りの操作（既定 s3api list-buckets）を N 秒おきに呼び、時刻・成否・エラーコードを 1 行ずつ出す。
// 最後にプロファイルごとの「最後の成功」「最初の失敗」を表で出す（Ctrl-C でも）。最初の失敗のあとも止めない（認証情報の更新で戻ることがあるため）。
// aws の標準出力（バケット名など）は読まずに捨てる。失敗の要約（伏せ字）は記録（<g2 dir>/records/session-watch-*.jsonl）にだけ書く。
// sts get-caller-identity は明示の Deny で止まらないので既定にしない（指定すると警告を出す）。
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail, writeSecret } from "../human/io";
import { parseCliErrorCode } from "../human/ops";
import { failureDetail, formatWatchSummary, type Sample, summarizeSamples } from "../human/watch";
import { fileStamp, g2Settings, parseDuration } from "./common";
import { DEFAULT_OPERATION, parseOperation, parseProfiles } from "./session-lib";

let values: Record<string, string | string[] | boolean | undefined>;
try {
  values = parseArgs({
    options: {
      profile: { type: "string", multiple: true },
      operation: { type: "string", default: DEFAULT_OPERATION },
      interval: { type: "string", default: "10" },
      count: { type: "string", default: "0" },
      duration: { type: "string", default: "0" },
      timeout: { type: "string", default: "30" },
      since: { type: "string" },
    },
  }).values;
} catch (e) {
  fail((e as Error).message);
}

let profiles: string[];
let operation: ReturnType<typeof parseOperation>;
let intervalSeconds: number;
let durationSeconds: number;
let timeoutSeconds: number;
let count: number;
let since: Date | undefined;
try {
  profiles = parseProfiles((values.profile as string[] | undefined) ?? []);
  operation = parseOperation(String(values.operation));
  intervalSeconds = parseDuration(String(values.interval), "--interval");
  durationSeconds = parseDuration(String(values.duration), "--duration");
  timeoutSeconds = parseDuration(String(values.timeout), "--timeout");
  if (timeoutSeconds <= 0) throw new Error("--timeout は正の秒数");
  count = Number(values.count);
  if (!Number.isInteger(count) || count < 0) throw new Error("--count は 0 以上の整数");
  if (typeof values.since === "string") {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) throw new Error("--since は ISO 8601 の時刻");
  }
} catch (e) {
  fail((e as Error).message);
}
if (operation.warning) console.warn(operation.warning);

/** プロファイルで操作を 1 回呼ぶ。標準出力は捨て、成否とエラーコードだけを返す。 */
function call(profile: string): Promise<{ ok: boolean; code?: string; detail?: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
  ])
    delete env[k];
  return new Promise((resolve) => {
    execFile(
      "aws",
      [...operation.args, `--profile=${profile}`, "--output", "json", "--no-cli-pager"],
      { env, timeout: timeoutSeconds * 1000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err === null) return resolve({ ok: true });
        const timedOut = (err as { killed?: boolean }).killed === true;
        resolve({
          ok: false,
          code: timedOut ? "Timeout" : parseCliErrorCode(stderr),
          detail: failureDetail(stderr).replace(/(?<!\d)\d{12}(?!\d)/g, "<account>"),
        });
      },
    );
  });
}

const record = join(g2Settings(process.env).dir, "records", `session-watch-${fileStamp()}.jsonl`);
writeSecret(record, "");
const samples: Sample[] = [];

function finish(reason: string): never {
  console.log("");
  console.log(`止めた理由: ${reason}`);
  console.log(formatWatchSummary(summarizeSamples(samples, since)));
  console.log(`記録: ${record}`);
  process.exit(0);
}
process.on("SIGINT", () => finish("interrupted"));

console.log(
  `見張り: ${profiles.join(", ")}（${operation.args.join(" ")}、${intervalSeconds} 秒おき、${
    count > 0 ? `${count} 回` : durationSeconds > 0 ? `${durationSeconds} 秒まで` : "Ctrl-C まで"
  }）`,
);
const started = Date.now();
for (let i = 0; ; i++) {
  const roundStart = Date.now();
  const at = new Date(roundStart).toISOString();
  const results = await Promise.all(profiles.map((p) => call(p)));
  const parts: string[] = [];
  profiles.forEach((p, j) => {
    const o = results[j] as { ok: boolean; code?: string; detail?: string };
    const sample: Sample = o.ok
      ? { at, target: `profile:${p}`, ok: true }
      : {
          at,
          target: `profile:${p}`,
          ok: false,
          code: o.code as string,
          ...(o.detail ? { detail: o.detail } : {}),
        };
    samples.push(sample);
    appendFileSync(record, `${JSON.stringify(sample)}\n`);
    parts.push(`${p}=${o.ok ? "OK" : o.code}`);
  });
  console.log(`${at} ${parts.join(" ")}`);
  if (count > 0 && i + 1 >= count) finish("count");
  if (count === 0 && durationSeconds > 0 && (Date.now() - started) / 1000 >= durationSeconds)
    finish("duration");
  const wait = roundStart + intervalSeconds * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
