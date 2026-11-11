import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importJWK, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PoC のポータルの手順（mise タスク・シェル・tsx のスクリプト）。
// 実 AWS / Cloudflare は呼ばない: aws・pnpm・terraform は引数を記録するダミーに、HTTP の相手は 127.0.0.1 の擬似サーバーに差し替える。

const root = new URL("../../", import.meta.url).pathname;
const toml = readFileSync(join(root, "mise.toml"), "utf8");
const tsx = join(root, "node_modules/.bin/tsx");
const PORTAL = "scripts/poc/human/portal";
// 入口は自社ドメインの Custom Domain（workers.dev は無効にした）
const HOST = "awsbridge-human-poc-portal.example.com";
const BASE = `https://${HOST}`;
const WORKERS_DEV_BASE = "https://awsbridge-human-poc-portal.example.workers.dev";
const ACCOUNT = "123456789012";
const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";

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

const OUTPUTS = [
  {
    OutputKey: "SharedRoleArn",
    OutputValue: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPocPortalShared`,
  },
  {
    OutputKey: "InfraOnlyRoleArn",
    OutputValue: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPocPortalInfraOnly`,
  },
  {
    OutputKey: "AdminRoleArn",
    OutputValue: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPocPortalAdmin`,
  },
];
const TF_OUTPUT = {
  team_auds: { value: { infra: "a".repeat(64), dev: "b".repeat(64) } },
  entry_aud: { value: "c".repeat(64) },
  worker_host: { value: HOST },
  app_ids: {
    value: {
      "awsbridge-human-poc-portal-entry": "id-entry",
      "awsbridge-human-poc-portal-infra": "id-infra",
      "awsbridge-human-poc-portal-dev": "id-dev",
    },
  },
};

interface Fakes {
  /** describe-stacks の応答。null なら失敗（スタックなし） */
  outputs?: unknown;
  tfOutput?: unknown;
  tfState?: string;
  /** terraform state list を失敗させる */
  tfStateFail?: boolean;
  /** pnpm（wrangler）の終了コード */
  pnpmExit?: number;
}

// aws / pnpm / terraform のダミー。呼ばれるたびに "<cmd> <引数をタブ区切り> PROFILE=.. REGION=.." を log に追記する。
function fakeBin(f: Fakes = {}): { dir: string; log: string } {
  const dir = tmp("awsbridge-portal-fakebin-");
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "outputs.json"),
    JSON.stringify(f.outputs === undefined ? OUTPUTS : f.outputs),
  );
  writeFileSync(join(dir, "tf-output.json"), JSON.stringify(f.tfOutput ?? TF_OUTPUT));
  writeFileSync(
    join(dir, "tf-state.txt"),
    f.tfState ??
      "cloudflare_zero_trust_access_application.entry\ncloudflare_zero_trust_access_policy.entry\n",
  );
  const record = (cmd: string) =>
    `line='${cmd}'; for a in "$@"; do line+=$'\\t'"$a"; done; line+=$'\\t'"PROFILE=\${AWS_PROFILE-UNSET}"$'\\t'"REGION=\${AWS_REGION-UNSET}"; line+=$'\\t'"CFTOKEN=\${CLOUDFLARE_API_TOKEN-UNSET}"; printf '%s\\n' "$line" >> "${log}"`;
  const scripts: Record<string, string> = {
    aws: `${record("aws")}
case "$*" in
  *describe-stacks*) if [ "$(cat "${dir}/outputs.json")" = "null" ]; then echo "Stack does not exist" >&2; exit 254; fi; cat "${dir}/outputs.json" ;;
esac
exit 0`,
    pnpm: `${record("pnpm")}
exit ${f.pnpmExit ?? 0}`,
    terraform: `${record("terraform")}
case "$*" in
  *"output -json"*) cat "${dir}/tf-output.json" ;;
  *"state list"*) ${f.tfStateFail ? "echo 'Error: state' >&2; exit 1" : `cat "${dir}/tf-state.txt"`} ;;
esac
exit 0`,
  };
  for (const [cmd, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, cmd), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, cmd), 0o755);
  }
  return { dir, log };
}

function calls(log: string): string[][] {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
    : [];
}
const argOf = (c: string[], name: string) => c[c.indexOf(name) + 1];

function envFor(dir: string, env: Record<string, string>) {
  return { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), ...env };
}

function runSh(script: string, env: Record<string, string>, fakes: Fakes = {}) {
  const { dir, log } = fakeBin(fakes);
  const r = spawnSync("bash", [join(root, script)], {
    env: envFor(dir, env),
    encoding: "utf8",
    input: "",
  });
  return { ...r, calls: calls(log) };
}

function runTs(script: string, args: string[], env: Record<string, string>, fakes: Fakes = {}) {
  const { dir, log } = fakeBin(fakes);
  const r = spawnSync(tsx, [join(root, script), ...args], {
    cwd: root,
    env: envFor(dir, env),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...r, calls: calls(log) };
}

// 同じプロセスの擬似サーバーに応答させるため、非同期で起動する
function runTsAsync(
  script: string,
  args: string[],
  env: Record<string, string>,
  fakes: Fakes = {},
): Promise<{ status: number | null; stdout: string; stderr: string; calls: string[][] }> {
  const { dir, log } = fakeBin(fakes);
  return new Promise((resolve) => {
    const p = spawn(tsx, [join(root, script), ...args], { cwd: root, env: envFor(dir, env) });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d;
    });
    p.stderr.on("data", (d) => {
      stderr += d;
    });
    p.on("close", (status) => resolve({ status, stdout, stderr, calls: calls(log) }));
  });
}

async function server(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<{ url: string; close: () => void }> {
  const s: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => s.close() };
}

// ---- 鍵（keygen で作ったものを各テストで使う） ----
let outDir = "";
beforeAll(() => {
  outDir = tmp("awsbridge-portal-out-");
  const r = runTs(`${PORTAL}/keygen.ts`, [], { AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: outDir });
  expect(r.status, r.stderr).toBe(0);
});

describe("mise タスク poc:human:portal:*", () => {
  const tasks: Record<string, string> = {
    "poc:human:portal:keygen": `${PORTAL}/keygen.ts`,
    "poc:human:portal:deploy": `${PORTAL}/deploy.ts`,
    "poc:human:portal:deploy-aws": `${PORTAL}/deploy-aws.sh`,
    "poc:human:portal:access-plan": `${PORTAL}/access`,
    "poc:human:portal:access-apply": `${PORTAL}/access`,
    "poc:human:portal:checks": `${PORTAL}/checks.ts`,
    "poc:human:portal:watch": `${PORTAL}/access-watch.ts`,
    "poc:human:portal:revoke-tokens": `${PORTAL}/access-revoke.ts`,
    "poc:human:portal:destroy": `${PORTAL}/destroy.sh`,
    "poc:human:portal:lint": `${PORTAL}/poc-portal.yaml`,
    "poc:human:portal:bypass-check": `${PORTAL}/bypass-check.ts`,
  };
  for (const [name, script] of Object.entries(tasks)) {
    it(`${name} は ${script} を使い、MCP 用の wrangler.sh / deploy-aws.sh・infra/cloudflare を使わない`, () => {
      const s = section(`tasks."${name}"`);
      expect(s, name).toContain(script);
      expect(s).toMatch(/^description\s*=/m);
      expect(s).not.toMatch(/scripts\/wrangler\.sh|scripts\/deploy-aws\.sh|infra\/cloudflare/);
    });
  }
  it("access-apply は PoC 用の state にだけ対話なしで apply する（-auto-approve）。plan には付けない", () => {
    const apply = section('tasks."poc:human:portal:access-apply"');
    expect(apply).toContain(`terraform -chdir=${PORTAL}/access apply -auto-approve`);
    expect(section('tasks."poc:human:portal:access-plan"')).not.toContain("-auto-approve");
  });
  it("access-plan / access-apply は Access を掛けるホストを AWSBRIDGE_HUMAN_POC_PORTAL_HOST から渡す（tfvars より優先）", () => {
    for (const t of ["access-plan", "access-apply"])
      expect(section(`tasks."poc:human:portal:${t}"`), t).toContain(
        '-var "worker_host=${AWSBRIDGE_HUMAN_POC_PORTAL_HOST:?',
      );
  });
  it("wrangler を呼む tail は CLOUDFLARE_API_TOKEN を外す（Workers は wrangler login の OAuth）", () => {
    expect(section('tasks."poc:human:portal:tail"')).toMatch(
      /env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler/,
    );
  });
  it("lint は Terraform の検査（access/check.sh）と cfn-lint を含む", () => {
    const s = section('tasks."poc:human:portal:lint"');
    expect(s).toContain(`${PORTAL}/access/check.sh`);
    expect(s).toContain(`cfn-lint ${PORTAL}/poc-portal.yaml`);
  });
  it("PoC のポータルの既定値を [env] に置かない", () => {
    expect(section("env")).not.toMatch(/^AWSBRIDGE_HUMAN_POC_PORTAL_\w+\s*=/m);
  });
});

describe(`${PORTAL}/wrangler.jsonc と access/.gitignore`, () => {
  it("Worker 名は awsbridge-human-poc-portal、workers.dev・プレビュー URL なし、入口は Custom Domain（ダミーのホスト）、vars・secret を書かない", () => {
    const cfg = readFileSync(join(root, PORTAL, "wrangler.jsonc"), "utf8");
    expect(cfg).toMatch(/"name":\s*"awsbridge-human-poc-portal"/);
    expect(cfg).toMatch(/"workers_dev":\s*false/);
    expect(cfg).toMatch(/"preview_urls":\s*false/);
    expect(cfg).toMatch(/"custom_domain":\s*true/);
    expect(cfg).toContain('"pattern": "awsbridge-human-poc-portal.example.invalid"');
    expect(cfg).not.toMatch(/"vars"|"env"\s*:/);
  });
  it("Access の Terraform の worker_host は workers.dev を受け付けない（入口は自社ドメイン）", () => {
    const tf = readFileSync(join(root, PORTAL, "access/variables.tf"), "utf8");
    expect(tf).toContain('!endswith(var.worker_host, ".workers.dev")');
    expect(tf).toContain("awsbridge-console-poc");
    const ex = readFileSync(join(root, PORTAL, "access/terraform.tfvars.example"), "utf8");
    expect(ex).not.toContain("workers.dev");
  });
  it("Terraform の state と tfvars はコミットしない", () => {
    const gi = readFileSync(join(root, PORTAL, "access/.gitignore"), "utf8");
    for (const p of [".terraform/", "*.tfstate", "*.tfstate.*", "*.tfvars"])
      expect(gi).toContain(p);
  });
});

describe("keygen.ts", () => {
  it("std と admin の鍵を権限 600 で作り、2 回目は上書きしない", () => {
    for (const f of ["signing-key-std.json", "signing-key-admin.json"]) {
      const p = join(outDir, f);
      expect(statSync(p).mode & 0o777, f).toBe(0o600);
    }
    const before = readFileSync(join(outDir, "signing-key-std.json"), "utf8");
    const r = runTs(`${PORTAL}/keygen.ts`, [], { AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: outDir });
    expect(r.status).toBe(0);
    expect(readFileSync(join(outDir, "signing-key-std.json"), "utf8")).toBe(before);
    expect(before).not.toBe(readFileSync(join(outDir, "signing-key-admin.json"), "utf8"));
  });
});

describe("deploy-aws.sh", () => {
  const S = `${PORTAL}/deploy-aws.sh`;
  it("HOST も URL も未設定なら終了コード 1 で aws を呼ばない", () => {
    const r = runSh(S, {});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AWSBRIDGE_HUMAN_POC_PORTAL_HOST");
    expect(r.calls).toEqual([]);
  });
  it("HOST が awsbridge-console-poc.<zone> でもデプロイする。似た名前・workers.dev は拒否する", () => {
    const ok = runSh(S, { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: "awsbridge-console-poc.example.com" });
    expect(ok.status, ok.stderr).toBe(0);
    const d = ok.calls.find((c) => c[1] === "cloudformation" && c[2] === "deploy") as string[];
    expect(d).toContain("IssuerHost=awsbridge-console-poc.example.com");
    expect(argOf(d, "--stack-name")).toBe("awsbridge-human-poc-portal");
    for (const bad of [
      "awsbridge-console.example.com",
      "awsbridge-console-poc.example.workers.dev",
    ]) {
      const r = runSh(S, { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: bad });
      expect(r.status, bad).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });
  it("HOST から issuer のホストを決める。URL と食い違う・workers.dev・不正な HOST は拒否する", () => {
    const ok = runSh(S, { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: HOST });
    expect(ok.status, ok.stderr).toBe(0);
    const d = ok.calls.find((c) => c[1] === "cloudformation" && c[2] === "deploy") as string[];
    expect(d).toContain(`IssuerHost=${HOST}`);
    for (const env of [
      { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: HOST, AWSBRIDGE_HUMAN_POC_PORTAL_URL: WORKERS_DEV_BASE },
      { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: "awsbridge-human-poc-portal.example.workers.dev" },
      { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: `https://${HOST}` },
      { AWSBRIDGE_HUMAN_POC_PORTAL_URL: WORKERS_DEV_BASE },
    ]) {
      const r = runSh(S, env);
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });
  for (const bad of [
    "https://awsbridge.example.workers.dev",
    "https://awsbridge-human-poc.example.workers.dev",
    `${BASE}/std`,
    `http://${HOST}`,
  ])
    it(`PoC のポータルでない URL ${bad} は拒否する`, () => {
      const r = runSh(S, { AWSBRIDGE_HUMAN_POC_PORTAL_URL: bad });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
    });
  it("PoC のポータル用でないスタック名・不正なチーム名は拒否する", () => {
    for (const env of [
      { AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME: "awsbridge" },
      { AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME: "awsbridge-human-poc" },
      { AWSBRIDGE_HUMAN_POC_PORTAL_SHARED_TEAMS: 'infra,"dev' },
      { AWSBRIDGE_HUMAN_POC_PORTAL_RESTRICTED_TEAM: "Infra" },
    ]) {
      const r = runSh(S, { AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE, ...env });
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });
  it("PoC のポータルのテンプレートを、ホスト名とチームを渡してデプロイする（MCP 用の変数は読まない）", () => {
    const r = runSh(S, {
      AWSBRIDGE_HUMAN_POC_PORTAL_URL: `${BASE}/`,
      AWSBRIDGE_STACK_NAME: "awsbridge",
      AWSBRIDGE_HUMAN_POC_STACK_NAME: "awsbridge-human-poc",
    });
    expect(r.status, r.stderr).toBe(0);
    const d = r.calls.find((c) => c[1] === "cloudformation" && c[2] === "deploy") as string[];
    expect(argOf(d, "--stack-name")).toBe("awsbridge-human-poc-portal");
    expect(argOf(d, "--template-file")).toBe(join(root, PORTAL, "poc-portal.yaml"));
    expect(d).toContain(`IssuerHost=${HOST}`);
    expect(d).toContain("SharedTeams=infra,dev");
    expect(d).toContain("RestrictedTeam=infra");
    expect(d).toContain("CAPABILITY_NAMED_IAM");
    expect(d).toContain("PROFILE=awsbridge");
    expect(d).toContain("REGION=ap-northeast-1");
  });
});

describe("destroy.sh", () => {
  const S = `${PORTAL}/destroy.sh`;
  // Access の Terraform のディレクトリ（state の有無で分ける）。リポジトリの access/ を汚さないよう一時ディレクトリに向ける
  function accessDir(withState: boolean): string {
    const d = tmp("awsbridge-portal-access-");
    if (withState) writeFileSync(join(d, "terraform.tfstate"), "{}");
    return d;
  }
  const env = (access: string, out = tmp("awsbridge-portal-destroy-")) => ({
    AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: out,
    AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_DIR: access,
  });
  it("PoC のポータル用でないスタック名は拒否し、何も呼ばない", () => {
    for (const stack of ["awsbridge", "awsbridge-human-poc"]) {
      const r = runSh(S, { ...env(accessDir(true)), AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME: stack });
      expect(r.status, stack).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });
  it("state を確かめてから、スタック → Worker → Access（Terraform）の順に消し、Worker の secret と Cookie を消す。鍵は残す", () => {
    const out = tmp("awsbridge-portal-destroy-");
    for (const f of ["worker-secrets.json", "access-cookie.txt", "signing-key-std.json"])
      writeFileSync(join(out, f), "x");
    const access = accessDir(true);
    const r = runSh(S, env(access, out));
    expect(r.status, r.stderr).toBe(0);
    const kinds = r.calls.map((c) => `${c[0]} ${c.slice(1, 4).join(" ")}`);
    const idx = (re: RegExp) => kinds.findIndex((k) => re.test(k));
    expect(idx(/^terraform .*state list/)).toBe(0);
    expect(idx(/^aws cloudformation delete-stack/)).toBeGreaterThan(0);
    expect(idx(/^aws cloudformation wait/)).toBeGreaterThan(idx(/delete-stack/));
    expect(idx(/^pnpm exec wrangler delete/)).toBeGreaterThan(idx(/^aws cloudformation wait/));
    expect(idx(/^terraform .*destroy/)).toBeGreaterThan(idx(/wrangler delete/));
    const del = r.calls.find(
      (c) => c[1] === "cloudformation" && c[2] === "delete-stack",
    ) as string[];
    expect(argOf(del, "--stack-name")).toBe("awsbridge-human-poc-portal");
    const wd = r.calls.find((c) => c[0] === "pnpm" && c.includes("delete")) as string[];
    expect(argOf(wd, "--name")).toBe("awsbridge-human-poc-portal");
    expect(argOf(wd, "--config")).toBe(join(root, PORTAL, "wrangler.jsonc"));
    const tf = r.calls.find((c) => c[0] === "terraform" && c.includes("destroy")) as string[];
    expect(tf).toContain(`-chdir=${access}`);
    expect(tf).toContain("-auto-approve");
    expect(existsSync(join(out, "worker-secrets.json"))).toBe(false);
    expect(existsSync(join(out, "access-cookie.txt"))).toBe(false);
    expect(existsSync(join(out, "signing-key-std.json"))).toBe(true);
  });
  it("HOST があれば Terraform の destroy に worker_host を渡し、デプロイ用の wrangler の設定を消し、片付けの確認を案内する", () => {
    const out = tmp("awsbridge-portal-destroy-");
    writeFileSync(join(out, "wrangler.deploy.json"), "{}");
    const r = runSh(S, { ...env(accessDir(true), out), AWSBRIDGE_HUMAN_POC_PORTAL_HOST: HOST });
    expect(r.status, r.stderr).toBe(0);
    const tf = r.calls.find((c) => c[0] === "terraform" && c.includes("destroy")) as string[];
    expect(tf).toContain("-var");
    expect(tf).toContain(`worker_host=${HOST}`);
    expect(existsSync(join(out, "wrangler.deploy.json"))).toBe(false);
    expect(r.stdout + r.stderr).toContain("poc:human:portal:bypass-check -- --after-destroy");
  });
  it("wrangler には CLOUDFLARE_API_TOKEN を渡さず、Terraform には渡す", () => {
    const r = runSh(S, { ...env(accessDir(true)), CLOUDFLARE_API_TOKEN: "cf-token" });
    expect(r.status, r.stderr).toBe(0);
    const wd = r.calls.find((c) => c[0] === "pnpm" && c.includes("delete")) as string[];
    expect(wd).toContain("CFTOKEN=UNSET");
    const tf = r.calls.find((c) => c[0] === "terraform" && c.includes("destroy")) as string[];
    expect(tf).toContain("CFTOKEN=cf-token");
  });
  it("state に Access のアプリ・ポリシー以外があれば、スタックも Worker も消さずに止まる", () => {
    const r = runSh(S, env(accessDir(true)), {
      tfState: "cloudflare_zero_trust_access_application.entry\ncloudflare_dns_record.x\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c[0] === "aws" || c[0] === "pnpm")).toBe(false);
    expect(r.calls.some((c) => c[0] === "terraform" && c.includes("destroy"))).toBe(false);
  });
  it("state のファイルがあるのに読めなければ、何も消さずに止まる", () => {
    const r = runSh(S, env(accessDir(true)), { tfStateFail: true });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c[0] === "aws" || c[0] === "pnpm")).toBe(false);
  });
  it("state のファイルが無ければ Terraform は飛ばし、スタックと Worker は消す", () => {
    const r = runSh(S, env(accessDir(false)));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c[0] === "terraform")).toBe(false);
    expect(r.calls.some((c) => c[2] === "delete-stack")).toBe(true);
  });
  it("Worker の削除が失敗しても（既に無いなど）、Access の削除へ進む", () => {
    const r = runSh(S, env(accessDir(true)), { pnpmExit: 1 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c[0] === "terraform" && c.includes("destroy"))).toBe(true);
    expect(r.stderr).toContain("Worker");
  });
});

describe("deploy.ts", () => {
  const S = `${PORTAL}/deploy.ts`;
  const env = () => ({
    AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: outDir,
    AWSBRIDGE_HUMAN_POC_PORTAL_HOST: HOST,
    AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  });
  it("HOST・チームドメインが未設定なら wrangler を呼ばない", () => {
    for (const k of [
      "AWSBRIDGE_HUMAN_POC_PORTAL_HOST",
      "AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN",
    ]) {
      const { [k as keyof ReturnType<typeof env>]: _, ...rest } = env();
      const r = runTs(S, ["--dry-run"], rest);
      expect(r.status, k).toBe(1);
      expect(r.stderr).toContain(k);
      expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
    }
  });
  it("スタックの Outputs と terraform output から vars を作り、鍵は --secrets-file（権限 600）でだけ渡す", () => {
    const r = runTs(S, ["--dry-run"], env());
    expect(r.status, r.stderr).toBe(0);
    const w = r.calls.find((c) => c[0] === "pnpm") as string[];
    expect(w.slice(1, 4)).toEqual(["exec", "wrangler", "deploy"]);
    // ダミーのホストを HOST に置き換えたデプロイ用の設定（workers.dev・Preview URL は無効のまま）
    const deployConfig = argOf(w, "--config") as string;
    expect(deployConfig).toBe(join(outDir, "wrangler.deploy.json"));
    expect(JSON.parse(readFileSync(deployConfig, "utf8"))).toMatchObject({
      name: "awsbridge-human-poc-portal",
      main: join(root, PORTAL, "worker.ts"),
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: HOST, custom_domain: true }],
    });
    expect(w).toContain("--dry-run");
    const secretsFile = argOf(w, "--secrets-file") as string;
    expect(secretsFile).toBe(join(outDir, "worker-secrets.json"));
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
    expect(Object.keys(secrets).sort()).toEqual(["SIGNING_JWK_ADMIN", "SIGNING_JWK_STD"]);
    const vars = w.filter((_, i) => w[i - 1] === "--var");
    expect(vars).toContain(`PORTAL_BASE:${BASE}`);
    expect(vars).toContain(`ACCESS_TEAM_DOMAIN:${TEAM_DOMAIN}`);
    expect(vars).toContain(
      `ACCESS_AUD_MAP:${JSON.stringify({ ["a".repeat(64)]: "infra", ["b".repeat(64)]: "dev" })}`,
    );
    expect(vars).toContain(`ACCESS_ENTRY_AUD:${"c".repeat(64)}`);
    expect(vars.find((v) => v.startsWith("ROLES:"))).toContain("AwsbridgeHumanPocPortalInfraOnly");
    // 秘密成分（d）は引数に載せない
    expect(w.join(" ")).not.toMatch(/"d":/);
    const tf = r.calls.find((c) => c[0] === "terraform") as string[];
    expect(tf).toContain(`-chdir=${join(root, PORTAL, "access")}`);
  });
  it("wrangler には CLOUDFLARE_API_TOKEN を渡さず、Terraform（output）には渡す", () => {
    const r = runTs(S, ["--dry-run"], { ...env(), CLOUDFLARE_API_TOKEN: "cf-token" });
    expect(r.status, r.stderr).toBe(0);
    const w = r.calls.find((c) => c[0] === "pnpm") as string[];
    expect(w).toContain("CFTOKEN=UNSET");
    const tf = r.calls.find((c) => c[0] === "terraform") as string[];
    expect(tf).toContain("CFTOKEN=cf-token");
  });
  it("スタックがまだ無ければ ROLES は空、Access の state が無ければ AUD の対応は空でデプロイする（初回）", () => {
    const r = runTs(S, ["--dry-run"], env(), { outputs: null, tfOutput: {} });
    expect(r.status, r.stderr).toBe(0);
    const w = r.calls.find((c) => c[0] === "pnpm") as string[];
    const vars = w.filter((_, i) => w[i - 1] === "--var");
    expect(vars).toContain("ROLES:[]");
    expect(vars).toContain("ACCESS_AUD_MAP:{}");
    expect(vars.some((v) => v.startsWith("ACCESS_ENTRY_AUD:"))).toBe(false);
  });
  it("workers.dev の URL（HOST なし）では止める（workers.dev は無効にしたので入口にならない）", () => {
    const { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: _h, ...rest } = env();
    const r = runTs(S, ["--dry-run"], {
      ...rest,
      AWSBRIDGE_HUMAN_POC_PORTAL_URL: WORKERS_DEV_BASE,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AWSBRIDGE_HUMAN_POC_PORTAL_HOST");
    expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
  });
  it("HOST が awsbridge-console-poc.<zone> でも、そのホストの Custom Domain でデプロイする（Worker 名は変えない）", () => {
    const r = runTs(
      S,
      ["--dry-run"],
      { ...env(), AWSBRIDGE_HUMAN_POC_PORTAL_HOST: "awsbridge-console-poc.example.com" },
      {
        tfOutput: { ...TF_OUTPUT, worker_host: { value: "awsbridge-console-poc.example.com" } },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const w = r.calls.find((c) => c[0] === "pnpm") as string[];
    const cfg = JSON.parse(readFileSync(argOf(w, "--config") as string, "utf8"));
    expect(cfg.name).toBe("awsbridge-human-poc-portal");
    expect(cfg.routes).toEqual([
      { pattern: "awsbridge-console-poc.example.com", custom_domain: true },
    ]);
    expect(w.filter((_, i) => w[i - 1] === "--var")).toContain(
      "PORTAL_BASE:https://awsbridge-console-poc.example.com",
    );
  });
  it("PoC 専用の poc-token は --poc-token のときだけ開ける（既定は閉じる）", () => {
    const vars = (args: string[]) => {
      const r = runTs(S, ["--dry-run", ...args], env());
      expect(r.status, r.stderr).toBe(0);
      const w = r.calls.find((c) => c[0] === "pnpm") as string[];
      return w.filter((_, i) => w[i - 1] === "--var");
    };
    expect(vars([]).some((v) => v.startsWith("POC_TOKEN_ENDPOINT"))).toBe(false);
    expect(vars(["--poc-token"])).toContain("POC_TOKEN_ENDPOINT:enabled");
  });
  it("Terraform の worker_host が URL と違えば止める", () => {
    const r = runTs(S, ["--dry-run"], env(), {
      tfOutput: {
        ...TF_OUTPUT,
        worker_host: { value: "awsbridge-human-poc-portal.other.example.com" },
      },
    });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c[0] === "pnpm")).toBe(false);
  });
});

describe("checks.ts（N9）", () => {
  const S = `${PORTAL}/checks.ts`;
  it("URL が未設定・PoC 用でないスタック名・不正な --only なら STS を呼ばない", async () => {
    for (const [env, args] of [
      [{}, []],
      [
        {
          AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE,
          AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME: "awsbridge",
        },
        [],
      ],
      [{ AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE }, ["--only", "99"]],
    ] as [Record<string, string>, string[]][]) {
      const r = runTs(S, args, { AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: outDir, ...env });
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(r.calls.some((c) => c.includes("describe-stacks"))).toBe(false);
    }
  });
  it("ケースごとに鍵・iss・ロール・タグ・SI を変えて STS を呼び、表を出す（擬似 STS）", async () => {
    const seen: URLSearchParams[] = [];
    const sts = await server((_req, body, res) => {
      const f = new URLSearchParams(body);
      seen.push(f);
      if (f.get("RoleArn")?.endsWith("Admin")) {
        res.statusCode = 403;
        res.end(
          "<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>",
        );
        return;
      }
      res.end(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
<Credentials><AccessKeyId>ASIAX</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials>
<SourceIdentity>awsbridge-n9-check</SourceIdentity>
<AssumedRoleUser><Arn>arn:aws:sts::${ACCOUNT}:assumed-role/x/y</Arn><AssumedRoleId>A:x</AssumedRoleId></AssumedRoleUser>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
    });
    try {
      const r = await runTsAsync(S, ["--only", "1,3,6,10"], {
        AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: outDir,
        AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE,
        AWSBRIDGE_HUMAN_POC_PORTAL_STS_ENDPOINT: `${sts.url}/`,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(seen).toHaveLength(4);
      const [c1, c3, c6, c10] = seen as [
        URLSearchParams,
        URLSearchParams,
        URLSearchParams,
        URLSearchParams,
      ];
      expect(c1.get("RoleArn")).toMatch(/PortalShared$/);
      expect(c3.get("RoleArn")).toMatch(/PortalAdmin$/);
      const std = JSON.parse(readFileSync(join(outDir, "signing-key-std.json"), "utf8"));
      const pub = await importJWK({ kty: "RSA", n: std.n, e: std.e }, "RS256");
      const v1 = await jwtVerify(c1.get("WebIdentityToken") ?? "", pub);
      expect(v1.payload.iss).toBe(`${BASE}/std`);
      expect(v1.payload["https://aws.amazon.com/tags"]).toEqual({
        principal_tags: { awsbridge_team: ["infra"] },
      });
      expect((await jwtVerify(c6.get("WebIdentityToken") ?? "", pub)).payload.iss).toBe(
        `${BASE}/std/`,
      );
      expect(
        (await jwtVerify(c10.get("WebIdentityToken") ?? "", pub)).payload[
          "https://aws.amazon.com/source_identity"
        ],
      ).toBeUndefined();
      expect(r.stdout).toMatch(/\| 1 \|.*\| PASS \|/);
      expect(r.stdout).toMatch(/\| 3 \|.*AccessDenied.*\| PASS \|/);
      // 認証情報は出さない。アカウント ID は伏せる
      expect(r.stdout).not.toContain("ASIAX");
      expect(r.stdout).not.toContain(ACCOUNT);
    } finally {
      sts.close();
    }
  });
});

describe("access-revoke.ts（Access のアプリのトークンを失効させる。PoC のアプリだけ）", () => {
  const S = `${PORTAL}/access-revoke.ts`;
  async function withApi(
    appName: string,
    run: (url: string, seen: string[]) => Promise<void>,
    postStatus = 200,
  ) {
    const seen: string[] = [];
    const api = await server((req, _body, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "GET")
        res.end(JSON.stringify({ success: true, result: { id: "id-infra", name: appName } }));
      else {
        res.statusCode = postStatus;
        res.end(JSON.stringify({ success: true, result: null }));
      }
    });
    try {
      await run(api.url, seen);
    } finally {
      api.close();
    }
  }
  const env = (url: string) => ({
    CLOUDFLARE_API_TOKEN: "cf-token",
    AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID: "acc1",
    AWSBRIDGE_HUMAN_POC_PORTAL_CF_API_BASE: url,
  });
  it("Terraform の app_ids でアプリ ID を引き、名前を確かめてから revoke_tokens を呼び、時刻を出す", async () => {
    await withApi("awsbridge-human-poc-portal-infra", async (url, seen) => {
      const r = await runTsAsync(S, ["--app", "awsbridge-human-poc-portal-infra"], env(url));
      expect(r.status, r.stderr).toBe(0);
      expect(seen).toEqual([
        "GET /accounts/acc1/access/apps/id-infra Bearer cf-token",
        "POST /accounts/acc1/access/apps/id-infra/revoke_tokens Bearer cf-token",
      ]);
      expect(r.stdout).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/);
      expect(r.stdout + r.stderr).not.toContain("cf-token");
    });
  });
  it("revoke_tokens の 2xx（202 など）は成功、4xx・5xx は失敗", async () => {
    const app = "awsbridge-human-poc-portal-infra";
    for (const [status, ok] of [
      [200, true],
      [202, true],
      [403, false],
      [500, false],
    ] as const) {
      await withApi(
        app,
        async (url) => {
          const r = await runTsAsync(S, ["--app", app], env(url));
          expect(r.status === 0, `HTTP ${status}: ${r.stderr}`).toBe(ok);
          if (ok) expect(r.stdout).toContain("完了");
          else expect(r.stderr).toContain(String(status));
        },
        status,
      );
    }
  });
  it("PoC のポータルの名前でないアプリ・API の名前が違うアプリは失効させない", async () => {
    await withApi("awsbridge-mcp", async (url, seen) => {
      const r1 = await runTsAsync(S, ["--app", "awsbridge-mcp"], env(url));
      expect(r1.status).not.toBe(0);
      const r2 = await runTsAsync(S, ["--app", "awsbridge-human-poc-portal-infra"], env(url));
      expect(r2.status).not.toBe(0);
      expect(seen.some((s) => s.startsWith("POST"))).toBe(false);
    });
  });
  it("API の宛先の差し替えは 127.0.0.1 だけ", async () => {
    const r = await runTsAsync(S, ["--app", "awsbridge-human-poc-portal-infra"], {
      ...env("https://evil.example.com"),
    });
    expect(r.status).not.toBe(0);
  });
});

describe("access-watch.ts（Cookie で whoami を叩き、拒否とトークンの取り直しの時刻を記録）", () => {
  const S = `${PORTAL}/access-watch.ts`;
  it("記録を書き、要約（最初の失敗・トークンの取り直し）を出す。Cookie はログに出さない", async () => {
    let n = 0;
    const seenCookies: string[] = [];
    const w = await server((req, _body, res) => {
      seenCookies.push(String(req.headers.cookie));
      n++;
      if (n >= 3) {
        res.statusCode = 302;
        res.setHeader(
          "location",
          "https://example-team.cloudflareaccess.com/cdn-cgi/access/login/x",
        );
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ verified: true, team_match: true, aud_team: "infra", iat: 100 + n }),
      );
    });
    const out = tmp("awsbridge-portal-watch-");
    const cookie = join(out, "cookie.txt");
    writeFileSync(cookie, "secret-cookie-token\n", { mode: 0o600 });
    try {
      const r = await runTsAsync(S, ["--team", "infra", "--interval", "0.2", "--max-rounds", "4"], {
        AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: out,
        AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE,
        AWSBRIDGE_HUMAN_POC_PORTAL_COOKIE_FILE: cookie,
        AWSBRIDGE_HUMAN_POC_PORTAL_WATCH_BASE: w.url,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(seenCookies[0]).toBe("CF_Authorization=secret-cookie-token");
      expect(r.stdout).toContain("access_login_redirect");
      expect(r.stdout).toMatch(/iat.*101/s);
      expect(r.stdout + r.stderr).not.toContain("secret-cookie-token");
      const files = spawnSync("ls", [out], { encoding: "utf8" }).stdout;
      const rec = files.split("\n").find((f) => /^access-watch-.*\.jsonl$/.test(f));
      expect(rec).toBeDefined();
      expect(readFileSync(join(out, rec as string), "utf8")).not.toContain("secret-cookie-token");
    } finally {
      w.close();
    }
  });
  it("--summarize は記録を読み直すだけ（HTTP を呼ばない）", () => {
    const out = tmp("awsbridge-portal-watch-");
    const f = join(out, "rec.jsonl");
    writeFileSync(
      f,
      [
        { at: "2026-01-01T00:00:00Z", target: "infra", ok: true, detail: "iat=1 aud_team=infra" },
        { at: "2026-01-01T00:00:10Z", target: "infra", ok: false, code: "access_forbidden" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const r = runTs(S, ["--summarize", f, "--since", "2026-01-01T00:00:05Z"], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("access_forbidden");
    expect(r.stdout).toMatch(/\| 5 \|/);
  });
  it("WATCH_BASE の差し替えは 127.0.0.1 だけ・Cookie のファイルが無ければ止める", () => {
    const out = tmp("awsbridge-portal-watch-");
    const r1 = runTs(S, ["--team", "infra", "--max-rounds", "1"], {
      AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE,
      AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: out,
      AWSBRIDGE_HUMAN_POC_PORTAL_WATCH_BASE: "https://evil.example.com",
    });
    expect(r1.status).not.toBe(0);
    const r2 = runTs(S, ["--team", "infra", "--max-rounds", "1"], {
      AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE,
      AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: out,
    });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("Cookie");
  });
});

describe("keygen.ts の鍵の形", () => {
  it("RSA の秘密鍵 JWK（kid つき）", () => {
    const jwk = JSON.parse(readFileSync(join(outDir, "signing-key-admin.json"), "utf8"));
    expect(jwk.kty).toBe("RSA");
    expect(typeof jwk.d).toBe("string");
    expect(typeof jwk.kid).toBe("string");
  });
});

describe("bypass-check.ts（cto の条件 (2): Access を経由しない入口が閉じているか）", () => {
  const S = `${PORTAL}/bypass-check.ts`;
  const SUB = "secret-sub-x";
  const VERSION = "18f97339-c287-4872-9bdd-e2135c07ec12";
  const AUD_INFRA = "a".repeat(64);
  const domain = (o: Record<string, unknown> = {}) => ({
    id: "d1",
    hostname: HOST,
    service: "awsbridge-human-poc-portal",
    environment: "production",
    zone_id: "zonesecret1",
    zone_name: "example.com",
    enabled: true,
    previews_enabled: false,
    ...o,
  });

  interface ApiState {
    status?: number;
    subdomain?: Record<string, unknown> | null;
    domainsByService?: unknown[];
    domainsByHost?: unknown[];
    routes?: unknown[];
    revoked?: boolean;
  }
  // Cloudflare API の擬似サーバー（読み取りと、access-revoke.ts の失効だけ）
  async function cfApi(st: ApiState) {
    const seen: string[] = [];
    const s = await server((req, _body, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.setHeader("content-type", "application/json");
      const ok = (result: unknown) =>
        res.end(JSON.stringify({ success: true, errors: [], result }));
      const u = new URL(req.url ?? "/", "http://x");
      if (st.status !== undefined) {
        res.statusCode = st.status;
        res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "auth" }] }));
        return;
      }
      if (u.pathname === "/accounts/acc1/workers/scripts/awsbridge-human-poc-portal/subdomain") {
        if (st.subdomain === null) {
          res.statusCode = 404;
          res.end(JSON.stringify({ success: false, errors: [{ code: 10007, message: "nf" }] }));
          return;
        }
        return ok(st.subdomain ?? { enabled: false, previews_enabled: false });
      }
      if (u.pathname === "/accounts/acc1/workers/subdomain") return ok({ subdomain: SUB });
      if (u.pathname === "/accounts/acc1/workers/scripts/awsbridge-human-poc-portal/versions")
        return ok({ items: [{ id: VERSION, number: 2 }] });
      if (u.pathname === "/accounts/acc1/workers/domains") {
        if (u.searchParams.get("service") === "awsbridge-human-poc-portal")
          return ok(st.domainsByService ?? [domain()]);
        if (u.searchParams.get("hostname") === HOST) return ok(st.domainsByHost ?? [domain()]);
        return ok([]);
      }
      if (u.pathname === "/zones/zonesecret1/workers/routes") return ok(st.routes ?? []);
      if (u.pathname === "/accounts/acc1/access/apps/id-infra" && req.method === "GET")
        return ok({ id: "id-infra", name: "awsbridge-human-poc-portal-infra" });
      if (u.pathname === "/accounts/acc1/access/apps/id-infra/revoke_tokens") {
        st.revoked = true;
        res.statusCode = 202;
        return ok(null);
      }
      res.statusCode = 404;
      res.end("{}");
    });
    return { ...s, seen };
  }

  const loginRedirect = (res: ServerResponse) => {
    res.statusCode = 302;
    res.setHeader(
      "location",
      `${TEAM_DOMAIN}/cdn-cgi/access/login/${HOST}?kid=${AUD_INFRA}&redirect_url=%2Ft%2Finfra%2Fwhoami&meta=secret-meta`,
    );
    res.end();
  };
  const whoamiOk = (res: ServerResponse) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ verified: true, team_match: true, aud_team: "infra", iat: 1 }));
  };

  async function run(
    args: string[],
    extra: Record<string, string> = {},
    servers: { api?: string; portal?: string; wdev?: string } = {},
  ) {
    const out = tmp("awsbridge-portal-bypass-");
    return runTsAsync(S, args, {
      AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR: out,
      AWSBRIDGE_HUMAN_POC_PORTAL_HOST: HOST,
      AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      CLOUDFLARE_API_TOKEN: "cf-token-secret",
      AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID: "acc1",
      ...(servers.api ? { AWSBRIDGE_HUMAN_POC_PORTAL_CF_API_BASE: servers.api } : {}),
      ...(servers.portal ? { AWSBRIDGE_HUMAN_POC_PORTAL_BYPASS_PORTAL_BASE: servers.portal } : {}),
      ...(servers.wdev ? { AWSBRIDGE_HUMAN_POC_PORTAL_BYPASS_WORKERS_DEV_BASE: servers.wdev } : {}),
      ...extra,
    });
  }
  const noSecrets = (text: string, extra: string[] = []) => {
    for (const s of [
      HOST,
      SUB,
      VERSION.slice(0, 8),
      "zonesecret1",
      "acc1",
      "cf-token-secret",
      "secret-meta",
      AUD_INFRA,
      ...extra,
    ])
      expect(text, s).not.toContain(s);
  };

  it("B1: workers.dev と Version URL に直接リクエストし、Cloudflare のエラー（1042）なら PASS。ホスト・サブドメインは出さない", async () => {
    const api = await cfApi({});
    const uas: string[] = [];
    const paths: string[] = [];
    const wdev = await server((req, _b, res) => {
      uas.push(String(req.headers["user-agent"]));
      paths.push(String(req.url));
      res.statusCode = 404;
      res.end("error code: 1042");
    });
    try {
      const r = await run(["--case", "B1"], {}, { api: api.url, wdev: wdev.url });
      expect(r.status, r.stderr).toBe(0);
      expect(paths).toEqual(
        expect.arrayContaining(["/std/.well-known/jwks.json", "/t/infra/whoami"]),
      );
      expect(paths.length).toBe(3); // workers.dev の 2 つと Version URL の 1 つ
      expect(uas.every((u) => u.startsWith("awsbridge-poc-bypass-check/"))).toBe(true);
      expect(r.stdout).toMatch(/\| B1-1 \|.*\| 1042 \|.*\| PASS \|/);
      expect(r.stdout).toMatch(/\| B1-3 \|.*Version URL.*\| PASS \|/);
      noSecrets(r.stdout + r.stderr);
    } finally {
      api.close();
      wdev.close();
    }
  });
  it("B1: workers.dev で Worker が応答したら（JWKS が返る）FAIL で終了コード 1", async () => {
    const api = await cfApi({});
    const wdev = await server((_req, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [{ kty: "RSA" }] }));
    });
    try {
      const r = await run(["--case", "B1"], {}, { api: api.url, wdev: wdev.url });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/\| B1-1 \|.*worker_document.*\| FAIL \|/);
    } finally {
      api.close();
      wdev.close();
    }
  });
  it("B2: API でスクリプトの workers.dev・Preview URL・Custom Domain・ゾーンのルートを読み、Custom Domain 1 つだけなら PASS（読み取りだけ）", async () => {
    const api = await cfApi({
      routes: [{ id: "r1", pattern: "other.example.com/*", script: "x" }],
    });
    try {
      const r = await run(["--case", "B2"], {}, { api: api.url });
      expect(r.status, r.stderr).toBe(0);
      const got = api.seen.map((x) => x.split(" ").slice(0, 2).join(" "));
      expect(got).toEqual(
        expect.arrayContaining([
          "GET /accounts/acc1/workers/scripts/awsbridge-human-poc-portal/subdomain",
          "GET /accounts/acc1/workers/domains?service=awsbridge-human-poc-portal",
          `GET /accounts/acc1/workers/domains?hostname=${HOST}`,
          "GET /zones/zonesecret1/workers/routes",
        ]),
      );
      expect(api.seen.every((x) => x.startsWith("GET "))).toBe(true);
      expect(api.seen.every((x) => x.endsWith("Bearer cf-token-secret"))).toBe(true);
      expect(r.stdout).not.toMatch(/\| FAIL \|/);
      expect(r.stdout).toMatch(/workers\.dev.*\| false \| false \| PASS \|/);
      noSecrets(r.stdout + r.stderr);
    } finally {
      api.close();
    }
  });
  it("B2: workers.dev が有効・ルートが残っていれば FAIL", async () => {
    const api = await cfApi({
      subdomain: { enabled: true, previews_enabled: false },
      routes: [{ id: "r2", pattern: `${HOST}/*`, script: "awsbridge-human-poc-portal" }],
    });
    try {
      const r = await run(["--case", "B2"], {}, { api: api.url });
      expect(r.status).toBe(1);
      expect((r.stdout.match(/\| FAIL \|/g) ?? []).length).toBe(2);
    } finally {
      api.close();
    }
  });
  it("B2: トークンの権限が足りなければ（403）必要な権限を出して止まる", async () => {
    const api = await cfApi({ status: 403 });
    try {
      const r = await run(["--case", "B2"], {}, { api: api.url });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Workers Scripts Read");
      expect(r.stderr).toContain("Workers Routes Read");
      noSecrets(r.stdout + r.stderr);
    } finally {
      api.close();
    }
  });
  it("B3: 偽の Cf-Access-Jwt-Assertion（チームドメインの iss・infra の AUD・別の鍵）を Cookie なしで送り、Access のログインへのリダイレクトなら PASS", async () => {
    const seen: { method: string; url: string; jwt: string; cookie: string; origin: string }[] = [];
    const portal = await server((req, _b, res) => {
      seen.push({
        method: String(req.method),
        url: String(req.url),
        jwt: String(req.headers["cf-access-jwt-assertion"]),
        cookie: String(req.headers.cookie),
        origin: String(req.headers.origin),
      });
      loginRedirect(res);
    });
    try {
      const r = await run(["--case", "B3"], {}, { portal: portal.url });
      expect(r.status, r.stderr).toBe(0);
      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        "GET /t/infra/whoami",
        "POST /t/infra/login",
      ]);
      for (const s of seen) {
        expect(s.cookie).toBe("undefined");
        const { decodeJwt } = await import("jose");
        expect(decodeJwt(s.jwt)).toMatchObject({ iss: TEAM_DOMAIN, aud: [AUD_INFRA] });
      }
      expect(seen[1]?.origin).toBe(BASE);
      expect(r.stdout).toMatch(/\| B3-1 \|.*access_login_redirect.*\| PASS \|/);
      expect(r.stdout).toMatch(/\| B3-2 \|.*access_login_redirect.*\| PASS \|/);
      noSecrets(r.stdout + r.stderr, [seen[0]?.jwt ?? "x"]);
    } finally {
      portal.close();
    }
  });
  it("B3: Worker の応答（401 の whoami JSON・HTML のエラーページ）が返れば FAIL", async () => {
    const portal = await server((req, _b, res) => {
      if (req.method === "GET") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ verified: false, error: "JWSSignatureVerificationFailed" }));
      } else {
        res.statusCode = 401;
        res.setHeader("content-type", "text/html");
        res.end("<p>awsbridge PoC（人間のログイン）のポータル。本番ではない。</p>");
      }
    });
    try {
      const r = await run(["--case", "B3"], {}, { portal: portal.url });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/\| B3-1 \|.*worker_json.*\| FAIL \|/);
      expect(r.stdout).toMatch(/\| B3-2 \|.*worker_html.*\| FAIL \|/);
    } finally {
      portal.close();
    }
  });

  async function tokenFile(expSeconds = 3600): Promise<{ file: string; jwt: string }> {
    const { generateKeyPair, SignJWT } = await import("jose");
    const { privateKey } = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ email: "u@example.com" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience([AUD_INFRA])
      .setIssuedAt(now)
      .setExpirationTime(now + expSeconds)
      .sign(privateKey);
    const file = join(tmp("awsbridge-portal-jwt-"), "access-jwt.txt");
    writeFileSync(file, `${jwt}\n`, { mode: 0o600 });
    return { file, jwt };
  }

  it("B4 --revoke: 失効前は Cookie で通り、access-revoke で infra のアプリを失効させ、Cookie・ヘッダーとも Access がログインへ送るまでリトライして時刻を出す。トークンは出さない", async () => {
    const st: ApiState = {};
    const api = await cfApi(st);
    const { file, jwt } = await tokenFile();
    const seen: string[] = [];
    const portal = await server((req, _b, res) => {
      const cookie = String(req.headers.cookie ?? "");
      const viaCookie = cookie === `CF_Authorization=${jwt}`;
      const viaToken = req.headers["cf-access-token"] === jwt;
      const viaHeader = req.headers["cf-access-jwt-assertion"] === jwt;
      seen.push(viaCookie ? "cookie" : viaToken ? "token" : viaHeader ? "header" : "none");
      if ((viaCookie || viaToken) && !st.revoked) return whoamiOk(res);
      loginRedirect(res);
    });
    try {
      const r = await run(
        ["--case", "B4", "--revoke", "--interval", "0.2", "--timeout", "10"],
        { AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE: file },
        { api: api.url, portal: portal.url },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(st.revoked).toBe(true);
      expect(api.seen.filter((x) => x.startsWith("POST"))).toEqual([
        "POST /accounts/acc1/access/apps/id-infra/revoke_tokens Bearer cf-token-secret",
      ]);
      expect(seen).toEqual(expect.arrayContaining(["cookie", "header", "token"]));
      expect(r.stdout).toMatch(/\| B4-1 \|.*Cookie.*worker_json.*\| PASS \|/);
      expect(r.stdout).toMatch(
        /Cookie.*\| \d{4}-\d\d-\d\dT[\d:.]+Z \|.*access_login_redirect.*\| PASS \|/,
      );
      expect(r.stdout).toMatch(/Cf-Access-Jwt-Assertion.*access_login_redirect.*\| PASS \|/);
      noSecrets(r.stdout + r.stderr, [jwt, jwt.split(".")[1] as string]);
    } finally {
      api.close();
      portal.close();
    }
  });
  it("B4 --revoked-at: 判断できない応答（5xx）では止まらず、Access のログインへ送られるまでリトライする", async () => {
    const { file, jwt } = await tokenFile();
    let n = 0;
    const portal = await server((req, _b, res) => {
      const viaCookie = String(req.headers.cookie ?? "") === `CF_Authorization=${jwt}`;
      if (viaCookie) n++;
      // Cookie: 1 回目は 503（判断できない）、2 回目から Access のログインへ
      if (viaCookie && n === 1) {
        res.statusCode = 503;
        res.end("upstream");
        return;
      }
      loginRedirect(res);
    });
    try {
      const r = await run(
        [
          "--case",
          "B4",
          "--revoked-at",
          new Date().toISOString(),
          "--interval",
          "0.2",
          "--timeout",
          "10",
        ],
        { AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE: file },
        { portal: portal.url },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(r.stdout).toMatch(
        /Cookie.*\| \d{4}-\d\d-\d\dT[\d:.]+Z \|.*access_login_redirect.*\| PASS \|/,
      );
    } finally {
      portal.close();
    }
  });
  it("B1: サブドメインを変数で渡しトークンが無ければ、Version URL は未実施（記録）にして API を呼ばない", async () => {
    const wdev = await server((_req, _b, res) => {
      res.statusCode = 404;
      res.end("error code: 1042");
    });
    try {
      const r = await run(
        ["--case", "B1"],
        { AWSBRIDGE_HUMAN_POC_PORTAL_WORKERS_DEV_SUBDOMAIN: SUB, CLOUDFLARE_API_TOKEN: "" },
        { wdev: wdev.url },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/\| B1-1 \|.*\| PASS \|/);
      expect(r.stdout).toMatch(/\| B1-3 \|.*未実施.*\| 記録 \|/);
    } finally {
      wdev.close();
    }
  });
  it("B4: 失効前に Cookie で通らなければ、失効させずに止まる", async () => {
    const st: ApiState = {};
    const api = await cfApi(st);
    const { file } = await tokenFile();
    const portal = await server((_req, _b, res) => loginRedirect(res));
    try {
      const r = await run(
        ["--case", "B4", "--revoke", "--interval", "0.2", "--timeout", "2"],
        { AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE: file },
        { api: api.url, portal: portal.url },
      );
      expect(r.status).toBe(1);
      expect(st.revoked).toBeUndefined();
      expect(api.seen.some((x) => x.startsWith("POST"))).toBe(false);
    } finally {
      api.close();
      portal.close();
    }
  });
  it("B4: トークンのファイルが無い・期限がリトライの時間より短いなら、何も送らずに止まる", async () => {
    const st: ApiState = {};
    const api = await cfApi(st);
    let hits = 0;
    const portal = await server((_req, _b, res) => {
      hits++;
      loginRedirect(res);
    });
    try {
      const r1 = await run(
        ["--case", "B4", "--revoke"],
        { AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE: "/nonexistent/x.txt" },
        { api: api.url, portal: portal.url },
      );
      expect(r1.status).not.toBe(0);
      expect(r1.stderr).toContain("AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE");
      const { file } = await tokenFile(60);
      const r2 = await run(
        ["--case", "B4", "--revoke", "--timeout", "300"],
        { AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE: file },
        { api: api.url, portal: portal.url },
      );
      expect(r2.status).not.toBe(0);
      expect(r2.stderr).toContain("期限");
      expect(hits).toBe(0);
      expect(st.revoked).toBeUndefined();
    } finally {
      api.close();
      portal.close();
    }
  });
  it("--after-destroy: Custom Domain・スクリプトが残っていなければ PASS、残っていれば FAIL", async () => {
    const gone = await cfApi({ subdomain: null, domainsByService: [], domainsByHost: [] });
    const left = await cfApi({});
    try {
      const r1 = await run(["--after-destroy"], {}, { api: gone.url });
      expect(r1.status, r1.stderr).toBe(0);
      expect(r1.stdout).not.toMatch(/\| FAIL \|/);
      const r2 = await run(["--after-destroy"], {}, { api: left.url });
      expect(r2.status).toBe(1);
      noSecrets(r1.stdout + r2.stdout);
    } finally {
      gone.close();
      left.close();
    }
  });
  it("宛先の差し替えは 127.0.0.1 だけ。HOST が無ければ止まる", async () => {
    const r1 = await run(["--case", "B3"], {
      AWSBRIDGE_HUMAN_POC_PORTAL_BYPASS_PORTAL_BASE: "https://evil.example.com",
    });
    expect(r1.status).not.toBe(0);
    const r2 = await run(["--case", "B3"], { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: "" });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("AWSBRIDGE_HUMAN_POC_PORTAL_HOST");
  });
});
