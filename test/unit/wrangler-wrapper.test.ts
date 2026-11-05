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

// 偽 pnpm が受けた引数を 1 行 1 引数で記録する
function run(args: string[], env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "awsbridge-wrangler-"));
  tmpDirs.push(dir);
  const argsFile = join(dir, "args.txt");
  writeFileSync(
    join(dir, "pnpm"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\n`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  const r = spawnSync("bash", [join(root, "scripts/wrangler.sh"), ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  let got: string[] = [];
  try {
    got = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
  } catch {
    // 呼ばれていない
  }
  return { ...r, got };
}

describe("scripts/wrangler.sh", () => {
  it("未設定なら upstream の既定（wrangler.jsonc と --env dev）を使う", () => {
    const r = run(["deploy", "--dry-run"], {});
    expect(r.status).toBe(0);
    expect(r.got).toEqual([
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      "wrangler.jsonc",
      "--env",
      "dev",
    ]);
  });
  it("AWSBRIDGE_WRANGLER_CONFIG を --config に反映する", () => {
    const r = run(["dev"], { AWSBRIDGE_WRANGLER_CONFIG: "wrangler.awsbridge-mcp.jsonc" });
    expect(r.got).toEqual(expect.arrayContaining(["--config", "wrangler.awsbridge-mcp.jsonc"]));
    expect(r.got).not.toContain("wrangler.jsonc");
  });
  it("AWSBRIDGE_WRANGLER_ENV が空文字なら --env を付けない（未設定とは区別する）", () => {
    const r = run(["deploy"], { AWSBRIDGE_WRANGLER_ENV: "" });
    expect(r.got).not.toContain("--env");
    expect(r.got).toEqual(expect.arrayContaining(["--config", "wrangler.jsonc"]));
  });
  it("AWSBRIDGE_WRANGLER_ENV に値があれば --env に渡す", () => {
    const r = run(["deploy"], { AWSBRIDGE_WRANGLER_ENV: "prod" });
    expect(r.got).toEqual(expect.arrayContaining(["--env", "prod"]));
  });
  it("空白や記号を含む引数を壊さずに渡す", () => {
    const r = run(["deploy", "--var", "ISSUER:https://x.example/ a"], {});
    expect(r.got).toContain("ISSUER:https://x.example/ a");
  });
});
