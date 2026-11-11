#!/usr/bin/env bash
# PoC のポータル用 Access アプリの Terraform の静的検査。plan / apply はしない（Cloudflare に接続しない）。
set -euo pipefail
cd "$(dirname "$0")"

terraform fmt -check -recursive
terraform init -backend=false -input=false >/dev/null
terraform validate
tflint --init >/dev/null
tflint
