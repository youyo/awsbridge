import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// aws コマンドが呼ばれたら失敗するダミーを PATH の先頭に置き、実 AWS を絶対に呼ばない。
// 渡された引数は 1 行 1 引数で args ファイルに記録する。
function fakeBin(): { dir: string; argsFile: string; profileFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "awsbridge-fakebin-"));
  tmpDirs.push(dir);
  const argsFile = join(dir, "args.txt");
  const aws = join(dir, "aws");
  const profileFile = join(dir, "profile.txt");
  writeFileSync(
    aws,
    `#!/bin/sh\necho "AWS_CALLED $*"\nprintf '%s' "\${AWS_PROFILE-UNSET}" > "${profileFile}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\nexit 99\n`,
  );
  chmodSync(aws, 0o755);
  return { dir, argsFile, profileFile };
}

const full = {
  AWSBRIDGE_ISSUER: "https://awsbridge.example.workers.dev/",
  AWSBRIDGE_ALLOWED_SUBJECTS: "user@example.com",
  AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS: "admin@example.com",
};

function run(script: string, env: Record<string, string>) {
  const { dir, argsFile, profileFile } = fakeBin();
  const r = spawnSync("bash", [join(root, script)], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  let args: string[] = [];
  try {
    args = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
  } catch {
    // aws が呼ばれていない
  }
  let profile = "";
  try {
    profile = readFileSync(profileFile, "utf8");
  } catch {
    // aws が呼ばれていない
  }
  return { ...r, args, profile };
}

describe("scripts/deploy-aws.sh", () => {
  for (const name of Object.keys(full)) {
    it(`${name} が未設定なら終了コード 1 で mise.local.toml を案内する`, () => {
      const { [name as keyof typeof full]: _, ...rest } = full;
      const r = run("scripts/deploy-aws.sh", rest);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(name);
      expect(r.stderr).toContain("mise.local.toml");
      expect(r.stdout + r.stderr).not.toContain("AWS_CALLED");
    });
  }
});

const subjectVars = [
  {
    env: "AWSBRIDGE_ALLOWED_SUBJECTS",
    param: "AllowedSubjects",
    other: "AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS",
  },
  {
    env: "AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS",
    param: "DebugAllowedSubjects",
    other: "AWSBRIDGE_ALLOWED_SUBJECTS",
  },
] as const;

for (const { env, param } of subjectVars) {
  describe(`${env} の検証`, () => {
    const rejected = [
      "*",
      "*@*",
      "*@*.com",
      'a"b@example.com',
      "user",
      "a@example.com,",
      " a@example.com",
    ];
    for (const v of rejected) {
      it(`${JSON.stringify(v)} は終了コード 1 で拒否し aws を呼ばない`, () => {
        const r = run("scripts/deploy-aws.sh", { ...full, [env]: v });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(env);
        expect(r.stderr).toContain("mise.local.toml");
        expect(r.stdout + r.stderr).not.toContain("AWS_CALLED");
        expect(r.args).toEqual([]);
      });
    }
    it("拒否メッセージは該当要素を示す", () => {
      const r = run("scripts/deploy-aws.sh", { ...full, [env]: "ok@example.com,bad" });
      expect(r.stderr).toContain("bad");
    });
    for (const v of ["user@example.com", "*@example.com,user@example.org"]) {
      it(`${JSON.stringify(v)} は検証を通過し aws が呼ばれる`, () => {
        const r = run("scripts/deploy-aws.sh", { ...full, [env]: v });
        expect(r.status).toBe(99);
        expect(r.stdout).toContain("AWS_CALLED");
        expect(r.args).toContain(`${param}=${v}`);
      });
    }
    it("大文字混じりの入力は小文字にして検証・CloudFormation に渡す", () => {
      const r = run("scripts/deploy-aws.sh", { ...full, [env]: "User@Example.COM,*@Example.Org" });
      expect(r.status).toBe(99);
      expect(r.args).toContain(`${param}=user@example.com,*@example.org`);
      expect(r.args.some((a) => new RegExp(`^${param}=.*[A-Z]`).test(a))).toBe(false);
    });
  });
}

describe("aws へ渡すパラメーター", () => {
  it("IssuerHost は https:// と末尾 / を除去する", () => {
    const r = run("scripts/deploy-aws.sh", full);
    expect(r.args).toContain("IssuerHost=awsbridge.example.workers.dev");
  });
  it("2 つの利用者リストを別パラメーターで渡す", () => {
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_ALLOWED_SUBJECTS: "ro@example.com",
      AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS: "dbg@example.com",
    });
    expect(r.args).toContain("AllowedSubjects=ro@example.com");
    expect(r.args).toContain("DebugAllowedSubjects=dbg@example.com");
  });
  it("AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS が空なら渡さず、あれば渡す", () => {
    const none = run("scripts/deploy-aws.sh", full);
    expect(none.args.some((a) => a.startsWith("DebugAdditionalPolicyArns="))).toBe(false);
    const arns = "arn:aws:iam::aws:policy/A,arn:aws:iam::123456789012:policy/b";
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS: arns,
    });
    expect(r.args).toContain(`DebugAdditionalPolicyArns=${arns}`);
  });
  it("AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS が空なら渡さず、あれば渡す", () => {
    const none = run("scripts/deploy-aws.sh", full);
    expect(none.args.some((a) => a.startsWith("DebugPassableEcsTaskRoleArns="))).toBe(false);
    const arns = "arn:aws:iam::111111111111:role/a,arn:aws:iam::111111111111:role/path/b";
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS: arns,
    });
    expect(r.args).toContain(`DebugPassableEcsTaskRoleArns=${arns}`);
  });
  it("廃止したパラメーターは渡さない", () => {
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_ROLE_NAME: "x",
      AWSBRIDGE_MANAGED_POLICY_ARNS: "arn:aws:iam::aws:policy/ReadOnlyAccess",
    });
    expect(r.args.some((a) => a.startsWith("RoleName="))).toBe(false);
    expect(r.args.some((a) => a.startsWith("ManagedPolicyArns="))).toBe(false);
  });
});

const arnVars = [
  {
    env: "AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS",
    ok: "arn:aws:iam::aws:policy/ReadOnlyAccess,arn:aws:iam::111111111111:policy/x",
    ng: ["arn:aws:iam::aws:role/x", "arn:aws:iam::12345:policy/x", "*"],
  },
  {
    env: "AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS",
    ok: "arn:aws:iam::111111111111:role/a,arn:aws:iam::111111111111:role/path/b",
    ng: ["arn:aws:iam::111111111111:role/*", "arn:aws:iam::111111111111:policy/x", "*"],
  },
] as const;

for (const { env, ok, ng } of arnVars) {
  describe(`${env} の検証`, () => {
    const bad = [",", `${ok},`, `,${ok}`, `${ok},,${ok}`, ` ${ok}`, ...ng];
    for (const v of bad) {
      it(`${JSON.stringify(v)} は終了コード 1 で拒否し aws を呼ばない`, () => {
        const r = run("scripts/deploy-aws.sh", { ...full, [env]: v });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(env);
        expect(r.stdout + r.stderr).not.toContain("AWS_CALLED");
        expect(r.args).toEqual([]);
      });
    }
    it("正しい形式は通過して aws が呼ばれる", () => {
      const r = run("scripts/deploy-aws.sh", { ...full, [env]: ok });
      expect(r.status).toBe(99);
      expect(r.stdout).toContain("AWS_CALLED");
    });
  });
}

describe("上書き可能な既定値（mise.toml ではなくスクリプト側で効く）", () => {
  it("deploy-aws.sh: 未設定なら awsbridge の既定値を使う", () => {
    const r = run("scripts/deploy-aws.sh", full);
    expect(r.args).toContain("Audience=awsbridge");
    // ロール名は渡さない（テンプレートの既定 FederatedMcpReadOnly / FederatedMcpDebug を使う）
    expect(r.args.some((a) => a.startsWith("ReadOnlyRoleName="))).toBe(false);
    expect(r.args.some((a) => a.startsWith("DebugRoleName="))).toBe(false);
    expect(r.args).toContain("awsbridge"); // --stack-name の値
    expect(r.profile).toBe("awsbridge");
  });
  it("deploy-aws.sh: 環境変数で上書きできる", () => {
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_AUDIENCE: "aud-x",
      AWSBRIDGE_READONLY_ROLE_NAME: "ro-x",
      AWSBRIDGE_DEBUG_ROLE_NAME: "dbg-x",
      AWSBRIDGE_STACK_NAME: "stack-x",
      AWS_PROFILE: "profile-x",
    });
    expect(r.args).toContain("Audience=aud-x");
    expect(r.args).toContain("ReadOnlyRoleName=ro-x");
    expect(r.args).toContain("DebugRoleName=dbg-x");
    expect(r.args).toContain("stack-x");
    expect(r.args).not.toContain("awsbridge");
    expect(r.profile).toBe("profile-x");
  });
});

describe("scripts/destroy-aws.sh", () => {
  it("AWSBRIDGE_STACK_NAME が未設定なら既定 awsbridge と AWS_PROFILE=awsbridge を使う", () => {
    const r = run("scripts/destroy-aws.sh", {});
    expect(r.args).toContain("awsbridge");
    expect(r.profile).toBe("awsbridge");
  });
  it("環境変数で上書きできる", () => {
    const r = run("scripts/destroy-aws.sh", { AWSBRIDGE_STACK_NAME: "stack-x", AWS_PROFILE: "p" });
    expect(r.args).toContain("stack-x");
    expect(r.profile).toBe("p");
  });
});
