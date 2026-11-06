import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const skillPath = ".claude/skills/setup-downstream/SKILL.md";

describe("setup-downstream の SKILL.md", () => {
  it("プロジェクトスキルとして .claude/skills/ に置く（プラグイン定義は持たない）", () => {
    expect(existsSync(join(root, skillPath))).toBe(true);
    expect(existsSync(join(root, ".claude-plugin"))).toBe(false);
    expect(existsSync(join(root, "plugins"))).toBe(false);
  });

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

  it("プロファイル一覧は alias で deploy/profiles.json に向ける手順で、廃止した AWS_PROFILES / AWSBRIDGE_PROFILES を書かせない", () => {
    expect(body).toContain("awsbridge:profiles");
    expect(body).toContain("deploy/profiles.json");
    expect(body).not.toContain("vars.AWS_PROFILES");
    expect(body).not.toMatch(/AWSBRIDGE_PROFILES[^`]*を(設定|書)/);
  });

  it("実在しそうな 12 桁のアカウント ID を含まない（ダミーのみ可）", () => {
    const dummy = /^(\d)\1{11}$|^123456789012$/;
    for (const f of [skillPath]) {
      for (const m of read(f).matchAll(/(?<!\d)\d{12}(?!\d)/g)) {
        expect(m[0], `${f}: ${m[0]}`).toMatch(dummy);
      }
    }
  });
});
