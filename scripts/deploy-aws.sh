#!/usr/bin/env bash
# CloudFormation で IAM OIDC プロバイダーと Worker 発行 JWT 用ロールをデプロイする。
# 値はすべて環境変数（mise.toml / mise.local.toml）から読む。
set -euo pipefail

need() {
  if [ -z "${!1:-}" ]; then
    echo "$1 が未設定です。mise.local.toml に設定してください。" >&2
    exit 1
  fi
}
for v in AWSBRIDGE_ISSUER AWSBRIDGE_AUDIENCE AWSBRIDGE_ROLE_NAME AWSBRIDGE_STACK_NAME AWSBRIDGE_ALLOWED_SUBJECTS; do
  need "$v"
done

# email は小文字に正規化して照合するため、許可リストも小文字にそろえる（Worker 側は identity を小文字化する）
AWSBRIDGE_ALLOWED_SUBJECTS="$(printf '%s' "$AWSBRIDGE_ALLOWED_SUBJECTS" | tr '[:upper:]' '[:lower:]')"

# 信頼ポリシーは JSON 文字列として組むため、値を厳格に検証する（全員許可・JSON 破壊の防止）。
# ローカル部はワイルドカード可、ドメイン部は不可。前後の空白と空要素はエラー。
subject_re='^[A-Za-z0-9._%+*?-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
rest="${AWSBRIDGE_ALLOWED_SUBJECTS},"
while [ -n "$rest" ]; do
  item="${rest%%,*}"
  rest="${rest#*,}"
  if ! [[ "$item" =~ $subject_re ]]; then
    echo "AWSBRIDGE_ALLOWED_SUBJECTS の要素 '${item}' が不正です（user@example.com / *@example.com の形式。ドメイン部のワイルドカード、* 単独、空要素、前後の空白は不可）。mise.local.toml の AWSBRIDGE_ALLOWED_SUBJECTS を確認してください。" >&2
    exit 1
  fi
done

host="${AWSBRIDGE_ISSUER#https://}"
host="${host%/}"
template="$(cd "$(dirname "$0")/.." && pwd)/infra/aws/awsbridge.yaml"

params=(
  "IssuerHost=${host}"
  "Audience=${AWSBRIDGE_AUDIENCE}"
  "RoleName=${AWSBRIDGE_ROLE_NAME}"
  "AllowedSubjects=${AWSBRIDGE_ALLOWED_SUBJECTS}"
)
# 空の ManagedPolicyArns は渡さない（テンプレートの既定値 = 付けない）
if [ -n "${AWSBRIDGE_MANAGED_POLICY_ARNS:-}" ]; then
  params+=("ManagedPolicyArns=${AWSBRIDGE_MANAGED_POLICY_ARNS}")
fi

aws cloudformation deploy \
  --stack-name "$AWSBRIDGE_STACK_NAME" \
  --template-file "$template" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --tags project=awsbridge \
  --parameter-overrides "${params[@]}"

aws cloudformation describe-stacks \
  --stack-name "$AWSBRIDGE_STACK_NAME" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output text
