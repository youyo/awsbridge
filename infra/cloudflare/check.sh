#!/usr/bin/env bash
# Terraform サンプルの静的検査。plan / apply はしない（Cloudflare に接続しない）。
# 対象: このディレクトリ（MCP 用）と console/（コンソールログイン用の Access の例。別の state）。
set -euo pipefail
cd "$(dirname "$0")"

# fmt は console/ も含めて再帰で見る
terraform fmt -check -recursive

for dir in . console; do
  echo "== infra/cloudflare/${dir#./} =="
  terraform -chdir="$dir" init -backend=false -input=false
  terraform -chdir="$dir" validate
  (cd "$dir" && tflint --init && tflint)
done
