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
2. AWS 側: `AWS_PROFILE=<対象> mise run deploy:aws`（出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える）
3. プロファイル一覧を登録する。secret で持つ場合は `mise.local.toml` に `AWSBRIDGE_PROFILES` を設定して `mise run secrets`、`wrangler.jsonc` の vars で持つ場合（下流リポジトリ）は vars に書いて `mise run deploy:worker`

2 回目以降は、変更した側だけを流します。

### AWS 側（対象アカウントごと）

[infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml) を流すだけです。Worker の URL を issuer とする IAM OIDC プロバイダーと、Worker 発行の JWT で引き受ける 2 つのロール（読み取り専用 `FederatedMcpReadOnly`、デバッグ `FederatedMcpDebug`）を作ります。

```
AWS_PROFILE=<対象> mise run deploy:aws    # CloudFormation をデプロイ（何度でも別アカウントに流せる）
AWS_PROFILE=<対象> mise run destroy:aws   # 片付け: スタックを削除
```

`AWS_PROFILE` は呼び出し側の値が優先されます（未設定なら `awsbridge`）。`AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_AUDIENCE` も同様に環境変数で上書きできます（これらの既定値は `scripts/` 側にあり、`mise.toml` の `[env]` には置いていません）。一方、`mise.local.toml` や下流リポジトリの `mise.<name>.toml` に書いた値は、呼び出し側の環境変数より優先されます。対象アカウントを `AWS_PROFILE=<対象>` で切り替えたい場合は、`AWS_PROFILE` をこれらのファイルに書かないでください。

```
mise exec -- env AWS_PROFILE=<対象> AWSBRIDGE_ALLOWED_SUBJECTS="user@example.com" AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS="admin@example.com" bash scripts/deploy-aws.sh
```

マネジメントコンソールや StackSets でテンプレートを直接流すこともできます。そのときのパラメーター:

| パラメーター | 説明 |
|---|---|
| `IssuerHost` | Worker のホスト名（`https://` と末尾 `/` なし。例: `awsbridge.example.workers.dev`） |
| `Audience` | JWT の audience（既定 `awsbridge`。Worker の `STS_AUDIENCE` と一致させる） |
| `AllowedSubjects` | 読み取り専用ロールを引き受けられる利用者（カンマ区切り。下記の書式。小文字で指定） |
| `DebugAllowedSubjects` | デバッグロールを引き受けられる利用者（同じ書式。読み取り専用より絞ることを勧めます） |
| `ReadOnlyRoleName` | 読み取り専用ロール名（既定 `FederatedMcpReadOnly`） |
| `DebugRoleName` | デバッグロール名（既定 `FederatedMcpDebug`） |
| `DebugAdditionalPolicyArns` | 任意。デバッグロールに追加で付ける管理ポリシー（カンマ区切り。空なら付けない） |
| `DebugPassableEcsTaskRoleArns` | 任意。`ecs:RunTask` でタスクに渡してよい IAM ロール ARN（カンマ区切り。ワイルドカード不可）。空なら `iam:PassRole` を付けない |

デプロイ後、出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控えます（`aws cloudformation describe-stacks` でも取れます）。

#### ロールの権限と注意

| ロール | 権限 |
|---|---|
| `FederatedMcpReadOnly` | AWS 管理ポリシー `ReadOnlyAccess` + SSM パラメーター取得（`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`）の明示 Deny（条件なし） |
| `FederatedMcpDebug` | `ReadOnlyAccess` + インラインポリシー（調査の読み取り強化・秘密値の参照・軽い運用操作・接続と実行。`aws:CalledViaAWSMCP = aws-mcp.amazonaws.com` の条件付き）+ 任意の `DebugAdditionalPolicyArns` |

デバッグロールのインラインポリシーは、次のグループに分かれています（すべて `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com` の条件付き、Resource は `*`）。削除系・IAM 変更・組織変更は含みません。

| グループ（Sid） | 内容 |
|---|---|
| `Investigation` | `ReadOnlyAccess` より深い調査用の読み取り。Logs Insights / ログ取得 / Live Tail、X-Ray、CloudTrail（`LookupEvents`・クエリ）、Athena のクエリ実行、EC2 コンソール出力 / スクリーンショット、AWS Config の `SelectResourceConfig` / `GetResourceConfigHistory` |
| `SecretRead` | 秘密値の参照: `secretsmanager:GetSecretValue`、`ssm:GetParameter(s)` / `GetParametersByPath`。実行系と同等のリスクとして扱ってください。復号用の `kms:Decrypt` は別 Statement で、`kms:ViaService`（Secrets Manager / SSM 経由）に限定します |
| `Operations` | 副作用のある軽い運用操作（削除なし）: ECS の `UpdateService` / `StopTask`、EC2 の起動・停止・再起動、Lambda の同時実行数の変更、Auto Scaling の台数変更、RDS / ElastiCache の再起動、CloudFront の `CreateInvalidation` |
| `Execution` | 接続・実行: `ssm:SendCommand` / `StartSession` など、EC2 Instance Connect、`ecs:ExecuteCommand` / `RunTask`、`lambda:InvokeFunction`、`states:StartExecution`、`sqs:SendMessage`、`sns:Publish`、`rds-db:connect`。`ecs:RunTask` 用の `iam:PassRole` は別 Statement で、`DebugPassableEcsTaskRoleArns` を指定したときだけ付き、渡せるロールをその ARN、渡し先を `ecs-tasks.amazonaws.com` に限定します（空ならタスクロール無しのタスク定義だけ実行できます） |

Athena のクエリは結果バケットへの書き込み（`s3:PutObject`）が別に必要です。このポリシーには含めていないので、必要なら `DebugAdditionalPolicyArns` で足してください。

- **デバッグロールはリモート実行相当の権限を含みます。** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` はリモートシェルと同等で、秘密情報や認証情報、ファイルの内容が見えてしまうことがあります。`SecretRead` も秘密値そのものを読めます。`Operations` と `lambda:InvokeFunction`・`states:StartExecution`・`sqs:SendMessage`・`sns:Publish` は副作用のある処理を実行します。
- **権限昇格の経路は塞いでいます。** `iam:PassRole` を `*` に付けると、任意のロールでタスクを動かせてしまうため、既定では付けず、`DebugPassableEcsTaskRoleArns` で明示したロールだけに限ります。また `lambda:UpdateFunctionConfiguration`（実行ロールや環境変数の差し替え）と `autoscaling:UpdateAutoScalingGroup`（起動テンプレートの差し替え）は付けていません。
- **残るリスク:** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` / EC2 Instance Connect は、対象のインスタンスやタスクに付いたロールの権限で動けます。権限の強いインスタンス・タスクが同じアカウントにあると、その権限を借りられます。本番ではタグ条件や SSM ドキュメントで対象を絞ってください。
- **読み取り専用ロールは `ReadOnlyAccess` を含むため、SSM パラメーター以外の秘密値は読めてしまいます。** `ReadOnlyAccess`（v191）は `ssm:Get*` を含み、SecureString も `aws/ssm` キー経由で復号できてしまうため、読み取り専用ロールでは SSM パラメーター取得を明示 Deny しています（秘密値の参照はデバッグロールの `SecretRead` だけ）。一方、Lambda の環境変数（`lambda:Get*` / `ListFunctions`）や `s3:GetObject` などは調査で日常的に使うため Deny していません。ここに秘密値があるなら、`AllowedSubjects` を絞るか、権限境界・SCP で独自に Deny してください。
- **`ReadOnlyAccess` は MCP 経由に限定されません。** AWS 管理ポリシーには IAM 条件を付けられないため、セッションの認証情報で直接 API を呼んでも読み取り権限は有効です。`aws:CalledViaAWSMCP` で絞られるのはインラインポリシーの操作だけです。
- 本番では `Resource` を特定の ARN・タグ・SSM ドキュメントに絞り、セッションログ（SSM Session Manager のログ、ECS Exec のログ、Lambda の CloudWatch Logs）を必ず有効にしてください。CloudTrail だけでは足りません。
- 利用者はロールごとに `AllowedSubjects`（読み取り専用）と `DebugAllowedSubjects`（デバッグ）で分けます。`DebugAllowedSubjects` は読み取り専用より狭くしてください。

### Cloudflare 側（1 回）

```
mise run keygen          # 署名鍵を生成（.secrets/、既存なら上書きしない）
# mise.local.toml に AWSBRIDGE_ISSUER / AWSBRIDGE_ACCESS_* / AWSBRIDGE_PROFILES などを設定
mise run deploy:worker   # wrangler deploy → secrets を順に実行（AWS は呼ばない）
```

`secrets` は単独でも実行できます（`mise run secrets`）。`wrangler secret bulk` に標準入力で JSON を渡すので、値がコマンドライン引数に出ません。登録するのは `SIGNING_JWK` / `ADDITIONAL_PUBLIC_JWKS`（署名鍵のローテーション用。通常は `[]`）/ `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `AWS_PROFILES` で、`AWS_PROFILES` は `AWSBRIDGE_PROFILES`（JSON 文字列）から読みます。

検証: `mise run poc:sts`（正常 1 + 否定 4 ケース。実 AWS を呼ぶので明示的に実行したときだけ使います）。

### `mise.local.toml` の変数

固定の既定値は `mise.toml` にあります。アカウント固有の値は `mise.local.toml`（gitignore）に書きます（値はすべてプレースホルダーです）。

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge.example.workers.dev"   # Worker の URL（OIDC issuer）
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # 読み取り専用ロールを引き受けられる利用者（カンマ区切り）
AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS = "admin@example.com"       # デバッグロールを引き受けられる利用者（カンマ区切り）
# AWSBRIDGE_READONLY_ROLE_NAME = "FederatedMcpReadOnly"      # 任意。ロール名（既定値）
# AWSBRIDGE_DEBUG_ROLE_NAME = "FederatedMcpDebug"            # 任意。ロール名（既定値）
# AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS = "arn:aws:iam::<アカウントID>:policy/<名前>" # 任意。デバッグロールに追加する管理ポリシー（カンマ区切り）
AWSBRIDGE_PROFILES = '{"default":"dev-readonly","profiles":[{"name":"dev-readonly","roleArn":"arn:aws:iam::<アカウントID>:role/FederatedMcpReadOnly"},{"name":"dev-debug","roleArn":"arn:aws:iam::<アカウントID>:role/FederatedMcpDebug"}]}' # 各アカウントの deploy:aws の出力 ReadOnlyRoleArn / DebugRoleArn。secrets が AWS_PROFILES に登録
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # poc:sts の正常ケースで使う利用者
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # Access のチームドメイン
AWSBRIDGE_ACCESS_AUD = "<Access アプリケーションの AUD タグ>"   # このアプリケーションの AUD
```

`AWSBRIDGE_ALLOWED_SUBJECTS` と `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS` の書式（どちらも同じ）: 各要素は `user@example.com` または `*@example.com` の形です。ワイルドカードを使えるのはメールのローカル部だけで、ドメイン部（`*@*` や `*@*.com`）や `*` 単独は使えません（全員に許可してしまうため）。空要素や前後の空白もエラーです。email は小文字に正規化して照合します（Worker は Access JWT の email を小文字にして STS に渡し、`deploy:aws` もこれらを小文字にして CloudFormation に渡します）。`deploy:aws` は AWS を呼ぶ前にこれを検証し、CloudFormation テンプレートの `AllowedPattern` でも同じ検査をします。

`AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS` で付ける管理ポリシーは、デバッグロールを引き受けた利用者が実行できる操作そのものになります。必要最小限の権限だけを付けてください（未設定なら何も付けません）。

上書きできる既定値（`scripts/` 側で補います。環境変数・`mise.local.toml`・下流の mise 設定ファイルで変更可）: `AWS_PROFILE`（`awsbridge`）、`AWSBRIDGE_AUDIENCE`（`awsbridge`）、`AWSBRIDGE_STACK_NAME`（`awsbridge`）、`AWSBRIDGE_KEY_FILE`（リポジトリルートの `.secrets/dev-signing-key.json`）、`AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE`（鍵ローテーション用。既定は `AWSBRIDGE_KEY_FILE` の拡張子の前に `.next` / `.previous` を付けたもの）、`AWSBRIDGE_WRANGLER_CONFIG`（`wrangler.jsonc`）、`AWSBRIDGE_WRANGLER_ENV`（未設定なら `dev`。**空文字なら `--env` を付けない**）。

### Worker の設定

secret（`mise run secrets` が登録）: `SIGNING_JWK`、`ADDITIONAL_PUBLIC_JWKS`（任意。署名鍵のローテーション用の追加の公開鍵）、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`AWS_PROFILES`（必須。vars で持つ場合は secret にしない）。

var（任意。既定値を上書きするときだけ）: `ISSUER`（deploy 時に `--var` で設定）、`IDENTITY_CLAIM`（既定 `email`）、`ACCESS_MAX_TOKEN_AGE_SECONDS`、`STS_AUDIENCE`（既定 `awsbridge`）、`STS_REGION`（既定 `us-east-1`）、`STS_ENDPOINT`、`AWS_MCP_REGION`（既定 `us-east-1`）、`AWS_MCP_ENDPOINT`、`TARGET_AWS_REGION`（既定 `ap-northeast-1`）、`ALLOWED_ORIGINS`（カンマ区切りの完全一致オリジン。既定は空）。

`/mcp` は CSRF 対策として、`Origin` ヘッダーが付いたリクエスト（ブラウザ由来）を `ALLOWED_ORIGINS` に含まれない限り 403 `forbidden_origin` で拒否します。`Origin` が無い MCP クライアント・Portal のサーバー間通信は通ります。また POST は `Content-Type` が `application/json`（`; charset=utf-8` などのパラメーター可）のときだけ受け付け、それ以外（Content-Type 無しを含む）は 415 `unsupported_media_type` です。Access はブラウザの Cookie を検証して `Cf-Access-Jwt-Assertion` を差し込むため、認証だけでは CSRF を防げません。

`/mcp` のエラーは `{"error":"<code>"}` で返ります: `unauthorized`（401）、`forbidden`（403。ロールを引き受ける権限がない）、`upstream_auth_failed`（502。サーバー側の設定不整合）、`temporarily_unavailable`（503）、`server_misconfigured`（500）、`unknown_aws_profile` / `invalid_aws_profile` / `batch_not_supported`（400）。原因ごとの対応表は `docs/specs/architecture.md` の「エラーと HTTP ステータスの対応」を参照してください。

## 署名鍵のローテーション

Worker の署名鍵（secret `SIGNING_JWK`）を、止めずに入れ替える手順です。STS は JWKS をキャッシュするので、単純に差し替えると切り替え直後に検証が失敗します。そこで、新しい鍵の公開鍵を先に JWKS（`/.well-known/jwks.json`）へ載せ、STS が取り込んでから署名を切り替えます。

```
mise run key:prepare    # 1. 次の鍵を生成（AWSBRIDGE_NEXT_KEY_FILE。既にあれば中止）
mise run secrets        #    次の鍵の公開鍵を JWKS に載せる（署名は現行の鍵のまま）
# ── 最低 1 時間（安全側に 24 時間）待つ: STS の JWKS キャッシュが切れるまで ──
mise run key:activate   # 2. 現行 → PREVIOUS、NEXT → 現行
mise run secrets        #    署名を新しい鍵に切り替える（JWKS には前の鍵の公開鍵も残る）
# ── JWT の有効期限（5 分）以上待つ ──
mise run key:retire     # 3. 前の鍵（PREVIOUS）を削除
mise run secrets        #    古い公開鍵を JWKS から外す
```

- STS の JWKS キャッシュの長さは公開されていないため、待ち時間は目安です。1 回目の待ちは最低 1 時間、確実にするなら 24 時間。2 回目の待ちは JWT の有効期限（5 分）以上で、`/.well-known/jwks.json` の `cache-control: max-age=300` も考慮して余裕を見てください。
- `mise run secrets` は、`AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE`（既定は `AWSBRIDGE_KEY_FILE` の拡張子の前に `.next` / `.previous` を付けたもの）のファイルがあれば、その**公開鍵だけ**を secret `ADDITIONAL_PUBLIC_JWKS` に登録します（秘密成分は secret に入れません）。どちらも無ければ空配列 `[]` を登録し、前回の追加鍵を消します。署名は常に `SIGNING_JWK`（現行の鍵）だけで行います。
- 鍵ファイルは 0600 で作り、上書きしません。各タスクは操作の前に存在を確認し、条件に合わなければ何も動かさず中止します（`key:prepare`: NEXT が既にある、`key:activate`: NEXT が無い・PREVIOUS が既にある）。`key:retire` は PREVIOUS が無ければ何もしません。
- `ADDITIONAL_PUBLIC_JWKS` の**要素**が不正（短い鍵・壊れた base64url・RSA 以外など）なら、Worker はその要素だけを捨てて `jwks: invalid additional key skipped (index=<n>)` を warn で出し、署名鍵の公開鍵と正しい追加鍵は返します（JWKS 全体は止まりません）。JSON として壊れている・配列でない場合も、追加鍵なしで 200 を返します。`SIGNING_JWK` が不正なときだけ 500 `server_misconfigured` です。なお捨てられた鍵で署名しても STS は検証できないので、`mise run secrets` は next / previous の鍵ファイルを同じ検証にかけ、通らなければ登録せずに止まります。
- 仕組みの詳細は `docs/specs/architecture.md` の「署名鍵のローテーション」を参照してください。

## マルチアカウント

複数の AWS アカウントを、MCP の `tools/call` の引数 `aws_profile` で切り替えられます。Worker は選ばれたアカウントのロールを AssumeRoleWithWebIdentity で直接引き受けます（チェーンしません）。誰がどのアカウントを使えるかは各アカウントの信頼ポリシー（`AllowedSubjects` / `DebugAllowedSubjects`）で決まり、許可外は 403 `forbidden` になります。

1. 対象アカウントごとに `AWS_PROFILE=<対象> mise run deploy:aws` を流し、出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える。
2. 環境変数 `AWS_PROFILES`（必須。wrangler の vars の JSON オブジェクトでも、secret の JSON 文字列でも可）にプロファイル一覧を書く（値はプレースホルダー）。`profiles` は配列で書くのを推奨します。配列の順がそのまま `aws_profile` の enum の順になります。

```json
{
  "default": "dev-readonly",
  "profiles": [
    { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpReadOnly", "description": "開発（読み取り専用）" },
    { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpDebug", "description": "開発（デバッグ）" },
    { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpReadOnly" },
    { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpDebug" }
  ]
}
```

`profiles` はオブジェクト（`"profiles": { "dev-readonly": { "roleArn": "..." }, ... }`）でも書けます（従来の形式）。ただしオブジェクトのキーの順は、Worker に届くまでの経路で保たれないことがあります（原因は未特定。実環境で、`dev-readonly` → `dev-debug` と書いたのに Portal の enum が名前順になった例があります）。順を意図するなら配列で書いてください。配列形式の `name` は必須で、重複は 500 `server_misconfigured` です。

- プロファイル名: 英数字・`_`・`-` の 1〜32 文字（超えると 500 `server_misconfigured`）。数字だけの名前はオブジェクトの規則で数値順に先に並ぶので、順を意図するなら避けてください。
- `default`: 必須。`aws_profile` を省略したとき、および `tools/list` など `tools/call` 以外で使うプロファイル。
- `tools`: 任意。`aws_profile` の対象ツール（省略時は全ツール。通常は省略でよい）。名前は AWS MCP Server が返す実際のツール名（例: `aws___run_script`。`tools/list` で確認できる）で、存在しない名前を書くと `aws_profile` が効きません。対象外ツールに付いた `aws_profile` は無視して取り除きます。
- `tools/list` の応答には、対象ツールの `inputSchema.properties.aws_profile`（`enum` は `default` を先頭にして残りを設定の順（配列形式なら配列の順）に、`description` に既定値と各説明）を注入します。これでクライアント（Claude など）がツール定義からプロファイルを選べます（省略可。`required` には入れません）。上流が既に `aws_profile` を持つツールは注入しません。応答を加工できないときは原文のまま返します。MCP Server Portal は管理者の資格で `tools/list` を同期・キャッシュしますが、プロファイル一覧は全員共通なので問題ありません。デプロイやプロファイル変更の後は、Portal 側でツール一覧を再同期してください。
- `aws_profile` は上流へ送る前に取り除きます。一覧にない名前は 400 `unknown_aws_profile`、文字列以外は 400 `invalid_aws_profile`。
- JSON-RPC バッチは、対象ツールの `aws_profile` がすべて同じ（省略は `default`）ならそのロールで中継し、異なれば 400 `batch_not_supported`。
- `AWS_PROFILES` が未設定・不正なら 500 `server_misconfigured`。
- STS の `RoleSessionName` は `gw-<利用者>-<プロファイル名>` です（CloudTrail で見分けられます）。

上流自身の開発用デプロイでは、`mise.local.toml` の `AWSBRIDGE_PROFILES`（上記 JSON の文字列）を `mise run secrets` が secret `AWS_PROFILES` として登録します。詳細は `docs/specs/architecture.md` の「マルチアカウント（aws_profile）」を参照してください。

## セットアップ用スキル（Claude Code）

下流の private リポジトリを対話しながらセットアップする Claude Code スキルを `.claude/skills/setup-downstream/` に同梱しています。awsbridge を clone すればそのまま使えます（初回はフォルダーの信頼を求められます）。

```
git clone https://github.com/youyo/awsbridge <下流リポジトリ名>
cd <下流リポジトリ名> && claude
/setup-downstream <下流リポジトリ名>
```

スキルは、リモートの付け替え（`origin` → `upstream`）・下流リポジトリの作成・Worker のデプロイ・CloudFormation・Cloudflare Access/Portal・動作確認を順に案内します。外部に影響する操作は、各段階で実行前に確認します。スキルはコードと一緒に版管理されるので、`git pull --no-rebase upstream main` で下流にも更新が届きます。

## 下流リポジトリでの運用

実運用は private の下流リポジトリで行う想定です。awsbridge を `upstream` として登録して更新を pull し続けます。**上流のファイルは一切編集せず、新しいファイルを足すだけ**で自分の環境にデプロイできます（`git pull` で衝突しません）。以下の `<name>` は環境名です（例 `awsbridge-mcp`）。

1. 下流リポジトリを作り、上流を取り込む。

```
git clone <awsbridge の URL> my-awsbridge && cd my-awsbridge
git remote rename origin upstream
git remote add origin <private リポジトリの URL>   # 下流の push 先
```

2. `wrangler.<name>.jsonc` を足す（コミットする。ロール ARN は秘密ではない）。`main` などは上流の `wrangler.jsonc` と同じ値にし、`name` / `workers_dev` / `vars.AWS_PROFILES` だけ自分用にします。env セクションは使いません（値はダミーです）。

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "awsbridge-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": true,
  "vars": {
    "AWS_PROFILES": {
      "default": "dev-readonly",
      "profiles": [
        { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpReadOnly", "description": "development (read-only)" },
        { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpDebug", "description": "development (debug)" },
        { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpReadOnly" },
        { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpDebug" }
      ]
    }
  }
}
```

3. 下流用の mise 設定ファイルを足す。`mise.<name>.toml` と、それを有効にする `.miserc.toml` の 2 つです（どちらもコミットする。秘密値は入れない）。

```toml
# mise.awsbridge-mcp.toml
[env]
AWSBRIDGE_WRANGLER_CONFIG = "wrangler.awsbridge-mcp.jsonc"
AWSBRIDGE_WRANGLER_ENV = ""                      # 空 = --env を付けない（未設定だと上流の dev になる）
AWSBRIDGE_STACK_NAME = "awsbridge-mcp"
AWSBRIDGE_KEY_FILE = ".secrets/awsbridge-mcp-signing-key.json"   # 環境ごとに別の鍵にする
# AWS_PROFILE = "<デプロイに使う AWS CLI プロファイル>"
# AWSBRIDGE_AUDIENCE = "awsbridge"               # 変える場合は Worker の var STS_AUDIENCE も揃える
```

```toml
# .miserc.toml
env = ["awsbridge-mcp"]
```

4. 秘密値と環境固有値を `mise.local.toml`（gitignore。コミットしない）に書く。`AWSBRIDGE_ISSUER`（Worker の URL）、`AWSBRIDGE_ALLOWED_SUBJECTS`、`AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS`、`AWSBRIDGE_ACCESS_TEAM_DOMAIN`、`AWSBRIDGE_ACCESS_AUD` など（上の「`mise.local.toml` の変数」を参照）。`AWS_PROFILES` を `vars` で持つので `AWSBRIDGE_PROFILES` は設定しない（`secrets` が `AWS_PROFILES` を secret として二重登録しません）。

5. デプロイする（初回）。

```
mise run keygen          # AWSBRIDGE_KEY_FILE に署名鍵を生成
mise run deploy:worker   # wrangler.<name>.jsonc で Worker をデプロイ → secrets を登録
AWS_PROFILE=<対象> mise run deploy:aws   # アカウントごとに CloudFormation を流し、出力 ReadOnlyRoleArn / DebugRoleArn を wrangler.<name>.jsonc の AWS_PROFILES に書く
```

6. 上流の更新を取り込む。

```
git pull --no-rebase upstream main
```

注意:

- **署名鍵は環境ごとに分ける。** 上流の開発用デプロイと同じ鍵・同じ issuer を使い回さないでください（`AWSBRIDGE_KEY_FILE` を別パスにする）。鍵の入れ替えは「署名鍵のローテーション」の手順（`mise run key:prepare` → `secrets` → 待つ → `key:activate` → `secrets` → 待つ → `key:retire` → `secrets`）で止めずに行えます。
- **issuer（Worker の URL）が環境ごとに変わる**ので、IAM OIDC プロバイダーとロールを作る CloudFormation スタックも環境ごとに別です（`AWSBRIDGE_STACK_NAME` を分ける）。同じアカウントに複数の環境を置くときはロール名も分ける（`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`）。
- mise は `mise.<name>.toml` を `mise.toml` より、`mise.local.toml` を `mise.<name>.toml` より優先します。`.config/mise/conf.d/*.toml` は `mise.toml` に負けるので使えません。
- 上流の `wrangler.jsonc`（`name: awsbridge` / `env.dev`）は上流の開発用です。下流では使いません。
