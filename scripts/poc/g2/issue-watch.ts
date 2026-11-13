// G2 の発行の見張り（mise タスク poc:g2:issue-watch）。手順書 §2.6・§3.6（追 1）・ii-1d。**Adm 枠では回さない**。
//   pnpm tsx scripts/poc/g2/issue-watch.ts --portal https://awsbridge-console.<dev> --team <team> --account <12 桁> --role <ロール>
//     [--cookie-file <g2 dir>/cookies/<team>.txt] [--interval 30] [--count 0] [--duration 15m] [--region <r>] [--keep-cookie]
//     [--since <ISO>]
// 利用者がブラウザから写した Access の Cookie（CF_Authorization の値か Cookie 行。1 行）で、回ごとに
//   GET <portal>/t/<team>/a/<account>?role=<role>（フォームの CSRF を取る）→ POST <portal>/t/<team>/login
// を行い、時刻・HTTP の状態・エラーコードを 1 行ずつ出す（成功は AWS のサインインへの 302 = issued）。リダイレクトは追わない。
// Cookie・CSRF・Location（サインインのトークン）・アカウント ID は、標準出力・記録（<g2 dir>/records/issue-watch-*.jsonl）に出さない。
// Cookie のファイルは <g2 dir>/cookies/ の下だけを受け付け、終わったら（正常・失敗・例外・SIGINT・SIGTERM・SIGHUP のどれでも）消して、
// 名前と時刻を出す。SIGKILL では消せないので、そのときは手で消す。
// 残すときは --keep-cookie。本物の Administrator（--role administrator）は断る。
// 注意: POST のたびにポータルが本当に発行する（STS の引き受けと getSigninToken）。間隔を短くしすぎない。
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { writeSecret } from "../human/io";
import { cookieHeader } from "../human/portal/watch-lib";
import { formatWatchSummary, type Sample, summarizeSamples } from "../human/watch";
import { fileStamp, g2Settings, parseDuration } from "./common";
import {
  assertCookieFile,
  assertWatchRole,
  classifyAccountPage,
  classifyLogin,
  type IssueTarget,
  loginBody,
  parseIssueTarget,
} from "./issue-lib";

const g2 = g2Settings(process.env);
let cookieFile: string | undefined;
let keepCookie = false;

/** Cookie のファイルを消す（受け付けたあとはどの終わり方でも呼ぶ）。 */
function cleanupCookie(): void {
  if (cookieFile === undefined) return;
  const f = cookieFile;
  cookieFile = undefined;
  if (keepCookie) {
    console.log(`Cookie のファイルを残しました: ${basename(f)}（使い終わったら消してください）`);
    return;
  }
  rmSync(f, { force: true });
  console.log(`Cookie のファイルを消しました: ${basename(f)} ${new Date().toISOString()}`);
}

// どの終わり方でも Cookie を残さない（例外・process.exit の経路。cleanupCookie は同期で、2 回目は何もしない）
process.on("exit", () => cleanupCookie());

function die(message: string): never {
  console.error(message);
  cleanupCookie();
  process.exit(1);
}

let values: Record<string, string | boolean | undefined>;
try {
  values = parseArgs({
    options: {
      portal: { type: "string" },
      team: { type: "string" },
      account: { type: "string" },
      role: { type: "string" },
      "cookie-file": { type: "string" },
      interval: { type: "string", default: "30" },
      count: { type: "string", default: "0" },
      duration: { type: "string", default: "15m" },
      region: { type: "string" },
      "keep-cookie": { type: "boolean", default: false },
      since: { type: "string" },
    },
  }).values;
} catch (e) {
  die((e as Error).message);
}
const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
keepCookie = values["keep-cookie"] === true;

// 1. Cookie のファイル（置き場所を確かめてから受け付ける。受け付けたら以降はどの終わり方でも消す）
const team = str("team") ?? die("--team を指定してください");
try {
  cookieFile = assertCookieFile(
    str("cookie-file") ?? join(g2.cookiesDir, `${team}.txt`),
    g2.cookiesDir,
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (!existsSync(cookieFile)) {
  console.error(`Cookie のファイルがありません: ${basename(cookieFile)}`);
  process.exit(1);
}

// 2. 対象と間隔（Administrator は断る）
let target: IssueTarget;
let intervalSeconds: number;
let durationSeconds: number;
let count: number;
let since: Date | undefined;
let cookie: string;
try {
  target = parseIssueTarget({
    portal: str("portal") ?? die("--portal を指定してください"),
    team,
    account: str("account") ?? die("--account を指定してください"),
    role: assertWatchRole(str("role") ?? die("--role を指定してください")),
  });
  intervalSeconds = parseDuration(str("interval") ?? "30", "--interval");
  durationSeconds = parseDuration(str("duration") ?? "15m", "--duration");
  count = Number(str("count") ?? "0");
  if (!Number.isInteger(count) || count < 0)
    throw new Error("--count は 0 以上の整数（0 = 期間まで）");
  if (str("since") !== undefined) {
    since = new Date(str("since") as string);
    if (Number.isNaN(since.getTime())) throw new Error("--since は ISO 8601 の時刻");
  }
  const region = str("region");
  if (region !== undefined && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
    throw new Error("--region の形が違う");
  const mode = statSync(cookieFile).mode & 0o777;
  if (mode & 0o077)
    console.warn(`警告: Cookie のファイルの権限が ${mode.toString(8)} です（600 にしてください）`);
  cookie = cookieHeader(readFileSync(cookieFile, "utf8"));
} catch (e) {
  die((e as Error).message);
}
const region = str("region");

const record = join(g2.dir, "records", `issue-watch-${fileStamp()}.jsonl`);
writeSecret(record, "");
const samples: Sample[] = [];

function finish(reason: string): never {
  console.log("");
  console.log(`止めた理由: ${reason}`);
  console.log(formatWatchSummary(summarizeSamples(samples, since)));
  console.log(`記録: ${record}`);
  cleanupCookie();
  process.exit(0);
}
process.on("SIGINT", () => finish("interrupted"));
process.on("SIGTERM", () => finish("terminated"));
process.on("SIGHUP", () => finish("hangup"));

async function request(
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<{ status: number; location: string | null; body: string }> {
  const headers: Record<string, string> = { cookie, accept: "text/html" };
  if (method === "POST") {
    headers.origin = target.origin;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(`${target.origin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

/** 1 回分: GET で CSRF → POST。出すのは状態とコードだけ。 */
async function round(): Promise<{ sample: Sample; line: string; extra: Record<string, number> }> {
  const at = new Date().toISOString();
  const extra: Record<string, number> = {};
  try {
    const page = await request("GET", target.accountPath);
    extra.getStatus = page.status;
    const p = classifyAccountPage(page);
    if (!p.ok)
      return {
        sample: { at, target: team, ok: false, code: p.code },
        line: `${at} team=${team} get=${page.status} ${p.code}`,
        extra,
      };
    const res = await request(
      "POST",
      target.loginPath,
      loginBody(target.account, target.role, p.csrf, region),
    );
    extra.postStatus = res.status;
    const l = classifyLogin(res);
    return {
      sample: l.ok
        ? { at, target: team, ok: true, code: l.code }
        : { at, target: team, ok: false, code: l.code },
      line: `${at} team=${team} get=${page.status} post=${res.status} ${l.code}`,
      extra,
    };
  } catch (e) {
    const code = (e as Error).name === "TimeoutError" ? "Timeout" : "network_error";
    return {
      sample: { at, target: team, ok: false, code },
      line: `${at} team=${team} ${code}`,
      extra,
    };
  }
}

console.log(
  `見張り: team=${team} ${intervalSeconds} 秒おき、${count === 0 ? `${durationSeconds} 秒まで` : `${count} 回`}（Ctrl-C で止める）`,
);
const started = Date.now();
for (let i = 0; ; i++) {
  const roundStart = Date.now();
  const r = await round();
  samples.push(r.sample);
  appendFileSync(record, `${JSON.stringify({ ...r.sample, ...r.extra })}\n`);
  console.log(r.line);
  if (count > 0 && i + 1 >= count) finish("count");
  if (count === 0 && (Date.now() - started) / 1000 >= durationSeconds) finish("duration");
  const wait = roundStart + intervalSeconds * 1000 - Date.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}
