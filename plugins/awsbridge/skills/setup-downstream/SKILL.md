---
name: setup-downstream
description: 利用者が明示したときに、awsbridge を upstream とする下流の private リポジトリを作り、Worker・AWS（CloudFormation）・Cloudflare Access/Portal まで対話しながらセットアップする。
argument-hint: <下流リポジトリ名（例 awsbridge-mcp）>
disable-model-invocation: true
---

# awsbridge の下流リポジトリをセットアップする

下流リポジトリ名: $ARGUMENTS

awsbridge（public）を `upstream` とする下流の private リポジトリを作り、デプロイまで進めます。以下の `<name>` は下流リポジトリ名（環境名）です。下流は上流のファイルを編集せず、3 つのファイル（`wrangler.<name>.jsonc` / `mise.<name>.toml` / `.miserc.toml`）を足すだけで動きます。詳しくは awsbridge の README「デプロイ」「下流リポジトリでの運用」「マルチアカウント」を参照してください。

## 手順

1. 入力を確認する。次の項目のうち足りないものは利用者に聞いて、ここで止まる（推測で埋めない）。
   - 下流リポジトリ名（上の `$ARGUMENTS`。空なら聞く）
   - GitHub の owner（個人または Organization）
   - private リポジトリを新規に作るか、既存のものを使うか
   - Worker 名（既定は下流リポジトリ名）
   - 対象の AWS アカウントのプロファイル一覧: aws_profile として使う名前（英数字・`_`・`-` の 1〜32 文字。1 アカウントにつき `<env>-readonly` と `<env>-debug` の 2 つ。例 `dev-readonly` / `dev-debug`）、デプロイに使う AWS CLI プロファイル、説明（任意）、default にするもの（readonly 側を勧める）
   - 読み取り専用ロールを使える利用者 `AllowedSubjects`、デバッグロールを使える利用者 `DebugAllowedSubjects`（どちらも `user@example.com` または `*@example.com`。ドメイン部のワイルドカードと `*` 単独は不可。デバッグはリモート実行相当の権限を含むので、読み取り専用より絞ることを勧める）
   - Cloudflare Access のチームドメイン（`https://<team>.cloudflareaccess.com`）
   - デバッグロールに追加する管理ポリシー `DebugAdditionalPolicyArns`（任意。必要最小限にする）
2. リポジトリを作る。外部に作る操作なので、実行前に owner・名前・private であることを利用者に確認する。
   - 既存でなければ `gh repo create <owner>/<name> --private` を実行する。既にあれば作らずにそれを使う。
   - awsbridge を clone し、`git remote rename origin upstream` で上流を `upstream` にして、`git remote add origin <下流の URL>` で下流を `origin` に足す。
3. 下流のファイルを作る。値は手順 1 の入力で埋める。ロール ARN は手順 5 で決まるまで仮に空にしておく。
   - `wrangler.<name>.jsonc`: 上流の `wrangler.jsonc` から `compatibility_date` / `compatibility_flags` / `main` / `observability` を写し、`name`（Worker 名）、`workers_dev: true`、`vars.AWS_PROFILES`（`default` と `profiles`。`tools` は通常省略。指定するなら AWS MCP Server の実際のツール名（例 `aws___run_script`））を書く。`env` セクションは使わない。
   - `mise.<name>.toml`: `[env]` に `AWSBRIDGE_WRANGLER_CONFIG = "wrangler.<name>.jsonc"`、`AWSBRIDGE_WRANGLER_ENV = ""`（空 = `--env` を付けない）、`AWSBRIDGE_STACK_NAME = "<name>"`、`AWSBRIDGE_KEY_FILE = ".secrets/<name>-signing-key.json"` を書く。
   - `.miserc.toml`: `env = ["<name>"]`。
   - `mise.local.toml`（gitignore 済みか確認する。コミットしない）: `AWSBRIDGE_ALLOWED_SUBJECTS` / `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS` / `AWSBRIDGE_ACCESS_TEAM_DOMAIN` / `AWSBRIDGE_POC_SUBJECT`（動作確認に使う利用者）と、必要なら `AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS` を書く。`AWSBRIDGE_ISSUER` は Worker をデプロイしてから決まるので、ここではまだ書かない。`AWS_PROFILES` を `vars` で持つので `AWSBRIDGE_PROFILES` は書かない。
4. Cloudflare 側（Worker）を先にデプロイする。デプロイは外部に影響するので、実行前に利用者に確認する。
   - `mise install`（初回は `mise trust` が必要なことがある）→ `mise run install`（clone 直後は依存パッケージが無い）
   - `mise run keygen`（`AWSBRIDGE_KEY_FILE` に署名鍵を生成する。環境ごとに別の鍵にする。既存なら上書きされない）
   - `deploy:worker` は `AWSBRIDGE_ISSUER`（Worker の URL）が必須。URL は Cloudflare アカウントの workers.dev サブドメインで決まり、名前からは推測できないので、利用者にサブドメイン（Cloudflare ダッシュボードの Workers & Pages で確認できる）を聞く。`wrangler login` 済みであることも確認する。
   - `mise.local.toml` に `AWSBRIDGE_ISSUER = "https://<Worker 名>.<サブドメイン>.workers.dev"` を設定し、`mise run deploy:worker`（wrangler deploy → secrets 登録）を実行する。この時点では Access アプリがまだ無く AUD が決まっていない。`secrets` は `AWSBRIDGE_ACCESS_AUD` が空だと止まるので、利用者に断ったうえで仮の値（`pending` など）を `mise.local.toml` に置く。仮の値のままでは `/mcp` は 401 になるだけで、手順 6 で本物に差し替える。
   - デプロイ出力の URL が `AWSBRIDGE_ISSUER` と違っていたら、出力の URL に直してもう一度 `mise run deploy:worker` する。
   - この時点で `/mcp` が 500（プロファイル未登録）か 401 になるのは正常。
5. AWS 側を、対象アカウントごとに流す。CloudFormation の実行は外部に影響するので、アカウントごとに利用者に確認する。
   - `AWS_PROFILE=<対象> mise run deploy:aws`
   - 出力（`aws cloudformation describe-stacks` でも取れる）の `ReadOnlyRoleArn` と `DebugRoleArn` を、`wrangler.<name>.jsonc` の `vars.AWS_PROFILES.profiles` に 2 つのプロファイル（例 `<env>-readonly` に ReadOnlyRoleArn、`<env>-debug` に DebugRoleArn）として反映する。`default` は必須（readonly 側を勧める）。
   - すべてのアカウントを流したら、`mise run deploy:worker` で一覧を反映する（利用者に確認）。
6. Cloudflare Access / MCP Server Portal を用意する。
   - 利用者が既に Cloudflare の IaC を持っているなら、そちらに足す。必要なものは、Worker 用の self-hosted Access アプリ（Managed OAuth 有効。動的クライアント登録の許可 URI に `https://dash.cloudflare.com/<アカウント ID>/one/access-controls/ai-controls/mcp-server/oauth-callback/*` と `https://<portal のホスト>/servers-callback` を入れる。無いと MCP サーバーの認証が「Redirect URI not allowed」で失敗し waiting のままになる）、`/.well-known/openid-configuration` と `/.well-known/jwks.json` を対象外にする bypass（AWS IAM / STS が認証なしで取りに来る）、MCP サーバー（`https://<worker_host>/mcp`、`auth_type = "oauth"`）、`type = "mcp"` のアプリ、Portal への登録。
   - IaC が無ければ、上流の `infra/cloudflare/`（README と `main.tf` / `variables.tf` / `terraform.tfvars.example`）を参考にする。これは参考実装で、作者は apply を検証していないと利用者に伝える。`terraform plan` の差分を読んでから apply する。Portal の Require user auth は Enabled にする（Terraform では portal の `servers[].on_behalf = true`。既存の IaC に足す場合も同じ。`false` だと管理者の資格を全員で共用し、全員が管理者の身元で AWS に入る）。手順 7 で、Portal の画面でこのサーバーに利用者ごとの「Sign Out」が出ることを確認する。
   - MCP サーバーは作成直後 waiting なので、管理者が Cloudflare ダッシュボード（AI controls → MCP servers）で一度認証し、Portal のツール一覧を同期する。
   - Worker 用 Access アプリの AUD タグを `mise.local.toml` の `AWSBRIDGE_ACCESS_AUD` に設定する（MCP アプリや Portal の AUD ではない）。利用者に確認して `mise run secrets` で Worker secret に登録する。
7. 動作を確認する。
   - Access ヘッダー無しで `/mcp` が 401 を返す。
   - `/.well-known/openid-configuration` が 200 を返す。
   - 各ロール（ReadOnlyRoleArn と DebugRoleArn）について `mise run poc:sts -- --role-arn <ロール ARN>` を実行する（`--role-arn` を省略すると ReadOnlyRoleArn を使う）（`AWSBRIDGE_POC_SUBJECT` が必要。実 AWS を呼ぶので利用者に確認する。結果の合否だけを報告し、エラー本文や認証情報は貼らない）。
   - Portal 経由の正常系（`tools/list`、`aws_profile` を付けた `tools/call`）は利用者に試してもらう。
8. 下流リポジトリにコミットし、利用者の確認後に push する。
   - コミットするのは `wrangler.<name>.jsonc` / `mise.<name>.toml` / `.miserc.toml`。`mise.local.toml` と `.secrets/` は含まれていないことを `git status` で確認する。
   - `mise run deploy:worker` のあとは、Portal のツール一覧を再同期する（Cloudflare ダッシュボードの AI controls → MCP servers でこのサーバーを同期）。Portal は `tools/list` をキャッシュしており、注入された `aws_profile` の enum（プロファイル一覧）は再同期するまで反映されない。
   - 上流の更新を取り込むときは `git pull --no-rebase upstream main` （下流のコミットを付け直さないよう rebase せず merge する。push 済みの履歴と食い違わない）→ `mise run test` → `mise run deploy:worker`。

## 止まる条件

- 手順 1 の入力が足りないとき。
- `gh` や `wrangler` が未ログイン、AWS プロファイルが使えないなど、前提が満たせないとき。利用者に伝えて止まる。
- 同じコマンドが 2 回失敗して原因が分からないとき。エラーの要点だけを伝えて止まる。

## 守ること

- 外部に影響する操作（リポジトリ作成、Worker のデプロイ、CloudFormation、secret 登録、Terraform の apply、push）は、各段階で実行前に利用者に確認する。
- 署名鍵（`.secrets/`）と `mise.local.toml` をコミットしない。
- 開発用と本番用、または環境どうしで署名鍵を共有しない。上流の開発用デプロイの鍵・issuer も使い回さない。
- public な upstream（awsbridge）のファイルにアカウント ID や実在のドメインを書かない。下流は private なので、ロール ARN を含むプロファイル一覧のコミットは可。
- STS や MCP のエラー本文、署名鍵、トークン、認証情報を会話に貼らない。
- 存在しないコマンドを書かない。使うのは `mise run keygen` / `deploy:worker` / `deploy:aws` / `secrets` / `poc:sts` / `test` など、リポジトリの `mise.toml` にあるタスクだけ。
