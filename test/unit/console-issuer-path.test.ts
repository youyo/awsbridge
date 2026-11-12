import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Standard の issuer の URL のパスは /standard（利用者の判断 2026-11-13。それまでは /std）。
// ロールの IAM パスの階層名 std（/awsbridge-console/std/）と、Admin の /admin は別物で、変えない。

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// issuer の URL・OIDC プロバイダーの ARN・<issuer-host> の直後のパスが std
const STD_ISSUER_PATH =
  /(?:https?:\/\/[^\s`"')]+|oidc-provider\/[^\s`"')]+|<issuer-host>|<issuer-host-std>)\/(?:p\/[a-z0-9<>-]+\/)?std(?![a-z0-9-])/;

describe("Standard の issuer のパスは /standard", () => {
  it("設定の例: Standard の issuer のパスは /standard か /p/<id>/standard", () => {
    for (const f of ["config/console.example.json", "config/console.company.example.json"]) {
      const urls = [...read(f).matchAll(/"standard":\s*"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
      expect(urls.length, f).toBeGreaterThan(0);
      for (const u of urls) {
        expect(new URL(u as string).pathname, f).toMatch(/^\/(p\/[a-z0-9]{2,16}\/)?standard$/);
      }
    }
  });

  it("README の日英: StandardPath の既定は standard", () => {
    for (const f of ["README.md", "README_ja.md"])
      expect(read(f), f).toMatch(/\| `StandardPath` \| `standard` \|/);
  });

  it("参考のロールのテンプレート（生成物）の StandardPath の既定は standard", () => {
    expect(read("infra/aws/console/kind.example.yaml")).toMatch(
      /StandardPath:\n\s+Type: String\n\s+Default: standard\n/,
    );
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
        "wrangler.console-standard.jsonc",
        "wrangler.console-admin.jsonc",
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
