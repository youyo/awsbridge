// G2 の時間差の集計（scripts/poc/g2/time-gap.ts。mise タスク poc:g2:time-gap）を実プロセスで通す。
// CloudTrail は PATH の先頭の偽の aws（console:reconcile の e2e と同じ形の応答）か、lookup-events の出力のファイル（--trail）。
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { RECONCILE_READ_COMMANDS } from "../../scripts/console/reconcile-read";
import { root } from "./console-e2e-kit";

const ACCOUNT = "123456789012";
const EMAIL = "alice@example.com";
const dir = mkdtempSync(join(tmpdir(), "awsbridge-g2-gap-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-13T00:00:00Z");
const jti = (n: number) => `${n.toString(16).padStart(8, "0")}-1f4e-4c55-9d2a-7f3c1a2b3c4d`;

/** Worker の発行記録（issueLogRecord の形）を Workers Logs のイベントに包んだもの。 */
function record(n: number, tier: "standard" | "admin" = "standard") {
  const at = T0 + n * 60_000;
  return {
    $workers: {
      scriptName: tier === "admin" ? "awsbridge-console-admin" : "awsbridge-console-standard",
    },
    source: {
      event: "console_issue",
      result: "ok",
      at: new Date(at).toISOString(),
      tier,
      team: tier === "admin" ? "g2adm" : "g2std",
      user: { email: "a***@***.com", sourceIdentity: "a***@***.com" },
      target: {
        accountId: ACCOUNT,
        role: "viewer",
        boundary: "managed",
        issuer: "https://id.example.com/standard",
      },
      jwt: { jti: jti(n), iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 300, kid: "k1" },
      sts: { region: "us-east-1" },
    },
  };
}

function trail(n: number, afterSeconds: number) {
  const at = T0 + n * 60_000 + afterSeconds * 1000;
  return {
    EventId: `ev-${n}`,
    EventName: "AssumeRoleWithWebIdentity",
    CloudTrailEvent: JSON.stringify({
      eventName: "AssumeRoleWithWebIdentity",
      eventTime: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
      awsRegion: "us-east-1",
      recipientAccountId: ACCOUNT,
      userIdentity: { type: "WebIdentityUser", userName: EMAIL },
      requestParameters: {
        roleArn: `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/FederatedAwsBridgeViewer`,
        webIdentityTokenId: jti(n),
        sourceIdentity: EMAIL,
      },
      responseElements: { subjectFromWebIdentityToken: EMAIL },
    }),
  };
}

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(args) + "\\n");
const region = args.find((a) => a.startsWith("--region="));
const key = [args[0], args[1], ...(region ? [region] : [])].join(" ");
const table = JSON.parse(fs.readFileSync(process.env.AWS_STUB_TABLE, "utf8"));
if (!(key in table)) { process.stderr.write("unknown call: " + key + "\\n"); process.exit(255); }
process.stdout.write(JSON.stringify(table[key]));
`;

function setup(events: unknown[]) {
  const d = mkdtempSync(join(dir, "case-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), STUB);
  chmodSync(join(bin, "aws"), 0o755);
  writeFileSync(
    join(d, "table.json"),
    JSON.stringify({
      "account list-regions --region=us-east-1": {
        Regions: [
          { RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" },
          { RegionName: "ap-northeast-1", RegionOptStatus: "ENABLED_BY_DEFAULT" },
        ],
      },
      "cloudtrail lookup-events --region=us-east-1": { Events: events },
      "cloudtrail lookup-events --region=ap-northeast-1": { Events: [] },
    }),
  );
  const log = join(d, "calls.log");
  writeFileSync(log, "");
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("AWSBRIDGE_") && !k.startsWith("AWS_")) e[k] = v;
  return {
    d,
    log,
    env: {
      ...e,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AWS_STUB_LOG: log,
      AWS_STUB_TABLE: join(d, "table.json"),
    },
  };
}

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/poc/g2/time-gap.ts"), ...args],
      {
        cwd: root,
        env,
      },
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

function noSecrets(out: string) {
  expect(out).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  expect(out).not.toContain("@");
  for (let n = 1; n <= 5; n++) expect(out).not.toContain(jti(n).slice(0, 8));
}

describe("poc:g2:time-gap", () => {
  it("--profile: 有効な全リージョンの CloudTrail を読み（読み取りの aws だけ）、jti で結んで分布を出す", async () => {
    const s = setup([trail(1, 2), trail(2, 4), trail(3, 30), trail(5, 1)]);
    const records = join(s.d, "records.ndjson");
    writeFileSync(
      records,
      [record(1), record(2), record(3, "admin"), record(4)]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const r = await run(["--records", records, "--profile", "g2-ro"], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("regions: read 2/2");
    expect(r.out).toContain("matched: 3 / records without event: 1 / events without record: 1");
    expect(r.out).toMatch(/\| all \| 3 \| 2 \| 4 \| 30 \| 30 \|/);
    expect(r.out).toMatch(/\| admin \| 1 \| 30 \| 30 \| 30 \| 30 \|/);
    noSecrets(r.out);
    const calls = readFileSync(s.log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(RECONCILE_READ_COMMANDS as readonly string[]).toContain(`${c[0]} ${c[1]}`);
      expect(c).toContain("--profile=g2-ro");
    }
    // 既定の期間は記録の最初の 15 分前から
    const lookup = calls.find((c) => c[1] === "lookup-events") ?? [];
    expect(lookup[lookup.indexOf("--start-time") + 1]).toBe(
      new Date(T0 + 60_000 - 15 * 60_000).toISOString(),
    );
  });

  it("--trail（lookup-events の出力のファイル）と、ディレクトリ・.gz の記録も読める。aws は呼ばない", async () => {
    const s = setup([]);
    const recDir = join(s.d, "recs");
    mkdirSync(recDir);
    writeFileSync(join(recDir, "a.ndjson"), JSON.stringify(record(1)));
    writeFileSync(join(recDir, "b.ndjson.gz"), gzipSync(JSON.stringify(record(2))));
    const trailFile = join(s.d, "trail.json");
    writeFileSync(trailFile, JSON.stringify({ Events: [trail(1, 3), trail(2, 5)] }));
    const r = await run(["--records", recDir, "--trail", trailFile], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\| all \| 2 \| 3 \| 4 \| 5 \| 5 \|/);
    expect(readFileSync(s.log, "utf8")).toBe("");
    noSecrets(r.out);
  });

  it("--profile と --trail のどちらかが要る。記録が無ければ止める", async () => {
    const s = setup([]);
    const records = join(s.d, "records.ndjson");
    writeFileSync(records, JSON.stringify(record(1)));
    expect((await run(["--records", records], s.env)).status).not.toBe(0);
    expect(
      (await run(["--records", join(s.d, "none.ndjson"), "--trail", records], s.env)).status,
    ).not.toBe(0);
  });
});
