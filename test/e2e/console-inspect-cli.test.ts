// 検査の道具の CLI（scripts/console/inspect.ts。mise タスク console:inspect）を実プロセスで動かす。
// aws は PATH の先頭に置いた偽のコマンドで置き換え（材料の応答を返し、呼ばれた引数を記録する）、実際の AWS には接続しない。
// 終了コード・出力（伏せ字）・呼んだ API（読み取りの 8 種類だけ・指定のプロファイル）を確かめる。
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { READ_COMMANDS } from "../../scripts/console/inspect-read";
import type { AccountSnapshot } from "../../src/console/inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "../../src/console/reserved";
import type { Json } from "../unit/cfn";
import { companyConfig } from "../unit/console-fixtures";
import {
  awsResponses,
  goodSnapshot,
  inventory,
  role,
  SIGNING_ACCOUNT,
} from "../unit/console-inspect-fixtures";

const root = new URL("../../", import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// 偽の aws: --profile と --output を除いた引数を空白でつないだものを応答の表で引く。無ければ失敗（終了コード 255）。
// 呼ばれた引数はすべて記録する。FAIL_ON に一致した呼び出しは、アカウント ID を含むエラーで失敗させる。
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(args) + "\\n");
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--profile=")) continue;
  if (args[i] === "--output") { i++; continue; }
  rest.push(args[i]);
}
const key = rest.join(" ");
if (process.env.AWS_STUB_FAIL_ON && key.startsWith(process.env.AWS_STUB_FAIL_ON)) {
  process.stderr.write("An error occurred (AccessDenied): User: arn:aws:sts::333333333333:assumed-role/x/user1@example.com is not authorized\\n");
  process.exit(254);
}
const table = JSON.parse(fs.readFileSync(process.env.AWS_STUB_TABLE, "utf8"));
if (!(key in table)) { process.stderr.write("unknown call: " + key + "\\n"); process.exit(255); }
process.stdout.write(JSON.stringify(table[key]));
`;

function setup(s: AccountSnapshot, extra: { stops?: string[]; failOn?: string } = {}) {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-console-inspect-"));
  dirs.push(d);
  const bin = join(d, "bin");
  spawnSync("mkdir", [bin]);
  writeFileSync(join(bin, "aws"), STUB);
  chmodSync(join(bin, "aws"), 0o755);
  const table = join(d, "table.json");
  writeFileSync(table, JSON.stringify(awsResponses(s)));
  const raw = companyConfig();
  raw.signing = { accountIds: [SIGNING_ACCOUNT] };
  const config = join(d, "console.json");
  writeFileSync(config, JSON.stringify(raw));
  const inv = join(d, "inventory.json");
  writeFileSync(inv, JSON.stringify(inventory()));
  const log = join(d, "calls.log");
  writeFileSync(log, "");
  const args = ["--profile", "inspect-test"];
  if (extra.stops) {
    const p = join(d, "stops.json");
    writeFileSync(p, JSON.stringify({ sourceIdentities: extra.stops }));
    args.push("--stops", p);
  }
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    AWS_STUB_TABLE: table,
    AWS_STUB_LOG: log,
    AWSBRIDGE_CONSOLE_CONFIG: config,
    AWSBRIDGE_CONSOLE_INVENTORY_FILE: inv,
    ...(extra.failOn ? { AWS_STUB_FAIL_ON: extra.failOn } : {}),
  };
  return { args, env, log };
}

function inspect(
  s: AccountSnapshot,
  extra: { stops?: string[]; failOn?: string } = {},
  more: string[] = [],
) {
  const { args, env, log } = setup(s, extra);
  const r = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "scripts/console/inspect.ts"), ...args, ...more],
    { cwd: root, env, encoding: "utf8" },
  );
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[]);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

const NO_SECRETS = (out: string) => {
  expect(out).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  expect(out).not.toMatch(/@/);
};

describe("console:inspect（偽の aws で実プロセス）", () => {
  it("正しい形のアカウントは終了コード 0。呼ぶのは読み取りの 8 種類だけで、すべて指定のプロファイル", () => {
    const r = inspect(goodSnapshot());
    expect(r.out).toContain("errors: 0");
    expect(r.status, r.out).toBe(0);
    NO_SECRETS(r.out);
    expect(r.calls.length).toBeGreaterThan(8);
    for (const c of r.calls) {
      expect(READ_COMMANDS as readonly string[], c.join(" ")).toContain(`${c[0]} ${c[1]}`);
      expect(c.slice(-3)).toEqual(["--profile=inspect-test", "--output", "json"]);
    }
  });

  it("2 つ目の Allow 文に StringLikeIfExists があれば終了コード 1 で違反を出す", () => {
    const s = goodSnapshot();
    const doc = role(s, "FederatedViewer").trustPolicy as Json;
    doc.Statement.push({
      ...structuredClone(doc.Statement[0]),
      Condition: { StringLikeIfExists: { "aws:RequestTag/awsbridge_team": "*" } },
    });
    const r = inspect(s);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ERROR\s+trust_allow_extra\s+FederatedViewer/);
    NO_SECRETS(r.out);
  });

  it("停止の一覧を渡すと、Deny の無いロールを違反にする（値は出さない）", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: STOP_USER_INLINE_POLICY_NAME,
      document: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Action: "*",
            Resource: "*",
            Condition: { StringEquals: { "aws:SourceIdentity": ["user1@example.com"] } },
          },
        ],
      },
    });
    const r = inspect(s, { stops: ["user1@example.com"] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ERROR\s+stop_missing\s+FederatedAdministrator/);
    expect(r.out).not.toMatch(/stop_missing\s+FederatedViewer/);
    NO_SECRETS(r.out);
  });

  it("aws の失敗は終了コード 2 で止まり、エラー文の中身も伏せる", () => {
    const r = inspect(goodSnapshot(), { failOn: "iam list-roles" });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("AccessDenied");
    NO_SECRETS(r.out);
  });

  it("--account-id と違うアカウントなら終了コード 2", () => {
    const r = inspect(goodSnapshot(), {}, ["--account-id", "111111111111"]);
    expect(r.status, r.out).toBe(2);
    NO_SECRETS(r.out);
  });

  it("設定に無いアカウント（取り違えたプロファイル）は終了コード 1。見出しは末尾 4 桁だけ", () => {
    const moved = JSON.parse(
      JSON.stringify(goodSnapshot()).replaceAll("333333333333", "777777777777"),
    ) as AccountSnapshot;
    const r = inspect(moved);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ERROR\s+account_not_in_config/);
    expect(r.out).toContain("****7777");
    NO_SECRETS(r.out);
  });

  it("- で始まるプロファイル名は終了コード 2 で、aws を呼ばない", () => {
    const { env, log } = setup(goodSnapshot());
    const r = spawnSync(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console/inspect.ts"), "--profile=-x"],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("--profile が無ければ終了コード 2 で、aws を呼ばない", () => {
    const { env, log } = setup(goodSnapshot());
    const r = spawnSync(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console/inspect.ts")],
      {
        cwd: root,
        env,
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(2);
    expect(readFileSync(log, "utf8")).toBe("");
  });
});
