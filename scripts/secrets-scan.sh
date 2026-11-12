#!/usr/bin/env bash
# 秘密の検査（mise run secrets:scan）: gitleaks で (1) コミットの履歴と (2) 作業ツリー（未コミット・未追跡を含む。.gitignore のものは除く）を見る。
# 作業ツリーは git ls-files で選んだファイルだけを一時ディレクトリに写して gitleaks dir にかける（node_modules などを見ない）。値は伏せて出す。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# 作業ツリーで削除した tracked のファイルは一覧に残るので、存在するファイルだけを渡す
git ls-files -co --exclude-standard -z |
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then printf '%s\0' "$f"; fi
  done |
  rsync -a --from0 --files-from=- . "$tmp/tree"
gitleaks git . --redact --no-banner
gitleaks dir "$tmp/tree" --redact --no-banner
