// コンソールログイン: 設定の roles[] と kinds[] から、種類の StackSet（awsbridge-console-kind-<kind>）のロールのテンプレート
// （CloudFormation。参考の形）を作る。設計: docs/specs/console-login.md §4.1・§4.3・§4.4・§4.7・§4.8・§6.3、
// console-login-portal.md §11.4（K1）。副作用のない純粋関数だけを置く（直列化とファイルの読み書きは scripts/console/config.ts）。
// MCP 用 Worker からは import しない。
//
// テンプレートの形:
//   - 設定のすべてのロールを、どの種類のテンプレートにも置く（StackSets 用の生成物 stacksets.json は、種類ごとに
//     すべてのロールの <Name>Teams を渡すため。割り当てのないロールは空文字）。ロールは Conditions で、
//     <Name>Teams が空でないときだけ作る。<Name>Teams の AllowedPattern は、その種類でそのロールに割り当てたチームの
//     組み合わせだけを受け付ける（割り当てのないロールは空だけ）。信頼ポリシーの JSON に差し込む値の形も、これで絞る
//   - Standard の階層: Principal は https://<IssuerHost>/<StandardPath> のプロバイダー（必須のスタックと同じパラメーター。
//     base.yaml はプロバイダーの ARN を Export しない）
//   - Admin の階層: Principal は https://<AdminIssuerHost>/<AdminPath> のプロバイダー（必須のスタックと同じパラメーター。
//     ARN はアカウント ID を AWS::AccountId から組むので、StackSet で 1 つの値にできる）。AdminIssuerHost が空なら
//     Admin の階層のロールは作らない（cto の決裁 2026-11-13 の P-A）
//   - 権限: 設定の AWS 管理ポリシー、その階層の守りの部品（必須のスタックの Export を ImportValue）、aws login の Allow
//     （Standard は localhost と remote、Admin は localhost だけ）、Standard の階層は秘密値の読み取りの Deny（§4.7）、
//     下流のポリシー文書（permissions.inlinePolicyFiles。中身は呼び出し側が読んで渡す）
//   - MaxSessionDuration: Admin の階層はちょうど 3600（AWS が強制できる最短）、Standard は sessionSeconds。Admin の sessionSeconds が
//     3600 を超える設定は作らない（admin_session_seconds。cto の決裁 G2 の論点 5）
//   - 1 人停止の Deny のインラインポリシー（予約名 STOP_USER_INLINE_POLICY_NAME）は作らず、名前も使わない（§6.3。cto の回答 U-15）

import {
  type ConsoleConfig,
  ConsoleConfigError,
  type ConsoleRole,
  IssueList,
  teamsParameterName,
} from "./config";
import {
  ADMIN_MAX_SESSION_SECONDS,
  AUDIENCE,
  roleMaxSessionDuration,
  rolePath,
  TEAM_TAG_KEY,
  type Tier,
} from "./constants";
import { BASE_EXPORT_NAME } from "./reserved";

// biome-ignore lint/suspicious/noExplicitAny: CloudFormation のテンプレートは任意の形をとる
export type CfnTemplate = Record<string, any>;

export type TemplateOptions = {
  /** 下流のポリシー文書（permissions.inlinePolicyFiles のパス → JSON として読んだ中身）。 */
  inlinePolicies?: Record<string, unknown>;
};

export type KindTemplate = { kind: string; stackSetName: string; template: CfnTemplate };

/** 種類の StackSet の名前（console-login.md §3.5）。 */
export const kindStackSetName = (kind: string) => `awsbridge-console-kind-${kind}`;

/** ロールの論理 ID の元（viewer → Viewer、read-only → ReadOnly）。パラメーター名（<Name>Teams）と同じ規則。 */
const roleKey = (role: ConsoleRole) => teamsParameterName(role.name).replace(/Teams$/, "");

const ISSUER_HOST_PATTERN = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$";
const ISSUER_PATH_PATTERN = "^[a-z0-9-]+(/[a-z0-9-]+)*$";
/** Admin の issuer のホスト。空（Admin の階層なし）か、IssuerHost と同じ規則のホスト名。 */
const ADMIN_ISSUER_HOST_PATTERN = `^$|${ISSUER_HOST_PATTERN}`;

const HAS_ADMIN_PROVIDER = "HasAdminProvider";
/** Fn::Sub の変数の参照（${Name}）。 */
const v = (name: string) => `\${${name}}`;
const LOGIN_ACTIONS = ["signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token"];
const loginResource = (client: "localhost" | "remote") => ({
  "Fn::Sub": `arn:\${AWS::Partition}:signin:*:\${AWS::AccountId}:oauth2/public-client/${client}`,
});

/** MCP 用の Viewer ロール（infra/aws/awsbridge.yaml の ReadOnlyRole）と同じ文。条件なし。 */
const DENY_SECRET_VALUE_READ = [
  {
    Sid: "DenySsmParameterRead",
    Effect: "Deny",
    Action: [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
    ],
    Resource: "*",
  },
  {
    Sid: "DenySecretsManagerRead",
    Effect: "Deny",
    Action: ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"],
    Resource: "*",
  },
];

const GUARD_EXPORT: Record<Tier, string> = {
  standard: BASE_EXPORT_NAME.standardGuardPolicyArn,
  admin: BASE_EXPORT_NAME.adminGuardPolicyArn,
};

/** チーム名の組み合わせ（カンマ区切り）だけを受け付ける AllowedPattern。チームがなければ空だけ。 */
function teamsPattern(teams: string[]): string {
  if (teams.length === 0) return "^$";
  const one = `(${teams.join("|")})`;
  return `^$|^${one}(,${one})*$`;
}

/**
 * 信頼ポリシー（§4.3 の形）。Fn::Sub の JSON 文字列にする（条件キーに issuer のホストが入り、
 * CloudFormation はマップのキーに組み込み関数を使えないため。infra/aws/awsbridge.yaml と同じ）。
 * 差し込む値（Issuer・Principal・Teams）は、パラメーターの AllowedPattern で形を絞る。
 */
function trustPolicy(teamsParam: string, issuer: unknown, principal: unknown) {
  const doc = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: v("Principal") },
        Action: ["sts:AssumeRoleWithWebIdentity", "sts:TagSession", "sts:SetSourceIdentity"],
        Condition: {
          StringEquals: {
            [`${v("Issuer")}:aud`]: AUDIENCE,
            [`aws:RequestTag/${TEAM_TAG_KEY}`]: [v("Teams")],
          },
          "ForAllValues:StringEquals": { "aws:TagKeys": [TEAM_TAG_KEY] },
          Null: { "sts:SourceIdentity": "false" },
        },
      },
    ],
  };
  return {
    "Fn::Sub": [
      JSON.stringify(doc, null, 2),
      {
        Issuer: issuer,
        Principal: principal,
        Teams: { "Fn::Join": ['","', { "Fn::Split": [",", { Ref: teamsParam }] }] },
      },
    ],
  };
}

/** 階層ごとの issuer のホストとパスのパラメーター（必須のスタック base.yaml と同じ名前）。 */
const ISSUER_PARAMS: Record<Tier, { host: string; path: string }> = {
  standard: { host: "IssuerHost", path: "StandardPath" },
  admin: { host: "AdminIssuerHost", path: "AdminPath" },
};

/** 階層ごとの Principal（プロバイダーの ARN）と、条件キーの issuer（<host>/<path>）。 */
function provider(tier: Tier): { issuer: unknown; principal: unknown } {
  const { host, path } = ISSUER_PARAMS[tier];
  return {
    issuer: { "Fn::Sub": `${v(host)}/${v(path)}` },
    principal: {
      "Fn::Sub": `arn:${v("AWS::Partition")}:iam::${v("AWS::AccountId")}:oidc-provider/${v(host)}/${v(path)}`,
    },
  };
}

/** 下流のポリシー文書を、ロールの index → 文書の並びにする（足りない・形が違うものは誤り）。 */
function resolveInline(config: ConsoleConfig, options: TemplateOptions): Map<number, unknown[]> {
  const out = new IssueList();
  const docs = new Map<number, unknown[]>();
  config.roles.forEach((role, i) => {
    const list: unknown[] = [];
    role.inlinePolicyFiles.forEach((file, j) => {
      const p = `roles[${i}].permissions.inlinePolicyFiles[${j}]`;
      const inline = options.inlinePolicies;
      if (inline === undefined || !Object.hasOwn(inline, file)) {
        out.add(p, "required");
        return;
      }
      const doc = inline[file];
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        out.add(p, "type");
        return;
      }
      list.push(doc);
    });
    docs.set(i, list);
  });
  if (out.items.length > 0) throw new ConsoleConfigError(out.items);
  return docs;
}

function build(config: ConsoleConfig, kind: string, inline: Map<number, unknown[]>): CfnTemplate {
  const k = config.kinds.find((x) => x.name === kind);
  if (!k) throw new ConsoleConfigError([{ path: "kind", code: "unknown_kind" }]);
  const tiers = new Set(config.roles.map((r) => r.tier));

  const parameters: CfnTemplate = {};
  const conditions: CfnTemplate = {};
  const resources: CfnTemplate = {};
  if (tiers.has("standard")) {
    parameters.IssuerHost = {
      Type: "String",
      Description:
        "Host of the console login issuer, without scheme, path or trailing slash. Same value as the base stack.",
      AllowedPattern: ISSUER_HOST_PATTERN,
      MaxLength: 180,
    };
    parameters.StandardPath = {
      Type: "String",
      Default: "standard",
      Description: "Path of the Standard tier issuer. Same value as the base stack.",
      AllowedPattern: ISSUER_PATH_PATTERN,
      MaxLength: 64,
    };
  }
  if (tiers.has("admin")) {
    parameters.AdminIssuerHost = {
      Type: "String",
      Default: "",
      Description:
        "Host of the Admin tier issuer (separate from IssuerHost). Same value as the base stack. Empty: the Admin tier roles are not created.",
      AllowedPattern: ADMIN_ISSUER_HOST_PATTERN,
      MaxLength: 180,
    };
    parameters.AdminPath = {
      Type: "String",
      Default: "admin",
      Description: "Path of the Admin tier issuer. Same value as the base stack.",
      AllowedPattern: ISSUER_PATH_PATTERN,
      MaxLength: 64,
    };
    conditions[HAS_ADMIN_PROVIDER] = {
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "AdminIssuerHost" }, ""] }],
    };
  }

  config.roles.forEach((role, i) => {
    const key = roleKey(role);
    const teamsParam = teamsParameterName(role.name);
    const teams = k.assign.find((a) => a.role === role.name)?.teams ?? [];
    parameters[teamsParam] = {
      Type: "String",
      Default: "",
      Description: `Comma separated teams allowed to assume ${role.roleName}. Empty: the role is not created.`,
      AllowedPattern: teamsPattern(teams),
    };
    const hasTeams = { "Fn::Not": [{ "Fn::Equals": [{ Ref: teamsParam }, ""] }] };
    const condition = `Create${key}Role`;
    conditions[condition] =
      role.tier === "admin"
        ? { "Fn::And": [hasTeams, { Condition: HAS_ADMIN_PROVIDER }] }
        : hasTeams;

    const { issuer, principal } = provider(role.tier);
    const policies: CfnTemplate[] = [
      {
        PolicyName: "AwsLogin",
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowAwsLogin",
              Effect: "Allow",
              Action: [...LOGIN_ACTIONS],
              Resource:
                role.tier === "standard"
                  ? [loginResource("localhost"), loginResource("remote")]
                  : [loginResource("localhost")],
            },
          ],
        },
      },
    ];
    if (role.tier === "standard")
      policies.push({
        PolicyName: "DenySecretValueRead",
        PolicyDocument: { Version: "2012-10-17", Statement: DENY_SECRET_VALUE_READ },
      });
    (inline.get(i) ?? []).forEach((doc, j) => {
      policies.push({ PolicyName: `InlinePolicy${j + 1}`, PolicyDocument: doc });
    });

    resources[`${key}Role`] = {
      Type: "AWS::IAM::Role",
      Condition: condition,
      Properties: {
        RoleName: role.roleName,
        Path: rolePath(role.tier),
        // Admin はちょうど 3600（AWS が強制できる最短）、Standard は sessionSeconds（G2 の決裁の論点 5）
        MaxSessionDuration: roleMaxSessionDuration(role),
        // 守りの部品は、その種類で割り当てのあるロールにだけ付ける。割り当てのないロールは AllowedPattern で作られず、
        // ImportValue を置くと Admin の Export の無い基盤（AdminIssuerHost が空）で解決に失敗しうるため出さない
        ManagedPolicyArns: [
          ...role.managedPolicyArns,
          ...(teams.length > 0 ? [{ "Fn::ImportValue": GUARD_EXPORT[role.tier] }] : []),
        ],
        Policies: policies,
        AssumeRolePolicyDocument: trustPolicy(teamsParam, issuer, principal),
        Tags: [
          { Key: "project", Value: "awsbridge" },
          { Key: "awsbridge-console-tier", Value: role.tier },
        ],
      },
    };
  });

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `awsbridge console login - role template (reference) for the kind StackSet ${kindStackSetName(kind)}. Generated from the console config; do not edit by hand.`,
    Parameters: parameters,
    Conditions: conditions,
    Resources: resources,
  };
}

/**
 * Admin の階層のロールの sessionSeconds が MaxSessionDuration（3600）を超えていないか。設定の解析（parseConsoleConfig）でも
 * 断るが、解析を通さずに組んだ設定でも、Worker が求める長さがロールの上限を超えるテンプレートを作らない。
 */
function checkAdminSessions(config: ConsoleConfig): void {
  const out = new IssueList();
  config.roles.forEach((r, i) => {
    if (r.tier === "admin" && r.sessionSeconds > ADMIN_MAX_SESSION_SECONDS)
      out.add(`roles[${i}].sessionSeconds`, "admin_session_seconds");
  });
  if (out.items.length > 0) throw new ConsoleConfigError(out.items);
}

/**
 * 1 つの種類のテンプレートを作る。誤り（設定にない種類・下流のポリシー文書の欠落や形の違い）は ConsoleConfigError。
 * 戻り値は CloudFormation のテンプレート（JSON / YAML に直列化して使う）。時刻などの変わる値は入れない。
 */
export function buildKindTemplate(
  config: ConsoleConfig,
  kind: string,
  options: TemplateOptions = {},
): CfnTemplate {
  if (!config.kinds.some((x) => x.name === kind))
    throw new ConsoleConfigError([{ path: "kind", code: "unknown_kind" }]);
  checkAdminSessions(config);
  return build(config, kind, resolveInline(config, options));
}

/** 設定のすべての種類について、StackSet の名前とテンプレートを作る（設定に書いた順）。 */
export function buildKindTemplates(
  config: ConsoleConfig,
  options: TemplateOptions = {},
): KindTemplate[] {
  checkAdminSessions(config);
  const inline = resolveInline(config, options);
  return config.kinds.map((k) => ({
    kind: k.name,
    stackSetName: kindStackSetName(k.name),
    template: build(config, k.name, inline),
  }));
}
