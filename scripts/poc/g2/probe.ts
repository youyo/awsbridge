// G2 の試験用の issuer の道具（mise タスク poc:g2:probe:*）。手順書 §2.6・§2.6.1・§3.1 の ii-1b・§3.7（追 2）・§3.3 の対照。
//   pnpm tsx scripts/poc/g2/probe.ts <keygen|keys|deploy|check|watch|forget> --issuer <label> [...]
//
// keygen  --issuer <label> --name <A>        RSA の鍵を <g2 dir>/probe/<label>/key-<A>.json に作る（権限 600。既存なら止める）
// keys    --issuer <label>                    手元の鍵の名前と kid の先頭 8 文字、今の JWKS に載っているか
// deploy  --issuer <label> --keys <A,B>       選んだ鍵の公開鍵だけの JWKS と discovery を作り、Worker awsbridge-g2-probe-<label> を
//         [--dry-run]                        Custom Domain awsbridge-g2-probe-<label>.<zone> へデプロイ → 公開内容を確かめる。
//                                            JWKS の kid を差し替えるときも --keys を変えてデプロイし直す。要求と完了の時刻を出す
// check   --issuer <label>                    公開された discovery と JWKS が手元の文書と一致するか。応答ヘッダーを出す
// watch   --issuer <label> --role-arn <arn> --keys <A,C>
//         [--interval 60] [--duration 60m]   鍵ごとに毎回新しい JWT（aud awsbridge-g2-probe、exp = iat + 300）を作り、
//         [--extend-interval 5m --max-duration 24h]   AssumeRoleWithWebIdentity を呼んで、時刻・成否・エラーコードを 1 行ずつ出す。
//         [--until-refused <A>] [--stop-after-refused 30m]   延長: 最初の区間のあとは広げた間隔で最長まで。見張る鍵が
//         [--since <ISO>]                    続けて断られたら止める（§3.7）。Ctrl-C でも要約を出す
// forget  --issuer <label>                    手元の鍵・文書・デプロイ用の設定を消す（記録 <g2 dir>/records/ は残す）
//
// 環境変数: AWSBRIDGE_G2_PROBE_ZONE（必須。開発用のゾーン）、AWSBRIDGE_G2_DEV_DIR（既定 .secrets/g2-dev）、
//   AWSBRIDGE_G2_PROBE_AUDIENCE（既定 awsbridge-g2-probe）、AWSBRIDGE_G2_PROBE_SUBJECT（既定 g2-probe）、AWS_REGION（既定 ap-northeast-1）、
//   AWSBRIDGE_G2_PROBE_CF_API_TOKEN（T-PROBE。あれば wrangler に CLOUDFLARE_API_TOKEN として渡す。無ければ wrangler の OAuth）、
//   AWSBRIDGE_G2_PROBE_CF_ACCOUNT_ID（任意）、AWSBRIDGE_G2_PROBE_REAL_HOSTS（本物のホストの追加。カンマ区切り）、
//   試験用: AWSBRIDGE_G2_PROBE_STS_ENDPOINT・AWSBRIDGE_G2_PROBE_DOCS_BASE（http://127.0.0.1:<port> だけ）
// 隔離の条件（probe-lib.ts）: aud が awsbridge-console なら断る / 本物の issuer のホストなら断る / ロールのパスが /awsbridge-console/ なら断る。
// 出力・記録に JWT・認証情報・秘密鍵を出さない（出すのは時刻・成否・エラーコード・kid と jti の先頭 8 文字）。
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import type { JWK } from "jose";
import { generateSigningJwk, publicJwkOf } from "../../../src/keys";
import { fail, writeSecret } from "../human/io";
import { parseJsonc } from "../human/portal/bypass-lib";
import { formatWatchSummary, type Sample, summarizeSamples } from "../human/watch";
import {
  fileStamp,
  g2Settings,
  nextStep,
  parseDuration,
  refusedForSeconds,
  type Schedule,
} from "./common";
import {
  assertKeyName,
  assertProbeIssuer,
  assertProbeLabel,
  assertProbeRoleArn,
  assumeProbe,
  headerLine,
  keyFileOf,
  kid8,
  type ProbeSettings,
  parseKeyNames,
  probeDocuments,
  probeSettings,
  probeWranglerConfig,
  realHostsFrom,
  refusalOf,
  signProbeToken,
  stsEndpointFrom,
} from "./probe-lib";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const [command, ...rest] = process.argv.slice(2);
let values: Record<string, string | boolean | undefined>;
try {
  values = parseArgs({
    args: rest,
    options: {
      issuer: { type: "string" },
      name: { type: "string" },
      keys: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "role-arn": { type: "string" },
      interval: { type: "string", default: "60" },
      duration: { type: "string", default: "60m" },
      "extend-interval": { type: "string" },
      "max-duration": { type: "string" },
      "until-refused": { type: "string" },
      "stop-after-refused": { type: "string" },
      since: { type: "string" },
    },
  }).values;
} catch (e) {
  fail((e as Error).message);
}

const str = (k: string): string | undefined => {
  const v = values[k];
  return typeof v === "string" ? v : undefined;
};
const need = (k: string): string => str(k) ?? fail(`--${k} を指定してください`);

let s: ProbeSettings;
let realHosts: Set<string>;
try {
  s = probeSettings(process.env, assertProbeLabel(need("issuer")));
  const configFile = process.env.AWSBRIDGE_CONSOLE_CONFIG || join(repoRoot, "config/console.json");
  realHosts = realHostsFrom(
    process.env,
    existsSync(configFile) ? readFileSync(configFile, "utf8") : undefined,
  );
  // どの操作でも、最初に issuer の隔離の条件を見る
  assertProbeIssuer(s.issuer, realHosts);
} catch (e) {
  fail((e as Error).message);
}

const recordsDir = join(g2Settings(process.env).dir, "records");

/** 手元の鍵の名前（key-<name>.json）。 */
function keyNames(): string[] {
  if (!existsSync(s.dir)) return [];
  return readdirSync(s.dir)
    .map((f) => /^key-([A-Za-z0-9_-]{1,16})\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .sort();
}

function readKey(name: string): JWK {
  try {
    return JSON.parse(readFileSync(keyFileOf(s.dir, name), "utf8")) as JWK;
  } catch {
    fail(
      `鍵を読めません: ${name}（先に poc:g2:probe:keygen -- --issuer ${s.label} --name ${name}）`,
    );
  }
}

const docsUrlBase = (): string => {
  const v = process.env.AWSBRIDGE_G2_PROBE_DOCS_BASE;
  if (v === undefined || v === "") return new URL(s.issuer).origin;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(v))
    fail("AWSBRIDGE_G2_PROBE_DOCS_BASE は試験用で、http://127.0.0.1:<port> だけ");
  return v;
};

/** 公開された文書を手元の文書と比べる。応答ヘッダー（JWKS のキャッシュの測定の記録用）も出す。 */
async function check(retries: number): Promise<boolean> {
  let docs: { discovery: unknown; jwks: unknown };
  try {
    docs = JSON.parse(readFileSync(s.documentsFile, "utf8"));
  } catch {
    fail(`手元の文書がありません: ${s.documentsFile}（先に deploy）`);
  }
  const path = new URL(s.issuer).pathname;
  let ok = true;
  for (const [name, file, expected] of [
    ["discovery", "openid-configuration", docs.discovery],
    ["JWKS", "jwks.json", docs.jwks],
  ] as const) {
    const url = `${docsUrlBase()}${path}/.well-known/${file}`;
    let status = 0;
    let body: unknown;
    let headers: [string, string][] = [];
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
        status = res.status;
        headers = [...res.headers.entries()];
        body = JSON.parse(await res.text());
      } catch {
        body = undefined;
      }
      if (status === 200 && isDeepStrictEqual(body, expected)) break;
      if (i + 1 < retries) await new Promise((r) => setTimeout(r, 3000));
    }
    const pass = status === 200 && isDeepStrictEqual(body, expected);
    if (!pass) ok = false;
    console.log(`[${pass ? "OK" : "NG"}] ${name} ${s.issuer}/.well-known/${file} HTTP ${status}`);
    for (const [k, v] of headers) console.log(`    ${headerLine(k, v)}`);
  }
  if (Array.isArray((docs.jwks as { keys?: unknown }).keys))
    console.log(
      `JWKS の kid: ${(docs.jwks as { keys: { kid?: string }[] }).keys
        .map((k) => `${kid8(k.kid ?? "")}…`)
        .join(", ")}`,
    );
  return ok;
}

async function keygen(): Promise<void> {
  const name = assertKeyName(need("name"));
  const file = keyFileOf(s.dir, name);
  if (existsSync(file)) fail(`既存の鍵があるため上書きしません: issuer=${s.label} name=${name}`);
  const jwk = await generateSigningJwk();
  writeSecret(file, JSON.stringify(jwk));
  console.log(`鍵を作りました: issuer=${s.label} name=${name} kid=${kid8(jwk.kid as string)}…`);
}

async function keys(): Promise<void> {
  let published: string[] = [];
  try {
    const docs = JSON.parse(readFileSync(s.documentsFile, "utf8")) as {
      jwks: { keys: { kid: string }[] };
    };
    published = docs.jwks.keys.map((k) => k.kid);
  } catch {}
  for (const name of keyNames()) {
    const pub = await publicJwkOf(readKey(name));
    console.log(
      `${name} kid=${kid8(pub.kid as string)}… ${published.includes(pub.kid as string) ? "JWKS に載っている" : "JWKS に無い"}`,
    );
  }
}

async function deploy(): Promise<void> {
  const names = parseKeyNames(need("keys"), keyNames());
  const pubs = await Promise.all(names.map(async (n) => publicJwkOf(readKey(n))));
  const docs = probeDocuments(s.issuer, pubs, realHosts);
  const template = parseJsonc(readFileSync(join(here, "wrangler.jsonc"), "utf8"));
  const cfg = probeWranglerConfig(template, {
    templateDir: here,
    workerName: s.workerName,
    host: s.host,
    documentsFile: s.documentsFile,
  });
  writeSecret(s.documentsFile, JSON.stringify(docs));
  writeSecret(s.deployConfigFile, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(
    `JWKS: ${names.map((n, i) => `${n}[${kid8(pubs[i]?.kid as string)}]`).join(", ")}（issuer=${s.label}）`,
  );
  const args = ["exec", "wrangler", "deploy", "--config", s.deployConfigFile];
  if (values["dry-run"]) args.push("--dry-run", "--outdir", join(s.dir, "dist"));
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  delete env.CLOUDFLARE_API_TOKEN;
  if (process.env.AWSBRIDGE_G2_PROBE_CF_API_TOKEN)
    env.CLOUDFLARE_API_TOKEN = process.env.AWSBRIDGE_G2_PROBE_CF_API_TOKEN;
  if (process.env.AWSBRIDGE_G2_PROBE_CF_ACCOUNT_ID)
    env.CLOUDFLARE_ACCOUNT_ID = process.env.AWSBRIDGE_G2_PROBE_CF_ACCOUNT_ID;
  console.log(`デプロイの要求: ${new Date().toISOString()}`);
  const r = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit", env });
  if (r.status !== 0) fail(`wrangler deploy が失敗しました（終了コード ${r.status}）`);
  console.log(`デプロイの完了: ${new Date().toISOString()}`);
  if (values["dry-run"]) {
    console.log("--dry-run のためデプロイしていません");
    return;
  }
  if (!(await check(10))) process.exitCode = 1;
}

async function watch(): Promise<void> {
  const roleArn = assertProbeRoleArn(need("role-arn"));
  const names = parseKeyNames(need("keys"), keyNames());
  const endpoint = stsEndpointFrom(process.env, s.region);
  const schedule: Schedule = {
    intervalSeconds: parseDuration(str("interval") ?? "60", "--interval"),
    durationSeconds: parseDuration(str("duration") ?? "60m", "--duration"),
    extendIntervalSeconds:
      str("extend-interval") === undefined
        ? undefined
        : parseDuration(str("extend-interval") as string, "--extend-interval"),
    maxDurationSeconds:
      str("max-duration") === undefined
        ? undefined
        : parseDuration(str("max-duration") as string, "--max-duration"),
    stopAfterRefusedSeconds: parseDuration(
      str("stop-after-refused") ?? "30m",
      "--stop-after-refused",
    ),
  };
  nextStep(schedule, 0, undefined); // 予定の形を先に確かめる
  const untilRefused = str("until-refused");
  if (untilRefused !== undefined && !names.includes(untilRefused))
    fail(`--until-refused は --keys の中の鍵: '${untilRefused}'`);
  let since: Date | undefined;
  if (str("since") !== undefined) {
    since = new Date(str("since") as string);
    if (Number.isNaN(since.getTime())) fail("--since は ISO 8601 の時刻");
  }
  const jwks = Object.fromEntries(names.map((n) => [n, readKey(n)]));
  const record = join(recordsDir, `probe-${s.label}-watch-${fileStamp()}.jsonl`);
  writeSecret(record, "");
  const samples: Sample[] = [];
  const attempts: { atSeconds: number; ok: boolean }[] = [];
  const started = Date.now();
  let stopReason = "";

  const finish = () => {
    console.log("");
    console.log(`止めた理由: ${stopReason}`);
    console.log(formatWatchSummary(summarizeSamples(samples, since)));
    console.log(`記録: ${record}`);
  };
  process.on("SIGINT", () => {
    stopReason = "interrupted";
    finish();
    process.exit(0);
  });

  console.log(
    `見張り: issuer=${s.label} 鍵=${names.join(",")} 間隔 ${schedule.intervalSeconds} 秒・${schedule.durationSeconds} 秒${
      schedule.extendIntervalSeconds !== undefined
        ? `、そのあと ${schedule.extendIntervalSeconds} 秒おきに最長 ${schedule.maxDurationSeconds} 秒`
        : ""
    }`,
  );
  for (;;) {
    const roundStart = Date.now();
    const at = new Date(roundStart).toISOString();
    const elapsedAtStart = Math.round((roundStart - started) / 1000);
    const results = await Promise.all(
      names.map(async (name) => {
        const t = await signProbeToken({
          privateJwk: jwks[name] as JWK,
          issuer: s.issuer,
          audience: s.audience,
          subject: s.subject,
          realHosts,
        });
        const o = await assumeProbe({
          endpoint,
          roleArn,
          token: t.token,
          sessionName: `g2-probe-${s.label}-${name}`,
          fetch,
        });
        return { name, kid: kid8(t.kid), jti: kid8(t.jti), o };
      }),
    );
    const parts: string[] = [];
    for (const { name, kid, jti, o } of results) {
      const sample: Sample = o.ok
        ? { at, target: name, ok: true, detail: `kid=${kid} jti=${jti}` }
        : {
            at,
            target: name,
            ok: false,
            code: o.code,
            detail: `kid=${kid} jti=${jti} ${o.detail}`,
          };
      samples.push(sample);
      appendFileSync(
        record,
        `${JSON.stringify({ ...sample, status: o.status, elapsedSeconds: elapsedAtStart })}\n`,
      );
      // 通信の失敗・5xx は止め方に数えない（refusalOf）
      const refused = refusalOf(o);
      if (name === untilRefused && refused !== undefined)
        attempts.push({ atSeconds: elapsedAtStart, ok: !refused });
      parts.push(`${name}[${kid}]=${o.ok ? "OK" : o.code}`);
    }
    console.log(`${at} +${elapsedAtStart}s ${parts.join(" ")}`);
    const elapsed = (Date.now() - started) / 1000;
    const step = nextStep(
      schedule,
      elapsed,
      untilRefused === undefined ? undefined : refusedForSeconds(attempts, elapsed),
    );
    if (step.action === "stop") {
      stopReason = step.reason;
      break;
    }
    const wait = roundStart + step.delaySeconds * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  finish();
}

function forget(): void {
  if (!existsSync(s.dir)) {
    console.log(`手元の鍵はありません: issuer=${s.label}`);
    return;
  }
  const names = keyNames();
  rmSync(s.dir, { recursive: true, force: true });
  console.log(
    `手元の鍵・文書・デプロイ用の設定を消しました: issuer=${s.label} 鍵=${names.join(",") || "なし"} 時刻=${new Date().toISOString()}`,
  );
}

try {
  switch (command) {
    case "keygen":
      await keygen();
      break;
    case "keys":
      await keys();
      break;
    case "deploy":
      await deploy();
      break;
    case "check":
      if (!(await check(1))) process.exitCode = 1;
      break;
    case "watch":
      await watch();
      break;
    case "forget":
      forget();
      break;
    default:
      fail("使い方: probe.ts <keygen|keys|deploy|check|watch|forget> --issuer <label> ...");
  }
} catch (e) {
  fail((e as Error).message);
}
