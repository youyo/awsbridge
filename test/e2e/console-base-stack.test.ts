// コンソールログインの必須のスタック（infra/aws/console/base.yaml）を実際の cfn-lint（mise の [tools] で固定した版）で検査する。
// IAM は存在しない Action 名でもポリシーを受け付ける（綴りの誤りは Deny が黙って効かなくなる）ので、
// cfn-lint が未知の Action を誤りにすることを、壊したコピーで陰性対照として確かめる。AWS は呼ばない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const BASE = join(root, "infra/aws/console/base.yaml");
const dir = mkdtempSync(join(tmpdir(), "awsbridge-console-base-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cfnLint(path: string) {
  const r = spawnSync("cfn-lint", [path], { cwd: root, encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function brokenCopy(name: string, from: string, to: string): string {
  const text = readFileSync(BASE, "utf8");
  expect(text).toContain(from);
  const path = join(dir, name);
  writeFileSync(path, text.replaceAll(from, to));
  return path;
}

describe("必須のスタックのテンプレート（cfn-lint）", () => {
  it("base.yaml は警告も誤りもなく通る", () => {
    const r = cfnLint(BASE);
    expect(r.out).toBe("");
    expect(r.status).toBe(0);
  });

  it("陰性対照: IAM の Action の綴りを誤ると落ちる", () => {
    const r = cfnLint(
      brokenCopy("bad-iam.yaml", "iam:UpdateAssumeRolePolicy", "iam:UpdateAssumeRolePolicyX"),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("W3037");
  });

  // プロバイダーの Deny の Resource は Standard の部品では Fn::If、Admin の部品（条件つきのリソース）では 2 つのホスト。
  // どちらの文でも cfn-lint が Action を検査することを、その部品の中だけを壊して確かめる
  it.each([
    ["Standard の部品（Resource が Fn::If）", "\n  StandardGuardPolicy:", "AdminGuardPolicy:"],
    ["Admin の部品（条件つき）", "\n  AdminGuardPolicy:", "\nOutputs:"],
  ])("陰性対照: %s のプロバイダーの Deny の Action の綴りを誤ると落ちる", (name, start, end) => {
    const text = readFileSync(BASE, "utf8");
    const at = text.indexOf(start);
    const to = text.indexOf(end, at + 1);
    expect(at).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(at);
    const from = "iam:AddClientIDToOpenIDConnectProvider";
    const part = text.slice(at, to);
    expect(part).toContain(from);
    expect(part).toContain("AdminIssuerHost");
    const path = join(dir, `bad-provider-${name.length}.yaml`);
    writeFileSync(path, text.slice(0, at) + part.replace(from, `${from}X`) + text.slice(to));
    const r = cfnLint(path);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("W3037");
  });

  it("陰性対照: aws login --remote の Deny の Action の綴りを誤ると落ちる", () => {
    const r = cfnLint(
      brokenCopy("bad-signin.yaml", "signin:CreateOAuth2Token", "signin:CreateOAuth2Tokn"),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("W3037");
  });
});
