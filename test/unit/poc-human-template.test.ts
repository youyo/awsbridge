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
  it("ロールは既存の HumanRole と、P2〜P4 用の TaggedRole・NoTagRole の 3 つ", () => {
    const roles = Object.entries(tpl.Resources as Record<string, Json>)
      .filter(([, r]) => r.Type === "AWS::IAM::Role")
      .map(([k]) => k)
      .sort();
    expect(roles).toEqual(["HumanRole", "NoTagRole", "TaggedRole"]);
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

function roleTrust(resource: string, subject = "user@example.com") {
  const text = evaluate(tpl.Resources[resource].Properties.AssumeRolePolicyDocument, {
    IssuerHost: HOST,
    Audience: "awsbridge-human-poc",
    Subject: subject,
    OidcProvider: PROVIDER_ARN,
  });
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

describe("PoC（人間のログイン）テンプレート: TaggedRole（P2 セッションタグ・P3 SourceIdentity・P4 停止）", () => {
  const role = tpl.Resources.TaggedRole;
  it("ロール名は <RoleName>Tagged（PoC のガード AwsbridgeHumanPoc* に収まる）、MaxSessionDuration 43200", () => {
    expect(evaluate(role.Properties.RoleName, { RoleName: "AwsbridgeHumanPoc" })).toBe(
      "AwsbridgeHumanPocTagged",
    );
    expect(role.Properties.MaxSessionDuration).toBe(43200);
  });
  it("ReadOnlyAccess と SignInLocalDevelopmentAccess（コンソールと aws login で P3/P4 を試す）", () => {
    expect(evaluate(role.Properties.ManagedPolicyArns, { "AWS::Partition": "aws" })).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
      "arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess",
    ]);
  });
  it("信頼ポリシーは Allow 文 1 つだけ（迂回できる別の Allow を置かない）", () => {
    const doc = roleTrust("TaggedRole");
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Effect).toBe("Allow");
    expect(doc.Statement[0].Principal).toEqual({ Federated: PROVIDER_ARN });
  });
  it("Action は AssumeRoleWithWebIdentity・TagSession・SetSourceIdentity", () => {
    const st = roleTrust("TaggedRole").Statement[0];
    expect([...st.Action].sort()).toEqual([
      "sts:AssumeRoleWithWebIdentity",
      "sts:SetSourceIdentity",
      "sts:TagSession",
    ]);
  });
  it("条件: aud・sub、access_profile は poc-admin / poc-viewer、タグのキーは access_profile だけ、SourceIdentity 必須", () => {
    const st = roleTrust("TaggedRole").Statement[0];
    expect(st.Condition).toEqual({
      StringEquals: {
        [`${HOST}:aud`]: "awsbridge-human-poc",
        [`${HOST}:sub`]: "user@example.com",
        "aws:RequestTag/access_profile": ["poc-admin", "poc-viewer"],
      },
      "ForAllValues:StringEquals": { "aws:TagKeys": ["access_profile"] },
      Null: { "sts:SourceIdentity": "false" },
    });
  });
  it("権限: access_profile が poc-admin でなければ iam:ListRoles を Deny（PrincipalTag での権限差）", () => {
    const policies = role.Properties.Policies as Json[];
    expect(policies).toHaveLength(1);
    const doc = policies[0].PolicyDocument;
    expect(doc.Statement).toEqual([
      {
        Sid: "DenyListRolesUnlessPocAdmin",
        Effect: "Deny",
        Action: "iam:ListRoles",
        Resource: "*",
        Condition: { StringNotEquals: { "aws:PrincipalTag/access_profile": "poc-admin" } },
      },
    ]);
  });
});

describe("PoC（人間のログイン）テンプレート: NoTagRole（TagSession なしでタグ付きトークンが拒否されるか）", () => {
  const role = tpl.Resources.NoTagRole;
  it("ロール名は <RoleName>NoTag", () => {
    expect(evaluate(role.Properties.RoleName, { RoleName: "AwsbridgeHumanPoc" })).toBe(
      "AwsbridgeHumanPocNoTag",
    );
  });
  it("信頼ポリシーの Action は AssumeRoleWithWebIdentity だけ、条件は aud・sub だけ", () => {
    const doc = roleTrust("NoTagRole");
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Action).toEqual(["sts:AssumeRoleWithWebIdentity"]);
    expect(doc.Statement[0].Condition).toEqual({
      StringEquals: {
        [`${HOST}:aud`]: "awsbridge-human-poc",
        [`${HOST}:sub`]: "user@example.com",
      },
    });
  });
  it("権限は ReadOnlyAccess だけ", () => {
    expect(evaluate(role.Properties.ManagedPolicyArns, { "AWS::Partition": "aws" })).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });
});

describe("PoC（人間のログイン）テンプレート: 追加のロール名と Outputs", () => {
  it("RoleName は接尾辞（Tagged / NoTag）を足しても 64 文字に収まる長さまで", () => {
    const re = new RegExp(tpl.Parameters.RoleName.AllowedPattern);
    expect(re.test("A".repeat(58))).toBe(true);
    expect(re.test("A".repeat(59))).toBe(false);
  });
  it("TaggedRoleArn と NoTagRoleArn を出す", () => {
    expect(tpl.Outputs.TaggedRoleArn.Value).toEqual({ "Fn::GetAtt": ["TaggedRole", "Arn"] });
    expect(tpl.Outputs.NoTagRoleArn.Value).toEqual({ "Fn::GetAtt": ["NoTagRole", "Arn"] });
  });
});
