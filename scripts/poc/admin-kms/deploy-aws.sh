#!/usr/bin/env bash
# PoC N6: CloudFormation で KMS の鍵 3 つ（RSA_2048 ×2・ECC_NIST_P256）、Worker 用の IAM ユーザー（kms:Sign だけ。アクセスキーは作らない）、
# PoC の issuer の IAM OIDC プロバイダー、ロール AwsbridgeAdminKmsPoc をデプロイする。Cloudflare は呼ばない。
# MCP 用・既存の PoC の変数（AWSBRIDGE_ISSUER / AWSBRIDGE_STACK_NAME / AWSBRIDGE_HUMAN_POC_*）は読まない。
# 必須: AWSBRIDGE_ADMIN_KMS_POC_ISSUER（https://awsbridge-admin-kms-poc.<subdomain>.workers.dev）
# 上書きできる既定値: AWS_PROFILE（awsbridge）/ AWS_REGION（ap-northeast-1）/
#   AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME（awsbridge-admin-kms-poc）/ AWSBRIDGE_ADMIN_KMS_POC_AUDIENCE（awsbridge-admin-kms-poc）/
#   AWSBRIDGE_ADMIN_KMS_POC_SUBJECT（awsbridge-kms-check）
# 引数: --keys-only（鍵と IAM ユーザーだけ。IAM は OIDC プロバイダーの作成時に issuer の discovery を読むため、
#   1 回目は --keys-only → Worker をデプロイ（JWKS に鍵が要る）→ 2 回目（引数なし）で OIDC プロバイダーとロールを足す）
set -euo pipefail

create_issuer=true
if [ "${1:-}" = "--keys-only" ]; then
  create_issuer=false
elif [ -n "${1:-}" ]; then
  echo "使い方: deploy-aws.sh [--keys-only]" >&2
  exit 1
fi

export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
stack="${AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME:-awsbridge-admin-kms-poc}"
audience="${AWSBRIDGE_ADMIN_KMS_POC_AUDIENCE:-awsbridge-admin-kms-poc}"
subject="${AWSBRIDGE_ADMIN_KMS_POC_SUBJECT:-awsbridge-kms-check}"

if [[ "$stack" != awsbridge-admin-kms-poc* ]]; then
  echo "エラー: PoC N6 でないスタック名: ${stack}（awsbridge-admin-kms-poc で始まる名前だけ）" >&2
  exit 1
fi
if [ -z "${AWSBRIDGE_ADMIN_KMS_POC_ISSUER:-}" ]; then
  echo "AWSBRIDGE_ADMIN_KMS_POC_ISSUER が未設定です。mise.local.toml に設定してください。" >&2
  exit 1
fi
issuer="${AWSBRIDGE_ADMIN_KMS_POC_ISSUER%/}"
if ! [[ "$issuer" =~ ^https://awsbridge-admin-kms-poc\.[a-z0-9-]+\.workers\.dev$ ]]; then
  echo "AWSBRIDGE_ADMIN_KMS_POC_ISSUER が不正です（https://awsbridge-admin-kms-poc.<subdomain>.workers.dev の形。パスは不可）。" >&2
  exit 1
fi
host="${issuer#https://}"

template="$(cd "$(dirname "$0")" && pwd)/poc-admin-kms.yaml"
echo "デプロイ: スタック ${stack}（AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}）" >&2
aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$template" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --tags project=awsbridge-admin-kms-poc \
  --parameter-overrides "IssuerHost=${host}" "Audience=${audience}" "Subject=${subject}" "CreateIssuerResources=${create_issuer}"

# Outputs は ARN（アカウント ID・鍵 ID を含む）なので、キー名だけ出す
aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Outputs[].OutputKey' --output text
