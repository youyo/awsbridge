#!/usr/bin/env bash
# PoC X1-(h) の片付け: Worker awsbridge-x1h-poc を消し（secret_key・secret_text のバインディングも一緒に消える）、
# 手元のデプロイ用の設定を消す（計測の記録 runs.jsonl は残す。鍵・bearer は手元に置いていない）。
# 残っていないことの確認は mise run poc:x1h:clean-check（API で数える）。何度実行してもよい。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
worker="awsbridge-x1h-poc"
echo "削除対象: Worker ${worker}" >&2
(cd "$root" && env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler delete --name "$worker" --force) ||
  echo "（Worker の削除は失敗または対象なし。clean-check で確かめる）" >&2
rm -f "$root/.secrets/poc-x1h/wrangler.deploy.json"
echo "手元のデプロイ用の設定を消しました"
