// コンソールログイン用の Access の Terraform の参考の例（infra/cloudflare/console/）の形。apply は検証しない（例）。
// 入口とチームのアプリの Cookie Path を true に固定すること（R-P の要件。docs/specs/console-login.md §5.4）、MCP 用の
// infra/cloudflare と分けること、lint の対象に入ること、実値を書かないことを、ファイルの内容で確かめる。
// fmt・validate・tflint は mise run lint（infra/cloudflare/check.sh）が流す。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const dir = join(root, "infra/cloudflare/console");
const read = (p: string) => readFileSync(join(dir, p), "utf8");
const tfFiles = () => readdirSync(dir).filter((f) => f.endsWith(".tf") || f.endsWith(".example"));

/** resource "<type>" "<name>" { … } の本体（波括弧の対応で切り出す）。 */
function resourceBody(src: string, type: string, name: string): string {
  const start = src.indexOf(`resource "${type}" "${name}"`);
  expect(start, `${type}.${name}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

describe("infra/cloudflare/console/（Access の Terraform の例）", () => {
  const main = () => read("main.tf");
  const APP = "cloudflare_zero_trust_access_application";

  it.each(["entry", "team"])(
    "%s のアプリは Cookie Path を true に固定する（変数にしない）",
    (name) => {
      const body = resourceBody(main(), APP, name);
      expect(body).toMatch(/^\s*path_cookie_attribute\s*=\s*true\s*$/m);
      expect(body).toMatch(/^\s*enable_binding_cookie\s*=\s*true\s*$/m);
      expect(body).toMatch(/^\s*same_site_cookie_attribute\s*=\s*"lax"\s*$/m);
      expect(body).toMatch(/^\s*type\s*=\s*"self_hosted"\s*$/m);
    },
  );

  it.each(["entry", "team"])(
    "%s のアプリは、適用後の値が true でなければ失敗する（postcondition）",
    (name) => {
      const body = resourceBody(main(), APP, name);
      expect(body).toMatch(/postcondition\s*{[^}]*self\.path_cookie_attribute\s*==\s*true/);
    },
  );

  it("path_cookie_attribute を変数にしない（無効にできる入口を作らない）", () => {
    expect(read("variables.tf")).not.toMatch(/path_cookie/);
  });

  it("チームのアプリは for_each で作り、対象は <host>/t/<チーム>。入口はホスト全体", () => {
    const team = resourceBody(main(), APP, "team");
    expect(team).toContain("for_each");
    expect(team).toMatch(/\/t\/\$\{each\.key\}/);
    const entry = resourceBody(main(), APP, "entry");
    expect(entry).toContain("for_each");
    expect(entry).not.toMatch(/\/t\//);
  });

  it("出力は AWSBRIDGE_CONSOLE_AUD_FILE の形（teams と entry）で、sensitive", () => {
    const out = read("outputs.tf");
    expect(out).toMatch(/output "console_aud"/);
    expect(out).toMatch(/sensitive\s*=\s*true/);
    expect(out).toMatch(/\bteams\b/);
    expect(out).toMatch(/\bentry\b/);
  });

  it("実在の値を書かない（ドキュメント用のドメイン・全部 0 の ID だけ）", () => {
    for (const f of tfFiles()) {
      const text = read(f);
      for (const m of text.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|dev|io|jp)\b/g))
        expect(m[0], `${f}: ${m[0]}`).toMatch(
          /(^|\.)example\.(com|org)$|^registry\.terraform\.io$|^developers\.cloudflare\.com$/,
        );
      expect(text, f).not.toMatch(/\b[0-9a-f]{32}\b(?<!0{32})/);
      expect(text, f).not.toMatch(/@(?!example\.)[\w-]+\./);
    }
  });

  it("MCP 用の infra/cloudflare は、コンソール用のリソースを持たない（別ディレクトリ・別 state）", () => {
    const upstream = readFileSync(join(root, "infra/cloudflare/main.tf"), "utf8");
    expect(upstream).not.toMatch(/path_cookie_attribute/);
    expect(read("versions.tf")).toContain("required_providers");
  });

  it("lint の Terraform の検査（infra/cloudflare/check.sh）の対象に入る", () => {
    const check = readFileSync(join(root, "infra/cloudflare/check.sh"), "utf8");
    expect(check).toContain("console");
    expect(check).toMatch(/terraform .*validate/);
    expect(check).toMatch(/tflint/);
  });
});
