# awsbridge

Bridge AI agents to AWS.

Cloudflare Access で認証された利用者の身元を、利用者ごとの AWS 一時認証情報（STS）に変換し、SigV4 署名して AWS MCP Server へ中継する Cloudflare Worker です。Cloudflare MCP Server Portal の背後に置くことを前提としています。

> 開発初期段階です。設計は [docs/specs/architecture.md](docs/specs/architecture.md) を参照してください。

前身: [youyo/aws-mcp-gateway](https://github.com/youyo/aws-mcp-gateway)

## デプロイ

Worker のデプロイと CloudFormation のデプロイの 2 つで環境が整います。CloudFormation（[infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml)）は、Worker の URL を issuer とする IAM OIDC プロバイダーと、Worker 発行の JWT で引き受けるロールを作ります。

### 前提

- [mise](https://mise.jdx.dev/)（`mise install` でランタイムと cfn-lint が入ります）
- `wrangler login` 済みの Cloudflare アカウント
- AWS の認証（`AWS_PROFILE` など。IAM と CloudFormation を操作できる権限）

### 設定

固定の既定値は `mise.toml` にあります。アカウント固有の値は `mise.local.toml`（gitignore）に書きます。

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge.example.workers.dev"   # Worker の URL（OIDC issuer）
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # ロールを引き受けられる利用者（カンマ区切り）
# AWSBRIDGE_MANAGED_POLICY_ARNS = "arn:aws:iam::aws:policy/ReadOnlyAccess" # 任意。ロールに付ける管理ポリシー
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # poc:sts の正常ケースで使う利用者
```

`AWSBRIDGE_ALLOWED_SUBJECTS` の書式: 各要素は `user@example.com` または `*@example.com` の形です。ワイルドカードを使えるのはメールのローカル部だけで、ドメイン部（`*@*` や `*@*.com`）や `*` 単独は使えません（全員に許可してしまうため）。空要素や前後の空白もエラーです。`deploy:aws` は AWS を呼ぶ前にこれを検証し、CloudFormation テンプレートの `AllowedPattern` でも同じ検査をします。

`AWSBRIDGE_MANAGED_POLICY_ARNS` は、ロールを引き受けた利用者が実行できる操作そのものになります。必要最小限の権限だけを付けてください（未設定なら何も付けません）。

`mise.toml` の既定値: `AWSBRIDGE_AUDIENCE`（`awsbridge`）、`AWSBRIDGE_ROLE_NAME`（`awsbridge`）、`AWSBRIDGE_STACK_NAME`（`awsbridge`）、`AWSBRIDGE_KEY_FILE`（`.secrets/dev-signing-key.json`）。

### 手順

```
mise run keygen              # 署名鍵を生成（.secrets/、既存なら上書きしない）
mise run deploy:worker       # Worker をデプロイ（secret 登録より先に Worker を作る）
mise run secret:signing-key  # 署名鍵を Worker secret SIGNING_JWK に登録
mise run deploy:aws          # CloudFormation（OIDC プロバイダー + ロール）をデプロイ
mise run poc:sts             # 検証: 正常 1 + 否定 4 ケース
mise run destroy:aws         # 片付け: CloudFormation スタックを削除
```

2 回目以降は `mise run deploy`（`deploy:worker` → `deploy:aws`）で足ります。
