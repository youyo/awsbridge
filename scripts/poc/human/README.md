# PoC: awsbridge 方式で人間が AWS にログインできるか

awsbridge の方式（自前の OIDC issuer → 各アカウントの IAM OIDC プロバイダー → `AssumeRoleWithWebIdentity`）を、
MCP だけでなく人間の AWS ログインにも使えるかを確かめる。確かめることは 2 つ。

- **PoC-A**: `AssumeRoleWithWebIdentity` で得た一時認証情報（長期認証情報は使わない）から、
  Federation エンドポイント（`https://signin.aws.amazon.com/federation` の `Action=getSigninToken` → `Action=login`）で
  コンソールのログイン URL を作れるか。`SessionDuration` は指定なしと指定あり（43200 秒 = 12 時間を狙う）の両方を試す
- **PoC-B**: その URL で入ったコンソールのセッションから、`aws login`（AWS CLI 2.32 以降）で CLI の認証情報を取れるか

## 構成（MCP 経路とは分ける）

```
手元（scripts/poc/human/*.ts）            Cloudflare（workers.dev）              AWS（PoC 用スタック）
  署名鍵 .secrets/poc-human/      ─公開鍵→  Worker awsbridge-human-poc            IAM OIDC プロバイダー（issuer = Worker の URL）
  JWT を署名 ──────────────────────────────────────────────────────────────→  STS AssumeRoleWithWebIdentity（署名なし）
                                           /.well-known/openid-configuration      ロール AwsbridgeHumanPoc
                                           /.well-known/jwks.json（静的）         （ReadOnlyAccess + SignInLocalDevelopmentAccess）
  一時認証情報 → getSigninToken → ログイン URL（.secrets/poc-human/、権限 600）
```

| 項目 | MCP 経路 | この PoC |
|---|---|---|
| issuer | Worker `awsbridge`（署名もする） | Worker `awsbridge-human-poc`（discovery と JWKS を静的に返すだけ。署名しない） |
| 署名鍵 | `.secrets/dev-signing-key.json` | `.secrets/poc-human/signing-key.json`（手元で署名） |
| audience | `awsbridge` | `awsbridge-human-poc` |
| ロール | `FederatedMcpReadOnly` / `FederatedMcpDebug` | `AwsbridgeHumanPoc`（1 つ。利用者 1 人） |
| CloudFormation | `infra/aws/awsbridge.yaml`（スタック `awsbridge`） | `scripts/poc/human/poc-human.yaml`（スタック `awsbridge-human-poc`） |
| 設定 | `AWSBRIDGE_*` | `AWSBRIDGE_HUMAN_POC_*` だけ（MCP 用の変数は読まない） |

ファイル:

- `lib.ts`: 純粋関数（JWT の claim、discovery / JWKS、STS のパラメーター、Federation の URL）。テストは `test/unit/poc-human-*.test.ts`
- `worker.ts` / `worker-handler.ts` / `wrangler.jsonc`: PoC 用 issuer Worker。E2E は `test/e2e/poc-human-issuer.test.ts`
- `keygen.ts` / `deploy-issuer.ts` / `deploy-aws.sh` / `console-url.ts` / `destroy.sh`: 手順（mise タスクから呼ぶ）
- `poc-human.yaml`: IAM OIDC プロバイダーとロール（`mise run lint` の cfn-lint 対象）

## 前提

- `mise install` 済み（`mise run install` で依存パッケージも入れる）
- AWS CLI 2.32.0 以降（`aws login` に必要。手元は 2.39.6）
- デプロイ先アカウントの AWS プロファイル（既定 `awsbridge`）が使えること。例: `aws login --profile awsbridge`
  （CloudFormation で IAM のロールと OIDC プロバイダーを作れる権限が要る）
- `pnpm exec wrangler login` 済み（`awsbridge-human-poc` を workers.dev にデプロイできる Cloudflare アカウント）
- `mise.local.toml`（gitignore）に次を書く。値はリポジトリに入れない

```toml
[env]
# PoC Worker の URL（= OIDC issuer）。workers.dev のサブドメインは MCP 用 Worker と同じアカウントのもの
AWSBRIDGE_HUMAN_POC_ISSUER  = "https://awsbridge-human-poc.<subdomain>.workers.dev"
# PoC 利用者 1 人（JWT の sub。信頼ポリシーで StringEquals 照合。小文字にそろえる）
AWSBRIDGE_HUMAN_POC_SUBJECT = "user@example.com"
```

上書きできる既定値（スクリプト側で補う。`mise.toml` の `[env]` には置かない）:

| 変数 | 既定値 |
|---|---|
| `AWS_PROFILE` | `awsbridge` |
| `AWS_REGION` | `ap-northeast-1` |
| `AWSBRIDGE_HUMAN_POC_AUDIENCE` | `awsbridge-human-poc` |
| `AWSBRIDGE_HUMAN_POC_STACK_NAME` | `awsbridge-human-poc` |
| `AWSBRIDGE_HUMAN_POC_ROLE_NAME` | （テンプレートの既定 `AwsbridgeHumanPoc`） |
| `AWSBRIDGE_HUMAN_POC_OUT_DIR` | `.secrets/poc-human`（鍵・issuer の文書・ログイン URL・認証情報の置き場所） |
| `AWSBRIDGE_HUMAN_POC_KEY_FILE` | `<OUT_DIR>/signing-key.json` |

## 実行順

```sh
mise run poc:human:keygen          # 1. 専用の署名鍵を生成（既存なら上書きしない）
mise run poc:human:deploy-issuer   # 2. Worker awsbridge-human-poc をデプロイし、公開された discovery / JWKS を手元と照合（[OK] が 2 行）
mise run poc:human:deploy-aws      # 3. CloudFormation（OIDC プロバイダー + ロール）をデプロイ。Outputs の RoleArn を確認
mise run poc:human:console-url     # 4. PoC-A（DurationSeconds 指定なし）
mise run poc:human:console-url -- --duration-seconds 43200   # 4'. PoC-A（DurationSeconds=43200）
#                                    5. PoC-B（下の手順）
mise run poc:human:destroy         # 6. 片付け
```

- 2 は AWS を呼ばない。3 は Cloudflare を呼ばない。`mise run poc:human:deploy-issuer -- --dry-run` ならバンドルだけ確認できる
- 2 の照合が `[NG]` なら、デプロイ時に表示された URL と `AWSBRIDGE_HUMAN_POC_ISSUER` が同じか確かめる（違えば直して 2 からやり直す）。
  照合だけやり直すときは `mise run poc:human:deploy-issuer -- --check-only`
- issuer を変えたら 3 もやり直す（OIDC プロバイダーの URL が変わるため）

## PoC-A: コンソールのログイン URL

`mise run poc:human:console-url` が行うこと:

1. 手元の鍵で JWT（`iss` = issuer、`aud` = `awsbridge-human-poc`、`sub` = 利用者、有効期限 5 分）を署名する
2. STS `AssumeRoleWithWebIdentity`（`https://sts.<region>.amazonaws.com/`、**署名なし**）。`RoleSessionName` は `human-<email>`。
   ロール ARN はスタックの Output `RoleArn`（`--role-arn` で指定も可）。`--duration-seconds` を付けたときだけ `DurationSeconds` を送る
3. 一時認証情報で `getSigninToken` を `SessionDuration` ごとに呼ぶ（既定 `--session-durations none,43200,43199`）
4. `Action=login` のログイン URL（`Destination` は `<region>` のコンソール）を
   `<OUT_DIR>/console-url-dur-<DurationSeconds|default>-sd-<SessionDuration|none>.txt` に書く。
   失敗した条件のファイルは消す（前の回の URL を開いて「入れた」と誤認しないため）

標準出力には各段の成否（HTTP ステータス・エラーの要約・`Expiration`・ファイルのパス）だけが出る。URL と認証情報（`<OUT_DIR>/credentials.json`）は
権限 600 のファイルにだけ書く。**画面共有・チャット・Issue に貼らない**。

`43199` も試す理由: AWS の文書には「`SessionDuration` はロールの最大セッション時間以上にできない」とある
（例: 最大 5 時間なら 4 時間 59 分）。ロールの `MaxSessionDuration` は上限の 43200 なので、43200 が失敗した場合に、
この制約によるものか WebIdentity 由来の認証情報によるものかを 43199 で切り分ける。

`getSigninToken` は既定で GET で呼ぶ（文書が `SessionDuration` の説明を GET 前提で書いているため）。POST で比べるなら
`-- --federation-method post`。

### ブラウザでの確認

- URL は**発行から 15 分**で使えなくなる。期限切れなら `console-url` をやり直す
- URL ごとに別のブラウザプロファイル（またはシークレットウィンドウ）で開く。同じプロファイルで続けて開くとセッションが混ざる
- 開き方の例（macOS。URL を画面に出さない）: `open "$(cat .secrets/poc-human/console-url-dur-default-sd-none.txt)"`

確認すること:

1. コンソールが開き、右上のアカウント表示が `AwsbridgeHumanPoc/human-<email>`（フェデレーテッドユーザー / 引き受けたロール）になっている
2. 読み取り操作（例: IAM のロール一覧、S3 のバケット一覧）ができ、書き込み操作（例: S3 バケットの作成）は拒否される
3. セッションの長さ: `sd-none` の URL は認証情報の期限（STS の既定 1 時間、または `--duration-seconds`）で切れるはず。
   `sd-43200` / `sd-43199` の URL は 1 時間を超えて使えるはず。65〜70 分後に同じタブでページを再読み込みし、ログイン状態が続いているかで判定する

### 判定基準（PoC-A）

| 判定 | 条件 |
|---|---|
| 成立 | `DurationSeconds` 指定なしで、`none` と `43200`（または `43199`）の両方で URL ができ、ログインでき、`43200`/`43199` のセッションが 1 時間を超えて続く |
| 部分的に成立 | `none` では入れるが、`SessionDuration` を付けると `getSigninToken` が失敗する、またはセッションが 1 時間で切れる（= コンソールは 1 時間まで） |
| 不成立 | `none` でも `getSigninToken` が失敗する、または URL でコンソールに入れない |

`--duration-seconds 43200` の回は、AWS の文書の「`AssumeRole*` で `DurationSeconds` を使うなら長期認証情報の IAM ユーザーとして呼べ。
さもないと Federation の呼び出しが失敗する」が `AssumeRoleWithWebIdentity` にも当てはまるかを確かめる回。
`getSigninToken` が失敗すれば当てはまる、成功すれば当てはまらない、と記録する。

## PoC-B: コンソールのセッションから `aws login`

PoC-A で開いたコンソール（フェデレーションでログインしたセッション）が**有効なブラウザプロファイル**で行う。
既存の設定・キャッシュを汚さないよう、一時的な設定ファイルと専用プロファイルを使う。

```sh
export POC_B_DIR="$(mktemp -d)"
export AWS_CONFIG_FILE="$POC_B_DIR/config"
export AWS_SHARED_CREDENTIALS_FILE="$POC_B_DIR/credentials"
export AWS_LOGIN_CACHE_DIRECTORY="$POC_B_DIR/login-cache"
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

aws --version                                   # 2.32.0 以降
aws login --profile human-poc --region ap-northeast-1
```

- `aws login` は既定のブラウザで `https://signin.<region>.amazonaws.com/authorize?...` を開く。既定のブラウザが PoC-A のプロファイルでなければ、
  表示された URL を PoC-A のブラウザプロファイルに貼る。それも難しければ `aws login --profile human-poc --region ap-northeast-1 --remote` で
  URL を開き、表示された認可コードを CLI に貼る
- ブラウザでは、表示されたアクティブなセッション一覧から `AwsbridgeHumanPoc/human-<email>` のセッションを選ぶ

確認:

```sh
aws sts get-caller-identity --profile human-poc
# 期待: "Arn": "arn:aws:sts::<account-id>:assumed-role/AwsbridgeHumanPoc/human-user@example.com"
grep login_session "$AWS_CONFIG_FILE"
# 期待: login_session = arn:aws:sts::<account-id>:assumed-role/AwsbridgeHumanPoc/...
aws s3api list-buckets --profile human-poc --query 'length(Buckets)'   # 読み取りができる
```

後片付け（PoC-B）:

```sh
aws logout --profile human-poc
rm -rf "$POC_B_DIR"
unset AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_LOGIN_CACHE_DIRECTORY POC_B_DIR
```

`aws login` に要る権限は、AWS 管理ポリシー `SignInLocalDevelopmentAccess`（`signin:AuthorizeOAuth2Access` と
`signin:CreateOAuth2Token`、リソース `arn:aws:signin:*:*:oauth2/public-client/*`）。ロールに付けてある。出典:

- https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html（前提: CLI 2.32.0 以降、`SignInLocalDevelopmentAccess` を付ける、フェデレーションも対象）
- https://docs.aws.amazon.com/aws-managed-policy/latest/reference/SignInLocalDevelopmentAccess.html（ポリシー本文）
- https://docs.aws.amazon.com/signin/latest/userguide/security-iam-awsmanpol.html（`localhost` は `aws login`、`remote` は `aws login --remote`）

### 判定基準（PoC-B）

| 判定 | 条件 |
|---|---|
| 成立 | `aws login` が成功し、`get-caller-identity` の Arn が `assumed-role/AwsbridgeHumanPoc/...`、読み取りの API が通る |
| 不成立 | ブラウザにフェデレーションのセッションが出ない・選べない、または認可・トークン発行が拒否される（エラーを記録する） |

CLI のセッションの長さ（文書では IAM プリンシパルのセッション時間まで。最大 12 時間）も分かれば記録する。

## 結果の記録

実行日・CLI のバージョン・リージョンと、各ケースの結果を書く（アカウント ID・email・URL は書かない）。

| ケース | STS DurationSeconds | SessionDuration | getSigninToken | コンソールに入れたか | セッションの長さ | メモ |
|---|---|---|---|---|---|---|
| A-1 | 指定なし | なし | 成功 | 未確認（URL のみ生成） | - | |
| A-2 | 指定なし | 43200 | 成功 | 入れた（右上に AwsbridgeHumanPoc/human-<email>） | 12 時間の経過は未観測 | PoC-B の元にしたセッション |
| A-3 | 指定なし | 43199 | 成功 | 未確認（URL のみ生成） | - | |
| A-4 | 43200 | なし | 成功 | 未確認（URL のみ生成） | STS の Expiration は 12 時間後 | |
| A-5 | 43200 | 43200 | 成功 | 未確認（URL のみ生成） | 同上 | |
| A-6 | 43200 | 43199 | 成功 | 未確認（URL のみ生成） | 同上 | |

| ケース | 元のコンソールセッション | `aws login` | get-caller-identity の Arn（アカウント ID は伏せる） | メモ |
|---|---|---|---|---|
| B-1 | A-1 の URL | 未実施 | - | |
| B-2 | A-2 の URL | 成功（`--remote`。ブラウザの「アクティブなセッションで続行」にフェデレーションのセッションが出た） | assumed-role/AwsbridgeHumanPoc/human-<email> | list-buckets は通り、iam:CreateUser は AccessDenied。ログインキャッシュのアクセスキーは 15 分で、更新される |

結論:

- PoC-A: 成立（2026-11-11、CLI 2.39.6、ap-northeast-1）。長期認証情報なしの AssumeRoleWithWebIdentity の認証情報で、SessionDuration=43200 を付けた getSigninToken が通り、コンソールに入れた。実際に 12 時間続くかは観測していない
- PoC-B: 成立。フェデレーションのコンソールセッションから `aws login --remote` で CLI の認証情報を取れた

## 片付け

```sh
mise run poc:human:destroy
```

- CloudFormation スタック（`AWSBRIDGE_HUMAN_POC_STACK_NAME`、既定 `awsbridge-human-poc`）を消し、消えるのを待つ
- Worker `awsbridge-human-poc` を消す（`wrangler delete`。確認を求められたら答える）
- `<OUT_DIR>` のログイン URL（`console-url-*.txt`）と認証情報（`credentials.json`）を消す
- 署名鍵と issuer の文書は残す。PoC を終えたら `rm -rf .secrets/poc-human` で消す
- MCP 用のスタック・Worker・鍵には触らない（MCP 用の変数も読まない）

ロールを消すと、そのロールで開いているコンソールと CLI のセッションも使えなくなる。
