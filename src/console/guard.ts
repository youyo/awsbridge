// コンソールログイン: 守りの部品（infra/aws/console/base.yaml の StandardGuardPolicy・AdminGuardPolicy。P2 でもどちらも残す）の文書の上流の形。
// 検査の道具（inspect.ts）が、アカウントの部品の今の既定の版の中身と照合する。node の API を使わない（YAML を読まない）ので、
// base.yaml と同じ文をここにも書く。同じであることは test/unit/console-inspect.test.ts で確かめる（base.yaml を変えたらここも直す）。
// 設計: docs/specs/console-login.md §4.8・§4.9。

import type { Tier } from "./constants";

/**
 * issuerHost: コンソール用のプロバイダーのホスト（P2: 1 つ。Standard と Admin の階層で同じプロバイダー。管理外の先方の
 * /p/<id>/... も同じホストの下）。どちらの部品も同じ 1 つのホストを守る（P2（B）の設計メモ §6.1。M3 で測るまで未検証）。
 */
export type GuardParams = { partition: string; accountId: string; issuerHost: string };

/** その階層の守りの部品の文書（base.yaml の Fn::Sub を、アカウントの値で展開したもの）。 */
export function guardPolicyDocument(tier: Tier, p: GuardParams) {
  const iam = `arn:${p.partition}:iam::${p.accountId}`;
  const statements: Record<string, unknown>[] = [
    {
      Sid: "DenyRoleChaining",
      Effect: "Deny",
      Action: ["sts:AssumeRole", "sts:AssumeRoot"],
      Resource: "*",
    },
    {
      Sid: "DenyConsoleRoleWrites",
      Effect: "Deny",
      Action: [
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary",
      ],
      Resource: `${iam}:role/awsbridge-console/*`,
    },
    {
      Sid: "DenyConsoleProviderWrites",
      Effect: "Deny",
      Action: [
        "iam:CreateOpenIDConnectProvider",
        "iam:DeleteOpenIDConnectProvider",
        "iam:UpdateOpenIDConnectProviderThumbprint",
        "iam:AddClientIDToOpenIDConnectProvider",
        "iam:RemoveClientIDFromOpenIDConnectProvider",
        "iam:TagOpenIDConnectProvider",
        "iam:UntagOpenIDConnectProvider",
      ],
      // base.yaml は 1 要素の配列。IAM が 1 要素を文字列で返しても検査（canon）は同じとみなす
      Resource: [`${iam}:oidc-provider/${p.issuerHost}/*`],
    },
    {
      Sid: "DenyGuardPolicyWrites",
      Effect: "Deny",
      Action: [
        "iam:CreatePolicy",
        "iam:CreatePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:DeletePolicy",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: `${iam}:policy/awsbridge-console/*`,
    },
  ];
  if (tier === "admin")
    statements.push({
      Sid: "DenyAwsLoginRemote",
      Effect: "Deny",
      Action: ["signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token"],
      Resource: `arn:${p.partition}:signin:*:${p.accountId}:oauth2/public-client/remote`,
    });
  return { Version: "2012-10-17", Statement: statements };
}
