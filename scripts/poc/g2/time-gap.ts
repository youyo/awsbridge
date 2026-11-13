// G2 の時間差の集計（mise タスク poc:g2:time-gap）。手順書 §3.2 の 6（ii-2）。読み取りだけ。
//   pnpm tsx scripts/poc/g2/time-gap.ts --records <file|dir> (--profile <AWS のプロファイル> | --trail <file>)
//     [--since <ISO>] [--until <ISO>] [--workers awsbridge-console-standard,awsbridge-console-admin]
// 発行記録（console:reconcile の --records と同じ形: 生の行・Trace Events の包み・Workers Logs のイベント。.gz も読む）と、
// CloudTrail の AssumeRoleWithWebIdentity を jti で結び、差（eventTime − jwt.iat。秒）の分布（件数・最小・中央値・p90・最大）を出す。
// CloudTrail の読み方は console:reconcile と同じ（scripts/console/reconcile-read.ts。有効な全リージョン、呼ぶのは照会の aws だけ）。
// --trail は aws cloudtrail lookup-events の出力（{"Events":[...]}）か、その Events の配列のファイル（aws を呼ばない）。
// 既定の期間: 記録の最初の発行の 15 分前から、最後の発行の 30 分後まで。
// 出力は件数と秒数だけ（jti・アカウント ID・email を出さない）。読めなかったリージョンがあれば終了コード 1。
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  type AssumeEvent,
  mergeRecordReads,
  parseAssumeEvent,
  type RecordRead,
  readRecordLines,
} from "../../../src/console/reconcile-input";
import {
  type AwsRun,
  guardRun,
  readAssumeEvents,
  readEnabledRegions,
} from "../../console/reconcile-read";
import { fail } from "../human/io";
import { formatTimeGap, pairGaps } from "./time-gap-lib";

const DEFAULT_WORKERS = ["awsbridge-console-standard", "awsbridge-console-admin"];
const PROFILE_RE = /^[\w.+@][\w.+@-]{0,63}$/;

let values: Record<string, string | undefined>;
try {
  values = parseArgs({
    options: {
      records: { type: "string" },
      profile: { type: "string" },
      trail: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      workers: { type: "string" },
    },
  }).values as Record<string, string | undefined>;
} catch (e) {
  fail((e as Error).message);
}

function readRecords(path: string, workers: readonly string[]): RecordRead {
  if (!existsSync(path)) fail(`記録がありません: ${basename(path)}`);
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .map((f) => join(path, f))
        .filter((f) => statSync(f).isFile())
        .sort()
    : [path];
  return mergeRecordReads(
    files.map((f) => {
      const raw = readFileSync(f);
      const text = new TextDecoder("utf-8").decode(f.endsWith(".gz") ? gunzipSync(raw) : raw);
      return readRecordLines(text, basename(f), { workers });
    }),
  );
}

function parseTime(v: string | undefined, label: string): number | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(t)) fail(`${label} は ISO 8601 の時刻`);
  return t;
}

/** aws CLI を `aws <args> --profile=<p> --output json` で呼ぶ（シェルを通さない。lookup-events は長くかかりうる）。 */
function awsRunner(profile: string): AwsRun {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "aws",
        [...args, `--profile=${profile}`, "--output", "json"],
        { env: process.env, timeout: 600_000, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(new Error(`aws ${args[0]} ${args[1]} failed`));
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

function readTrailFile(path: string): AssumeEvent[] {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`CloudTrail のファイルを読めません: ${basename(path)}`);
  }
  const list = Array.isArray(v) ? v : (v as { Events?: unknown })?.Events;
  if (!Array.isArray(list))
    fail("CloudTrail のファイルは lookup-events の出力（Events）か、その配列");
  const out: AssumeEvent[] = [];
  for (const e of list) {
    const raw =
      typeof e === "object" && e !== null && "CloudTrailEvent" in e ? e.CloudTrailEvent : e;
    try {
      out.push(parseAssumeEvent(raw));
    } catch {
      // AssumeRoleWithWebIdentity でない・読めないイベントは飛ばす
    }
  }
  return out;
}

const recordsPath = values.records ?? fail("--records を指定してください");
if ((values.profile === undefined) === (values.trail === undefined))
  fail(
    "--profile（CloudTrail を aws で読む）か --trail（lookup-events の出力のファイル）のどちらか 1 つを指定してください",
  );
const workers = values.workers?.split(",").map((w) => w.trim()) ?? DEFAULT_WORKERS;
const read = readRecords(recordsPath, workers);
if (read.records.length === 0) fail("発行記録が 1 件もありません");
console.log(
  `records file lines: ${read.lines}（読めない ${read.unreadable.length}・切られた ${read.truncated.length}）`,
);

let events: AssumeEvent[];
let unread = 0;
if (values.trail !== undefined) {
  events = readTrailFile(values.trail);
} else {
  const profile = values.profile as string;
  if (!PROFILE_RE.test(profile)) fail(`不正なプロファイル名: '${profile}'`);
  const ats = read.records.map((r) => r.at);
  const since = parseTime(values.since, "--since") ?? Math.min(...ats) - 15 * 60_000;
  const until = parseTime(values.until, "--until") ?? Math.max(...ats) + 30 * 60_000;
  if (since >= until) fail("--since は --until より前にする");
  const run = guardRun(awsRunner(profile));
  try {
    const regions = await readEnabledRegions(run);
    const r = await readAssumeEvents(run, regions, { since, until });
    events = r.events;
    unread = r.unread.length;
    console.log(`regions: read ${r.read.length}/${regions.length}`);
    console.log(`window: ${new Date(since).toISOString()} .. ${new Date(until).toISOString()}`);
  } catch (e) {
    fail((e as Error).message);
  }
}

console.log(formatTimeGap(pairGaps(read.records, events)));
if (unread > 0) {
  console.log(`読めなかったリージョンが ${unread} あります（分布は欠けている可能性がある）`);
  process.exitCode = 1;
}
