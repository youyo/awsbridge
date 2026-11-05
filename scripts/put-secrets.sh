#!/usr/bin/env bash
# Worker secret（SIGNING_JWK / ACCESS_TEAM_DOMAIN / ACCESS_AUD / AWS_PROFILES）を一括登録する。
# 値は wrangler の標準入力に JSON で渡し、コマンドライン引数には載せない。
# 値はすべて環境変数（mise.toml / mise.local.toml）から読む。AWS は呼ばない
# AWS_PROFILES（default とプロファイル一覧）は JSON 文字列の AWSBRIDGE_PROFILES から読む
# （各ロール ARN は CloudFormation の Output RoleArn）。デプロイ環境は AWSBRIDGE_WRANGLER_ENV（既定 dev）。
set -euo pipefail

need() {
  if [ -z "${!1:-}" ]; then
    echo "$1 が未設定です。mise.local.toml に設定してください。" >&2
    exit 1
  fi
}
for v in AWSBRIDGE_KEY_FILE AWSBRIDGE_ACCESS_TEAM_DOMAIN AWSBRIDGE_ACCESS_AUD; do
  need "$v"
done

if [ ! -r "$AWSBRIDGE_KEY_FILE" ]; then
  echo "署名鍵ファイルを読めません（AWSBRIDGE_KEY_FILE）。mise run keygen で生成してください。" >&2
  exit 1
fi

# AWSBRIDGE_PROFILES が JSON として読めること（値はエラーに出さない）
# 未設定（空）なら AWS_PROFILES は登録しない（wrangler の vars で持つ環境向け）
if [ -z "${AWSBRIDGE_PROFILES:-}" ]; then
  echo "AWSBRIDGE_PROFILES が未設定のため AWS_PROFILES は登録しません（vars で与えてください）。" >&2
elif ! node -e 'JSON.parse(process.env.AWSBRIDGE_PROFILES)' 2>/dev/null; then
  echo "AWSBRIDGE_PROFILES が JSON として不正です。mise.local.toml を確認してください。" >&2
  exit 1
fi

# JSON は node で組み立てる（bash の文字列連結ではエスケープが保証できない）。値は環境変数で渡す。
node -e '
const fs = require("node:fs");
const e = process.env;
process.stdout.write(JSON.stringify({
  SIGNING_JWK: fs.readFileSync(e.AWSBRIDGE_KEY_FILE, "utf8").trim(),
  ACCESS_TEAM_DOMAIN: e.AWSBRIDGE_ACCESS_TEAM_DOMAIN,
  ACCESS_AUD: e.AWSBRIDGE_ACCESS_AUD,
  ...(e.AWSBRIDGE_PROFILES ? { AWS_PROFILES: e.AWSBRIDGE_PROFILES } : {}),
}));
' | pnpm exec wrangler secret bulk --env "${AWSBRIDGE_WRANGLER_ENV:-dev}"
