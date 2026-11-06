#!/usr/bin/env bash
# wrangler を、使う設定ファイルと環境を環境変数で切り替えて呼ぶ。引数はそのまま wrangler に渡す。
#   AWSBRIDGE_WRANGLER_CONFIG  wrangler の設定ファイル（既定 wrangler.jsonc。リポジトリルート相対）
#   AWSBRIDGE_WRANGLER_ENV     wrangler の --env（未設定なら dev。空文字なら --env を付けない）
# 下流リポジトリは wrangler.<name>.jsonc を足し、mise.<name>.toml でこれらを与える（README_ja.md 参照）。
set -euo pipefail

cd "$(dirname "$0")/.."

args=(--config "${AWSBRIDGE_WRANGLER_CONFIG:-wrangler.jsonc}")
# 未設定（既定 dev）と空文字（env なし）を区別するため ":-" ではなく "-" を使う
wrangler_env="${AWSBRIDGE_WRANGLER_ENV-dev}"
if [ -n "$wrangler_env" ]; then
  args+=(--env "$wrangler_env")
fi

exec pnpm exec wrangler "$@" "${args[@]}"
