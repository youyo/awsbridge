// G2 の実測の道具（scripts/poc/g2/）の置き場所: mise タスク、本体（src/）・本番のバンドルとの分離、試験用の issuer の Worker の設定。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { importGraph } from "./import-graph";

const root = new URL("../../", import.meta.url).pathname;
const toml = readFileSync(join(root, "mise.toml"), "utf8");

function section(name: string): string {
  const start = toml.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = toml.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("mise タスク poc:g2:*", () => {
  const tasks: [string, string][] = [
    ["probe:keygen", "scripts/poc/g2/probe.ts keygen"],
    ["probe:keys", "scripts/poc/g2/probe.ts keys"],
    ["probe:deploy", "scripts/poc/g2/probe.ts deploy"],
    ["probe:check", "scripts/poc/g2/probe.ts check"],
    ["probe:watch", "scripts/poc/g2/probe.ts watch"],
    ["probe:forget", "scripts/poc/g2/probe.ts forget"],
    ["issue-watch", "scripts/poc/g2/issue-watch.ts"],
    ["session-watch", "scripts/poc/g2/session-watch.ts"],
    ["time-gap", "scripts/poc/g2/time-gap.ts"],
    ["clean-check", "scripts/poc/g2/clean-check.ts"],
  ];
  it.each(tasks)(
    "poc:g2:%s は %s を呼ぶ（本体の wrangler.sh・deploy-aws.sh を使わない）",
    (name, script) => {
      const s = section(`tasks."poc:g2:${name}"`);
      expect(s).toContain(`pnpm tsx ${script}`);
      expect(s).not.toMatch(/scripts\/wrangler\.sh|scripts\/deploy-aws\.sh/);
    },
  );

  it("G2 の道具の既定値を [env] に置かない", () => {
    expect(section("env")).not.toMatch(/^AWSBRIDGE_G2_/m);
  });
});

describe("本体・本番のバンドルとの分離", () => {
  const g2 = (files: string[]) =>
    files.map((f) => relative(root, f)).filter((f) => f.startsWith("scripts/poc/g2/"));

  it("MCP 用の Worker（src/index.ts）とコンソールの Worker のエントリから scripts/poc/g2/ に届かない", () => {
    const entries = ["src/index.ts"];
    for (const f of readdirSync(root))
      if (/^wrangler.*\.jsonc$/.test(f)) {
        const main = /"main"\s*:\s*"([^"]+)"/.exec(readFileSync(join(root, f), "utf8"))?.[1];
        if (main) entries.push(main);
      }
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const e of entries) expect(g2(importGraph(join(root, e)).files), e).toEqual([]);
  });

  it("src/ のどのファイルも scripts/poc/g2/ を import しない", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : e.name.endsWith(".ts")
            ? [`${dir}/${e.name}`]
            : [],
      );
    for (const f of walk("src"))
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/poc\/g2/);
  });

  it("試験用の issuer の Worker は手元の道具（署名・鍵・node の API）を取り込まない", () => {
    const g = importGraph(join(root, "scripts/poc/g2/probe-worker.ts"));
    const files = g.files.map((f) => relative(root, f));
    expect(files).toContain("scripts/poc/g2/probe-handler.ts");
    for (const f of ["scripts/poc/g2/probe-lib.ts", "scripts/poc/g2/common.ts", "src/keys.ts"])
      expect(files).not.toContain(f);
    expect(g.bare.filter((b) => b.startsWith("node:"))).toEqual([]);
  });
});

describe("scripts/poc/g2/wrangler.jsonc（試験用の issuer の Worker のテンプレート）", () => {
  const cfg = JSON.parse(
    readFileSync(join(root, "scripts/poc/g2/wrangler.jsonc"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  it("workers.dev と Preview URL は無効、routes・vars・env の実値を置かない", () => {
    expect(cfg.name).toBe("awsbridge-g2-probe");
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    expect(cfg.routes).toBeUndefined();
    expect(cfg.vars).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });
});
