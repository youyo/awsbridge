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
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # Access のチームドメイン
AWSBRIDGE_ACCESS_AUD = "<Access アプリケーションの AUD タグ>"   # このアプリケーションの AUD
```

`AWSBRIDGE_ALLOWED_SUBJECTS` の書式: 各要素は `user@example.com` または `*@example.com` の形です。ワイルドカードを使えるのはメールのローカル部だけで、ドメイン部（`*@*` や `*@*.com`）や `*` 単独は使えません（全員に許可してしまうため）。空要素や前後の空白もエラーです。email は小文字に正規化して照合します（Worker は Access JWT の email を小文字にして STS に渡し、`deploy:aws` も `AWSBRIDGE_ALLOWED_SUBJECTS` を小文字にして CloudFormation に渡します）。`deploy:aws` は AWS を呼ぶ前にこれを検証し、CloudFormation テンプレートの `AllowedPattern` でも同じ検査をします。

`AWSBRIDGE_MANAGED_POLICY_ARNS` は、ロールを引き受けた利用者が実行できる操作そのものになります。必要最小限の権限だけを付けてください（未設定なら何も付けません）。

`mise.toml` の既定値: `AWSBRIDGE_AUDIENCE`（`awsbridge`）、`AWSBRIDGE_ROLE_NAME`（`awsbridge`）、`AWSBRIDGE_STACK_NAME`（`awsbridge`）、`AWSBRIDGE_KEY_FILE`（`.secrets/dev-signing-key.json`）。

### 手順

```
mise run keygen   # 署名鍵を生成（.secrets/、既存なら上書きしない）
mise run deploy   # Worker → CloudFormation → secret 登録を順に実行
```

`deploy` の中身は次の 3 つです。個別にも実行できます。

```
mise run deploy:worker   # Worker をデプロイ
mise run deploy:aws      # CloudFormation（OIDC プロバイダー + ロール）をデプロイ
mise run secrets         # Worker secret を一括登録（SIGNING_JWK / ACCESS_TEAM_DOMAIN / ACCESS_AUD / FEDERATED_ROLE_ARN）
```

`secrets` は `wrangler secret bulk` に標準入力で JSON を渡します（値がコマンドライン引数に出ません）。`FEDERATED_ROLE_ARN` は CloudFormation スタックの Output `RoleArn` から取るため、`deploy:aws` の後に実行します。

検証・後片付け:

```
mise run poc:sts      # 検証: 正常 1 + 否定 4 ケース
mise run destroy:aws  # 片付け: CloudFormation スタックを削除
```

### Worker の設定

secret（`mise run secrets` が登録）: `SIGNING_JWK`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`FEDERATED_ROLE_ARN`。

var（任意。既定値を上書きするときだけ）: `ISSUER`（deploy 時に `--var` で設定）、`IDENTITY_CLAIM`（既定 `email`）、`ACCESS_MAX_TOKEN_AGE_SECONDS`、`STS_AUDIENCE`（既定 `awsbridge`）、`STS_REGION`（既定 `us-east-1`）、`STS_ENDPOINT`、`AWS_MCP_REGION`（既定 `us-east-1`）、`AWS_MCP_ENDPOINT`、`TARGET_AWS_REGION`（既定 `ap-northeast-1`）。

`/mcp` のエラーは `{"error":"<code>"}` で返ります: `unauthorized`（401）、`forbidden`（403。ロールを引き受ける権限がない）、`upstream_auth_failed`（502。サーバー側の設定不整合）、`temporarily_unavailable`（503）、`server_misconfigured`（500）。原因ごとの対応表は `docs/specs/architecture.md` の「エラーと HTTP ステータスの対応」を参照してください。
