// PoC N6（K1・K3・K5）: Worker の /poc/login（KMS で署名 → STS → getSigninToken）か /poc/sign（KMS の Sign だけ）を呼び、
// 結果と所要時間を 1 行ずつ出し、最後に集計（件数・最小・中央値・p90・最大・平均。1 回目は別に出す）を出す。
// 記録は <OUT_DIR>/runs.jsonl に追記する（JWT・認証情報・SigninToken は Worker が返さないので入らない）。
// オプション: --mode login|sign（既定 login）、--key rsa|ec|rsa-next（既定 rsa）、--n 回数（既定 1）、
//            --interval-ms 回の間隔（既定 0）、--no-federation（login で getSigninToken を呼ばない）、--note 記録に付けるメモ
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail } from "../human/io";
import { MAX_SIGN_COUNT } from "./handler";
import { callWorker, loadSettings, readCallerToken, requireIssuer } from "./io";
import { timingStats } from "./lib";
import { maskIds } from "./ops";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "login" },
    key: { type: "string", default: "rsa" },
    n: { type: "string", default: "1" },
    "interval-ms": { type: "string", default: "0" },
    "no-federation": { type: "boolean", default: false },
    note: { type: "string", default: "" },
    variant: { type: "string" },
  },
});
const mode = values.mode;
if (mode !== "login" && mode !== "sign") fail("--mode は login か sign");
const n = Number(values.n);
if (!Number.isInteger(n) || n < 1 || n > 200) fail("--n は 1〜200");
const interval = Number(values["interval-ms"]);
const s = loadSettings();
const issuer = requireIssuer(s);
const token = readCallerToken(s);
const log = join(s.outDir, "runs.jsonl");
const runId = new Date().toISOString();

function record(line: Record<string, unknown>): void {
  appendFileSync(log, `${JSON.stringify({ runId, mode, note: values.note, ...line })}\n`, {
    mode: 0o600,
  });
}

const fmt = (v: unknown) => (typeof v === "number" ? `${v}ms` : "-");

if (mode === "sign") {
  const samples: number[] = [];
  let remaining = n;
  let i = 0;
  while (remaining > 0) {
    const count = Math.min(remaining, MAX_SIGN_COUNT);
    const r = await callWorker(issuer, token, "/poc/sign", {
      key: values.key,
      count,
      ...(values.variant ? { variant: values.variant } : {}),
    });
    if (r.status !== 200) fail(`HTTP ${r.status}: ${maskIds(JSON.stringify(r.body))}`);
    const results = (r.body.results as Record<string, unknown>[]) ?? [];
    for (const x of results) {
      i++;
      record({ i, key: values.key, alg: r.body.alg, colo: r.body.colo, ...x });
      console.log(
        `#${i} ${x.ok ? "OK" : `NG ${x.code}`} sign=${fmt(x.ms)} colo=${r.body.colo} kmsRequestId=${x.kmsRequestId}`,
      );
      if (x.ok && typeof x.ms === "number") samples.push(x.ms);
    }
    remaining -= count;
  }
  console.log(`\n集計（Worker から見た KMS の Sign の往復、ミリ秒。key=${values.key}）`);
  console.log(`  1 回目: ${samples[0] ?? "-"}`);
  console.log(`  2 回目以降: ${JSON.stringify(timingStats(samples.slice(1)))}`);
  console.log(`  全体: ${JSON.stringify(timingStats(samples))}`);
  process.exit(samples.length === n ? 0 : 1);
}

const cols = ["signMs", "stsMs", "federationMs", "totalMs", "clientMs"] as const;
const series: Record<(typeof cols)[number], number[]> = {
  signMs: [],
  stsMs: [],
  federationMs: [],
  totalMs: [],
  clientMs: [],
};
let okCount = 0;
for (let i = 1; i <= n; i++) {
  const r = await callWorker(issuer, token, "/poc/login", {
    key: values.key,
    federation: !values["no-federation"],
  });
  const b: Record<string, unknown> = { ...r.body, clientMs: r.clientMs, httpStatus: r.status };
  record({ i, ...b });
  if (b.ok === true) {
    okCount++;
    for (const c of cols) if (typeof b[c] === "number") series[c].push(b[c] as number);
  }
  console.log(
    maskIds(
      `#${i} ${b.ok ? "OK" : `NG stage=${b.stage} code=${b.code}`} key=${b.key} alg=${b.alg} kid=${String(b.kid).slice(0, 8)}… ` +
        `sign=${fmt(b.signMs)} sts=${fmt(b.stsMs)} fed=${fmt(b.federationMs)} total=${fmt(b.totalMs)} client=${fmt(b.clientMs)} ` +
        `colo=${b.colo} sourceIdentity=${b.sourceIdentity ?? "-"} at=${b.startedAt} kmsRequestId=${b.kmsRequestId ?? "-"} stsRequestId=${b.stsRequestId ?? "-"}`,
    ),
  );
  if (interval > 0 && i < n) await new Promise((res) => setTimeout(res, interval));
}
if (n > 1) {
  console.log(
    `\n集計（成功 ${okCount}/${n}、ミリ秒。sign/sts/fed/total は Worker から見た値、client は手元から見た往復）`,
  );
  for (const c of cols)
    console.log(
      `  ${c}: 1 回目=${series[c][0] ?? "-"} 2 回目以降=${JSON.stringify(timingStats(series[c].slice(1)))}`,
    );
}
process.exit(okCount === n ? 0 : 1);
