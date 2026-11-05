# Cloudflare Access / MCP Server Portal の Terraform サンプル

awsbridge Worker を Cloudflare Access と MCP Server Portal の背後に置くための**参考実装**です。

- 上流の作者は別の IaC で管理しているため、このサンプルを実際に apply しては検証していません。
- CI で保証するのは `terraform fmt` / `terraform validate` / `tflint` が通ることだけです（`bash infra/cloudflare/check.sh`）。
- apply する前に、必ず `terraform plan` の差分を読んでください。

## 作るもの

| リソース | 役割 |
|---|---|
| `cloudflare_zero_trust_access_application.worker` | Worker 本体を守る self-hosted アプリ（Managed OAuth 有効）。この **AUD** を Worker の `ACCESS_AUD` に設定する |
| `cloudflare_zero_trust_access_policy.bypass_everyone` / `...application.well_known_bypass` | `/.well-known/openid-configuration` と `/.well-known/jwks.json` を Access の対象外にする。AWS IAM / STS が認証なしで取りに来るため |
| `cloudflare_zero_trust_access_ai_controls_mcp_server.this` | ポータルに登録する MCP サーバー（`https://<worker_host>/mcp`、`auth_type = "oauth"`） |
| `cloudflare_zero_trust_access_application.mcp` | `type = "mcp"` のアプリ。無いとポータルの同意画面に出ない |
| `cloudflare_zero_trust_access_application.portal` / `...ai_controls_mcp_portal.this` | ポータル本体。`create_portal = true` のときだけ作る |

## 前提

- Cloudflare Zero Trust が有効なアカウント
- Zero Trust に登録済みの IdP（その ID を `allowed_idp_ids` に渡す）
- 既存の reusable policy（その ID を `access_policy_ids` に渡す。ログインを許可する利用者はこのポリシーで決める）
- API トークン（環境変数 `CLOUDFLARE_API_TOKEN`）。Access アプリ・ポリシーと MCP サーバー／ポータルを編集できる権限が必要
- Worker はデプロイ済みで、`worker_host` でアクセスできること

## 変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `account_id` | はい | Cloudflare アカウント ID |
| `worker_host` | はい | Worker のホスト名（スキーム・パスなし） |
| `allowed_idp_ids` | はい | 許可する IdP の ID 一覧 |
| `access_policy_ids` | はい | 適用する既存 reusable policy の ID 一覧（先頭ほど優先） |
| `name` | いいえ | リソース名の接頭辞（既定 `awsbridge`） |
| `session_duration` | いいえ | アプリのセッション期間（既定 `24h`） |
| `create_portal` | いいえ | `true` でポータルも作る（既定 `false`） |
| `portal_hostname` | `create_portal` 時 | ポータルのホスト名 |
| `portal_oauth_allowed_uris` | いいえ | ポータルの DCR で許可するリダイレクト URI |
| `portal_session_duration` | いいえ | ポータルのセッション期間（既定 `24h`） |

`terraform.tfvars.example` をコピーして `terraform.tfvars` を作り、自分の値に置き換えます。`terraform.tfvars` と state は gitignore 済みです。

## 手順

```sh
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # 編集する
export CLOUDFLARE_API_TOKEN=...
terraform init
terraform plan
terraform apply
```

撤去するときは `terraform destroy` です。state はローカルに置かれるので、失くさないでください（チームで使うなら `versions.tf` に remote backend を足す）。

## apply 後にやること

1. 出力 `worker_access_aud` を `mise.local.toml` の `AWSBRIDGE_ACCESS_AUD` に入れ、`mise run secrets` で Worker の secret `ACCESS_AUD` に登録する。`mcp_access_aud` やポータルの AUD は使わない（STS の信頼にも使わない）。
2. `auth_type = "oauth"` の MCP サーバーを API / Terraform で作ると、管理者の資格がなく `waiting` のままになることがある。ダッシュボードの MCP servers から一度認証して Ready にする。

## MCP Server Portal 側の注意

- ポータルの **Require user auth は Enabled にする**。Disabled だと管理者の資格で全員が接続する。
- ポータルは `tools/list` を管理者の資格で同期・キャッシュするため、利用者ごとの `aws_profile` enum の注入は効かない。認可は `tools/call` 側で強制される。
- Code Mode（Required）では tools が 2 つに集約され、`aws_profile` 引数の説明が届きにくい。

詳しくは [`docs/specs/architecture.md`](../../docs/specs/architecture.md) の「MCP Server Portal 背後に置くことの制約」を参照してください。

### 既存のポータルを使う場合

`cloudflare_zero_trust_access_ai_controls_mcp_portal` は `servers` の一覧全体を所有します。同じポータルを別の Terraform や手作業でも管理していると、片方の apply でもう片方の登録が消えるため、共存管理できません。

既存のポータルを使うなら `create_portal = false`（既定）のままにします。出力 `mcp_server_id` を、ポータルを管理している側の `servers` に追加するか、ダッシュボードで追加してください。

## 検証

```sh
bash infra/cloudflare/check.sh
```

`terraform fmt -check`、`terraform init -backend=false`、`terraform validate`、`tflint` を順に実行します。Cloudflare には接続しません。

## provider 5.27.0 の注意

`type = "mcp"` のアプリには `cors_headers` / `enable_binding_cookie` / `options_preflight_bypass` を設定できません。API 側に残る既定値との差分を避けるため、`lifecycle.ignore_changes` で無視しています。
