import { describe, expect, it } from "vitest";
import { evaluate, type Json, loadTemplate } from "./cfn";

const tpl = loadTemplate();
const HOST = "awsbridge.example.workers.dev";
const PROVIDER_ARN = `arn:aws:iam::123456789012:oidc-provider/${HOST}`;

type RoleKind = "ReadOnlyRole" | "DebugRole";
const SUBJECT_PARAM = { ReadOnlyRole: "AllowedSubjects", DebugRole: "DebugAllowedSubjects" };

function trustPolicy(subjects: string[], audience = "awsbridge", role: RoleKind = "ReadOnlyRole") {
  const doc = tpl.Resources[role].Properties.AssumeRolePolicyDocument;
  const text = evaluate(doc, {
    IssuerHost: HOST,
    Audience: audience,
    AllowedSubjects: role === "ReadOnlyRole" ? subjects : ["unused@example.com"],
    DebugAllowedSubjects: role === "DebugRole" ? subjects : ["unused@example.com"],
    OidcProvider: PROVIDER_ARN,
  });
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

describe("Parameters", () => {
  const p = tpl.Parameters;
  it("必須パラメーターは既定値を持たない", () => {
    expect(p.IssuerHost.Default).toBeUndefined();
    for (const n of ["AllowedSubjects", "DebugAllowedSubjects"]) {
      expect(p[n].Default, n).toBeUndefined();
      expect(p[n].Type, n).toBe("CommaDelimitedList");
    }
  });
  it("既定値", () => {
    expect(p.Audience.Default).toBe("awsbridge");
    expect(p.ReadOnlyRoleName.Default).toBe("FederatedMcpReadOnly");
    expect(p.DebugRoleName.Default).toBe("FederatedMcpDebug");
    expect(p.MaxSessionDuration.Default).toBe(3600);
    expect(p.MaxSessionDuration.Type).toBe("Number");
  });
  it("廃止したパラメーターと条件は無い", () => {
    expect(p.RoleName).toBeUndefined();
    expect(p.ManagedPolicyArns).toBeUndefined();
    expect(tpl.Conditions.HasManagedPolicies).toBeUndefined();
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
  for (const name of ["AllowedSubjects", "DebugAllowedSubjects"]) {
    it(`${name} は許可例に一致し拒否例に一致しない`, () => {
      const subjects = new RegExp(p[name].AllowedPattern);
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
  }
  for (const name of ["ReadOnlyRoleName", "DebugRoleName"]) {
    it(`${name} は IAM のロール名パターン`, () => {
      const re = new RegExp(p[name].AllowedPattern);
      expect(re.test("FederatedMcpReadOnly")).toBe(true);
      expect(re.test("a_b+c=d,e.f@g-h")).toBe(true);
      expect(re.test("a".repeat(64))).toBe(true);
      expect(re.test("a".repeat(65))).toBe(false);
      expect(re.test("")).toBe(false);
      expect(re.test('a"b')).toBe(false);
      expect(re.test("a b")).toBe(false);
    });
  }
});

describe("Resources", () => {
  it("OIDC プロバイダー", () => {
    const r = tpl.Resources.OidcProvider;
    expect(r.Type).toBe("AWS::IAM::OIDCProvider");
    expect(evaluate(r.Properties.Url, { IssuerHost: HOST })).toBe(`https://${HOST}`);
    expect(r.Properties.ClientIdList).toEqual([{ Ref: "Audience" }]);
    expect(r.Properties.ThumbprintList).toBeUndefined();
  });
  it("リソースは OIDC プロバイダー 1 つとロール 2 つだけ", () => {
    expect(Object.keys(tpl.Resources).sort()).toEqual([
      "DebugRole",
      "OidcProvider",
      "ReadOnlyRole",
    ]);
    expect(tpl.Resources.Role).toBeUndefined();
  });
  it("ロールの基本プロパティと名前", () => {
    const ro = tpl.Resources.ReadOnlyRole;
    const dbg = tpl.Resources.DebugRole;
    expect(ro.Type).toBe("AWS::IAM::Role");
    expect(dbg.Type).toBe("AWS::IAM::Role");
    expect(ro.Properties.RoleName).toEqual({ Ref: "ReadOnlyRoleName" });
    expect(dbg.Properties.RoleName).toEqual({ Ref: "DebugRoleName" });
    for (const r of [ro, dbg])
      expect(r.Properties.MaxSessionDuration).toEqual({ Ref: "MaxSessionDuration" });
  });
  it("タグ project=awsbridge", () => {
    for (const name of ["OidcProvider", "ReadOnlyRole", "DebugRole"]) {
      expect(tpl.Resources[name].Properties.Tags).toContainEqual({
        Key: "project",
        Value: "awsbridge",
      });
    }
  });
});

describe("権限", () => {
  const readOnlyAccess = (partition: string) => `arn:${partition}:iam::aws:policy/ReadOnlyAccess`;
  const managed = (role: RoleKind, additional: string[] = []) =>
    evaluate(tpl.Resources[role].Properties.ManagedPolicyArns, {
      "AWS::Partition": "aws-cn",
      DebugAdditionalPolicyArns: additional,
      HasDebugAdditionalPolicies: additional.length > 0 ? "true" : "false",
    });

  it("ReadOnlyRole の管理ポリシーは ReadOnlyAccess だけ（パーティションは AWS::Partition）", () => {
    expect(managed("ReadOnlyRole")).toEqual([readOnlyAccess("aws-cn")]);
  });
  it("ReadOnlyRole は SSM パラメータの取得を明示 Deny する（条件なし・DebugRole には付けない）", () => {
    const policies = tpl.Resources.ReadOnlyRole.Properties.Policies;
    expect(policies).toHaveLength(1);
    const doc = policies[0].PolicyDocument;
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement).toHaveLength(1);
    const st = doc.Statement[0];
    expect(st.Effect).toBe("Deny");
    expect([...st.Action].sort()).toEqual([
      "ssm:GetParameter",
      "ssm:GetParameterHistory",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]);
    expect(st.Resource).toBe("*");
    expect(st.Condition).toBeUndefined();
    // DebugRole のインラインポリシーに Deny は無い（SecretRead で読める設計のまま）
    const debugStatements = tpl.Resources.DebugRole.Properties.Policies[0].PolicyDocument.Statement;
    expect(JSON.stringify(debugStatements)).not.toContain('"Deny"');
  });
  it("DebugAdditionalPolicyArns は空なら付けず、あれば ReadOnlyAccess に加えて DebugRole だけに付く", () => {
    const p = tpl.Parameters.DebugAdditionalPolicyArns;
    expect(p.Type).toBe("CommaDelimitedList");
    expect(p.Default).toBe("");
    expect(tpl.Conditions.HasDebugAdditionalPolicies).toEqual({
      "Fn::Not": [
        { "Fn::Equals": [{ "Fn::Join": ["", { Ref: "DebugAdditionalPolicyArns" }] }, ""] },
      ],
    });
    const extra = [
      "arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess",
      "arn:aws:iam::123456789012:policy/custom",
    ];
    expect(managed("DebugRole", extra)).toEqual([readOnlyAccess("aws-cn"), ...extra]);
    expect(managed("DebugRole")).toEqual([readOnlyAccess("aws-cn")]);
    expect(managed("ReadOnlyRole", extra)).toEqual([readOnlyAccess("aws-cn")]);
  });
  it("DebugAdditionalPolicyArns のパターン", () => {
    const re = new RegExp(tpl.Parameters.DebugAdditionalPolicyArns.AllowedPattern);
    for (const ok of [
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
      "arn:aws-cn:iam::aws:policy/service-role/Foo",
      "arn:aws:iam::123456789012:policy/my-policy",
      "",
    ])
      expect(re.test(ok), ok).toBe(true);
    for (const ng of [
      "arn:aws:iam::aws:role/x",
      "arn:aws:iam::12345:policy/x",
      "arn:aws:iam::123456789012:policy/",
      'arn:aws:iam::aws:policy/a"b',
      " arn:aws:iam::aws:policy/x",
    ])
      expect(re.test(ng), ng).toBe(false);
  });
  describe("DebugRole のインラインポリシー", () => {
    const GROUPS: Record<string, string[]> = {
      Investigation: [
        "logs:StartQuery",
        "logs:StopQuery",
        "logs:GetQueryResults",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:GetLogRecord",
        "logs:StartLiveTail",
        "xray:GetTraceSummaries",
        "xray:BatchGetTraces",
        "xray:GetInsightSummaries",
        "cloudtrail:LookupEvents",
        "cloudtrail:StartQuery",
        "cloudtrail:GetQueryResults",
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StopQueryExecution",
        "ec2:GetConsoleOutput",
        "ec2:GetConsoleScreenshot",
        "config:SelectResourceConfig",
        "config:GetResourceConfigHistory",
      ],
      SecretRead: [
        "secretsmanager:GetSecretValue",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ],
      SecretDecrypt: ["kms:Decrypt"],
      Operations: [
        "ecs:UpdateService",
        "ecs:StopTask",
        "ec2:RebootInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "lambda:PutFunctionConcurrency",
        "autoscaling:SetDesiredCapacity",
        "rds:RebootDBInstance",
        "elasticache:RebootCacheCluster",
        "cloudfront:CreateInvalidation",
      ],
      Execution: [
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:StartSession",
        "ssm:ResumeSession",
        "ssm:TerminateSession",
        "ec2-instance-connect:SendSSHPublicKey",
        "ecs:ExecuteCommand",
        "ecs:RunTask",
        "lambda:InvokeFunction",
        "states:StartExecution",
        "sqs:SendMessage",
        "sns:Publish",
        "rds-db:connect",
      ],
      PassRoleForEcsRunTask: ["iam:PassRole"],
    };
    const policies = tpl.Resources.DebugRole.Properties.Policies;
    const doc = policies[0].PolicyDocument;
    const PASSABLE = ["arn:aws:iam::111111111111:role/task-a", "arn:aws:iam::111111111111:role/b"];
    // DebugPassableEcsTaskRoleArns を指定したときの Statement 一覧（Fn::If を評価済み）
    const withPassable: Json[] = evaluate(doc.Statement, {
      HasDebugPassableEcsTaskRoles: "true",
      DebugPassableEcsTaskRoleArns: PASSABLE,
    });
    // 既定（空）のときの Statement 一覧
    const withoutPassable: Json[] = evaluate(doc.Statement, {
      HasDebugPassableEcsTaskRoles: "false",
      DebugPassableEcsTaskRoleArns: [""],
    });
    const statements = withPassable;
    const byGroup = (sid: string): Json => statements.find((s: Json) => s.Sid === sid);
    const actions = (s: Json): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
    const allActions: string[] = statements.flatMap(actions);

    it("DebugRole は ReadOnlyAccess + インラインポリシー 1 つ", () => {
      expect(managed("DebugRole")).toEqual([readOnlyAccess("aws-cn")]);
      expect(policies).toHaveLength(1);
      expect(typeof policies[0].PolicyName).toBe("string");
      expect(doc.Version).toBe("2012-10-17");
    });
    it("Statement は想定のグループだけ", () => {
      expect(statements.map((s: Json) => s.Sid).sort()).toEqual(Object.keys(GROUPS).sort());
    });
    for (const [sid, expected] of Object.entries(GROUPS)) {
      it(`${sid} の Action と Resource`, () => {
        const s = byGroup(sid);
        expect(s.Effect).toBe("Allow");
        expect([...actions(s)].sort()).toEqual([...expected].sort());
        if (sid === "PassRoleForEcsRunTask") expect(s.Resource).toEqual(PASSABLE);
        else expect(s.Resource).toBe("*");
      });
    }
    it("権限昇格につながる lambda:UpdateFunctionConfiguration / autoscaling:UpdateAutoScalingGroup を含まない", () => {
      expect(allActions).not.toContain("lambda:UpdateFunctionConfiguration");
      expect(allActions).not.toContain("autoscaling:UpdateAutoScalingGroup");
      expect(allActions).toContain("lambda:PutFunctionConcurrency");
      expect(allActions).toContain("autoscaling:SetDesiredCapacity");
    });
    it("DebugPassableEcsTaskRoleArns が空（既定）なら iam:PassRole の Statement を付けない", () => {
      const p = tpl.Parameters.DebugPassableEcsTaskRoleArns;
      expect(p.Type).toBe("CommaDelimitedList");
      expect(p.Default).toBe("");
      expect(tpl.Conditions.HasDebugPassableEcsTaskRoles).toEqual({
        "Fn::Not": [
          { "Fn::Equals": [{ "Fn::Join": ["", { Ref: "DebugPassableEcsTaskRoleArns" }] }, ""] },
        ],
      });
      expect(withoutPassable.map((s: Json) => s.Sid)).not.toContain("PassRoleForEcsRunTask");
      expect(withoutPassable.flatMap(actions)).not.toContain("iam:PassRole");
      expect(withoutPassable.map((s: Json) => s.Sid).sort()).toEqual(
        Object.keys(GROUPS)
          .filter((k) => k !== "PassRoleForEcsRunTask")
          .sort(),
      );
      expect(withoutPassable.flatMap(actions)).toContain("ecs:RunTask");
    });
    it("DebugPassableEcsTaskRoleArns のパターン", () => {
      const re = new RegExp(tpl.Parameters.DebugPassableEcsTaskRoleArns.AllowedPattern);
      for (const ok of [
        "arn:aws:iam::111111111111:role/task-a",
        "arn:aws-cn:iam::111111111111:role/path/to/role",
        "",
      ])
        expect(re.test(ok), ok).toBe(true);
      for (const ng of [
        "*",
        "arn:aws:iam::111111111111:role/*",
        "arn:aws:iam::111111111111:policy/x",
        "arn:aws:iam::1111:role/x",
        "arn:aws:iam::111111111111:role/",
        'arn:aws:iam::111111111111:role/a"b',
        " arn:aws:iam::111111111111:role/x",
      ])
        expect(re.test(ng), ng).toBe(false);
    });
    it("全 Statement に aws:CalledViaAWSMCP 条件がある", () => {
      for (const s of statements)
        expect(s.Condition.StringEquals["aws:CalledViaAWSMCP"], s.Sid).toBe(
          "aws-mcp.amazonaws.com",
        );
    });
    it("kms:Decrypt は Secrets Manager / SSM 経由に限定される", () => {
      expect(byGroup("SecretDecrypt").Condition.StringLike).toEqual({
        "kms:ViaService": ["secretsmanager.*.amazonaws.com", "ssm.*.amazonaws.com"],
      });
    });
    it("iam:PassRole は ecs-tasks.amazonaws.com 宛に限定される", () => {
      expect(byGroup("PassRoleForEcsRunTask").Condition.StringEquals["iam:PassedToService"]).toBe(
        "ecs-tasks.amazonaws.com",
      );
    });
    it("kms:Decrypt と iam:PassRole はそれぞれ専用 Statement だけにある", () => {
      expect(allActions.filter((a) => a === "kms:Decrypt")).toHaveLength(1);
      expect(allActions.filter((a) => a === "iam:PassRole")).toHaveLength(1);
    });
    it("削除系・IAM 変更・組織変更・ワイルドカードを含まない", () => {
      for (const a of allActions) {
        expect(a, a).not.toMatch(/:(Delete|Terminate(?!Session)|Remove|Deregister)/);
        expect(a, a).not.toMatch(/^iam:(Create|Put|Attach|Update|Detach|Add|Set)/);
        expect(a, a).not.toMatch(/^organizations:/);
        expect(a, a).not.toContain("*");
      }
    });
    it("s3:PutObject を含まない（Athena の結果バケットは DebugAdditionalPolicyArns で足す）", () => {
      expect(allActions.some((a) => a.startsWith("s3:"))).toBe(false);
    });
    it("ポリシー文書が IAM インラインポリシーの上限 10,240 文字未満", () => {
      expect(JSON.stringify(doc).length).toBeLessThan(10240);
    });
  });
});

for (const role of ["ReadOnlyRole", "DebugRole"] as const) {
  describe(`信頼ポリシー (${role})`, () => {
    it("構造: Allow / AssumeRoleWithWebIdentity / Federated = provider", () => {
      const doc = trustPolicy(["user@example.com"], "awsbridge", role);
      expect(doc.Version).toBe("2012-10-17");
      expect(doc.Statement).toHaveLength(1);
      const s = doc.Statement[0];
      expect(s.Effect).toBe("Allow");
      expect(s.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(s.Principal).toEqual({ Federated: PROVIDER_ARN });
    });
    it("aud は StringEquals、sub は StringLike で、キーは <host>:aud / <host>:sub", () => {
      const c = trustPolicy(["user@example.com"], "my-aud", role).Statement[0].Condition;
      expect(Object.keys(c).sort()).toEqual(["StringEquals", "StringLike"]);
      expect(c.StringEquals).toEqual({ [`${HOST}:aud`]: "my-aud" });
      expect(Object.keys(c.StringLike)).toEqual([`${HOST}:sub`]);
    });
    it(`${SUBJECT_PARAM[role]} を全て含む（ワイルドカード可、1 件でも配列）`, () => {
      const many = ["user@example.com", "*@example.org", "other@example.net"];
      const sub = (v: string[]) =>
        trustPolicy(v, "awsbridge", role).Statement[0].Condition.StringLike[`${HOST}:sub`];
      expect(sub(many)).toEqual(many);
      expect(sub(["a@example.com"])).toEqual(["a@example.com"]);
    });
  });
}

describe("信頼ポリシーの利用者はロールごとに分かれる", () => {
  it("それぞれ別のパラメーターを参照する", () => {
    const ref = (role: RoleKind) =>
      JSON.stringify(tpl.Resources[role].Properties.AssumeRolePolicyDocument);
    expect(ref("ReadOnlyRole")).toContain("AllowedSubjects");
    expect(ref("ReadOnlyRole")).not.toContain("DebugAllowedSubjects");
    expect(ref("DebugRole")).toContain("DebugAllowedSubjects");
  });
});

describe("Outputs", () => {
  it("ReadOnlyRoleArn / DebugRoleArn / OidcProviderArn", () => {
    const o: Json = tpl.Outputs;
    expect(Object.keys(o).sort()).toEqual(["DebugRoleArn", "OidcProviderArn", "ReadOnlyRoleArn"]);
    expect(o.ReadOnlyRoleArn.Value).toEqual({ "Fn::GetAtt": ["ReadOnlyRole", "Arn"] });
    expect(o.DebugRoleArn.Value).toEqual({ "Fn::GetAtt": ["DebugRole", "Arn"] });
    expect(o.OidcProviderArn.Value).toEqual({ Ref: "OidcProvider" });
  });
});
