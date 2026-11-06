import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProfilesConfig, profileNames } from "../../src/profiles";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url).pathname, "utf8");
// wrangler.jsonc は行頭コメントだけなので、それを除けば JSON として読める
const wrangler = JSON.parse(
  read("wrangler.jsonc")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n"),
);

describe("プロファイル一覧のバンドル（alias）", () => {
  it("wrangler.jsonc の alias は awsbridge:profiles を gitignore された config/profiles.json に向ける", () => {
    expect(wrangler.alias).toEqual({ "awsbridge:profiles": "./config/profiles.json" });
    expect(read(".gitignore").split("\n")).toContain("config/profiles.json");
  });

  it("src/index.ts だけが awsbridge:profiles を import し、handler には注入する", () => {
    expect(read("src/index.ts")).toMatch(/from "awsbridge:profiles"/);
    for (const f of ["src/handler.ts", "src/profiles.ts"]) {
      expect(read(f), f).not.toContain('awsbridge:profiles"');
    }
  });

  it("config/profiles.example.json は検証を通り、ダミーのアカウント ID だけを持つ", () => {
    const raw = read("config/profiles.example.json");
    const config = parseProfilesConfig(JSON.parse(raw));
    expect(profileNames(config).length).toBeGreaterThan(1);
    const ids = new Set([...raw.matchAll(/iam::(\d{12}):/g)].map((m) => m[1]));
    expect([...ids].sort()).toEqual(["111111111111", "222222222222"]);
  });

  it("AWS_PROFILES は Env にも wrangler.jsonc の vars にも無い（環境変数は 5 KB 上限）", () => {
    expect(read("src/handler.ts")).not.toContain("AWS_PROFILES");
    expect(wrangler.vars?.AWS_PROFILES).toBeUndefined();
  });
});
