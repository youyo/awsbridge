#!/usr/bin/env bash
# PoC で作成した IAM ロールと OIDC プロバイダーを削除する。
set -euo pipefail

: "${AWSBRIDGE_POC_ISSUER:?mise.local.toml に AWSBRIDGE_POC_ISSUER を設定してください}"
: "${AWSBRIDGE_POC_ACCOUNT_ID:?mise.local.toml に AWSBRIDGE_POC_ACCOUNT_ID を設定してください}"
: "${AWSBRIDGE_POC_ROLE_NAME:?}"

host="${AWSBRIDGE_POC_ISSUER#https://}"
host="${host%/}"
provider_arn="arn:aws:iam::${AWSBRIDGE_POC_ACCOUNT_ID}:oidc-provider/${host}"

if aws iam get-role --role-name "$AWSBRIDGE_POC_ROLE_NAME" >/dev/null 2>&1; then
  aws iam delete-role --role-name "$AWSBRIDGE_POC_ROLE_NAME"
  echo "ロールを削除しました: ${AWSBRIDGE_POC_ROLE_NAME}"
fi
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
  aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn"
  echo "OIDC プロバイダーを削除しました: ${host}"
fi
