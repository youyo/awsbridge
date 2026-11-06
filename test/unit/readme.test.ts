import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const path = (p: string) => join(root, p);
const read = (p: string) => readFileSync(path(p), "utf8");
const head = (p: string) => read(p).split("\n").slice(0, 6).join("\n");

// コードブロック内の `#` 行（シェルのコメントなど）を除いた見出し行を返す
const headings = (p: string): string[] => {
  let inFence = false;
  const out: string[] = [];
  for (const line of read(p).split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,6}\s/.test(line)) out.push(line);
  }
  return out;
};
const levels = (p: string) => headings(p).map((h) => /^#+/.exec(h)?.[0].length);

describe("README の 2 言語化", () => {
  it("README.md（英語）と README_ja.md（日本語）が両方ある", () => {
    expect(existsSync(path("README.md"))).toBe(true);
    expect(existsSync(path("README_ja.md"))).toBe(true);
  });

  it("先頭付近に互いへの切替リンクがある", () => {
    expect(head("README.md")).toContain("](README_ja.md)");
    expect(head("README_ja.md")).toContain("](README.md)");
  });

  it("README_ja.md が日本語、README.md が英語で書かれている", () => {
    expect(read("README_ja.md")).toMatch(/[぀-ヿ]/);
    expect(read("README.md")).not.toMatch(/[぀-ヿ]/);
  });

  it("見出しの数とレベルの並びが一致する", () => {
    expect(headings("README.md").length).toBeGreaterThan(0);
    expect(levels("README.md")).toEqual(levels("README_ja.md"));
  });

  it("コードブロックの数が一致する", () => {
    const fences = (p: string) => (read(p).match(/^```/gm) ?? []).length;
    expect(fences("README.md")).toBe(fences("README_ja.md"));
  });
});

describe("README のプロファイル一覧（alias でバンドル）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: example のコピー手順・alias・移行時の secret delete を載せ、AWSBRIDGE_PROFILES を設定例に残さない`, () => {
      const text = read(f);
      expect(text).toContain("cp config/profiles.example.json config/profiles.json");
      expect(text).toContain("awsbridge:profiles");
      expect(text).toContain("secret delete AWS_PROFILES");
      // 設定例（mise.local.toml のコードブロック）に AWSBRIDGE_PROFILES = ... が無い
      expect(text).not.toMatch(/^AWSBRIDGE_PROFILES\s*=/m);
      // 下流の wrangler 設定例が vars.AWS_PROFILES を使っていない
      expect(text).not.toMatch(/"AWS_PROFILES"\s*:/);
    });
  }
});
