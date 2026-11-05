#!/usr/bin/env bash
# Worker secret（SIGNING_JWK / ACCESS_TEAM_DOMAIN / ACCESS_AUD / FEDERATED_ROLE_ARN）を一括登録する。
# 値は wrangler の標準入力に JSON で渡し、コマンドライン引数には載せない。
# 値はすべて環境変数（mise.toml / mise.local.toml）と CloudFormation スタックの Output から読む。
set -euo pipefail

need() {
  if [ -z "${!1:-}" ]; then
    echo "$1 が未設定です。mise.local.toml に設定してください。" >&2
    exit 1
  fi
}
for v in AWSBRIDGE_KEY_FILE AWSBRIDGE_ACCESS_TEAM_DOMAIN AWSBRIDGE_ACCESS_AUD AWSBRIDGE_STACK_NAME; do
  need "$v"
done

if [ ! -r "$AWSBRIDGE_KEY_FILE" ]; then
  echo "署名鍵ファイルを読めません（AWSBRIDGE_KEY_FILE）。mise run keygen で生成してください。" >&2
  exit 1
fi

role_arn="$(aws cloudformation describe-stacks \
  --stack-name "$AWSBRIDGE_STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" \
  --output text)"
if [ -z "$role_arn" ] || [ "$role_arn" = "None" ]; then
  echo "スタック ${AWSBRIDGE_STACK_NAME} の Output RoleArn を取得できません。mise run deploy:aws を先に実行してください。" >&2
  exit 1
fi

# JSON は node で組み立てる（bash の文字列連結ではエスケープが保証できない）。値は環境変数で渡す。
AWSBRIDGE_ROLE_ARN="$role_arn" node -e '
const fs = require("node:fs");
const e = process.env;
process.stdout.write(JSON.stringify({
  SIGNING_JWK: fs.readFileSync(e.AWSBRIDGE_KEY_FILE, "utf8").trim(),
  ACCESS_TEAM_DOMAIN: e.AWSBRIDGE_ACCESS_TEAM_DOMAIN,
  ACCESS_AUD: e.AWSBRIDGE_ACCESS_AUD,
  FEDERATED_ROLE_ARN: e.AWSBRIDGE_ROLE_ARN,
}));
' | pnpm exec wrangler secret bulk --env dev
