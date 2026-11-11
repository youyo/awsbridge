import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// PoC（人間の AWS ログイン）の mise タスクとシェルスクリプト。
// 実 AWS / Cloudflare は呼ばない: aws と pnpm は引数を記録するだけのダミーに差し替える。

const root = new URL("../../", import.meta.url).pathname;
const toml = readFileSync(join(root, "mise.toml"), "utf8");

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

// aws / pnpm のダミー。呼ばれるたびに "<cmd> <引数をタブ区切り>" と AWS_PROFILE / AWS_REGION を log に 1 行で追記する。
function fakeBin(awsExit: number): { dir: string; log: string } {
  const dir = tmp("awsbridge-human-fakebin-");
  const log = join(dir, "calls.log");
  for (const cmd of ["aws", "pnpm"]) {
    const f = join(dir, cmd);
    writeFileSync(
      f,
      `#!/bin/bash\n{ printf '%s' "${cmd}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\tPROFILE=%s\\tREGION=%s\\n' "\${AWS_PROFILE-UNSET}" "\${AWS_REGION-UNSET}"; } >> "${log}"\necho "${cmd.toUpperCase()}_CALLED"\nexit ${cmd === "aws" ? awsExit : 0}\n`,
    );
    chmodSync(f, 0o755);
  }
  return { dir, log };
}

function run(script: string, env: Record<string, string>, awsExit = 0) {
  const { dir, log } = fakeBin(awsExit);
  const r = spawnSync("bash", [join(root, script)], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
    : [];
  return { ...r, calls };
}

// MCP 経路の変数が mise.local.toml にあっても、PoC のスクリプトはそれを使わないこと
const mcpVars = {
  AWSBRIDGE_ISSUER: "https://awsbridge.example.workers.dev",
  AWSBRIDGE_STACK_NAME: "awsbridge",
  AWSBRIDGE_AUDIENCE: "awsbridge",
  AWSBRIDGE_ALLOWED_SUBJECTS: "mcp@example.com",
  AWSBRIDGE_WRANGLER_CONFIG: "wrangler.jsonc",
  AWSBRIDGE_WRANGLER_ENV: "dev",
};

const full = {
  AWSBRIDGE_HUMAN_POC_ISSUER: "https://awsbridge-human-poc.example.workers.dev/",
  AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com",
};

describe("mise タスク poc:human:*", () => {
  const tasks: Record<string, string> = {
    "poc:human:keygen": "scripts/poc/human/keygen.ts",
    "poc:human:deploy-issuer": "scripts/poc/human/deploy-issuer.ts",
    "poc:human:deploy-aws": "scripts/poc/human/deploy-aws.sh",
    "poc:human:console-url": "scripts/poc/human/console-url.ts",
    "poc:human:destroy": "scripts/poc/human/destroy.sh",
  };
  for (const [name, script] of Object.entries(tasks)) {
    it(`${name} は ${script} を呼び、MCP 用の wrangler.sh / deploy-aws.sh を使わない`, () => {
      const s = section(`tasks."${name}"`);
      expect(s, name).toContain(script);
      expect(s).toMatch(/^description\s*=/m);
      expect(s).not.toMatch(
        /scripts\/wrangler\.sh|scripts\/deploy-aws\.sh|scripts\/destroy-aws\.sh/,
      );
    });
  }
  it("lint は PoC のテンプレートも cfn-lint で検査する", () => {
    expect(section("tasks.lint")).toContain("cfn-lint scripts/poc/human/poc-human.yaml");
    expect(section("tasks.lint")).toContain("cfn-lint infra/aws/awsbridge.yaml");
  });
  it("PoC の既定値を [env] に置かない", () => {
    expect(section("env")).not.toMatch(/^AWSBRIDGE_HUMAN_POC_\w+\s*=/m);
  });
});

describe("scripts/poc/human/wrangler.jsonc", () => {
  const cfg = readFileSync(join(root, "scripts/poc/human/wrangler.jsonc"), "utf8");
  it("Worker 名は awsbridge-human-poc、workers.dev、env セクションなし", () => {
    expect(cfg).toMatch(/"name":\s*"awsbridge-human-poc"/);
    expect(cfg).toMatch(/"workers_dev":\s*true/);
    expect(cfg).toMatch(/"main":\s*"worker\.ts"/);
    expect(cfg).not.toMatch(/"env"\s*:/);
  });
});

describe("scripts/poc/human/deploy-aws.sh", () => {
  for (const name of Object.keys(full)) {
    it(`${name} が未設定なら終了コード 1 で aws を呼ばない`, () => {
      const { [name as keyof typeof full]: _, ...rest } = full;
      const r = run("scripts/poc/human/deploy-aws.sh", { ...mcpVars, ...rest });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(name);
      expect(r.stderr).toContain("mise.local.toml");
      expect(r.calls).toEqual([]);
    });
  }
  for (const bad of [
    "*@example.com",
    "a@example.com,b@example.com",
    'a"b@example.com',
    "user",
    " user@example.com",
  ]) {
    it(`Subject ${JSON.stringify(bad)} は拒否する`, () => {
      const r = run("scripts/poc/human/deploy-aws.sh", {
        ...full,
        AWSBRIDGE_HUMAN_POC_SUBJECT: bad,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("AWSBRIDGE_HUMAN_POC_SUBJECT");
      expect(r.calls).toEqual([]);
    });
  }
  for (const bad of [
    "http://awsbridge-human-poc.example.workers.dev",
    "https://awsbridge-human-poc.example.workers.dev/path",
    "awsbridge-human-poc.example.workers.dev",
  ]) {
    it(`issuer ${JSON.stringify(bad)} は拒否する`, () => {
      const r = run("scripts/poc/human/deploy-aws.sh", {
        ...full,
        AWSBRIDGE_HUMAN_POC_ISSUER: bad,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("AWSBRIDGE_HUMAN_POC_ISSUER");
      expect(r.calls).toEqual([]);
    });
  }
  it("既定: スタック awsbridge-human-poc・プロファイル awsbridge・リージョン ap-northeast-1。MCP 用の変数は使わない", () => {
    const r = run("scripts/poc/human/deploy-aws.sh", { ...mcpVars, ...full });
    expect(r.status, r.stderr).toBe(0);
    const deploy = r.calls.find((c) => c[0] === "aws" && c[2] === "deploy");
    expect(deploy).toBeDefined();
    const args = deploy as string[];
    expect(args[args.indexOf("--stack-name") + 1]).toBe("awsbridge-human-poc");
    expect(args[args.indexOf("--template-file") + 1]).toBe(
      join(root, "scripts/poc/human/poc-human.yaml"),
    );
    expect(args).toContain("IssuerHost=awsbridge-human-poc.example.workers.dev");
    expect(args).toContain("Subject=user@example.com");
    expect(args).toContain("Audience=awsbridge-human-poc");
    expect(args).toContain("PROFILE=awsbridge");
    expect(args).toContain("REGION=ap-northeast-1");
    expect(args.join(" ")).not.toMatch(/awsbridge\.example\.workers\.dev|mcp@example\.com/);
  });
  it("AWSBRIDGE_HUMAN_POC_* と AWS_PROFILE / AWS_REGION で上書きでき、Subject は小文字にする", () => {
    const r = run("scripts/poc/human/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_HUMAN_POC_SUBJECT: "User@Example.COM",
      AWSBRIDGE_HUMAN_POC_STACK_NAME: "stack-x",
      AWSBRIDGE_HUMAN_POC_AUDIENCE: "aud-x",
      AWSBRIDGE_HUMAN_POC_ROLE_NAME: "RoleX",
      AWS_PROFILE: "prof-x",
      AWS_REGION: "us-west-2",
    });
    expect(r.status, r.stderr).toBe(0);
    const args = r.calls.find((c) => c[0] === "aws" && c[2] === "deploy") as string[];
    expect(args[args.indexOf("--stack-name") + 1]).toBe("stack-x");
    expect(args).toContain("Subject=user@example.com");
    expect(args).toContain("Audience=aud-x");
    expect(args).toContain("RoleName=RoleX");
    expect(args).toContain("PROFILE=prof-x");
    expect(args).toContain("REGION=us-west-2");
  });
  it("SecondSubject（既定 none）と UpdateMarker（既定 0）を毎回明示して渡す（cloudformation deploy は省いた値の前回値を引き継ぐため）", () => {
    const r = run("scripts/poc/human/deploy-aws.sh", full);
    expect(r.status, r.stderr).toBe(0);
    const args = r.calls.find((c) => c[0] === "aws" && c[2] === "deploy") as string[];
    expect(args).toContain("SecondSubject=none");
    expect(args).toContain("UpdateMarker=0");
  });
  it("AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT（小文字にする）と AWSBRIDGE_HUMAN_POC_UPDATE_MARKER を渡す", () => {
    const r = run("scripts/poc/human/deploy-aws.sh", {
      ...full,
      AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: "Second@Example.COM",
      AWSBRIDGE_HUMAN_POC_UPDATE_MARKER: "2",
    });
    expect(r.status, r.stderr).toBe(0);
    const args = r.calls.find((c) => c[0] === "aws" && c[2] === "deploy") as string[];
    expect(args).toContain("SecondSubject=second@example.com");
    expect(args).toContain("UpdateMarker=2");
  });
  for (const [env, bad] of [
    ["AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT", "*@example.com"],
    ["AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT", "a@example.com,b@example.com"],
    ["AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT", "User@Example.com"],
    ["AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT", "none"],
    ["AWSBRIDGE_HUMAN_POC_UPDATE_MARKER", "a-b"],
    ["AWSBRIDGE_HUMAN_POC_UPDATE_MARKER", "A".repeat(17)],
  ]) {
    it(`${env}=${JSON.stringify(bad)} は拒否する（2 人目は 1 人目と別の 1 人の email、印は英数字 16 文字まで）`, () => {
      const r = run("scripts/poc/human/deploy-aws.sh", { ...full, [env as string]: bad as string });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(env);
      expect(r.calls).toEqual([]);
    });
  }
  it("aws が失敗したら失敗で終わる", () => {
    const r = run("scripts/poc/human/deploy-aws.sh", full, 7);
    expect(r.status).toBe(7);
  });
  it("Cloudflare（wrangler）は呼ばない", () => {
    const r = run("scripts/poc/human/deploy-aws.sh", full);
    expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
  });
});

describe("scripts/poc/human/destroy.sh", () => {
  it("PoC のスタックだけを消し（MCP 用の AWSBRIDGE_STACK_NAME は無視）、PoC の Worker を明示の設定と名前で消す", () => {
    const out = tmp("awsbridge-human-out-");
    const r = run("scripts/poc/human/destroy.sh", {
      ...mcpVars,
      AWSBRIDGE_HUMAN_POC_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    const del = r.calls.find((c) => c[0] === "aws" && c[2] === "delete-stack") as string[];
    expect(del[del.indexOf("--stack-name") + 1]).toBe("awsbridge-human-poc");
    expect(del).toContain("PROFILE=awsbridge");
    expect(del).toContain("REGION=ap-northeast-1");
    for (const c of r.calls.filter((c) => c[0] === "aws"))
      expect(c[c.indexOf("--stack-name") + 1]).toBe("awsbridge-human-poc");
    const wr = r.calls.find((c) => c[0] === "pnpm") as string[];
    expect(wr.slice(1, 4)).toEqual(["exec", "wrangler", "delete"]);
    expect(wr[wr.indexOf("--config") + 1]).toBe(join(root, "scripts/poc/human/wrangler.jsonc"));
    expect(wr[wr.indexOf("--name") + 1]).toBe("awsbridge-human-poc");
    expect(wr).not.toContain("--env");
    expect(wr.join(" ")).not.toContain("wrangler.jsonc --env");
  });
  it("AWSBRIDGE_HUMAN_POC_STACK_NAME で対象スタックを変えられる", () => {
    const r = run("scripts/poc/human/destroy.sh", {
      AWSBRIDGE_HUMAN_POC_STACK_NAME: "awsbridge-human-poc-x",
      AWSBRIDGE_HUMAN_POC_OUT_DIR: tmp("awsbridge-human-out-"),
    });
    const del = r.calls.find((c) => c[0] === "aws" && c[2] === "delete-stack") as string[];
    expect(del[del.indexOf("--stack-name") + 1]).toBe("awsbridge-human-poc-x");
  });
  it.each(["awsbridge", "stack-x"])(
    "PoC 用（awsbridge-human-poc で始まる）でないスタック名 %s は拒否し、何も消さない",
    (stack) => {
      const r = run("scripts/poc/human/destroy.sh", {
        AWSBRIDGE_HUMAN_POC_STACK_NAME: stack,
        AWSBRIDGE_HUMAN_POC_OUT_DIR: tmp("awsbridge-human-out-"),
      });
      expect(r.status).not.toBe(0);
      expect(r.calls).toEqual([]);
    },
  );
  it("ログイン URL と認証情報のファイルを消し、署名鍵は残す", () => {
    const out = tmp("awsbridge-human-out-");
    mkdirSync(out, { recursive: true });
    for (const f of [
      "console-url-none.txt",
      "console-url-43200.txt",
      "credentials.json",
      "signing-key.json",
      "issuer-documents.json",
    ])
      writeFileSync(join(out, f), "x");
    const r = run("scripts/poc/human/destroy.sh", { AWSBRIDGE_HUMAN_POC_OUT_DIR: out });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(out, "console-url-none.txt"))).toBe(false);
    expect(existsSync(join(out, "console-url-43200.txt"))).toBe(false);
    expect(existsSync(join(out, "credentials.json"))).toBe(false);
    expect(existsSync(join(out, "signing-key.json"))).toBe(true);
  });
  it("スタックの削除が失敗したら Worker は消さずに失敗で終わる", () => {
    const r = run(
      "scripts/poc/human/destroy.sh",
      { AWSBRIDGE_HUMAN_POC_OUT_DIR: tmp("awsbridge-human-out-") },
      5,
    );
    expect(r.status).toBe(5);
    expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
  });
});
