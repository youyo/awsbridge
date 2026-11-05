# awsbridge

Bridge AI agents to AWS.

Cloudflare Access で認証された利用者の身元を、利用者ごとの AWS 一時認証情報（STS）に変換し、SigV4 署名して AWS MCP Server へ中継する Cloudflare Worker です。Cloudflare MCP Server Portal の背後に置くことを前提としています。

> 開発初期段階です。設計は [docs/specs/architecture.md](docs/specs/architecture.md) を参照してください。

前身: [youyo/aws-mcp-gateway](https://github.com/youyo/aws-mcp-gateway)

## デプロイ

Cloudflare 側（Worker）と AWS 側（CloudFormation）は完全に分かれています。Worker のデプロイは AWS を呼ばず、CloudFormation のデプロイは Cloudflare を呼びません。対象の AWS アカウントには CloudFormation だけを流せば足ります。

### 前提

- [mise](https://mise.jdx.dev/)（`mise install` でランタイムと cfn-lint が入ります）
- Cloudflare 側: `wrangler login` 済みのアカウント
- AWS 側: IAM と CloudFormation を操作できる権限を持つ AWS プロファイル

### 初回の順序

Worker の URL が OIDC issuer になるため、次の順で進めます。

1. Cloudflare 側: `mise run keygen` → `mise.local.toml` に `AWSBRIDGE_ISSUER` などを設定 → `mise run deploy:worker`（Worker の URL を確定させる。この時点ではプロファイル一覧が未登録なので `/mcp` は 500 になる）
2. AWS 側: `AWS_PROFILE=<対象> mise run deploy:aws`（出力 `RoleArn` を控える）
3. プロファイル一覧を登録する。secret で持つ場合は `mise.local.toml` に `AWSBRIDGE_PROFILES` を設定して `mise run secrets`、`wrangler.jsonc` の vars で持つ場合（下流リポジトリ）は vars に書いて `mise run deploy:worker`

2 回目以降は、変更した側だけを流します。

### AWS 側（対象アカウントごと）

[infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml) を流すだけです。Worker の URL を issuer とする IAM OIDC プロバイダーと、Worker 発行の JWT で引き受けるロールを作ります。

```
AWS_PROFILE=<対象> mise run deploy:aws    # CloudFormation をデプロイ（何度でも別アカウントに流せる）
AWS_PROFILE=<対象> mise run destroy:aws   # 片付け: スタックを削除
```

`AWS_PROFILE` は呼び出し側の値が優先されます（未設定なら `awsbridge`）。`AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_ROLE_NAME` / `AWSBRIDGE_AUDIENCE` も同様に環境変数で上書きできます。一方、`mise.local.toml` に書いた値は環境変数より優先されることがあります。その場合は、mise の環境を読み込んだうえで値を指定して直接実行してください。

```
mise exec -- env AWS_PROFILE=<対象> AWSBRIDGE_ALLOWED_SUBJECTS="user@example.com" bash scripts/deploy-aws.sh
```

マネジメントコンソールや StackSets でテンプレートを直接流すこともできます。そのときのパラメーター:

| パラメーター | 説明 |
|---|---|
| `IssuerHost` | Worker のホスト名（`https://` と末尾 `/` なし。例: `awsbridge.example.workers.dev`） |
| `Audience` | JWT の audience（既定 `awsbridge`。Worker の `STS_AUDIENCE` と一致させる） |
| `AllowedSubjects` | ロールを引き受けられる利用者（カンマ区切り。下記の書式。小文字で指定） |
| `RoleName` | ロール名（既定 `awsbridge`） |
| `ManagedPolicyArns` | 任意。ロールに付ける管理ポリシー（カンマ区切り） |

デプロイ後、出力 `RoleArn` を控えます（`aws cloudformation describe-stacks` でも取れます）。

### Cloudflare 側（1 回）

```
mise run keygen          # 署名鍵を生成（.secrets/、既存なら上書きしない）
# mise.local.toml に AWSBRIDGE_ISSUER / AWSBRIDGE_ACCESS_* / AWSBRIDGE_PROFILES などを設定
mise run deploy:worker   # wrangler deploy → secrets を順に実行（AWS は呼ばない）
```

`secrets` は単独でも実行できます（`mise run secrets`）。`wrangler secret bulk` に標準入力で JSON を渡すので、値がコマンドライン引数に出ません。登録するのは `SIGNING_JWK` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `AWS_PROFILES` で、`AWS_PROFILES` は `AWSBRIDGE_PROFILES`（JSON 文字列）から読みます。

検証: `mise run poc:sts`（正常 1 + 否定 4 ケース。実 AWS を呼ぶので明示的に実行したときだけ使います）。

### `mise.local.toml` の変数

固定の既定値は `mise.toml` にあります。アカウント固有の値は `mise.local.toml`（gitignore）に書きます（値はすべてプレースホルダーです）。

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge.example.workers.dev"   # Worker の URL（OIDC issuer）
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # ロールを引き受けられる利用者（カンマ区切り）
# AWSBRIDGE_MANAGED_POLICY_ARNS = "arn:aws:iam::aws:policy/ReadOnlyAccess" # 任意。ロールに付ける管理ポリシー
AWSBRIDGE_PROFILES = '{"default":"dev","profiles":{"dev":{"roleArn":"arn:aws:iam::<アカウントID>:role/awsbridge"}}}' # 各アカウントの deploy:aws の出力 RoleArn。secrets が AWS_PROFILES に登録
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # poc:sts の正常ケースで使う利用者
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # Access のチームドメイン
AWSBRIDGE_ACCESS_AUD = "<Access アプリケーションの AUD タグ>"   # このアプリケーションの AUD
```

`AWSBRIDGE_ALLOWED_SUBJECTS` の書式: 各要素は `user@example.com` または `*@example.com` の形です。ワイルドカードを使えるのはメールのローカル部だけで、ドメイン部（`*@*` や `*@*.com`）や `*` 単独は使えません（全員に許可してしまうため）。空要素や前後の空白もエラーです。email は小文字に正規化して照合します（Worker は Access JWT の email を小文字にして STS に渡し、`deploy:aws` も `AWSBRIDGE_ALLOWED_SUBJECTS` を小文字にして CloudFormation に渡します）。`deploy:aws` は AWS を呼ぶ前にこれを検証し、CloudFormation テンプレートの `AllowedPattern` でも同じ検査をします。

`AWSBRIDGE_MANAGED_POLICY_ARNS` は、ロールを引き受けた利用者が実行できる操作そのものになります。必要最小限の権限だけを付けてください（未設定なら何も付けません）。

`mise.toml` の既定値（環境変数で上書き可）: `AWS_PROFILE`（`awsbridge`）、`AWSBRIDGE_AUDIENCE`（`awsbridge`）、`AWSBRIDGE_ROLE_NAME`（`awsbridge`）、`AWSBRIDGE_STACK_NAME`（`awsbridge`）。`AWSBRIDGE_KEY_FILE` は `.secrets/dev-signing-key.json` です。

### Worker の設定

secret（`mise run secrets` が登録）: `SIGNING_JWK`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`AWS_PROFILES`（必須。vars で持つ場合は secret にしない）。

var（任意。既定値を上書きするときだけ）: `ISSUER`（deploy 時に `--var` で設定）、`IDENTITY_CLAIM`（既定 `email`）、`ACCESS_MAX_TOKEN_AGE_SECONDS`、`STS_AUDIENCE`（既定 `awsbridge`）、`STS_REGION`（既定 `us-east-1`）、`STS_ENDPOINT`、`AWS_MCP_REGION`（既定 `us-east-1`）、`AWS_MCP_ENDPOINT`、`TARGET_AWS_REGION`（既定 `ap-northeast-1`）。

`/mcp` のエラーは `{"error":"<code>"}` で返ります: `unauthorized`（401）、`forbidden`（403。ロールを引き受ける権限がない）、`upstream_auth_failed`（502。サーバー側の設定不整合）、`temporarily_unavailable`（503）、`server_misconfigured`（500）、`unknown_aws_profile` / `invalid_aws_profile` / `batch_not_supported`（400）。原因ごとの対応表は `docs/specs/architecture.md` の「エラーと HTTP ステータスの対応」を参照してください。

## マルチアカウント

複数の AWS アカウントを、MCP の `tools/call` の引数 `aws_profile` で切り替えられます。Worker は選ばれたアカウントのロールを AssumeRoleWithWebIdentity で直接引き受けます（チェーンしません）。誰がどのアカウントを使えるかは各アカウントの信頼ポリシー（`AllowedSubjects`）で決まり、許可外は 403 `forbidden` になります。

1. 対象アカウントごとに `AWS_PROFILE=<対象> mise run deploy:aws` を流し、出力 `RoleArn` を控える。
2. 環境変数 `AWS_PROFILES`（必須。wrangler の vars の JSON オブジェクトでも、secret の JSON 文字列でも可）にプロファイル一覧を書く（値はプレースホルダー）。

```json
{
  "default": "dev",
  "profiles": {
    "dev":  { "roleArn": "arn:aws:iam::111111111111:role/awsbridge", "description": "開発" },
    "prod": { "roleArn": "arn:aws:iam::222222222222:role/awsbridge" }
  },
  "tools": ["call_aws"]
}
```

- プロファイル名: 英数字・`_`・`-` の 1〜32 文字（超えると 500 `server_misconfigured`）。
- `default`: 必須。`aws_profile` を省略したとき、および `tools/list` など `tools/call` 以外で使うプロファイル。
- `tools`: 任意。`aws_profile` の対象ツール（省略時は全ツール）。対象外ツールに付いた `aws_profile` は無視して取り除きます。
- `aws_profile` は上流へ送る前に取り除きます。一覧にない名前は 400 `unknown_aws_profile`、文字列以外は 400 `invalid_aws_profile`。
- JSON-RPC バッチは、対象ツールの `aws_profile` がすべて同じ（省略は `default`）ならそのロールで中継し、異なれば 400 `batch_not_supported`。
- `AWS_PROFILES` が未設定・不正なら 500 `server_misconfigured`。
- STS の `RoleSessionName` は `gw-<利用者>-<プロファイル名>` です（CloudTrail で見分けられます）。

上流自身の開発用デプロイでは、`mise.local.toml` の `AWSBRIDGE_PROFILES`（上記 JSON の文字列）を `mise run secrets` が secret `AWS_PROFILES` として登録します。詳細は `docs/specs/architecture.md` の「マルチアカウント（aws_profile）」を参照してください。

## 下流リポジトリでの運用

実運用は private の下流リポジトリで行う想定です。awsbridge を upstream として登録して更新を pull し続けます。下流固有の設定は上流と衝突しにくい場所に置きます。

```
git remote add upstream <awsbridge の URL>
git pull upstream main                      # 上流の更新を取り込む
```

1. 下流の `wrangler.jsonc` に環境（例 `env.prod`）を追加し、`vars.AWS_PROFILES` に上記の JSON をコミットする（ロール ARN は秘密ではない）。`name` / `workers_dev` などもその環境に書く。
2. デプロイ環境は `AWSBRIDGE_WRANGLER_ENV` で切り替える（既定 `dev`）。

```
AWSBRIDGE_WRANGLER_ENV=prod mise run build
AWSBRIDGE_WRANGLER_ENV=prod mise run deploy:worker
```

3. `AWS_PROFILES` を vars で持つ環境では、同名の secret と二重定義にならないよう `AWSBRIDGE_PROFILES` を設定せずに `mise run secrets` を使ってください（`AWS_PROFILES` は登録されません）。
