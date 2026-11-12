// PoC P4（緊急停止）の見張り: 数秒おきに固定の無害な API（s3:ListBuckets）を対象ごとに並べて呼び、
// 時刻・成否・エラーコードを記録する。最後に対象ごとの「最後の成功」「最初の失敗」を表で出す。
// 認証情報は標準出力・記録に出さない（記録は <OUT_DIR>/stop-watch-<時刻>.jsonl）。
//
// 対象（複数指定・組み合わせ可）:
//   --credentials <file>   console-url が書いた認証情報ファイル（credentials*.json）。環境変数で aws に渡す（引数には載せない）
//   --profile <name>       AWS プロファイル（aws login のプロファイルなど）。AWS_CONFIG_FILE / AWS_LOGIN_CACHE_DIRECTORY はそのまま引き継ぐ
//   --assume <ロール>[:second]   毎回 JWT を署名して引き受け直し、新しい認証情報で呼ぶ（新しい引き受けが止まるかを見る）。
//                          ロールは base / tagged / notag / localonly / viewer。:second を付けると 2 人目
//                          （AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT）の subject・SourceIdentity で引き受ける（(4-b) の対照）
//   複数の --credentials（例 credentials-tagged.json と credentials-tagged-second.json）を同時に見張れる
// オプション:
//   --interval <秒>        間隔（既定 5。0 も可）
//   --count <回>           回数（既定 0 = Ctrl-C まで）。Ctrl-C でも要約を出して終わる
//   --since <ISO 8601>     revoke などの操作の時刻（revoke.ts が出す「完了」の時刻）。最初の失敗までの秒数を出す
//   --access-profile <値>  --assume tagged のタグ（既定 poc-admin。SourceIdentity は subject）
//   --timeout <秒>         1 回の API 呼び出しの時間切れ（既定 30。超えたら Timeout として記録）
//   --summarize <jsonl>    見張らずに、記録を読み直して要約だけ出す（aws は呼ばない）。--since と組み合わせて、
//                          見張りの開始時には分からなかった操作の時刻から最初の失敗までの秒数を出す
// 最初の失敗のあとも止めない（aws login の認証情報の更新で戻ることがあるため）。失敗の要約（伏せ字）も記録する。
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Outcome } from "./cases";
import {
  assumeWithClaims,
  fail,
  probeApi,
  required,
  roleArnOf,
  stackOutputs,
  writeSecret,
} from "./io";
import {
  assumeClaimsFor,
  humanPocSettings,
  type RoleKey,
  subjectFor,
  type TemporaryCredentials,
} from "./lib";
import { credentialsEnv } from "./ops";
import {
  failureDetail,
  formatWatchSummary,
  parseSamples,
  parseWatchTargets,
  type Sample,
  summarizeSamples,
  type WatchTarget,
} from "./watch";

let values: ReturnType<typeof parse>["values"];
function parse() {
  return parseArgs({
    options: {
      credentials: { type: "string", multiple: true },
      profile: { type: "string", multiple: true },
      assume: { type: "string", multiple: true },
      interval: { type: "string", default: "5" },
      count: { type: "string", default: "0" },
      since: { type: "string" },
      "access-profile": { type: "string", default: "poc-admin" },
      timeout: { type: "string", default: "30" },
      summarize: { type: "string" },
    },
  });
}
try {
  values = parse().values;
} catch (e) {
  fail((e as Error).message);
}

let since: Date | undefined;
if (values.since !== undefined) {
  since = new Date(values.since);
  if (!/^\d{4}-\d\d-\d\dT/.test(values.since) || Number.isNaN(since.getTime()))
    fail("--since は ISO 8601 の時刻（例 2026-11-11T01:02:03Z）");
}

if (values.summarize !== undefined) {
  let text: string;
  try {
    text = readFileSync(values.summarize, "utf8");
  } catch {
    fail(`記録を読めません: ${values.summarize}`);
  }
  console.log(formatWatchSummary(summarizeSamples(parseSamples(text), since)));
  process.exit(0);
}

let targets: WatchTarget[];
try {
  targets = parseWatchTargets(values);
} catch (e) {
  fail((e as Error).message);
}
const interval = Number(values.interval);
const count = Number(values.count);
const timeoutMs = Number(values.timeout) * 1000;
if (!Number.isFinite(interval) || interval < 0) fail("--interval は 0 以上の秒数");
if (!Number.isInteger(count) || count < 0) fail("--count は 0 以上の整数（0 = Ctrl-C まで）");
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout は正の秒数");

let settings: ReturnType<typeof humanPocSettings>;
try {
  settings = humanPocSettings(process.env);
} catch (e) {
  fail(`AWSBRIDGE_HUMAN_POC_ISSUER が不正です: ${(e as Error).message}`);
}

// 認証情報ファイルは最初に読む（読めなければ aws を呼ばずに終わる）
const fileCreds = new Map<string, TemporaryCredentials>();
for (const t of targets) {
  if (t.kind !== "credentials") continue;
  try {
    const j = JSON.parse(readFileSync(t.file, "utf8"));
    if (!j.AccessKeyId || !j.SecretAccessKey || !j.SessionToken) throw new Error("missing");
    fileCreds.set(t.name, {
      accessKeyId: j.AccessKeyId,
      secretAccessKey: j.SecretAccessKey,
      sessionToken: j.SessionToken,
    });
  } catch {
    fail(
      `認証情報ファイルを読めません: ${t.file}（console-url が書いた credentials*.json を渡す）`,
    );
  }
}

// 引き受け直す対象があるときだけ、issuer・subject（対象ごと）・ロール ARN を用意する
const assumeRoles = new Map<string, string>();
const assumeSubjects = new Map<string, string>();
let issuer = "";
if (targets.some((t) => t.kind === "assume")) {
  issuer = required(settings.issuer, "AWSBRIDGE_HUMAN_POC_ISSUER");
  required(settings.subject, "AWSBRIDGE_HUMAN_POC_SUBJECT");
  for (const t of targets) {
    if (t.kind !== "assume") continue;
    try {
      assumeSubjects.set(t.name, subjectFor(settings, t.who ?? "primary"));
    } catch (e) {
      fail(`${(e as Error).message}（mise.local.toml を確認してください）`);
    }
  }
  const outputs = stackOutputs(settings);
  for (const t of targets)
    if (t.kind === "assume")
      assumeRoles.set(t.name, roleArnOf(outputs, t.role, settings.stackName));
}

function assumeClaims(role: RoleKey, subject: string): Record<string, unknown> {
  return assumeClaimsFor(role, subject, values["access-profile"] ?? "poc-admin");
}

async function check(t: WatchTarget): Promise<Outcome> {
  if (t.kind === "profile") {
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_PROFILE: t.profile };
    for (const k of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_DEFAULT_PROFILE",
    ])
      delete env[k];
    return probeApi("s3:ListBuckets", env, timeoutMs);
  }
  if (t.kind === "credentials") {
    const creds = fileCreds.get(t.name) as TemporaryCredentials;
    return probeApi(
      "s3:ListBuckets",
      credentialsEnv(process.env, creds, settings.region),
      timeoutMs,
    );
  }
  const subject = assumeSubjects.get(t.name) as string;
  const r = await assumeWithClaims({
    settings,
    issuer,
    subject,
    roleArn: assumeRoles.get(t.name) as string,
    extraClaims: assumeClaims(t.role, subject),
  });
  if (!r.ok) return { ok: false, code: `sts:${r.code}`, detail: failureDetail(r.message) };
  return probeApi(
    "s3:ListBuckets",
    credentialsEnv(process.env, r.creds, settings.region),
    timeoutMs,
  );
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const logFile = join(settings.outDir, `stop-watch-${stamp}.jsonl`);
writeSecret(logFile, "");
const samples: Sample[] = [];

function finish(): never {
  console.log("");
  console.log(formatWatchSummary(summarizeSamples(samples, since)));
  console.log(`記録: ${logFile}`);
  process.exit(0);
}
process.on("SIGINT", finish);

console.log(
  `見張り: ${targets.map((t) => t.name).join(", ")}（s3:ListBuckets、${interval} 秒おき、${count === 0 ? "Ctrl-C まで" : `${count} 回`}）`,
);
for (let i = 0; count === 0 || i < count; i++) {
  if (i > 0 && interval > 0) await new Promise((r) => setTimeout(r, interval * 1000));
  const at = new Date().toISOString();
  const results = await Promise.all(targets.map((t) => check(t)));
  const parts: string[] = [];
  targets.forEach((t, j) => {
    const o = results[j] as Outcome;
    const sample: Sample = o.ok
      ? { at, target: t.name, ok: true }
      : { at, target: t.name, ok: false, code: o.code, ...(o.detail ? { detail: o.detail } : {}) };
    samples.push(sample);
    appendFileSync(logFile, `${JSON.stringify(sample)}\n`);
    parts.push(`${t.name}=${o.ok ? "OK" : o.code}`);
  });
  console.log(`${at}  ${parts.join("  ")}`);
}
finish();
