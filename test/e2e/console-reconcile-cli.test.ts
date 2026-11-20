// 突き合わせの道具の CLI（scripts/console/reconcile.ts。mise タスク console:reconcile）を実プロセスで動かす。
// aws は PATH の先頭に置いた偽のコマンド（材料の応答を返し、呼ばれた引数を記録する）、Cloudflare の API は手元（127.0.0.1）の
// 擬似サーバー（AWSBRIDGE_CONSOLE_LOGS_API_BASE は 127.0.0.1 だけ受け付ける）。実際の AWS・Cloudflare には接続しない。
// 確かめること: 呼ぶのは許可した aws のコマンドと照会の API だけ、出力に email・全桁の jti・12 桁のアカウント ID が無い、終了コード。
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RECONCILE_READ_COMMANDS } from "../../scripts/console/reconcile-read";
import { companyConfig } from "../unit/console-fixtures";
import { freePort, root } from "./console-e2e-kit";

const ACCOUNT = "333333333333";
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
// トークン・AWS のキーの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const TOKEN = ["e2e", "logs", "token", "z".repeat(24)].join("-");
const ACCESS_KEY_ID = ["ASIA", "Q".repeat(16)].join("");
/** 境界の issuer（P2: Standard と Admin の階層で同じ issuer・同じプロバイダー）。 */
const ISSUER_ID = "id.example.com/console";
const STD_ROLE = `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/FederatedViewer`;
const ADMIN_ROLE = `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/admin/FederatedAdministrator`;
const EMAIL = "alice@example.com";
const MIN = 60_000;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---- 偽の Cloudflare の API ----
type Req = { method: string; url: string; auth: string | undefined; body: string };
let server: Server;
let base = "";
const reqs: Req[] = [];
let apiEvents: { timestamp: number; $metadata: { id: string }; [k: string]: unknown }[] = [];
let apiFail = false;
/** 実物の読み取りの間引き（abr_level 10）をまねる: 幅がこれを超える events の照会は 10 行に 1 行だけ返す。 */
let apiSampleAboveMs: number | undefined;
/** events の照会がいつも 1 行少なく返す（割っても件数に届かない場合）。 */
let apiDropOne = false;
/**
 * 古い区間を含む照会の件数が間引かれる（sampleInterval > 1）のをまねる: timeframe の from がこれより前なら、calculations の
 * sampleInterval を 10 にする（窓全体に掛かる。保存の間引きか照会の間引きかは未確認のため、窓に古い区間を含むかだけで決める）。
 */
let apiCountSampledBefore: number | undefined;

/**
 * 偽の telemetry/query（実物の振る舞いをまねる）: timeframe の両端は含まない。calculations の view は count、
 * events の view は新しい順で、幅が apiSampleAboveMs を超えると間引く。events.count はそのページの行数。
 */
function telemetry(body: {
  view: string;
  timeframe: { from: number; to: number };
  limit?: number;
  offset?: string;
}) {
  const { from, to } = body.timeframe;
  const inside = apiEvents
    .filter((e) => e.timestamp > from && e.timestamp < to)
    .sort((a, b) => b.timestamp - a.timestamp);
  if (body.view === "calculations")
    return {
      success: true,
      result: {
        calculations: [
          {
            alias: "n",
            calculation: "count",
            aggregates: [
              {
                count: inside.length,
                sampleInterval:
                  apiCountSampledBefore !== undefined && from < apiCountSampledBefore
                    ? 10
                    : inside.length > 0
                      ? 1
                      : 0,
              },
            ],
            series: [],
          },
        ],
        statistics: { abr_level: 1 },
      },
    };
  const sampled = apiSampleAboveMs !== undefined && to - from > apiSampleAboveMs;
  let list = sampled ? inside.filter((_, i) => i % 10 === 9) : inside;
  if (apiDropOne) list = list.slice(1);
  if (body.offset !== undefined)
    list = list.slice(list.findIndex((e) => e.$metadata.id === body.offset) + 1);
  const events = list.slice(0, body.limit ?? 2000);
  return {
    success: true,
    result: {
      events: { events, count: events.length },
      statistics: { abr_level: sampled ? 10 : 1 },
    },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      reqs.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body,
      });
      res.setHeader("content-type", "application/json");
      if (apiFail) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "internal" }] }));
      } else if (
        req.method === "POST" &&
        req.url?.endsWith("/workers/observability/telemetry/query")
      )
        res.end(JSON.stringify(telemetry(JSON.parse(body))));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }] }));
      }
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  reqs.length = 0;
  apiEvents = [];
  apiFail = false;
  apiSampleAboveMs = undefined;
  apiDropOne = false;
  apiCountSampledBefore = undefined;
});

// ---- 材料 ----
let seq = 0;
const newJti = () => `${(++seq).toString(16).padStart(8, "0")}-1f4e-4c55-9d2a-7f3c1a2b3c4d`;

/** Worker の発行記録（issueLogRecord の形）。 */
function issue(o: {
  jti: string;
  at: number;
  tier?: "standard" | "admin";
  region?: string;
  user?: Record<string, string>;
}) {
  const tier = o.tier ?? "standard";
  return {
    event: "console_issue",
    result: "ok",
    at: new Date(o.at).toISOString(),
    tier,
    team: tier === "admin" ? "infra-elevated" : "infra",
    user: o.user ?? { email: "a***@***.com", sourceIdentity: "a***@***.com", accessSub: "1111…" },
    target: {
      accountId: ACCOUNT,
      role: tier === "admin" ? "administrator" : "viewer",
      roleArn: tier === "admin" ? ADMIN_ROLE : STD_ROLE,
      boundary: "managed",
      issuer: `https://${ISSUER_ID}`,
    },
    jwt: {
      jti: o.jti,
      iat: Math.floor(o.at / 1000),
      exp: Math.floor(o.at / 1000) + 300,
      kid: "k1",
    },
    sts: {
      region: o.region ?? "us-east-1",
      accessKeyId: "ASIA…QQQQ",
      assumedRoleId: "AROA…",
      requestId: "5e1b7c2a…",
    },
    session: { seconds: 3600, consoleRegion: "us-east-1" },
    worker: { versionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" },
  };
}

/** 記録に対になる CloudTrail の AssumeRoleWithWebIdentity（CloudTrailEvent の JSON の文字列）。 */
function trail(
  r: ReturnType<typeof issue>,
  o: { afterIssueSeconds?: number; sourceIdentity?: string | null } = {},
) {
  return {
    EventId: `ev-${r.jwt.jti}`,
    EventName: "AssumeRoleWithWebIdentity",
    CloudTrailEvent: JSON.stringify({
      eventVersion: "1.08",
      userIdentity: {
        type: "WebIdentityUser",
        userName: EMAIL,
        identityProvider: `arn:aws:iam::${ACCOUNT}:oidc-provider/${ISSUER_ID}`,
      },
      eventTime: new Date(r.jwt.iat * 1000 + (o.afterIssueSeconds ?? 2) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      eventSource: "sts.amazonaws.com",
      eventName: "AssumeRoleWithWebIdentity",
      awsRegion: r.sts.region,
      requestID: "5e1b7c2a-8d3f-4a6b-9c0d-112233445566",
      eventID: `ev-${r.jwt.jti}`,
      recipientAccountId: ACCOUNT,
      requestParameters: {
        roleArn: r.target.roleArn,
        roleSessionName: `console-${EMAIL}`,
        ...(o.sourceIdentity === null ? {} : { sourceIdentity: o.sourceIdentity ?? EMAIL }),
        webIdentityTokenId: r.jwt.jti,
      },
      responseElements: {
        credentials: { accessKeyId: ACCESS_KEY_ID, expiration: "x" },
        assumedRoleUser: { assumedRoleId: `AROAZZZZ:console-${EMAIL}`, arn: "x" },
        subjectFromWebIdentityToken: EMAIL,
      },
    }),
  };
}

// 偽の aws: --profile と --output を除き、サービス・サブコマンドと --region= を空白でつないだものを応答の表で引く。
// 無ければ失敗（終了コード 255）。呼ばれた引数はすべて記録する。FAIL_ON に前方一致した呼び出しは失敗させる。
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(args) + "\\n");
const region = args.find((a) => a.startsWith("--region="));
const key = [args[0], args[1], ...(region ? [region] : [])].join(" ");
if (process.env.AWS_STUB_FAIL_ON && process.env.AWS_STUB_FAIL_ON.split("|").some((f) => key.startsWith(f))) {
  process.stderr.write("An error occurred (AccessDenied): User: arn:aws:sts::333333333333:assumed-role/x/user1@example.com is not authorized\\n");
  process.exit(254);
}
const table = JSON.parse(fs.readFileSync(process.env.AWS_STUB_TABLE, "utf8"));
if (!(key in table)) { process.stderr.write("unknown call: " + key + "\\n"); process.exit(255); }
let res = table[key];
// AWS_STUB_SLEEP_MS があれば、lookup-events の応答の前に待つ（実行中に止める試験）
if (process.env.AWS_STUB_SLEEP_MS && args[1] === "lookup-events") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.AWS_STUB_SLEEP_MS));
// AWS_STUB_TOUCH があれば、lookup-events のときにそのファイルを書き換える（同じ状態のファイルで同時に回した形）
if (process.env.AWS_STUB_TOUCH && args[1] === "lookup-events") fs.writeFileSync(process.env.AWS_STUB_TOUCH, process.env.AWS_STUB_TOUCH_TEXT || "");
// AWS_STUB_FILTER_TIME があれば、lookup-events は --start-time .. --end-time の中のイベントだけを返す（実物と同じ）
if (process.env.AWS_STUB_FILTER_TIME && args[1] === "lookup-events") {
  const at = (n) => Date.parse(args[args.indexOf(n) + 1]);
  const from = at("--start-time"), to = at("--end-time");
  res = { Events: res.Events.filter((e) => {
    const t = Date.parse(JSON.parse(e.CloudTrailEvent).eventTime);
    return t >= from && t <= to;
  }) };
}
process.stdout.write(JSON.stringify(res));
`;

type Setup = {
  records?: unknown[];
  recordLines?: string[];
  trails?: { region: string; events: unknown[] }[];
  failOn?: string;
  /** lookup-events を --start-time .. --end-time で絞る（実物と同じ）。 */
  filterTime?: boolean;
};

function setup(s: Setup) {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-console-reconcile-"));
  dirs.push(d);
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), STUB);
  chmodSync(join(bin, "aws"), 0o755);
  const regions = ["ap-northeast-1", "us-east-1"];
  const table: Record<string, unknown> = {
    "sts get-caller-identity --region=us-east-1": {
      Account: ACCOUNT,
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Reader/${EMAIL}`,
    },
    "account list-regions --region=us-east-1": {
      Regions: regions.map((r) => ({ RegionName: r, RegionOptStatus: "ENABLED_BY_DEFAULT" })),
    },
  };
  for (const r of regions) {
    const t = s.trails?.find((x) => x.region === r);
    table[`cloudtrail lookup-events --region=${r}`] = { Events: t?.events ?? [] };
  }
  writeFileSync(join(d, "table.json"), JSON.stringify(table));
  writeFileSync(join(d, "console.json"), JSON.stringify(companyConfig()));
  const records = join(d, "records.ndjson");
  writeFileSync(
    records,
    [...(s.records ?? []).map((r) => JSON.stringify(r)), ...(s.recordLines ?? [])].join("\n"),
  );
  const log = join(d, "calls.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: d,
    AWS_STUB_TABLE: join(d, "table.json"),
    AWS_STUB_LOG: log,
    AWSBRIDGE_CONSOLE_CONFIG: join(d, "console.json"),
    ...(s.failOn ? { AWS_STUB_FAIL_ON: s.failOn } : {}),
    ...(s.filterTime ? { AWS_STUB_FILTER_TIME: "1" } : {}),
  };
  return { env, records, log, dir: d, state: join(d, "state.json") };
}

/** 実プロセスで動かす（同じプロセスの擬似サーバーが応答できるよう、spawnSync ではなく非同期で待つ）。 */
function run(
  args: string[],
  env: Record<string, string>,
  o: { cwd?: string; defaultState?: boolean } = {},
): Promise<{ status: number | null; out: string }> {
  // 確認済みの区間の状態は、指定が無ければ試験ごとの一時ディレクトリに置く（リポジトリの .secrets/ を触らない）
  const withState =
    o.defaultState === false || args.includes("--state")
      ? args
      : [...args, "--state", join(env.HOME ?? "", "state.json")];
  return new Promise((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console/reconcile.ts"), ...withState],
      { cwd: o.cwd ?? root, env },
    );
    let out = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      out += c;
    });
    p.on("close", (status) => resolve({ status, out }));
  });
}

/** 状態のファイルのこのアカウントの行（version 2）。 */
const rowOf = (state: string) => {
  const body = JSON.parse(readFileSync(state, "utf8"));
  expect(body.version).toBe(2);
  return body.accounts[ACCOUNT];
};

const callsOf = (log: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[]);

/** 出力に email・12 桁のアカウント ID・全桁の jti・トークンが無い。 */
function noSecrets(out: string, jtis: string[]) {
  expect(out).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  expect(out).not.toMatch(/@/);
  expect(out).not.toContain(TOKEN);
  for (const j of jtis) expect(out).not.toContain(j);
}

const now = () => Date.now();

describe("console:reconcile（偽の aws と 127.0.0.1 の偽の Cloudflare の API で実プロセス）", () => {
  it("ファイルの記録と CloudTrail が対になれば終了コード 0。呼ぶのは許可リストの aws だけで、すべて指定のプロファイル・--region 付き", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const b = issue({
      jti: newJti(),
      at: now() - 30 * MIN,
      tier: "admin",
      region: "ap-northeast-1",
    });
    const { env, records, log } = setup({
      records: [a, b],
      trails: [
        { region: "us-east-1", events: [trail(a)] },
        { region: "ap-northeast-1", events: [trail(b)] },
      ],
    });
    const r = await run(["--profile", "reconcile-test", "--records", records, "--init"], env);
    expect(r.out).toContain("errors: 0");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("source: file");
    expect(r.out).toContain("regions: read 2/2");
    expect(r.out).toContain("unverifiable: 0");
    expect(r.out).toContain("truncated lines: 0");
    expect(r.out).toMatch(/matched: 2/);
    noSecrets(r.out, [a.jwt.jti, b.jwt.jti]);
    const calls = callsOf(log);
    expect(calls.length).toBe(4);
    for (const c of calls) {
      expect(RECONCILE_READ_COMMANDS as readonly string[], c.join(" ")).toContain(
        `${c[0]} ${c[1]}`,
      );
      expect(c.slice(-3)).toEqual(["--profile=reconcile-test", "--output", "json"]);
      expect(c.some((x) => x.startsWith("--region="))).toBe(true);
    }
    // 既定のさかのぼりは 6 日（記録の保持 7 日より短く）
    const lookup = calls.find((c) => c[1] === "lookup-events") ?? [];
    const since = Date.parse(lookup[lookup.indexOf("--start-time") + 1] ?? "");
    expect(Math.round((now() - since) / 86_400_000)).toBe(6);
    expect(reqs).toEqual([]);
  });

  it("記録に無い引き受けは assume_without_record で終了コード 1（jti は先頭 8 文字だけ）", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records } = setup({
      records: [],
      trails: [{ region: "us-east-1", events: [trail(a)] }],
    });
    const r = await run(["--profile", "reconcile-test", "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("assume_without_record");
    expect(r.out).toContain(a.jwt.jti.slice(0, 8));
    noSecrets(r.out, [a.jwt.jti]);
  });

  it("切られた行（$cloudflare.truncated）があれば record_line_truncated で終了コード 1", async () => {
    const { env, records } = setup({
      recordLines: [
        JSON.stringify({ $cloudflare: { truncated: true }, source: '{"event":"console_iss' }),
      ],
    });
    const r = await run(["--profile", "reconcile-test", "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("record_line_truncated");
    expect(r.out).toContain("truncated lines: 1");
  });

  it("読めなかったリージョンは region_unread で終了コード 1", async () => {
    const { env, records } = setup({ failOn: "cloudtrail lookup-events --region=ap-northeast-1" });
    const r = await run(["--profile", "reconcile-test", "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("region_unread");
    expect(r.out).toContain("regions: read 1/2");
    noSecrets(r.out, []);
  });

  it("記録の保持より古く記録の無い引き受け（検証できない）が 1 件以上あれば、誤りが 0 でも終了コード 1", async () => {
    const old = issue({ jti: newJti(), at: now() - 8 * 86_400_000 });
    const { env, records } = setup({ trails: [{ region: "us-east-1", events: [trail(old)] }] });
    const r = await run(
      ["--profile", "reconcile-test", "--records", records, "--since", "10d", "--init"],
      env,
    );
    expect(r.out).toContain("unverifiable: 1");
    expect(r.out).toMatch(/errors: 0,/);
    expect(r.out).not.toContain("assume_without_record");
    expect(r.status, r.out).toBe(1);
    noSecrets(r.out, [old.jwt.jti]);
  });

  it("さかのぼりを記録の保持より長くすると window_exceeds_retention（警告）", async () => {
    const { env, records } = setup({});
    const r = await run(
      ["--profile", "reconcile-test", "--records", records, "--since", "10d", "--init"],
      env,
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("window_exceeds_retention");
  });

  it("--logs-api: 照会の API（POST .../workers/observability/telemetry/query）だけを Bearer のトークンで呼び、記録を読む", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    apiEvents = [
      {
        $metadata: { id: "e1" },
        $workers: { scriptName: "awsbridge-console", eventType: "fetch" },
        dataset: "cloudflare-workers",
        timestamp: Date.parse(a.at),
        source: a,
      },
    ];
    const { env } = setup({ trails: [{ region: "us-east-1", events: [trail(a)] }] });
    const r = await run(["--profile", "reconcile-test", "--logs-api", "--init"], {
      ...env,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("source: api");
    expect(r.out).toMatch(/matched: 1/);
    noSecrets(r.out, [a.jwt.jti]);
    expect(reqs.length).toBeGreaterThan(0);
    const views = new Set<string>();
    for (const q of reqs) {
      expect(q.method).toBe("POST");
      expect(q.url).toBe(`/accounts/${CF_ACCOUNT}/workers/observability/telemetry/query`);
      expect(q.auth).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(q.body);
      views.add(body.view);
      expect(body.timeframe.from).toBeLessThan(body.timeframe.to);
    }
    // 行（events）と、別の経路の件数（calculations の count）の 2 つの view だけ
    expect([...views].sort()).toEqual(["calculations", "events"]);
  });

  const apiEnv = (env: NodeJS.ProcessEnv) => ({
    ...env,
    AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
    AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
    AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
  });
  const logEvent = (r: ReturnType<typeof issue>, id: string) => ({
    $metadata: { id },
    $workers: { scriptName: "awsbridge-console", eventType: "fetch" },
    dataset: "cloudflare-workers",
    timestamp: Date.parse(r.at),
    source: r,
  });

  it("--logs-api: 長い窓の読み取りが間引かれて limit より少なく返っても、件数（calculations の count）まで窓を割って全件を読む（c2 の読み落とし）", async () => {
    const recs = Array.from({ length: 12 }, (_, i) =>
      issue({ jti: newJti(), at: now() - (5 * 24 * 60 - i * 7 * 60) * MIN }),
    );
    // 記録でない行（他のログ）も混ぜる。同じ $metadata.id の行もある（実物でも一意でない）
    const noise = Array.from({ length: 30 }, (_, i) => ({
      $metadata: { id: `n${i % 20}` },
      $workers: { scriptName: "awsbridge-console", eventType: "fetch" },
      dataset: "cloudflare-workers",
      timestamp: now() - (4 * 24 * 60 - i * 13) * MIN,
      source: { message: "GET /" },
    }));
    apiEvents = [...recs.map((r, i) => logEvent(r, `e${i}`)), ...noise];
    apiSampleAboveMs = 2 * 3_600_000;
    const { env, state } = setup({
      trails: [{ region: "us-east-1", events: recs.map((r) => trail(r)) }],
    });
    const r = await run(["--profile", "reconcile-test", "--logs-api", "--init"], apiEnv(env));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/matched: 12/);
    expect(r.out).toContain(`api count ${apiEvents.length}`);
    expect(r.out).toMatch(new RegExp(`lines ${apiEvents.length}\\)`));
    expect(r.out).not.toContain("assume_without_record");
    expect(r.out).toContain("state: confirmed until");
    expect(existsSync(state)).toBe(true);
  });

  it("--logs-api: 割っても件数に届かなければ record_read_incomplete（誤り）で終了コード 1。状態は進めない", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const b = issue({ jti: newJti(), at: now() - 50 * MIN });
    apiEvents = [logEvent(a, "e1"), logEvent(b, "e2")];
    apiDropOne = true;
    const { env, state } = setup({
      trails: [{ region: "us-east-1", events: [trail(a), trail(b)] }],
    });
    const r = await run(["--profile", "reconcile-test", "--logs-api", "--init"], apiEnv(env));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("record_read_incomplete");
    expect(r.out).toMatch(/read \d+ of \d+/);
    expect(r.out).toContain("state: not advanced");
    // --init の実行は結果によらず行を書く（i2）。確認済みの区間は無い。時刻を持たない誤りは件数だけ（q3）。読めなかった記録の引き受けは錨
    const row = rowOf(state);
    expect(Object.keys(row).sort()).toEqual(["unresolved", "untimed", "watchStart"]);
    expect(Object.keys(row.untimed.codes)).toEqual(["record_read_incomplete"]);
    noSecrets(r.out, [a.jwt.jti, b.jwt.jti]);
  });

  it("--logs-api: 宛先を 127.0.0.1 以外に向けられない・トークンが無ければ実行できない（終了コード 2。API を呼ばない）", async () => {
    const { env } = setup({});
    const api = {
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    };
    let r = await run(["--profile", "reconcile-test", "--logs-api", "--init"], {
      ...env,
      ...api,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: "http://example.com:80",
    });
    expect(r.status, r.out).toBe(2);
    r = await run(["--profile", "reconcile-test", "--logs-api", "--init"], {
      ...env,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
    });
    expect(r.status, r.out).toBe(2);
    expect(r.out).not.toContain(TOKEN);
    expect(reqs).toEqual([]);
  });

  it("--logs-api: API が失敗すれば実行できない（終了コード 2。空の読み取りとして扱わない）", async () => {
    const { env } = setup({});
    apiFail = true;
    const r = await run(["--profile", "reconcile-test", "--logs-api", "--init"], {
      ...env,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    });
    expect(r.status, r.out).toBe(2);
    expect(r.out).not.toContain(TOKEN);
    expect(reqs.length).toBe(1);
  });

  it("--records にディレクトリを渡すと、中のファイル（.gz は展開）をすべて読む", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const b = issue({ jti: newJti(), at: now() - 50 * MIN });
    const { env, records } = setup({
      trails: [{ region: "us-east-1", events: [trail(a), trail(b)] }],
    });
    const dir = join(records, "..", "logs");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.ndjson"), JSON.stringify(a));
    writeFileSync(join(dir, "b.log.gz"), gzipSync(Buffer.from(JSON.stringify(b))));
    const r = await run(["--profile", "reconcile-test", "--records", dir, "--init"], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/matched: 2/);
    expect(r.out).toMatch(/lines 2\)/);
  });

  it("--account-id がプロファイルのアカウントと違えば終了コード 2（CloudTrail を読まない）", async () => {
    const { env, records, log } = setup({});
    const r = await run(
      [
        "--profile",
        "reconcile-test",
        "--records",
        records,
        "--account-id",
        "444444444444",
        "--init",
      ],
      env,
    );
    expect(r.status, r.out).toBe(2);
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    noSecrets(r.out, []);
  });

  it("aws の失敗（エラーの文にアカウント ID と email を含む）で終了コード 2 のときも、出力は伏せ字", async () => {
    const { env, records } = setup({ failOn: "sts get-caller-identity" });
    const r = await run(["--profile", "reconcile-test", "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("sts get-caller-identity failed");
    noSecrets(r.out, []);
  });

  it("実行できない入力（--profile が無い・記録の入力が無い・両方・リージョンの一覧が読めない）は終了コード 2", async () => {
    const { env, records } = setup({});
    expect((await run(["--records", records], env)).status).toBe(2);
    expect((await run(["--profile", "reconcile-test"], env)).status).toBe(2);
    expect(
      (await run(["--profile", "reconcile-test", "--records", records, "--logs-api"], env)).status,
    ).toBe(2);
    const failing = setup({ failOn: "account list-regions|ec2 describe-regions" });
    const r = await run(
      ["--profile", "reconcile-test", "--records", failing.records, "--init"],
      failing.env,
    );
    expect(r.status, r.out).toBe(2);
    noSecrets(r.out, []);
  });
});

describe("console:reconcile: 時間の検査と SourceIdentity の一致（誤り。終了コード 1。cto の決裁 G2-A 条件 c5 の Q1）", () => {
  const prof = ["--profile", "reconcile-test"];

  it("引き受けが発行から 300 秒＋時計ずれ（既定 60 秒）を超えて後なら assume_time_gap の誤り。終了コード 1・状態は進めない。--clock-skew-seconds で許容を広げられる", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records, state } = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a, { afterIssueSeconds: 400 })] }],
    });
    let r = await run([...prof, "--records", records, "--init"], env);
    expect(r.out).toMatch(/^ERROR\s+assume_time_gap/m);
    expect(r.out).toContain("+400s");
    expect(r.out).toMatch(/errors: 1, warnings: 0/);
    expect(r.out).toContain("time from issue: standard n=1 min 400s max 400s, admin n=0");
    expect(r.out).toContain("state: not advanced");
    // --init の実行は誤りでも行を書く（i2）: 確認済みの区間は無く、時刻を持つ誤りが錨になる（q3）
    expect(Object.keys(rowOf(state)).sort()).toEqual(["unresolved", "watchStart"]);
    expect(rowOf(state).unresolved.codes).toEqual({ assume_time_gap: 1 });
    expect(r.status, r.out).toBe(1);
    noSecrets(r.out, [a.jwt.jti]);
    // 錨を作ったときより判定条件を緩めた実行は、誤り 0 でも解決にしない（続き 4 の B1。#55 までは 0 で消えていた）
    r = await run([...prof, "--records", records, "--clock-skew-seconds", "120"], env);
    expect(r.out).not.toMatch(/^ERROR\s+assume_time_gap/m);
    expect(r.out).toContain("clock skew 120s");
    expect(r.out).toMatch(/^ERROR\s+unresolved_criteria_looser/m);
    expect(r.out).toContain("judgment criteria looser: not resolving");
    expect(r.status, r.out).toBe(1);
    expect(rowOf(state).unresolved.codes).toEqual({ assume_time_gap: 1 });
    expect(rowOf(state).unresolved.criteria).toEqual({ clockSkewSeconds: 60, lagSeconds: 300 });
    // 出口は理由つきの受け入れ（区間を受け入れる）
    const acc = await run(
      [
        ...prof,
        "--records",
        records,
        "--clock-skew-seconds",
        "120",
        "--accept-unresolved",
        "--reason",
        "skew measured",
      ],
      env,
    );
    expect(acc.status, acc.out).toBe(0);
    expect(rowOf(state).unresolved).toBeUndefined();
    // 初めから広い許容で回せば（--init）誤りにならない（--clock-skew-seconds で許容を広げられる）
    const wide = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a, { afterIssueSeconds: 400 })] }],
    });
    const w = await run(
      [...prof, "--records", wide.records, "--init", "--clock-skew-seconds", "120"],
      wide.env,
    );
    expect(w.out).not.toContain("assume_time_gap");
    expect(w.status, w.out).toBe(0);
  });

  it("引き受けが発行より時計ずれを超えて前でも同じ所見（向きは -NNNs）", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records } = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a, { afterIssueSeconds: -120 })] }],
    });
    const r = await run([...prof, "--records", records, "--init"], env);
    expect(r.out).toMatch(/^ERROR\s+assume_time_gap/m);
    expect(r.out).toContain("-120s");
    expect(r.status, r.out).toBe(1);
  });

  it("--clock-skew-seconds が整数でなければ実行できない（終了コード 2）", async () => {
    const { env, records } = setup({});
    for (const v of ["-1", "abc", "1.5"])
      expect(
        (await run([...prof, "--records", records, "--clock-skew-seconds", v], env)).status,
      ).toBe(2);
  });

  it("記録の利用者と CloudTrail の SourceIdentity（どちらも伏せ字にして比べる）が違えば identity_mismatch の誤り。値は出さない。終了コード 1", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records } = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a, { sourceIdentity: "bob@example.org" })] }],
    });
    const r = await run([...prof, "--records", records, "--init"], env);
    expect(r.out).toMatch(/^ERROR\s+identity_mismatch/m);
    expect(r.out).toContain("identity: compared 1, not compared 0 (admin 0)");
    expect(r.status, r.out).toBe(1);
    noSecrets(r.out, [a.jwt.jti]);
    expect(r.out).not.toContain("bob");
  });

  it("両方あって一致すれば所見なし。どちらかが無ければ比べず、比べられなかった件数を出す", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const ok = setup({ records: [a], trails: [{ region: "us-east-1", events: [trail(a)] }] });
    let r = await run([...prof, "--records", ok.records, "--init"], ok.env);
    expect(r.out).toContain("identity: compared 1, not compared 0");
    expect(r.out).not.toContain("identity_mismatch");
    expect(r.status, r.out).toBe(0);

    const b = issue({ jti: newJti(), at: now() - 60 * MIN });
    const noEvent = setup({
      records: [b],
      trails: [{ region: "us-east-1", events: [trail(b, { sourceIdentity: null })] }],
    });
    r = await run([...prof, "--records", noEvent.records, "--init"], noEvent.env);
    expect(r.out).toContain("identity: compared 0, not compared 1");
    expect(r.out).toContain("identity_not_compared");
    expect(r.status, r.out).toBe(0);

    const c = issue({ jti: newJti(), at: now() - 60 * MIN, user: { accessSub: "1111…" } });
    const noRecord = setup({ records: [c], trails: [{ region: "us-east-1", events: [trail(c)] }] });
    r = await run([...prof, "--records", noRecord.records, "--init"], noRecord.env);
    expect(r.out).toContain("identity: compared 0, not compared 1");
    expect(r.status, r.out).toBe(0);
  });
});

describe("console:reconcile: 確認済みの区間（状態のファイル）", () => {
  const prof = ["--profile", "reconcile-test"];
  const DAY = 86_400_000;
  const stateText = (coveredUntil: number) =>
    JSON.stringify({
      version: 1,
      accounts: { [ACCOUNT]: { coveredUntil: new Date(coveredUntil).toISOString() } },
    });

  it("状態が無い初回は穴なし（そのことを出力する）。成功したら状態にアカウント ID と時刻だけを書く（今回の終わり − lag）。2 回目は continuous", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records, state } = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a)] }],
    });
    const t0 = now();
    let r = await run([...prof, "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("coverage: first run");
    expect(r.out).toContain("state: confirmed until");
    const body = JSON.parse(readFileSync(state, "utf8"));
    expect(Object.keys(body).sort()).toEqual(["accounts", "version"]);
    expect(Object.keys(body.accounts)).toEqual([ACCOUNT]);
    expect(Object.keys(body.accounts[ACCOUNT])).toEqual(["coveredUntil"]);
    const first = Date.parse(body.accounts[ACCOUNT].coveredUntil);
    expect(first).toBeGreaterThanOrEqual(t0 - 300_000 - 1000);
    expect(first).toBeLessThanOrEqual(now() - 300_000 + 1000);
    const text = readFileSync(state, "utf8");
    expect(text).not.toContain(a.jwt.jti);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("@");

    r = await run([...prof, "--records", records], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("coverage: continuous");
    expect(
      Date.parse(JSON.parse(readFileSync(state, "utf8")).accounts[ACCOUNT].coveredUntil),
    ).toBeGreaterThanOrEqual(first);
  });

  it("前回の終わりより今回の読み始めが後（既定のさかのぼり 6 日より前に終わっている）なら coverage_gap（誤り）で終了コード 1。状態は進めない", async () => {
    const { env, records, state } = setup({});
    const old = now() - 8 * DAY;
    writeFileSync(state, stateText(old));
    const r = await run([...prof, "--records", records], env);
    expect(r.out).toContain("coverage_gap");
    expect(r.out).toContain("coverage: GAP");
    expect(r.out).toContain("state: not advanced");
    expect(r.status, r.out).toBe(1);
    // 確認済みの区間は進めない。coverage_gap は状態に保存しない（q3。次の実行で同じ判定をやり直す）
    expect(rowOf(state)).toEqual({ coveredUntil: new Date(old).toISOString() });
    noSecrets(r.out, []);
    // さかのぼりを前回の終わり以前まで戻せば（--since 9d）穴は無い
    const again = await run([...prof, "--records", records, "--since", "9d"], env);
    expect(again.out).toContain("coverage: continuous");
    expect(again.out).not.toContain("coverage_gap");
  });

  it("誤りのある実行（assume_without_record）は状態を進めない。--init の初回で誤りなら、確認済みの区間の無い行（未解決の所見だけ）を書く", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records, state } = setup({
      trails: [{ region: "us-east-1", events: [trail(a)] }],
    });
    const r = await run([...prof, "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("state: not advanced");
    const assumedAt = a.jwt.iat * 1000 + 2000;
    expect(rowOf(state)).toEqual({
      // 見張りの始まりは --since なしの --init ではその実行の時刻（続き 5 の w1）
      watchStart: expect.any(String),
      unresolved: {
        oldestAt: new Date(assumedAt).toISOString(),
        newestAt: new Date(assumedAt).toISOString(),
        firstSeenAt: expect.any(String),
        codes: { assume_without_record: 1 },
        criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
      },
    });
    const prev = now() - 2 * DAY;
    writeFileSync(state, stateText(prev));
    const r2 = await run([...prof, "--records", records], env);
    expect(r2.status, r2.out).toBe(1);
    expect(rowOf(state).coveredUntil).toBe(new Date(prev).toISOString());
    expect(rowOf(state).unresolved.codes).toEqual({ assume_without_record: 1 });
  });

  it("読めない状態のファイルは実行しない（終了コード 2。CloudTrail を読まない。初回として扱わない）。出力に中身を出さない", async () => {
    const { env, records, state, log } = setup({});
    writeFileSync(
      state,
      '{"version":1,"accounts":{"333333333333":{"coveredUntil":"secret-nope"}}}',
    );
    const r = await run([...prof, "--records", records], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).not.toContain("secret-nope");
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    noSecrets(r.out, []);
  });

  it("未来の時刻（今 + 5 分より後）の状態は壊れた状態と同じ扱い（終了コード 2。CloudTrail を読まない。中身を出さない。ファイルは変えない）。許容の範囲内の未来は受け付ける", async () => {
    const { env, records, state, log } = setup({});
    const future = stateText(now() + DAY);
    writeFileSync(state, future);
    const r = await run([...prof, "--records", records], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).not.toContain(new Date(now() + DAY).toISOString().slice(0, 10));
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    expect(readFileSync(state, "utf8")).toBe(future);
    noSecrets(r.out, []);
    const near = setup({});
    writeFileSync(near.state, stateText(now() + 60_000));
    const ok = await run([...prof, "--records", near.records], near.env);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain("coverage: continuous");
  });

  it("--state を渡さなければ、作業ディレクトリの .secrets/console-reconcile-state.json に書く。.secrets/ は gitignore 済み", async () => {
    const { env, records, dir } = setup({});
    const cwd = join(dir, "work");
    mkdirSync(cwd);
    const r = await run([...prof, "--records", records, "--init"], env, {
      cwd,
      defaultState: false,
    });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(cwd, ".secrets/console-reconcile-state.json"))).toBe(true);
    expect(r.out).toContain(".secrets/console-reconcile-state.json");
    expect(readFileSync(join(root, ".gitignore"), "utf8").split("\n")).toContain(".secrets/");
  });

  it("状態はアカウントごと。別のアカウントの値は残す", async () => {
    const { env, records, state } = setup({});
    const other = "444444444444";
    writeFileSync(
      state,
      JSON.stringify({
        version: 1,
        accounts: { [other]: { coveredUntil: "2026-01-01T00:00:00.000Z" } },
      }),
    );
    const r = await run([...prof, "--records", records, "--init"], env);
    expect(r.out).toContain("coverage: first run");
    expect(r.status, r.out).toBe(0);
    const body = JSON.parse(readFileSync(state, "utf8"));
    expect(Object.keys(body.accounts).sort()).toEqual([ACCOUNT, other]);
    expect(body.accounts[other].coveredUntil).toBe("2026-01-01T00:00:00.000Z");
  });
});

/** MCP の Worker の引き受け（コンソールのロールのパスの外・コンソールの issuer でないプロバイダー）。照合の対象から外れる。 */
function mcpTrail(at: number) {
  const id = newJti();
  return {
    EventId: `ev-mcp-${id}`,
    EventName: "AssumeRoleWithWebIdentity",
    CloudTrailEvent: JSON.stringify({
      eventVersion: "1.08",
      userIdentity: {
        type: "WebIdentityUser",
        userName: EMAIL,
        identityProvider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-mcp.example.com`,
      },
      eventTime: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
      eventSource: "sts.amazonaws.com",
      eventName: "AssumeRoleWithWebIdentity",
      awsRegion: "us-east-1",
      eventID: `ev-mcp-${id}`,
      recipientAccountId: ACCOUNT,
      requestParameters: {
        roleArn: `arn:aws:iam::${ACCOUNT}:role/FederatedAwsBridgeMcpViewer`,
        roleSessionName: "mcp",
        webIdentityTokenId: id,
      },
    }),
  };
}

describe("console:reconcile: cto の決裁 G2-A 条件 c5（Administrator の比べ漏れ・時間差の記録・除外の件数・Admin の発行）", () => {
  const prof = ["--profile", "reconcile-test"];

  it("Administrator の階層の対で SourceIdentity を比べられなければ identity_not_compared_admin の誤り（終了コード 1・状態は進めない）", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN, tier: "admin" });
    const s = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a, { sourceIdentity: null })] }],
    });
    const r = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(r.out).toMatch(/^ERROR\s+identity_not_compared_admin/m);
    expect(r.out).toContain("identity: compared 0, not compared 1 (admin 1)");
    expect(r.out).toContain("state: not advanced");
    expect(r.status, r.out).toBe(1);
    noSecrets(r.out, [a.jwt.jti]);
  });

  it("毎日の出力に、時間差の階層ごとの最小・最大・件数、除外した引き受けの件数、Admin の発行の件数と時刻（UTC）を出す。除外は所見にしない", async () => {
    const t = now() - 60 * MIN;
    const s1 = issue({ jti: newJti(), at: t });
    const a1 = issue({ jti: newJti(), at: t - 30 * MIN, tier: "admin" });
    const a2 = issue({ jti: newJti(), at: t - 10 * MIN, tier: "admin" });
    const s = setup({
      records: [s1, a1, a2],
      trails: [
        {
          region: "us-east-1",
          events: [
            trail(s1, { afterIssueSeconds: 1 }),
            trail(a1, { afterIssueSeconds: 0 }),
            trail(a2, { afterIssueSeconds: 2 }),
            mcpTrail(t),
            mcpTrail(t + MIN),
          ],
        },
      ],
    });
    const r = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("console assumes: 3 (failed 0), matched: 3");
    expect(r.out).toContain("excluded assumes (not console): 2");
    expect(r.out).toContain("time from issue: standard n=1 min 1s max 1s, admin n=2 min 0s max 2s");
    // 時刻は発行記録の時刻（UTC の ISO 8601）
    expect(r.out).toContain(`admin issues: 2 (${a1.at} ok, ${a2.at} ok)`);
    expect(r.out).toMatch(/errors: 0, warnings: 0/);
    noSecrets(r.out, [s1.jwt.jti, a1.jwt.jti, a2.jwt.jti]);
  });
});

// ---- 読み始め（状態があれば「確認済みの区間の終わり − 重なり」から。既定のさかのぼり 6 日より前には戻らない） ----
// 古い区間を含む長い窓の照会が間引かれて record_read_incomplete になるのを避ける緩和策。--since が勝ち、初回と coverage_gap は変えない。
describe("console:reconcile: 読み始めを状態から決める（--overlap-seconds。既定 24 時間・下限 1 時間）", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const DAY = 86_400_000;
  const stateText = (coveredUntil: number) =>
    JSON.stringify({
      version: 1,
      accounts: { [ACCOUNT]: { coveredUntil: new Date(coveredUntil).toISOString() } },
    });
  const startOf = (log: string) => {
    const lookups = callsOf(log).filter((c) => c[1] === "lookup-events");
    expect(lookups.length).toBeGreaterThan(0);
    const starts = new Set(lookups.map((c) => c[c.indexOf("--start-time") + 1] ?? ""));
    expect(starts.size).toBe(1);
    return Date.parse([...starts][0] ?? "");
  };
  const iso = (t: number) => new Date(t).toISOString();
  const apiEnvOf = (env: Record<string, string>) => ({
    ...env,
    AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
    AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
    AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
  });
  const logEventOf = (r: ReturnType<typeof issue>, id: string) => ({
    $metadata: { id },
    $workers: { scriptName: "awsbridge-console", eventType: "fetch" },
    dataset: "cloudflare-workers",
    timestamp: Date.parse(r.at),
    source: r,
  });

  it("状態があれば、CloudTrail を「確認済みの区間の終わり − 24 時間」から読み、そのことと時刻を出す。成功すれば区間を進める", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const { env, records, state, log } = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a)] }],
      filterTime: true,
    });
    const covered = now() - 2 * H;
    writeFileSync(state, stateText(covered));
    const r = await run([...prof, "--records", records], env);
    expect(r.status, r.out).toBe(0);
    expect(startOf(log)).toBe(covered - DAY);
    expect(r.out).toContain(
      `read start: ${iso(covered - DAY)} (from the state: confirmed until ${iso(covered)} minus overlap 86400s)`,
    );
    expect(r.out).toContain(`window: ${iso(covered - DAY)} ..`);
    expect(r.out).toContain("coverage: continuous");
    expect(r.out).toContain("state: confirmed until");
    expect(
      Date.parse(JSON.parse(readFileSync(state, "utf8")).accounts[ACCOUNT].coveredUntil),
    ).toBeGreaterThan(covered);
    noSecrets(r.out, [a.jwt.jti]);
  });

  // 所見の保持（cto の決裁 2026-11-19 h5「重なりを縮めても進まない」）: #55 では既知の限界として「--overlap-seconds を短くすると次の実行で
  // 読まれず終了コード 0 で進む」を固定していた。検出した誤りは錨として状態に残るので、後半の期待値を逆にした。
  it("重なりの中の遅れた引き受け（前回の終わりより前・記録なし）は assume_without_record（誤り）で終了コード 1。状態は進めない。--overlap-seconds 3600 に変えても、読み始めは錨 − 1 時間になり同じ引き受けを読み直して終了コード 1 のまま", async () => {
    const late = issue({ jti: newJti(), at: now() - 4 * H });
    const { env, records, state, log } = setup({
      records: [],
      trails: [{ region: "us-east-1", events: [trail(late)] }],
      filterTime: true,
    });
    const covered = now() - 2 * H;
    writeFileSync(state, stateText(covered));
    const r = await run([...prof, "--records", records], env);
    expect(startOf(log)).toBe(covered - DAY);
    expect(r.out).toContain("assume_without_record");
    expect(r.out).toContain(late.jwt.jti.slice(0, 8));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("state: not advanced");
    const lateAt = late.jwt.iat * 1000 + 2000;
    expect(rowOf(state).coveredUntil).toBe(iso(covered));
    expect(rowOf(state).unresolved).toMatchObject({
      oldestAt: iso(lateAt),
      newestAt: iso(lateAt),
      codes: { assume_without_record: 1 },
    });

    // 重なりを 1 時間にしても、読み始めは min(終わり − 1 時間, 錨 − 1 時間) = 錨 − 1 時間（錨を読み直す）。誤りは消えず 1 のまま
    writeFileSync(log, "");
    const short = await run([...prof, "--records", records, "--overlap-seconds", "3600"], env);
    expect(startOf(log)).toBe(lateAt - H);
    expect(short.out).toContain(
      `from the unresolved findings: oldest ${iso(lateAt)} minus overlap 3600s`,
    );
    expect(short.out).toContain("assume_without_record");
    expect(short.status, short.out).toBe(1);
    expect(rowOf(state).coveredUntil).toBe(iso(covered));
    expect(rowOf(state).unresolved.oldestAt).toBe(iso(lateAt));
  });

  it("--since を渡せば状態があってもそれが勝つ（全部を読み直す監査用の指定）。前回の終わりより後なら今までどおり coverage_gap", async () => {
    const { env, records, state, log } = setup({ filterTime: true });
    const covered = now() - 2 * H;
    writeFileSync(state, stateText(covered));
    const t0 = now();
    const r = await run([...prof, "--records", records, "--since", "6d"], env);
    expect(r.status, r.out).toBe(0);
    const start = startOf(log);
    expect(start).toBeGreaterThanOrEqual(t0 - 6 * DAY - 1000);
    expect(start).toBeLessThanOrEqual(now() - 6 * DAY);
    expect(r.out).toContain(`read start: ${iso(start)} (--since)`);
    expect(r.out).toContain("coverage: continuous");

    writeFileSync(state, stateText(covered));
    const later = await run([...prof, "--records", records, "--since", "1h"], env);
    expect(later.out).toContain("coverage_gap");
    expect(later.out).toContain("(--since)");
    expect(later.status, later.out).toBe(1);
    // coverage_gap は保存しない（q3）。確認済みの区間はそのまま
    expect(rowOf(state)).toEqual({ coveredUntil: iso(covered) });
  });

  it("状態が無い初回は今までどおり 6 日。終わり − 重なりが 6 日より前でも 6 日（穴なし）。6 日より前に終わった状態は今までどおり coverage_gap", async () => {
    const first = setup({ filterTime: true });
    const t0 = now();
    const r = await run([...prof, "--records", first.records, "--init"], first.env);
    expect(r.status, r.out).toBe(0);
    const start = startOf(first.log);
    expect(start).toBeGreaterThanOrEqual(t0 - 6 * DAY - 1000);
    expect(start).toBeLessThanOrEqual(now() - 6 * DAY);
    expect(r.out).toContain(
      `read start: ${iso(start)} (default lookback 6d; no confirmed interval on record)`,
    );
    expect(r.out).toContain("coverage: first run");

    const near = setup({ filterTime: true });
    const covered = now() - 5 * DAY - 12 * H;
    writeFileSync(near.state, stateText(covered));
    const n = await run([...prof, "--records", near.records], near.env);
    expect(n.status, n.out).toBe(0);
    expect(n.out).toContain(
      `(default lookback 6d; the confirmed interval ends ${iso(covered)}, the overlap would go back further)`,
    );
    expect(n.out).toContain("coverage: continuous");

    const old = setup({ filterTime: true });
    writeFileSync(old.state, stateText(now() - 8 * DAY));
    const g = await run([...prof, "--records", old.records], old.env);
    expect(g.out).toContain("coverage_gap");
    expect(g.out).toContain("default lookback 6d");
    expect(g.status, g.out).toBe(1);
  });

  it("--overlap-seconds が 1 時間（3600）未満・整数でなければ実行できない（終了コード 2。aws を呼ばない）", async () => {
    for (const v of ["3599", "0", "1.5", "24h"]) {
      const { env, records, log } = setup({});
      const r = await run([...prof, "--records", records, "--overlap-seconds", v], env);
      expect(r.status, `${v}: ${r.out}`).toBe(2);
      expect(r.out).toContain("--overlap-seconds");
      expect(callsOf(log)).toEqual([]);
    }
  });

  it("状態が壊れている・未来なら、--overlap-seconds があっても今までどおり実行しない（終了コード 2）", async () => {
    const { env, records, state, log } = setup({});
    writeFileSync(state, stateText(now() + DAY));
    const r = await run([...prof, "--records", records, "--overlap-seconds", "7200"], env);
    expect(r.status, r.out).toBe(2);
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    writeFileSync(state, "{");
    const broken = await run([...prof, "--records", records], env);
    expect(broken.status, broken.out).toBe(2);
  });

  it("--until だけを状態の終わり − 重なりより前にすると、読み始めが終わりを越えるので実行できない（終了コード 2。CloudTrail を読まない）", async () => {
    const { env, records, state, log } = setup({});
    const covered = now() - 2 * H;
    writeFileSync(state, stateText(covered));
    const r = await run([...prof, "--records", records, "--until", iso(covered - 2 * DAY)], env);
    expect(r.status, r.out).toBe(2);
    expect(callsOf(log).some((c) => c[1] === "lookup-events")).toBe(false);
  });

  it("--logs-api: 状態があれば照会の窓も「終わり − 重なり − 15 分」より前を含まない。古い区間を含む照会が間引かれる（sampleInterval > 1）ときも、状態から始めれば読める", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    apiEvents = [logEventOf(a, "e1")];
    // 3 日より前を含む照会の件数は間引かれる
    apiCountSampledBefore = now() - 3 * DAY;
    // 状態が無い初回（6 日）は、古い区間を含むので record_read_incomplete（今までどおり誤り）
    const first = setup({ trails: [{ region: "us-east-1", events: [trail(a)] }] });
    const r1 = await run([...prof, "--logs-api", "--init"], apiEnvOf(first.env));
    expect(r1.out).toContain("record_read_incomplete");
    expect(r1.status, r1.out).toBe(1);

    reqs.length = 0;
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(a)] }] });
    const covered = now() - 2 * H;
    writeFileSync(s.state, stateText(covered));
    const r = await run([...prof, "--logs-api"], apiEnvOf(s.env));
    expect(r.out).not.toContain("record_read_incomplete");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/matched: 1/);
    expect(reqs.length).toBeGreaterThan(0);
    for (const q of reqs)
      expect(JSON.parse(q.body).timeframe.from).toBeGreaterThanOrEqual(covered - DAY - 15 * MIN);
    noSecrets(r.out, [a.jwt.jti]);
  });
});

// ---- 同じ状態ファイルでの連続実行（あとから CloudTrail に出た過去の引き受け）と、読み始め・終わりの境界 ----
describe("console:reconcile: 同じ状態ファイルでの連続実行と、読み始めの境界", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  const stateText = (coveredUntil: string) =>
    JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil } } });
  const coveredOf = (state: string) =>
    Date.parse(JSON.parse(readFileSync(state, "utf8")).accounts[ACCOUNT].coveredUntil);
  const lookupArg = (log: string, name: string) => {
    const lookups = callsOf(log).filter((c) => c[1] === "lookup-events");
    expect(lookups.length).toBeGreaterThan(0);
    const vals = new Set(lookups.map((c) => c[c.indexOf(name) + 1] ?? ""));
    expect(vals.size).toBe(1);
    return [...vals][0] ?? "";
  };
  /** 偽の aws の応答の表に、あとから CloudTrail に出たイベントを足す（前回の照会には無かった過去の引き受け）。 */
  const addTrails = (dir: string, events: unknown[]) => {
    const p = join(dir, "table.json");
    const table = JSON.parse(readFileSync(p, "utf8"));
    table["cloudtrail lookup-events --region=us-east-1"].Events.push(...events);
    writeFileSync(p, JSON.stringify(table));
  };
  /** 秒にそろえた時刻（CloudTrail の eventTime は秒）。 */
  const sec = (t: number) => Math.floor(t / 1000) * 1000;

  it("1 回目が成功して状態が進んだあと、前回の終わりより前の引き受けが CloudTrail に遅れて出たら、重なりの中なら 2 回目で assume_without_record（終了コード 1・状態は進めない）", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const s = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a)] }],
      filterTime: true,
    });
    const first = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(first.status, first.out).toBe(0);
    expect(first.out).toContain("coverage: first run");
    const c1 = coveredOf(s.state);
    const afterFirst = readFileSync(s.state, "utf8");
    // 前回の終わりの 2 時間前の引き受け（記録なし）が、1 回目のあとに CloudTrail に出た
    const late = issue({ jti: newJti(), at: c1 - 2 * H });
    addTrails(s.dir, [trail(late)]);
    writeFileSync(s.log, "");
    const second = await run([...prof, "--records", s.records], s.env);
    expect(lookupArg(s.log, "--start-time")).toBe(iso(c1 - DAY));
    expect(second.out).toContain("from the state");
    expect(second.out).toContain("assume_without_record");
    expect(second.out).toContain(late.jwt.jti.slice(0, 8));
    expect(second.status, second.out).toBe(1);
    expect(second.out).toContain("state: not advanced");
    // 確認済みの区間は 1 回目のまま。遅れて出た引き受けは錨として残る
    expect(rowOf(s.state).coveredUntil).toBe(JSON.parse(afterFirst).accounts[ACCOUNT].coveredUntil);
    expect(rowOf(s.state).unresolved.codes).toEqual({ assume_without_record: 1 });
    // 終了コード 1 のとき、時刻を持つ誤りの最も古い時刻と、それが既定の窓（6 日）から外れる時刻を出す
    const lateAt = late.jwt.iat * 1000 + 2000;
    expect(second.out).toContain(
      `oldest error finding: ${iso(lateAt)} (it leaves the default window of 6d after ${iso(lateAt + 6 * DAY)}`,
    );
    expect(first.out).not.toContain("oldest error finding:");
  });

  // 一度も読まれていない誤りは保持できないので、前半は既知の限界のまま（#55 の注記の「期待値を逆にする」は、検出したあとの後半にだけ当たる。
  // cto の決裁 2026-11-19 §4 の承認）。--since 6d で一度見つけたあとは錨として残り、--since なしの実行でも消えない
  it("既知の限界: 遅れが重なり（既定 24 時間）を超えて CloudTrail に出た引き受けは、2 回目では読まれず検出されない（終了コード 0・状態は進む）。正常終了は重なりの外の遅れが無いことを証明しない。--since 6d で見つけたあとは、--since なしでも錨から読み戻して終了コード 1 のまま", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const s = setup({
      records: [a],
      trails: [{ region: "us-east-1", events: [trail(a)] }],
      filterTime: true,
    });
    const first = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(first.status, first.out).toBe(0);
    const c1 = coveredOf(s.state);
    // 前回の終わりの 25 時間前（重なりの外。6 日よりは新しい）の引き受け（記録なし）が、あとから出た
    const late = issue({ jti: newJti(), at: c1 - 25 * H });
    addTrails(s.dir, [trail(late)]);
    writeFileSync(s.log, "");
    const second = await run([...prof, "--records", s.records], s.env);
    expect(lookupArg(s.log, "--start-time")).toBe(iso(c1 - DAY));
    // 限界: 読まないので所見にならない（この試験はその限界を固定する。重なりを広げるか --since で読み直せば見つかる）
    expect(second.out).not.toContain("assume_without_record");
    expect(second.status, second.out).toBe(0);
    expect(coveredOf(s.state)).toBeGreaterThanOrEqual(c1);
    // --since で全部を読み直せば見つかる（監査用の指定）
    const audit = await run([...prof, "--records", s.records, "--since", "6d"], s.env);
    expect(audit.out).toContain("assume_without_record");
    expect(audit.status, audit.out).toBe(1);
    // 見つけた所見は錨として残る。--since なしの次の実行は「最も古い錨 − 重なり」から読み、所見は消えない
    const lateAt = late.jwt.iat * 1000 + 2000;
    expect(rowOf(s.state).unresolved.oldestAt).toBe(iso(lateAt));
    writeFileSync(s.log, "");
    const third = await run([...prof, "--records", s.records], s.env);
    expect(lookupArg(s.log, "--start-time")).toBe(iso(lateAt - DAY));
    expect(third.out).toContain("from the unresolved findings");
    expect(third.out).toContain("assume_without_record");
    expect(third.status, third.out).toBe(1);
  });

  it("--until がちょうど読み始め（状態の終わり − 重なり）か 1 ミリ秒前なら実行できない（終了コード 2）。1 ミリ秒後なら読み、過去の --until で成功しても確認済みの終わりを後ろに戻さない", async () => {
    const s = setup({ filterTime: true });
    const covered = now() - 2 * H;
    writeFileSync(s.state, stateText(iso(covered)));
    const start = covered - DAY;
    for (const u of [start, start - 1]) {
      writeFileSync(s.log, "");
      const r = await run([...prof, "--records", s.records, "--until", iso(u)], s.env);
      expect(r.status, `${iso(u)}: ${r.out}`).toBe(2);
      expect(callsOf(s.log).some((c) => c[1] === "lookup-events")).toBe(false);
    }
    writeFileSync(s.log, "");
    const ok = await run([...prof, "--records", s.records, "--until", iso(start + 1)], s.env);
    expect(ok.status, ok.out).toBe(0);
    expect(lookupArg(s.log, "--start-time")).toBe(iso(start));
    expect(lookupArg(s.log, "--end-time")).toBe(iso(start + 1));
    // 成功しても、確認済みの終わりは前回のまま（今回の終わり − lag は前回より前なので戻さない）
    expect(coveredOf(s.state)).toBe(covered);
    expect(ok.out).toContain(`state: confirmed until ${iso(covered)}`);
  });

  it("小数秒の状態の時刻（.5 など）は、ミリ秒のまま CloudTrail の --start-time に渡す", async () => {
    const s = setup({ filterTime: true });
    const whole = sec(now() - 2 * H);
    const text = `${iso(whole).slice(0, 19)}.5Z`;
    writeFileSync(s.state, stateText(text));
    const r = await run([...prof, "--records", s.records], s.env);
    expect(r.status, r.out).toBe(0);
    expect(lookupArg(s.log, "--start-time")).toBe(iso(whole + 500 - DAY));
    expect(lookupArg(s.log, "--start-time")).toMatch(/\.500Z$/);
    expect(r.out).toContain(`confirmed until ${iso(whole + 500)} minus overlap 86400s`);
  });

  it("--since・--until・--overlap-seconds を同時に渡すと、--since と --until の窓で読み、--overlap-seconds を使わないことを 1 行出す（終了コード は変えない）", async () => {
    const s = setup({ filterTime: true });
    writeFileSync(s.state, stateText(iso(now() - 2 * H)));
    const since = sec(now() - 3 * DAY);
    const until = sec(now() - 3 * H);
    const r = await run(
      [
        ...prof,
        "--records",
        s.records,
        "--since",
        iso(since),
        "--until",
        iso(until),
        "--overlap-seconds",
        "7200",
      ],
      s.env,
    );
    expect(r.status, r.out).toBe(0);
    expect(lookupArg(s.log, "--start-time")).toBe(iso(since));
    expect(lookupArg(s.log, "--end-time")).toBe(iso(until));
    expect(r.out).toContain(`read start: ${iso(since)} (--since)`);
    expect(r.out).toContain("--since があるので --overlap-seconds は使わない");
    // --overlap-seconds だけなら、その行は出さない
    const only = await run([...prof, "--records", s.records, "--overlap-seconds", "7200"], s.env);
    expect(only.out).not.toContain("--overlap-seconds は使わない");
  });

  it("--logs-api: 読み始めちょうどの引き受けと記録も読む（CloudTrail は読み始めから、記録の照会は読み始め − 15 分から）", async () => {
    const covered = sec(now() - 2 * H);
    const start = covered - DAY;
    const a = issue({ jti: newJti(), at: start });
    apiEvents = [
      {
        $metadata: { id: "edge" },
        $workers: { scriptName: "awsbridge-console", eventType: "fetch" },
        dataset: "cloudflare-workers",
        timestamp: start,
        source: a,
      },
    ];
    const s = setup({
      trails: [{ region: "us-east-1", events: [trail(a, { afterIssueSeconds: 0 })] }],
      filterTime: true,
    });
    writeFileSync(s.state, stateText(iso(covered)));
    const r = await run([...prof, "--logs-api"], {
      ...s.env,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    });
    expect(lookupArg(s.log, "--start-time")).toBe(iso(start));
    expect(r.out).toMatch(/matched: 1/);
    expect(r.status, r.out).toBe(0);
    const froms = reqs.map((q) => JSON.parse(q.body).timeframe.from as number);
    expect(Math.min(...froms)).toBe(start - 15 * MIN);
  });
});

// ---- 所見の保持と --init（cto の決裁 2026-11-19 h1〜h5・i1〜i7・q1〜q3）----
describe("console:reconcile: 状態の行が無いときに黙って初回にしない（--init。i1〜i7）", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const iso = (t: number) => new Date(t).toISOString();
  const v1 = (coveredUntil: number, account = ACCOUNT) =>
    JSON.stringify({ version: 1, accounts: { [account]: { coveredUntil: iso(coveredUntil) } } });

  it("状態のファイルが無く --init も無ければ state_missing（終了コード 2）。aws も Cloudflare も呼ばない。2 つの道を出す", async () => {
    const { env, records, log, state } = setup({});
    const r = await run([...prof, "--records", records], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("state_missing");
    expect(r.out).toContain("move the whole state file from there");
    expect(r.out).toContain("--init");
    expect(callsOf(log)).toEqual([]);
    expect(existsSync(state)).toBe(false);
    const api = await run([...prof, "--logs-api"], {
      ...env,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    });
    expect(api.status, api.out).toBe(2);
    expect(api.out).toContain("state_missing");
    expect(callsOf(log)).toEqual([]);
    expect(reqs).toEqual([]);
    noSecrets(api.out, []);
  });

  it("別のアカウントの行だけなら state_missing（終了コード 2。呼ぶのはアカウントを知る sts だけ。ファイルは変えない）", async () => {
    const { env, records, log, state } = setup({});
    const other = v1(now() - 2 * H, "444444444444");
    writeFileSync(state, other);
    const r = await run([...prof, "--records", records], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("state_missing");
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    expect(readFileSync(state, "utf8")).toBe(other);
    noSecrets(r.out, []);
  });

  it("行があるのに --init なら終了コード 2（CloudTrail を読まない。ファイルは変えない）", async () => {
    const { env, records, log, state } = setup({});
    const text = v1(now() - 2 * H);
    writeFileSync(state, text);
    const r = await run([...prof, "--records", records, "--init"], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("--init");
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    expect(readFileSync(state, "utf8")).toBe(text);
  });

  it("--init と --accept-unresolved は同時に使えない（終了コード 2。何も呼ばない）", async () => {
    const { env, records, log } = setup({});
    const r = await run(
      [...prof, "--records", records, "--init", "--accept-unresolved", "--reason", "x"],
      env,
    );
    expect(r.status, r.out).toBe(2);
    expect(callsOf(log)).toEqual([]);
  });

  it("--init の成功: coverage: first run (explicit --init)。行は coveredUntil だけ。毎回 unresolved と accepted intervals の行を出す", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    const s = setup({ records: [a], trails: [{ region: "us-east-1", events: [trail(a)] }] });
    const r = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("coverage: first run (explicit --init)");
    expect(r.out).toContain("unresolved: none");
    expect(r.out).toContain("accepted intervals: 0");
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
  });

  it("--init で誤り → 確認済みの区間の無い行（未解決の錨つき）ができ、次は --init なしで回り（unconfirmed）、所見は残る", async () => {
    const late = issue({ jti: newJti(), at: now() - 3 * H });
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }], filterTime: true });
    const first = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(first.status, first.out).toBe(1);
    const lateAt = late.jwt.iat * 1000 + 2000;
    expect(rowOf(s.state).coveredUntil).toBeUndefined();
    expect(rowOf(s.state).unresolved.oldestAt).toBe(iso(lateAt));
    writeFileSync(s.log, "");
    const second = await run([...prof, "--records", s.records], s.env);
    expect(second.out).toContain("coverage: unconfirmed");
    expect(second.out).not.toContain("coverage: first run");
    // 確認済みの区間の無い行は 6 日を読み直す（続き 4 の (1)。前は錨 − 重なりから読んでいた）
    expect(second.out).toContain(
      "(default lookback 6d; no confirmed interval on record; the oldest unresolved finding is",
    );
    expect(second.out).toContain("assume_without_record");
    expect(second.status, second.out).toBe(1);
    expect(rowOf(s.state).unresolved.oldestAt).toBe(iso(lateAt));
    expect(rowOf(s.state).coveredUntil).toBeUndefined();
  });
});

describe("console:reconcile: 所見の保持（h5 の負の試験・q の負の試験）", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  const v1 = (coveredUntil: number) =>
    JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil: iso(coveredUntil) } } });
  const v2 = (row: unknown) => JSON.stringify({ version: 2, accounts: { [ACCOUNT]: row } });
  /** 記録の無い引き受けを 1 回目で錨にする（状態は v1 の coveredUntil から）。 */
  async function anchored(lateAgo: number) {
    const late = issue({ jti: newJti(), at: now() - lateAgo });
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }], filterTime: true });
    const covered = now() - 2 * H;
    writeFileSync(s.state, v1(covered));
    const r = await run([...prof, "--records", s.records], s.env);
    expect(r.status, r.out).toBe(1);
    return { s, late, covered, lateAt: late.jwt.iat * 1000 + 2000 };
  }
  const addTrail = (dir: string, events: unknown[]) => {
    const p = join(dir, "table.json");
    const table = JSON.parse(readFileSync(p, "utf8"));
    table["cloudtrail lookup-events --region=us-east-1"].Events.push(...events);
    writeFileSync(p, JSON.stringify(table));
  };

  it("version 1 の状態を読み（unresolved なし）、書くときは version 2", async () => {
    const s = setup({});
    const covered = now() - 2 * H;
    writeFileSync(s.state, v1(covered));
    const r = await run([...prof, "--records", s.records], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("coverage: continuous");
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
  });

  it("壊れた version 2（知らない項目・理由の本文）は実行しない（終了コード 2。CloudTrail を読まない。中身を出さない。ファイルは変えない）", async () => {
    for (const row of [
      { coveredUntil: iso(now() - H), unresolved: { oldestAt: "secret-nope" } },
      {
        coveredUntil: iso(now() - H),
        accepted: [
          {
            from: iso(now() - H),
            until: iso(now() - H),
            acceptedAt: iso(now()),
            reasonGiven: true,
            codes: { a: 1 },
            reason: "secret-nope",
          },
        ],
      },
      {},
    ]) {
      const s = setup({});
      writeFileSync(s.state, v2(row));
      const r = await run([...prof, "--records", s.records], s.env);
      expect(r.status, r.out).toBe(2);
      expect(r.out).not.toContain("secret-nope");
      expect(callsOf(s.log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
      expect(readFileSync(s.state, "utf8")).toBe(v2(row));
    }
  });

  it("錨が今 − 6 日より前なら、何度回しても unresolved_out_of_window で終了コード 1 のまま（受け入れなしに消えない）", async () => {
    const s = setup({ filterTime: true });
    const old = now() - 6 * DAY - H;
    const row = {
      coveredUntil: iso(now() - 2 * H),
      unresolved: {
        oldestAt: iso(old),
        newestAt: iso(old),
        firstSeenAt: iso(now() - 5 * DAY),
        criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
        codes: { assume_without_record: 1 },
      },
    };
    writeFileSync(s.state, v2(row));
    for (let i = 0; i < 2; i++) {
      const r = await run([...prof, "--records", s.records], s.env);
      expect(r.out).toMatch(/^ERROR\s+unresolved_out_of_window/m);
      expect(r.out).toContain("default lookback 6d");
      expect(r.status, r.out).toBe(1);
      expect(rowOf(s.state)).toEqual(row);
    }
  });

  it("--since で錨より後から始めると unresolved_not_covered（誤り・終了コード 1・錨は残る）", async () => {
    const { s, lateAt, covered } = await anchored(4 * H);
    const r = await run([...prof, "--records", s.records, "--since", "1h"], s.env);
    expect(r.out).toMatch(/^ERROR\s+unresolved_not_covered/m);
    expect(r.status, r.out).toBe(1);
    expect(rowOf(s.state).unresolved.oldestAt).toBe(iso(lateAt));
    expect(rowOf(s.state).coveredUntil).toBe(iso(covered));
  });

  it("理由の無い受け入れは通らない（--reason なし・空白だけ・--reason だけ。終了コード 2。何も呼ばない）", async () => {
    const { s } = await anchored(4 * H);
    const before = readFileSync(s.state, "utf8");
    for (const extra of [
      ["--accept-unresolved"],
      ["--accept-unresolved", "--reason", "   "],
      ["--reason", "x"],
    ]) {
      writeFileSync(s.log, "");
      const r = await run([...prof, "--records", s.records, ...extra], s.env);
      expect(r.status, `${extra.join(" ")}: ${r.out}`).toBe(2);
      expect(callsOf(s.log)).toEqual([]);
      expect(readFileSync(s.state, "utf8")).toBe(before);
    }
  });

  it("受け入れるもの（錨も今回の coverage_gap も）が無ければ終了コード 2（CloudTrail を読まない）", async () => {
    const s = setup({});
    writeFileSync(s.state, v1(now() - 2 * H));
    const r = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "nothing"],
      s.env,
    );
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("nothing to accept");
    expect(callsOf(s.log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
  });

  it("窓の中の錨を受け入れる: その実行は 0（区間と理由を出力し、状態には理由の本文を入れない）。次の実行でも note（accepted）のまま 0", async () => {
    const { s, lateAt, covered } = await anchored(4 * H);
    const reason = "checked with the operator: a test login";
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", reason],
      s.env,
    );
    expect(acc.status, acc.out).toBe(0);
    expect(acc.out).toContain(
      `accepted: ${iso(lateAt)} .. ${iso(lateAt)} (width 0s; unverified; not confirmed; assume_without_record=1; reason: ${reason})`,
    );
    expect(acc.out).toContain(
      "an interval is accepted, not findings: every finding with a time inside it, including ones not recorded before, is not an error from now on",
    );
    // 幅が重なり（既定 24 時間）以下なら警告の行は出さない（続き 4 の A3）
    expect(acc.out).not.toContain("wider than the overlap");
    expect(acc.out).toMatch(/^NOTE\s+assume_without_record.*\(accepted\)/m);
    expect(acc.out).toContain("errors: 0");
    const row = rowOf(s.state);
    expect(row.unresolved).toBeUndefined();
    expect(Date.parse(row.coveredUntil)).toBeGreaterThan(covered);
    expect(row.accepted).toEqual([
      {
        from: iso(lateAt),
        until: iso(lateAt),
        acceptedAt: expect.any(String),
        reasonGiven: true,
        codes: { assume_without_record: 1 },
      },
    ]);
    expect(readFileSync(s.state, "utf8")).not.toContain("operator");
    const next = await run([...prof, "--records", s.records, "--since", "6d"], s.env);
    expect(next.status, next.out).toBe(0);
    expect(next.out).toMatch(/^NOTE\s+assume_without_record.*\(accepted\)/m);
    expect(next.out).toContain(`accepted intervals: 1 (latest ${iso(lateAt)} .. ${iso(lateAt)}`);
  });

  it("受け入れの実行で錨を読み直して誤り 0（記録があとから読めた）なら、受け入れた区間を作らずにこの実行で解決する（終了コード 0）", async () => {
    const { s, late, covered } = await anchored(4 * H);
    writeFileSync(s.records, JSON.stringify(late));
    const r = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("resolved by this run (no accepted interval recorded)");
    expect(r.out).not.toMatch(/^accepted: /m);
    expect(r.out).toContain("accepted intervals: 0");
    const row = rowOf(s.state);
    expect(Object.keys(row)).toEqual(["coveredUntil"]);
    expect(Date.parse(row.coveredUntil)).toBeGreaterThan(covered);
  });

  // 続き 4 の (1): 確認済みの区間の無い行は、読み始めが今 − 6 日より後なら誤り（前は --since 1h の誤り 0 で確認済みになっていた。期待値を逆にした）
  it("--init（--since 2h）が時刻なしの誤り → --since 1h は unconfirmed_not_covered（誤り・行は変えない）→ --since なしで誤り 0 なら確認済み", async () => {
    const s = setup({
      failOn: "cloudtrail lookup-events --region=ap-northeast-1",
      filterTime: true,
    });
    const first = await run([...prof, "--records", s.records, "--init", "--since", "2h"], s.env);
    expect(first.status, first.out).toBe(1);
    expect(first.out).not.toContain("unconfirmed_not_covered");
    expect(Object.keys(rowOf(s.state)).sort()).toEqual(["untimed", "watchStart"]);
    expect(rowOf(s.state).untimed.codes).toEqual({ region_unread: 1 });
    const { AWS_STUB_FAIL_ON: _drop, ...ok } = s.env;
    const short = await run([...prof, "--records", s.records, "--since", "1h"], ok);
    expect(short.out).toContain("coverage: unconfirmed");
    expect(short.out).toMatch(/^ERROR\s+unconfirmed_not_covered/m);
    expect(short.status, short.out).toBe(1);
    expect(Object.keys(rowOf(s.state)).sort()).toEqual(["untimed", "watchStart"]);
    expect(rowOf(s.state).untimed.codes).toEqual({ region_unread: 1 });
    writeFileSync(s.log, "");
    const t0 = now();
    const full = await run([...prof, "--records", s.records], ok);
    expect(full.status, full.out).toBe(0);
    const start = Date.parse(lookupStart(s.log));
    expect(start).toBeGreaterThanOrEqual(t0 - 6 * DAY - 1000);
    expect(start).toBeLessThanOrEqual(now() - 6 * DAY);
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
  });

  it("時刻なしの誤りの件数は誤り 0 の実行でだけ消える: 次の実行が時刻を持つ誤りだけでも残る（続き 4 の (2)）", async () => {
    const s = setup({
      failOn: "cloudtrail lookup-events --region=ap-northeast-1",
      filterTime: true,
    });
    const covered = now() - 2 * H;
    writeFileSync(s.state, v1(covered));
    expect((await run([...prof, "--records", s.records], s.env)).status).toBe(1);
    const late = issue({ jti: newJti(), at: now() - 3 * H });
    addTrail(s.dir, [trail(late)]);
    const { AWS_STUB_FAIL_ON: _drop, ...ok } = s.env;
    const r = await run([...prof, "--records", s.records], ok);
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toMatch(/^ERROR\s+region_unread/m);
    expect(rowOf(s.state).untimed.codes).toEqual({ region_unread: 1 });
    expect(rowOf(s.state).unresolved.codes).toEqual({ assume_without_record: 1 });
    expect(r.out).toContain("unresolved untimed errors (largest count per code): region_unread=1");
  });

  it("同じ状態のファイルを実行の途中でほかが書き換えたら、今回の所見を出してから終了コード 2（書かない。続き 4 の (5)）", async () => {
    const { s } = await anchored(4 * H);
    const other = JSON.stringify({
      version: 1,
      accounts: { "444444444444": { coveredUntil: iso(now() - H) } },
    });
    const env = { ...s.env, AWS_STUB_TOUCH: s.state, AWS_STUB_TOUCH_TEXT: other };
    const r = await run([...prof, "--records", s.records], env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("assume_without_record");
    expect(r.out).toMatch(/errors: \d+/);
    expect(r.out).toContain("changed while this run was running");
    expect(r.out).toContain(
      "do not run the reconciliation at the same time with the same state file",
    );
    expect(readFileSync(s.state, "utf8")).toBe(other);
    noSecrets(r.out, []);
  });

  it("--help: 使い方と、受け入れは区間に対して行うこと（記録に無かった所見も誤りにならない）を出し、終了コード 0（何も呼ばない）", async () => {
    const s = setup({});
    const r = await run(["--help"], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("--accept-unresolved --reason");
    expect(r.out).toContain("accepts an interval, not findings");
    expect(r.out).toContain("including ones not recorded before");
    expect(r.out).toContain("cannot be used with --until");
    expect(callsOf(s.log)).toEqual([]);
  });

  it("受け入れの実行に区間の外の今回初めての誤りがあれば、終了コード 1 で受け入れを適用しない（accepted は増えない）", async () => {
    const { s, lateAt } = await anchored(4 * H);
    const fresh = issue({ jti: newJti(), at: now() - H });
    addTrail(s.dir, [trail(fresh)]);
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(acc.status, acc.out).toBe(1);
    expect(acc.out).toContain("accept: not applied");
    const row = rowOf(s.state);
    expect(row.accepted).toBeUndefined();
    expect(row.unresolved.oldestAt).toBe(iso(lateAt));
    expect(row.unresolved.newestAt).toBe(iso(fresh.jwt.iat * 1000 + 2000));
  });

  it("受け入れた区間の外の同じ code は誤り（終了コード 1）。区間の中の所見は note のまま", async () => {
    const { s, lateAt } = await anchored(4 * H);
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(acc.status, acc.out).toBe(0);
    const other = issue({ jti: newJti(), at: now() - 3 * H });
    addTrail(s.dir, [trail(other)]);
    const r = await run([...prof, "--records", s.records, "--since", "6d"], s.env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^ERROR\s+assume_without_record/m);
    expect(r.out).toMatch(/^NOTE\s+assume_without_record.*\(accepted\)/m);
    expect(rowOf(s.state).unresolved.oldestAt).toBe(iso(other.jwt.iat * 1000 + 2000));
    expect(rowOf(s.state).accepted).toHaveLength(1);
    expect(lateAt).toBeLessThan(other.jwt.iat * 1000);
  });

  it("今回の coverage_gap を受け入れる: 区間は [前回の終わり, 今回の読み始め]。確認済みの区間はその実行が読んだ分だけ進み、次は continuous", async () => {
    const s = setup({ filterTime: true });
    const old = now() - 8 * DAY;
    writeFileSync(s.state, v1(old));
    const gap = await run([...prof, "--records", s.records], s.env);
    expect(gap.status, gap.out).toBe(1);
    expect(rowOf(s.state)).toEqual({ coveredUntil: iso(old) });
    writeFileSync(s.log, "");
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "machine was off"],
      s.env,
    );
    expect(acc.status, acc.out).toBe(0);
    const start = Date.parse(lookupStart(s.log));
    expect(acc.out).toContain(
      `accepted: ${iso(old)} .. ${iso(start)} (width ${Math.round((start - old) / 1000)}s; unverified; not confirmed; coverage_gap=1`,
    );
    // 幅が重なり（既定 24 時間）を超えるので警告の 1 行（続き 4 の A3）
    expect(acc.out).toMatch(
      /^WARN\s+the accepted interval \(width \d+s\) is wider than the overlap \(86400s\)/m,
    );
    const row = rowOf(s.state);
    expect(row.accepted[0]).toMatchObject({
      from: iso(old),
      until: iso(start),
      codes: { coverage_gap: 1 },
    });
    expect(Date.parse(row.coveredUntil)).toBeGreaterThan(start);
    const next = await run([...prof, "--records", s.records], s.env);
    expect(next.status, next.out).toBe(0);
    expect(next.out).toContain("coverage: continuous");
  });

  it("一時的な region_unread（時刻を持たない誤り）は件数だけ残り、次の誤り 0 の実行で消えて区間が進む（受け入れは要らない）", async () => {
    const s = setup({
      failOn: "cloudtrail lookup-events --region=ap-northeast-1",
      filterTime: true,
    });
    const covered = now() - 2 * H;
    writeFileSync(s.state, v1(covered));
    const r = await run([...prof, "--records", s.records], s.env);
    expect(r.status, r.out).toBe(1);
    expect(rowOf(s.state)).toEqual({
      coveredUntil: iso(covered),
      untimed: {
        codes: { region_unread: 1 },
        firstWindowStart: iso(covered - 24 * H),
        settledUntil: expect.any(String),
      },
    });
    expect(r.out).toContain("unresolved untimed errors (largest count per code): region_unread=1");
    const { AWS_STUB_FAIL_ON: _drop, ...ok } = s.env;
    const again = await run([...prof, "--records", s.records], ok);
    expect(again.status, again.out).toBe(0);
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
    expect(Date.parse(rowOf(s.state).coveredUntil)).toBeGreaterThan(covered);
  });

  it("--init の初回が record_read_incomplete（時刻を持たない誤り）だけなら、次の 6 日の読みで誤り 0 なら確認済みになる", async () => {
    const a = issue({ jti: newJti(), at: now() - 60 * MIN });
    apiEvents = [
      {
        $metadata: { id: "e1" },
        $workers: { scriptName: "awsbridge-console", eventType: "fetch" },
        dataset: "cloudflare-workers",
        timestamp: Date.parse(a.at),
        source: a,
      },
    ];
    apiCountSampledBefore = now() - 3 * DAY;
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(a)] }], filterTime: true });
    const env = {
      ...s.env,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: base,
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    };
    const first = await run([...prof, "--logs-api", "--init"], env);
    expect(first.out).toContain("record_read_incomplete");
    expect(first.status, first.out).toBe(1);
    expect(Object.keys(rowOf(s.state)).sort()).toEqual(["untimed", "watchStart"]);
    // 翌日: 間引きが解けた（一時的な読みの失敗）。6 日を読み直して誤り 0 なら確認済み
    apiCountSampledBefore = undefined;
    writeFileSync(s.log, "");
    const t0 = now();
    const next = await run([...prof, "--logs-api"], env);
    expect(next.status, next.out).toBe(0);
    expect(next.out).toContain("coverage: unconfirmed");
    const start = Date.parse(lookupStart(s.log));
    expect(start).toBeGreaterThanOrEqual(t0 - 6 * DAY - 1000);
    expect(start).toBeLessThanOrEqual(now() - 6 * DAY);
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
  });
});

describe("console:reconcile: 続き 5（ロック・判定した範囲・時刻なしの誤りの範囲・受け入れの出力の順・区間に対する受け入れ）", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const iso = (t: number) => new Date(t).toISOString();
  const v1 = (coveredUntil: number) =>
    JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil: iso(coveredUntil) } } });
  const addTrail = (dir: string, events: unknown[]) => {
    const p = join(dir, "table.json");
    const table = JSON.parse(readFileSync(p, "utf8"));
    table["cloudtrail lookup-events --region=us-east-1"].Events.push(...events);
    writeFileSync(p, JSON.stringify(table));
  };

  it("R1: 状態のファイルの隣のロック（<state>.lock）があれば、何も読まず終了コード 2（ロックも状態も変えない）", async () => {
    const s = setup({});
    const stateBefore = v1(now() - 2 * H);
    writeFileSync(s.state, stateBefore);
    const lock = `${s.state}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: iso(now()) }));
    const r = await run([...prof, "--records", s.records], s.env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("another reconciliation is running with the same state file");
    expect(r.out).toContain("check the lock file and remove it");
    expect(callsOf(s.log)).toEqual([]);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(s.state, "utf8")).toBe(stateBefore);
    noSecrets(r.out, []);
  });

  it("R1: ロックは終了コード 0・1・2 のどれでも消える。中身は pid と開始時刻だけ", async () => {
    const ok = setup({});
    writeFileSync(ok.state, v1(now() - 2 * H));
    expect((await run([...prof, "--records", ok.records], ok.env)).status).toBe(0);
    expect(existsSync(`${ok.state}.lock`)).toBe(false);
    const late = issue({ jti: newJti(), at: now() - 3 * H });
    const bad = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }] });
    writeFileSync(bad.state, v1(now() - 2 * H));
    expect((await run([...prof, "--records", bad.records], bad.env)).status).toBe(1);
    expect(existsSync(`${bad.state}.lock`)).toBe(false);
    const fail = setup({ failOn: "account list-regions|ec2 describe-regions" });
    writeFileSync(fail.state, v1(now() - 2 * H));
    expect((await run([...prof, "--records", fail.records], fail.env)).status).toBe(2);
    expect(existsSync(`${fail.state}.lock`)).toBe(false);
    const missing = setup({});
    expect((await run([...prof, "--records", missing.records], missing.env)).status).toBe(2);
    expect(existsSync(`${missing.state}.lock`)).toBe(false);
  });

  it("R4: 時刻なしの誤りは、--until を過去にした誤り 0 の実行と、--since を後ろにした誤り 0 の実行では消えない。既定の実行は記録した実行の窓まで戻して読み直し、消える", async () => {
    const s = setup({
      failOn: "cloudtrail lookup-events --region=ap-northeast-1",
      filterTime: true,
    });
    const covered = now() - 2 * H;
    writeFileSync(s.state, v1(covered));
    expect((await run([...prof, "--records", s.records], s.env)).status).toBe(1);
    const recorded = rowOf(s.state).untimed;
    expect(recorded.codes).toEqual({ region_unread: 1 });
    expect(recorded.firstWindowStart).toBe(iso(covered - 24 * H));
    const { AWS_STUB_FAIL_ON: _drop, ...ok } = s.env;
    const past = await run([...prof, "--records", s.records, "--until", iso(now() - H)], ok);
    expect(past.status, past.out).toBe(0);
    expect(rowOf(s.state).untimed).toEqual(recorded);
    const later = await run([...prof, "--records", s.records, "--since", "25h"], ok);
    expect(later.status, later.out).toBe(0);
    expect(rowOf(s.state).untimed).toEqual(recorded);
    writeFileSync(s.log, "");
    const plain = await run([...prof, "--records", s.records], ok);
    expect(plain.status, plain.out).toBe(0);
    expect(plain.out).toContain("from the unresolved untimed errors");
    expect(lookupStart(s.log)).toBe(recorded.firstWindowStart);
    expect(rowOf(s.state).untimed).toBeUndefined();
  });

  it("R5: 受け入れは状態を書く前に acceptance (not yet written) を出し、書けたあとに accepted: を出す。書けなければ accepted: を出さず、保存されていないと出す", async () => {
    const late = issue({ jti: newJti(), at: now() - 4 * H });
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }], filterTime: true });
    writeFileSync(s.state, v1(now() - 2 * H));
    expect((await run([...prof, "--records", s.records], s.env)).status).toBe(1);
    const before = readFileSync(s.state, "utf8");
    const other = JSON.stringify({
      version: 1,
      accounts: { "444444444444": { coveredUntil: iso(now() - H) } },
    });
    const conflict = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      { ...s.env, AWS_STUB_TOUCH: s.state, AWS_STUB_TOUCH_TEXT: other },
    );
    expect(conflict.status, conflict.out).toBe(2);
    expect(conflict.out).toContain("acceptance (not yet written):");
    expect(conflict.out).not.toMatch(/^accepted: /m);
    expect(conflict.out).toContain("the acceptance was not saved");
    writeFileSync(s.state, before);
    const ok = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(ok.status, ok.out).toBe(0);
    const i = ok.out.indexOf("acceptance (not yet written):");
    const j = ok.out.search(/^accepted: /m);
    const k = ok.out.indexOf("state: confirmed until");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    expect(j).toBeGreaterThan(k);
  });

  it("R6: 受け入れを保存したあと、同じ区間に記録に無かった code の時刻を持つ誤りが出ても note（区間に対して行う）。時刻を持たない誤りは下がらない", async () => {
    const late = issue({ jti: newJti(), at: now() - 4 * H });
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }], filterTime: true });
    writeFileSync(s.state, v1(now() - 2 * H));
    expect((await run([...prof, "--records", s.records], s.env)).status).toBe(1);
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(acc.status, acc.out).toBe(0);
    const lateAt = late.jwt.iat * 1000 + 2000;
    expect(rowOf(s.state).accepted[0]).toMatchObject({ from: iso(lateAt), until: iso(lateAt) });
    // 同じ時刻（区間の中）に、記録に無かった code（identity_mismatch）の引き受けが遅れて出た
    const same = issue({ jti: newJti(), at: Date.parse(late.at) });
    writeFileSync(s.records, JSON.stringify(same));
    addTrail(s.dir, [trail(same, { sourceIdentity: "bob@example.org" })]);
    const r = await run([...prof, "--records", s.records, "--since", "6d"], s.env);
    expect(r.out).toMatch(/^NOTE\s+identity_mismatch.*\(accepted\)/m);
    expect(r.out).toMatch(/^NOTE\s+assume_without_record.*\(accepted\)/m);
    expect(r.status, r.out).toBe(0);
    // 時刻を持たない誤り（region_unread）は区間に関係なく誤り
    const unread = await run([...prof, "--records", s.records], {
      ...s.env,
      AWS_STUB_FAIL_ON: "cloudtrail lookup-events --region=ap-northeast-1",
    });
    expect(unread.out).toMatch(/^ERROR\s+region_unread/m);
    expect(unread.status, unread.out).toBe(1);
  });

  it("R6: 確認済みの区間の無い行で --since を後ろにした受け入れは unconfirmed_not_covered が残り、適用しない（終了コード 1・accepted なし）", async () => {
    const late = issue({ jti: newJti(), at: now() - 3 * H });
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }], filterTime: true });
    // 見張りの始まりを 2 時間前にした --init（--since なしの --init は見張りがその実行の時刻から始まり、--since 1h でも読める。続き 5 の w1）
    expect(
      (await run([...prof, "--records", s.records, "--init", "--since", "4h"], s.env)).status,
    ).toBe(1);
    const r = await run(
      [...prof, "--records", s.records, "--since", "1h", "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(r.out).toMatch(/^ERROR\s+unconfirmed_not_covered/m);
    expect(r.out).toContain("accept: not applied");
    expect(r.status, r.out).toBe(1);
    expect(rowOf(s.state).accepted).toBeUndefined();
  });

  it("R3: 記録した件数が上限で飽和していれば受け入れを適用しない（終了コード 1 と理由）", async () => {
    const late = issue({ jti: newJti(), at: now() - 4 * H });
    const s = setup({ trails: [{ region: "us-east-1", events: [trail(late)] }], filterTime: true });
    const lateAt = iso(late.jwt.iat * 1000 + 2000);
    writeFileSync(
      s.state,
      JSON.stringify({
        version: 2,
        accounts: {
          [ACCOUNT]: {
            coveredUntil: iso(now() - 2 * H),
            unresolved: {
              oldestAt: lateAt,
              newestAt: lateAt,
              firstSeenAt: iso(now() - H),
              codes: { assume_without_record: 1_000_000 },
              criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
            },
          },
        },
      }),
    );
    const r = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("saturated");
    expect(rowOf(s.state).accepted).toBeUndefined();
  });
});

describe("console:reconcile: 続き 6（受け入れと untimed・シグナルでのロック・state_missing の順）", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const iso = (t: number) => new Date(t).toISOString();
  const v1 = (coveredUntil: number) =>
    JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil: iso(coveredUntil) } } });

  it("U3: --since を 1 時間前にした受け入れ（region_unread の窓は未読）では、錨は受け入れても untimed は残る", async () => {
    const late = issue({ jti: newJti(), at: now() - 4 * H });
    const s = setup({
      trails: [{ region: "us-east-1", events: [trail(late)] }],
      failOn: "cloudtrail lookup-events --region=ap-northeast-1",
      filterTime: true,
    });
    writeFileSync(s.state, v1(now() - 2 * H));
    expect((await run([...prof, "--records", s.records], s.env)).status).toBe(1);
    const recorded = rowOf(s.state).untimed;
    expect(recorded.codes).toEqual({ region_unread: 1 });
    const { AWS_STUB_FAIL_ON: _drop, ...ok } = s.env;
    const acc = await run(
      [...prof, "--records", s.records, "--since", "1h", "--accept-unresolved", "--reason", "x"],
      ok,
    );
    expect(acc.status, acc.out).toBe(0);
    expect(rowOf(s.state).unresolved).toBeUndefined();
    expect(rowOf(s.state).accepted).toHaveLength(1);
    expect(rowOf(s.state).untimed).toEqual(recorded);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const)
    it(`U5: ${signal} で止めてもロックを消す（元の終わり方で終わる）`, async () => {
      const s = setup({});
      writeFileSync(s.state, v1(now() - 2 * H));
      const lock = `${s.state}.lock`;
      const p = spawn(
        join(root, "node_modules/.bin/tsx"),
        [
          join(root, "scripts/console/reconcile.ts"),
          ...prof,
          "--records",
          s.records,
          "--state",
          s.state,
        ],
        { cwd: root, env: { ...s.env, AWS_STUB_SLEEP_MS: "20000" } },
      );
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        p.on("close", (code, sig) => resolve({ code, signal: sig })),
      );
      // ロックを取り、CloudTrail を読みに行った（偽の aws が待っている）ところで止める
      for (let i = 0; i < 200 && !callsOf(s.log).some((c) => c[1] === "lookup-events"); i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(lock)).toBe(true);
      p.kill(signal);
      const end = await closed;
      expect(end.code === null ? end.signal : end.code).not.toBe(0);
      expect(existsSync(lock)).toBe(false);
    });

  it("U6: ファイルが無く --init も無い state_missing は、ロックを取る前（ディレクトリを作る前）に止める", async () => {
    const s = setup({});
    const dir = join(s.dir, "not-yet");
    const state = join(dir, "state.json");
    const r = await run([...prof, "--records", s.records, "--state", state], s.env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("state_missing");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("console:reconcile: 続き 5（cto）見張りの始まり（watchStart）と untimed_not_covered", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  const FAIL = "cloudtrail lookup-events --region=ap-northeast-1";
  const v2 = (row: unknown) => JSON.stringify({ version: 2, accounts: { [ACCOUNT]: row } });

  it("w1・w4: --since なしの --init が時刻なしの誤り → 見張りはその実行の時刻（until）から → 翌日の既定の実行は見張りを含むので誤り 0 なら確認済み", async () => {
    const s = setup({ failOn: FAIL, filterTime: true });
    const t0 = now();
    const init = await run([...prof, "--records", s.records, "--init"], s.env);
    expect(init.status, init.out).toBe(1);
    expect(init.out).toContain("watch starts:");
    const watch = Date.parse(rowOf(s.state).watchStart);
    expect(watch).toBeGreaterThanOrEqual(t0 - 1000);
    expect(watch).toBeLessThanOrEqual(now());
    const { AWS_STUB_FAIL_ON: _drop, ...ok } = s.env;
    const next = await run([...prof, "--records", s.records], ok);
    expect(next.status, next.out).toBe(0);
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
  });

  it("w1: --since つきの --init は見張りがその読み始めから（以後の誤りの実行でも動かない）", async () => {
    const s = setup({ failOn: FAIL, filterTime: true });
    const t0 = now();
    expect(
      (await run([...prof, "--records", s.records, "--init", "--since", "3h"], s.env)).status,
    ).toBe(1);
    const watch = rowOf(s.state).watchStart;
    expect(Date.parse(watch)).toBeGreaterThanOrEqual(t0 - 3 * H - 1000);
    expect(Date.parse(watch)).toBeLessThanOrEqual(now() - 3 * H);
    expect((await run([...prof, "--records", s.records], s.env)).status).toBe(1);
    expect(rowOf(s.state).watchStart).toBe(watch);
  });

  it("w3: 既定の読み始め（今 − 6 日）が見張りの始まりを過ぎたら毎回 untimed_not_covered。--since を見張り以前にして誤り 0 なら確認済み", async () => {
    const s = setup({ filterTime: true });
    const watch = now() - 6 * DAY - H;
    const row = {
      watchStart: iso(watch),
      untimed: {
        codes: { region_unread: 1 },
        firstWindowStart: iso(watch - DAY),
        settledUntil: iso(watch),
      },
    };
    writeFileSync(s.state, v2(row));
    for (let i = 0; i < 2; i++) {
      const r = await run([...prof, "--records", s.records], s.env);
      expect(r.out).toMatch(/^ERROR\s+untimed_not_covered/m);
      expect(r.status, r.out).toBe(1);
      expect(rowOf(s.state)).toEqual(row);
    }
    const back = await run([...prof, "--records", s.records, "--since", iso(watch)], s.env);
    expect(back.status, back.out).toBe(0);
    expect(Object.keys(rowOf(s.state))).toEqual(["coveredUntil"]);
  });

  it("w3: 受け入れると、受け入れた区間に [見張りの始まり, 今回の読み始め] が入り、untimed を消して確認済みになる", async () => {
    const s = setup({ filterTime: true });
    const watch = now() - 6 * DAY - H;
    writeFileSync(
      s.state,
      v2({
        watchStart: iso(watch),
        untimed: {
          codes: { region_unread: 1 },
          firstWindowStart: iso(watch - DAY),
          settledUntil: iso(watch),
        },
      }),
    );
    writeFileSync(s.log, "");
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(acc.status, acc.out).toBe(0);
    const start = lookupStart(s.log);
    const row = rowOf(s.state);
    expect(row.accepted[0]).toMatchObject({
      from: iso(watch),
      until: start,
      codes: { region_unread: 1, untimed_not_covered: 1 },
    });
    expect(row.untimed).toBeUndefined();
    expect(row.watchStart).toBeUndefined();
    expect(row.coveredUntil).toBeDefined();
  });

  it("w5・U1・U2: 確認済みの行で、時刻なしの誤りを記録した窓が既定の窓より前なら毎回 untimed_not_covered。受け入れたときだけ消える", async () => {
    const s = setup({ filterTime: true });
    const first = now() - 6 * DAY - H;
    const row = {
      coveredUntil: iso(now() - 2 * H),
      untimed: {
        codes: { record_read_incomplete: 1 },
        firstWindowStart: iso(first),
        settledUntil: iso(now() - 3 * H),
      },
    };
    writeFileSync(s.state, v2(row));
    const r = await run([...prof, "--records", s.records], s.env);
    expect(r.out).toMatch(/^ERROR\s+untimed_not_covered/m);
    expect(r.status, r.out).toBe(1);
    expect(rowOf(s.state)).toEqual(row);
    const acc = await run(
      [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
      s.env,
    );
    expect(acc.status, acc.out).toBe(0);
    expect(rowOf(s.state).untimed).toBeUndefined();
    expect(rowOf(s.state).accepted[0]).toMatchObject({
      from: iso(first),
      codes: { untimed_not_covered: 1 },
    });
  });
});

describe("console:reconcile: 続き 7（V1・cto 続き 6 の s1〜s3）受け入れの実行に --until は付けられない・untimed の範囲を覆う受け入れだけが消す", () => {
  const prof = ["--profile", "reconcile-test"];
  const H = 3_600_000;
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  const v2 = (row: unknown) => JSON.stringify({ version: 2, accounts: { [ACCOUNT]: row } });
  const rows = () => {
    const t = now();
    const untimed = {
      codes: { record_read_incomplete: 1 },
      firstWindowStart: iso(t - 6 * DAY - H),
      settledUntil: iso(t - H),
    };
    return {
      t,
      confirmed: { start: t - 6 * DAY - H, row: { coveredUntil: iso(t - 2 * H), untimed } },
      unconfirmed: {
        start: t - 6 * DAY - H,
        row: {
          watchStart: iso(t - 6 * DAY - H),
          untimed: { ...untimed, firstWindowStart: iso(t - 7 * DAY) },
        },
      },
    };
  };
  for (const kind of ["confirmed", "unconfirmed"] as const)
    it(`${kind === "confirmed" ? "確認済みの行" : "確認済みの区間の無い行"}: --until T−3h つきの受け入れは終了コード 2（何も読まず状態も変えない）。--until なしなら untimed が消え、受け入れた区間は [始まり, 読み始め]`, async () => {
      const s = setup({ filterTime: true });
      const all = rows();
      const { start, row } = all[kind];
      const text = v2(row);
      writeFileSync(s.state, text);
      const past = await run(
        [
          ...prof,
          "--records",
          s.records,
          "--accept-unresolved",
          "--reason",
          "x",
          "--until",
          iso(all.t - 3 * H),
        ],
        s.env,
      );
      expect(past.status, past.out).toBe(2);
      expect(past.out).toContain("--accept-unresolved cannot be used with --until");
      expect(callsOf(s.log)).toEqual([]);
      expect(readFileSync(s.state, "utf8")).toBe(text);
      const ok = await run(
        [...prof, "--records", s.records, "--accept-unresolved", "--reason", "x"],
        s.env,
      );
      expect(ok.status, ok.out).toBe(0);
      const after = rowOf(s.state);
      expect(after.untimed).toBeUndefined();
      expect(after.accepted).toHaveLength(1);
      expect(after.accepted[0]).toMatchObject({ from: iso(start), until: lookupStart(s.log) });
    });
});

/** lookup-events の --start-time（全リージョンで同じ）。 */
function lookupStart(log: string): string {
  const starts = new Set(
    callsOf(log)
      .filter((c) => c[1] === "lookup-events")
      .map((c) => c[c.indexOf("--start-time") + 1] ?? ""),
  );
  expect(starts.size).toBe(1);
  return [...starts][0] ?? "";
}
