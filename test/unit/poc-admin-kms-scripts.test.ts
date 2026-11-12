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

// PoC N6（Admin の階層の署名鍵を KMS に置く）の mise タスクとシェルスクリプト。
// 実 AWS / Cloudflare は呼ばない: aws と pnpm は引数を記録するダミーに差し替える。

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

const KEY = "arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111";

// aws / pnpm のダミー。呼ばれるたびに "<cmd> <引数をタブ区切り>" と AWS_PROFILE / AWS_REGION を log に追記する。
// aws は引数に応じて決まった値を返す（WorkerUserName・鍵 ARN・アクセスキーの一覧・鍵の状態）。
function fakeBin(opts: { deleteStackExit?: number; awsExit?: number } = {}) {
  const dir = tmp("awsbridge-kms-fakebin-");
  const log = join(dir, "calls.log");
  const record = `{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\tPROFILE=%s\\tREGION=%s\\n' "\${AWS_PROFILE-UNSET}" "\${AWS_REGION-UNSET}"; } >> "${log}"`;
  writeFileSync(
    join(dir, "aws"),
    `#!/bin/bash
${record}
args="$*"
case "$args" in
  *delete-stack*) exit ${opts.deleteStackExit ?? 0} ;;
  *WorkerUserName*) echo "awsbridge-admin-kms-poc-worker" ;;
  *KeyArn*) echo "${KEY}" ;;
  *list-access-keys*) echo "AKIAFAKEFAKEFAKE0001" ;;
  *describe-key*) printf 'PendingDeletion\\t2026-11-19T00:00:00+00:00\\n' ;;
esac
exit ${opts.awsExit ?? 0}
`,
  );
  writeFileSync(join(dir, "pnpm"), `#!/bin/bash\n${record}\nexit 0\n`);
  for (const f of ["aws", "pnpm"]) chmodSync(join(dir, f), 0o755);
  return { dir, log };
}

function run(script: string, env: Record<string, string>, opts = {}) {
  const { dir, log } = fakeBin(opts);
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

const ISSUER = "https://awsbridge-admin-kms-poc.example.workers.dev";

describe("mise タスク poc:admin-kms:*", () => {
  const tasks: [string, string][] = [
    ["deploy-aws", "scripts/poc/admin-kms/deploy-aws.sh"],
    ["deploy", "scripts/poc/admin-kms/deploy.ts"],
    ["access-key", "scripts/poc/admin-kms/access-key.ts"],
    ["run", "scripts/poc/admin-kms/run.ts"],
    ["disable-watch", "scripts/poc/admin-kms/disable-watch.ts"],
    ["trail", "scripts/poc/admin-kms/trail.ts"],
    ["destroy", "scripts/poc/admin-kms/destroy.sh"],
  ];
  it.each(tasks)(
    "poc:admin-kms:%s は %s を呼び、MCP 用の wrangler.sh / deploy-aws.sh を使わない",
    (name, script) => {
      const s = section(`tasks."poc:admin-kms:${name}"`);
      expect(s).toContain(script);
      expect(s).not.toMatch(/scripts\/wrangler\.sh|scripts\/deploy-aws\.sh/);
    },
  );
  it("lint は PoC N6 のテンプレートも cfn-lint で検査する", () => {
    expect(section("tasks.lint")).toContain("cfn-lint scripts/poc/admin-kms/poc-admin-kms.yaml");
  });
  it("PoC N6 の既定値を [env] に置かない", () => {
    expect(section("env")).not.toMatch(/^AWSBRIDGE_ADMIN_KMS_POC_/m);
  });
});

describe("scripts/poc/admin-kms/wrangler.jsonc", () => {
  const cfg = JSON.parse(
    readFileSync(join(root, "scripts/poc/admin-kms/wrangler.jsonc"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  it("Worker 名は awsbridge-admin-kms-poc、workers.dev、Preview URL は無効、env セクションなし、vars・secret の実値なし", () => {
    expect(cfg.name).toBe("awsbridge-admin-kms-poc");
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.preview_urls).toBe(false);
    expect(cfg.env).toBeUndefined();
    expect(cfg.vars).toBeUndefined();
  });
});

describe("scripts/poc/admin-kms/deploy-aws.sh", () => {
  it("AWSBRIDGE_ADMIN_KMS_POC_ISSUER が未設定なら終了コード 1 で aws を呼ばない", () => {
    const r = run("scripts/poc/admin-kms/deploy-aws.sh", {});
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
  it.each([
    "https://awsbridge-mcp.example.workers.dev",
    "http://awsbridge-admin-kms-poc.example.workers.dev",
    "https://awsbridge-admin-kms-poc.example.workers.dev/x",
    "awsbridge-admin-kms-poc.example.workers.dev",
  ])("issuer %s は拒否する", (issuer) => {
    const r = run("scripts/poc/admin-kms/deploy-aws.sh", {
      AWSBRIDGE_ADMIN_KMS_POC_ISSUER: issuer,
    });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
  it("既定: スタック awsbridge-admin-kms-poc・プロファイル awsbridge・リージョン ap-northeast-1。IssuerHost を渡し、Cloudflare は呼ばない", () => {
    const r = run("scripts/poc/admin-kms/deploy-aws.sh", {
      AWSBRIDGE_ADMIN_KMS_POC_ISSUER: `${ISSUER}/`,
      AWSBRIDGE_STACK_NAME: "awsbridge",
    });
    expect(r.status, r.stderr).toBe(0);
    const dep = r.calls.find((c) => c[0] === "aws" && c[2] === "deploy") as string[];
    expect(dep[dep.indexOf("--stack-name") + 1]).toBe("awsbridge-admin-kms-poc");
    expect(dep).toContain("IssuerHost=awsbridge-admin-kms-poc.example.workers.dev");
    expect(dep).toContain("--capabilities");
    expect(dep).toContain("PROFILE=awsbridge");
    expect(dep).toContain("REGION=ap-northeast-1");
    expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
  });
  it("既定は CreateIssuerResources=true、--keys-only なら false（Worker より先に鍵だけ作る）", () => {
    const env = { AWSBRIDGE_ADMIN_KMS_POC_ISSUER: ISSUER };
    const dflt = run("scripts/poc/admin-kms/deploy-aws.sh", env);
    expect(dflt.calls.find((c) => c[2] === "deploy")).toContain("CreateIssuerResources=true");
    const { dir, log } = fakeBin();
    const r = spawnSync(
      "bash",
      [join(root, "scripts/poc/admin-kms/deploy-aws.sh"), "--keys-only"],
      {
        env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("CreateIssuerResources=false");
  });
  it("AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME が PoC の名前でなければ拒否する", () => {
    const r = run("scripts/poc/admin-kms/deploy-aws.sh", {
      AWSBRIDGE_ADMIN_KMS_POC_ISSUER: ISSUER,
      AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME: "awsbridge",
    });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
});

describe("scripts/poc/admin-kms/destroy.sh", () => {
  it("アクセスキーを消してからスタックを消し、鍵の削除予定（KeyState・DeletionDate）を出し、最後に Worker を消す", () => {
    const out = tmp("awsbridge-kms-out-");
    const r = run("scripts/poc/admin-kms/destroy.sh", { AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR: out });
    expect(r.status, r.stderr).toBe(0);
    const idx = (pred: (c: string[]) => boolean) => r.calls.findIndex(pred);
    const delKey = idx((c) => c[0] === "aws" && c[2] === "delete-access-key");
    const delStack = idx((c) => c[0] === "aws" && c[2] === "delete-stack");
    const describeKey = idx((c) => c[0] === "aws" && c[2] === "describe-key");
    const wr = idx((c) => c[0] === "pnpm");
    expect(delKey).toBeGreaterThanOrEqual(0);
    expect(delKey).toBeLessThan(delStack);
    expect(delStack).toBeLessThan(describeKey);
    expect(describeKey).toBeLessThan(wr);
    const del = r.calls[delStack] as string[];
    expect(del[del.indexOf("--stack-name") + 1]).toBe("awsbridge-admin-kms-poc");
    const dk = r.calls[delKey] as string[];
    expect(dk[dk.indexOf("--user-name") + 1]).toBe("awsbridge-admin-kms-poc-worker");
    const w = r.calls[wr] as string[];
    expect(w.slice(1, 4)).toEqual(["exec", "wrangler", "delete"]);
    expect(w[w.indexOf("--name") + 1]).toBe("awsbridge-admin-kms-poc");
    expect(r.stdout).toContain("PendingDeletion");
    expect(r.stdout).toContain("2026-11-19");
    // 鍵 ARN は記録ファイルにだけ書き、画面にはアカウント ID・鍵 ID を出さない
    expect(r.stdout).not.toContain("123456789012");
    expect(r.stdout).not.toContain("11111111-1111");
    expect(readFileSync(join(out, "kms-keys.txt"), "utf8")).toContain(KEY);
  });
  it.each(["awsbridge", "awsbridge-human-poc"])(
    "PoC N6 でないスタック名 %s は拒否し、何も消さない",
    (stack) => {
      const r = run("scripts/poc/admin-kms/destroy.sh", {
        AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME: stack,
        AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR: tmp("awsbridge-kms-out-"),
      });
      expect(r.status).not.toBe(0);
      expect(r.calls).toEqual([]);
    },
  );
  it("スタックの削除が失敗したら Worker は消さずに失敗で終わる", () => {
    const r = run(
      "scripts/poc/admin-kms/destroy.sh",
      { AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR: tmp("awsbridge-kms-out-") },
      { deleteStackExit: 5 },
    );
    expect(r.status).toBe(5);
    expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
  });
  it("手元の bearer・文書・デプロイ用の設定を消し、計測の記録は残す", () => {
    const out = tmp("awsbridge-kms-out-");
    mkdirSync(out, { recursive: true });
    for (const f of [
      "caller-token.txt",
      "issuer-documents.json",
      "wrangler.deploy.json",
      "runs.jsonl",
    ])
      writeFileSync(join(out, f), "x");
    const r = run("scripts/poc/admin-kms/destroy.sh", { AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR: out });
    expect(r.status, r.stderr).toBe(0);
    for (const f of ["caller-token.txt", "issuer-documents.json", "wrangler.deploy.json"])
      expect(existsSync(join(out, f)), f).toBe(false);
    expect(existsSync(join(out, "runs.jsonl"))).toBe(true);
  });
});
