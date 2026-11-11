import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 段階 1a の前の条件（ADR-003 相当）の道具: (1) localhost だけのロール、(4-a) CFN の外のインラインポリシーが残るか、
// (4-b) SourceIdentity で 1 人だけ止める Deny。
// 実 AWS は呼ばない: aws は引数と一部の環境変数を記録し、決まった応答を返すダミーに差し替える。
// ネットワーク（STS）に出る処理は、署名鍵を読めないところで止めて、その手前までを確かめる。

const root = new URL("../../", import.meta.url).pathname;
const toml = readFileSync(join(root, "mise.toml"), "utf8");
const tsx = join(root, "node_modules/.bin/tsx");

function section(name: string): string {
  const start = toml.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = toml.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const ACCOUNT = "123456789012";
const HOST = "awsbridge-human-poc.example.workers.dev";
const role = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
const OUTPUTS = [
  { OutputKey: "RoleArn", OutputValue: role("AwsbridgeHumanPoc") },
  { OutputKey: "TaggedRoleArn", OutputValue: role("AwsbridgeHumanPocTagged") },
  { OutputKey: "NoTagRoleArn", OutputValue: role("AwsbridgeHumanPocNoTag") },
  { OutputKey: "LocalOnlyRoleArn", OutputValue: role("AwsbridgeHumanPocLocalOnly") },
  { OutputKey: "OidcProviderArn", OutputValue: `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}` },
];

interface Fake {
  outputs?: unknown;
  /** ロール名 → インラインポリシー名 */
  rolePolicies?: Record<string, string[]>;
  driftStatus?: unknown;
  drifts?: unknown;
}

// aws のダミー。呼ばれるたびに "aws <引数をタブ区切り> PROFILE=.. KEY=.." を log に追記する。
function fakeAws(fake: Fake): { dir: string; log: string } {
  const dir = tmp("awsbridge-human-gate-fakebin-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "outputs.json"), JSON.stringify(fake.outputs ?? OUTPUTS));
  for (const [name, names] of Object.entries(fake.rolePolicies ?? {}))
    writeFileSync(join(dir, `policies-${name}.json`), JSON.stringify({ PolicyNames: names }));
  writeFileSync(
    join(dir, "drift-status.json"),
    JSON.stringify(
      fake.driftStatus ?? {
        StackDriftDetectionId: "drift-1",
        DetectionStatus: "DETECTION_COMPLETE",
        StackDriftStatus: "IN_SYNC",
        DriftedStackResourceCount: 0,
      },
    ),
  );
  writeFileSync(
    join(dir, "drifts.json"),
    JSON.stringify(fake.drifts ?? { StackResourceDrifts: [] }),
  );
  const f = join(dir, "aws");
  writeFileSync(
    f,
    `#!/bin/bash
line='aws'; for a in "$@"; do line+=$'\\t'"$a"; done
line+=$'\\t'"PROFILE=\${AWS_PROFILE-UNSET}"$'\\t'"KEY=\${AWS_ACCESS_KEY_ID-UNSET}"
printf '%s\\n' "$line" >> "${log}"
prev=''; rn=''
for a in "$@"; do if [ "$prev" = "--role-name" ]; then rn="$a"; fi; prev="$a"; done
case "$*" in
  *describe-stacks*) cat "${dir}/outputs.json" ;;
  *list-role-policies*)
    if [ -f "${dir}/policies-$rn.json" ]; then cat "${dir}/policies-$rn.json"; else echo '{"PolicyNames":[]}'; fi ;;
  *detect-stack-drift*) echo '{"StackDriftDetectionId":"drift-1"}' ;;
  *describe-stack-drift-detection-status*) cat "${dir}/drift-status.json" ;;
  *describe-stack-resource-drifts*) cat "${dir}/drifts.json" ;;
esac
exit 0
`,
  );
  chmodSync(f, 0o755);
  return { dir, log };
}

function runTs(script: string, args: string[], env: Record<string, string>, fake: Fake = {}) {
  const { dir, log } = fakeAws(fake);
  const r = spawnSync(tsx, [join(root, script), ...args], {
    cwd: root,
    env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
    : [];
  return { ...r, calls };
}

const argOf = (c: string[], name: string) => c[c.indexOf(name) + 1];
const PRIMARY = "user@example.com";
const SECOND = "second@example.com";
const subjects = {
  AWSBRIDGE_HUMAN_POC_SUBJECT: PRIMARY,
  AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: SECOND,
};

describe("mise タスク（段階 1a の前の条件）", () => {
  const tasks: Record<string, string> = {
    "poc:human:deny-si": "scripts/poc/human/revoke.ts deny-si",
    "poc:human:undeny-si": "scripts/poc/human/revoke.ts undeny-si",
    "poc:human:inline-policies": "scripts/poc/human/persist.ts inline",
    "poc:human:drift": "scripts/poc/human/persist.ts drift",
  };
  for (const [name, script] of Object.entries(tasks)) {
    it(`${name} は ${script} を呼ぶ`, () => {
      const s = section(`tasks."${name}"`);
      expect(s, name).toContain(script);
      expect(s).toMatch(/^description\s*=/m);
    });
  }
});

describe("revoke.ts deny-si / undeny-si（(4-b) SourceIdentity で 1 人だけ止める）", () => {
  it("deny-si: Tagged に AwsbridgeDenySourceIdentity（1 人目の SourceIdentity の Deny）を付け、UTC の時刻を出す（email は伏せる）", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["deny-si"], subjects);
    expect(r.status, r.stderr).toBe(0);
    const put = r.calls.find((c) => c[2] === "put-role-policy") as string[];
    expect(put).toBeDefined();
    expect(argOf(put, "--role-name")).toBe("AwsbridgeHumanPocTagged");
    expect(argOf(put, "--policy-name")).toBe("AwsbridgeDenySourceIdentity");
    const doc = JSON.parse(argOf(put, "--policy-document") as string);
    expect(doc.Statement[0]).toMatchObject({
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: { StringEquals: { "aws:SourceIdentity": [PRIMARY] } },
    });
    expect(put).toContain("PROFILE=awsbridge");
    expect(r.stdout).toMatch(/完了: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/);
    expect(r.stdout + r.stderr).not.toContain(PRIMARY);
  });
  it("deny-si --who second: 2 人目の SourceIdentity を止める", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["deny-si", "--who", "second"], subjects);
    expect(r.status, r.stderr).toBe(0);
    const put = r.calls.find((c) => c[2] === "put-role-policy") as string[];
    const doc = JSON.parse(argOf(put, "--policy-document") as string);
    expect(doc.Statement[0].Condition.StringEquals["aws:SourceIdentity"]).toEqual([SECOND]);
  });
  it("deny-si --role localonly / base でも付けられる（PoC のロールだけ）", () => {
    for (const [r0, name] of [
      ["localonly", "AwsbridgeHumanPocLocalOnly"],
      ["base", "AwsbridgeHumanPoc"],
    ]) {
      const r = runTs("scripts/poc/human/revoke.ts", ["deny-si", "--role", r0 as string], subjects);
      expect(r.status, r.stderr).toBe(0);
      const put = r.calls.find((c) => c[2] === "put-role-policy") as string[];
      expect(argOf(put, "--role-name")).toBe(name);
    }
  });
  it("undeny-si: インラインポリシーを外す", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["undeny-si"], {});
    expect(r.status, r.stderr).toBe(0);
    const del = r.calls.find((c) => c[2] === "delete-role-policy") as string[];
    expect(argOf(del, "--role-name")).toBe("AwsbridgeHumanPocTagged");
    expect(argOf(del, "--policy-name")).toBe("AwsbridgeDenySourceIdentity");
    expect(r.stdout).toMatch(/完了: \d{4}-\d\d-\d\dT/);
  });
  it("subject が無い・2 人目が無い・2 人目が 1 人目と同じ・--who が不正なら aws を呼ばない", () => {
    for (const [args, env] of [
      [["deny-si"], {}],
      [["deny-si", "--who", "second"], { AWSBRIDGE_HUMAN_POC_SUBJECT: PRIMARY }],
      [
        ["deny-si", "--who", "second"],
        {
          AWSBRIDGE_HUMAN_POC_SUBJECT: PRIMARY,
          AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: "USER@example.com",
        },
      ],
      [["deny-si", "--who", "third"], subjects],
    ] as [string[], Record<string, string>][]) {
      const r = runTs("scripts/poc/human/revoke.ts", args, env);
      expect(r.status, `${args.join(" ")} ${JSON.stringify(env)}`).not.toBe(0);
      expect(r.calls).toEqual([]);
    }
  });
  it("Output のロールが PoC 用でなければ付けない", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["deny-si"], subjects, {
      outputs: [{ OutputKey: "TaggedRoleArn", OutputValue: role("FederatedMcpDebug") }],
    });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c[2] === "put-role-policy")).toBe(false);
  });
  it("PoC 用でないスタック名は拒否し、aws を呼ばない", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["deny-si"], {
      ...subjects,
      AWSBRIDGE_HUMAN_POC_STACK_NAME: "awsbridge",
    });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
  it("revoke / unrevoke も --role localonly を受け付ける", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["revoke", "--role", "localonly"], {});
    expect(r.status, r.stderr).toBe(0);
    const put = r.calls.find((c) => c[2] === "put-role-policy") as string[];
    expect(argOf(put, "--role-name")).toBe("AwsbridgeHumanPocLocalOnly");
  });
});

describe("persist.ts inline（(4-a) CFN の外のインラインポリシーが残るか）", () => {
  it("スタックの全ロールのインラインポリシーを出し、Tagged に revoke と deny-si が残っているかを判定する", () => {
    const r = runTs(
      "scripts/poc/human/persist.ts",
      ["inline"],
      {},
      {
        rolePolicies: {
          AwsbridgeHumanPocTagged: [
            "PrincipalTagPermissions",
            "AWSRevokeOlderSessions",
            "AwsbridgeDenySourceIdentity",
          ],
          AwsbridgeHumanPocLocalOnly: ["AwsLoginLocalhostOnly"],
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const lists = r.calls.filter((c) => c[2] === "list-role-policies");
    expect(lists.map((c) => argOf(c, "--role-name")).sort()).toEqual([
      "AwsbridgeHumanPoc",
      "AwsbridgeHumanPocLocalOnly",
      "AwsbridgeHumanPocNoTag",
      "AwsbridgeHumanPocTagged",
    ]);
    for (const c of lists) expect(c).toContain("PROFILE=awsbridge");
    expect(r.stdout).toContain("AwsLoginLocalhostOnly");
    expect(r.stdout).toMatch(/すべて残っている/);
    expect(r.stdout).not.toContain(ACCOUNT);
  });
  it("消えていればそれを判定に出す（--expect と --role で対象を変えられる）", () => {
    const r = runTs(
      "scripts/poc/human/persist.ts",
      ["inline", "--role", "base", "--expect", "AWSRevokeOlderSessions"],
      {},
      { rolePolicies: { AwsbridgeHumanPocTagged: ["AWSRevokeOlderSessions"] } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/base のロールから消えた: AWSRevokeOlderSessions/);
  });
  it("Output に PoC 用でないロールがあれば一覧を取らずに止まる", () => {
    const r = runTs(
      "scripts/poc/human/persist.ts",
      ["inline"],
      {},
      {
        outputs: [{ OutputKey: "TaggedRoleArn", OutputValue: role("FederatedMcpDebug") }],
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c[2] === "list-role-policies")).toBe(false);
  });
  it("PoC 用でないスタック名・不明なサブコマンド・ロールは拒否し、aws を呼ばない", () => {
    for (const [args, env] of [
      [["inline"], { AWSBRIDGE_HUMAN_POC_STACK_NAME: "awsbridge" }],
      [["nope"], {}],
      [[], {}],
      [["inline", "--role", "admin"], {}],
      [["inline", "--expect", "bad name!"], {}],
    ] as [string[], Record<string, string>][]) {
      const r = runTs("scripts/poc/human/persist.ts", args, env);
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.calls).toEqual([]);
    }
  });
});

describe("persist.ts drift（(4-a) ドリフト検出でどう見えるか）", () => {
  it("detect-stack-drift → 完了を待つ → リソースごとの状態と差分の場所・種類を出す（値・email・アカウント ID は出さない）", () => {
    const r = runTs(
      "scripts/poc/human/persist.ts",
      ["drift", "--poll-seconds", "0"],
      {},
      {
        driftStatus: {
          StackDriftDetectionId: "drift-1",
          DetectionStatus: "DETECTION_COMPLETE",
          StackDriftStatus: "DRIFTED",
          DriftedStackResourceCount: 1,
        },
        drifts: {
          StackResourceDrifts: [
            {
              LogicalResourceId: "TaggedRole",
              ResourceType: "AWS::IAM::Role",
              StackResourceDriftStatus: "MODIFIED",
              PropertyDifferences: [
                {
                  PropertyPath: "/Policies/1",
                  DifferenceType: "ADD",
                  ActualValue: JSON.stringify({
                    PolicyName: "AwsbridgeDenySourceIdentity",
                    PolicyDocument: { x: PRIMARY },
                  }),
                  ExpectedValue: "null",
                },
              ],
            },
          ],
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const detect = r.calls.find((c) => c[2] === "detect-stack-drift") as string[];
    expect(argOf(detect, "--stack-name")).toBe("awsbridge-human-poc");
    const status = r.calls.find(
      (c) => c[2] === "describe-stack-drift-detection-status",
    ) as string[];
    expect(argOf(status, "--stack-drift-detection-id")).toBe("drift-1");
    expect(r.calls.some((c) => c[2] === "describe-stack-resource-drifts")).toBe(true);
    expect(r.stdout).toContain("DRIFTED");
    expect(r.stdout).toContain("/Policies/1 ADD（AwsbridgeDenySourceIdentity）");
    expect(r.stdout).not.toMatch(/user@example\.com|123456789012/);
  });
  it("検出が失敗したら終了コード 1（理由を出す）", () => {
    const r = runTs(
      "scripts/poc/human/persist.ts",
      ["drift", "--poll-seconds", "0"],
      {},
      {
        driftStatus: {
          DetectionStatus: "DETECTION_FAILED",
          DetectionStatusReason: "boom",
        },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("boom");
  });
});

describe("console-url.ts / stop-watch.ts の 2 人目と localonly（ネットワークに出る前で止める）", () => {
  const base = {
    AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}`,
    ...subjects,
  };
  it("console-url --role localonly はスタックの Output LocalOnlyRoleArn を使う（署名鍵で止まる）", () => {
    const out = tmp("awsbridge-human-gate-out-");
    const r = runTs("scripts/poc/human/console-url.ts", ["--role", "localonly"], {
      ...base,
      AWSBRIDGE_HUMAN_POC_OUT_DIR: out,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("署名鍵を読めません");
    expect(r.calls.some((c) => c[2] === "describe-stacks")).toBe(true);
    const noOutput = runTs(
      "scripts/poc/human/console-url.ts",
      ["--role", "localonly"],
      { ...base, AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
      { outputs: OUTPUTS.filter((o) => o.OutputKey !== "LocalOnlyRoleArn") },
    );
    expect(noOutput.status).toBe(1);
    expect(noOutput.stderr).toContain("LocalOnlyRoleArn");
  });
  it("console-url --who second: 2 人目が無い・同じ・不正な値なら aws を呼ばない", () => {
    for (const [args, env] of [
      [
        ["--who", "second"],
        { AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}`, AWSBRIDGE_HUMAN_POC_SUBJECT: PRIMARY },
      ],
      [["--who", "second"], { ...base, AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: PRIMARY }],
      [["--who", "nobody"], base],
    ] as [string[], Record<string, string>][]) {
      const r = runTs("scripts/poc/human/console-url.ts", args, env);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });
  it("console-url --who second は 2 人目で進む（署名鍵で止まる）", () => {
    const out = tmp("awsbridge-human-gate-out-");
    const r = runTs(
      "scripts/poc/human/console-url.ts",
      ["--role", "tagged", "--who", "second", "--source-identity", "--access-profile", "poc-admin"],
      { ...base, AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("署名鍵を読めません");
  });
  it("stop-watch --assume tagged:second: 2 人目が無ければ aws を呼ばない。あれば引き受けに進む（署名鍵で止まる）", () => {
    const out = tmp("awsbridge-human-gate-out-");
    const none = runTs(
      "scripts/poc/human/stop-watch.ts",
      ["--assume", "tagged:second", "--count", "1", "--interval", "0"],
      {
        AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}`,
        AWSBRIDGE_HUMAN_POC_SUBJECT: PRIMARY,
        AWSBRIDGE_HUMAN_POC_OUT_DIR: out,
      },
    );
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT");
    expect(none.calls).toEqual([]);
    const ok = runTs(
      "scripts/poc/human/stop-watch.ts",
      ["--assume", "tagged", "--assume", "tagged:second", "--count", "1", "--interval", "0"],
      { ...base, AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
    );
    expect(ok.status).toBe(1);
    expect(ok.stderr).toContain("署名鍵を読めません");
    expect(ok.calls.some((c) => c[2] === "describe-stacks")).toBe(true);
  });
});
