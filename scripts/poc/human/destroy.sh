#!/usr/bin/env bash
# PoC（人間の AWS ログイン）の片付け: CloudFormation スタック → PoC Worker（awsbridge-human-poc）の順に消し、
# 手元のログイン URL・認証情報のファイル（console-url-*.txt、credentials*.json）を消す
# （署名鍵 signing-key.json と見張りの記録 stop-watch-*.jsonl は残す。不要なら手で消す）。
# P2〜P4 のロール（AwsbridgeHumanPocTagged / NoTag）もスタックごと消える。revoke のインラインポリシーが
# 残っていても消えるはずだが、DELETE_FAILED になったら mise run poc:human:unrevoke してからやり直す（README 参照）。
# MCP 用の変数（AWSBRIDGE_STACK_NAME / AWSBRIDGE_WRANGLER_*）は読まない。scripts/wrangler.sh も使わない。
# 上書きできる既定値: AWS_PROFILE（awsbridge）/ AWS_REGION（ap-northeast-1）/
#   AWSBRIDGE_HUMAN_POC_STACK_NAME（awsbridge-human-poc）/ AWSBRIDGE_HUMAN_POC_OUT_DIR（.secrets/poc-human）
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
stack="${AWSBRIDGE_HUMAN_POC_STACK_NAME:-awsbridge-human-poc}"
out_dir="${AWSBRIDGE_HUMAN_POC_OUT_DIR:-$root/.secrets/poc-human}"

# MCP 用のスタック（awsbridge など）を取り違えて消さないよう、PoC 用の名前だけを受け付ける
if [[ "$stack" != awsbridge-human-poc* ]]; then
  echo "エラー: PoC 用でないスタック名は消さない: ${stack}（awsbridge-human-poc で始まる名前だけ）" >&2
  exit 1
fi

echo "削除対象: スタック ${stack}（AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}）" >&2
aws cloudformation delete-stack --stack-name "$stack"
aws cloudformation wait stack-delete-complete --stack-name "$stack"
echo "スタックを削除しました: ${stack}"

echo "削除対象: Worker awsbridge-human-poc" >&2
(cd "$root" && pnpm exec wrangler delete --config "$here/wrangler.jsonc" --name awsbridge-human-poc)

rm -f "$out_dir"/console-url-*.txt "$out_dir"/credentials*.json
echo "ログイン URL と認証情報のファイルを消しました: ${out_dir}"
