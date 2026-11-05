import { describe, expect, it } from "vitest";
import { evaluate, type Json, loadTemplate } from "./cfn";

const tpl = loadTemplate();
const HOST = "awsbridge.example.workers.dev";
const PROVIDER_ARN = `arn:aws:iam::123456789012:oidc-provider/${HOST}`;

function trustPolicy(subjects: string[], audience = "awsbridge") {
  const doc = tpl.Resources.Role.Properties.AssumeRolePolicyDocument;
  const text = evaluate(doc, {
    IssuerHost: HOST,
    Audience: audience,
    AllowedSubjects: subjects,
    OidcProvider: PROVIDER_ARN,
  });
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

describe("Parameters", () => {
  const p = tpl.Parameters;
  it("必須パラメーターは既定値を持たない", () => {
    expect(p.IssuerHost.Default).toBeUndefined();
    expect(p.AllowedSubjects.Default).toBeUndefined();
    expect(p.AllowedSubjects.Type).toBe("CommaDelimitedList");
  });
  it("既定値", () => {
    expect(p.Audience.Default).toBe("awsbridge");
    expect(p.RoleName.Default).toBe("awsbridge");
    expect(p.MaxSessionDuration.Default).toBe(3600);
    expect(p.MaxSessionDuration.Type).toBe("Number");
    expect(p.ManagedPolicyArns.Type).toBe("CommaDelimitedList");
    expect(p.ManagedPolicyArns.Default).toBe("");
  });
  it("IssuerHost は https:// や / を含められない", () => {
    const re = new RegExp(p.IssuerHost.AllowedPattern);
    expect(re.test(HOST)).toBe(true);
    expect(re.test(`https://${HOST}`)).toBe(false);
    expect(re.test(`${HOST}/`)).toBe(false);
    expect(re.test('a"b.example.com')).toBe(false);
  });
});

describe("入力パターン", () => {
  const p = tpl.Parameters;
  const subjects = new RegExp(p.AllowedSubjects.AllowedPattern);
  it("AllowedSubjects は許可例に一致し拒否例に一致しない", () => {
    for (const ok of ["user@example.com", "*@example.com", "a.b+c@sub.example.org"])
      expect(subjects.test(ok), ok).toBe(true);
    for (const ng of [
      "*",
      "*@*",
      "*@*.com",
      'a"b@example.com',
      "user",
      "",
      "a@example",
      "a@exa*mple.com",
      " a@example.com",
    ])
      expect(subjects.test(ng), ng).toBe(false);
  });
  it("RoleName は IAM のロール名パターン", () => {
    const re = new RegExp(p.RoleName.AllowedPattern);
    expect(re.test("awsbridge")).toBe(true);
    expect(re.test("a_b+c=d,e.f@g-h")).toBe(true);
    expect(re.test("a".repeat(64))).toBe(true);
    expect(re.test("a".repeat(65))).toBe(false);
    expect(re.test("")).toBe(false);
    expect(re.test('a"b')).toBe(false);
    expect(re.test("a b")).toBe(false);
  });
});

describe("Resources", () => {
  it("OIDC プロバイダー", () => {
    const r = tpl.Resources.OidcProvider;
    expect(r.Type).toBe("AWS::IAM::OIDCProvider");
    expect(evaluate(r.Properties.Url, { IssuerHost: HOST })).toBe(`https://${HOST}`);
    expect(r.Properties.ClientIdList).toEqual([{ Ref: "Audience" }]);
    expect(r.Properties.ThumbprintList).toBeUndefined();
  });
  it("Role の基本プロパティ", () => {
    const r = tpl.Resources.Role;
    expect(r.Type).toBe("AWS::IAM::Role");
    expect(r.Properties.RoleName).toEqual({ Ref: "RoleName" });
    expect(r.Properties.MaxSessionDuration).toEqual({ Ref: "MaxSessionDuration" });
  });
  it("タグ project=awsbridge", () => {
    for (const name of ["OidcProvider", "Role"]) {
      expect(tpl.Resources[name].Properties.Tags).toContainEqual({
        Key: "project",
        Value: "awsbridge",
      });
    }
  });
});

describe("ManagedPolicyArns の条件分岐", () => {
  it("空のときは付けない（Fn::If で AWS::NoValue）", () => {
    const v = tpl.Resources.Role.Properties.ManagedPolicyArns["Fn::If"];
    expect(v[0]).toBe("HasManagedPolicies");
    expect(v[1]).toEqual({ Ref: "ManagedPolicyArns" });
    expect(v[2]).toEqual({ Ref: "AWS::NoValue" });
  });
  it("Condition は『結合した結果が空文字でない』", () => {
    expect(tpl.Conditions.HasManagedPolicies).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ "Fn::Join": ["", { Ref: "ManagedPolicyArns" }] }, ""] }],
    });
  });
});

describe("信頼ポリシー", () => {
  it("構造: Allow / AssumeRoleWithWebIdentity / Federated = provider", () => {
    const doc = trustPolicy(["user@example.com"]);
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement).toHaveLength(1);
    const s = doc.Statement[0];
    expect(s.Effect).toBe("Allow");
    expect(s.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(s.Principal).toEqual({ Federated: PROVIDER_ARN });
  });
  it("aud は StringEquals、sub は StringLike で、キーは <host>:aud / <host>:sub", () => {
    const c = trustPolicy(["user@example.com"], "my-aud").Statement[0].Condition;
    expect(Object.keys(c).sort()).toEqual(["StringEquals", "StringLike"]);
    expect(c.StringEquals).toEqual({ [`${HOST}:aud`]: "my-aud" });
    expect(Object.keys(c.StringLike)).toEqual([`${HOST}:sub`]);
  });
  it("AllowedSubjects を全て含む（ワイルドカード可、1 件でも配列）", () => {
    const many = ["user@example.com", "*@example.org", "other@example.net"];
    expect(trustPolicy(many).Statement[0].Condition.StringLike[`${HOST}:sub`]).toEqual(many);
    expect(trustPolicy(["a@example.com"]).Statement[0].Condition.StringLike[`${HOST}:sub`]).toEqual(
      ["a@example.com"],
    );
  });
});

describe("Outputs", () => {
  it("RoleArn と OidcProviderArn", () => {
    const o: Json = tpl.Outputs;
    expect(o.RoleArn.Value).toEqual({ "Fn::GetAtt": ["Role", "Arn"] });
    expect(o.OidcProviderArn.Value).toEqual({ Ref: "OidcProvider" });
  });
});
