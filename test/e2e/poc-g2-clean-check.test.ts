// G2 の片付けの確認（scripts/poc/g2/clean-check.ts。mise タスク poc:g2:clean-check）を実プロセスで通す。
// aws は偽のコマンド、Cloudflare の API は 127.0.0.1 の擬似サーバー（AWSBRIDGE_G2_CF_API_BASE）。読み取り（GET）だけを呼ぶこと。
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLEAN_CHECK_AWS_COMMANDS } from "../../scripts/poc/g2/clean-check-lib";
import { freePort, root } from "./console-e2e-kit";

const ACCOUNT = "123456789012";
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = ["cf", "read", "token", "r".repeat(24)].join("-");
const dir = mkdtempSync(join(tmpdir(), "awsbridge-g2-clean-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let server: Server;
let base = "";
const reqs: { method: string; url: string; auth?: string | undefined }[] = [];
let workers: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    reqs.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === `/client/v4/accounts/${CF_ACCOUNT}/workers/scripts`)
      res.end(JSON.stringify({ success: true, result: workers.map((id) => ({ id })) }));
    else if (path.endsWith("/workers/domains") || path.endsWith("/access/apps"))
      res.end(JSON.stringify({ success: true, result: [] }));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  reqs.length = 0;
  workers = [];
});

// 偽の aws: get-role は EXISTING_ROLES にあれば成功、無ければ NoSuchEntity。describe-stacks は無いと答える。
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(args) + "\\n");
const cmd = args[0] + " " + args[1];
const arg = (k) => args[args.indexOf(k) + 1];
const out = (v) => process.stdout.write(JSON.stringify(v));
const err = (code, msg) => { process.stderr.write("\\nAn error occurred (" + code + ") when calling the X operation: " + msg + "\\n"); process.exit(254); };
if (cmd === "iam list-roles") out({ Roles: [] });
else if (cmd === "iam get-role") (process.env.EXISTING_ROLES || "").split(",").includes(arg("--role-name")) ? out({ Role: {} }) : err("NoSuchEntity", "The role cannot be found");
else if (cmd === "iam list-open-id-connect-providers") out({ OpenIDConnectProviderList: [{ Arn: "arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com" }] });
else if (cmd === "iam list-policies") out({ Policies: [] });
else if (cmd === "cloudformation describe-stacks") err("ValidationError", "Stack with id " + arg("--stack-name") + " does not exist");
else { process.stderr.write("unknown " + cmd); process.exit(255); }
`;

function setup(extra: Record<string, string> = {}) {
  const d = mkdtempSync(join(dir, "case-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), STUB);
  chmodSync(join(bin, "aws"), 0o755);
  const log = join(d, "calls.log");
  writeFileSync(log, "");
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("AWSBRIDGE_") &&
      !k.startsWith("AWS_") &&
      !k.startsWith("CLOUDFLARE_")
    )
      e[k] = v;
  return {
    log,
    env: {
      ...e,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AWS_STUB_LOG: log,
      AWSBRIDGE_G2_CF_API_BASE: base,
      AWSBRIDGE_G2_CF_ACCOUNT_ID: CF_ACCOUNT,
      AWSBRIDGE_G2_CF_READ_TOKEN: TOKEN,
      ...extra,
    },
  };
}

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/poc/g2/clean-check.ts"), ...args],
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

describe("poc:g2:clean-check", () => {
  it("何も残っていなければ終了コード 0。aws は読み取りだけ、Cloudflare は GET だけ。トークン・アカウント ID を出さない", async () => {
    const s = setup();
    const r = await run(["--profile", "g2-ro", "--stack", "g2-base"], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\| cloudflare workers \| OK \|/);
    expect(r.out).toMatch(/\| cloudformation g2-base \| OK \|/);
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).not.toContain(ACCOUNT);
    for (const c of readFileSync(s.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[])) {
      expect(CLEAN_CHECK_AWS_COMMANDS as readonly string[]).toContain(`${c[0]} ${c[1]}`);
      expect(c).toContain("--profile=g2-ro");
    }
    expect(reqs.length).toBe(3);
    for (const q of reqs) {
      expect(q.method).toBe("GET");
      expect(q.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("残っていれば終了コード 1 で名前を出す", async () => {
    workers = ["awsbridge-g2-probe-kid"];
    const s = setup({ EXISTING_ROLES: "FederatedAwsBridgeAdministrator" });
    const r = await run(["--profile", "g2-ro"], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\| iam get-role FederatedAwsBridgeAdministrator \| NG \|/);
    expect(r.out).toMatch(/\| cloudflare workers \| NG \| awsbridge-g2-probe-kid \|/);
  });

  it("Cloudflare のトークンが無ければ Cloudflare は SKIP（AWS だけ見る）", async () => {
    const s = setup({ AWSBRIDGE_G2_CF_READ_TOKEN: "" });
    const r = await run(["--profile", "g2-ro"], s.env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\| cloudflare workers \| SKIP \|/);
    expect(reqs).toEqual([]);
  });
});
