import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluate, type Json } from "./cfn";

// PoC N6 の CloudFormation（scripts/poc/admin-kms/poc-admin-kms.yaml）。既存の PoC とは別スタック。
const tpl: Json = parse(
  readFileSync(
    resolve(import.meta.dirname, "../../scripts/poc/admin-kms/poc-admin-kms.yaml"),
    "utf8",
  ),
  { customTags: [] },
);
const HOST = "awsbridge-admin-kms-poc.example.workers.dev";
const PROVIDER = `arn:aws:iam::123456789012:oidc-provider/${HOST}`;
const PARAMS = {
  IssuerHost: HOST,
  Audience: "awsbridge-admin-kms-poc",
  Subject: "awsbridge-kms-check",
  WorkerUserName: "awsbridge-admin-kms-poc-worker",
  RoleName: "AwsbridgeAdminKmsPoc",
  OidcProvider: PROVIDER,
  "AWS::Partition": "aws",
  "AWS::AccountId": "123456789012",
  "AWS::StackName": "awsbridge-admin-kms-poc",
};
const WORKER_ARN = "arn:aws:iam::123456789012:user/awsbridge-admin-kms-poc-worker";
const KEYS = { RsaKey: "RSA_2048", EcKey: "ECC_NIST_P256", RsaNextKey: "RSA_2048" } as const;

function keyPolicy(name: string) {
  return evaluate(tpl.Resources[name].Properties.KeyPolicy, PARAMS);
}

describe("PoC N6 のテンプレート: KMS の鍵", () => {
  it.each(Object.entries(KEYS))(
    "%s は %s の署名用（SIGN_VERIFY）、削除の待ちは最短の 7 日",
    (name, spec) => {
      const k = tpl.Resources[name];
      expect(k.Type).toBe("AWS::KMS::Key");
      expect(k.Properties.KeySpec).toBe(spec);
      expect(k.Properties.KeyUsage).toBe("SIGN_VERIFY");
      expect(k.Properties.PendingWindowInDays).toBe(7);
      expect(k.DeletionPolicy ?? "Delete").toBe("Delete");
    },
  );
  it.each(Object.keys(KEYS))(
    "%s の鍵ポリシー: 管理はアカウント（IAM）に残し、Sign は Worker の IAM ユーザー以外を Deny",
    (name) => {
      const p = keyPolicy(name);
      const admin = p.Statement.find((s: Json) => s.Effect === "Allow");
      expect(admin.Principal).toEqual({ AWS: "arn:aws:iam::123456789012:root" });
      expect(admin.Action).toBe("kms:*");
      const denies = p.Statement.filter((s: Json) => s.Effect === "Deny");
      // Deny は Sign だけ（Disable・ScheduleKeyDeletion などの管理は塞がない）
      for (const d of denies) expect(d.Action).toBe("kms:Sign");
      const byPrincipal = denies.find(
        (d: Json) => d.Condition?.StringNotEquals?.["aws:PrincipalArn"],
      );
      expect(byPrincipal.Principal).toBe("*");
      expect(byPrincipal.Condition.StringNotEquals["aws:PrincipalArn"]).toBe(WORKER_ARN);
      const byType = denies.find((d: Json) => d.Condition?.StringNotEquals?.["kms:MessageType"]);
      expect(byType.Condition.StringNotEquals["kms:MessageType"]).toBe("RAW");
      const byAlg = denies.find(
        (d: Json) => d.Condition?.StringNotEquals?.["kms:SigningAlgorithm"],
      );
      expect(byAlg.Condition.StringNotEquals["kms:SigningAlgorithm"]).toBe(
        name === "EcKey" ? "ECDSA_SHA_256" : "RSASSA_PKCS1_V1_5_SHA_256",
      );
    },
  );
});

describe("PoC N6 のテンプレート: Worker の IAM ユーザー", () => {
  const u = tpl.Resources.WorkerUser;
  it("アクセスキーはテンプレートで作らない（秘密をスタックに残さない）", () => {
    for (const r of Object.values(tpl.Resources) as Json[])
      expect(r.Type).not.toBe("AWS::IAM::AccessKey");
  });
  it("権限は 3 つの鍵への kms:Sign だけ", () => {
    expect(u.Type).toBe("AWS::IAM::User");
    expect(evaluate(u.Properties.UserName, PARAMS)).toBe("awsbridge-admin-kms-poc-worker");
    expect(u.Properties.ManagedPolicyArns).toBeUndefined();
    const stmts = u.Properties.Policies.flatMap((p: Json) => p.PolicyDocument.Statement);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].Effect).toBe("Allow");
    expect(stmts[0].Action).toBe("kms:Sign");
    expect(stmts[0].Resource).toEqual([
      { "Fn::GetAtt": ["RsaKey", "Arn"] },
      { "Fn::GetAtt": ["EcKey", "Arn"] },
      { "Fn::GetAtt": ["RsaNextKey", "Arn"] },
    ]);
  });
});

describe("PoC N6 のテンプレート: OIDC プロバイダーとロール", () => {
  it("OIDC プロバイダーは https://<IssuerHost>、client ID は Audience", () => {
    const p = tpl.Resources.OidcProvider.Properties;
    expect(evaluate(p.Url, PARAMS)).toBe(`https://${HOST}`);
    expect(evaluate(p.ClientIdList, PARAMS)).toEqual(["awsbridge-admin-kms-poc"]);
  });
  it("IssuerHost は PoC の Worker のホストだけ", () => {
    const re = new RegExp(tpl.Parameters.IssuerHost.AllowedPattern);
    expect(re.test(HOST)).toBe(true);
    for (const bad of [`https://${HOST}`, `${HOST}/x`, "awsbridge-mcp.example.workers.dev"])
      expect(re.test(bad), bad).toBe(false);
  });
  it("ロールの信頼ポリシーは既存の PoC（Tagged）と同じ形: aud・sub・セッションタグ・SourceIdentity 必須", () => {
    const r = tpl.Resources.AdminRole.Properties;
    expect(r.MaxSessionDuration).toBe(3600);
    expect(r.ManagedPolicyArns).toBeUndefined();
    expect(r.Policies).toBeUndefined();
    const trust = JSON.parse(evaluate(r.AssumeRolePolicyDocument, PARAMS));
    expect(trust.Statement).toHaveLength(1);
    const s = trust.Statement[0];
    expect(s.Principal).toEqual({ Federated: PROVIDER });
    expect(s.Action).toEqual([
      "sts:AssumeRoleWithWebIdentity",
      "sts:TagSession",
      "sts:SetSourceIdentity",
    ]);
    expect(s.Condition).toEqual({
      StringEquals: {
        [`${HOST}:aud`]: "awsbridge-admin-kms-poc",
        [`${HOST}:sub`]: "awsbridge-kms-check",
        "aws:RequestTag/access_profile": ["poc-admin"],
      },
      "ForAllValues:StringEquals": { "aws:TagKeys": ["access_profile"] },
      Null: { "sts:SourceIdentity": "false" },
    });
  });
});

describe("PoC N6 のテンプレート: Outputs", () => {
  it("ロール・ユーザー・3 つの鍵の ARN", () => {
    expect(Object.keys(tpl.Outputs).sort()).toEqual(
      [
        "EcKeyArn",
        "OidcProviderArn",
        "RoleArn",
        "RsaKeyArn",
        "RsaNextKeyArn",
        "WorkerUserName",
      ].sort(),
    );
  });
});

describe("PoC N6 のテンプレート: 2 段階のデプロイ（IAM は作成時に issuer の discovery を読むため）", () => {
  it("CreateIssuerResources（既定 true）が false なら OIDC プロバイダーとロールを作らない（鍵とユーザーだけ）", () => {
    const p = tpl.Parameters.CreateIssuerResources;
    expect(p.AllowedValues).toEqual(["true", "false"]);
    expect(p.Default).toBe("true");
    expect(tpl.Conditions.HasIssuer).toEqual({
      "Fn::Equals": [{ Ref: "CreateIssuerResources" }, "true"],
    });
    for (const r of ["OidcProvider", "AdminRole"])
      expect(tpl.Resources[r].Condition, r).toBe("HasIssuer");
    for (const o of ["RoleArn", "OidcProviderArn"])
      expect(tpl.Outputs[o].Condition, o).toBe("HasIssuer");
    for (const r of ["RsaKey", "EcKey", "RsaNextKey", "WorkerUser"])
      expect(tpl.Resources[r].Condition, r).toBeUndefined();
  });
});
