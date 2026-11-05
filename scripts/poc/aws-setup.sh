#!/usr/bin/env bash
# PoC（未決事項 1）: awsbridge Worker を IAM OIDC プロバイダーとして登録し、
# Worker 発行 JWT で引き受ける検証用ロール（権限ポリシーなし）を作成する。
# 値はすべて環境変数（mise.toml / mise.local.toml）から読む。
set -euo pipefail

: "${AWSBRIDGE_POC_ISSUER:?mise.local.toml に AWSBRIDGE_POC_ISSUER を設定してください}"
: "${AWSBRIDGE_POC_SUBJECT:?mise.local.toml に AWSBRIDGE_POC_SUBJECT を設定してください}"
: "${AWSBRIDGE_POC_ACCOUNT_ID:?mise.local.toml に AWSBRIDGE_POC_ACCOUNT_ID を設定してください}"
: "${AWSBRIDGE_POC_AUDIENCE:?}"
: "${AWSBRIDGE_POC_ROLE_NAME:?}"

host="${AWSBRIDGE_POC_ISSUER#https://}"
host="${host%/}"
provider_arn="arn:aws:iam::${AWSBRIDGE_POC_ACCOUNT_ID}:oidc-provider/${host}"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
  echo "OIDC プロバイダーは既に存在します: ${host}"
else
  echo "OIDC プロバイダーを作成します: ${host}"
  aws iam create-open-id-connect-provider \
    --url "https://${host}" \
    --client-id-list "$AWSBRIDGE_POC_AUDIENCE" \
    --tags Key=project,Value=awsbridge Key=purpose,Value=poc \
    --query OpenIDConnectProviderArn --output text >/dev/null
  echo "作成しました"
fi

trust_policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${provider_arn}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${host}:aud": "${AWSBRIDGE_POC_AUDIENCE}",
          "${host}:sub": "${AWSBRIDGE_POC_SUBJECT}"
        }
      }
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$AWSBRIDGE_POC_ROLE_NAME" >/dev/null 2>&1; then
  echo "ロールは既に存在するため信頼ポリシーを更新します: ${AWSBRIDGE_POC_ROLE_NAME}"
  aws iam update-assume-role-policy --role-name "$AWSBRIDGE_POC_ROLE_NAME" --policy-document "$trust_policy"
else
  echo "ロールを作成します（権限ポリシーなし）: ${AWSBRIDGE_POC_ROLE_NAME}"
  aws iam create-role \
    --role-name "$AWSBRIDGE_POC_ROLE_NAME" \
    --assume-role-policy-document "$trust_policy" \
    --max-session-duration 3600 \
    --tags Key=project,Value=awsbridge Key=purpose,Value=poc \
    --query Role.RoleName --output text >/dev/null
  echo "作成しました"
fi
