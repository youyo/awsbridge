#!/usr/bin/env bash
# PoC のポータルの片付け: CloudFormation スタック → Worker（awsbridge-human-poc-portal）→ Access アプリ（このディレクトリの
# Terraform の state にあるものだけ）の順に消し、手元の Worker の secret と Cookie のファイルを消す。
# 署名鍵（signing-key-*.json）と見張りの記録（access-watch-*.jsonl）は残す。不要なら手で消す。
# ガード（何かを消す前に確かめる）: スタック名は awsbridge-human-poc-portal で始まるものだけ。Worker 名は固定。
#   Terraform の state のファイルがあれば state list が読めて、中身が Access のアプリ・ポリシーだけであること（違えば何も消さずに止まる）。
# Worker が既に無い（wrangler delete が失敗）ときは警告して Access の削除へ進む。MCP 用の変数・infra/cloudflare には触らない。
# 上書きできる既定値: AWS_PROFILE（awsbridge）/ AWS_REGION（ap-northeast-1）/
#   AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME（awsbridge-human-poc-portal）/ AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR（.secrets/poc-human/portal）/
#   AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_DIR（このスクリプトの隣の access/）
# AWSBRIDGE_HUMAN_POC_PORTAL_HOST があれば Terraform の destroy に -var worker_host=<HOST> を渡す（tfvars の古い値より優先）。
# Worker の Custom Domain が Worker の削除で消えるかは未確認。消したあと mise run poc:human:portal:bypass-check -- --after-destroy で確かめる
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
stack="${AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME:-awsbridge-human-poc-portal}"
out_dir="${AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR:-$root/.secrets/poc-human/portal}"
access_dir="${AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_DIR:-$here/access}"
worker="awsbridge-human-poc-portal"

if [[ "$stack" != awsbridge-human-poc-portal && "$stack" != awsbridge-human-poc-portal-* ]]; then
  echo "エラー: PoC のポータル用でないスタック名は消さない: ${stack}" >&2
  exit 1
fi

# Terraform の state を先に確かめる（スタックや Worker を消してから止まらないように）
destroy_access=0
if [ -f "$access_dir/terraform.tfstate" ]; then
  if ! state="$(terraform -chdir="$access_dir" state list)"; then
    echo "エラー: ${access_dir} の Terraform の state を読めないため、何も消さずに止めます" >&2
    exit 1
  fi
  others="$(printf '%s\n' "$state" | grep -Ev '^cloudflare_zero_trust_access_(application|policy)\.' | grep -v '^$' || true)"
  if [ -n "$others" ]; then
    echo "エラー: state に Access のアプリ・ポリシー以外のリソースがあるため、何も消さずに止めます:" >&2
    printf '%s\n' "$others" >&2
    exit 1
  fi
  [ -n "$state" ] && destroy_access=1
else
  echo "Terraform の state（${access_dir}/terraform.tfstate）が無いため、Access アプリの削除は飛ばします" >&2
fi

echo "削除対象: スタック ${stack}（AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}）" >&2
aws cloudformation delete-stack --stack-name "$stack"
aws cloudformation wait stack-delete-complete --stack-name "$stack"
echo "スタックを削除しました: ${stack}"

echo "削除対象: Worker ${worker}" >&2
# Workers の操作は wrangler login の OAuth を使う。CLOUDFLARE_API_TOKEN は Access 用（Workers の権限なし）なので wrangler には渡さない
if ! (cd "$root" && env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler delete --config "$here/wrangler.jsonc" --name "$worker"); then
  echo "警告: Worker ${worker} の削除が失敗しました（既に無い、など）。Access の削除へ進みます" >&2
fi

if [ "$destroy_access" = 1 ]; then
  echo "削除対象: Access アプリ（${access_dir} の Terraform の state）" >&2
  # 対象はこのスクリプトが state の中身（Access のアプリ・ポリシーだけ）を確かめた PoC 用の state だけなので、対話の確認は付けない
  # Terraform には CLOUDFLARE_API_TOKEN をそのまま渡す
  tf_vars=()
  [ -n "${AWSBRIDGE_HUMAN_POC_PORTAL_HOST:-}" ] && tf_vars=(-var "worker_host=${AWSBRIDGE_HUMAN_POC_PORTAL_HOST}")
  terraform -chdir="$access_dir" destroy -auto-approve "${tf_vars[@]+"${tf_vars[@]}"}"
fi

rm -f "$out_dir/worker-secrets.json" "$out_dir/access-cookie.txt" "$out_dir/access-jwt.txt" "$out_dir/wrangler.deploy.json"
rm -rf "$out_dir/dist"
echo "Worker の secret・Cookie・持ち込み用の Access JWT・デプロイ用の wrangler の設定を消しました: ${out_dir}"
echo "Custom Domain とスクリプトが残っていないことを確かめる: mise run poc:human:portal:bypass-check -- --after-destroy"
