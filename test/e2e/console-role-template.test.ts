// コンソールログインのロールのテンプレート（種類の StackSet。参考の形）を実際の cfn-lint（mise の [tools] で固定した版）で検査する。
// 参考のテンプレート（infra/aws/console/kind.example.yaml）と、生成器で作ったテンプレート（Standard だけ・Admin あり・
// 割り当てのない種類）を通す。IAM は存在しない Action 名でもポリシーを受け付けるので、壊したコピーで陰性対照を取る。AWS は呼ばない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { templateYaml } from "../../scripts/console/template-yaml";
import { parseConsoleConfig } from "../../src/console/config";
import { buildKindTemplate } from "../../src/console/template";
import { companyConfig, personalConfig } from "../unit/console-fixtures";

const root = new URL("../../", import.meta.url).pathname;
const EXAMPLE = join(root, "infra/aws/console/kind.example.yaml");
const dir = mkdtempSync(join(tmpdir(), "awsbridge-console-kind-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cfnLint(path: string) {
  const r = spawnSync("cfn-lint", [path], { cwd: root, encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function brokenCopy(name: string, from: string, to: string): string {
  const text = readFileSync(EXAMPLE, "utf8");
  expect(text).toContain(from);
  const path = join(dir, name);
  writeFileSync(path, text.replaceAll(from, to));
  return path;
}

describe("ロールのテンプレート（cfn-lint）", () => {
  it("参考のテンプレート kind.example.yaml は警告も誤りもなく通る", () => {
    const r = cfnLint(EXAMPLE);
    expect(r.out).toBe("");
    expect(r.status).toBe(0);
  });

  it("生成したテンプレート（会社用の全種類・個人用）も警告も誤りもなく通る", () => {
    const cases: [string, unknown, string][] = [
      ["company-A", companyConfig(), "A"],
      ["company-C", companyConfig(), "C"],
      ["company-P", companyConfig(), "P"],
      ["personal", personalConfig(), "default"],
    ];
    for (const [name, raw, kind] of cases) {
      const path = join(dir, `${name}.yaml`);
      writeFileSync(path, templateYaml(buildKindTemplate(parseConsoleConfig(raw).config, kind)));
      const r = cfnLint(path);
      expect(r.out, name).toBe("");
      expect(r.status, name).toBe(0);
    }
  });

  it("陰性対照: aws login の Allow の Action の綴りを誤ると落ちる", () => {
    const r = cfnLint(
      brokenCopy("bad-signin.yaml", "signin:CreateOAuth2Token", "signin:CreateOAuth2Tokn"),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("W3037");
  });

  it("陰性対照: 秘密値の Deny の Action の綴りを誤ると落ちる", () => {
    const r = cfnLint(
      brokenCopy(
        "bad-secret.yaml",
        "secretsmanager:GetSecretValue",
        "secretsmanager:GetSecretValu",
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("W3037");
  });
});
