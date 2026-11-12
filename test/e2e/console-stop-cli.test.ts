// 停止の道具の CLI（scripts/console/stop.ts。mise タスク console:stop:show / console:stop:apply）を実プロセスで動かす。
// aws は PATH の先頭に置いた偽のコマンドで置き換え、実際の AWS には接続しない。偽の aws は状態を持ち、
// put-role-policy・delete-role-policy で応答の表を書き換える（そのあとの読み直しと console:inspect が書いた結果を読む）。
// 確かめること: --yes なしで書き込みを 1 回も呼ばない、--yes で put と delete だけを呼ぶ、出力に値と全桁のアカウント ID が無い、
// 途中の失敗で終了コード 1、apply のあとの console:inspect --stops で誤り 0、cto の決裁の ★4・★5。
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { STOP_READ_COMMANDS, STOP_WRITE_COMMANDS } from "../../scripts/console/stop-lib";
import type { AccountSnapshot, RoleSnapshot } from "../../src/console/inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "../../src/console/reserved";
import { stopPolicyDocument } from "../../src/console/stops";
import { companyConfig } from "../unit/console-fixtures";
import {
  ACCOUNT,
  awsResponses,
  goodSnapshot,
  inventory,
  role,
  SIGNING_ACCOUNT,
  STD_PROVIDER,
} from "../unit/console-inspect-fixtures";

const root = new URL("../../", import.meta.url).pathname;
const tsx = join(root, "node_modules/.bin/tsx");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const A = "user1@example.com";
const B = "user2@example.com";
/** email でない SourceIdentity（custom.<名前> の出どころ）。redact では伏せられないので、出力に出さないことを直接確かめる。 */
const C = "custom-id_1";
const RESERVED = STOP_USER_INLINE_POLICY_NAME;
const OPS_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_Ops_0123456789abcdef/${A}`;

// 偽の aws: --profile と --output を除いた引数を空白でつないだものを応答の表で引く。無ければ失敗（終了コード 255）。
// put-role-policy・delete-role-policy は表（get-role-policy・list-role-policies の応答）を書き換え、空の応答を返す。
// 呼ばれた引数はすべて記録する。FAIL_ON に一致した呼び出しは、アカウント ID と email を含むエラーで失敗させる。
// SILENT_FAIL_ON に一致した呼び出しは、stderr に何も出さずに失敗させる（タイムアウトなど）。
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
if (process.env.AWS_STUB_SILENT_FAIL_ON && key.startsWith(process.env.AWS_STUB_SILENT_FAIL_ON)) process.exit(1);
if (process.env.AWS_STUB_FAIL_ON && key.startsWith(process.env.AWS_STUB_FAIL_ON)) {
  process.stderr.write("An error occurred (AccessDenied): User: arn:aws:sts::333333333333:assumed-role/x/user1@example.com is not authorized\\n");
  process.exit(254);
}
const tablePath = process.env.AWS_STUB_TABLE;
const table = JSON.parse(fs.readFileSync(tablePath, "utf8"));
const opt = (name) => { const a = rest.find((x) => x.startsWith("--" + name + "=")); return a && a.slice(name.length + 3); };
if (rest[0] === "iam" && (rest[1] === "put-role-policy" || rest[1] === "delete-role-policy")) {
  const role = opt("role-name"), name = opt("policy-name");
  const listKey = "iam list-role-policies --role-name=" + role;
  const getKey = "iam get-role-policy --role-name=" + role + " --policy-name=" + name;
  if (!(listKey in table)) { process.stderr.write("NoSuchEntity: role\\n"); process.exit(254); }
  const names = table[listKey].PolicyNames.filter((n) => n !== name);
  if (rest[1] === "put-role-policy") {
    table[getKey] = { RoleName: role, PolicyName: name, PolicyDocument: JSON.parse(opt("policy-document")) };
    names.push(name);
  } else {
    if (!(getKey in table)) { process.stderr.write("NoSuchEntity: policy\\n"); process.exit(254); }
    delete table[getKey];
  }
  table[listKey] = { PolicyNames: names };
  fs.writeFileSync(tablePath, JSON.stringify(table));
  process.exit(0);
}
if (!(key in table)) { process.stderr.write("unknown call: " + key + "\\n"); process.exit(255); }
process.stdout.write(JSON.stringify(table[key]));
`;

type Opts = {
  stops?: string[];
  failOn?: string;
  silentFailOn?: string;
  callerArn?: string;
  reason?: string | null;
};

function setup(s: AccountSnapshot, o: Opts = {}) {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-console-stop-"));
  dirs.push(d);
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), STUB);
  chmodSync(join(bin, "aws"), 0o755);
  const table = join(d, "table.json");
  writeFileSync(
    table,
    JSON.stringify({
      ...awsResponses(s),
      "sts get-caller-identity": {
        UserId: `AROAEXAMPLE:${A}`,
        Account: ACCOUNT,
        Arn: o.callerArn ?? OPS_ARN,
      },
    }),
  );
  const raw = companyConfig();
  raw.signing = { accountIds: [SIGNING_ACCOUNT] };
  const config = join(d, "console.json");
  writeFileSync(config, JSON.stringify(raw));
  const inv = join(d, "inventory.json");
  writeFileSync(inv, JSON.stringify(inventory()));
  const log = join(d, "calls.log");
  writeFileSync(log, "");
  const stops = join(d, "stops.json");
  writeFileSync(stops, JSON.stringify({ sourceIdentities: o.stops ?? [A] }));
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    AWS_STUB_TABLE: table,
    AWS_STUB_LOG: log,
    AWSBRIDGE_CONSOLE_CONFIG: config,
    AWSBRIDGE_CONSOLE_INVENTORY_FILE: inv,
    ...(o.failOn ? { AWS_STUB_FAIL_ON: o.failOn } : {}),
    ...(o.silentFailOn ? { AWS_STUB_SILENT_FAIL_ON: o.silentFailOn } : {}),
  };
  return { env, log, stops };
}

type Ctx = ReturnType<typeof setup>;

function exec(ctx: Ctx, script: string, args: string[]) {
  const before = readFileSync(ctx.log, "utf8").length;
  const r = spawnSync(tsx, [join(root, "scripts/console", script), ...args], {
    cwd: root,
    env: ctx.env,
    encoding: "utf8",
  });
  const calls = readFileSync(ctx.log, "utf8")
    .slice(before)
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[]);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, calls };
}

function apply(ctx: Ctx, more: string[] = [], reason: string | null = "incident 42") {
  return exec(ctx, "stop.ts", [
    "apply",
    "--profile",
    "stop-test",
    "--stops",
    ctx.stops,
    ...(reason !== null ? ["--reason", reason] : []),
    ...more,
  ]);
}

const writes = (calls: string[][]) =>
  calls.filter((c) => (STOP_WRITE_COMMANDS as readonly string[]).includes(`${c[0]} ${c[1]}`));

const NO_SECRETS = (out: string) => {
  expect(out).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  expect(out).not.toMatch(/@/);
};

const ALLOWED = [...STOP_READ_COMMANDS, ...STOP_WRITE_COMMANDS] as readonly string[];

function handmade(name = "HandmadeConsoleRole"): RoleSnapshot {
  return {
    roleName: name,
    path: "/",
    arn: `arn:aws:iam::${ACCOUNT}:role/${name}`,
    trustPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: STD_PROVIDER },
          Action: "sts:AssumeRoleWithWebIdentity",
        },
      ],
    },
    attachedPolicies: [],
    inlinePolicies: [],
  };
}

describe("console:stop:apply（偽の aws で実プロセス）", () => {
  it("--yes なしは計画の表示だけで、書き込みの API を 1 回も呼ばない（IAM の読み取りと呼び出し元の確認はする）", () => {
    const ctx = setup(goodSnapshot(), { stops: [A, B] });
    const r = apply(ctx);
    expect(r.status, r.out).toBe(0);
    expect(writes(r.calls)).toEqual([]);
    expect(r.calls.map((c) => `${c[0]} ${c[1]}`)).toContain("sts get-caller-identity");
    for (const c of r.calls) expect(ALLOWED, c.join(" ")).toContain(`${c[0]} ${c[1]}`);
    expect(r.out).toMatch(/PLAN\s+FederatedViewer\s+config\s.*writes add:put/);
    expect(r.out).toContain("--yes");
    NO_SECRETS(r.out);
  });

  it("--yes で put だけを呼び（予約名・指定のプロファイル）、書いたあと読み直す。console:inspect --stops で誤り 0", () => {
    const ctx = setup(goodSnapshot(), { stops: [C, A, B] });
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(0);
    const w = writes(r.calls);
    expect(w.map((c) => `${c[0]} ${c[1]} ${c[2]}`)).toEqual([
      "iam put-role-policy --role-name=FederatedAdministrator",
      "iam put-role-policy --role-name=FederatedViewer",
    ]);
    for (const c of w) {
      expect(c).toContain(`--policy-name=${RESERVED}`);
      expect(c.slice(-3)).toEqual(["--profile=stop-test", "--output", "json"]);
    }
    for (const c of r.calls) {
      expect(ALLOWED, c.join(" ")).toContain(`${c[0]} ${c[1]}`);
      expect(c).toContain("--profile=stop-test");
    }
    NO_SECRETS(r.out);
    // 記録: 1 行の JSON（値は入れない。アカウントは末尾 4 桁）
    const rec = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      event: "awsbridge-console-stop",
      account: "****3333",
      mode: "add",
      reason: "incident 42",
      values: 3,
    });
    // 値は伏せ字にもならない（そもそも出さない）
    expect(r.out).not.toContain(C);
    expect(r.out).not.toContain("<email>");
    expect(r.out).toContain("console:inspect");

    const i = exec(ctx, "inspect.ts", ["--profile", "stop-test", "--stops", ctx.stops]);
    expect(i.out).toContain("errors: 0");
    expect(i.status, i.out).toBe(0);
    // 最後の案内は、inspect が確かめる範囲を事実どおりに書く
    expect(r.out).toContain("console:inspect --stops は設定のロールを確かめる");
    expect(r.out).toContain("この道具の読み直しで確かめた");
  });

  it("2 回目は何も書かない（宣言的）", () => {
    const ctx = setup(goodSnapshot(), { stops: [A] });
    expect(apply(ctx, ["--yes"]).status).toBe(0);
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(writes(r.calls)).toEqual([]);
  });

  it("空の一覧と --allow-remove --yes で delete だけを呼び、console:inspect --stops（空）で誤り 0", () => {
    const s = goodSnapshot();
    for (const n of ["FederatedViewer", "FederatedAdministrator"])
      role(s, n).inlinePolicies?.push({ policyName: RESERVED, document: stopPolicyDocument([A]) });
    const ctx = setup(s, { stops: [] });
    const r = apply(ctx, ["--allow-remove", "--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(writes(r.calls).map((c) => c[1])).toEqual(["delete-role-policy", "delete-role-policy"]);
    for (const c of writes(r.calls)) expect(c).toContain(`--policy-name=${RESERVED}`);
    expect(r.out).toContain("MaxSessionDuration");
    NO_SECRETS(r.out);
    const i = exec(ctx, "inspect.ts", ["--profile", "stop-test", "--stops", ctx.stops]);
    expect(i.status, i.out).toBe(0);
  });

  it("足す値が無く外す値だけ（解除だけ）で --allow-remove が無ければ終了コード 2 で、書き込みを呼ばない", () => {
    const s = goodSnapshot();
    for (const n of ["FederatedViewer", "FederatedAdministrator"])
      role(s, n).inlinePolicies?.push({
        policyName: RESERVED,
        document: stopPolicyDocument([A, B]),
      });
    const ctx = setup(s, { stops: [A] });
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("remove_not_allowed");
    expect(writes(r.calls)).toEqual([]);
    NO_SECRETS(r.out);
  });

  it("ロールに [A, old]・一覧 [A, B] で --allow-remove なし: 足すだけ（old は消さない）。ほかのロールにも B、余分 1 件の報告、終了コード 0", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: RESERVED,
      document: stopPolicyDocument([A, "old@example.com"]),
    });
    const ctx = setup(s, { stops: [A, B] });
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(writes(r.calls).map((c) => `${c[1]} ${c[2]}`)).toEqual([
      "put-role-policy --role-name=FederatedAdministrator",
      "put-role-policy --role-name=FederatedViewer",
    ]);
    expect(r.out).toMatch(/EXTRA\s+FederatedViewer\s+1/);
    expect(r.out).toContain("--allow-remove");
    NO_SECRETS(r.out);
    // 書いた結果: 全ロールに A と B。Viewer には old が残る（検査では余分の警告）
    const i = exec(ctx, "inspect.ts", ["--profile", "stop-test", "--stops", ctx.stops]);
    expect(i.status, i.out).toBe(0);
    expect(i.out).toMatch(/WARN\s+stop_extra\s+FederatedViewer\s+1/);
  });

  it("同じ材料で --allow-remove あり: 全ロールに足し終えてから外す。結果は一覧どおり", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: RESERVED,
      document: stopPolicyDocument([A, "old@example.com"]),
    });
    const ctx = setup(s, { stops: [A, B] });
    const r = apply(ctx, ["--allow-remove", "--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(writes(r.calls).map((c) => `${c[1]} ${c[2]}`)).toEqual([
      "put-role-policy --role-name=FederatedAdministrator",
      "put-role-policy --role-name=FederatedViewer",
      "put-role-policy --role-name=FederatedViewer",
    ]);
    expect(r.out).toContain("MaxSessionDuration");
    NO_SECRETS(r.out);
    const i = exec(ctx, "inspect.ts", ["--profile", "stop-test", "--stops", ctx.stops]);
    expect(i.status, i.out).toBe(0);
    expect(i.out).not.toContain("stop_extra");
  });

  it("外す段階で 1 つのロールの書き込みが失敗しても、ほかのロールは外し、終了コード 1", () => {
    const s = goodSnapshot();
    for (const n of ["FederatedViewer", "FederatedAdministrator"])
      role(s, n).inlinePolicies?.push({
        policyName: RESERVED,
        document: stopPolicyDocument([A, B]),
      });
    const ctx = setup(s, {
      stops: [A],
      failOn: "iam put-role-policy --role-name=FederatedAdministrator",
    });
    const r = apply(ctx, ["--allow-remove", "--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(writes(r.calls).map((c) => c[2])).toEqual([
      "--role-name=FederatedAdministrator",
      "--role-name=FederatedViewer",
    ]);
    expect(r.out).toMatch(/failed:\s+FederatedAdministrator\s+remove/);
    expect(r.out).toMatch(/done:\s+FederatedViewer\s+remove/);
    expect(r.out).toContain("AccessDenied");
    NO_SECRETS(r.out);
  });

  it("足す段階で失敗したロールは外す段階を行わない（ほかのロールは続ける）", () => {
    const s = goodSnapshot();
    for (const n of ["FederatedViewer", "FederatedAdministrator"])
      role(s, n).inlinePolicies?.push({
        policyName: RESERVED,
        document: stopPolicyDocument([A, "old@example.com"]),
      });
    const ctx = setup(s, {
      stops: [A, B],
      failOn: "iam put-role-policy --role-name=FederatedAdministrator",
    });
    const r = apply(ctx, ["--allow-remove", "--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(writes(r.calls).map((c) => c[2])).toEqual([
      "--role-name=FederatedAdministrator",
      "--role-name=FederatedViewer",
      "--role-name=FederatedViewer",
    ]);
    expect(r.out).toMatch(/failed:\s+FederatedAdministrator\s+add/);
    expect(r.out).toMatch(/not run:\s+FederatedAdministrator\s+remove/);
    NO_SECRETS(r.out);
  });

  it("stderr の無い失敗（タイムアウトなど）でも、エラーの文に書き込みの引数（値）を出さない", () => {
    const ctx = setup(goodSnapshot(), {
      stops: [C, A],
      silentFailOn: "iam put-role-policy --role-name=FederatedAdministrator",
    });
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/failed:\s+FederatedAdministrator/);
    expect(r.out).not.toContain(C);
    expect(r.out).not.toContain("SourceIdentity");
    expect(r.out).not.toContain("<email>");
    NO_SECRETS(r.out);
  });

  it("★4: 足す段階では、あるロールの書き込みが失敗してもほかのロールには書き、終了コード 1", () => {
    const ctx = setup(goodSnapshot(), {
      stops: [A],
      failOn: "iam put-role-policy --role-name=FederatedAdministrator",
    });
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(writes(r.calls).map((c) => c[2])).toEqual([
      "--role-name=FederatedAdministrator",
      "--role-name=FederatedViewer",
    ]);
    expect(r.out).toMatch(/failed:\s+FederatedAdministrator/);
    expect(r.out).toMatch(/done:\s+FederatedViewer/);
    NO_SECRETS(r.out);
  });

  it("★4・★5: 予約名の衝突のロールは上書きせず報告し、設定に無いロール（パスの外で信頼）には書いて、終了コード 1", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: RESERVED,
      document: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }],
      },
    });
    s.roles.push(handmade());
    const ctx = setup(s, { stops: [A] });
    const dry = apply(ctx);
    expect(dry.status, dry.out).toBe(1);
    expect(writes(dry.calls)).toEqual([]);
    expect(dry.out).toMatch(/PLAN\s+HandmadeConsoleRole\s+unlisted\s.*writes add:put/);
    expect(dry.out).toContain("設定に無いロール");
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(writes(r.calls).map((c) => c[2])).toEqual([
      "--role-name=FederatedAdministrator",
      "--role-name=HandmadeConsoleRole",
    ]);
    expect(r.out).toMatch(/stop_reserved_conflict\s+FederatedViewer/);
    NO_SECRETS(r.out);
  });

  it("呼び出し元がコンソール用のロールなら終了コード 2 で、書き込みを呼ばない（ARN は出さない）", () => {
    const ctx = setup(goodSnapshot(), {
      callerArn: `arn:aws:sts::${ACCOUNT}:assumed-role/FederatedAdministrator/${A}`,
    });
    const r = apply(ctx, ["--yes"]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("caller_console_role");
    expect(writes(r.calls)).toEqual([]);
    NO_SECRETS(r.out);
  });

  it("--reason が無ければ終了コード 2 で、aws を呼ばない", () => {
    const ctx = setup(goodSnapshot());
    const r = apply(ctx, ["--yes"], null);
    expect(r.status, r.out).toBe(2);
    expect(r.calls).toEqual([]);
  });

  it("理由の中の email とアカウント ID も伏せる", () => {
    const ctx = setup(goodSnapshot());
    const r = apply(ctx, ["--yes"], `requested by ${B} for ${ACCOUNT}`);
    expect(r.status, r.out).toBe(0);
    NO_SECRETS(r.out);
  });
});

describe("console:stop:show（偽の aws で実プロセス）", () => {
  it("読み取りだけで、ロールごとの件数を出す。--stops で足りないロールは終了コード 1（値は出さない）", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: RESERVED,
      document: stopPolicyDocument([A, B]),
    });
    const ctx = setup(s, { stops: [A] });
    const r0 = exec(ctx, "stop.ts", ["show", "--profile", "stop-test"]);
    expect(r0.status, r0.out).toBe(0);
    expect(r0.out).toMatch(/FederatedViewer\s+.*values: 2/);
    expect(writes(r0.calls)).toEqual([]);
    const r = exec(ctx, "stop.ts", ["show", "--profile", "stop-test", "--stops", ctx.stops]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/stop_missing\s+FederatedAdministrator/);
    expect(r.out).toMatch(/stop_extra\s+FederatedViewer/);
    expect(writes(r.calls)).toEqual([]);
    for (const c of r.calls) expect(ALLOWED, c.join(" ")).toContain(`${c[0]} ${c[1]}`);
    NO_SECRETS(`${r0.out}${r.out}`);
  });
});
