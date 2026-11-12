import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const toml = readFileSync(new URL("../../mise.toml", import.meta.url).pathname, "utf8");

function section(name: string): string {
  const start = toml.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = toml.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("mise.toml のデプロイタスク", () => {
  it("統合タスク deploy は存在しない", () => {
    expect(toml).not.toMatch(/^\[tasks\.deploy\]/m);
  });
  it("deploy:worker は wrangler deploy → secrets の順で、aws を呼ばない", () => {
    const s = section('tasks."deploy:worker"');
    expect(s).toContain("wrangler.sh deploy");
    expect(s).toContain("mise run secrets");
    expect(s.indexOf("wrangler.sh deploy")).toBeLessThan(s.indexOf("mise run secrets"));
    expect(s).not.toMatch(/\baws\b|deploy:aws/);
  });
  it("secrets は単独タスクとして残る", () => {
    expect(section("tasks.secrets")).toContain("scripts/put-secrets.sh");
  });
  it("プロファイル一覧は secret にしない（secrets の説明と mise.toml に AWS_PROFILES / AWSBRIDGE_PROFILES が無い）", () => {
    expect(section("tasks.secrets")).not.toContain("AWS_PROFILES");
    expect(toml).not.toMatch(/AWS_PROFILES|AWSBRIDGE_PROFILES/);
  });
  it("鍵ローテーションのタスク（key:prepare / key:activate / key:retire）は scripts/key-rotate.ts を呼び、wrangler・aws を呼ばない", () => {
    for (const cmd of ["prepare", "activate", "retire"]) {
      const run = /^run\s*=.*$/m.exec(section(`tasks."key:${cmd}"`))?.[0] ?? "";
      expect(run, cmd).toContain(`scripts/key-rotate.ts ${cmd}`);
      expect(run, cmd).not.toMatch(/wrangler|\baws\b|secrets/);
    }
  });
  it("deploy:aws / destroy:aws は Cloudflare を呼ばない", () => {
    for (const n of ['tasks."deploy:aws"', 'tasks."destroy:aws"']) {
      expect(section(n)).not.toMatch(/wrangler|deploy:worker|secrets/);
    }
  });
  it("上書きされうる既定値は [env] に置かない（下流の mise 設定ファイルが負けないように）", () => {
    const env = section("env");
    for (const n of [
      "AWS_PROFILE",
      "AWSBRIDGE_AUDIENCE",
      "AWSBRIDGE_ROLE_NAME",
      "AWSBRIDGE_STACK_NAME",
      "AWSBRIDGE_KEY_FILE",
      "AWSBRIDGE_WRANGLER_ENV",
      "AWSBRIDGE_WRANGLER_CONFIG",
    ]) {
      expect(env, n).not.toMatch(new RegExp(`^${n}\\s*=`, "m"));
    }
  });
  it("wrangler は scripts/wrangler.sh 経由で呼び、直接 `--env` を書かない", () => {
    for (const n of ["tasks.build", "tasks.dev", 'tasks."deploy:worker"']) {
      const s = section(n);
      expect(s).toContain("scripts/wrangler.sh");
      expect(s).not.toMatch(/pnpm wrangler|--env/);
    }
    expect(
      readFileSync(new URL("../../scripts/wrangler.sh", import.meta.url).pathname, "utf8"),
    ).toMatch(/--config "\$\{AWSBRIDGE_WRANGLER_CONFIG:-wrangler\.jsonc\}"/);
  });
});

describe("mise.toml: コンソールログインの Admin の署名鍵（X1 の決裁）", () => {
  it("console:admin-key:put / retire / check は scripts/console/admin-key.ts を呼び、--yes を既定で付けない。wrangler deploy・aws を呼ばない", () => {
    for (const cmd of ["put", "retire", "check"]) {
      const sec = section(`tasks."console:admin-key:${cmd}"`);
      const run = /^run\s*=.*$/m.exec(sec)?.[0] ?? "";
      expect(run, cmd).toContain(`scripts/console/admin-key.ts ${cmd}`);
      expect(run, cmd).not.toMatch(/--yes|wrangler|\baws\b|deploy/);
    }
  });
  it("鍵の道具の変数（トークン・アカウント ID）を [env] に置かない", () => {
    expect(section("env")).not.toMatch(/^AWSBRIDGE_CONSOLE_ADMIN_/m);
  });
  it("秘密の検査（secrets:scan）は gitleaks で作業ツリー（未コミットを含む）を見る。gitleaks の版を固定する", () => {
    const run = /^run\s*=.*$/m.exec(section('tasks."secrets:scan"'))?.[0] ?? "";
    expect(run).toContain("scripts/secrets-scan.sh");
    const script = readFileSync(
      new URL("../../scripts/secrets-scan.sh", import.meta.url).pathname,
      "utf8",
    );
    expect(script).toContain("gitleaks git");
    expect(script).toContain("gitleaks dir");
    expect(script).toContain("git ls-files -co --exclude-standard");
    expect(script).toContain("--redact");
    expect(section("tools")).toMatch(/^gitleaks\s*=\s*"\d+\.\d+\.\d+"/m);
  });
});

describe("mise.toml: コンソールログインの Standard の署名鍵（cto の決裁「Standard も secret_key に揃える」）", () => {
  it("console:standard-key:put / retire / check は scripts/console/standard-key.ts を呼び、--yes を既定で付けない。wrangler deploy・aws を呼ばない", () => {
    for (const cmd of ["put", "retire", "check"]) {
      const sec = section(`tasks."console:standard-key:${cmd}"`);
      const run = /^run\s*=.*$/m.exec(sec)?.[0] ?? "";
      expect(run, cmd).toContain(`scripts/console/standard-key.ts ${cmd}`);
      expect(run, cmd).not.toMatch(/--yes|wrangler|\baws\b|deploy/);
    }
  });
  it("console:secrets:standard は CSRF の鍵だけを入れる道具（scripts/console/secrets.ts）で、--yes を既定で付けない", () => {
    const sec = section('tasks."console:secrets:standard"');
    const run = /^run\s*=.*$/m.exec(sec)?.[0] ?? "";
    expect(run).toContain("scripts/console/secrets.ts");
    expect(run).not.toMatch(/--yes|wrangler|\baws\b|deploy/);
    expect(sec).toContain("CONSOLE_CSRF_KEY");
  });
  it("文字列の秘密鍵を作る console:keygen は無い。鍵の道具の変数（トークン・アカウント ID）を [env] に置かない", () => {
    expect(toml).not.toMatch(/^\[tasks\."console:keygen"\]/m);
    expect(section("env")).not.toMatch(/^AWSBRIDGE_CONSOLE_STANDARD_/m);
  });
});

describe("mise.toml のコンソールログインの運用タスク（ビルドと手元の起動。PR11 から）", () => {
  it("console:build:standard / console:dev がある", () => {
    for (const n of ["build:standard", "dev"]) {
      expect(section(`tasks."console:${n}"`), n).not.toBe("");
    }
  });
  it("console:build:standard は wrangler deploy --dry-run をコンソール用の設定で呼び、デプロイしない", () => {
    const s = section('tasks."console:build:standard"');
    expect(s).toContain("scripts/wrangler.sh");
    expect(s).toContain("deploy --dry-run");
    expect(s).toContain("wrangler.console-standard.jsonc");
  });
  it("console:dev は wrangler dev をコンソール用の設定で呼ぶ", () => {
    const s = section('tasks."console:dev"');
    expect(s).toContain("scripts/wrangler.sh dev");
    expect(s).toContain("wrangler.console-standard.jsonc");
  });
  it("Standard の wrangler の設定の変数は AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG の 1 つだけ（旧名 AWSBRIDGE_CONSOLE_WRANGLER_CONFIG を読まない）", () => {
    for (const n of ["build:standard", "dev"])
      expect(section(`tasks."console:${n}"`), n).toContain(
        "${AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG:-wrangler.console-standard.jsonc}",
      );
    expect(toml).not.toContain("AWSBRIDGE_CONSOLE_WRANGLER_CONFIG");
  });
  it("コンソール用のタスクは MCP 用の AWSBRIDGE_WRANGLER_CONFIG / ENV に左右されない", () => {
    for (const n of ["build:standard", "dev"]) {
      const s = section(`tasks."console:${n}"`);
      expect(s, n).toMatch(/AWSBRIDGE_WRANGLER_CONFIG=/);
      expect(s, n).toMatch(/AWSBRIDGE_WRANGLER_ENV=(\s|")/);
    }
  });
});

// 下流の想定: upstream の mise.toml と、下流が足すファイル（mise.<env>.toml + .miserc.toml）を共存させる
describe("下流の mise 設定ファイルの上書き", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awsbridge-mise-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, "mise.toml"), toml.replace(/^\[tools\][\s\S]*?(?=^\[env\])/m, ""));
  writeFileSync(
    join(tmp, "mise.awsbridge-mcp.toml"),
    '[env]\nAWSBRIDGE_STACK_NAME = "stack-down"\nAWSBRIDGE_WRANGLER_ENV = ""\nAWSBRIDGE_WRANGLER_CONFIG = "wrangler.awsbridge-mcp.jsonc"\n',
  );
  writeFileSync(join(tmp, ".miserc.toml"), 'env = ["awsbridge-mcp"]\n');
  const { MISE_ENV: _ignored, ...parentEnv } = process.env;
  const out = spawnSync("mise", ["env", "--json"], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...parentEnv, MISE_TRUSTED_CONFIG_PATHS: tmp },
  });
  const vars = out.status === 0 ? (JSON.parse(out.stdout) as Record<string, string>) : {};
  it("mise env が成功する", () => {
    expect(out.status, out.stderr).toBe(0);
  });
  it("下流ファイルの値が効き、空文字も空のまま渡る", () => {
    expect(vars.AWSBRIDGE_STACK_NAME).toBe("stack-down");
    expect(vars.AWSBRIDGE_WRANGLER_CONFIG).toBe("wrangler.awsbridge-mcp.jsonc");
    expect(vars.AWSBRIDGE_WRANGLER_ENV).toBe("");
  });
});
