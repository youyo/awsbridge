#!/usr/bin/env bash
# PoC N6 の片付け:
# 1. スタックの Outputs から Worker 用の IAM ユーザーと鍵の ARN を読み、鍵の ARN を <OUT_DIR>/kms-keys.txt（権限 600）に残す
# 2. その IAM ユーザーのアクセスキーをすべて消す（残っているとスタックの削除でユーザーを消せない）
# 3. スタックを消す（KMS の鍵は PendingWindowInDays 7 で削除の予約になる。OIDC プロバイダー・ロール・ユーザーは消える）
# 4. 鍵ごとに KeyState と DeletionDate（削除の予定日）を出す
# 5. Worker awsbridge-admin-kms-poc を消し、手元の bearer・文書・デプロイ用の設定を消す（計測の記録 *.jsonl は残す）
# 何度実行してもよい（スタックが無ければ 1・2 は飛ばし、kms-keys.txt があれば 4 を出す）。
# 上書きできる既定値: AWS_PROFILE（awsbridge）/ AWS_REGION（ap-northeast-1）/
#   AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME（awsbridge-admin-kms-poc）/ AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR（.secrets/poc-admin-kms）
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
stack="${AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME:-awsbridge-admin-kms-poc}"
out_dir="${AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR:-$root/.secrets/poc-admin-kms}"
worker="awsbridge-admin-kms-poc"

if [[ "$stack" != awsbridge-admin-kms-poc* ]]; then
  echo "エラー: PoC N6 でないスタック名は消さない: ${stack}（awsbridge-admin-kms-poc で始まる名前だけ）" >&2
  exit 1
fi
mask() { sed -E 's#key/[0-9a-f-]{36}#key/<key-id>#g; s/[0-9]{12}/<acct>/g'; }

mkdir -p "$out_dir" && chmod 700 "$out_dir"
user="$(aws cloudformation describe-stacks --stack-name "$stack" \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerUserName'].OutputValue" --output text 2>/dev/null || true)"
keys="$(aws cloudformation describe-stacks --stack-name "$stack" \
  --query "Stacks[0].Outputs[?ends_with(OutputKey, 'KeyArn')].OutputValue" --output text 2>/dev/null || true)"
if [ -n "$keys" ] && [ "$keys" != "None" ]; then
  printf '%s\n' $keys > "$out_dir/kms-keys.txt"
  chmod 600 "$out_dir/kms-keys.txt"
fi

if [ -n "$user" ] && [ "$user" != "None" ]; then
  if [[ "$user" != awsbridge-admin-kms-poc* ]]; then
    echo "エラー: PoC N6 でない IAM ユーザー: ${user}" >&2
    exit 1
  fi
  for id in $(aws iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    [ "$id" = "None" ] && continue
    aws iam delete-access-key --user-name "$user" --access-key-id "$id"
    echo "アクセスキーを消しました（ユーザー ${user}）"
  done
fi

echo "削除対象: スタック ${stack}（AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}）" >&2
aws cloudformation delete-stack --stack-name "$stack"
aws cloudformation wait stack-delete-complete --stack-name "$stack"
echo "スタックを削除しました: ${stack}"

if [ -f "$out_dir/kms-keys.txt" ]; then
  echo "KMS の鍵（KeyState と DeletionDate）:"
  while read -r arn; do
    [ -z "$arn" ] && continue
    state="$(aws kms describe-key --key-id "$arn" --query 'KeyMetadata.[KeyState,DeletionDate]' --output text)"
    printf '  %s\t%s\n' "$(printf '%s' "$arn" | mask)" "$state"
  done < "$out_dir/kms-keys.txt"
fi

echo "削除対象: Worker ${worker}" >&2
(cd "$root" && env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler delete --name "$worker")

rm -f "$out_dir/caller-token.txt" "$out_dir/issuer-documents.json" "$out_dir/wrangler.deploy.json" "$out_dir"/worker-secrets.*.json
echo "手元の bearer・文書・デプロイ用の設定を消しました: ${out_dir}"
