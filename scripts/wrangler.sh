#!/usr/bin/env bash
# wrangler を、使う設定ファイルと環境を環境変数で切り替えて呼ぶ。引数はそのまま wrangler に渡す。
#   AWSBRIDGE_WRANGLER_CONFIG       wrangler の設定ファイル（既定 wrangler.jsonc。リポジトリルート相対）
#   AWSBRIDGE_WRANGLER_ENV          wrangler の --env（未設定なら dev。空文字なら --env を付けない）
#   AWSBRIDGE_WRANGLER_DEPLOY_MODE  deploy サブコマンドの経路（未設定なら versions）
#     versions  wrangler versions upload → versions deploy <id>@100% --yes の 2 段。
#               Custom Domain・Route などの triggers は同期しない。ゾーンの権限が無い「その Worker だけのトークン」で通る。
#               Worker が無い初回は失敗する（先に deploy モードで作る）。
#     deploy    wrangler deploy（triggers の同期を含む）。Custom Domain の初回・変更は、これを利用者の短命のトークンで流す。
#   --dry-run を含む deploy は、モードに関係なく wrangler deploy --dry-run（何も書かない）。
# 下流リポジトリは wrangler.<name>.jsonc を足し、mise.<name>.toml でこれらを与える（README_ja.md 参照）。
set -euo pipefail

cd "$(dirname "$0")/.."

args=(--config "${AWSBRIDGE_WRANGLER_CONFIG:-wrangler.jsonc}")
# 未設定（既定 dev）と空文字（env なし）を区別するため ":-" ではなく "-" を使う
wrangler_env="${AWSBRIDGE_WRANGLER_ENV-dev}"
if [ -n "$wrangler_env" ]; then
  args+=(--env "$wrangler_env")
fi

# deploy を versions upload + versions deploy に置き換えるのは、モードが versions で --dry-run が無いときだけ
use_versions=0
if [ "${1:-}" = "deploy" ]; then
  mode="${AWSBRIDGE_WRANGLER_DEPLOY_MODE:-versions}"
  case "$mode" in
    versions) use_versions=1 ;;
    deploy) ;;
    *)
      echo "wrangler.sh: AWSBRIDGE_WRANGLER_DEPLOY_MODE は versions か deploy（値: $mode）" >&2
      exit 2
      ;;
  esac
  for a in "$@"; do
    if [ "$a" = "--dry-run" ]; then
      use_versions=0
    fi
  done
fi

if [ "$use_versions" -eq 0 ]; then
  exec pnpm exec wrangler "$@" "${args[@]}"
fi

# ---- versions 経路 ----
shift # deploy

# wrangler 4.112 の versions upload が受け付ける引数だけを通す。受け付けないものは黙って捨てずに止める
reject() {
  echo "wrangler.sh: deploy の引数 '$1' は versions upload で使えません。$2" >&2
  echo "  triggers（Custom Domain・Route）を含めて deploy するときは AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy を指定してください。" >&2
  exit 2
}
upload_args=()
while [ "$#" -gt 0 ]; do
  a="$1"
  shift
  case "$a" in
    --config | -c | --config=* | --env | -e | --env=*)
      reject "$a" "--config と --env は AWSBRIDGE_WRANGLER_CONFIG / AWSBRIDGE_WRANGLER_ENV で指定します。"
      ;;
    --minify | --no-bundle | --upload-source-maps | --keep-vars | --strict | --latest)
      upload_args+=("$a")
      ;;
    --var=* | --message=* | --tag=* | --name=* | --outdir=* | --outfile=* | --define=* | --alias=* | --assets=* | \
      --compatibility-date=* | --compatibility-flags=* | --compatibility-flag=* | --secrets-file=* | --preview-alias=* | \
      --jsx-factory=* | --jsx-fragment=* | --tsconfig=*)
      upload_args+=("$a")
      ;;
    --var | --message | --tag | --name | --outdir | --outfile | --define | --alias | --assets | \
      --compatibility-date | --compatibility-flags | --compatibility-flag | --secrets-file | --preview-alias | \
      --jsx-factory | --jsx-fragment | --tsconfig)
      if [ "$#" -eq 0 ]; then
        echo "wrangler.sh: deploy の引数 '$a' に値がありません。" >&2
        exit 2
      fi
      upload_args+=("$a" "$1")
      shift
      ;;
    *)
      reject "$a" "versions upload が受け付ける引数ではありません。"
      ;;
  esac
done

out_file="$(mktemp)"
trap 'rm -f "$out_file"' EXIT

# 出力は利用者にも見せる。pipefail で wrangler の終了コードを保つ
set +e
pnpm exec wrangler versions upload ${upload_args[@]+"${upload_args[@]}"} "${args[@]}" 2>&1 | tee "$out_file"
upload_status="${PIPESTATUS[0]}"
set -e
if [ "$upload_status" -ne 0 ]; then
  exit "$upload_status"
fi

# 色付きの出力でも取れるよう ANSI を除き、UUID の形のものだけを Version ID とする（コマンドに渡すため）
esc="$(printf '\033')"
version_id="$(
  sed -e "s/${esc}\[[0-9;]*[A-Za-z]//g" "$out_file" |
    sed -nE 's/.*Worker Version ID:[[:space:]]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[[:space:]]*$/\1/p' |
    tail -n 1
)"
if [ -z "$version_id" ]; then
  echo "wrangler.sh: versions upload の出力から Version ID を取り出せませんでした。versions deploy は流していません。" >&2
  exit 1
fi

rm -f "$out_file"
exec pnpm exec wrangler versions deploy "${version_id}@100%" --yes "${args[@]}"
