import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluate, type Json } from "./cfn";

const tpl: Json = parse(
  readFileSync(resolve(import.meta.dirname, "../../scripts/poc/human/poc-human.yaml"), "utf8"),
  { customTags: [] },
);
const HOST = "awsbridge-human-poc.example.workers.dev";
const PROVIDER_ARN = `arn:aws:iam::123456789012:oidc-provider/${HOST}`;

function trustPolicy(subject = "user@example.com", audience = "awsbridge-human-poc") {
  const text = evaluate(tpl.Resources.HumanRole.Properties.AssumeRolePolicyDocument, {
    IssuerHost: HOST,
    Audience: audience,
    Subject: subject,
    OidcProvider: PROVIDER_ARN,
  });
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

describe("PoC（人間のログイン）テンプレート: Parameters", () => {
  const p = tpl.Parameters;
  it("IssuerHost・Subject は必須（既定値なし）", () => {
    expect(p.IssuerHost.Default).toBeUndefined();
    expect(p.Subject.Default).toBeUndefined();
    expect(p.Subject.Type).toBe("String");
  });
  it("既定値は MCP 用とは別（audience・ロール名）", () => {
    expect(p.Audience.Default).toBe("awsbridge-human-poc");
    expect(p.RoleName.Default).toBe("AwsbridgeHumanPoc");
  });
  it("IssuerHost は https:// や / を含められない", () => {
    const re = new RegExp(p.IssuerHost.AllowedPattern);
    expect(re.test(HOST)).toBe(true);
    expect(re.test(`https://${HOST}`)).toBe(false);
    expect(re.test(`${HOST}/`)).toBe(false);
    expect(re.test('a"b.example.com')).toBe(false);
  });
  it("Subject は 1 人の email だけ（ワイルドカード・カンマ・引用符は不可）", () => {
    const re = new RegExp(p.Subject.AllowedPattern);
    expect(re.test("user@example.com")).toBe(true);
    expect(re.test("a.b+c@sub.example.org")).toBe(true);
    for (const bad of [
      "*@example.com",
      "user?@example.com",
      "a@example.com,b@example.com",
      'a"@example.com',
      "user@*.com",
      "",
    ])
      expect(re.test(bad), bad).toBe(false);
  });
});

describe("PoC（人間のログイン）テンプレート: OIDC プロバイダー", () => {
  it("issuer は https://<IssuerHost>、client ID は Audience", () => {
    const props = evaluate(tpl.Resources.OidcProvider.Properties, {
      IssuerHost: HOST,
      Audience: "awsbridge-human-poc",
    });
    expect(props.Url).toBe(`https://${HOST}`);
    expect(props.ClientIdList).toEqual(["awsbridge-human-poc"]);
    expect(props.ThumbprintList).toBeUndefined();
  });
});

describe("PoC（人間のログイン）テンプレート: ロール", () => {
  const role = tpl.Resources.HumanRole;
  it("ロールは 1 つだけ", () => {
    const roles = Object.values(tpl.Resources as Record<string, Json>).filter(
      (r) => r.Type === "AWS::IAM::Role",
    );
    expect(roles).toHaveLength(1);
  });
  it("MaxSessionDuration は 43200（12 時間）", () => {
    expect(role.Properties.MaxSessionDuration).toBe(43200);
  });
  it("ReadOnlyAccess と SignInLocalDevelopmentAccess（aws login 用）", () => {
    const arns = evaluate(role.Properties.ManagedPolicyArns, { "AWS::Partition": "aws" });
    expect(arns).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
      "arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess",
    ]);
  });
  it("ロール名は RoleName", () => {
    expect(evaluate(role.Properties.RoleName, { RoleName: "AwsbridgeHumanPoc" })).toBe(
      "AwsbridgeHumanPoc",
    );
  });
  it("信頼ポリシー: OIDC プロバイダーを Federated に、3 つの Action、aud と sub を StringEquals で照合", () => {
    const doc = trustPolicy();
    expect(doc.Statement).toHaveLength(1);
    const st = doc.Statement[0];
    expect(st.Effect).toBe("Allow");
    expect(st.Principal).toEqual({ Federated: PROVIDER_ARN });
    expect([...st.Action].sort()).toEqual([
      "sts:AssumeRoleWithWebIdentity",
      "sts:SetSourceIdentity",
      "sts:TagSession",
    ]);
    expect(st.Condition).toEqual({
      StringEquals: {
        [`${HOST}:aud`]: "awsbridge-human-poc",
        [`${HOST}:sub`]: "user@example.com",
      },
    });
  });
});

describe("PoC（人間のログイン）テンプレート: Outputs", () => {
  it("RoleArn と OidcProviderArn", () => {
    expect(tpl.Outputs.RoleArn.Value).toEqual({ "Fn::GetAtt": ["HumanRole", "Arn"] });
    expect(tpl.Outputs.OidcProviderArn.Value).toEqual({ Ref: "OidcProvider" });
  });
});
