# コンソールログイン用の Cloudflare Access の Terraform の例

人の AWS コンソールへのログイン（コンソールログイン）のポータル（入口の画面）を守る Access アプリの**参考実装**です。MCP 用の [`infra/cloudflare/`](../README.md) とは別のディレクトリ・別の state で、MCP 用のリソースは含みません。

- 実際に apply しては検証していません（MCP 用と同じ扱い）。CI で保証するのは `terraform fmt` / `validate` / `tflint` が通ることだけです（`bash infra/cloudflare/check.sh`、`mise run lint`）。
- apply する前に、必ず `terraform plan` の差分を読んでください。
- 設計は [`docs/specs/console-login.md`](../../../docs/specs/console-login.md) §5.4、[`console-login-portal.md`](../../../docs/specs/console-login-portal.md) §9.1。

## 作るもの

| リソース | 役割 |
|---|---|
| `cloudflare_zero_trust_access_application.entry` | 入口のアプリ。階層（`standard`、Admin のチームがあれば `admin`）ごとに 1 つ。ホスト全体（`standard_host` / `admin_host`）を守る |
| `cloudflare_zero_trust_access_application.team` | チームのアプリ。`teams` のキー（設定ファイルのチーム名）ごとに 1 つ。`<ホスト>/t/<チーム>` を守る。階層が `admin` のチームは `admin_host` の下に置く |

どのアプリも `type = "self_hosted"`、`enable_binding_cookie = true`、`same_site_cookie_attribute = "lax"`、**`path_cookie_attribute = true`**（変数にしない）です。適用後の値が true でなければ、`lifecycle.postcondition` で失敗します。

## なぜ Cookie Path を固定するか

パスでチームを分ける構成（`portal.routing: path`。既定）では、入口のアプリ（ホスト全体）とチームのアプリ（`/t/<チーム>`）が同じホストに並びます。Cookie Path が無効だと、同じホストの別のアプリの AUD も Access JWT の `aud` に入り、Worker の「`aud` はちょうど 1 つ」の検査で断られて、ログインができなくなります。ホストでチームを分ける構成（`routing: host`）では Cookie もホストで分かれますが、この例は `routing: path` の形だけを書いています。

## 変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `account_id` | はい | Cloudflare アカウント ID |
| `standard_host` | はい | Standard の入口のホスト名（スキーム・パスなし。例 `awsbridge-console.example.com`）。設定ファイルの `portal.standardOrigin` のホスト |
| `admin_host` | Admin のチームがあるとき | Admin の入口のホスト名（例 `awsbridge-admin-console.example.com`）。Standard とは別のホスト |
| `allowed_idp_ids` | はい | 許可する IdP の ID 一覧 |
| `teams` | はい | チーム名 → `{ tier, policy_ids }`。チーム名は設定ファイルと同じにする。`policy_ids` はそのチームの利用者だけを許可する既存の reusable policy |
| `entry_policy_ids` | はい | 階層（`standard` / `admin`）→ 入口に付ける reusable policy の ID（その階層のチームの利用者をすべて含む範囲） |
| `name` | いいえ | アプリ名の接頭辞（既定 `awsbridge-console`） |
| `standard_session_duration` / `admin_session_duration` | いいえ | セッション期間（既定 `24h` / `15m`）。Admin は Admin の Worker の `ACCESS_MAX_AGE_SECONDS`（既定 900 秒）に揃える |

`terraform.tfvars.example` をコピーして `terraform.tfvars` を作ります（`terraform.tfvars` と state は gitignore 済み）。実在のアカウント ID・ドメイン・ポリシー ID はコミットしません。

## 手順

```sh
cd infra/cloudflare/console
cp terraform.tfvars.example terraform.tfvars   # 編集する
export CLOUDFLARE_API_TOKEN=...                # Access アプリを編集できる権限
terraform init
terraform plan
terraform apply
```

## apply 後にやること

1. AUD を設定ファイルの検査・生成に渡す。`terraform output -json console_aud > "$AWSBRIDGE_CONSOLE_AUD_FILE"`（`{ "teams": {…}, "entry": {…} }`。AUD は端末に出さずにファイルへ。ファイルはコミットしない）。そのあと `mise run console:config:generate`。
2. 実物を確かめる: `mise run console:access:inspect`（Cloudflare API を GET だけで読む）。入口とチームのアプリが在ること、対象の場所、Cookie Path が有効なことを見る。トークンは Access: Apps and Policies の Read だけを `AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN` に、アカウント ID を `AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID` に与える（`mise.local.toml`）。手でアプリを変えたあとにも回す。
3. issuer のホスト（例 `awsbridge-oidc-console.example.com`）にはこの Access のアプリを作らない（AWS IAM / STS が認証なしで取りに来る）。

撤去するときは `terraform destroy` です。state はローカルに置かれるので、失くさないでください（チームで使うなら `versions.tf` に remote backend を足す）。
