// 検査の道具の読み取り（scripts/console/inspect-read.ts）: aws CLI の応答から AccountSnapshot を作る。
// aws CLI は差し替えた関数（応答の材料）で置き換え、実際の AWS には接続しない。
import { describe, expect, it } from "vitest";
import {
  type AwsRun,
  READ_COMMANDS,
  readAccountSnapshot,
} from "../../scripts/console/inspect-read";
import type { AccountSnapshot } from "../../src/console/inspect";
import {
  ACCOUNT,
  awsResponses,
  goodSnapshot,
  inspectConfig,
  STD_GUARD,
} from "./console-inspect-fixtures";

const roleNames = inspectConfig().roles.map((r) => r.roleName);

/** 材料の応答で動く aws と、呼ばれた引数の記録。 */
function fake(s: AccountSnapshot) {
  const responses = awsResponses(s);
  const calls: string[][] = [];
  const run: AwsRun = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (!(key in responses)) throw new Error(`未知の呼び出し: ${key}`);
    return responses[key];
  };
  return { run, calls };
}

describe("readAccountSnapshot", () => {
  it("応答から、検査に渡す形を作る（材料の往復で元に戻る）", async () => {
    const s = goodSnapshot();
    const { run } = fake(s);
    const got = await readAccountSnapshot(run, { roleNames });
    expect(got.accountId).toBe(ACCOUNT);
    expect(got.partition).toBe("aws");
    expect(got.providers.sort()).toEqual([...s.providers].sort());
    for (const r of s.roles) {
      const g = got.roles.find((x) => x.roleName === r.roleName);
      expect(g?.trustPolicy, r.roleName).toEqual(r.trustPolicy);
      expect(g?.path).toBe(r.path);
    }
    const viewer = got.roles.find((x) => x.roleName === "FederatedViewer");
    expect(viewer?.attachedPolicies?.map((p) => p.policyArn)).toContain(STD_GUARD);
    expect(viewer?.inlinePolicies?.map((p) => p.policyName).sort()).toEqual([
      "AwsLogin",
      "DenySecretValueRead",
    ]);
    // 設定にも無く、コンソール用のパスにも無いロールは詳細を読まない（信頼ポリシーは ListRoles のもの）
    expect(
      got.roles.find((x) => x.roleName === "OrganizationAccountAccessRole")?.attachedPolicies,
    ).toBe(undefined);
    expect(got.managedPolicies.map((p) => p.arn).sort()).toEqual(
      s.managedPolicies.map((p) => p.arn).sort(),
    );
  });

  it("呼ぶのは読み取りの 8 種類だけ", async () => {
    const { run, calls } = fake(goodSnapshot());
    await readAccountSnapshot(run, { roleNames });
    const used = new Set(calls.map((c) => `${c[0]} ${c[1]}`));
    expect([...used].sort()).toEqual([...READ_COMMANDS].sort());
  });

  it("名前は = の形で渡す（- で始まる名前を別の引数と読ませない）", async () => {
    const { run, calls } = fake(goodSnapshot());
    await readAccountSnapshot(run, { roleNames });
    expect(calls).toContainEqual(["iam", "get-role", "--role-name=FederatedViewer"]);
    expect(calls).toContainEqual([
      "iam",
      "get-role-policy",
      "--role-name=FederatedViewer",
      "--policy-name=AwsLogin",
    ]);
  });

  it("部品は今の既定の版（DefaultVersionId）を読む", async () => {
    const s = goodSnapshot();
    const p = s.managedPolicies.find((x) => x.arn === STD_GUARD);
    if (p) p.defaultVersionId = "v7";
    const { run, calls } = fake(s);
    const got = await readAccountSnapshot(run, { roleNames });
    expect(calls).toContainEqual([
      "iam",
      "get-policy-version",
      "--policy-arn",
      STD_GUARD,
      "--version-id",
      "v7",
    ]);
    expect(got.managedPolicies.find((x) => x.arn === STD_GUARD)?.defaultVersionId).toBe("v7");
  });

  it("URL エンコードされた文字列の文書も読める", async () => {
    const s = goodSnapshot();
    const { run } = fake(s);
    const wrapped: AwsRun = async (args) => {
      const r = (await run(args)) as { Roles?: { AssumeRolePolicyDocument: unknown }[] };
      if (args[1] === "list-roles" && r.Roles)
        for (const x of r.Roles)
          x.AssumeRolePolicyDocument = encodeURIComponent(
            JSON.stringify(x.AssumeRolePolicyDocument),
          );
      return r;
    };
    const got = await readAccountSnapshot(wrapped, { roleNames });
    expect(
      got.roles.find((x) => x.roleName === "OrganizationAccountAccessRole")?.trustPolicy,
    ).toEqual(s.roles.find((x) => x.roleName === "OrganizationAccountAccessRole")?.trustPolicy);
  });

  it("ARN のアカウントが混ざっていれば止まる（取り違えたプロファイルで通さない）", async () => {
    const s = goodSnapshot();
    s.providers.push("arn:aws:iam::111111111111:oidc-provider/other.example.com");
    const { run } = fake(s);
    await expect(readAccountSnapshot(run, { roleNames })).rejects.toThrow(/account/);
  });

  it("期待するアカウントと違えば止まる", async () => {
    const { run } = fake(goodSnapshot());
    await expect(
      readAccountSnapshot(run, { roleNames, expectAccountId: "111111111111" }),
    ).rejects.toThrow(/account/);
  });
});
