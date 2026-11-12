// コンソールログインのロールのテンプレート（種類の StackSet。参考の形）の生成器 src/console/template.ts。
// 設計: docs/specs/console-login.md §4.1・§4.3・§4.4・§4.7・§4.8・§6.3、console-login-portal.md §11.4。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { templateYaml } from "../../scripts/console/template-yaml";
import { ConsoleConfigError, parseConsoleConfig } from "../../src/console/config";
import { BASE_EXPORT_NAME, STOP_USER_INLINE_POLICY_NAME } from "../../src/console/reserved";
import { buildKindTemplate, buildKindTemplates } from "../../src/console/template";
import { evaluate, type Json, TEMPLATE_PATH } from "./cfn";
import { companyConfig } from "./console-fixtures";

const ACCOUNT = "111111111111";
const HOST = "id.example.com";
const PSEUDO = { "AWS::Partition": "aws", "AWS::AccountId": ACCOUNT };

const parsed = (raw: Json) => parseConsoleConfig(raw).config;

/** 会社用の設定（例のファイルと同じ名前のロール）: Standard の Viewer と Admin の Administrator。 */
function viewerAdminConfig(): Json {
  const c = companyConfig();
  c.roles = [
    {
      name: "administrator",
      roleName: "FederatedAwsBridgeAdministrator",
      tier: "admin",
      sessionSeconds: 3600,
      permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"] },
    },
    {
      name: "viewer",
      roleName: "FederatedAwsBridgeViewer",
      sessionSeconds: 43200,
      permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"] },
    },
  ];
  c.kinds = [
    { name: "A", assign: { administrator: ["infra-elevated"], viewer: ["sa", "infra"] } },
    {
      name: "C",
      assign: { administrator: ["infra-elevated", "dev-elevated"], viewer: ["sa", "infra", "dev"] },
    },
    { name: "P", assign: { viewer: ["sa", "infra", "dev"] } },
  ];
  c.organizations[0].kindOus = { A: ["ou-abcd-11111111"], C: ["ou-abcd-33333333"] };
  return c;
}

describe("信頼ポリシー（§4.3 の形）", () => {
  it("Viewer: その階層のプロバイダーだけ・aud・チームのタグの値・タグキーの制限・SourceIdentity 必須（完全一致）", () => {
    const tpl = buildKindTemplate(parsed(viewerAdminConfig()), "C");
    const doc = evaluate(tpl.Resources.ViewerRole.Properties.AssumeRolePolicyDocument, {
      ...PSEUDO,
      IssuerHost: HOST,
      StandardPath: "standard",
      ViewerTeams: "sa,infra",
    });
    expect(JSON.parse(doc)).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}/standard` },
          Action: ["sts:AssumeRoleWithWebIdentity", "sts:TagSession", "sts:SetSourceIdentity"],
          Condition: {
            StringEquals: {
              [`${HOST}/standard:aud`]: "awsbridge-console",
              "aws:RequestTag/awsbridge_team": ["sa", "infra"],
            },
            "ForAllValues:StringEquals": { "aws:TagKeys": ["awsbridge_team"] },
            Null: { "sts:SourceIdentity": "false" },
          },
        },
      ],
    });
  });
});

// ---- 共通の道具 ----

type Params = Record<string, string>;

/** Conditions の式（Fn::Equals / Fn::Not / Fn::And / Fn::Or / Condition）を、パラメーターで評価する。 */
function evalCondition(tpl: Json, expr: Json, params: Params): boolean {
  const [key] = Object.keys(expr);
  const arg = expr[key as string];
  if (key === "Condition") return evalCondition(tpl, tpl.Conditions[arg], params);
  if (key === "Fn::Equals") {
    const [a, b] = (arg as Json[]).map((v) => evaluate(v, params));
    return a === b;
  }
  if (key === "Fn::Not") return !evalCondition(tpl, arg[0], params);
  if (key === "Fn::And") return (arg as Json[]).every((e) => evalCondition(tpl, e, params));
  if (key === "Fn::Or") return (arg as Json[]).some((e) => evalCondition(tpl, e, params));
  throw new Error(`未対応の条件: ${key}`);
}

function conditions(tpl: Json, params: Params): Params {
  const full: Params = { ...defaults(tpl), ...params };
  return Object.fromEntries(
    Object.entries(tpl.Conditions ?? {}).map(([k, v]) => [k, String(evalCondition(tpl, v, full))]),
  );
}

/** パラメーター（既定値で補う）から、作られるリソースの名前を返す。 */
function created(tpl: Json, params: Params): string[] {
  const conds = conditions(tpl, params);
  return Object.entries(tpl.Resources as Record<string, Json>)
    .filter(([, v]) => v.Condition === undefined || conds[v.Condition] === "true")
    .map(([k]) => k)
    .sort();
}

function defaults(tpl: Json): Params {
  return Object.fromEntries(
    Object.entries(tpl.Parameters as Record<string, Json>)
      .filter(([, v]) => v.Default !== undefined)
      .map(([k, v]) => [k, String(v.Default)]),
  );
}

/** ロールのプロパティを、パラメーターと条件を入れて評価する。 */
function props(tpl: Json, logicalId: string, params: Params): Json {
  return evaluate(tpl.Resources[logicalId].Properties, {
    ...PSEUDO,
    ...defaults(tpl),
    ...params,
    ...conditions(tpl, params),
  });
}

const ADMIN_PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}/admin`;
const STD = { IssuerHost: HOST, StandardPath: "standard" };
const ALL = {
  ...STD,
  AdminProviderArn: ADMIN_PROVIDER,
  ViewerTeams: "sa,infra",
  AdministratorTeams: "infra-elevated",
};

const templateC = () => buildKindTemplate(parsed(viewerAdminConfig()), "C");
const statements = (p: Json, policyName: string) =>
  (p.Policies as Json[]).find((x) => x.PolicyName === policyName)?.PolicyDocument.Statement;
const allows = (p: Json) =>
  (p.Policies as Json[])
    .flatMap((x) => x.PolicyDocument.Statement as Json[])
    .filter((s) => s.Effect === "Allow");

describe("信頼ポリシー（Admin）", () => {
  it("Admin: Principal はパラメーターで受けた Admin のプロバイダーだけで、aud の条件キーはその issuer（完全一致）", () => {
    const doc = props(templateC(), "AdministratorRole", ALL).AssumeRolePolicyDocument;
    expect(JSON.parse(doc)).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: ADMIN_PROVIDER },
          Action: ["sts:AssumeRoleWithWebIdentity", "sts:TagSession", "sts:SetSourceIdentity"],
          Condition: {
            StringEquals: {
              [`${HOST}/admin:aud`]: "awsbridge-console",
              "aws:RequestTag/awsbridge_team": ["infra-elevated"],
            },
            "ForAllValues:StringEquals": { "aws:TagKeys": ["awsbridge_team"] },
            Null: { "sts:SourceIdentity": "false" },
          },
        },
      ],
    });
  });

  it("AdminProviderArn が既定（空）でも、組み込み関数の評価が失敗しない（Fn::Select が範囲外にならない）", () => {
    const p = props(templateC(), "AdministratorRole", {
      ...STD,
      AdministratorTeams: "infra-elevated",
    });
    expect(typeof p.AssumeRolePolicyDocument).toBe("string");
  });

  it("どちらの階層でも Allow の文は 1 つだけ（別の文で迂回できない）", () => {
    for (const id of ["ViewerRole", "AdministratorRole"]) {
      const doc = JSON.parse(props(templateC(), id, ALL).AssumeRolePolicyDocument);
      expect(doc.Statement, id).toHaveLength(1);
    }
  });
});

describe("Parameters", () => {
  const p = () => templateC().Parameters;

  it("IssuerHost・StandardPath は必須のスタック（base.yaml）と同じ形の規則", () => {
    const host = new RegExp(p().IssuerHost.AllowedPattern);
    for (const ok of ["id.example.com", "a"]) expect(host.test(ok), ok).toBe(true);
    for (const ng of ["https://id.example.com", "id.example.com/", "ID.example.com", "", 'a"b'])
      expect(host.test(ng), ng).toBe(false);
    expect(p().StandardPath.Default).toBe("std");
    const path = new RegExp(p().StandardPath.AllowedPattern);
    for (const ok of ["std", "p/p01/std"]) expect(path.test(ok), ok).toBe(true);
    for (const ng of ["/std", "std/", "STD", "", 'std"']) expect(path.test(ng), ng).toBe(false);
  });

  it("AdminProviderArn は既定が空で、空か OIDC プロバイダーの ARN だけを受け付ける（G1-b まで値は未確定）", () => {
    expect(p().AdminProviderArn.Default).toBe("");
    const re = new RegExp(p().AdminProviderArn.AllowedPattern);
    for (const ok of [
      "",
      ADMIN_PROVIDER,
      `arn:aws:iam::${ACCOUNT}:oidc-provider/admin.example.com/p/admin`,
    ])
      expect(re.test(ok), ok).toBe(true);
    for (const ng of [
      `arn:aws:iam::${ACCOUNT}:role/x`,
      `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}`,
      `${ADMIN_PROVIDER}"`,
      `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}/admin/`,
      "*",
    ])
      expect(re.test(ng), ng).toBe(false);
  });

  it("ロールごとの <Name>Teams: 既定は空。その種類で割り当てたチームの組み合わせだけを受け付ける（JSON に差し込めない）", () => {
    expect(p().ViewerTeams.Default).toBe("");
    expect(p().ViewerTeams.Type).toBe("String");
    const re = new RegExp(p().ViewerTeams.AllowedPattern);
    for (const ok of ["", "sa", "sa,infra", "dev,sa,infra"]) expect(re.test(ok), ok).toBe(true);
    for (const ng of ["infra-elevated", "sa,", ",sa", "sa,,infra", 'sa","x', "other", "sa infra"])
      expect(re.test(ng), ng).toBe(false);
    const admin = new RegExp(p().AdministratorTeams.AllowedPattern);
    expect(admin.test("infra-elevated,dev-elevated")).toBe(true);
    expect(admin.test("infra")).toBe(false);
  });

  it("その種類で割り当てのないロールのパラメーターは空だけを受け付ける", () => {
    const tpl = buildKindTemplate(parsed(viewerAdminConfig()), "P");
    const re = new RegExp(tpl.Parameters.AdministratorTeams.AllowedPattern);
    expect(re.test("")).toBe(true);
    expect(re.test("infra-elevated")).toBe(false);
  });

  it("パラメーターは StackSets 用の生成物（assignments[].parameters）のキーと、issuer の 3 つだけ", async () => {
    const { generateConsoleArtifacts } = await import("../../src/console/generate");
    const config = parsed(viewerAdminConfig());
    const { stacksets } = generateConsoleArtifacts(config, { mode: "check", generatedAt: "x" });
    for (const a of stacksets.assignments) {
      const tpl = buildKindTemplate(config, a.kind);
      expect(Object.keys(tpl.Parameters).sort(), a.kind).toEqual(
        [...Object.keys(a.parameters), "IssuerHost", "StandardPath", "AdminProviderArn"].sort(),
      );
      // 生成物の値はテンプレートの規則を満たす
      for (const [k, v] of Object.entries(a.parameters))
        expect(new RegExp(tpl.Parameters[k].AllowedPattern).test(v), `${a.kind} ${k}`).toBe(true);
    }
  });

  it("Admin の階層のロールがなければ AdminProviderArn を置かない", () => {
    const c = viewerAdminConfig();
    c.roles = c.roles.filter((r: Json) => r.name === "viewer");
    c.teams = c.teams.filter((t: Json) => t.tier !== "admin");
    c.portal.adminOrigin = undefined;
    for (const k of c.kinds) delete k.assign.administrator;
    const tpl = buildKindTemplate(parsed(c), "A");
    expect(Object.keys(tpl.Parameters).sort()).toEqual([
      "IssuerHost",
      "StandardPath",
      "ViewerTeams",
    ]);
  });
});

describe("Conditions: 割り当てのパラメーターが空のロールは作らない", () => {
  it("Viewer は ViewerTeams が空なら作らない", () => {
    expect(created(templateC(), { ...ALL, ViewerTeams: "" })).not.toContain("ViewerRole");
    expect(created(templateC(), ALL)).toContain("ViewerRole");
  });

  it("Administrator は AdministratorTeams と AdminProviderArn の両方があるときだけ作る", () => {
    expect(created(templateC(), ALL)).toContain("AdministratorRole");
    expect(created(templateC(), { ...ALL, AdministratorTeams: "" })).not.toContain(
      "AdministratorRole",
    );
    expect(created(templateC(), { ...ALL, AdminProviderArn: "" })).not.toContain(
      "AdministratorRole",
    );
    expect(created(templateC(), { ...STD })).toEqual([]);
  });

  it("すべてのリソースに Condition がある（割り当てのない種類では何も作らない）", () => {
    for (const [id, r] of Object.entries(templateC().Resources as Record<string, Json>))
      expect(r.Condition, id).toBeDefined();
  });
});

describe("ロールの形", () => {
  it("名前は設定の roleName、パスは /awsbridge-console/<tier>/、MaxSessionDuration は sessionSeconds", () => {
    const v = props(templateC(), "ViewerRole", ALL);
    expect(v.RoleName).toBe("FederatedAwsBridgeViewer");
    expect(v.Path).toBe("/awsbridge-console/std/");
    expect(v.MaxSessionDuration).toBe(43200);
    const a = props(templateC(), "AdministratorRole", ALL);
    expect(a.RoleName).toBe("FederatedAwsBridgeAdministrator");
    expect(a.Path).toBe("/awsbridge-console/admin/");
    expect(a.MaxSessionDuration).toBe(3600);
  });

  it("管理ポリシーは設定の ARN と、その階層の守りの部品（必須のスタックの Export を ImportValue）", () => {
    const v = props(templateC(), "ViewerRole", ALL);
    expect(v.ManagedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
      { "Fn::ImportValue": BASE_EXPORT_NAME.standardGuardPolicyArn },
    ]);
    const a = props(templateC(), "AdministratorRole", ALL);
    expect(a.ManagedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/AdministratorAccess",
      { "Fn::ImportValue": BASE_EXPORT_NAME.adminGuardPolicyArn },
    ]);
  });

  it("その種類で割り当てのないロールには守りの部品の ImportValue を出さない（Admin の Export が無い基盤でも解決しにいかない）", () => {
    const tpl = buildKindTemplate(parsed(viewerAdminConfig()), "P");
    const text = JSON.stringify(tpl);
    expect(text).not.toContain(BASE_EXPORT_NAME.adminGuardPolicyArn);
    expect(tpl.Resources.AdministratorRole.Properties.ManagedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/AdministratorAccess",
    ]);
    // 割り当てのあるロール（Viewer）には付く
    expect(tpl.Resources.ViewerRole.Properties.ManagedPolicyArns).toContainEqual({
      "Fn::ImportValue": BASE_EXPORT_NAME.standardGuardPolicyArn,
    });
  });

  it("SignInLocalDevelopmentAccess は付けない", () => {
    const text = JSON.stringify(templateC());
    expect(text.toLowerCase()).not.toContain("signinlocaldevelopmentaccess");
  });
});

describe("aws login の Allow（§4.4）", () => {
  const LOGIN_ACTIONS = ["signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token"];
  const arn = (client: string) => `arn:aws:signin:*:${ACCOUNT}:oauth2/public-client/${client}`;

  it("Standard: 2 つのアクションを localhost と remote だけに Allow", () => {
    const v = props(templateC(), "ViewerRole", ALL);
    expect(statements(v, "AwsLogin")).toEqual([
      {
        Sid: "AllowAwsLogin",
        Effect: "Allow",
        Action: LOGIN_ACTIONS,
        Resource: [arn("localhost"), arn("remote")],
      },
    ]);
  });

  it("Admin: 2 つのアクションを localhost だけに Allow。remote の Allow はどこにもない", () => {
    const a = props(templateC(), "AdministratorRole", ALL);
    expect(statements(a, "AwsLogin")).toEqual([
      {
        Sid: "AllowAwsLogin",
        Effect: "Allow",
        Action: LOGIN_ACTIONS,
        Resource: [arn("localhost")],
      },
    ]);
    expect(JSON.stringify(allows(a))).not.toContain("remote");
  });
});

describe("秘密値の読み取りの Deny（§4.7）", () => {
  it("Viewer（Standard の階層）: MCP 用の Viewer ロールと同じ文（SSM・Secrets Manager の値。条件なし）", () => {
    const mcp = parse(readFileSync(TEMPLATE_PATH, "utf8"), { customTags: [] });
    const expected = (mcp.Resources.ReadOnlyRole.Properties.Policies as Json[]).find(
      (x) => x.PolicyName === "DenySecretValueRead",
    ).PolicyDocument.Statement;
    const v = props(templateC(), "ViewerRole", ALL);
    expect(statements(v, "DenySecretValueRead")).toEqual(expected);
    for (const s of expected) expect(s.Condition).toBeUndefined();
  });

  it("Administrator（Admin の階層）には付けない", () => {
    const a = props(templateC(), "AdministratorRole", ALL);
    expect(statements(a, "DenySecretValueRead")).toBeUndefined();
  });
});

describe("1 人停止の予約名（§6.3。cto の回答 U-15）", () => {
  it("予約名のインラインポリシーを作らず、テンプレートのどこにもその名前を使わない", () => {
    for (const kind of ["A", "C", "P"]) {
      const tpl = buildKindTemplate(parsed(viewerAdminConfig()), kind);
      expect(JSON.stringify(tpl), kind).not.toContain(STOP_USER_INLINE_POLICY_NAME);
      for (const r of Object.values(tpl.Resources as Record<string, Json>)) {
        expect([
          "AWS::IAM::Policy",
          "AWS::IAM::RolePolicy",
          "AWS::IAM::ManagedPolicy",
        ]).not.toContain(r.Type);
        for (const pol of r.Properties.Policies ?? [])
          expect(pol.PolicyName).not.toBe(STOP_USER_INLINE_POLICY_NAME);
      }
    }
  });
});

describe("下流のポリシー文書（permissions.inlinePolicyFiles）", () => {
  const withFile = () => {
    const c = viewerAdminConfig();
    c.roles[1].permissions.inlinePolicyFiles = ["policies/viewer-extra.json"];
    return parsed(c);
  };
  const extra = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "ce:GetCostAndUsage", Resource: "*" }],
  };

  it("渡した文書を、上流の名前と重ならない名前のインラインポリシーとして付ける", () => {
    const tpl = buildKindTemplate(withFile(), "C", {
      inlinePolicies: { "policies/viewer-extra.json": extra },
    });
    const v = props(tpl, "ViewerRole", ALL);
    expect(statements(v, "InlinePolicy1")).toEqual(extra.Statement);
    expect((v.Policies as Json[]).map((x) => x.PolicyName)).toEqual([
      "AwsLogin",
      "DenySecretValueRead",
      "InlinePolicy1",
    ]);
  });

  it("文書が渡されなければ誤り（黙って落とさない）。パスと種別だけを出す", () => {
    expect(() => buildKindTemplate(withFile(), "C")).toThrowError(ConsoleConfigError);
    try {
      buildKindTemplate(withFile(), "C", { inlinePolicies: { "policies/viewer-extra.json": "x" } });
      expect.unreachable();
    } catch (e) {
      expect((e as ConsoleConfigError).issues).toEqual([
        { path: "roles[1].permissions.inlinePolicyFiles[0]", code: "type" },
      ]);
    }
    try {
      buildKindTemplate(withFile(), "C");
    } catch (e) {
      expect((e as ConsoleConfigError).issues).toEqual([
        { path: "roles[1].permissions.inlinePolicyFiles[0]", code: "required" },
      ]);
    }
  });
});

describe("種類", () => {
  it("設定にない種類は誤り", () => {
    expect(() => buildKindTemplate(parsed(viewerAdminConfig()), "Z")).toThrowError(
      ConsoleConfigError,
    );
  });

  it("buildKindTemplates は種類ごとに StackSet の名前（awsbridge-console-kind-<kind>）とテンプレートを返す", () => {
    const config = parsed(viewerAdminConfig());
    const all = buildKindTemplates(config);
    expect(all.map((k) => [k.kind, k.stackSetName])).toEqual([
      ["A", "awsbridge-console-kind-A"],
      ["C", "awsbridge-console-kind-C"],
      ["P", "awsbridge-console-kind-P"],
    ]);
    expect(all[1]?.template).toEqual(buildKindTemplate(config, "C"));
  });

  it("テンプレートに時刻などの変わる値を入れない（同じ設定から同じものができる）", () => {
    expect(JSON.stringify(templateC())).toBe(JSON.stringify(templateC()));
    expect(templateC().AWSTemplateFormatVersion).toBe("2010-09-09");
  });
});

describe("参考のテンプレート（infra/aws/console/kind.example.yaml）", () => {
  const root = resolve(import.meta.dirname, "../..");
  it("会社用の例（config/console.company.example.json）の種類 C から生成したものと一致する", () => {
    const config = parsed(
      readFileSync(resolve(root, "config/console.company.example.json"), "utf8"),
    );
    const file = parse(readFileSync(resolve(root, "infra/aws/console/kind.example.yaml"), "utf8"), {
      customTags: [],
    });
    expect(file).toEqual(buildKindTemplate(config, "C"));
  });

  it("ファイルの文字列も、生成器の出力を YAML にしたものと一致する（直すときは mise run console:template:example）", () => {
    const config = parsed(
      readFileSync(resolve(root, "config/console.company.example.json"), "utf8"),
    );
    expect(readFileSync(resolve(root, "infra/aws/console/kind.example.yaml"), "utf8")).toBe(
      templateYaml(buildKindTemplate(config, "C")),
    );
  });

  it("mise の lint が cfn-lint で検査する", () => {
    const toml = readFileSync(resolve(root, "mise.toml"), "utf8");
    const rest = toml.slice(toml.indexOf("[tasks.lint]") + 1);
    expect(rest.slice(0, rest.search(/^\[/m))).toContain(
      "cfn-lint infra/aws/console/kind.example.yaml",
    );
  });
});
