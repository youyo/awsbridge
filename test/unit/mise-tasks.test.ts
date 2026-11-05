import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(s).toContain("wrangler deploy");
    expect(s).toContain("mise run secrets");
    expect(s.indexOf("wrangler deploy")).toBeLessThan(s.indexOf("mise run secrets"));
    expect(s).not.toMatch(/\baws\b|deploy:aws/);
  });
  it("secrets は単独タスクとして残る", () => {
    expect(section("tasks.secrets")).toContain("scripts/put-secrets.sh");
  });
  it("deploy:aws / destroy:aws は Cloudflare を呼ばない", () => {
    for (const n of ['tasks."deploy:aws"', 'tasks."destroy:aws"']) {
      expect(section(n)).not.toMatch(/wrangler|deploy:worker|secrets/);
    }
  });
  it("AWS_PROFILE は固定せず呼び出し側の値を優先する", () => {
    expect(toml).not.toMatch(/^AWS_PROFILE\s*=\s*"awsbridge"/m);
    expect(toml).toMatch(
      /^AWS_PROFILE\s*=\s*'\{\{\s*get_env\(name="AWS_PROFILE", default="awsbridge"\)\s*\}\}'/m,
    );
  });
});
