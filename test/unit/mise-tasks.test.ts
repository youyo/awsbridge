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
