// G2 のセッションの見張り（scripts/poc/g2/session-watch.ts。mise タスク poc:g2:session-watch）を実プロセスで通す。
// aws は PATH の先頭に置いた偽のコマンド（呼ばれた引数を記録し、プロファイルと回数で成功・AccessDenied を返す）。実 AWS には接続しない。
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findLeaks } from "../../scripts/poc/g2/common";
import { root } from "./console-e2e-kit";

const dir = mkdtempSync(join(tmpdir(), "awsbridge-g2-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const BUCKET_SECRET = ["bucket", "owner", "z".repeat(24)].join("-");

// 偽の aws: 引数を記録。--profile=<p> が AWS_STUB_DENY_AFTER の「<p>:<n>」なら n 回目より後は AccessDenied（文面に ARN と email）。
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(args) + "\\n");
const profile = (args.find((a) => a.startsWith("--profile=")) || "").slice(10);
const n = fs.readFileSync(process.env.AWS_STUB_LOG, "utf8").split("\\n").filter((l) => l.includes("--profile=" + profile)).length;
const rule = (process.env.AWS_STUB_DENY_AFTER || "").split(",").find((r) => r.startsWith(profile + ":"));
if (rule && n > Number(rule.split(":")[1])) {
  process.stderr.write("\\nAn error occurred (AccessDenied) when calling the ListBuckets operation: User: arn:aws:sts::123456789012:assumed-role/AwsbridgeG2AdminProbe/console-user@example.com is not authorized to perform: s3:ListAllMyBuckets with an explicit deny in an identity-based policy\\n");
  process.exit(254);
}
process.stdout.write(JSON.stringify({ Buckets: [{ Name: "${BUCKET_SECRET}" }], Owner: { ID: "${BUCKET_SECRET}" } }));
`;

function setup(denyAfter = "") {
  const d = mkdtempSync(join(dir, "case-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), STUB);
  chmodSync(join(bin, "aws"), 0o755);
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
      AWS_STUB_DENY_AFTER: denyAfter,
      AWSBRIDGE_G2_DEV_DIR: join(d, "g2"),
    },
  };
}

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/poc/g2/session-watch.ts"), ...args],
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

const calls = (log: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[]);

function noLeaks(text: string) {
  expect(findLeaks(text, [BUCKET_SECRET])).toEqual([]);
  expect(text).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  expect(text).not.toMatch(/user@example\.com/);
}

describe("poc:g2:session-watch（偽の aws）", () => {
  it("プロファイルごとに既定の s3api list-buckets を N 秒おきに呼び、時刻・成否・エラーコードを出す。止まった時刻を要約に出す", async () => {
    const s = setup("g2-admin:1");
    const r = await run(
      ["--profile", "g2-viewer", "--profile", "g2-admin", "--interval", "1", "--count", "3"],
      s.env,
    );
    expect(r.status, r.out).toBe(0);
    const lines = r.out.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/g2-viewer=OK g2-admin=OK$/);
    expect(lines[1]).toMatch(/g2-viewer=OK g2-admin=AccessDenied$/);
    expect(r.out).toMatch(/\| profile:g2-admin \| 3（1\/2） \|/);
    for (const c of calls(s.log)) {
      expect(c.slice(0, 2)).toEqual(["s3api", "list-buckets"]);
      expect(c).toContain("--output");
      expect(c.some((a) => a === "--profile=g2-viewer" || a === "--profile=g2-admin")).toBe(true);
    }
    noLeaks(r.out);
    const rec = readdirSync(join(s.d, "g2", "records"))
      .map((f) => readFileSync(join(s.d, "g2", "records", f), "utf8"))
      .join("");
    expect(rec).toContain('"code":"AccessDenied"');
    noLeaks(rec);
  });

  it("--operation で操作を変えられる。sts get-caller-identity は警告を出す", async () => {
    const s = setup();
    const r = await run(
      [
        "--profile",
        "p1",
        "--operation",
        "sts get-caller-identity",
        "--interval",
        "0",
        "--count",
        "1",
      ],
      s.env,
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/停止の確認には使えない/);
    expect(calls(s.log)[0]?.slice(0, 2)).toEqual(["sts", "get-caller-identity"]);
  });

  it("書き込みの操作は aws を呼ばずに断る", async () => {
    const s = setup();
    const r = await run(
      ["--profile", "p1", "--operation", "s3api delete-bucket", "--count", "1"],
      s.env,
    );
    expect(r.status).not.toBe(0);
    expect(calls(s.log)).toEqual([]);
    expect(existsSync(join(s.d, "g2", "records"))).toBe(false);
  });
});
