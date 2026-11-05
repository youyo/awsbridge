#!/usr/bin/env bash
# deploy-aws.sh で作成した CloudFormation スタックを削除する。
set -euo pipefail

# 上書きできる既定値: AWS_PROFILE / AWSBRIDGE_STACK_NAME（どちらも awsbridge）
export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
AWSBRIDGE_STACK_NAME="${AWSBRIDGE_STACK_NAME:-awsbridge}"

echo "削除対象: スタック ${AWSBRIDGE_STACK_NAME}（AWS_PROFILE=${AWS_PROFILE}）" >&2
aws cloudformation delete-stack --stack-name "$AWSBRIDGE_STACK_NAME"
aws cloudformation wait stack-delete-complete --stack-name "$AWSBRIDGE_STACK_NAME"
echo "スタックを削除しました: ${AWSBRIDGE_STACK_NAME}"
