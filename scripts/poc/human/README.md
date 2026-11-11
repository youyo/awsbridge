# PoC: awsbridge 方式で人間が AWS にログインできるか

awsbridge の方式（自前の OIDC issuer → 各アカウントの IAM OIDC プロバイダー → `AssumeRoleWithWebIdentity`）を、
MCP だけでなく人間の AWS ログインにも使えるかを確かめる。確かめることは 2 つ。

- **PoC-A**: `AssumeRoleWithWebIdentity` で得た一時認証情報（長期認証情報は使わない）から、
  Federation エンドポイント（`https://signin.aws.amazon.com/federation` の `Action=getSigninToken` → `Action=login`）で
  コンソールのログイン URL を作れるか。`SessionDuration` は指定なしと指定あり（43200 秒 = 12 時間を狙う）の両方を試す
- **PoC-B**: その URL で入ったコンソールのセッションから、`aws login`（AWS CLI 2.32 以降）で CLI の認証情報を取れるか

続く PoC（手順は後半の「P2〜P4」）:

- **P2 セッションタグでの認可**: JWT のセッションタグ（issuer が計算した単一値 `access_profile`）で、信頼ポリシーの `aws:RequestTag` が許可・拒否を分け、
  引き受け後は権限ポリシーの `aws:PrincipalTag` で権限が変わるか
- **P3 SourceIdentity**: JWT の `https://aws.amazon.com/source_identity` を信頼ポリシーで必須にでき、CloudTrail に残るか
- **P4 緊急停止**: ロールの Revoke Sessions と OIDC プロバイダーの削除で、発行済みの認証情報・コンソール・`aws login` が止まるまでの時間

段階 1 の前のゲートの PoC（N9 パス付き issuer・N1 の M2 パスごとの Access アプリと AUD・N10 Access + Worker の通し経路）は
[portal/README.md](portal/README.md)（ポータル Worker `awsbridge-human-poc-portal`。このページの道具とは別のスタック・Worker・鍵）。

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
- `poc-human.yaml`: IAM OIDC プロバイダーとロール 3 つ（`mise run lint` の cfn-lint 対象）
- P2〜P4: `cases.ts`（ケース表）/ `ops.ts`（revoke ポリシー・ガード・伏せ字）/ `watch.ts`（見張りの集計）/ `trail-lib.ts`（CloudTrail の読み取り）が純粋関数。
  `checks.ts` / `stop-watch.ts` / `revoke.ts` / `trail.ts` が手順。テストは `test/unit/poc-human-{claims,cases,ops,watch,trail,ops-scripts}.test.ts`

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
mise run poc:human:destroy         # 6. 片付け（P2〜P4 をやるなら、その前に後半の「P2〜P4」を済ませる）
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
- `<OUT_DIR>` のログイン URL（`console-url-*.txt`）と認証情報（`credentials*.json`）を消す
- 署名鍵と issuer の文書は残す。PoC を終えたら `rm -rf .secrets/poc-human` で消す
- MCP 用のスタック・Worker・鍵には触らない（MCP 用の変数も読まない）

ロールを消すと、そのロールで開いているコンソールと CLI のセッションも使えなくなる。

P2〜P4 のロール（`AwsbridgeHumanPocTagged` / `AwsbridgeHumanPocNoTag`）もスタックと一緒に消える。`credentials*.json` も消す。
見張りの記録（`stop-watch-*.jsonl`。認証情報は入っていない）は残すので、結果を書き写してから手で消す。

---

# P2〜P4: セッションタグ・SourceIdentity・緊急停止

## 追加したリソース（`poc-human.yaml`）

既存のロール `AwsbridgeHumanPoc` はそのまま残し、ロールを 2 つ足した。名前は `<RoleName>Tagged` / `<RoleName>NoTag`
（`RoleName` は 58 文字まで）。`revoke.ts` は名前が `AwsbridgeHumanPoc` で始まるロールにしか触らないので、`AWSBRIDGE_HUMAN_POC_ROLE_NAME`
で別の名前にしたときは P4 の道具を使えない。

| ロール | 信頼ポリシー（Allow 文 1 つだけ） | 権限 |
|---|---|---|
| `AwsbridgeHumanPoc`（既存） | aud・sub。Action に `TagSession` / `SetSourceIdentity`（条件なし） | ReadOnlyAccess + SignInLocalDevelopmentAccess |
| `AwsbridgeHumanPocTagged` | aud・sub、`aws:RequestTag/access_profile` が `poc-admin` か `poc-viewer`、`ForAllValues:StringEquals aws:TagKeys = [access_profile]`（未知のキーを拒否）、`Null sts:SourceIdentity = false`（SI 必須）。Action は `AssumeRoleWithWebIdentity` / `TagSession` / `SetSourceIdentity` | ReadOnlyAccess + SignInLocalDevelopmentAccess + インライン: `aws:PrincipalTag/access_profile` が `poc-admin` でなければ `iam:ListRoles` を Deny。MaxSessionDuration 43200 |
| `AwsbridgeHumanPocNoTag` | aud・sub。Action は `AssumeRoleWithWebIdentity` だけ | ReadOnlyAccess |

テンプレートを変えたので、P2 の前に `mise run poc:human:deploy-aws` をやり直す（既存のロールと OIDC プロバイダーは変わらない）。

## JWT の claim（AWS の文書で確かめた書式）

出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html（「Passing session tags using AssumeRoleWithWebIdentity」）、
https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html（SourceIdentity）

```jsonc
// 入れ子形式（既定）: 値は 1 要素の配列
"https://aws.amazon.com/tags": { "principal_tags": { "access_profile": ["poc-admin"] } }
// 平坦形式（--tag-format flat / ケース 2）: キーごとの claim、値は文字列
"https://aws.amazon.com/tags/principal_tags/access_profile": "poc-admin"
// SourceIdentity（値は subject = email。STS の制約は 2〜64 文字の [\w+=,.@-]）
"https://aws.amazon.com/source_identity": "user@example.com"
```

文書にある制約: タグは 50 個まで、キー 128 文字・値 256 文字まで、タグは単一値、キーの大文字・小文字は区別しない（保持はする）。
`WebIdentityToken` は 20000 文字まで（https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html）。
ケース 11（50 個 × 256 文字）の JWT は入れ子形式で約 18,500 文字、平坦形式だと約 21,200 文字で上限を超えるので、ケース 11・12 は入れ子形式で送る。
応答の `PackedPolicySize` は非推奨で、`SessionTokenUtilization`（と `SessionTokenSize`）が後継。checks は返ってきたものを全部出す。

## P2・P3: ケース表を流す

```sh
mise run poc:human:deploy-aws      # テンプレートの更新を反映（Outputs に TaggedRoleArn / NoTagRoleArn が出る）
mise run poc:human:checks          # 12 ケースを順に流して表を出す（--only 1,3,8 で絞れる）
```

表の列: ID・ロール・内容・期待・実際（成功 / エラーコード）・判定（PASS / FAIL / INFO）・API の確認・SourceIdentity（応答が subject と一致するか）・
サイズ（JWT の長さ・PackedPolicySize / SessionTokenUtilization）・エラーの要約。email とアカウント ID は伏せて出す。認証情報はどこにも書かない。

| ID | ロール | 内容 | 期待 |
|---|---|---|---|
| 1 | Tagged | 入れ子形式 `poc-admin` + SI | 成功。s3:ListBuckets・iam:ListRoles とも成功 |
| 2 | Tagged | 平坦形式 `poc-admin` + SI（1 と形式だけ違う） | 成功（失敗しても結果として記録する） |
| 3 | Tagged | `poc-viewer` + SI | 成功。s3:ListBuckets は成功（対照）、iam:ListRoles は AccessDenied |
| 4 | Tagged | 値違い `poc-other` + SI | AccessDenied |
| 5 | Tagged | タグなし + SI | AccessDenied |
| 6 | Tagged | 未知のキー `unknown_key` を追加 + SI | AccessDenied |
| 7 | Tagged | キーの大文字違い `Access_Profile=poc-admin` + SI | 記録（成功なら iam:ListRoles の結果も記録） |
| 8 | Tagged | SI なし `poc-admin` | AccessDenied |
| 9 | NoTag | タグ付き（SI なし） | AccessDenied |
| 10 | NoTag | タグも SI もなし（9 の対照） | 成功 |
| 11 | 既存 | 50 個 × 値 256 文字（値は圧縮しにくい英数字） | 成功。PackedPolicySize などを記録 |
| 12 | 既存 | 51 個（値は短い。数の上限だけで落ちるように） | エラー（コードを記録） |

- 信頼ポリシーの拒否はどれも `AccessDenied` で、理由は返らない。そのため否定ケースは対照と 1 点だけ変えてある（4〜8 は 1 と、9 は 10 と）
- 権限の判定には `sts:GetCallerIdentity` を使わない（権限で拒否されないため）。`s3:ListBuckets` と `iam:ListRoles` を使う
- `denied` の判定は `AccessDenied` のときだけ PASS。`InvalidIdentityToken` などほかのコードは原因が違うので FAIL にする

### P3: CloudTrail に残るか

```sh
mise run poc:human:trail                         # 直近 60 分。反映には数分〜15 分かかるので、checks の 15 分後に流す
mise run poc:human:trail -- --minutes 180 --follow 20
```

- `AssumeRoleWithWebIdentity`（PoC のロールだけ）の `requestParameters.sourceIdentity` / `responseElements.sourceIdentity` / `requestParameters.principalTags`
- そのセッション（アクセスキー ID）の API イベントの `userIdentity.sessionContext.sourceIdentity`
- STS のイベントは呼んだリージョン（regional endpoint）に、IAM（ListRoles）などグローバルなサービスのイベントは us-east-1 に残る。既定で `AWS_REGION` と us-east-1 を引く（`--regions` で変えられる）
- email は `u***@***.com`、アカウント ID は `<account>`、アクセスキー ID は末尾 4 文字で出す
- コンソールと `aws login` は、引き受けの時とは別のアクセスキーで API を呼ぶ見込み。そのためアクセスキー ID で引くだけでなく、
  セッション名（`human-<email>`）を `Username` として引き、PoC のロールのセッション（`sessionContext.sessionIssuer` が `AwsbridgeHumanPoc*`）の API イベントを
  キーの列つきで出す。**`Username` が assumed-role のセッション名に当たるかは確かめていない**。初回の実行で、コンソールで操作したあとに
  この表が空なら、CloudTrail のコンソール（イベント履歴）でそのイベントの `userIdentity` を見て、何で引けるかを記録する
- セッションタグ（`principalTags`）は、文書の例では引き受けのイベントの `requestParameters` に出る。後続の API イベントに出るかは確かめて記録する（trail は後続のイベントのタグを表示しない）

コンソールでも見る: `mise run poc:human:console-url -- --role tagged --access-profile poc-admin --source-identity --session-durations 43200` の URL で入り、
IAM のロール一覧などを開いたあと、trail でそのセッションの `sourceIdentity` を確かめる（コンソール操作のイベントにも残るか）。

### 判定基準（P2・P3）

| 判定 | 条件 |
|---|---|
| P2 成立 | 1・3・10 が成功、4・5・6・8・9 が AccessDenied、3 の iam:ListRoles が AccessDenied で s3:ListBuckets が成功、1 の iam:ListRoles が成功 |
| P2 部分的 | 入れ子形式だけ通り平坦形式（2）が通らない、などの形式の差。どちらが通るかを記録する |
| P3 成立 | 8 が AccessDenied（SI 必須にできる）、1 の応答の SourceIdentity が subject と一致し、trail で引き受けと後続 API の両方に sourceIdentity が出る |

## P4: 緊急停止

止める対象は 3 種類。`stop-watch` で同時に見張り、操作の完了時刻から最初の拒否までの秒数を測る。

1. STS の一時認証情報: `mise run poc:human:console-url -- --role tagged --access-profile poc-admin --source-identity --session-durations 43200`
   が書く `credentials-tagged.json`（同じ実行で `console-url-tagged-dur-default-sd-43200.txt` のコンソールの URL もできる）
2. コンソールのセッション: その URL で入ったブラウザ。stop-watch では見られないので、30 秒おきに IAM のロール一覧を再読み込みして、拒否された時刻を手で記録する
3. `aws login` の CLI 認証情報: PoC-B と同じ手順で、2 のコンソールのセッションから `aws login --profile human-poc-tagged --region ap-northeast-1 --remote`

```sh
# 別の端末で（PoC-B の AWS_CONFIG_FILE / AWS_LOGIN_CACHE_DIRECTORY を export した状態で。プロファイルの設定を読むため）
mise run poc:human:stop-watch -- \
  --credentials .secrets/poc-human/credentials-tagged.json \
  --profile human-poc-tagged \
  --assume tagged \
  --interval 5 --since <操作の完了時刻>
```

- `--assume tagged` は毎回 JWT を署名して引き受け直し、新しい認証情報で呼ぶ（新しい引き受けが止まるかを見る）。STS で失敗したらコードに `sts:` が付く
- 見張りは最初の拒否で止めない。`aws login` の認証情報は約 15 分ごとに更新され（PoC-B で確認）、更新後の認証情報は発行時刻が新しいので、
  revoke の基準時刻より後なら再び通る可能性がある。**少なくとも 1 回の更新（20 分以上）を越えるまで**見張り、要約の「失敗のあとに成功」を確かめる
- 見張りは操作の前に `--since` なしで起動する（完了時刻はまだ分からない）。終わったら Ctrl-C で止め、操作の「完了」の時刻を渡して記録を読み直す:
  `mise run poc:human:stop-watch -- --summarize .secrets/poc-human/stop-watch-<時刻>.jsonl --since <完了時刻>`（aws は呼ばない）。
  `--since` より前の失敗は「最初の失敗」に数えない
- 要約の列: 最後の成功・最初の失敗とコード・直前の成功からの間隔（見張りの間隔より細かくは分からない）・since から最初の失敗までの秒数・失敗のあとの最初の成功の時刻
- 記録（`stop-watch-*.jsonl`）には時刻・対象名・成否・エラーコードと、失敗の要約（stderr を 1 行に詰め、email・アカウント ID を伏せたもの）を書く。認証情報は書かない。
  1 回の呼び出しが `--timeout`（既定 30 秒）を超えたら `Timeout`。エラー文の形が違うもの（`aws login` の更新の失敗など）は `Unknown` で、中身は要約に残る

### (a) ロールの Revoke Sessions

```sh
mise run poc:human:revoke          # Tagged に AWSRevokeOlderSessions を付け、「完了: <UTC>」を出す（--role base で既存ロールにも）
#   … stop-watch で止まるまでの時間を見る（伝播に数秒〜数十秒）…
mise run poc:human:unrevoke        # 外す
```

- ポリシー本文（`ops.ts` の `revokePolicyDocument`）: `Deny` `*` on `*`、条件 `DateLessThan aws:TokenIssueTime <基準時刻>`。
  基準時刻はコンソールと同じく「今の 30 秒後」（`--future-seconds` で変えられる）。名前もコンソールと同じ `AWSRevokeOlderSessions`
  （出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html）
- 期待: 発行済みの認証情報・コンソール・`aws login` は拒否される。新しい引き受け（`assume:tagged`）は、基準時刻より後に発行された認証情報なら通る
  （revoke は信頼ポリシーではなく権限ポリシーなので、引き受け自体は止まらない）。基準時刻より前の 30 秒間に発行されたものは拒否される
- `aws login` の更新後の認証情報が基準時刻より後に発行されたものなら、revoke では止まらない可能性がある（これを確かめるのが見張りを続ける理由）
- revoke を付けたまま `deploy-aws` をやり直すと、CloudFormation がテンプレートにないインラインポリシーを消すかもしれない。PoC 中は unrevoke してから deploy-aws する

### (b) OIDC プロバイダーの削除

```sh
mise run poc:human:delete-provider     # スタックの Output の OIDC プロバイダーを消し、「完了: <UTC>」を出す
#   … stop-watch で見る …
mise run poc:human:recreate-provider   # 同じ URL・client ID・タグで作り直す
```

- ガード: スタックの Output `OidcProviderArn` のホストが `AWSBRIDGE_HUMAN_POC_ISSUER` と一致し、`awsbridge-human-poc.` で始まるときだけ消す・作る
- 期待: 新しい引き受け（`assume:tagged`）は止まる（`sts:InvalidIdentityToken` などを記録する）。発行済みの認証情報・コンソール・`aws login` が止まるかは
  分からない（STS の認証情報は引き受け時に発行済みで、プロバイダーは引き受けの時にしか見ないはず）。それを測る
- 戻し方（CloudFormation の外での操作なので、スタックとずれる）:
  1. `mise run poc:human:recreate-provider` で作り直す。ARN は `arn:aws:iam::<account>:oidc-provider/<host>` で決まるので同じになり、ロールの信頼ポリシーはそのまま使える
  2. `mise run poc:human:checks -- --only 1` で引き受けが戻ったか確かめる
  3. **確かめること**: 何も変えずに `deploy-aws` しても、CloudFormation はプロバイダーを作り直さない見込み（変更セットが空になる）。
     作り直さずに消したままで `deploy-aws` が成功しても、プロバイダーは無いままなので、必ず 1 で作る。
     ドリフト検出（`aws cloudformation detect-stack-drift`）で `OidcProvider` が `DELETED` になるか、作り直したあと `IN_SYNC` に戻るかを記録する
  4. うまく戻らなければ `mise run poc:human:destroy` → `deploy-aws` で作り直す（ロールも作り直されるので、開いているセッションは使えなくなる）

### (c) SCP は対象外

開発用のアカウントが AWS Organizations の管理アカウントで、SCP は管理アカウントのユーザー・ロールには効かないため、この PoC では試さない
（「SCPs affect only member accounts in the organization. They have no effect on users or roles in the management account.」
https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html）。メンバーアカウントで試すときは別の PoC にする。

### 片付けの確認（P4 のあと）

revoke のインラインポリシーが残っていてもスタック削除が通るかを確かめる:

1. `mise run poc:human:revoke` を付けたまま `mise run poc:human:destroy`
2. 通れば記録する。`DELETE_FAILED`（ロールにインラインポリシーが残っている、など）なら `mise run poc:human:unrevoke` → もう一度 `destroy`
3. プロバイダーを消したまま destroy した場合も、スタック削除が通るか（存在しないリソースの削除を成功とみなすか）を記録する

### 判定基準（P4）

| 判定 | 条件 |
|---|---|
| (a) 成立 | 発行済みの STS 認証情報・コンソール・`aws login` が、revoke の完了から数分以内に拒否され、20 分以上見張っても `aws login` が戻らない |
| (a) 部分的 | `aws login` が更新後に通る（失敗のあとに成功）。この場合、revoke は `aws login` を止めきれない |
| (b) 記録 | 新しい引き受けが止まるまでの秒数と、発行済みの認証情報・コンソール・`aws login` が止まるか（止まらないなら有効期限まで使える） |

## 結果の記録（P2〜P4）

実行日・CLI のバージョン・リージョンを書く（アカウント ID・email・URL は書かない）。`checks` と `trail` の表は伏せ字済みなので貼ってよい。

### P2・P3（checks）

実行日 2026-11-11（UTC 2026-11-10 22:47）、AWS CLI 2.39.6、ap-northeast-1。

| ID | ロール | 内容 | 期待 | 実際 | 判定 |
|---|---|---|---|---|---|
| 1 | Tagged | 入れ子形式 poc-admin + SI | 成功 | 成功（ListBuckets・ListRoles とも成功） | PASS |
| 2 | Tagged | 平坦形式 poc-admin + SI | 成功 | 成功（同上） | PASS |
| 3 | Tagged | poc-viewer + SI | 成功 | 成功。ListBuckets は成功、ListRoles は AccessDenied（PrincipalTag で権限が変わる） | PASS |
| 4 | Tagged | 値違い poc-other + SI | AccessDenied | AccessDenied | PASS |
| 5 | Tagged | タグなし + SI | AccessDenied | AccessDenied | PASS |
| 6 | Tagged | 未知のキーを追加 + SI | AccessDenied | AccessDenied | PASS |
| 7 | Tagged | キーの大文字違い Access_Profile | 記録 | AccessDenied | INFO |
| 8 | Tagged | SI なし poc-admin | AccessDenied | AccessDenied | PASS |
| 9 | NoTag | TagSession なしのロールにタグ付き | AccessDenied | AccessDenied | PASS |
| 10 | NoTag | タグも SI もなし | 成功 | 成功 | PASS |
| 11 | 既存 | 50 個 × 値 256 文字 | 成功 | PackedPolicyTooLarge（「Token size of 18244 bytes exceeds the maximum allowed limit of 4096 bytes」） | 期待が誤り（下記） |
| 12 | 既存 | 51 個 | エラー | InvalidParameterValue（「Number of tags in request can not be more than 50」） | PASS |

| 項目 | 結果 |
|---|---|
| 平坦形式（ケース 2） | 入れ子形式と同じく使える |
| キーの大文字違い（ケース 7） | 拒否された。信頼ポリシーの `aws:RequestTag/access_profile` と `aws:TagKeys` の照合で、キーの大文字・小文字は区別されるものとして扱う |
| 50 個 × 256 文字（ケース 11） | 失敗。セッションタグはパック後 4096 バイトまでで、50 個の上限より先にこちらに当たる。1 個（access_profile=poc-admin）の SessionTokenUtilization は 25%。タグはグループ一覧ではなく単一値で渡す前提を裏付ける |
| 51 個（ケース 12）のエラーコード | InvalidParameterValue |
| CloudTrail: 引き受けの sourceIdentity / principalTags | 残る。AssumeRoleWithWebIdentity のイベントに、要求と応答の sourceIdentity とタグ access_profile=poc-admin が記録された |
| CloudTrail: 後続 API の sessionContext.sourceIdentity | 残る。STS の認証情報と、`aws login` で得た CLI の認証情報の両方の ListBuckets に sourceIdentity が付いていた |
| コンソール操作のイベントの sourceIdentity | 未確認（コンソールからの API 呼び出しのイベントは個別に見ていない） |

### P4（stop-watch）

実行日 2026-11-11（UTC 2026-11-10 22:51〜23:16）。5〜6 秒おきに s3:ListBuckets を呼んで見張った。

| 操作 | 完了時刻（UTC） | STS 認証情報 | コンソール | `aws login` | 新しい引き受け | 失敗のあとに成功 | メモ |
|---|---|---|---|---|---|---|---|
| (a) revoke | 22:52:05 | 約 8 秒で AccessDenied | 約 1 分後の再読み込みで明示的な Deny | 約 8 秒で AccessDenied。15 分後の更新も `signin:CreateOAuth2Token` の拒否で失敗し、約 20 分見張っても戻らなかった | 基準時刻（完了の約 30 秒後）より後の引き受けは成功 | revoke 中はなし | unrevoke（23:11:44）から約 17 秒で、古い STS 認証情報と `aws login` が両方とも復活した |
| (b) プロバイダー削除 | 23:12:37 | 使えたまま | 確認していない（STS 認証情報と同じく使えたままのはず） | 使えたまま | 約 12 秒で `sts:InvalidIdentityToken` | - | 削除中、STS 認証情報が 2 回だけ AccessDenied になった（unrevoke の伝播の揺れとみられる）。ドリフト検出では OidcProvider が DELETED、recreate-provider のあと IN_SYNC に戻った |
| 片付け（revoke を付けたまま destroy） | 23:16 頃 | - | - | - | - | - | 通った。スタック・プロバイダー・ロールはどれも 0 件、Worker の URL は 404 |

分かったこと:

- revoke は、発行済みの STS 認証情報・コンソール・`aws login` を数秒〜1 分で止め、`aws login` の更新も止める。ただし**外すと古い認証情報が復活する**ので、最長のセッション（12 時間）が切れるまで外さない
- プロバイダーの削除は新しい引き受けしか止めない。発行済みの認証情報は期限まで使える。緊急停止は「プロバイダー削除（新規を止める）＋ revoke（発行済みを止める）」の組み合わせになる
- SCP は管理アカウントに効かないので、ここでは試していない（上の (c)）
- 運用上の注意: 同じブラウザに別のフェデレーションのコンソールセッションが残っていると、新しいログイン URL を開いても切り替わらない。いったんサインアウトしてから開く

### 12 時間のセッションについて（PoC-A の補足）

- **SessionDuration=43200 が受理されたこと**: 確認済み（PoC-A の A-2、`getSigninToken` が成功し、その URL でコンソールに入れた）
- **実際に 12 時間続くこと**: 未観測。1 時間を超えて続くかも含めて観測していない。確かめるなら A-2 と同じ URL で入り、
  1 時間後・6 時間後・12 時間後・12 時間 5 分後にページを再読み込みして、ログイン状態を記録する
