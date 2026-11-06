# awsbridge アーキテクチャ仕様（初版・設計合意メモ）

- 作成日: 2026-11-05
- 状態: 本体実装済み・実環境で通し確認済み（2026-11-05: Portal → Access → Worker → STS → AWS MCP、aws_profile による読み取り専用 / デバッグロールの切り替え、デバッグ専用権限が MCP 経由でのみ通ること）
- 前身: [youyo/aws-mcp-gateway](https://github.com/youyo/aws-mcp-gateway)（Go 製。OIDC 認証付き AWS MCP Server リバースプロキシ）

## 目的

AI エージェント（MCP クライアント）から AWS MCP Server へ、**利用者本人の AWS 一時認証情報**で接続するためのブリッジを、Cloudflare Workers 上で動かす。

- aws-mcp-gateway の `IAM_MODE=federated` 相当の機能に絞る（shared モードは持たない）
- Cloudflare **MCP Server Portal** の背後に置く前提
- 認証（ログイン）は **Cloudflare Access に完全に委ねる**。awsbridge 自身は OAuth AS もログイン UI も持たない

## 全体構成（構成 A'）

```
MCP クライアント
   │
   ▼
Cloudflare MCP Server Portal（Access アプリ, Managed OAuth）
   │  Access が利用者を認証（IdP: 開発=Google / 本番=Entra ID）
   ▼
awsbridge Worker（self-hosted Access アプリ / Managed OAuth 有効）
   │ 1. Cf-Access-Jwt-Assertion を検証（iss=チームドメイン, aud=このアプリの AUD, JWKS=/cdn-cgi/access/certs）
   │ 2. 利用者識別子（既定: email）を取り出す
   │ 3. Worker 自身の鍵で短命 JWT を発行（iss = Worker の URL, 有効期限 ~5 分）
   │ 4. その JWT で STS AssumeRoleWithWebIdentity（署名不要・fetch のみ）
   │ 5. aws_profile（省略時は default）が指すロールを AssumeRoleWithWebIdentity で直接引き受ける（チェーンしない）
   │ 6. aws4fetch で SigV4 署名（service="aws-mcp"）し、AWS MCP Server へストリーム中継
   ▼
AWS MCP Server（us-east-1 / eu-central-1）

Worker は IAM 向けに以下を公開する（この 2 パスのみ Access を bypass）:
  GET /.well-known/openid-configuration
  GET /.well-known/jwks.json
```

信頼の連鎖: **AWS IAM → awsbridge（OIDC issuer）→ Cloudflare Access → IdP（Google / Entra ID）**

### なぜ Worker が JWT を再発行するのか（PoC 結果）

Access の application token（`Cf-Access-Jwt-Assertion`）をそのまま STS に渡す案（構成 A）は **IAM が拒否した**。

- `https://<team>.cloudflareaccess.com/.well-known/openid-configuration` は存在するが、中身は `issuer` と `jwks_uri` のみ
- IAM の OIDC プロバイダー登録で `Please check .well-known/openid-configuration of provider: https://<team>.cloudflareaccess.com is valid.` エラー（2026-11-05 確認）
- 推定原因: OIDC Discovery 必須項目（`response_types_supported` / `subject_types_supported` / `id_token_signing_alg_values_supported` / `authorization_endpoint`）の欠落

Access JWT の実物（開発環境）で確認した claim:

| claim | 値の例 | 備考 |
|---|---|---|
| `iss` | `https://<team>.cloudflareaccess.com` | |
| `aud` | `["<application AUD>"]` | **配列** |
| `sub` | UUID | Access が払い出す ID。IdP の ID ではない |
| `email` | `user@example.com` | IdP によらず必ず入る |
| `type` | `app` | |
| `exp - iat` | 約 30 日 | cloudflared 経由で取得したトークン。長寿命 |

再発行することで得られる性質:
- IAM 要件を満たす discovery ドキュメントを自前で出せる
- STS に渡すトークンを **短命（~5 分）** にできる（Access JWT の 30 日寿命を AWS に持ち込まない）
- claim を整形できる（`sub` を email にする等）→ trust policy が書きやすい

## 決定事項

| 項目 | 決定 |
|---|---|
| リポジトリ名 | `awsbridge`（public） |
| ランタイム | Cloudflare Workers（TypeScript, `nodejs_compat`） |
| IAM モード | federated のみ（`IAM_MODE` 変数は持たない） |
| 認証 | Cloudflare Access に委譲（awsbridge は OAuth/ログインを実装しない） |
| AWS が信頼する IdP | awsbridge Worker 自身（自前の OIDC issuer） |
| 利用者識別子 | 既定 `email`。設定で `sub` / `custom.<claim>`（例: Entra の `oid`）に切替可能 |
| 環境 | 開発 = 個人 Zero Trust `<team>`（IdP: Google）、本番 = 会社 Zero Trust（IdP: Entra ID）。差分は wrangler の環境設定のみ |
| 署名鍵 | 環境ごとに別鍵（開発鍵で本番 AWS に入れないこと）。Worker secret / Secrets Store に保管 |
| SigV4 | `aws4fetch`。aws-sdk-js-v3 は使わない |
| STS | `fetch` + XML パース。`AssumeRoleWithWebIdentity` は署名不要 |
| デプロイ先 | `*.workers.dev`（開発） |

### Entra ID について

- Access の Entra IdP 設定の **Email claim** により JWT の `email` が決まる。会社では AWS SSO（Access SAML）で email を使用済みなので追加設定は不要の見込み
- Entra の `oid` / `groups` を使いたい場合は Access IdP 設定の「OIDC Claims」に追加 → JWT の `custom` に入る（約 1KB 超で切り捨て、best-effort）。完全な情報が必要なら `/cdn-cgi/access/get-identity`
- 開発環境（Google）では groups が出ないため、グループ認可は unit テスト（フィクスチャ）で検証し、最終確認は会社環境で行う

## 却下した案

| 案 | 内容 | 却下理由 |
|---|---|---|
| A | Access JWT をそのまま STS へ | IAM が Access チームドメインを OIDC プロバイダーとして受け付けない（上記 PoC） |
| B | Worker が OAuth AS（`@cloudflare/workers-oauth-provider`）を持ち、上流 Entra に直接 OIDC | Worker 用の Entra アプリ登録・refresh token 運用・KV が必要。ポータル背後ではログインが二重になる |
| C | Worker が OAuth AS を持ち、上流は Access for SaaS（OIDC） | 確実に動く見込みだが実装量が B と同等。**会社のセキュリティ方針が「AWS は Worker の鍵を信頼してはならない」なら C に切り替える**（鍵を Cloudflare 管理にできる） |
| shared モード | ランタイムロール共有 | Workers に実行ロールが無く、長期アクセスキーを置くことになる |

## aws-mcp-gateway からの機能の扱い

| 機能 | 扱い |
|---|---|
| `IAM_MODE=federated` | 唯一のモードとして継承 |
| `ASSUME_ROLE_ARN`（チェーン） | 廃止。ロールは `AWS_PROFILES` で指定し、チェーンせず直接引き受ける |
| `_meta` への AWS リージョン注入 | 継承 |
| `ALLOWED_DOMAINS` / `ALLOWED_EMAILS` | 廃止（Access ポリシーに一本化） |
| `COOKIE_SECRET` / `SIGNING_KEY_HEX`(OAuth 用) / DynamoDB ストア | 廃止（OAuth を持たない） |
| `aws_profile` | 継承。各アカウントのロールを AssumeRoleWithWebIdentity で直接引き受ける（[マルチアカウント](#マルチアカウントaws_profile)） |
| `/mcp/assumerole/...` パスルーティング | 廃止（`aws_profile` に一本化） |
| `AWS_PROFILE_CONFIG_S3` / users 対応表 | 廃止。プロファイル一覧は環境変数 `AWS_PROFILES`。誰がどのアカウントを使えるかは各アカウントの信頼ポリシーで AWS 側が判定する |
| `FEDERATED_ROLE_ARN`（基点ロール） | 廃止。`AWS_PROFILES` の `default` に一本化 |

## ロール構成

各 AWS アカウントに、IAM OIDC プロバイダー 1 つとロール 2 つを作る（`infra/aws/awsbridge.yaml`）。どちらのロールも信頼ポリシーの構造は同じ（`<host>:aud` は `StringEquals`、`<host>:sub` は `StringLike`）で、`sub` の許可リストだけがロールごとに違う。

| ロール（既定名） | 目的 | 権限 | 利用者 |
|---|---|---|---|
| `FederatedMcpReadOnly` | 普段の調査・参照 | AWS 管理ポリシー `ReadOnlyAccess` + インラインの明示 Deny（`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`、Resource `*`、条件なし） | `AllowedSubjects` |
| `FederatedMcpDebug` | 障害調査（秘密値の参照・運用操作・実行を伴う） | `ReadOnlyAccess` + インラインポリシー + 任意の追加管理ポリシー（`DebugAdditionalPolicyArns`） | `DebugAllowedSubjects` |

- インラインポリシーは Statement をグループ（Sid）に分けて持つ。すべて `StringEquals aws:CalledViaAWSMCP = aws-mcp.amazonaws.com`、Resource は `*`。削除系・IAM 変更・組織変更は含めない。
  - `Investigation`: ログ・トレース・CloudTrail・Athena・Config・EC2 コンソール出力など、`ReadOnlyAccess` より深い調査用の読み取り。
  - `SecretRead`: `secretsmanager:GetSecretValue`、`ssm:GetParameter(s)` / `GetParametersByPath`。秘密値を読めるので実行系と同等のリスク。別 Statement の `kms:Decrypt` は `kms:ViaService`（`secretsmanager.*.amazonaws.com` / `ssm.*.amazonaws.com`）に限定する。
  - `Operations`: ECS / EC2 / Lambda（`PutFunctionConcurrency` のみ）/ Auto Scaling（`SetDesiredCapacity` のみ）/ RDS / ElastiCache / CloudFront の軽い運用操作（再起動・停止・台数変更・無効化など。削除なし）。
  - `Execution`: SSM のコマンド・セッション、EC2 Instance Connect、ECS Exec / RunTask、Lambda 実行、Step Functions、SQS / SNS、`rds-db:connect`。`ecs:RunTask` 用の `iam:PassRole` は別 Statement で、パラメーター `DebugPassableEcsTaskRoleArns`（既定は空）を指定したときだけ付く（`Fn::If` + `AWS::NoValue`）。Resource はその ARN、`iam:PassedToService = ecs-tasks.amazonaws.com` に限定する。空ならタスクロール無しのタスク定義だけ実行できる。
- Athena の結果バケットへの書き込み（`s3:PutObject`）はこのポリシーに含めない。必要なら `DebugAdditionalPolicyArns` で足す。
- インラインポリシーの上限は 10,240 文字。テストで文書が上限未満であることを確かめている（現状 約 2.3k 文字）。
- 権限を広げるときはテンプレートの該当グループに Action を足すか、`DebugAdditionalPolicyArns` で管理ポリシーを足す。
- 利用者の範囲はロールごとに別のパラメーターで決める。デバッグは読み取り専用より狭くする想定。
- Worker から見ると 2 ロールは別のプロファイルで、1 アカウントにつき `<env>-readonly` と `<env>-debug` を `AWS_PROFILES` に並べる（default は readonly 側）。ロールごとに `RoleSessionName` が分かれるので CloudTrail で見分けられる。

注意:

- **デバッグロールはリモート実行相当の権限と秘密値の参照を含む。** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` はリモートシェルと同等で、秘密情報・認証情報・ファイルが見えうる。`SecretRead` は秘密値そのものを読める。`Operations` や `lambda:InvokeFunction` などは副作用のある処理を実行する。
- **権限昇格の経路は塞いでいる。** `iam:PassRole` を `*` に付けると任意のロールでタスクを動かせるため、既定では付けず `DebugPassableEcsTaskRoleArns` の明示ロールに限る。`lambda:UpdateFunctionConfiguration`（実行ロール・環境変数の差し替え）と `autoscaling:UpdateAutoScalingGroup`（起動テンプレートの差し替え）は付けない。テストで両 Action の不在と PassRole の既定なしを確かめている。
- **残るリスク:** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` / EC2 Instance Connect は、対象インスタンス・タスクのロールの権限で動ける。強いロールを持つ対象が同一アカウントにあるとその権限を借りられる。本番ではタグ条件や SSM ドキュメントで対象を絞る。
- **読み取り専用ロールの SSM Deny と残余リスク。** `ReadOnlyAccess`（v191）は `ssm:Get*` を含み、SecureString も `aws/ssm` キーの key policy により SSM 経由で復号できる。設計上、秘密値の参照はデバッグロール（`SecretRead`）専用なので、読み取り専用ロールには SSM パラメーター取得の明示 Deny を付ける（MCP 経由かどうかに関わらず拒否。デバッグロールには付けない）。Lambda の環境変数（`lambda:Get*` / `ListFunctions`）や `s3:GetObject` も `ReadOnlyAccess` に含まれるが、調査で日常的に使うため Deny しない。この残余リスクは許容し、必要なら利用者側で `AllowedSubjects` を絞る・権限境界や SCP で Deny する。
- **`ReadOnlyAccess` は MCP 経由に限定されない。** AWS 管理ポリシーには IAM 条件を付けられないため、セッションの認証情報で直接 API を呼んでも読み取りは効く。`aws:CalledViaAWSMCP` で絞られるのはインラインの操作だけ。
- 本番では Resource を ARN・タグ・SSM ドキュメントで絞り、セッションログ（SSM Session Manager、ECS Exec、Lambda の CloudWatch Logs）を必ず有効にする。CloudTrail だけでは足りない。`DebugAllowedSubjects` は読み取り専用より絞る。

## マルチアカウント（aws_profile）

複数の AWS アカウントを `tools/call` の引数 `aws_profile` で切り替える。前身の `aws_profile` を引き継ぐが、users 対応表と S3 読み込みは持たない。

### 決定

- **各アカウント**: 対象アカウントごとに `infra/aws/awsbridge.yaml` を流し、Worker を信頼する 2 つのロール（[ロール構成](#ロール構成)）を作る。Worker は選ばれたロールを **AssumeRoleWithWebIdentity で直接**引き受ける（チェーン AssumeRole はしない）。
- **認可は AWS 側**: 誰がどのアカウントを使えるかは各アカウントの信頼ポリシー（`AllowedSubjects` / `DebugAllowedSubjects`）で決まる。許可外は STS の `AccessDenied` → 403 `forbidden`。Worker に users 対応表は持たない。
- **設定**: 環境変数 `AWS_PROFILES`（**必須**）。wrangler の vars（JSON オブジェクト）でも secret（JSON 文字列）でも受け付ける。基点ロール `FEDERATED_ROLE_ARN` は廃止し、設定経路をこれに一本化した。

```json
{
  "default": "dev-readonly",
  "profiles": [
    { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpReadOnly", "description": "任意" },
    { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpDebug" },
    { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpReadOnly" },
    { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpDebug" }
  ]
}
```

- `profiles` は**配列（推奨）**でもオブジェクト（`{ "<名前>": { "roleArn": ... } }`）でもよい。配列の順がそのまま `aws_profile` の enum の順になる。オブジェクト形式は従来どおり受け付け、その場合はキーの順になる。
  - 配列形式を推奨する理由: 実環境で、vars のオブジェクトに `dev-readonly` → `dev-debug` の順で書いたのに、Portal に同期された enum が名前順（`dev-debug`, `dev-readonly`）になった。Worker のコード（`src/profiles.ts` / `src/toolslist.ts`）は順を変えない（unit テストで確認済み）。原因は特定できていないが、Worker に届く前の経路（vars の保存・受け渡しなど）でオブジェクトのキーが並べ替えられた可能性が高い（推定）。配列なら順が値の一部なので、どの経路でも保たれる。
  - さらに enum は**常に `default` を先頭**にし、残りを設定の順に並べる。並べ替えが起きても `default` は先頭に来る。
  - 配列形式の `name` は必須で、重複は 500 `server_misconfigured`（種別 `duplicate`）。
  - 名前が数字だけのプロファイル（`"1"`, `"10"` など）は、JS のオブジェクトの規則で数値順に先に並ぶ。順を意図するなら数字だけの名前は避ける。
- `default`: 必須。`profiles` の名前。`aws_profile` を指定しないときに使う。
- `tools`: 任意。`aws_profile` の対象ツール。省略時は全ツール。
- 検証: 名前は `^[A-Za-z0-9_-]{1,32}$`（STS の `RoleSessionName` 64 文字に `gw-<利用者>-<名前>` を収めるため 32 文字まで）、`roleArn` は `^arn:aws[a-z-]*:iam::\d{12}:role/[\w+=,.@/-]{1,128}$`、`profiles` は 1 件以上で名前の重複なし、`tools` は空配列不可、`default` は `profiles` に存在すること。違反は 500 `server_misconfigured`（ログには `config: invalid AWS_PROFILES: <種別>` のみ。値は出さない）。

### 選び方

| リクエスト | 使うロール |
|---|---|
| 対象ツールの `tools/call` で `params.arguments.aws_profile` が一覧にある | そのプロファイル |
| 対象ツールの `tools/call` で `aws_profile` なし | `default` |
| 対象外ツールの `tools/call`（`aws_profile` が付いていても検証せず無視） | `default` |
| `initialize` / `tools/list` / `ping` / notifications など `tools/call` 以外、GET / DELETE | `default` |
| JSON-RPC バッチ | 対象ツールの `tools/call` が指す `aws_profile` がすべて同じ（省略は `default` 扱い）ならそのロール。異なれば 400 `batch_not_supported` |

`aws_profile` は上流へ送る前にすべての `tools/call` の arguments から取り除く（対象・対象外とも）。本文は handler で 1 回だけ読み、パース結果に対して `aws_profile` の除去と `_meta.AWS_REGION` の注入を行い、直列化は 1 回にする。`/mcp` の POST は Content-Type が `application/json` のものだけ受け付けるので（後述「CSRF 対策」）、本文が JSON としてパースできない場合（fail-safe）だけ `default` でそのまま中継する。

エラー: `aws_profile` が文字列でない → 400 `invalid_aws_profile`、一覧にない（`__proto__` 等の prototype 由来の名前も不可）→ 400 `unknown_aws_profile`。どちらも認証後に判定し、STS・上流は呼ばない。

### tools/list への注入

クライアントがツール定義から `aws_profile` を選べるよう、`tools/list` の応答に注入する（`src/toolslist.ts`）。

- 対象: POST の単一 JSON-RPC リクエストで `method === "tools/list"`（バッチは対象外）。上流へは `accept: application/json` で要求し、JSON 応答を得る。
- 注入内容: 対象ツール（`tools` 設定のもの。省略時は全ツール）の `inputSchema.properties.aws_profile = { type: "string", enum: [プロファイル名（設定順）], description }`。`required` には加えない。`inputSchema` / `properties` が無ければ `type: "object"` で作る。`description` は既定値と各プロファイルの説明（長い説明は切り詰め、全体を数百文字に収める）。
- 既に `aws_profile` を持つツールは注入せず `console.warn("tools_list: aws_profile conflict")`。
- 応答の扱い: `application/json` は注入して返す。`text/event-stream`（上流が Accept を無視した場合）は、イベントが 1 つで `data:` の JSON-RPC 応答の id が一致し `result.tools` を持つときだけ注入して再シリアライズする。それ以外（複数イベント・パース不能・id 不一致）、非 200、その他の content-type、壊れた JSON は原文のまま流す（fail-safe。認可は `tools/call` 側なので、注入失敗で経路を止めない）。
- 加工時は `content-encoding` と `content-length` を応答から外す（Workers の fetch は gzip を展開済みで、長さも変わるため）。
- Portal 背後では、Portal が管理者資格で `tools/list` を同期・キャッシュするが、プロファイル一覧は全員共通なので問題ない。デプロイやプロファイル変更の後は Portal 側でツール一覧の再同期が必要。

### キャッシュと CloudTrail

認証情報キャッシュのキーは `(利用者, roleArn)`。プロファイルごとに別エントリになる。STS の `RoleSessionName` は `gw-<利用者>-<プロファイル名>`（長い利用者名は利用者側を切り詰める）。CloudTrail でどのプロファイルのセッションか見分けられる。

### 下流リポジトリでの運用（fork 的運用）

実運用は private の下流リポジトリで行う。awsbridge を git の upstream として登録し、更新を pull し続ける。下流固有の設定は上流と衝突しにくい場所に置く。

1. `git remote add upstream <awsbridge の URL>` → `git pull --no-rebase upstream main` で追従する。**上流のファイルは編集せず、ファイルを足すだけ**にして衝突を避ける。
2. `wrangler.<name>.jsonc`（例 `wrangler.awsbridge-mcp.jsonc`）を足す。`name` / `workers_dev` / `vars.AWS_PROFILES` を持ち、env セクションは使わない（ロール ARN は秘密ではないのでコミットしてよい）。
3. 下流用の mise 設定として `mise.<name>.toml` と `.miserc.toml`（`env = ["<name>"]`）を足し、`AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV`（空 = `--env` を付けない）/ `AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_KEY_FILE` などを与える。秘密値は `mise.local.toml`（gitignore）に置く。
4. 上書きできる既定値は `mise.toml` の `[env]` ではなくスクリプト側（`scripts/*.sh`、`scripts/poc/`）の `${VAR:-default}` で補う。理由: mise は `mise.<env>.toml` を `mise.toml` より優先するが `.config/mise/conf.d/*.toml` は `mise.toml` に負けるうえ、`[env]` に既定値があると呼び出し側の環境変数や下流ファイルでの上書きが難しくなるため（実験で確認）。優先順位は `mise.local.toml` > `mise.<name>.toml` > `mise.toml`。
5. wrangler は `scripts/wrangler.sh` 経由で呼び、`--config "${AWSBRIDGE_WRANGLER_CONFIG:-wrangler.jsonc}"` を付ける。`AWSBRIDGE_WRANGLER_ENV` は未設定なら `dev`、**空文字なら `--env` を付けない**（`${VAR-dev}` で未設定と空を区別）。
6. 署名鍵は環境ごとに分ける。issuer（Worker の URL）が環境ごとに変わるため、IAM OIDC プロバイダーとロールの CloudFormation スタックも環境ごとに別になる。
7. 各アカウントに `AWS_PROFILE=<対象> mise run deploy:aws` で CloudFormation を流し、出力 `ReadOnlyRoleArn` / `DebugRoleArn` を、1 アカウントにつき `<env>-readonly` と `<env>-debug` の 2 プロファイルとして `AWS_PROFILES` に追記する（default は readonly 側）。
8. 上流自身の開発用デプロイは、`mise.local.toml` の `AWSBRIDGE_PROFILES`（JSON 文字列）を `mise run secrets` が secret `AWS_PROFILES` として登録する。vars で `AWS_PROFILES` を持つ環境では、secret と二重定義にならないよう `AWSBRIDGE_PROFILES` を設定せずに `mise run secrets` を使う（`AWS_PROFILES` は登録されない）。

## 署名鍵のローテーション

Worker は secret `SIGNING_JWK`（RSA 秘密鍵 JWK）で STS 向け JWT に署名し、`/.well-known/jwks.json` に公開鍵を出す。STS（IAM OIDC プロバイダー）は JWKS をキャッシュするが、その長さは公開されていない。単純に鍵を差し替えると、キャッシュが古い間は新しい鍵で署名した JWT が検証できず、`InvalidIdentityToken`（→ 502 `upstream_auth_failed`）になる。そこで、**新しい鍵の公開鍵を先に JWKS に載せ、STS が取り込んでから署名を切り替える**。

### 仕組み

- secret `ADDITIONAL_PUBLIC_JWKS`（任意。公開鍵 JWK の JSON 配列の文字列）を追加した。JWKS は「`SIGNING_JWK` の公開鍵（先頭）+ `ADDITIONAL_PUBLIC_JWKS` の公開鍵」を返す。
- 追加分は公開成分（`kty`, `n`, `e`）だけを取り出し、`kid`（RFC 7638 thumbprint）・`use: "sig"`・`alg: "RS256"` を付け直す。秘密成分が入っていても出さない。`kid` が重複する鍵は除く。
- 不正な追加鍵は個別に捨てる（JWKS 全体は止めない）。`ADDITIONAL_PUBLIC_JWKS` の要素が RSA 公開鍵として使えない（短い・base64url が壊れている・RSA 以外・オブジェクトでない）場合は、その要素だけを除き `console.warn("jwks: invalid additional key skipped (index=<n>)")` を出す。署名鍵の公開鍵（先頭）と正しい追加鍵は返す。JSON として壊れている・配列でない場合は追加鍵なしで 200 を返し warn を出す。値はログにも応答にも出さない。`SIGNING_JWK` が不正なときだけ `/.well-known/jwks.json` は 500 `server_misconfigured`（ログは `config: invalid SIGNING_JWK`）。理由: 追加鍵の不備で署名鍵の公開鍵まで消えると、STS の検証が全停止するため。
- 署名は常に `SIGNING_JWK` だけで行う。追加鍵では署名しない。
- 鍵ファイルは `AWSBRIDGE_KEY_FILE`（現行。既定 `.secrets/dev-signing-key.json`）、`AWSBRIDGE_NEXT_KEY_FILE`（既定 `<KEY_FILE の拡張子の前>.next.json`）、`AWSBRIDGE_PREVIOUS_KEY_FILE`（既定 `<...>.previous.json`）。`mise run secrets`（`scripts/put-secrets.sh`）は next / previous のファイルがあればその**公開鍵だけ**を `ADDITIONAL_PUBLIC_JWKS` に登録する。登録前に Worker と同じ検証関数（`src/keys.ts` の `publicJwkOf`、`scripts/check-public-jwk.ts` 経由）で確かめ、通らなければファイルを示して終了コード 1 で止まる（wrangler は呼ばない）。どちらも無ければ空配列 `[]` を登録する（前回の追加鍵を確実に消すため）。
- mise タスク（`scripts/key-rotate.ts`。ファイルは 0600、上書きせず、操作の前に存在を確認する）:
  - `key:prepare`: 次の鍵を生成して NEXT に保存。NEXT が既にあれば中止。
  - `key:activate`: 現行 → PREVIOUS、NEXT → 現行。NEXT が無い、または PREVIOUS が既にあれば中止。
  - `key:retire`: PREVIOUS を削除。無ければ何もしない。

### 手順と待ち時間

| 段階 | 操作 | JWKS の中身 | 署名する鍵 | 次に進む前に待つ |
|---|---|---|---|---|
| 0 | （通常） | 現行 | 現行 | |
| 1 | `mise run key:prepare` → `mise run secrets` | 現行 + 次 | 現行 | **最低 1 時間（安全側に 24 時間）**。STS の JWKS キャッシュが切れて次の鍵の公開鍵を取り込むまで |
| 2 | `mise run key:activate` → `mise run secrets` | 次（新しい現行）+ 前 | 新しい現行 | **JWT の有効期限（5 分）以上**。旧鍵で署名した JWT がすべて失効するまで。実際には `/.well-known/jwks.json` の `cache-control: max-age=300`（5 分）も考慮して余裕を見る |
| 3 | `mise run key:retire` → `mise run secrets` | 新しい現行 | 新しい現行 | |

- 段階 1 の待ち時間は、STS が JWKS を何時間キャッシュするかが公開されていないための目安。経験的な下限として 1 時間、確実にするなら 24 時間待つ。短いと、段階 2 のあと STS が次の鍵をまだ知らず検証に失敗する。
- 段階 2 のあと、認証情報キャッシュ（isolate 内、有効期限の手前まで）に旧鍵で取得した認証情報が残るのは問題ない（STS が払い出し済みで、検証は取得時に済んでいる）。
- 段階 3 の `retire` を急ぐ理由は無いが、前の鍵の秘密鍵ファイルを手元に残し続けないために、確認が済んだら実施する。
- 手順の途中で中止したいとき: 段階 1 の途中なら NEXT を手で削除して `mise run secrets`（追加鍵が `[]` になる）。段階 2 のあとに問題が出たら、`mise run secrets` で PREVIOUS の公開鍵が JWKS に残っているうちは、現行と PREVIOUS のファイルを手で入れ替えて `mise run secrets` すれば署名を戻せる。
- 環境ごとに鍵ファイルのパスが違う場合（下流リポジトリ）は、`mise.<name>.toml` の `AWSBRIDGE_KEY_FILE` に従って NEXT / PREVIOUS も同じ場所に作られる。

## MCP Server Portal 背後に置くことの制約

1. ポータル側の **Require user auth は Enabled 必須**（Terraform では portal の `servers[].on_behalf = true`。Disabled だと管理者資格を全員で共用し、全員が管理者の身元で AWS のロールを引き受ける。2026-11-05 に実環境で `false` のまま登録してしまい、利用者ごとの Sign Out が出ないことで気づいた）
2. awsbridge 自体を self-hosted Access アプリにする（直 URL アクセスを Access で塞ぐ）。既存の `x-reader-mcp` / `seekio-mcp` と同じ構成
3. ポータルは tools 一覧を管理者資格で同期・キャッシュするため、利用者ごとに異なる `aws_profile` の enum は効かない。全員共通の enum（`AWS_PROFILES` の一覧）は効くので注入している（[tools/list への注入](#toolslist-への注入)）。デプロイ後はポータル側でツール一覧の再同期が必要。認可は `tools/call` 側（と各アカウントの信頼ポリシー）で強制する
4. ポータルの Code Mode（Required）では tools が 2 つに集約されるため、`aws_profile` 引数の説明が届きにくい

## セキュリティ上の注意

- Worker 署名鍵 = AWS への入口。漏洩すると任意の利用者として assume 可能。trust policy では `aud` と許可する `sub` を厳しく絞る
- IAM OIDC プロバイダーに登録する audience は awsbridge 専用のもののみ。ポータル（`mcp_portal`）の AUD を STS 信頼に使わない
- Access JWT は長寿命（観測値 ~30 日）。Access から外した利用者のトークンが残存しうるため、`iat` が古すぎるトークンの拒否や Access アプリのセッション短縮を検討
- `aws:SourceIp` 条件は実質使えない（Cloudflare egress）

### CSRF 対策（Origin 検査と Content-Type 制限）

self_hosted の Access は、ブラウザの `CF_Authorization` Cookie を検証して `Cf-Access-Jwt-Assertion` ヘッダーを Worker に差し込む。Worker がヘッダーだけを見ていても、Cookie 由来のブラウザ通信にはヘッダーが付くため、それだけでは CSRF を防げない。ブラウザはプリフライト無しで Content-Type 無し・`text/plain` の POST を送れる。そこで `/mcp` に次の 2 つを課す。どちらも本文の読み取り・STS 呼び出しより前に判定する。

- **Origin 検査（全メソッド）**: `Origin` ヘッダーがあるとき、環境変数 `ALLOWED_ORIGINS`（カンマ区切りの完全一致。未設定なら空）に含まれなければ 403 `forbidden_origin`。`Origin` が無い（MCP クライアント・Portal のサーバー間通信）なら通す。
- **POST の Content-Type 制限**: メディアタイプが `application/json`（大小無視、`; charset=...` 等のパラメーター可）のときだけ受け付け、それ以外（Content-Type 無しを含む）は 415 `unsupported_media_type`。以前の「Content-Type 無し・非 JSON は `default` で原文中継」は廃止した。

### email の正規化

利用者識別子が `email`（既定）のとき、Worker は identity と STS 向け JWT の `sub` を小文字に正規化して照合する。email は大文字小文字を区別しない値で、IdP や入力経路によって表記が揺れても IAM 信頼ポリシーの `StringLike` 照合（大文字小文字を区別する）とずれないようにするため。`deploy:aws` も `AWSBRIDGE_ALLOWED_SUBJECTS` を小文字にして検証・CloudFormation に渡す。`sub` と `custom.*`（例: Entra の `oid`）は不透明な ID なので正規化しない。

### 認証情報キャッシュの残余リスク

Access JWT の検証は毎リクエスト行う。一方、STS から取得済みの認証情報は isolate 内にキャッシュされ、最大「有効期限 − 5 分」まで使われる。このため、Access から外した（または trust policy から外した）利用者でも、キャッシュ済みの認証情報は残り時間のあいだ有効なままになりうる。ただしその利用者は Access JWT の検証で弾かれるので、Worker 経由では使えない。リスクは「認証情報が Worker の外に漏れた場合」に限られる。`DurationSeconds` が 900 秒なら、最大で約 10 分。これを許容できないなら `DurationSeconds` を短くするか、キャッシュを無効にする。

### エラーと HTTP ステータスの対応

`/mcp` のエラー応答は `{"error":"<code>"}`。内部の詳細（STS の本文、例外メッセージ）は返さず、原因の種別だけをログに残す。

| 状況 | HTTP | code |
|---|---|---|
| Access JWT が無い・署名/iss/aud/exp が不正・Cookie のみ | 401 | `unauthorized` |
| `Origin` ヘッダーがあり `ALLOWED_ORIGINS` に無い | 403 | `forbidden_origin` |
| POST の Content-Type が `application/json` でない（無い場合を含む） | 415 | `unsupported_media_type` |
| 利用者識別子（既定 email）の claim が無い | 403 | `forbidden` |
| STS が `AccessDenied`（trust policy が利用者を許可していない） | 403 | `forbidden` |
| STS が Worker 発行 JWT を拒否（`InvalidIdentityToken` 等） | 502 | `upstream_auth_failed` |
| STS の一時障害・ネットワーク失敗 | 503 | `temporarily_unavailable` |
| 必須設定（`AWS_PROFILES` 含む）の欠落・不正・署名鍵が不正 | 500 | `server_misconfigured` |
| `aws_profile` が一覧にない | 400 | `unknown_aws_profile` |
| `aws_profile` が文字列でない | 400 | `invalid_aws_profile` |
| JSON-RPC バッチで対象ツールの `aws_profile` が混在 | 400 | `batch_not_supported` |
| 上流 AWS MCP への署名失敗・接続失敗 | 502 | （本文 `Bad Gateway`。ログは `proxy: sign_failed` / `proxy: fetch_failed`） |
| 未対応メソッド | 405 | （本文 `Method Not Allowed`） |

STS の `invalid_token` を 401 ではなく 502 `upstream_auth_failed` にした理由: Worker 自身が発行した JWT が AWS に拒否されるのは、署名鍵・issuer・JWKS 公開・IAM OIDC プロバイダーなどサーバー側の設定不整合であり、利用者が Access で再認証し直しても直らない。401 を返すとクライアントが再認証を繰り返すだけになる。前身の aws-mcp-gateway はこれを 401 にしていたが、原因が利用者側にないので意図的に変えた。

## テスト方針

- Unit: vitest + `@cloudflare/vitest-pool-workers`。JWT 検証・JWT 発行・STS XML パース・SigV4・claim マッピング（Google / Entra フィクスチャ）
- E2E: `wrangler dev` + mock（JWKS を出す擬似 Access、擬似 STS、SigV4 を検証する擬似 MCP Server）。STS / MCP エンドポイントは env で差し替え可能にする
- コマンドは `mise run test` / `test:unit` / `test:e2e` / `lint` / `fmt` / `build` / `dev`

## PoC 結果（構成 A'、2026-11-05）

未決事項 1 の検証。Worker（`*.workers.dev`）を OIDC issuer として IAM に登録し、Worker と同じ署名コード（`src/oidc.ts` の `signStsToken`）で発行した JWT で STS を呼んだ。**構成 A' は成立する。**

再現手順（値は `mise.local.toml` に置く。アカウント ID・email・Worker の URL はリポジトリに入れない）。Cloudflare 側（Worker）と AWS 側（CloudFormation）は分離しており、Worker のデプロイは AWS を呼ばず、CloudFormation のデプロイは Cloudflare を呼ばない。対象 AWS アカウントには CloudFormation だけを流す。

初回は Worker の URL が issuer になるため、Worker → CloudFormation → secret の順に進める。

```
# Cloudflare 側（1 回）
mise run keygen             # 開発用 RSA 鍵を .secrets/ に生成
mise run deploy:worker      # wrangler deploy → secrets を順に実行（AWS は呼ばない）。初回は URL を確定させるために先に実行する
                            #   プロファイル一覧を secret で持つ場合は、下の手順で AWSBRIDGE_PROFILES を設定したあと mise run secrets を実行し直す

# AWS 側（対象アカウントごと。何度でも別アカウントに流せる）
AWS_PROFILE=<対象> mise run deploy:aws   # CloudFormation（OIDC プロバイダー + ロール 2 つ）をデプロイ。出力 ReadOnlyRoleArn / DebugRoleArn を控える

# Cloudflare 側（ロール ARN の反映）
# mise.local.toml に AWSBRIDGE_PROFILES（JSON 文字列。出力 ReadOnlyRoleArn / DebugRoleArn を並べる）を設定
mise run secrets            # Worker secret を一括登録（SIGNING_JWK / ADDITIONAL_PUBLIC_JWKS / ACCESS_TEAM_DOMAIN / ACCESS_AUD / AWS_PROFILES）

mise run poc:sts            # 正常 1 + 否定 4 ケース（--role-arn 省略時はスタックの Output ReadOnlyRoleArn。AWS_PROFILE で対象を選ぶ）
AWS_PROFILE=<対象> mise run destroy:aws  # 後片付け（CloudFormation スタックの削除）
```

`mise.local.toml` には `AWSBRIDGE_ISSUER` などに加えて `AWSBRIDGE_ACCESS_TEAM_DOMAIN`・`AWSBRIDGE_ACCESS_AUD`・`AWSBRIDGE_PROFILES` が要る。IAM 側のリソースは `infra/aws/awsbridge.yaml`（CloudFormation）で作る。マネジメントコンソールや StackSets でテンプレートを直接流してもよい（パラメーターは README_ja.md の「AWS 側」を参照）。`AWS_PROFILE` と `AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_AUDIENCE` は呼び出し側の環境変数が優先される（既定値はスクリプト側にあり、`mise.toml` の `[env]` には置かない）。

### Worker が公開した discovery（IAM が受理した内容）

```json
{
  "issuer": "https://<worker>.<subdomain>.workers.dev",
  "jwks_uri": "https://<worker>.<subdomain>.workers.dev/.well-known/jwks.json",
  "authorization_endpoint": "https://<worker>.<subdomain>.workers.dev/oauth/authorize",
  "token_endpoint": "https://<worker>.<subdomain>.workers.dev/oauth/token",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "claims_supported": ["sub", "aud", "exp", "iat", "iss", "email"]
}
```

- `authorization_endpoint` / `token_endpoint` は URL として存在するだけで、中身は実装していない（404）
- JWKS は RSA 2048 の公開鍵 1 本（ローテーション中は署名鍵の公開鍵 + 追加の公開鍵。[署名鍵のローテーション](#署名鍵のローテーション)）。`kid` は JWK thumbprint（RFC 7638）、`use: "sig"`, `alg: "RS256"`
- `issuer` は末尾スラッシュなし。JWT の `iss` とバイト単位で一致させる

### IAM 側

- `aws iam create-open-id-connect-provider --url https://<worker host> --client-id-list awsbridge` で登録できた。**thumbprint の指定は不要**（IAM が信頼済み CA で検証する）
- 登録は CLI（API）で行った。マネジメントコンソールからの登録（構成 A で discovery エラーが出た経路）は今回試していない
- 信頼ポリシーの条件キーは `<worker host>:aud` と `<worker host>:sub`（`StringEquals`）

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/<worker host>" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "<worker host>:aud": "awsbridge",
      "<worker host>:sub": "<利用者の email>"
    }
  }
}
```

### STS の結果

署名なし `fetch`（`POST https://sts.amazonaws.com/`）+ XML パースで実行。`RoleSessionName` は aws-mcp-gateway と同じ `gw-<email>`（64 文字以内に切り詰め）。

| ケース | 結果 | HTTP | エラーコード |
|---|---|---|---|
| 正常（JWT の `exp - iat` = 300 秒） | 成功。`assumed-role/awsbridge-poc/gw-<email>`、返却された認証情報で `GetCallerIdentity` も成功 | 200 | - |
| `aud` 違い | 拒否 | 400 | `InvalidIdentityToken`（could not be validated） |
| 期限切れ | 拒否 | 400 | `ExpiredTokenException` |
| JWKS に無い鍵で署名 | 拒否 | 400 | `InvalidIdentityToken`（Couldn't retrieve verification key） |
| `sub` が信頼ポリシーと不一致 | 拒否 | 403 | `AccessDenied` |

エラーの分類は aws-mcp-gateway の `classifyFederatedError` と対応づけられる: `InvalidIdentityToken` / `ExpiredTokenException` → トークン不正（Worker 側の再発行で回復しうる）、`AccessDenied` → ロール設定または利用者が許可されていない。

### 気づいたこと

- workers.dev のサブドメインはアカウント名と一致するとは限らない。issuer はデプロイ結果の URL を正とする
- 署名鍵を単純に差し替えると、STS 側の JWKS キャッシュにより切り替え直後に検証失敗が起きうる。このため JWKS に新旧の鍵を並べる無停止のローテーションを実装した（[署名鍵のローテーション](#署名鍵のローテーション)）

## 未決事項

1. ~~**PoC 残り**: Worker が出す discovery / JWKS を IAM が受理するか、Worker 発行 JWT で `AssumeRoleWithWebIdentity` が成功するか~~ → **解決**（[PoC 結果](#poc-結果構成-a-2026-11-05)）
2. ~~`aws_profile` を継承するか~~ → **解決**: 継承。各アカウントへ直接 AssumeRoleWithWebIdentity（[マルチアカウント](#マルチアカウントaws_profile)）
3. ~~`/mcp/assumerole/...` を廃止するか~~ → **解決**: 廃止（`aws_profile` に一本化）
4. ~~会社のセキュリティ方針上、A'（Worker 鍵を AWS が信頼）が許容されるか。不可なら C~~ → **解決**（2026-11-05、許容される。構成 A' で確定し、案 C には切り替えない）

## 参考

- [MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
