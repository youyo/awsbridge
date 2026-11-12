# awsbridge

[English](README.md) | 日本語

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

1. Cloudflare 側: `mise run keygen` → `mise.local.toml` に `AWSBRIDGE_ISSUER` などを設定 → `cp config/profiles.example.json config/profiles.json`（ビルドに必須。中身はこの時点ではダミーのままでよい）→ `mise run deploy:worker`（Worker の URL を確定させる。この時点ではダミーのロール ARN なので `/mcp` は使えない）
2. AWS 側: `AWS_PROFILE=<対象> mise run deploy:aws`（出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える）
3. プロファイル一覧を登録する。`config/profiles.json` に出力のロール ARN を書き（下の「マルチアカウント」）、`mise run deploy:worker` で反映する。一覧は環境変数ではなく Worker にバンドルされる JSON なので、`config/profiles.json` が無いとビルドが失敗する（未設定はエラー）

2 回目以降は、変更した側だけを流します。

### AWS 側（対象アカウントごと）

[infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml) を流すだけです。Worker の URL を issuer とする IAM OIDC プロバイダーと、Worker 発行の JWT で引き受ける 2 つのロール（読み取り専用 `FederatedAwsBridgeMcpViewer`、デバッグ `FederatedAwsBridgeMcpDebugger`）を作ります。この MCP 用ロールは、人のコンソールログインのロール（Viewer / Administrator）とは独立した別のロールで、人にコンソールのロールを与えても MCP 用ロールの権限は変わりません。Viewer（`FederatedAwsBridgeMcpViewer`）は全員が使えます。Debugger（`FederatedAwsBridgeMcpDebugger`）を誰に渡すかは、下流の設定（`DebugAllowedSubjects`）で決めます（上流は規則を持ちません）。渡すときの注意: Debugger はリモートシェルなどで実行先のロールの権限を得られ、その権限には MCP 経由の条件が付きません。

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
| `ReadOnlyRoleName` | 読み取り専用ロール名（既定 `FederatedAwsBridgeMcpViewer`） |
| `DebugRoleName` | デバッグロール名（既定 `FederatedAwsBridgeMcpDebugger`） |
| `DebugAdditionalPolicyArns` | 任意。デバッグロールに追加で付ける管理ポリシー（カンマ区切り。空なら付けない） |
| `DebugPassableEcsTaskRoleArns` | 任意。`ecs:RunTask` でタスクに渡してよい IAM ロール ARN（カンマ区切り。ワイルドカード不可）。空なら `iam:PassRole` を付けない |

デプロイ後、出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控えます（`aws cloudformation describe-stacks` でも取れます）。

#### ロールの権限と注意

| ロール | 権限 |
|---|---|
| `FederatedAwsBridgeMcpViewer` | AWS 管理ポリシー `ReadOnlyAccess` + SSM パラメーターの取得（`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`）と Secrets Manager の値の取得（`secretsmanager:GetSecretValue` / `BatchGetSecretValue`）の明示 Deny（条件なし） |
| `FederatedAwsBridgeMcpDebugger` | `ReadOnlyAccess` + インラインポリシー（調査の読み取り強化・軽い運用操作・費用のかかる操作・接続と実行。Allow はすべて `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com` の条件付き。読み取り専用ロールと同じ、SSM パラメーターと Secrets Manager の値の取得の無条件の Deny を含む）+ 任意の `DebugAdditionalPolicyArns` |

デバッグロールのインラインポリシーは、次のグループに分かれています（Allow はすべて `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com` の条件付き、Resource は `*`）。削除系の操作・IAM 変更・組織変更は含みません（ただし Knowledge Bases の同期は、結果として索引の文書を消すことがあります。`Operations` を参照）。

| グループ（Sid） | 内容 |
|---|---|
| `Investigation` | `ReadOnlyAccess` より深い調査用の読み取り。Logs Insights / ログ取得 / Live Tail、X-Ray、CloudTrail（`LookupEvents`・クエリ）、Athena のクエリ実行、EC2 コンソール出力 / スクリーンショット、AWS Config の `SelectResourceConfig` / `GetResourceConfigHistory` |
| `DenySsmParameterRead` / `DenySecretsManagerRead` | **Deny**（条件なし。読み取り専用ロールと同じ）: `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`、`secretsmanager:GetSecretValue` / `BatchGetSecretValue`。直接の呼び出しにも AWS MCP 経由の呼び出しにも効き、`DebugAdditionalPolicyArns` で足した管理ポリシーの Allow より優先します。`kms:Decrypt` は付けません（下の注意を参照） |
| `Operations` | 副作用のある軽い運用操作（削除なし）: ECS の `UpdateService` / `StopTask`、EC2 の起動・停止・再起動、Lambda の同時実行数の変更、Auto Scaling の台数変更、RDS / ElastiCache の再起動、CloudFront の `CreateInvalidation`、Bedrock Knowledge Bases の同期の開始・中止（`bedrock:StartIngestionJob` / `StopIngestionJob`）。同期は削除操作ではありませんが、データソース（S3 など）から消えた文書はベクトルストアからも消えます。<br>止める・再起動する: `states:StopExecution`、`glue:BatchStopJobRun` / `StopCrawler`、`codebuild:RetryBuild` / `StopBuild`、`autoscaling:SuspendProcesses` / `ResumeProcesses`、`rds:FailoverDBCluster` / `RebootDBCluster`、`elasticache:TestFailover`、`elasticbeanstalk:RestartAppServer`。<br>止める・抑える: `cloudwatch:DisableAlarmActions` / `EnableAlarmActions`、`events:EnableRule` / `DisableRule` / `CancelReplay`、`autoscaling:SetInstanceHealth` / `EnterStandby` / `ExitStandby`、`rds:StartDBInstance` / `StopDBInstance` / `StartDBCluster` / `StopDBCluster`、`ssm:StopAutomationExecution`、`batch:CancelJob`、`codepipeline:StopPipelineExecution` |
| `CostIncurring` | **費用がかかる**操作: `bedrock:InvokeModel` / `InvokeModelWithResponseStream`（Converse を含む）/ `ApplyGuardrail` / `RetrieveAndGenerate`、`sagemaker:InvokeEndpoint` / `InvokeEndpointAsync`、`rds:CreateDBSnapshot` / `CreateDBClusterSnapshot`、`ec2:CreateSnapshot`、`lambda:PutProvisionedConcurrencyConfig`。スナップショットを共有する権限は含みません |
| `Execution` | 接続・実行: `ssm:SendCommand` / `StartSession` など、EC2 Instance Connect、`ecs:ExecuteCommand` / `RunTask`、`lambda:InvokeFunction`、`states:StartExecution`、`sqs:SendMessage`、`sns:Publish`、`rds-db:connect`。業務ロジック・デプロイの実行: `states:RedriveExecution` / `StartSyncExecution`、`bedrock:InvokeAgent`、`lambda:InvokeFunctionUrl`、`glue:StartCrawler` / `StartWorkflowRun`、`ssm:StartAutomationExecution`、`events:StartReplay` / `PutEvents`、`codepipeline:RetryStageExecution`。`ecs:RunTask` 用の `iam:PassRole` は別 Statement で、`DebugPassableEcsTaskRoleArns` を指定したときだけ付き、渡せるロールをその ARN、渡し先を `ecs-tasks.amazonaws.com` に限定します（空ならタスクロール無しのタスク定義だけ実行できます） |

Athena のクエリは結果バケットへの書き込み（`s3:PutObject`）が別に必要です。このポリシーには含めていないので、必要なら `DebugAdditionalPolicyArns` で足してください。

Knowledge Bases の同期（`bedrock:StartIngestionJob` / `StopIngestionJob`）も、ほかのグループと同じく Resource は `*` です。デバッグロールはアカウント内のどのリソースでも調べられることを前提にしており、ほかの操作（ECS・EC2・RDS など）も対象の ARN をパラメーターにしていないため、Knowledge Base の ARN で絞るパラメーターは設けていません（`DebugAdditionalPolicyArns` は権限を足すだけで、絞ることはできません）。対象を絞るなら、テンプレートの `Operations` の Resource を `arn:${Partition}:bedrock:${Region}:${Account}:knowledge-base/${KnowledgeBaseId}` に書き換えるか、`aws:ResourceTag` の条件を足してください。

- **デバッグロールはリモート実行相当の権限を含みます。** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` はリモートシェルと同等で、秘密情報や認証情報、ファイルの内容が見えてしまうことがあります（コマンドはインスタンスやタスクのロールの権限で動き、そのロールが秘密値を読めることがあります）。`Operations` と `lambda:InvokeFunction`・`states:StartExecution`・`sqs:SendMessage`・`sns:Publish` は副作用のある処理を実行します。
- **費用がかかる操作とデプロイを伴う操作を含みます。** `CostIncurring` のモデル・推論エンドポイントの呼び出し、スナップショットの作成、プロビジョンド同時実行は課金されます（`rds:StopDBInstance` もスナップショットを作れます）。`codepipeline:RetryStageExecution` は失敗したステージを再試行し、本番へのデプロイを走らせることがあります。`events:StartReplay` / `PutEvents`、`bedrock:InvokeAgent`、`glue:StartCrawler` / `StartWorkflowRun`、`ssm:StartAutomationExecution` は、それぞれのターゲット・ジョブ・オートメーションを実行します。`glue:StartCrawler` は、クローラーの設定次第でカタログのテーブルを削除・非推奨にします。
- **止める・抑える操作は戻し忘れに注意してください。** `cloudwatch:DisableAlarmActions` や `events:DisableRule`、`autoscaling:SuspendProcesses` / `EnterStandby` は、戻し忘れると障害の見逃しや自己修復の停止につながります。`autoscaling:SetInstanceHealth` で Unhealthy にしたインスタンスは終了・置き換えされます。
- **Secrets Manager と SSM パラメーターストアの値は、API で直接は読めません（両ロール）。** 両ロールとも `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory` と `secretsmanager:GetSecretValue` / `BatchGetSecretValue` を条件なしで Deny するので、AWS MCP を経由するかどうかに関係なく効きます。`ReadOnlyAccess`（v191）は `ssm:Get*` を含み（SecureString も `aws/ssm` キーならキーポリシー側で復号できます）、Deny が無いとセッションで SSM パラメーターを読めてしまいます。`ReadOnlyAccess` は `secretsmanager:GetSecretValue` と `kms:Decrypt` を含まず、インラインポリシーもどちらも付けません。明示 Deny は常に優先するので、`DebugAdditionalPolicyArns` で管理ポリシーを足しても、これらの取得は戻せません。
- **権限昇格の経路は塞いでいます。** `iam:PassRole` を `*` に付けると、任意のロールでタスクを動かせてしまうため、既定では付けず、`DebugPassableEcsTaskRoleArns` で明示したロールだけに限ります。また `lambda:UpdateFunctionConfiguration`（実行ロールや環境変数の差し替え）と `autoscaling:UpdateAutoScalingGroup`（起動テンプレートの差し替え）は付けていません。`glue:StartJobRun` と `batch:SubmitJob` も付けていません。引数やコマンド・環境変数を上書きして、ジョブのロールの権限で任意のコードを動かせるためです（`codebuild:StartBuild` と同じ理由です）。`codepipeline:StartPipelineExecution` も付けていません。`sourceRevisions` でソースのコミット・S3 オブジェクト・イメージを差し替えられ、`variables` で任意の値をパイプラインに渡せるためです（引数を上書きできる `codebuild:StartBuild` と同じ理由です。再実行は `RetryStageExecution` で行います）。`ssm:StartAutomationExecution` 用の `iam:PassRole` は付けないため、オートメーションは呼び出し元の権限の範囲でだけ動きます。
- **残るリスク:** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` / EC2 Instance Connect は、対象のインスタンスやタスクに付いたロールの権限で動けます。権限の強いインスタンス・タスクが同じアカウントにあると、その権限を借りられます。本番ではタグ条件や SSM ドキュメントで対象を絞ってください。
- **「秘密値を読めない」わけではありません。** 上の 2 つの API 以外の経路は残ります: リモートシェル（デバッグロール。`ssm:SendCommand` / `StartSession`、`ecs:ExecuteCommand`、EC2 Instance Connect はインスタンスやタスクのロールの権限で動き、そのロールで秘密値を読めることがあります）、SSM のコマンドの実行結果（`ssm:GetCommandInvocation` / `ListCommandInvocations`）と Automation の実行結果、Lambda の環境変数と `lambda:GetFunction` で得るコードの取得 URL、ECS のタスク定義と CodeBuild プロジェクトの平文の環境変数、EC2 のユーザーデータ、CloudFormation のテンプレートと出力、AppConfig の設定内容、S3 のオブジェクト（`s3:GetObject`）、ログ、`rds-db:connect`（デバッグロール）。ECS の秘密の参照（`secrets` / `valueFrom`）や CodeBuild の `SECRETS_MANAGER` / `PARAMETER_STORE` 型の環境変数で見えるのは参照先だけで、値ではありません（平文の環境変数とは別です）。これらの多くは調査で日常的に使うため Deny していません。ここに秘密値があるなら、`AllowedSubjects` / `DebugAllowedSubjects` を絞るか、権限境界・SCP で独自に Deny してください。
- **`ReadOnlyAccess` のバージョンは固定されません。** AWS 管理ポリシーなので、AWS の更新で読める範囲が変わることがあります。上の Deny は値を取得する API を名指しで止めるので、その部分は更新の影響を受けません。
- **`ReadOnlyAccess` は MCP 経由に限定されません。** AWS 管理ポリシーには IAM 条件を付けられないため、セッションの認証情報で直接 API を呼んでも読み取り権限は有効です。`aws:CalledViaAWSMCP` で絞られるのは、デバッグロールのインラインポリシーの Allow だけです。
- 本番では `Resource` を特定の ARN・タグ・SSM ドキュメントに絞り、セッションログ（SSM Session Manager のログ、ECS Exec のログ、Lambda の CloudWatch Logs）を必ず有効にしてください。CloudTrail だけでは足りません。
- 利用者はロールごとに `AllowedSubjects`（読み取り専用）と `DebugAllowedSubjects`（デバッグ）で分けます。`DebugAllowedSubjects` は読み取り専用より狭くしてください。

### Cloudflare 側（1 回）

```
mise run keygen          # 署名鍵を生成（.secrets/、既存なら上書きしない）
# mise.local.toml に AWSBRIDGE_ISSUER / AWSBRIDGE_ACCESS_* などを設定
cp config/profiles.example.json config/profiles.json   # プロファイル一覧（gitignore）。ロール ARN を書く
mise run deploy:worker   # wrangler deploy → secrets を順に実行（AWS は呼ばない）
```

`secrets` は単独でも実行できます（`mise run secrets`）。`wrangler secret bulk` に標準入力で JSON を渡すので、値がコマンドライン引数に出ません。登録するのは `SIGNING_JWK` / `ADDITIONAL_PUBLIC_JWKS`（署名鍵のローテーション用。通常は `[]`）/ `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` です。プロファイル一覧は secret にしません（Workers の環境変数は 1 つ 5 KB が上限で、270 プロファイルなら約 38 KB になるため）。`config/profiles.json` として Worker にバンドルします（「マルチアカウント」参照）。

検証: `mise run poc:sts`（正常 1 + 否定 4 ケース。実 AWS を呼ぶので明示的に実行したときだけ使います）。

### `mise.local.toml` の変数

固定の既定値は `mise.toml` にあります。アカウント固有の値は `mise.local.toml`（gitignore）に書きます（値はすべてプレースホルダーです）。

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge.example.workers.dev"   # Worker の URL（OIDC issuer）
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # 読み取り専用ロールを引き受けられる利用者（カンマ区切り）
AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS = "admin@example.com"       # デバッグロールを引き受けられる利用者（カンマ区切り）
# AWSBRIDGE_READONLY_ROLE_NAME = "FederatedAwsBridgeMcpViewer"        # 任意。ロール名（既定値）
# AWSBRIDGE_DEBUG_ROLE_NAME = "FederatedAwsBridgeMcpDebugger"          # 任意。ロール名（既定値）
# AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS = "arn:aws:iam::<アカウントID>:policy/<名前>" # 任意。デバッグロールに追加する管理ポリシー（カンマ区切り）
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # poc:sts の正常ケースで使う利用者
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # Access のチームドメイン
AWSBRIDGE_ACCESS_AUD = "<Access アプリケーションの AUD タグ>"   # このアプリケーションの AUD
```

`AWSBRIDGE_ALLOWED_SUBJECTS` と `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS` の書式（どちらも同じ）: 各要素は `user@example.com` または `*@example.com` の形です。ワイルドカードを使えるのはメールのローカル部だけで、ドメイン部（`*@*` や `*@*.com`）や `*` 単独は使えません（全員に許可してしまうため）。空要素や前後の空白もエラーです。email は小文字に正規化して照合します（Worker は Access JWT の email を小文字にして STS に渡し、`deploy:aws` もこれらを小文字にして CloudFormation に渡します）。`deploy:aws` は AWS を呼ぶ前にこれを検証し、CloudFormation テンプレートの `AllowedPattern` でも同じ検査をします。

`AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS` で付ける管理ポリシーは、デバッグロールを引き受けた利用者が実行できる操作そのものになります。必要最小限の権限だけを付けてください（未設定なら何も付けません）。

上書きできる既定値（`scripts/` 側で補います。環境変数・`mise.local.toml`・下流の mise 設定ファイルで変更可）: `AWS_PROFILE`（`awsbridge`）、`AWSBRIDGE_AUDIENCE`（`awsbridge`）、`AWSBRIDGE_STACK_NAME`（`awsbridge`）、`AWSBRIDGE_KEY_FILE`（リポジトリルートの `.secrets/dev-signing-key.json`）、`AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE`（鍵ローテーション用。既定は `AWSBRIDGE_KEY_FILE` の拡張子の前に `.next` / `.previous` を付けたもの）、`AWSBRIDGE_WRANGLER_CONFIG`（`wrangler.jsonc`）、`AWSBRIDGE_WRANGLER_ENV`（未設定なら `dev`。**空文字なら `--env` を付けない**）。

### Worker の設定

secret（`mise run secrets` が登録）: `SIGNING_JWK`、`ADDITIONAL_PUBLIC_JWKS`（任意。署名鍵のローテーション用の追加の公開鍵）、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。プロファイル一覧は env / secret ではなくバンドルした JSON モジュール（`awsbridge:profiles`。必須）で渡します。

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
2. プロファイル一覧（必須）を JSON ファイルに書く。上流の開発用デプロイでは `cp config/profiles.example.json config/profiles.json` で作ります（gitignore。値はプレースホルダー）。一覧は環境変数ではなく、wrangler の `alias` で JSON モジュール `awsbridge:profiles` として Worker にバンドルされるので、プロファイル数に実質的な上限はありません（Workers の環境変数は 1 つ 5 KB が上限）。ファイルが無いとビルド（`wrangler deploy` / `wrangler dev`）が `Cannot find module` で失敗します。`profiles` は配列で書くのを推奨します。配列の順が `list_aws_profiles` の返す一覧の順になります（`default` は常に先頭）。

```json
{
  "default": "dev-readonly",
  "profiles": [
    { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedAwsBridgeMcpViewer", "description": "開発（読み取り専用）" },
    { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedAwsBridgeMcpDebugger", "description": "開発（デバッグ）" },
    { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedAwsBridgeMcpViewer" },
    { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedAwsBridgeMcpDebugger" }
  ]
}
```

`profiles` はオブジェクト（`"profiles": { "dev-readonly": { "roleArn": "..." }, ... }`）でも書けます（従来の形式）。ただしオブジェクトのキーの順は、Worker に届くまでの経路で保たれないことがあります（原因は未特定。実環境で、`dev-readonly` → `dev-debug` と書いたのに Portal の enum が名前順になった例があります）。順を意図するなら配列で書いてください。配列形式の `name` は必須で、重複は 500 `server_misconfigured` です。

- プロファイル名: 英数字・`_`・`-` の 1〜32 文字（超えると 500 `server_misconfigured`）。数字だけの名前はオブジェクトの規則で数値順に先に並ぶので、順を意図するなら避けてください。
- `default`: 必須。`aws_profile` を省略したとき、および `tools/list` など `tools/call` 以外で使うプロファイル。
- `tools`: 任意。`aws_profile` の対象ツール（省略時は全ツール。通常は省略でよい）。名前は AWS MCP Server が返す実際のツール名（例: `aws___run_script`。`tools/list` で確認できる）で、存在しない名前を書くと `aws_profile` が効きません。対象外ツールに付いた `aws_profile` は無視して取り除きます。
- `tools/list` の応答には、対象ツールの `inputSchema.properties.aws_profile`（`{type: "string", description}`。`enum` は持たず、`description` にも既定値やプロファイル名は入れません）を注入し、あわせて `list_aws_profiles` ツールを追加します（`tools/list` のページングで 2 ページ目以降には追加しません）。クライアント（Claude など）は `list_aws_profiles` を呼んで、使えるプロファイルを実行時に取得します。このツールは認証後に Worker が自分で応答し、`{default, profiles: [{name, description?}]}` を返します（`roleArn` は含めません）。注入するスキーマはプロファイル一覧に依存しないので、プロファイルを追加するだけなら MCP Server Portal の再同期も claude.ai の再接続も要りません。再同期・再接続が要るのは、上流のツール構成が変わったとき、または awsbridge の更新で注入するスキーマが変わったときです（`enum` を外して `list_aws_profiles` を追加した更新を取り込む初回を含みます）。上流が既に `aws_profile` を持つツールは注入しません。応答を加工できないときは原文のまま返します。
- `aws_profile` は上流へ送る前に取り除きます。単一の `tools/call` では、一覧にない名前（`unknown_aws_profile`）も文字列以外（`invalid_aws_profile`）も、HTTP 200 の JSON-RPC 結果 `isError: true` で返します。本文にエラーコード・使えるプロファイル名・既定のプロファイルを含むので、クライアントは 1 回で直せます。JSON-RPC バッチのときは 400 `{"error": "<code>"}` です。
- JSON-RPC バッチは、対象ツールの `aws_profile` がすべて同じ（省略は `default`）ならそのロールで中継し、異なれば 400 `batch_not_supported`。
- 一覧が不正（形式エラー・重複・空など）なら 500 `server_misconfigured`（ログには `config: invalid profiles: <種別>` だけを出し、設定値は出しません）。未設定はビルドの失敗になります。
- STS の `RoleSessionName` は `gw-<利用者>-<プロファイル名>` です（CloudTrail で見分けられます）。

下流リポジトリは上流の `wrangler.jsonc` を編集せず、自分の `wrangler.<name>.jsonc` の `alias` で自前の JSON（例 `deploy/profiles.json`）に向けます（「下流リポジトリでの運用」参照）。詳細は `docs/specs/architecture.md` の「マルチアカウント（aws_profile）」を参照してください。

### 既存デプロイからの移行（`AWS_PROFILES` の廃止）

以前は `AWS_PROFILES` を vars または secret（`mise.local.toml` の `AWSBRIDGE_PROFILES`）で渡していました。`AWS_PROFILES` は廃止したので、次の手順で移します。

```
# 上流の開発用デプロイ: mise.local.toml の AWSBRIDGE_PROFILES（JSON 文字列）の中身を config/profiles.json に書く
cp config/profiles.example.json config/profiles.json   # 中身を自分の一覧に置き換える。mise.local.toml の AWSBRIDGE_PROFILES は削除
# 下流リポジトリ: wrangler.<name>.jsonc の vars.AWS_PROFILES を deploy/profiles.json に移し、vars を消して alias を足す
mise run deploy:worker
# 不要になった Worker secret を消す（secret で持っていた場合のみ。--config / --env は使っていた設定に合わせる）
bash scripts/wrangler.sh secret delete AWS_PROFILES
```

`AWS_PROFILES` の vars / secret が残っていても Worker は読みません（無視されます）。ただし secret は Worker に残り続けるので、`secret delete` で消してください。

### 移行（既定のロール名の変更とデバッグロールの縮小）

既定のロール名を `FederatedMcpReadOnly` → `FederatedAwsBridgeMcpViewer`、`FederatedMcpDebug` → `FederatedAwsBridgeMcpDebugger` に変えました。短い期間だけ既定が `FederatedMcpViewer` / `FederatedMcpDebugger` だったことがあり、そのスタックでも同じ移行になります（パラメーター名 `ReadOnlyRoleName` / `DebugRoleName`、出力 `ReadOnlyRoleArn` / `DebugRoleArn`、環境変数 `AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME` は変わりません）。

- **旧名が保たれるのは、既存スタックを `scripts/deploy-aws.sh` で更新し、名前を指定しない場合だけです。** `scripts/deploy-aws.sh`（`mise run deploy:aws`）は `aws cloudformation deploy` を使い、ロール名は環境変数を設定したときだけ渡します。既存スタックでは、渡さないパラメーターにスタックの既存の値が使われます。次の場合はロールが置き換えられ、`roleArn` と一意 ID が変わります: (1) `AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME` で新しい名前を指定した（新しい名前に移るときはこれ）。(2) `deploy:aws` 以外で流した（マネジメントコンソール、`UsePreviousValue` を付けない `create-change-set` / `update-stack`、StackSets など。指定しないパラメーターにテンプレートの既定値、つまり新しい名前が使われることがあります）。(3) スタックを削除して作り直した。
- **移行の前に、変更を下見してください。** `scripts/deploy-aws.sh` と同じ引数に `--no-execute-changeset` を付けて `aws cloudformation deploy` を実行し、`aws cloudformation describe-change-set --stack-name <スタック> --change-set-name <名前> --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]'` で、`ReadOnlyRole` / `DebugRole` に `Replacement: True` が出ないか確かめます。変更セットは実行しなければ何も変わりません。確かめたら `aws cloudformation delete-change-set` で削除してください。
- **移行の前に、旧ロールの ARN を参照しているものを確かめてください:** KMS のキーポリシー、S3 のバケットポリシー、SCP、ほかのロールの信頼ポリシーなど。旧 ARN を書いたポリシーは新しいロールには当たりません。リソースポリシーの `Principal` に書いたロールは一意 ID で保存されるので、置き換えのあとは同じ名前のロールでも信頼は戻りません。これらのポリシーを直してください。
- **OIDC プロバイダーの削除や信頼ポリシーの変更では、発行済みの STS 認証情報は失効しません。** 旧ロールのセッションは有効期限まで残ります（Worker が求める長さは 900 秒。上限はロールの `MaxSessionDuration`、既定 3600 秒）。すぐに止めたいなら、削除の前に旧ロールでセッションの失効（IAM の「アクティブなセッションを取り消す」）をかけてください。
- **削除の完了は CloudFormation の結果だけでなく、IAM の実体で確かめてください。** スタックを削除したら、対象のアカウントすべてで、ロールと OIDC プロバイダーが実際に消えたことを確かめます。
- **デバッグロールで秘密値を API で読めなくなりました。** `SecretRead`（`secretsmanager:GetSecretValue`、`ssm:GetParameter*`）と `SecretDecrypt`（`kms:Decrypt`）を削除し、両ロールでこれらの取得を条件なしで Deny します。これは非互換の変更で、`DebugAdditionalPolicyArns` で追加ポリシーを付けても戻せません（明示 Deny が優先します）。ロール名を変えるかどうかに関係なく、スタックを更新すると効きます。

#### 同じスタックで改名する（切り替えの間 MCP は失敗する）

1. 新しい名前でスタックを更新する: `AWSBRIDGE_READONLY_ROLE_NAME=FederatedAwsBridgeMcpViewer AWSBRIDGE_DEBUG_ROLE_NAME=FederatedAwsBridgeMcpDebugger AWS_PROFILE=<対象> mise run deploy:aws`。新しい出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える
2. プロファイル一覧（`config/profiles.json`、下流なら `deploy/profiles.json`）の `roleArn` を更新する
3. Worker をデプロイする: `mise run deploy:worker`
4. 両ロールで確かめる（読み取り専用とデバッグのプロファイルでそれぞれツールを呼ぶ）

手順 1 から手順 3 が終わるまで、MCP の呼び出しは失敗します（プロファイル一覧が、もう無い旧 ARN を指しているため）。

#### 別スタックで並行稼働する（issuer の URL も変える場合）

issuer の URL（Worker の公開 URL）も変えるなら、新しいスタックを旧スタックと並べて動かし、停止時間をほぼ無くして切り替えられます。issuer の URL（`AWSBRIDGE_ISSUER`）・スタック名（`AWSBRIDGE_STACK_NAME`）・ロール名（`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`）の 3 つをすべて旧と違う値にしてください。IAM の OIDC プロバイダーは URL ごとに 1 つで、ロール名はアカウント内で一意なので、どれかが同じだと並行できません。上流のコードの変更は要りません（どれもパラメーター化済みです）。

始める前に決めること:

- **旧スタックの削除は移行の一部です。期限を決めてください。** 旧スタックを削除するまで旧デバッグロールは `SecretRead` を持ったまま残るので、それまでは「秘密値を API で直接読めなくする」が効いていません。
- **署名鍵を新旧で同じにするか分けるか。** 同じにすると、鍵が漏れたとき旧スタックを削除するまで旧ロール（秘密値を読める旧デバッグロールを含む）にも届くので、上の期限が特に重要です。分けるなら、`AWSBRIDGE_KEY_FILE` を新しいファイルに向けて `mise run keygen` で新しい鍵を作ります。鍵を更新する機会になります（既存の手順は「署名鍵のローテーション」を参照）。
- **URL が変わると、Cloudflare Access のアプリ（AUD）と MCP クライアントの接続先も変わります。** 新しいホストも Access のアプリと `/.well-known/*` の bypass で保護し（`infra/cloudflare` を参照）、新しい Worker の `ACCESS_AUD`（`AWSBRIDGE_ACCESS_AUD`）を新しいアプリの AUD にしてください。Worker は `ACCESS_AUD` で Access の JWT を自分でも検証するので、Access を通らずに届いた要求（別のホスト・Preview URL）は 401 になります。新しいホストでもこれを確かめてください（例: Access を通さない `/mcp` が 401 になる）。新しい URL がカスタムドメインなら、workers.dev の URL と Preview URL を閉じることも検討してください。

手順（Worker が先です。初回と同じく、IAM は OIDC プロバイダーを作るときに issuer の `/.well-known/openid-configuration` を読みます）:

1. 新しい URL で応答する別名の Worker を、`ISSUER` = 新しい URL でデプロイする（例: `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` で別の wrangler 設定を使い、`AWSBRIDGE_ISSUER` を新しい URL にする。`mise run deploy:worker` は `ISSUER` の指定とプロファイル一覧のバンドルを同じデプロイで行う）。STS は issuer の URL からディスカバリーと JWKS を取りに来て、ディスカバリーの issuer は Worker の `ISSUER` です。Worker は `ISSUER` を 1 つしか持たないので、旧 Worker は新しい issuer を出せません。並行稼働にはこの別名の Worker が要ります。この時点のプロファイル一覧は、初回と同じくダミーでかまいません
2. 新しい `AWSBRIDGE_ISSUER`・`AWSBRIDGE_STACK_NAME`・ロール名を設定して、`mise run deploy:aws` で新しいスタックを作る。対象のアカウントすべてで行う
3. 新しい Worker のプロファイル一覧に新しい `roleArn` を書き、もう一度デプロイする
4. クライアントを切り替える前に、新しいロールを 1 回引き受けられることを確かめる: `AWSBRIDGE_ISSUER=<新しい URL> AWSBRIDGE_STACK_NAME=<新スタック> AWS_PROFILE=<対象> mise run poc:sts`（`AWSBRIDGE_KEY_FILE` の鍵で JWT に署名する。新しい URL の Worker と同じ鍵にする。デバッグロールは `--role-arn <DebugRoleArn>` を渡す）
5. MCP クライアントの接続先を新しい URL に変える。Worker の URL は MCP の接続先でもあるので、クライアント側の再設定と再認可が要ります
6. 両ロールで確かめる
7. 期限までに、すべてのアカウントで旧スタックを削除する（`AWSBRIDGE_STACK_NAME=<旧スタック> AWS_PROFILE=<対象> mise run destroy:aws`）。旧の OIDC プロバイダーとロールが消えます。すべてのアカウントで、IAM 上で消えたことを確かめる
8. すべてのアカウントで旧の OIDC プロバイダーが消えてから、旧 Worker を片付け、旧ホスト名を手放す。逆の順にすると、手放したホスト名（特に workers.dev のサブドメイン）を第三者が取ったとき、残ったプロバイダーがそれを発行者として信頼してしまいます

この方法なら、切り替える前に旧と新を並べて確かめられます。別名の Worker を使わない場合は並行稼働になりません。Worker の `ISSUER` を新しい URL に移してからでないと新しいスタックを作れず、その後、新しいスタックと新しい `roleArn` をデプロイし終えるまで MCP の呼び出しは失敗します（旧ロールは Worker の JWT を受け付けなくなるため）。その方法を取るなら、切り戻しの手順（旧の `ISSUER` と旧の `roleArn` で Worker を再デプロイする。新しい側が動くまで旧スタックは残す）を先に用意してください。

## コンソールログインの Standard の署名鍵

コンソールログインの Standard の Worker（`wrangler.console-standard.jsonc`）は、境界（`managed`・`partner:<id>`）ごとに、Workers の `secret_key` 型のバインディング（取り出せない `CryptoKey`。RSASSA-PKCS1-v1_5 / SHA-256、usages は `sign` だけ）で STS に渡す JWT に署名します。仕組みは Admin の署名鍵と同じで、鍵・トークン・Worker は Admin と別です。文字列の秘密鍵 JWK を secret に入れる形は使いません。

- 鍵は `mise run console:standard-key:put -- --boundary <境界>` が手元のメモリの中で作り、Cloudflare API で入れます。ファイルに書かず、出力もしません。CI やログを通しません。実行するのは人で、手元からだけです。
- バインディングの名前は `STANDARD_KEY_<kid の先頭 8 バイトの 16 進>` で、kid から決まります（境界の名前は入りません）。道具は同じ名前への投入を断ります。差し替えは必ず別の名前で入れます。
- Worker は vars の `STANDARD_CURRENT_KEYS`（境界 → 今の鍵の名前と kid）と `STANDARD_PUBLIC_JWKS`（境界 → 公開鍵。新旧 2 つまで）を読みます。どちらかが空・壊れている、今の kid がその境界の公開鍵に無い、同じ鍵が 2 つの境界にある、ときはどの経路も `500 server_misconfigured` です。署名の前にその境界のバインディングを確かめ（`CryptoKey`・取り出せない・`sign` だけ・`exportKey` が失敗する）、署名した JWT を vars の公開鍵で確かめます。合わなければその境界の発行は `503 signing_unavailable` です。境界の issuer の JWKS は、その境界の vars の公開鍵だけを出します。
- 鍵を入れるまで（vars が空のあいだ）は、どの経路も `500` です。初回は「Worker をデプロイ → 鍵と CSRF の鍵を入れる → vars を書いてデプロイ」の順にします。
- CSRF の鍵 `CONSOLE_CSRF_KEY` は `secret_text` のままです。`mise run console:secrets:standard -- --yes` が 32 バイトの乱数を手元で作って入れます（ファイルに書かず、表示しません）。作り直すと、開いている画面のフォームは開き直しが要ります。
- トークン: `AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN` には Standard の Worker だけを書けるトークンを使い、Admin 用のトークンと分けます（無ければ `wrangler login` の OAuth をメモリの中だけで使います）。道具は Admin 用の変数を読みません。鍵を取り出せなくても、Worker のコードや secret を書き換えられる人は任意の JWT に署名できます。
- 更新の経路: `secret_key` のバインディングは、`wrangler deploy`、別の secret を更新する `wrangler secret put`・`wrangler secret bulk`・`wrangler secret delete`、`wrangler versions secret put / bulk` → `versions deploy` のあとも残ることを開発環境で確かめました（PoC X1-(h)）。ダッシュボードや Terraform で Worker のバインディングを管理する経路は測っていないので使いません。
- 変数（`mise.local.toml`）: `AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID`（または wrangler の設定の `account_id`）、`AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN`（任意）、`AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG`（既定 `wrangler.console-standard.jsonc`）、`AWSBRIDGE_CONSOLE_STANDARD_ACCESS_TOKEN`（任意。`check` の key-check に使う Access のトークン）。

バンドルの確認と手元の起動（どちらもデプロイしない。先に `mise run console:config:generate` が要る。wrangler の設定は `AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG`、既定 `wrangler.console-standard.jsonc`。MCP 用の `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` は読まない）:

```bash
mise run console:build:standard   # wrangler deploy --dry-run --outdir dist/console-standard（鍵の vars が空でもバンドルできる）
mise run console:dev              # wrangler dev（手元用。secret_key のバインディングは作れないので、鍵の vars が空なら全経路 500）
# デプロイは承認したあと手で行う（routes と vars を先に確かめる）
#   例: AWSBRIDGE_WRANGLER_CONFIG=wrangler.console-standard.jsonc AWSBRIDGE_WRANGLER_ENV= bash scripts/wrangler.sh deploy
```

初回の投入（境界ごと）:

```bash
mise run console:standard-key:put -- --boundary managed            # 何をするかの表示だけ（API を呼ばない）
mise run console:standard-key:put -- --boundary managed --yes      # 鍵を作って secret_key として入れる。名前・kid・公開鍵と、次に入れる vars を表示する
# put は wrangler の設定の vars を読んで、その境界だけを入れ替えた vars を表示する。
# 次の境界へ進む前に、表示された STANDARD_PUBLIC_JWKS と STANDARD_CURRENT_KEYS を wrangler の設定の vars に書く（書かずに続けると前の境界が抜ける）
mise run console:standard-key:put -- --boundary partner:partner-x --yes
# 同じく、表示された vars を wrangler の設定に書く
mise run console:secrets:standard -- --yes                         # CSRF の鍵（secret_text）
# vars をすべての境界で書いたらデプロイする
mise run console:standard-key:check     # 境界ごとのバインディングの型・discovery と JWKS・key-check（取り出せない・exportKey が失敗する・自己検証）
```

差し替え（境界ごと。90 日以下を目安に。侵害の疑いがあれば必ず替え、旧い kid を外す）:

```bash
mise run console:standard-key:put -- --boundary managed --yes      # 1. 新しい鍵を別の名前で入れる
# 2. vars STANDARD_PUBLIC_JWKS のその境界を新旧 2 つにしてデプロイする（JWKS に並べる）
# ── 最低 1 時間（安全側に 24 時間）待つ: STS の JWKS キャッシュが切れるまで ──
# 3. vars STANDARD_CURRENT_KEYS のその境界を新しい鍵にしてデプロイし、mise run console:standard-key:check
# 4. JWT の有効期限（5 分）より長く待ってから、旧い公開鍵を STANDARD_PUBLIC_JWKS から外してデプロイする
mise run console:standard-key:retire -- --binding STANDARD_KEY_<旧い鍵> --yes   # 5. 旧い鍵を消す（今の鍵・vars と JWKS に残る鍵・CSRF の鍵は断る）
```

## コンソールログインの Admin の署名鍵

コンソールログインの Admin の Worker（`wrangler.console-admin.jsonc`）は、Workers の `secret_key` 型のバインディング（取り出せない `CryptoKey`。RSASSA-PKCS1-v1_5 / SHA-256、usages は `sign` だけ）で STS に渡す JWT に署名します。Standard の Worker とは別の Worker・別の issuer・別の鍵・別のホストです。

- 鍵は `mise run console:admin-key:put` が手元のメモリの中で作り、Cloudflare API で入れます。ファイルに書かず、出力もしません。CI やログを通しません。実行するのは人で、手元からだけです。wrangler には `secret_key` を入れるコマンドがありません。
- バインディングの名前は `ADMIN_KEY_<kid の先頭 8 バイトの 16 進>` で、kid から決まります。同じ名前に入れると今の鍵が即座に置き換わるので、道具は同じ名前への投入を断ります。差し替えは必ず別の名前で入れます。
- Worker は vars の `ADMIN_CURRENT_KEY`（今の鍵の名前と kid）と `ADMIN_PUBLIC_JWKS`（公開鍵。新旧 2 つまで）を読みます。署名の前にバインディングを確かめ（`CryptoKey`・取り出せない・`sign` だけ・`exportKey` が失敗する）、署名した JWT を vars の公開鍵で確かめます。合わなければ発行せず `503 signing_unavailable` を返します。Admin の issuer の discovery と JWKS は、Admin の issuer のホスト（Standard の issuer・ポータルと別のホスト）の `/admin` で同じ Worker が出します。
- トークン: `AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN` には Admin の Worker だけを書けるトークンを使い、Standard の Worker のデプロイや secret に使うトークンと分けます（無ければ `wrangler login` の OAuth をメモリの中だけで使います）。鍵を取り出せなくても、Worker のコードや secret を書き換えられる人は任意の JWT に署名できます。Cloudflare のアカウントの権限を絞り、Admin のデプロイは Standard と別のトークンで承認を付けて行います。
- 変数（`mise.local.toml`）: `AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID`（または wrangler の設定の `account_id`）、`AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN`（任意）、`AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG`（既定 `wrangler.console-admin.jsonc`）、`AWSBRIDGE_CONSOLE_ADMIN_ACCESS_TOKEN`（任意。`check` の key-check に使う Access のトークン）。

初回の投入:

```bash
mise run console:admin-key:put              # 何をするかの表示だけ（API を呼ばない）
mise run console:admin-key:put -- --yes     # 鍵を作って secret_key として入れる。名前・kid・公開鍵と、次に入れる vars を表示する
# 表示された ADMIN_PUBLIC_JWKS と ADMIN_CURRENT_KEY を wrangler の設定の vars に書いてデプロイする
mise run console:admin-key:check            # バインディングの型・discovery と JWKS・key-check（取り出せない・exportKey が失敗する・自己検証）
```

差し替え（90 日以下を目安に。侵害の疑いがあれば必ず替え、旧い kid を外す）:

```bash
mise run console:admin-key:put -- --yes     # 1. 新しい鍵を別の名前で入れる
# 2. vars ADMIN_PUBLIC_JWKS を新旧 2 つにしてデプロイする（JWKS に並べる）
# ── 最低 1 時間（安全側に 24 時間）待つ: STS の JWKS キャッシュが切れるまで（長さは公開されておらず未測定） ──
# 3. vars ADMIN_CURRENT_KEY を新しい鍵にしてデプロイし、mise run console:admin-key:check
# 4. JWT の有効期限（5 分）より長く待ってから、旧い公開鍵を ADMIN_PUBLIC_JWKS から外してデプロイする
mise run console:admin-key:retire -- --binding ADMIN_KEY_<旧い鍵> --yes   # 5. 旧い鍵を消す（今の鍵・JWKS に残る鍵は断る）
```

発行を止めるときは、JWKS から kid を外してデプロイするか、vars `LOGIN_DISABLED` を `true` にします。

## コンソールログインの 1 人停止

1 人だけを止めるときは、その人の SourceIdentity（既定は email）を、コンソールログイン用のロールのインラインポリシーの予約名 `AwsbridgeConsoleDenySourceIdentity` に Deny として書きます（`aws:SourceIdentity` が一致するセッションの全操作の Deny。設計は `docs/specs/console-login.md` §6.3）。書くのは停止の道具です。

- 停止の一覧は検査の `--stops` と同じ形のファイル（`{ "sourceIdentities": ["..."] }`）で、これが「止めている一覧」の正本です。**email を含むので、`.secrets/` か下流のリポジトリに置き、公開リポジトリにコミットしません。**
- `console:stop:apply` は、対象の全ロールの予約名の中身をファイルの一覧に合わせます。対象は、設定のロール（アカウントにあるもの）、`/awsbridge-console/` のパスのロール、パスの外でコンソールのプロバイダーを信頼する設定に無いロール（計画の表示で「設定に無いロール」と出ます）です。
- `--yes` が無ければ計画の表示だけです。ただし今の状態との差を出すため、IAM の読み取りと `sts get-caller-identity` は呼びます（Admin の鍵の道具の「`--yes` なしは API を使わない」とは違います）。書き込みは `iam put-role-policy` と `iam delete-role-policy` の 2 種類だけです。
- `--allow-remove` が無ければ足すだけです。各ロールの予約名を「今の値とファイルの値を合わせたもの」にします。ファイルに無い値がロールに残っていても消さず、件数だけを余分（`EXTRA`）として表示します。余分があるだけなら終了コードは 0 です。足す値が 1 つも無く外す値だけがある実行（解除だけ）は、`--allow-remove` が無ければ何も書かずに終了コード 2 で止まります。
- `--allow-remove` を付けると、ファイルの一覧にそろえます（停止の解除）。全ロールに足し終えてから外すので、外す側の失敗が足す側を止めません。§6.3 の解除の条件（そのロールの `MaxSessionDuration` が切れるまで外さない、原因の除去、古い鍵の排除、新規の発行ができないことの確認）を表示します。道具はこれらを確かめられないので、人が確かめます。設定に無いロールからも外します。
- どちらでも 1 つのロールのために全体を止めません。予約名に停止の形でない文書があるロール・インラインの合計が 10,240 文字を超えるロール・書き込みに失敗したロールは書かずに報告し、ほかのロールには書いて、終了コード 1 で終わります。
- `--reason` は必須です。実行の結果を 1 行の JSON（時刻・アカウントの末尾 4 桁・ロール・件数の変化・理由。値は入れません）で標準出力に出すので、運用者が保管します。出力に email の値と全桁のアカウント ID は出しません。
- コンソール用のロール（設定のロール名か `/awsbridge-console/` のパス）のセッションからは実行しません（守りの部品が書き込みを Deny するため）。IAM Identity Center など別の入口から実行します。

```bash
mise run console:stop:show -- --profile=<p> --stops=.secrets/console-stops.json      # 読み取りだけ。ロールごとの件数と、足りない・余分
mise run console:stop:apply -- --profile=<p> --stops=.secrets/console-stops.json --reason="<理由>"         # 計画の表示
mise run console:stop:apply -- --profile=<p> --stops=.secrets/console-stops.json --reason="<理由>" --yes   # 書き込む
mise run console:inspect -- --profile=<p> --stops=.secrets/console-stops.json        # 書いたあと、設定のロールを確かめる
```

`console:inspect --stops` が確かめるのは設定のロールです。設定に無いロールとパスの外のロールは、停止の道具が書いたあとの読み直しで確かめます（結果は道具の出力の表）。

終了コード: 0 書き終えた（または変更なし。余分が残るだけなら 0）/ 1 書けなかったロールがある / 2 実行しなかった（入力の誤り・読み取りの失敗・呼び出し元・`--allow-remove` が無い解除だけの実行）。

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

2. `wrangler.<name>.jsonc` を足す（コミットする。ロール ARN は秘密ではない）。`main` などは上流の `wrangler.jsonc` と同じ値にし、`name` / `workers_dev` / `alias` だけ自分用にします。`alias` で、プロファイル一覧の JSON（手順 2 の次に作る `deploy/profiles.json`）をモジュール `awsbridge:profiles` として差し替えます。env セクションは使いません（値はダミーです）。

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "awsbridge-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": true,
  "alias": { "awsbridge:profiles": "./deploy/profiles.json" }
}
```

   `deploy/profiles.json` の形式は上の「マルチアカウント」の JSON と同じです（コミットする。ロール ARN は秘密ではない）。上流の `config/profiles.example.json` をコピーして書き換えると早いです。

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

4. 秘密値と環境固有値を `mise.local.toml`（gitignore。コミットしない）に書く。`AWSBRIDGE_ISSUER`（Worker の URL）、`AWSBRIDGE_ALLOWED_SUBJECTS`、`AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS`、`AWSBRIDGE_ACCESS_TEAM_DOMAIN`、`AWSBRIDGE_ACCESS_AUD` など（上の「`mise.local.toml` の変数」を参照）。プロファイル一覧は `mise.local.toml` ではなく `deploy/profiles.json` に置きます。

5. デプロイする（初回）。

```
mise run keygen          # AWSBRIDGE_KEY_FILE に署名鍵を生成
mise run deploy:worker   # wrangler.<name>.jsonc で Worker をデプロイ → secrets を登録
AWS_PROFILE=<対象> mise run deploy:aws   # アカウントごとに CloudFormation を流し、出力 ReadOnlyRoleArn / DebugRoleArn を deploy/profiles.json に書く
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
