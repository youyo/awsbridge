#!/usr/bin/env bash
# Terraform サンプルの静的検査。plan / apply はしない（Cloudflare に接続しない）。
set -euo pipefail
cd "$(dirname "$0")"

terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
tflint --init
tflint
