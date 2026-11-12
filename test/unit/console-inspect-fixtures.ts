// 検査の道具（src/console/inspect.ts）の試験の材料。正しい形は、生成器（src/console/template.ts）の出力と
// 必須のスタック（infra/aws/console/base.yaml）の部品を、パラメーターを入れて評価して作る（手で書き写さない）。
// 値はすべてダミー（example.com・333333333333 など。会社用の設定の例 test/unit/console-fixtures.ts と同じ）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { type ConsoleConfig, parseConsoleConfig } from "../../src/console/config";
import type { AccountSnapshot, RoleSnapshot } from "../../src/console/inspect";
import { buildKindTemplate } from "../../src/console/template";
import { evaluate, type Json } from "./cfn";
import { companyConfig, companyInventory } from "./console-fixtures";

/** 試験の対象のアカウント（会社用の設定のインベントリで種類 A: admin ← infra-elevated、readonly ← sa・infra）。 */
export const ACCOUNT = "333333333333";
/** 署名を置くアカウント（signing.accountIds）。どの種類の OU にも入っていない。 */
export const SIGNING_ACCOUNT = "666666666666";
export const HOST = "id.example.com";
export const STD_PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}/standard`;
export const ADMIN_PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}/admin`;
export const STD_GUARD = `arn:aws:iam::${ACCOUNT}:policy/awsbridge-console/AwsbridgeConsoleGuardStandard`;
export const ADMIN_GUARD = `arn:aws:iam::${ACCOUNT}:policy/awsbridge-console/AwsbridgeConsoleGuardAdmin`;
/** MCP 用のプロバイダー（コンソールログイン用ではない）。 */
export const MCP_PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge.example.workers.dev`;

export function inspectConfig(): ConsoleConfig {
  const raw = companyConfig();
  raw.signing = { accountIds: [SIGNING_ACCOUNT] };
  return parseConsoleConfig(raw).config;
}

export const inventory = () => companyInventory();

const BASE: Json = parse(
  readFileSync(resolve(import.meta.dirname, "../../infra/aws/console/base.yaml"), "utf8"),
  { customTags: [] },
);

const PSEUDO = { "AWS::Partition": "aws", "AWS::AccountId": ACCOUNT };

/** base.yaml の部品の文書を、このアカウントの値で評価する。 */
export function guardDocument(logicalId: "StandardGuardPolicy" | "AdminGuardPolicy"): Json {
  return evaluate(BASE.Resources[logicalId].Properties.PolicyDocument, {
    ...PSEUDO,
    IssuerHost: HOST,
  });
}

function roleFromTemplate(logicalId: string, params: Record<string, string>): RoleSnapshot {
  const tpl = buildKindTemplate(inspectConfig(), "A");
  const p = evaluate(tpl.Resources[logicalId].Properties, {
    ...PSEUDO,
    IssuerHost: HOST,
    StandardPath: "standard",
    AdminProviderArn: ADMIN_PROVIDER,
    ...params,
  });
  const managed = (p.ManagedPolicyArns as Json[]).map((x) =>
    typeof x === "string" ? x : x["Fn::ImportValue"].includes("admin") ? ADMIN_GUARD : STD_GUARD,
  );
  return {
    roleName: p.RoleName,
    path: p.Path,
    arn: `arn:aws:iam::${ACCOUNT}:role${p.Path}${p.RoleName}`,
    maxSessionDuration: p.MaxSessionDuration,
    trustPolicy: JSON.parse(p.AssumeRolePolicyDocument),
    attachedPolicies: managed.map((arn) => ({
      policyName: arn.split("/").at(-1) ?? "",
      policyArn: arn,
    })),
    inlinePolicies: (p.Policies as Json[]).map((x) => ({
      policyName: x.PolicyName,
      document: x.PolicyDocument,
    })),
  };
}

/** 生成器の出力そのままの、正しい形のアカウント（Viewer 相当の readonly と Admin の admin、無関係のロール 1 つ）。 */
export function goodSnapshot(): AccountSnapshot {
  return {
    accountId: ACCOUNT,
    partition: "aws",
    providers: [STD_PROVIDER, ADMIN_PROVIDER, MCP_PROVIDER],
    roles: [
      roleFromTemplate("ReadonlyRole", { ReadonlyTeams: "sa,infra", AdminTeams: "" }),
      roleFromTemplate("AdminRole", { ReadonlyTeams: "", AdminTeams: "infra-elevated" }),
      {
        roleName: "OrganizationAccountAccessRole",
        path: "/",
        arn: `arn:aws:iam::${ACCOUNT}:role/OrganizationAccountAccessRole`,
        trustPolicy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: "arn:aws:iam::111111111111:root" },
              Action: "sts:AssumeRole",
            },
          ],
        },
      },
    ],
    managedPolicies: [
      { arn: STD_GUARD, defaultVersionId: "v1", document: guardDocument("StandardGuardPolicy") },
      { arn: ADMIN_GUARD, defaultVersionId: "v1", document: guardDocument("AdminGuardPolicy") },
    ],
  };
}

/** 名前でロールを取り出す（書き換え用）。 */
export function role(s: AccountSnapshot, name: string): RoleSnapshot {
  const r = s.roles.find((x) => x.roleName === name);
  if (!r) throw new Error(`ロールがない: ${name}`);
  return r;
}

/**
 * スナップショットを、aws CLI（--output json）の応答の形にする: 「引数を空白でつないだもの」→ 応答の JSON。
 * 読み取りの試験（unit の差し替えた関数と、E2E の偽の aws コマンド）が使う。--profile と --output は含めない。
 */
export function awsResponses(s: AccountSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out["iam list-open-id-connect-providers"] = {
    OpenIDConnectProviderList: s.providers.map((Arn) => ({ Arn })),
  };
  out["iam list-roles"] = {
    Roles: s.roles.map((r) => ({
      Path: r.path,
      RoleName: r.roleName,
      Arn: r.arn,
      AssumeRolePolicyDocument: r.trustPolicy,
      ...(r.maxSessionDuration !== undefined ? { MaxSessionDuration: r.maxSessionDuration } : {}),
    })),
  };
  for (const r of s.roles) {
    const n = r.roleName;
    out[`iam get-role --role-name=${n}`] = {
      Role: {
        Path: r.path,
        RoleName: n,
        Arn: r.arn,
        AssumeRolePolicyDocument: r.trustPolicy,
        ...(r.maxSessionDuration !== undefined ? { MaxSessionDuration: r.maxSessionDuration } : {}),
      },
    };
    out[`iam list-attached-role-policies --role-name=${n}`] = {
      AttachedPolicies: (r.attachedPolicies ?? []).map((p) => ({
        PolicyName: p.policyName,
        PolicyArn: p.policyArn,
      })),
    };
    out[`iam list-role-policies --role-name=${n}`] = {
      PolicyNames: (r.inlinePolicies ?? []).map((p) => p.policyName),
    };
    for (const p of r.inlinePolicies ?? [])
      out[`iam get-role-policy --role-name=${n} --policy-name=${p.policyName}`] = {
        RoleName: n,
        PolicyName: p.policyName,
        PolicyDocument: p.document,
      };
  }
  for (const p of s.managedPolicies) {
    out[`iam get-policy --policy-arn ${p.arn}`] = {
      Policy: { Arn: p.arn, DefaultVersionId: p.defaultVersionId },
    };
    out[`iam get-policy-version --policy-arn ${p.arn} --version-id ${p.defaultVersionId}`] = {
      PolicyVersion: {
        Document: p.document,
        VersionId: p.defaultVersionId,
        IsDefaultVersion: true,
      },
    };
  }
  return out;
}
