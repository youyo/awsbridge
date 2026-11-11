#!/usr/bin/env bash
# PoC のポータル: CloudFormation（scripts/poc/human/portal/poc-portal.yaml）で、パス付き issuer の OIDC プロバイダー 2 つと
# ロール 3 つ（AwsbridgeHumanPocPortal*）をデプロイする。Cloudflare は呼ばない。
# MCP 用・既存の PoC の変数は読まない。
# 必須: AWSBRIDGE_HUMAN_POC_PORTAL_URL（https://awsbridge-human-poc-portal.<subdomain>.workers.dev）
# 上書きできる既定値: AWS_PROFILE（awsbridge）/ AWS_REGION（ap-northeast-1）/
#   AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME（awsbridge-human-poc-portal）/ AWSBRIDGE_HUMAN_POC_PORTAL_AUDIENCE（awsbridge-human-poc-portal）/
#   AWSBRIDGE_HUMAN_POC_PORTAL_SHARED_TEAMS（infra,dev）/ AWSBRIDGE_HUMAN_POC_PORTAL_RESTRICTED_TEAM（infra）
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-awsbridge}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
stack="${AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME:-awsbridge-human-poc-portal}"
audience="${AWSBRIDGE_HUMAN_POC_PORTAL_AUDIENCE:-awsbridge-human-poc-portal}"
shared_teams="${AWSBRIDGE_HUMAN_POC_PORTAL_SHARED_TEAMS:-infra,dev}"
restricted_team="${AWSBRIDGE_HUMAN_POC_PORTAL_RESTRICTED_TEAM:-infra}"

if [ -z "${AWSBRIDGE_HUMAN_POC_PORTAL_URL:-}" ]; then
  echo "AWSBRIDGE_HUMAN_POC_PORTAL_URL が未設定です。mise.local.toml に設定してください。" >&2
  exit 1
fi
url="${AWSBRIDGE_HUMAN_POC_PORTAL_URL%/}"
if ! [[ "$url" =~ ^https://awsbridge-human-poc-portal\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "AWSBRIDGE_HUMAN_POC_PORTAL_URL が不正です（https://awsbridge-human-poc-portal.<subdomain>.workers.dev の形。パスは不可）。" >&2
  exit 1
fi
host="${url#https://}"

if [[ "$stack" != awsbridge-human-poc-portal && "$stack" != awsbridge-human-poc-portal-* ]]; then
  echo "エラー: PoC のポータル用でないスタック名は扱わない: ${stack}" >&2
  exit 1
fi
team_re='^[a-z0-9][a-z0-9-]{0,31}$'
IFS=',' read -r -a teams <<<"$shared_teams"
for t in "${teams[@]}" "$restricted_team"; do
  if ! [[ "$t" =~ $team_re ]]; then
    echo "チーム名が不正です: '${t}'（小文字英数字とハイフン）" >&2
    exit 1
  fi
done

template="$(cd "$(dirname "$0")" && pwd)/poc-portal.yaml"
echo "デプロイ: スタック ${stack}（AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}）" >&2
aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$template" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --tags project=awsbridge-human-poc-portal \
  --parameter-overrides "IssuerHost=${host}" "Audience=${audience}" "SharedTeams=${shared_teams}" "RestrictedTeam=${restricted_team}"

aws cloudformation describe-stacks \
  --stack-name "$stack" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output text
