import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// issuer の URL のパスは /console（P2（B）の設計メモ §3.1。cto の決裁 2026-11-17。それまでは /standard、その前は /std）。
// issuer は境界ごとに 1 つで、Standard と Admin の階層で同じ。ロールの IAM パスの階層名 std（/awsbridge-console/std/）・
// admin（/awsbridge-console/admin/）は別物で、変えない。

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// issuer の URL・OIDC プロバイダーの ARN・<issuer-host> の直後のパスが std
const STD_ISSUER_PATH =
  /(?:https?:\/\/[^\s`"')]+|oidc-provider\/[^\s`"')]+|<issuer-host>|<issuer-host-std>)\/(?:p\/[a-z0-9<>-]+\/)?std(?![a-z0-9-])/;

// issuer の URL・OIDC プロバイダーの ARN・<issuer-host> の直後のパスが standard（P2 より前の既定）
const OLD_ISSUER_PATH =
  /(?:https?:\/\/[^\s`"')]+|oidc-provider\/[^\s`"')]+|<issuer-host>)\/(?:p\/[a-z0-9<>-]+\/)?standard(?![a-z0-9-])/;

describe("issuer のパスは /console（P2）", () => {
  it("設定の例: 境界の issuer のパスは /console か /p/<id>/console", () => {
    for (const f of ["config/console.example.json", "config/console.company.example.json"]) {
      const urls = [...read(f).matchAll(/"issuer":\s*"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
      expect(urls.length, f).toBeGreaterThan(0);
      for (const u of urls) {
        expect(new URL(u as string).pathname, f).toMatch(/^\/(p\/[a-z0-9]{2,16}\/)?console$/);
      }
    }
  });

  it("README の日英: IssuerPath の既定は console", () => {
    for (const f of ["README.md", "README_ja.md"])
      expect(read(f), f).toMatch(/\| `IssuerPath` \| `console` \|/);
  });

  it("必須のスタックと参考のロールのテンプレート（生成物）の IssuerPath の既定は console", () => {
    for (const f of ["infra/aws/console/base.yaml", "infra/aws/console/kind.example.yaml"])
      expect(read(f), f).toMatch(/IssuerPath:\n\s+Type: String\n\s+Default: console\n/);
  });

  it("設定の例・README・基盤のテンプレート・Worker の設定・ソースに、issuer の URL として旧い /standard を書かない（設計書は履歴なので見ない）", () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "--",
        "config",
        "infra",
        "src",
        "README.md",
        "README_ja.md",
        "wrangler.console.jsonc",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files)
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (OLD_ISSUER_PATH.test(line)) hits.push(`${f}:${i + 1}`);
        });
    expect(hits).toEqual([]);
  });

  it("設計書・設定の例・README・基盤のテンプレート・Worker の設定に、issuer の URL として /std を書かない（PoC の測定値は「PoC のパス」と断る）", () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "--",
        "docs/specs",
        "config",
        "infra",
        "src",
        "README.md",
        "README_ja.md",
        "wrangler.console.jsonc",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (STD_ISSUER_PATH.test(line) && !line.includes("PoC のパス"))
            hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("ロールの IAM パスの階層名 std は変えない（/awsbridge-console/std/）", () => {
    expect(read("src/console/constants.ts")).toContain('standard: "std"');
  });
});
