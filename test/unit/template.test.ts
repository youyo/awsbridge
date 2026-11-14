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
    expect(p.ReadOnlyRoleName.Default).toBe("FederatedAwsBridgeMcpViewer");
    expect(p.DebugRoleName.Default).toBe("FederatedAwsBridgeMcpDebugger");
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
      expect(re.test("FederatedAwsBridgeMcpViewer")).toBe(true);
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
  // 秘密値を API で直接読む操作。両ロールで無条件に Deny する（ReadOnlyAccess の ssm:Get* や、
  // DebugAdditionalPolicyArns で足した管理ポリシーの Allow より Deny が優先する）
  const SECRET_DENIES: Record<string, string[]> = {
    DenySsmParameterRead: [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
    ],
    DenySecretsManagerRead: ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"],
  };
  const SECRET_ACTIONS = Object.values(SECRET_DENIES).flat();
  const inlineStatements = (role: RoleKind): Json[] =>
    evaluate(tpl.Resources[role].Properties.Policies[0].PolicyDocument.Statement, {
      HasDebugPassableEcsTaskRoles: "true",
      DebugPassableEcsTaskRoleArns: ["arn:aws:iam::111111111111:role/task-a"],
    });
  for (const role of ["ReadOnlyRole", "DebugRole"] as const) {
    it(`${role} は SSM パラメーターと Secrets Manager の値の取得を無条件で明示 Deny する`, () => {
      const statements = inlineStatements(role);
      for (const [sid, expected] of Object.entries(SECRET_DENIES)) {
        const st = statements.find((s: Json) => s.Sid === sid);
        expect(st, sid).toBeDefined();
        expect(st.Effect, sid).toBe("Deny");
        expect([...st.Action].sort(), sid).toEqual([...expected].sort());
        expect(st.Resource, sid).toBe("*");
        // AWS MCP を経由しても、直接呼んでも効くよう条件を付けない
        expect(st.Condition, sid).toBeUndefined();
      }
    });
    it(`${role} のどの Allow にも秘密値の取得（SSM・Secrets Manager・kms:Decrypt）を含めない`, () => {
      const allows = inlineStatements(role).filter((s: Json) => s.Effect === "Allow");
      for (const s of allows) {
        const acts: string[] = Array.isArray(s.Action) ? s.Action : [s.Action];
        for (const a of acts) {
          expect(SECRET_ACTIONS, `${s.Sid}: ${a}`).not.toContain(a);
          expect(a, s.Sid).not.toMatch(/^ssm:GetParameter/);
          expect(a, s.Sid).not.toMatch(/^secretsmanager:/);
          expect(a, s.Sid).not.toBe("kms:Decrypt");
        }
      }
    });
  }
  it("ReadOnlyRole のインラインポリシーは秘密値の取得の Deny だけ", () => {
    const policies = tpl.Resources.ReadOnlyRole.Properties.Policies;
    expect(policies).toHaveLength(1);
    const doc = policies[0].PolicyDocument;
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement.map((s: Json) => s.Sid).sort()).toEqual(Object.keys(SECRET_DENIES).sort());
    for (const st of doc.Statement) expect(st.Effect, st.Sid).toBe("Deny");
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
        "bedrock:StartIngestionJob",
        "bedrock:StopIngestionJob",
        // 止める・再起動する（見直し表の「入れる候補」）
        "states:StopExecution",
        "glue:BatchStopJobRun",
        "glue:StopCrawler",
        "codebuild:RetryBuild",
        "codebuild:StopBuild",
        "autoscaling:SuspendProcesses",
        "autoscaling:ResumeProcesses",
        "rds:FailoverDBCluster",
        "rds:RebootDBCluster",
        "elasticache:TestFailover",
        "elasticbeanstalk:RestartAppServer",
        // 止める・抑える系（見直し表の「判断」から利用者が選んだもの）
        "cloudwatch:DisableAlarmActions",
        "cloudwatch:EnableAlarmActions",
        "events:EnableRule",
        "events:DisableRule",
        "events:CancelReplay",
        "autoscaling:SetInstanceHealth",
        "autoscaling:EnterStandby",
        "autoscaling:ExitStandby",
        "rds:StartDBInstance",
        "rds:StopDBInstance",
        "rds:StartDBCluster",
        "rds:StopDBCluster",
        "ssm:StopAutomationExecution",
        "batch:CancelJob",
        "codepipeline:StopPipelineExecution",
      ],
      // 費用がかかる操作（モデル・推論の呼び出し、スナップショット、プロビジョンド同時実行）
      CostIncurring: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ApplyGuardrail",
        "bedrock:RetrieveAndGenerate",
        "sagemaker:InvokeEndpoint",
        "sagemaker:InvokeEndpointAsync",
        "rds:CreateDBSnapshot",
        "rds:CreateDBClusterSnapshot",
        "ec2:CreateSnapshot",
        "lambda:PutProvisionedConcurrencyConfig",
        // 評価・プロンプト最適化のジョブ（セッションを切っても走り続けるので、止める Stop も入れる）
        "bedrock:OptimizePrompt",
        "bedrock:CreateEvaluationJob",
        "bedrock:StopEvaluationJob",
        "bedrock:CreateAdvancedPromptOptimizationJob",
        "bedrock:StopAdvancedPromptOptimizationJob",
        // バッチ推論・文字起こし（どちらもジョブを作る。バッチ推論には Stop がある）
        "bedrock:CreateModelInvocationJob",
        "bedrock:StopModelInvocationJob",
        "transcribe:StartTranscriptionJob",
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
        // 業務ロジック・デプロイの実行
        "states:RedriveExecution",
        "states:StartSyncExecution",
        "bedrock:InvokeAgent",
        "lambda:InvokeFunctionUrl",
        "glue:StartCrawler",
        "glue:StartWorkflowRun",
        "ssm:StartAutomationExecution",
        "events:StartReplay",
        "events:PutEvents",
        "codepipeline:RetryStageExecution",
      ],
      PassRoleForEcsRunTask: ["iam:PassRole"],
      PassRoleForBedrockJobs: ["iam:PassRole"],
    };
    // 値を指定したときだけ付く Statement（Fn::If で出し分ける）
    const OPTIONAL_SIDS = ["PassRoleForEcsRunTask", "PassRoleForBedrockJobs"];
    // 秘密値の取得を塞ぐ無条件の Deny（AWS MCP を経由しても読めない）
    const DENY_SIDS = Object.keys(SECRET_DENIES);
    const policies = tpl.Resources.DebugRole.Properties.Policies;
    const doc = policies[0].PolicyDocument;
    const PASSABLE = ["arn:aws:iam::111111111111:role/task-a", "arn:aws:iam::111111111111:role/b"];
    const BEDROCK_ROLES = [
      "arn:aws:iam::111111111111:role/eval-a",
      "arn:aws:iam::111111111111:role/path/eval-b",
    ];
    // 2 つの任意パラメーターの指定の有無ごとの Statement 一覧（Fn::If を評価済み）
    const build = (on: { ecs: boolean; bedrock: boolean }): Json[] =>
      evaluate(doc.Statement, {
        HasDebugPassableEcsTaskRoles: String(on.ecs),
        DebugPassableEcsTaskRoleArns: on.ecs ? PASSABLE : [""],
        HasDebugPassableBedrockServiceRoles: String(on.bedrock),
        DebugPassableBedrockServiceRoleArns: on.bedrock ? BEDROCK_ROLES : [""],
      });
    // すべて指定したときの Statement 一覧
    const withPassable: Json[] = build({ ecs: true, bedrock: true });
    // ECS のロールだけ空のとき
    const withoutPassable: Json[] = build({ ecs: false, bedrock: true });
    // 既定（2 つとも空）のとき
    const withoutOptional: Json[] = build({ ecs: false, bedrock: false });
    const statements = withPassable;
    const byGroup = (sid: string): Json => statements.find((s: Json) => s.Sid === sid);
    const actions = (s: Json): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
    const allActions: string[] = statements.flatMap(actions);
    const allowStatements = statements.filter((s: Json) => s.Effect === "Allow");

    it("DebugRole は ReadOnlyAccess + インラインポリシー 1 つ", () => {
      expect(managed("DebugRole")).toEqual([readOnlyAccess("aws-cn")]);
      expect(policies).toHaveLength(1);
      expect(typeof policies[0].PolicyName).toBe("string");
      expect(doc.Version).toBe("2012-10-17");
    });
    it("Statement は想定のグループと秘密値の取得の Deny だけ", () => {
      expect(statements.map((s: Json) => s.Sid).sort()).toEqual(
        [...Object.keys(GROUPS), ...DENY_SIDS].sort(),
      );
      expect(allowStatements.map((s: Json) => s.Sid).sort()).toEqual(Object.keys(GROUPS).sort());
    });
    for (const [sid, expected] of Object.entries(GROUPS)) {
      it(`${sid} の Action と Resource`, () => {
        const s = byGroup(sid);
        expect(s.Effect).toBe("Allow");
        expect([...actions(s)].sort()).toEqual([...expected].sort());
        if (sid === "PassRoleForEcsRunTask") expect(s.Resource).toEqual(PASSABLE);
        else if (sid === "PassRoleForBedrockJobs") expect(s.Resource).toEqual(BEDROCK_ROLES);
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
      // ECS 用が空でも、Bedrock 用を指定していればそちらの iam:PassRole だけが残る
      expect(
        withoutPassable
          .filter((s: Json) => actions(s).includes("iam:PassRole"))
          .map((s: Json) => s.Sid),
      ).toEqual(["PassRoleForBedrockJobs"]);
      expect(withoutPassable.map((s: Json) => s.Sid).sort()).toEqual(
        [...Object.keys(GROUPS).filter((k) => k !== "PassRoleForEcsRunTask"), ...DENY_SIDS].sort(),
      );
      expect(withoutPassable.flatMap(actions)).toContain("ecs:RunTask");
    });
    it("2 つの任意パラメーターが空（既定）なら iam:PassRole の Statement は出ない", () => {
      expect(withoutOptional.map((s: Json) => s.Sid).sort()).toEqual(
        [...Object.keys(GROUPS).filter((k) => !OPTIONAL_SIDS.includes(k)), ...DENY_SIDS].sort(),
      );
      expect(withoutOptional.flatMap(actions)).not.toContain("iam:PassRole");
    });
    it("DebugPassableBedrockServiceRoleArns は空が既定の CommaDelimitedList で、条件は『空でない』（列挙のまま）", () => {
      const param = "DebugPassableBedrockServiceRoleArns";
      expect(tpl.Parameters[param].Type).toBe("CommaDelimitedList");
      expect(tpl.Parameters[param].Default).toBe("");
      expect(tpl.Conditions.HasDebugPassableBedrockServiceRoles).toEqual({
        "Fn::Not": [{ "Fn::Equals": [{ "Fn::Join": ["", { Ref: param }] }, ""] }],
      });
    });
    it("S3 書き込み用のパラメーター・条件・Statement（WriteToListedBuckets / DataWrite）は無い", () => {
      expect(tpl.Parameters.DebugWritableS3BucketArns).toBeUndefined();
      expect(tpl.Conditions.HasDebugWritableS3Buckets).toBeUndefined();
      for (const list of [withPassable, withoutOptional])
        for (const sid of ["WriteToListedBuckets", "DataWrite"])
          expect(
            list.map((s: Json) => s.Sid),
            sid,
          ).not.toContain(sid);
    });
    it("PassRoleForBedrockJobs は MCP 経由・bedrock.amazonaws.com 宛の iam:PassRole だけ", () => {
      const s = byGroup("PassRoleForBedrockJobs");
      expect(s.Effect).toBe("Allow");
      expect(s.Action).toEqual(["iam:PassRole"]);
      expect(s.Resource).toEqual(BEDROCK_ROLES);
      expect(s.Condition).toEqual({
        StringEquals: {
          "aws:CalledViaAWSMCP": "aws-mcp.amazonaws.com",
          "iam:PassedToService": "bedrock.amazonaws.com",
        },
      });
    });
    it("評価・バッチ推論・文字起こしの追加アクションが CostIncurring にあり、BatchDelete 系は無い", () => {
      for (const a of [
        "bedrock:OptimizePrompt",
        "bedrock:CreateEvaluationJob",
        "bedrock:StopEvaluationJob",
        "bedrock:CreateAdvancedPromptOptimizationJob",
        "bedrock:StopAdvancedPromptOptimizationJob",
        "bedrock:CreateModelInvocationJob",
        "bedrock:StopModelInvocationJob",
        "transcribe:StartTranscriptionJob",
      ])
        expect(actions(byGroup("CostIncurring")), a).toContain(a);
      expect(allActions).not.toContain("bedrock:BatchDeleteEvaluationJob");
      for (const a of allActions) expect(a, a).not.toMatch(/BatchDelete/);
    });
    for (const param of ["DebugPassableEcsTaskRoleArns", "DebugPassableBedrockServiceRoleArns"]) {
      it(`${param} のパターン（ワイルドカード不可）`, () => {
        const re = new RegExp(tpl.Parameters[param].AllowedPattern);
        for (const ok of [
          "arn:aws:iam::111111111111:role/task-a",
          "arn:aws-cn:iam::111111111111:role/path/to/role",
          "",
        ])
          expect(re.test(ok), ok).toBe(true);
        for (const ng of [
          "*",
          "arn:aws:iam::111111111111:role/*",
          "arn:aws:iam::111111111111:role/ev*l",
          "arn:aws:iam::111111111111:policy/x",
          "arn:aws:iam::1111:role/x",
          "arn:aws:iam::111111111111:role/",
          'arn:aws:iam::111111111111:role/a"b',
          " arn:aws:iam::111111111111:role/x",
        ])
          expect(re.test(ng), ng).toBe(false);
      });
    }
    it("全 Allow Statement に aws:CalledViaAWSMCP 条件（StringEquals）がある", () => {
      for (const s of allowStatements)
        expect(s.Condition.StringEquals["aws:CalledViaAWSMCP"], s.Sid).toBe(
          "aws-mcp.amazonaws.com",
        );
    });
    it("Deny は秘密値の取得の 2 つだけで、どちらも条件を持たない", () => {
      const deny = statements.filter((s: Json) => s.Effect === "Deny");
      expect(deny.map((s: Json) => s.Sid).sort()).toEqual([...DENY_SIDS].sort());
      for (const s of deny) expect(s.Condition, s.Sid).toBeUndefined();
    });
    describe("秘密値の取得の評価（IAM の条件の評価規則を模す）", () => {
      // 条件演算子の規則: キーが無いとき、肯定の演算子は false、否定の演算子は true
      // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html
      const conditionMatches = (cond: Json, ctx: Record<string, string>): boolean =>
        Object.entries(cond ?? {}).every(([op, kv]) =>
          Object.entries(kv as Record<string, string | string[]>).every(([key, want]) => {
            const wants = Array.isArray(want) ? want : [want];
            const got = ctx[key];
            if (op === "StringEquals") return got !== undefined && wants.includes(got);
            if (op === "StringNotEquals") return got === undefined || !wants.includes(got);
            throw new Error(`未対応の演算子 ${op}`);
          }),
        );
      // インラインポリシーだけで判定する（ReadOnlyAccess や追加の管理ポリシーの Allow があっても Deny が優先する）
      const decide = (action: string, ctx: Record<string, string>) => {
        const hits = statements.filter(
          (s: Json) => actions(s).includes(action) && conditionMatches(s.Condition, ctx),
        );
        if (hits.some((s: Json) => s.Effect === "Deny")) return "Deny";
        return "Deny ではない";
      };
      const MCP = { "aws:CalledViaAWSMCP": "aws-mcp.amazonaws.com" };
      for (const a of SECRET_ACTIONS) {
        it(`${a}: 直接の呼び出し（キーなし）は Deny`, () => {
          expect(decide(a, {})).toBe("Deny");
        });
        it(`${a}: AWS MCP 経由でも Deny`, () => {
          expect(decide(a, MCP)).toBe("Deny");
        });
      }
    });
    it("見直しで入れないと決めた操作を含まない", () => {
      for (const a of [
        "codepipeline:StartPipelineExecution", // sourceRevisions・variables で差し替えられる
        "codebuild:StartBuild",
        "glue:StartJobRun", // Arguments の上書きで、ジョブのロールの権限で任意のコードを動かせる
        "batch:SubmitJob", // containerOverrides のコマンド・環境変数の上書きで同上
        "states:TestState",
        "cloudwatch:SetAlarmState",
        "autoscaling:StartInstanceRefresh",
        "autoscaling:CancelInstanceRefresh",
        "logs:Unmask",
        "sqs:StartMessageMoveTask",
        "sqs:CancelMessageMoveTask",
        "batch:TerminateJob",
        "sts:AssumeRole",
        "ssm:PutParameter",
        "lambda:UpdateFunctionCode",
      ])
        expect(allActions, a).not.toContain(a);
    });
    it("どの Allow にも secretsmanager:GetSecretValue・kms:Decrypt・ssm:GetParameter* を含めない", () => {
      const all = [...withPassable, ...withoutPassable].filter((s: Json) => s.Effect === "Allow");
      for (const s of all)
        for (const a of actions(s)) {
          expect(a, s.Sid).not.toMatch(/^ssm:GetParameter/);
          expect(a, s.Sid).not.toBe("secretsmanager:GetSecretValue");
          expect(a, s.Sid).not.toBe("secretsmanager:BatchGetSecretValue");
          expect(a, s.Sid).not.toBe("kms:Decrypt");
        }
      expect(allActions).not.toContain("kms:Decrypt");
    });
    it("SecretRead / SecretDecrypt / DenyParameterReadOutsideMCP の Statement は無い", () => {
      const sids = statements.map((s: Json) => s.Sid);
      for (const sid of ["SecretRead", "SecretDecrypt", "DenyParameterReadOutsideMCP"])
        expect(sids).not.toContain(sid);
    });
    it("リモート実行系は残す", () => {
      for (const a of [
        "ssm:SendCommand",
        "ssm:StartSession",
        "ecs:ExecuteCommand",
        "ecs:RunTask",
        "lambda:InvokeFunction",
        "iam:PassRole",
        "rds-db:connect",
      ])
        expect(allActions, a).toContain(a);
    });
    it("iam:PassRole は ecs-tasks.amazonaws.com 宛に限定される", () => {
      expect(byGroup("PassRoleForEcsRunTask").Condition.StringEquals["iam:PassedToService"]).toBe(
        "ecs-tasks.amazonaws.com",
      );
    });
    it("iam:PassRole は専用の Statement（ECS 用・Bedrock 用）だけにある", () => {
      expect(allActions.filter((a) => a === "iam:PassRole")).toHaveLength(2);
      for (const s of allowStatements.filter((x: Json) => actions(x).includes("iam:PassRole")))
        expect(["PassRoleForEcsRunTask", "PassRoleForBedrockJobs"], s.Sid).toContain(s.Sid);
    });
    it("削除系・IAM 変更・組織変更・ワイルドカードを含まない", () => {
      for (const a of allActions) {
        expect(a, a).not.toMatch(/:(Delete|Terminate(?!Session)|Remove|Deregister)/);
        expect(a, a).not.toMatch(/^iam:(Create|Put|Attach|Update|Detach|Add|Set)/);
        expect(a, a).not.toMatch(/^organizations:/);
        expect(a, a).not.toContain("*");
      }
    });
    it("インラインポリシーの Allow に s3 の操作が 1 つも無い（書き込み・ACL・タグ・削除・バケット設定・読み取り）", () => {
      for (const list of [withPassable, withoutPassable, withoutOptional])
        for (const st of list.filter((x: Json) => x.Effect === "Allow"))
          for (const a of actions(st)) expect(a, st.Sid).not.toMatch(/^s3/);
      for (const a of [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:PutObjectAcl",
        "s3:PutObjectTagging",
        "s3:PutObjectVersionAcl",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:PutBucketPolicy",
        "s3:PutBucketAcl",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutEncryptionConfiguration",
        "s3:GetObject",
      ])
        expect(allActions, a).not.toContain(a);
    });
    it("ポリシー文書が IAM インラインポリシーの上限 10,240 文字未満（2 つとも値があるときの最大の形）", () => {
      // 空白を含む JSON.stringify で測るので、IAM の数え方（空白を除く）より厳しい
      const longRole = (i: number) =>
        `arn:aws:iam::111111111111:role/${"r".repeat(40)}${i}`.padEnd(100, "x");
      const max = evaluate(doc.Statement, {
        HasDebugPassableEcsTaskRoles: "true",
        DebugPassableEcsTaskRoleArns: [1, 2, 3].map(longRole),
        HasDebugPassableBedrockServiceRoles: "true",
        DebugPassableBedrockServiceRoleArns: [4, 5, 6].map(longRole),
      });
      expect(JSON.stringify({ ...doc, Statement: max }).length).toBeLessThan(10240);
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
