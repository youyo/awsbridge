import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluate, type Json } from "./cfn";

// PoC のポータル用の CloudFormation（scripts/poc/human/portal/poc-portal.yaml）。既存の poc-human.yaml とは別スタック。
const tpl: Json = parse(
  readFileSync(
    resolve(import.meta.dirname, "../../scripts/poc/human/portal/poc-portal.yaml"),
    "utf8",
  ),
  { customTags: [] },
);
const HOST = "awsbridge-human-poc-portal.example.workers.dev";
const STD_ARN = `arn:aws:iam::123456789012:oidc-provider/${HOST}/std`;
const ADMIN_ARN = `arn:aws:iam::123456789012:oidc-provider/${HOST}/admin`;
const PARAMS = {
  IssuerHost: HOST,
  StdPath: "std",
  AdminPath: "admin",
  Audience: "awsbridge-human-poc-portal",
  RolePrefix: "AwsbridgeHumanPocPortal",
  SharedTeams: ["infra", "dev"],
  RestrictedTeam: "infra",
  StdProvider: STD_ARN,
  AdminProvider: ADMIN_ARN,
  "AWS::Partition": "aws",
  "AWS::AccountId": "123456789012",
};

function trust(resource: string) {
  const text = evaluate(tpl.Resources[resource].Properties.AssumeRolePolicyDocument, PARAMS);
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

describe("PoC ポータルのテンプレート: Parameters", () => {
  const p = tpl.Parameters;
  it("IssuerHost は必須で、PoC のポータルのホスト名だけ（https:// や / は不可）", () => {
    expect(p.IssuerHost.Default).toBeUndefined();
    const re = new RegExp(p.IssuerHost.AllowedPattern);
    expect(re.test(HOST)).toBe(true);
    for (const bad of [
      `https://${HOST}`,
      `${HOST}/std`,
      "awsbridge.example.workers.dev",
      "awsbridge-human-poc.example.workers.dev",
    ])
      expect(re.test(bad), bad).toBe(false);
  });
  it("パスは std / admin が既定で、英小文字・数字・ハイフンだけ", () => {
    expect(p.StdPath.Default).toBe("std");
    expect(p.AdminPath.Default).toBe("admin");
    const re = new RegExp(p.StdPath.AllowedPattern);
    expect(re.test("std")).toBe(true);
    for (const bad of ["std/", "/std", "a/b", "", "Std"]) expect(re.test(bad), bad).toBe(false);
  });
  it("audience とロール名の接頭辞は既存の PoC・MCP と別。接頭辞は AwsbridgeHumanPocPortal で始まる", () => {
    expect(p.Audience.Default).toBe("awsbridge-human-poc-portal");
    expect(p.RolePrefix.Default).toBe("AwsbridgeHumanPocPortal");
    const re = new RegExp(p.RolePrefix.AllowedPattern);
    expect(re.test("AwsbridgeHumanPocPortal")).toBe(true);
    expect(re.test("AwsbridgeHumanPoc")).toBe(false);
  });
});

describe("PoC ポータルのテンプレート: N9 パス付き issuer の OIDC プロバイダー 2 つ", () => {
  it("std と admin は同じホストの別パスで、client ID は Audience、ThumbprintList は付けない", () => {
    const std = evaluate(tpl.Resources.StdProvider.Properties, PARAMS);
    const admin = evaluate(tpl.Resources.AdminProvider.Properties, PARAMS);
    expect(std.Url).toBe(`https://${HOST}/std`);
    expect(admin.Url).toBe(`https://${HOST}/admin`);
    expect(std.ClientIdList).toEqual(["awsbridge-human-poc-portal"]);
    expect(admin.ClientIdList).toEqual(["awsbridge-human-poc-portal"]);
    expect(std.ThumbprintList).toBeUndefined();
  });
  it("Outputs に両方の ARN", () => {
    expect(tpl.Outputs.StdProviderArn.Value).toEqual({ Ref: "StdProvider" });
    expect(tpl.Outputs.AdminProviderArn.Value).toEqual({ Ref: "AdminProvider" });
  });
});

describe("PoC ポータルのテンプレート: ロール（タグ awsbridge_team を照合）", () => {
  it("ロールは Shared・InfraOnly・Admin の 3 つ", () => {
    const roles = Object.entries(tpl.Resources as Record<string, Json>)
      .filter(([, r]) => r.Type === "AWS::IAM::Role")
      .map(([k]) => k)
      .sort();
    expect(roles).toEqual(["AdminRole", "InfraOnlyRole", "SharedRole"]);
  });
  it("ロール名は <RolePrefix>Shared / InfraOnly / Admin（PoC のポータルのガードに収まる）", () => {
    expect(evaluate(tpl.Resources.SharedRole.Properties.RoleName, PARAMS)).toBe(
      "AwsbridgeHumanPocPortalShared",
    );
    expect(evaluate(tpl.Resources.InfraOnlyRole.Properties.RoleName, PARAMS)).toBe(
      "AwsbridgeHumanPocPortalInfraOnly",
    );
    expect(evaluate(tpl.Resources.AdminRole.Properties.RoleName, PARAMS)).toBe(
      "AwsbridgeHumanPocPortalAdmin",
    );
  });

  const expected = (provider: string, path: string, teams: string[]) => ({
    Effect: "Allow",
    Principal: { Federated: provider },
    Action: ["sts:AssumeRoleWithWebIdentity", "sts:TagSession", "sts:SetSourceIdentity"],
    Condition: {
      StringEquals: {
        [`${HOST}/${path}:aud`]: "awsbridge-human-poc-portal",
        "aws:RequestTag/awsbridge_team": teams,
      },
      "ForAllValues:StringEquals": { "aws:TagKeys": ["awsbridge_team"] },
      Null: { "sts:SourceIdentity": "false" },
    },
  });
  it("Shared: std のプロバイダー、条件キーは <host>/std:aud、チームは infra と dev、TagKeys と SI 必須", () => {
    const doc = trust("SharedRole");
    expect(doc.Statement).toEqual([expected(STD_ARN, "std", ["infra", "dev"])]);
  });
  it("InfraOnly: std のプロバイダー、チームは infra だけ（dev の経路で sts_denied を観察する）", () => {
    expect(trust("InfraOnlyRole").Statement).toEqual([expected(STD_ARN, "std", ["infra"])]);
  });
  it("Admin: admin のプロバイダー（std の JWT では入れない）、チームは infra だけ", () => {
    expect(trust("AdminRole").Statement).toEqual([expected(ADMIN_ARN, "admin", ["infra"])]);
  });
  it("sub は照合しない（所属は Access とタグで決める。sub の許可リストは使わない）", () => {
    for (const r of ["SharedRole", "InfraOnlyRole", "AdminRole"])
      expect(JSON.stringify(trust(r))).not.toContain(":sub");
  });
  it("MaxSessionDuration: Shared・InfraOnly は 43200、Admin は 3600（階層別に短く）", () => {
    expect(tpl.Resources.SharedRole.Properties.MaxSessionDuration).toBe(43200);
    expect(tpl.Resources.InfraOnlyRole.Properties.MaxSessionDuration).toBe(43200);
    expect(tpl.Resources.AdminRole.Properties.MaxSessionDuration).toBe(3600);
  });
  it("権限は ReadOnlyAccess と、aws login の localhost だけを許すインラインポリシー（--remote は許さない）", () => {
    for (const r of ["SharedRole", "InfraOnlyRole", "AdminRole"]) {
      const props = tpl.Resources[r].Properties;
      expect(evaluate(props.ManagedPolicyArns, PARAMS), r).toEqual([
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
      ]);
      const policies = evaluate(props.Policies, PARAMS) as Json[];
      expect(policies).toHaveLength(1);
      expect(policies[0].PolicyDocument.Statement).toEqual([
        {
          Sid: "AwsLoginLocalhostOnly",
          Effect: "Allow",
          Action: ["signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token"],
          Resource: "arn:aws:signin:*:123456789012:oauth2/public-client/localhost",
        },
      ]);
    }
  });
  it("Outputs にロールの ARN", () => {
    expect(tpl.Outputs.SharedRoleArn.Value).toEqual({ "Fn::GetAtt": ["SharedRole", "Arn"] });
    expect(tpl.Outputs.InfraOnlyRoleArn.Value).toEqual({ "Fn::GetAtt": ["InfraOnlyRole", "Arn"] });
    expect(tpl.Outputs.AdminRoleArn.Value).toEqual({ "Fn::GetAtt": ["AdminRole", "Arn"] });
  });
});
