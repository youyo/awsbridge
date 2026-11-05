import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const marketplacePath = ".claude-plugin/marketplace.json";
const pluginPath = "plugins/awsbridge/.claude-plugin/plugin.json";
const skillPath = "plugins/awsbridge/skills/setup-downstream/SKILL.md";

describe("marketplace.json", () => {
  it("JSON として読め、awsbridge プラグインを plugins/awsbridge から配る", () => {
    const m = JSON.parse(read(marketplacePath));
    expect(m.name).toBe("awsbridge");
    expect(typeof m.description).toBe("string");
    expect(m.owner?.name).toBeTruthy();
    expect(m.plugins).toEqual([{ name: "awsbridge", source: "./plugins/awsbridge" }]);
    expect(existsSync(join(root, "plugins/awsbridge"))).toBe(true);
  });
});

describe("plugin.json", () => {
  it("name・version・description を持つ", () => {
    const p = JSON.parse(read(pluginPath));
    expect(p.name).toBe("awsbridge");
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.description.length).toBeGreaterThan(0);
  });
});

describe("setup-downstream の SKILL.md", () => {
  const text = read(skillPath);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  const body = text.slice(text.indexOf("\n---\n", 3) + 5);

  it("frontmatter に name・description・argument-hint・disable-model-invocation がある", () => {
    expect(fm).toMatch(/^name: setup-downstream$/m);
    expect(fm).toMatch(/^description: .+/m);
    expect(fm).toMatch(/^argument-hint: .+/m);
    expect(fm).toMatch(/^disable-model-invocation: true$/m);
  });

  it("本文に出てくる mise run <task> はすべて mise.toml に存在する", () => {
    const toml = read("mise.toml");
    const defined = new Set(
      [...toml.matchAll(/^\[tasks\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm)].map((m) => m[1] ?? m[2]),
    );
    const used = [...body.matchAll(/mise run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const task of used) expect(defined, `mise run ${task}`).toContain(task);
  });

  it("本文が参照する scripts/ と infra/ のパスは実在する", () => {
    const paths = [...body.matchAll(/\b((?:scripts|infra)\/[A-Za-z0-9_./-]+)/g)].map((m) =>
      (m[1] ?? "").replace(/[.,)]+$/, ""),
    );
    for (const p of paths) expect(existsSync(join(root, p)), p).toBe(true);
  });

  it("実在しそうな 12 桁のアカウント ID を含まない（ダミーのみ可）", () => {
    const dummy = /^(\d)\1{11}$|^123456789012$/;
    for (const f of [marketplacePath, pluginPath, skillPath]) {
      for (const m of read(f).matchAll(/(?<!\d)\d{12}(?!\d)/g)) {
        expect(m[0], `${f}: ${m[0]}`).toMatch(dummy);
      }
    }
  });
});
