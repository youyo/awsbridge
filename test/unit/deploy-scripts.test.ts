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
function fakeBin(): { dir: string; argsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "awsbridge-fakebin-"));
  tmpDirs.push(dir);
  const argsFile = join(dir, "args.txt");
  const aws = join(dir, "aws");
  writeFileSync(
    aws,
    `#!/bin/sh\necho "AWS_CALLED $*"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\nexit 99\n`,
  );
  chmodSync(aws, 0o755);
  return { dir, argsFile };
}

const full = {
  AWSBRIDGE_ISSUER: "https://awsbridge.example.workers.dev/",
  AWSBRIDGE_AUDIENCE: "awsbridge",
  AWSBRIDGE_ROLE_NAME: "awsbridge",
  AWSBRIDGE_STACK_NAME: "awsbridge",
  AWSBRIDGE_ALLOWED_SUBJECTS: "user@example.com",
};

function run(script: string, env: Record<string, string>) {
  const { dir, argsFile } = fakeBin();
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
  return { ...r, args };
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

describe("AWSBRIDGE_ALLOWED_SUBJECTS の検証", () => {
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
      const r = run("scripts/deploy-aws.sh", { ...full, AWSBRIDGE_ALLOWED_SUBJECTS: v });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("AWSBRIDGE_ALLOWED_SUBJECTS");
      expect(r.stderr).toContain("mise.local.toml");
      expect(r.stdout + r.stderr).not.toContain("AWS_CALLED");
      expect(r.args).toEqual([]);
    });
  }
  it("拒否メッセージは該当要素を示す", () => {
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_ALLOWED_SUBJECTS: "ok@example.com,bad",
    });
    expect(r.stderr).toContain("bad");
  });
  for (const v of ["user@example.com", "*@example.com,user@example.org"]) {
    it(`${JSON.stringify(v)} は検証を通過し aws が呼ばれる`, () => {
      const r = run("scripts/deploy-aws.sh", { ...full, AWSBRIDGE_ALLOWED_SUBJECTS: v });
      expect(r.status).toBe(99);
      expect(r.stdout).toContain("AWS_CALLED");
      expect(r.args).toContain(`AllowedSubjects=${v}`);
    });
  }
});

describe("AWSBRIDGE_ALLOWED_SUBJECTS の小文字化", () => {
  it("大文字混じりの入力は小文字にして検証・CloudFormation に渡す", () => {
    const r = run("scripts/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_ALLOWED_SUBJECTS: "User@Example.COM,*@Example.Org",
    });
    expect(r.status).toBe(99);
    expect(r.args).toContain("AllowedSubjects=user@example.com,*@example.org");
    expect(r.args.some((a) => /AllowedSubjects=.*[A-Z]/.test(a))).toBe(false);
  });
});

describe("aws へ渡すパラメーター", () => {
  it("IssuerHost は https:// と末尾 / を除去する", () => {
    const r = run("scripts/deploy-aws.sh", full);
    expect(r.args).toContain("IssuerHost=awsbridge.example.workers.dev");
  });
  it("AWSBRIDGE_MANAGED_POLICY_ARNS が空なら ManagedPolicyArns を渡さない", () => {
    const r = run("scripts/deploy-aws.sh", full);
    expect(r.args.some((a) => a.startsWith("ManagedPolicyArns="))).toBe(false);
  });
  it("AWSBRIDGE_MANAGED_POLICY_ARNS があれば渡す", () => {
    const arn = "arn:aws:iam::aws:policy/ReadOnlyAccess";
    const r = run("scripts/deploy-aws.sh", { ...full, AWSBRIDGE_MANAGED_POLICY_ARNS: arn });
    expect(r.args).toContain(`ManagedPolicyArns=${arn}`);
  });
});

describe("scripts/destroy-aws.sh", () => {
  it("AWSBRIDGE_STACK_NAME が未設定なら終了コード 1", () => {
    const r = run("scripts/destroy-aws.sh", {});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AWSBRIDGE_STACK_NAME");
    expect(r.stderr).toContain("mise.local.toml");
    expect(r.stdout + r.stderr).not.toContain("AWS_CALLED");
  });
});
