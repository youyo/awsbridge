#!/usr/bin/env bash
# Worker secret（SIGNING_JWK / ADDITIONAL_PUBLIC_JWKS / ACCESS_TEAM_DOMAIN / ACCESS_AUD / AWS_PROFILES）を一括登録する。
# 値は wrangler の標準入力に JSON で渡し、コマンドライン引数には載せない。
# 値はすべて環境変数（mise.toml / mise.local.toml）から読む。AWS は呼ばない
# AWS_PROFILES（default とプロファイル一覧）は JSON 文字列の AWSBRIDGE_PROFILES から読む
# （各ロール ARN は CloudFormation の Output ReadOnlyRoleArn）。wrangler の設定と環境は scripts/wrangler.sh が
# AWSBRIDGE_WRANGLER_CONFIG（既定 wrangler.jsonc）/ AWSBRIDGE_WRANGLER_ENV（既定 dev、空なら --env なし）で決める。
# AWSBRIDGE_KEY_FILE の既定はリポジトリルートの .secrets/dev-signing-key.json。
# 署名鍵のローテーション: AWSBRIDGE_NEXT_KEY_FILE / AWSBRIDGE_PREVIOUS_KEY_FILE（既定は KEY_FILE の拡張子の前に
# .next / .previous を付けたもの）が存在すれば、その公開鍵（kty, n, e だけ）を ADDITIONAL_PUBLIC_JWKS に登録する。
# 秘密成分は SIGNING_JWK 以外に載せない。どちらも無ければ空配列 [] を登録する（前回の追加鍵を確実に消すため）。
set -euo pipefail

need() {
  if [ -z "${!1:-}" ]; then
    echo "$1 が未設定です。mise.local.toml に設定してください。" >&2
    exit 1
  fi
}
root="$(cd "$(dirname "$0")/.." && pwd)"
export AWSBRIDGE_KEY_FILE="${AWSBRIDGE_KEY_FILE:-${root}/.secrets/dev-signing-key.json}"
for v in AWSBRIDGE_ACCESS_TEAM_DOMAIN AWSBRIDGE_ACCESS_AUD; do
  need "$v"
done

if [ ! -r "$AWSBRIDGE_KEY_FILE" ]; then
  echo "署名鍵ファイルを読めません（AWSBRIDGE_KEY_FILE、既定 .secrets/dev-signing-key.json）。mise run keygen で生成してください。" >&2
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

case "${AWSBRIDGE_KEY_FILE##*/}" in
  *.*) key_stem="${AWSBRIDGE_KEY_FILE%.*}" ;;
  *) key_stem="$AWSBRIDGE_KEY_FILE" ;;
esac
export AWSBRIDGE_NEXT_KEY_FILE="${AWSBRIDGE_NEXT_KEY_FILE:-${key_stem}.next.json}"
export AWSBRIDGE_PREVIOUS_KEY_FILE="${AWSBRIDGE_PREVIOUS_KEY_FILE:-${key_stem}.previous.json}"

# next / previous の鍵ファイルは、Worker と同じ検証関数（src/keys.ts の publicJwkOf）を通ること。
# 通らない鍵を載せると Worker は読み飛ばすので、登録前に気づけるようここで止める（pnpm 経由にせず tsx を直接呼ぶ）
for pair in "NEXT:${AWSBRIDGE_NEXT_KEY_FILE}" "PREVIOUS:${AWSBRIDGE_PREVIOUS_KEY_FILE}"; do
  if [ -e "${pair#*:}" ] && ! "${root}/node_modules/.bin/tsx" "${root}/scripts/check-public-jwk.ts" "${pair#*:}" 2>/dev/null; then
    echo "AWSBRIDGE_${pair%%:*}_KEY_FILE のファイルが RSA 2048 bit 以上の鍵として使えません: ${pair#*:}" >&2
    exit 1
  fi
done

# JSON は node で組み立てる（bash の文字列連結ではエスケープが保証できない）。値は環境変数で渡す。
# 検証に失敗したら wrangler を呼ばない（パイプにせず、いったん変数に受ける。値は引数に載せない）
payload="$(node -e '
const fs = require("node:fs");
const e = process.env;
// 次の鍵・前の鍵の公開成分（kty, n, e）だけを取り出す。無ければ載せない。中身はエラーに出さない
function publicOf(envName) {
  const file = e[envName];
  if (!fs.existsSync(file)) return undefined;
  let jwk;
  try {
    jwk = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    jwk = undefined;
  }
  if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    console.error(envName + " のファイルを RSA 鍵 JWK として読めません: " + file);
    process.exit(1);
  }
  return { kty: "RSA", n: jwk.n, e: jwk.e };
}
const additional = [publicOf("AWSBRIDGE_NEXT_KEY_FILE"), publicOf("AWSBRIDGE_PREVIOUS_KEY_FILE")].filter(Boolean);
process.stdout.write(JSON.stringify({
  SIGNING_JWK: fs.readFileSync(e.AWSBRIDGE_KEY_FILE, "utf8").trim(),
  ADDITIONAL_PUBLIC_JWKS: JSON.stringify(additional),
  ACCESS_TEAM_DOMAIN: e.AWSBRIDGE_ACCESS_TEAM_DOMAIN,
  ACCESS_AUD: e.AWSBRIDGE_ACCESS_AUD,
  ...(e.AWSBRIDGE_PROFILES ? { AWS_PROFILES: e.AWSBRIDGE_PROFILES } : {}),
}));
')"
printf '%s' "$payload" | bash "${root}/scripts/wrangler.sh" secret bulk
