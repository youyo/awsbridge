// N10: 所属を外した人が拒否されるまでの時間を測る見張り。ブラウザの Access の Cookie（CF_Authorization）で
// <portal>/t/<チーム>/whoami を数秒おきに叩き、成否と Access JWT の iat（トークンの取り直し）を記録する。
// この見張りは Access のログイン（IdP）をやり直せないので、「今のトークンが受け付けられなくなる時刻」を測る。
// アプリのセッションが切れたあとに所属が取り直されるか（ポリシーの再評価）は、ブラウザで /t/<チーム>/?refresh=30 を開いて見る。
//
// Cookie: AWSBRIDGE_HUMAN_POC_PORTAL_COOKIE_FILE（既定 <OUT_DIR>/access-cookie.txt、権限 600）に、CF_Authorization の値か
//         Cookie 行（Binding cookie を有効にしたときは CF_Binding も）を 1 行で置く。中身は記録・画面に出さない。
// オプション: --team <チーム>（複数可）--interval <秒>（既定 5）--timeout <秒>（既定 15）--max-rounds <回>（既定 無制限）
//            --summarize <記録.jsonl> [--since <ISO 時刻>]（記録を読み直すだけ。HTTP を呼ばない）
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { markdownTable } from "../cases";
import { fail, required, writeSecret } from "../io";
import { formatWatchSummary, parseSamples, type Sample, summarizeSamples } from "../watch";
import { loadSettings, localOverride } from "./io";
import { teamFromPath } from "./lib";
import { BASE_VARS } from "./settings";
import { classifyWhoami, cookieHeader, tokenRefreshes } from "./watch-lib";

let values: {
  team?: string[] | undefined;
  interval?: string | undefined;
  timeout?: string | undefined;
  "max-rounds"?: string | undefined;
  summarize?: string | undefined;
  since?: string | undefined;
};
try {
  values = parseArgs({
    options: {
      team: { type: "string", multiple: true },
      interval: { type: "string", default: "5" },
      timeout: { type: "string", default: "15" },
      "max-rounds": { type: "string" },
      summarize: { type: "string" },
      since: { type: "string" },
    },
  }).values;
} catch (e) {
  fail((e as Error).message);
}

function report(samples: Sample[], since: Date | undefined): void {
  console.log(formatWatchSummary(summarizeSamples(samples, since)));
  console.log("");
  console.log("Access JWT の取り直し（iat が変わった時刻。最初の観測を含む）:");
  console.log(
    markdownTable(
      ["対象", "観測した時刻", "iat（UTC）"],
      tokenRefreshes(samples).map((r) => [
        r.target,
        r.at,
        `${r.iat}（${new Date(r.iat * 1000).toISOString()}）`,
      ]),
    ),
  );
}

let since: Date | undefined;
if (values.since !== undefined) {
  since = new Date(values.since);
  if (Number.isNaN(since.getTime())) fail("--since は ISO 8601 の時刻");
}

if (values.summarize !== undefined) {
  report(parseSamples(readFileSync(values.summarize, "utf8")), since);
  process.exit(0);
}

const s = loadSettings();
const base = localOverride("AWSBRIDGE_HUMAN_POC_PORTAL_WATCH_BASE") ?? required(s.base, BASE_VARS);
const teams = values.team ?? [];
if (teams.length === 0) fail("--team を 1 つ以上指定してください");
for (const t of teams) if (teamFromPath(`/t/${t}`) !== t) fail(`不正なチーム名: '${t}'`);
const interval = Number(values.interval);
const timeout = Number(values.timeout);
const maxRounds =
  values["max-rounds"] === undefined ? Number.POSITIVE_INFINITY : Number(values["max-rounds"]);
if (!(interval > 0) || !(timeout > 0) || !(maxRounds > 0))
  fail("--interval / --timeout / --max-rounds は正の数");

let cookie: string;
try {
  const mode = statSync(s.cookieFile).mode & 0o777;
  if (mode & 0o077)
    console.warn(`警告: Cookie のファイルの権限が ${mode.toString(8)} です（600 にしてください）`);
  cookie = cookieHeader(readFileSync(s.cookieFile, "utf8"));
} catch (e) {
  fail(`Cookie のファイルを読めません: ${s.cookieFile}（${(e as Error).message}）`);
}

const record = join(
  s.outDir,
  `access-watch-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
writeSecret(record, "");
console.error(`記録: ${record}（Ctrl-C で止めて要約を出す）`);
const samples: Sample[] = [];

async function probe(team: string): Promise<Sample> {
  const at = new Date().toISOString();
  try {
    const res = await fetch(`${base}/t/${team}/whoami`, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeout * 1000),
    });
    const c = classifyWhoami({
      status: res.status,
      location: res.headers.get("location"),
      body: await res.text(),
    });
    return { at, target: team, ...c };
  } catch (e) {
    return {
      at,
      target: team,
      ok: false,
      code: (e as Error).name === "TimeoutError" ? "Timeout" : "network_error",
    };
  }
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
for (let round = 0; round < maxRounds && !stopping; round++) {
  const got = await Promise.all(teams.map(probe));
  for (const g of got) {
    samples.push(g);
    appendFileSync(record, `${JSON.stringify(g)}\n`);
    console.error(`${g.at} ${g.target} ${g.ok ? "OK" : g.code} ${g.detail ?? ""}`);
  }
  if (round + 1 < maxRounds && !stopping) await new Promise((r) => setTimeout(r, interval * 1000));
}
report(samples, since);
