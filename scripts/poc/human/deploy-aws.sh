#!/usr/bin/env bash
# PoC（人間の AWS ログイン）: CloudFormation で PoC 用の IAM OIDC プロバイダーとロール（AwsbridgeHumanPoc）をデプロイする。
# MCP 用の scripts/deploy-aws.sh とは別。MCP 用の変数（AWSBRIDGE_ISSUER / AWSBRIDGE_STACK_NAME など）は読まない。
# 必須: AWSBRIDGE_HUMAN_POC_ISSUER（PoC Worker の URL）、AWSBRIDGE_HUMAN_POC_SUBJECT（PoC 利用者 1 人の email）
# 上書きできる既定値: AWS_PROFILE（awsbridge）/ AWS_REGION（ap-northeast-1）/
#   AWSBRIDGE_HUMAN_POC_STACK_NAME（awsbridge-human-poc）/ AWSBRIDGE_HUMAN_POC_AUDIENCE（awsbridge-human-poc）
# 任意: AWSBRIDGE_HUMAN_POC_ROLE_NAME（未設定ならテンプレートの既定 AwsbridgeHumanPoc）
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
stack="${AWSBRIDGE_HUMAN_POC_STACK_NAME:-awsbridge-human-poc}"
audience="${AWSBRIDGE_HUMAN_POC_AUDIENCE:-awsbridge-human-poc}"

for v in AWSBRIDGE_HUMAN_POC_ISSUER AWSBRIDGE_HUMAN_POC_SUBJECT; do
  if [ -z "${!v:-}" ]; then
    echo "$v が未設定です。mise.local.toml に設定してください。" >&2
    exit 1
  fi
done

issuer="${AWSBRIDGE_HUMAN_POC_ISSUER%/}"
if ! [[ "$issuer" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "AWSBRIDGE_HUMAN_POC_ISSUER '${AWSBRIDGE_HUMAN_POC_ISSUER}' が不正です（https://<host> の形式。パスは不可）。mise.local.toml を確認してください。" >&2
  exit 1
fi
host="${issuer#https://}"

# 信頼ポリシーは JSON 文字列として組むため厳格に検証する。1 人の email だけ（ワイルドカード・リスト不可）。小文字にそろえる。
subject="$(printf '%s' "$AWSBRIDGE_HUMAN_POC_SUBJECT" | tr '[:upper:]' '[:lower:]')"
if ! [[ "$subject" =~ ^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$ ]]; then
  echo "AWSBRIDGE_HUMAN_POC_SUBJECT '${AWSBRIDGE_HUMAN_POC_SUBJECT}' が不正です（user@example.com の形式で 1 人だけ。ワイルドカード・カンマ・前後の空白は不可）。mise.local.toml を確認してください。" >&2
  exit 1
fi

template="$(cd "$(dirname "$0")" && pwd)/poc-human.yaml"
params=("IssuerHost=${host}" "Audience=${audience}" "Subject=${subject}")
if [ -n "${AWSBRIDGE_HUMAN_POC_ROLE_NAME:-}" ]; then
  params+=("RoleName=${AWSBRIDGE_HUMAN_POC_ROLE_NAME}")
fi

echo "デプロイ: スタック ${stack}（AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}）" >&2
aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$template" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --tags project=awsbridge-human-poc \
  --parameter-overrides "${params[@]}"

aws cloudformation describe-stacks \
  --stack-name "$stack" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output text
