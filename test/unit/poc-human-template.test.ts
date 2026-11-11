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
  it("ロールは既存の HumanRole、P2〜P4 用の TaggedRole・NoTagRole、aws login を localhost に絞る LocalOnlyRole の 4 つ", () => {
    const roles = Object.entries(tpl.Resources as Record<string, Json>)
      .filter(([, r]) => r.Type === "AWS::IAM::Role")
      .map(([k]) => k)
      .sort();
    expect(roles).toEqual(["HumanRole", "LocalOnlyRole", "NoTagRole", "TaggedRole"]);
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
    // Sid の末尾は UpdateMarker（既定 0）。(4-a) でスタックの更新を起こすための印
    const doc = evaluate(policies[0].PolicyDocument, { UpdateMarker: "0" });
    expect(doc.Statement).toEqual([
      {
        Sid: "DenyListRolesUnlessPocAdmin0",
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
  it("RoleName は接尾辞（Tagged / NoTag / LocalOnly）を足しても 64 文字に収まる長さまで", () => {
    const re = new RegExp(tpl.Parameters.RoleName.AllowedPattern);
    expect(re.test("A".repeat(55))).toBe(true);
    expect(re.test("A".repeat(56))).toBe(false);
    expect(55 + "LocalOnly".length).toBeLessThanOrEqual(64);
  });
  it("TaggedRoleArn と NoTagRoleArn を出す", () => {
    expect(tpl.Outputs.TaggedRoleArn.Value).toEqual({ "Fn::GetAtt": ["TaggedRole", "Arn"] });
    expect(tpl.Outputs.NoTagRoleArn.Value).toEqual({ "Fn::GetAtt": ["NoTagRole", "Arn"] });
  });
});

// ---- 段階 1a の前の条件（ADR-003 相当）: (1) aws login を localhost だけに・(4) CFN の外のポリシーと 1 人だけ止める Deny ----

describe("PoC（人間のログイン）テンプレート: LocalOnlyRole（(1) aws login を localhost だけに絞る）", () => {
  const role = tpl.Resources.LocalOnlyRole;
  it("ロール名は <RoleName>LocalOnly（PoC のガード AwsbridgeHumanPoc* に収まる）、MaxSessionDuration 43200", () => {
    expect(evaluate(role.Properties.RoleName, { RoleName: "AwsbridgeHumanPoc" })).toBe(
      "AwsbridgeHumanPocLocalOnly",
    );
    expect(role.Properties.MaxSessionDuration).toBe(43200);
  });
  it("管理ポリシーは ReadOnlyAccess だけ（SignInLocalDevelopmentAccess は付けない）", () => {
    expect(evaluate(role.Properties.ManagedPolicyArns, { "AWS::Partition": "aws" })).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });
  it("インラインポリシー AwsLoginLocalhostOnly: 2 つのアクションを oauth2/public-client/localhost だけに許す（remote は許さない）", () => {
    const policies = evaluate(role.Properties.Policies, {
      "AWS::Partition": "aws",
      "AWS::AccountId": "123456789012",
    }) as Json[];
    expect(policies).toHaveLength(1);
    expect(policies[0].PolicyName).toBe("AwsLoginLocalhostOnly");
    expect(policies[0].PolicyDocument.Statement).toEqual([
      {
        Sid: "AwsLoginSameDeviceOnly",
        Effect: "Allow",
        Action: ["signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token"],
        Resource: "arn:aws:signin:*:123456789012:oauth2/public-client/localhost",
      },
    ]);
    expect(JSON.stringify(policies)).not.toMatch(/remote|public-client\/\*/);
  });
  it("信頼ポリシーは HumanRole と同じ（aud・sub、3 つの Action）", () => {
    expect(roleTrust("LocalOnlyRole")).toEqual(trustPolicy());
  });
  it("Output LocalOnlyRoleArn を出す", () => {
    expect(tpl.Outputs.LocalOnlyRoleArn.Value).toEqual({ "Fn::GetAtt": ["LocalOnlyRole", "Arn"] });
  });
});

describe("PoC（人間のログイン）テンプレート: 2 人目の利用者 SecondSubject（(4-b) 1 人だけ止める Deny の対照）", () => {
  const p = tpl.Parameters;
  it("既定は none（2 人目なし）。none か 1 人の email だけ", () => {
    expect(p.SecondSubject.Default).toBe("none");
    const re = new RegExp(p.SecondSubject.AllowedPattern);
    expect(re.test("none")).toBe(true);
    expect(re.test("second@example.com")).toBe(true);
    for (const bad of [
      "",
      "*@example.com",
      "a@example.com,b@example.com",
      'a"@example.com',
      "nonex",
    ])
      expect(re.test(bad), bad).toBe(false);
  });
  it("条件 HasSecondSubject は SecondSubject が none でないとき", () => {
    expect(tpl.Conditions.HasSecondSubject).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "SecondSubject" }, "none"] }],
    });
  });
  function taggedTrust(hasSecond: boolean) {
    const text = evaluate(tpl.Resources.TaggedRole.Properties.AssumeRolePolicyDocument, {
      IssuerHost: HOST,
      Audience: "awsbridge-human-poc",
      Subject: "user@example.com",
      SecondSubject: "second@example.com",
      OidcProvider: PROVIDER_ARN,
      HasSecondSubject: hasSecond ? "true" : "false",
    });
    return JSON.parse(text as string);
  }
  it("Tagged の信頼ポリシー: 2 人目があれば sub は 2 人のどちらか、なければ 1 人目だけ（ほかの条件は同じ）", () => {
    const one = taggedTrust(false).Statement[0].Condition;
    const two = taggedTrust(true).Statement[0].Condition;
    expect(one.StringEquals[`${HOST}:sub`]).toBe("user@example.com");
    expect(two.StringEquals[`${HOST}:sub`]).toEqual(["user@example.com", "second@example.com"]);
    const { [`${HOST}:sub`]: _a, ...restOne } = one.StringEquals;
    const { [`${HOST}:sub`]: _b, ...restTwo } = two.StringEquals;
    expect(restTwo).toEqual(restOne);
    expect(two.Null).toEqual({ "sts:SourceIdentity": "false" });
  });
  it("2 人目は Tagged だけに足す（ほかのロールの信頼ポリシーは SecondSubject を参照しない）", () => {
    for (const r of ["HumanRole", "NoTagRole", "LocalOnlyRole"])
      expect(JSON.stringify(tpl.Resources[r].Properties.AssumeRolePolicyDocument), r).not.toContain(
        "SecondSubject",
      );
  });
});

describe("PoC（人間のログイン）テンプレート: UpdateMarker（(4-a) スタックの更新を起こす印）", () => {
  it("既定 0、英数字 1〜16 文字（IAM の Sid に入れるため）", () => {
    const p = tpl.Parameters.UpdateMarker;
    expect(p.Default).toBe("0");
    const re = new RegExp(p.AllowedPattern);
    for (const ok of ["0", "1", "abc123", "A".repeat(16)]) expect(re.test(ok), ok).toBe(true);
    for (const bad of ["", "a-b", "a b", "A".repeat(17)]) expect(re.test(bad), bad).toBe(false);
  });
  it("印を変えると Tagged の CloudFormation 管理のインラインポリシー（Sid）が変わる", () => {
    const doc = (m: string) =>
      evaluate(tpl.Resources.TaggedRole.Properties.Policies, { UpdateMarker: m })[0].PolicyDocument;
    expect(doc("0").Statement[0].Sid).toBe("DenyListRolesUnlessPocAdmin0");
    expect(doc("1").Statement[0].Sid).toBe("DenyListRolesUnlessPocAdmin1");
  });
});
