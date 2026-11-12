// 突き合わせの道具の CLI（scripts/console/reconcile.ts。mise タスク console:reconcile）を実プロセスで動かす。
// aws は PATH の先頭に置いた偽のコマンド（材料の応答を返し、呼ばれた引数を記録する）、Cloudflare の API は手元（127.0.0.1）の
// 擬似サーバー（AWSBRIDGE_CONSOLE_LOGS_API_BASE は 127.0.0.1 だけ受け付ける）。実際の AWS・Cloudflare には接続しない。
// 確かめること: 呼ぶのは許可した aws のコマンドと照会の API だけ、出力に email・全桁の jti・12 桁のアカウント ID が無い、終了コード。
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const STD_ISSUER_ID = "id.example.com/standard";
const ADMIN_ISSUER_ID = "admin-id.example.com/admin";
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
let apiEvents: unknown[] = [];
let apiFail = false;

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
        res.end(
          JSON.stringify({
            success: true,
            result: { events: { events: apiEvents, count: apiEvents.length } },
          }),
        );
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
});

// ---- 材料 ----
let seq = 0;
const newJti = () => `${(++seq).toString(16).padStart(8, "0")}-1f4e-4c55-9d2a-7f3c1a2b3c4d`;

/** Worker の発行記録（issueLogRecord の形）。 */
function issue(o: { jti: string; at: number; tier?: "standard" | "admin"; region?: string }) {
  const tier = o.tier ?? "standard";
  return {
    event: "console_issue",
    result: "ok",
    at: new Date(o.at).toISOString(),
    tier,
    team: tier === "admin" ? "infra-elevated" : "infra",
    user: { email: "a***@***.com", sourceIdentity: "a***@***.com", accessSub: "1111…" },
    target: {
      accountId: ACCOUNT,
      role: tier === "admin" ? "administrator" : "viewer",
      roleArn: tier === "admin" ? ADMIN_ROLE : STD_ROLE,
      boundary: "managed",
      issuer: `https://${tier === "admin" ? ADMIN_ISSUER_ID : STD_ISSUER_ID}`,
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
function trail(r: ReturnType<typeof issue>) {
  const admin = r.tier === "admin";
  return {
    EventId: `ev-${r.jwt.jti}`,
    EventName: "AssumeRoleWithWebIdentity",
    CloudTrailEvent: JSON.stringify({
      eventVersion: "1.08",
      userIdentity: {
        type: "WebIdentityUser",
        userName: EMAIL,
        identityProvider: `arn:aws:iam::${ACCOUNT}:oidc-provider/${admin ? ADMIN_ISSUER_ID : STD_ISSUER_ID}`,
      },
      eventTime: new Date(Date.parse(r.at) + 2_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      eventSource: "sts.amazonaws.com",
      eventName: "AssumeRoleWithWebIdentity",
      awsRegion: r.sts.region,
      requestID: "5e1b7c2a-8d3f-4a6b-9c0d-112233445566",
      eventID: `ev-${r.jwt.jti}`,
      recipientAccountId: ACCOUNT,
      requestParameters: {
        roleArn: r.target.roleArn,
        roleSessionName: `console-${EMAIL}`,
        sourceIdentity: EMAIL,
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
process.stdout.write(JSON.stringify(table[key]));
`;

type Setup = {
  records?: unknown[];
  recordLines?: string[];
  trails?: { region: string; events: unknown[] }[];
  failOn?: string;
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
  };
  return { env, records, log };
}

/** 実プロセスで動かす（同じプロセスの擬似サーバーが応答できるよう、spawnSync ではなく非同期で待つ）。 */
function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console/reconcile.ts"), ...args],
      { cwd: root, env },
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
    const r = await run(["--profile", "reconcile-test", "--records", records], env);
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
    const r = await run(["--profile", "reconcile-test", "--records", records], env);
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
    const r = await run(["--profile", "reconcile-test", "--records", records], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("record_line_truncated");
    expect(r.out).toContain("truncated lines: 1");
  });

  it("読めなかったリージョンは region_unread で終了コード 1", async () => {
    const { env, records } = setup({ failOn: "cloudtrail lookup-events --region=ap-northeast-1" });
    const r = await run(["--profile", "reconcile-test", "--records", records], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("region_unread");
    expect(r.out).toContain("regions: read 1/2");
    noSecrets(r.out, []);
  });

  it("記録の保持より古く記録の無い引き受け（検証できない）が 1 件以上あれば、誤りが 0 でも終了コード 1", async () => {
    const old = issue({ jti: newJti(), at: now() - 8 * 86_400_000 });
    const { env, records } = setup({ trails: [{ region: "us-east-1", events: [trail(old)] }] });
    const r = await run(
      ["--profile", "reconcile-test", "--records", records, "--since", "10d"],
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
      ["--profile", "reconcile-test", "--records", records, "--since", "10d"],
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
        $workers: { scriptName: "awsbridge-console-standard", eventType: "fetch" },
        dataset: "cloudflare-workers",
        timestamp: Date.parse(a.at),
        source: a,
      },
    ];
    const { env } = setup({ trails: [{ region: "us-east-1", events: [trail(a)] }] });
    const r = await run(["--profile", "reconcile-test", "--logs-api"], {
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
    for (const q of reqs) {
      expect(q.method).toBe("POST");
      expect(q.url).toBe(`/accounts/${CF_ACCOUNT}/workers/observability/telemetry/query`);
      expect(q.auth).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(q.body);
      expect(body.view).toBe("events");
      expect(body.timeframe.from).toBeLessThan(body.timeframe.to);
    }
  });

  it("--logs-api: 宛先を 127.0.0.1 以外に向けられない・トークンが無ければ実行できない（終了コード 2。API を呼ばない）", async () => {
    const { env } = setup({});
    const api = {
      AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_CONSOLE_LOGS_TOKEN: TOKEN,
    };
    let r = await run(["--profile", "reconcile-test", "--logs-api"], {
      ...env,
      ...api,
      AWSBRIDGE_CONSOLE_LOGS_API_BASE: "http://example.com:80",
    });
    expect(r.status, r.out).toBe(2);
    r = await run(["--profile", "reconcile-test", "--logs-api"], {
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
    const r = await run(["--profile", "reconcile-test", "--logs-api"], {
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
    const r = await run(["--profile", "reconcile-test", "--records", dir], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/matched: 2/);
    expect(r.out).toMatch(/lines 2\)/);
  });

  it("--account-id がプロファイルのアカウントと違えば終了コード 2（CloudTrail を読まない）", async () => {
    const { env, records, log } = setup({});
    const r = await run(
      ["--profile", "reconcile-test", "--records", records, "--account-id", "444444444444"],
      env,
    );
    expect(r.status, r.out).toBe(2);
    expect(callsOf(log).map((c) => `${c[0]} ${c[1]}`)).toEqual(["sts get-caller-identity"]);
    noSecrets(r.out, []);
  });

  it("aws の失敗（エラーの文にアカウント ID と email を含む）で終了コード 2 のときも、出力は伏せ字", async () => {
    const { env, records } = setup({ failOn: "sts get-caller-identity" });
    const r = await run(["--profile", "reconcile-test", "--records", records], env);
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
    const r = await run(["--profile", "reconcile-test", "--records", failing.records], failing.env);
    expect(r.status, r.out).toBe(2);
    noSecrets(r.out, []);
  });
});
