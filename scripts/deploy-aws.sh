#!/usr/bin/env bash
# CloudFormation で IAM OIDC プロバイダーと Worker 発行 JWT 用ロール（読み取り専用・デバッグの 2 つ）をデプロイする。
# 値は環境変数（mise.local.toml や下流の mise 設定ファイル）から読む。
# 上書きできる既定値: AWS_PROFILE / AWSBRIDGE_AUDIENCE / AWSBRIDGE_STACK_NAME（すべて awsbridge）
# 任意: AWSBRIDGE_READONLY_ROLE_NAME / AWSBRIDGE_DEBUG_ROLE_NAME（未設定なら、新規スタックではテンプレートの既定 FederatedMcpViewer / FederatedMcpDebugger、
#       既存スタックの更新では aws cloudformation deploy がスタックの既存の値を使う）、
#       AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS（デバッグロールに追加する管理ポリシー ARN。カンマ区切り）、
#       AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS（ecs:RunTask で渡せるタスクロール ARN。カンマ区切り。空なら iam:PassRole を付けない）
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
AWSBRIDGE_AUDIENCE="${AWSBRIDGE_AUDIENCE:-awsbridge}"
AWSBRIDGE_STACK_NAME="${AWSBRIDGE_STACK_NAME:-awsbridge}"

need() {
  if [ -z "${!1:-}" ]; then
    echo "$1 が未設定です。mise.local.toml に設定してください。" >&2
    exit 1
  fi
}
for v in AWSBRIDGE_ISSUER AWSBRIDGE_ALLOWED_SUBJECTS AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS; do
  need "$v"
done

# email は小文字に正規化して照合するため、許可リストも小文字にそろえる（Worker 側は identity を小文字化する）
AWSBRIDGE_ALLOWED_SUBJECTS="$(printf '%s' "$AWSBRIDGE_ALLOWED_SUBJECTS" | tr '[:upper:]' '[:lower:]')"
AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS="$(printf '%s' "$AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS" | tr '[:upper:]' '[:lower:]')"

# 信頼ポリシーは JSON 文字列として組むため、値を厳格に検証する（全員許可・JSON 破壊の防止）。
# ローカル部はワイルドカード可、ドメイン部は不可。前後の空白と空要素はエラー。
subject_re='^[A-Za-z0-9._%+*?-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
validate_subjects() {
  local name="$1" rest="${!1}," item
  while [ -n "$rest" ]; do
    item="${rest%%,*}"
    rest="${rest#*,}"
    if ! [[ "$item" =~ $subject_re ]]; then
      echo "${name} の要素 '${item}' が不正です（user@example.com / *@example.com の形式。ドメイン部のワイルドカード、* 単独、空要素、前後の空白は不可）。mise.local.toml の ${name} を確認してください。" >&2
      exit 1
    fi
  done
}
validate_subjects AWSBRIDGE_ALLOWED_SUBJECTS
validate_subjects AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS

# 任意の ARN リスト（空要素・形式不正は CloudFormation 側で失敗するため先に弾く）。未設定ならスキップ。
validate_arns() {
  local name="$1" re="$2" rest="${!1}," item
  while [ -n "$rest" ]; do
    item="${rest%%,*}"
    rest="${rest#*,}"
    if ! [[ "$item" =~ $re ]]; then
      echo "${name} の要素 '${item}' が不正です（ARN 形式。空要素、ワイルドカード、前後の空白は不可）。mise.local.toml の ${name} を確認してください。" >&2
      exit 1
    fi
  done
}
policy_arn_re='^arn:aws[a-z-]*:iam::(aws|[0-9]{12}):policy/[A-Za-z0-9_+=,.@/-]+$'
role_arn_re='^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9_+=,.@/-]+$'
if [ -n "${AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS:-}" ]; then
  validate_arns AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS "$policy_arn_re"
fi
if [ -n "${AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS:-}" ]; then
  validate_arns AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS "$role_arn_re"
fi

host="${AWSBRIDGE_ISSUER#https://}"
host="${host%/}"
template="$(cd "$(dirname "$0")/.." && pwd)/infra/aws/awsbridge.yaml"

params=(
  "IssuerHost=${host}"
  "Audience=${AWSBRIDGE_AUDIENCE}"
  "AllowedSubjects=${AWSBRIDGE_ALLOWED_SUBJECTS}"
  "DebugAllowedSubjects=${AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS}"
)
# 任意の値は設定されているときだけ渡す（未設定ならテンプレートの既定値を使う）
if [ -n "${AWSBRIDGE_READONLY_ROLE_NAME:-}" ]; then
  params+=("ReadOnlyRoleName=${AWSBRIDGE_READONLY_ROLE_NAME}")
fi
if [ -n "${AWSBRIDGE_DEBUG_ROLE_NAME:-}" ]; then
  params+=("DebugRoleName=${AWSBRIDGE_DEBUG_ROLE_NAME}")
fi
if [ -n "${AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS:-}" ]; then
  params+=("DebugAdditionalPolicyArns=${AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS}")
fi
if [ -n "${AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS:-}" ]; then
  params+=("DebugPassableEcsTaskRoleArns=${AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS}")
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
