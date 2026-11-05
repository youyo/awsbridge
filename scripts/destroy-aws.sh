#!/usr/bin/env bash
# deploy-aws.sh で作成した CloudFormation スタックを削除する。
set -euo pipefail

if [ -z "${AWSBRIDGE_STACK_NAME:-}" ]; then
  echo "AWSBRIDGE_STACK_NAME が未設定です。mise.local.toml に設定してください。" >&2
  exit 1
fi

aws cloudformation delete-stack --stack-name "$AWSBRIDGE_STACK_NAME"
aws cloudformation wait stack-delete-complete --stack-name "$AWSBRIDGE_STACK_NAME"
echo "スタックを削除しました: ${AWSBRIDGE_STACK_NAME}"
