# PoC: ポータルの経路（N9・N1 の M2・N10）

人間の AWS ログインの段階 1 の前のゲート（cto の決裁の 3-C）のうち、開発環境（個人の Cloudflare Zero Trust、IdP は Google、
開発用の AWS アカウント 1 つ）で確かめられるものの道具と手順。設計は [docs/specs/console-login-portal.md](../../../../docs/specs/console-login-portal.md)
（§3.1 の R-P / R-H、§9 のエンドポイント、§12.3 の PoC）。前の PoC（PoC-A/B・P2〜P4）は [../README.md](../README.md)。

| # | 確かめること | 決まること |
|---|---|---|
| N9 | OIDC の issuer にパスを含めた場合（`https://<host>/std` と `https://<host>/admin`）、IAM の OIDC プロバイダーに登録でき、`AssumeRoleWithWebIdentity` が通るか。discovery と JWKS の置き場所（`<issuer>/.well-known/openid-configuration`）。同じホストの 2 つのパスを別のプロバイダーにできるか | G-8（issuer のホストとパス）、D3（階層ごとに issuer を分ける形） |
| N1 (M2) | 同じホストのパス違い（`/t/infra` と `/t/dev`）に別々の Access アプリを作ったとき、Worker に届く Access JWT の `aud` が別の値になるか。具体的なパスが優先されるか。片方のアプリに許可されていない人が、そのパスで拒否されるか | G-1（R-P か R-H か） |
| N10 | ブラウザ → Access（Google）→ Worker が Access JWT を検証 → AUD からチーム → 自前 JWT（タグ `awsbridge_team`・SourceIdentity）→ STS → `getSigninToken` → コンソール。所属を外した人が拒否されるまでの時間と、アプリのセッションを短くしたとき・トークンを失効させたときに所属が取り直されるか | §6 全体、所属の反映時間 |
| 余裕があれば | 同じ端末の `aws login`（`--remote` なし）、`--remote` が拒否されるか（P-2）、マルチセッションで 2 つ目のフェデレーションのセッションを追加できるか（P-1） | G-4、§6.4 |

Google には groups が無いので、所属の代わりに Access ポリシーの email の include を使う（会社の環境では Entra のグループの Object ID になる）。

## 構成（MCP 用・前の PoC とは分ける）

```
ブラウザ ──▶ Access（PoC のアプリ）──▶ Worker awsbridge-human-poc-portal（workers.dev）──▶ STS ──▶ Federation ──▶ コンソール
              入口: <host>（ホスト全体）      GET /t/<チーム>/whoami・/t/<チーム>/（aud とチームを表示）
              infra: <host>/t/infra          POST /t/<チーム>/login（Access JWT → AUD → チーム → 自前 JWT → STS → 302）
              dev:   <host>/t/dev            GET /std/.well-known/*、/admin/.well-known/*（N9。Access は Bypass）
              Bypass: <host>/{std,admin}/.well-known/{openid-configuration,jwks.json}
手元 ── checks.ts（N9。std / admin の鍵で署名して STS を直接呼ぶ。Access を通らない）
AWS（スタック awsbridge-human-poc-portal）: OIDC プロバイダー <host>/std と <host>/admin、ロール AwsbridgeHumanPocPortal{Shared,InfraOnly,Admin}
```

| 項目 | 値 |
|---|---|
| Worker | `awsbridge-human-poc-portal`（`portal/wrangler.jsonc`。workers.dev。本番の自社ドメインは人間用ポータルの本番で決める） |
| issuer | `https://<host>/std`（ログインに使う）と `https://<host>/admin`（N9 だけ）。鍵は階層ごとに別（`.secrets/poc-human/portal/signing-key-{std,admin}.json`） |
| audience | `awsbridge-human-poc-portal` |
| タグ | `awsbridge_team`（単一値。Worker が Access JWT の AUD から決める） |
| ロール | `Shared`（std、チーム infra・dev）、`InfraOnly`（std、infra だけ）、`Admin`（admin の issuer、infra だけ、MaxSessionDuration 3600）。どれも ReadOnlyAccess と、`aws login` の localhost だけを許すインラインポリシー。sub は照合しない |
| Access アプリ | `portal/access/`（Terraform。`infra/cloudflare` とは別のディレクトリ・別の state）。名前は `awsbridge-human-poc-portal-{entry,infra,dev,issuer-documents}` |
| 設定 | `AWSBRIDGE_HUMAN_POC_PORTAL_*` だけ（MCP 用・前の PoC の変数は読まない） |

Worker はロールの一覧をチームで絞らない（設計の `not_listed` の絞り込みは入れていない）。dev の経路で `InfraOnly` を選ぶと、
信頼ポリシーが拒否して `sts_denied` になることを観察するため（認可は AWS 側）。

ファイル:

- `lib.ts`（Worker と手順で共有する純粋関数）/ `handler.ts` / `worker.ts` / `wrangler.jsonc`: Worker。テストは `test/unit/poc-human-portal-{lib,handler}.test.ts`、E2E は `test/e2e/poc-human-portal.test.ts`
- `poc-portal.yaml`: CloudFormation。テストは `test/unit/poc-human-portal-template.test.ts`
- `access/`: Access アプリの Terraform（`check.sh` で fmt・validate・tflint）
- `settings.ts` / `deploy-lib.ts` / `n9-cases.ts` / `watch-lib.ts`: 手順の純粋関数。テストは `test/unit/poc-human-portal-ops.test.ts`
- `keygen.ts` / `deploy.ts` / `deploy-aws.sh` / `checks.ts` / `access-watch.ts` / `access-revoke.ts` / `destroy.sh`: 手順。テストは `test/unit/poc-human-portal-scripts.test.ts`

## 前提と、実行前に用意するもの

- `mise install`・`mise run install` 済み。`pnpm exec wrangler login` 済み（Worker をデプロイできる Cloudflare アカウント）
- AWS プロファイル（既定 `awsbridge`）で CloudFormation・IAM を作れること（`aws login --profile awsbridge`）
- `CLOUDFLARE_API_TOKEN`（Terraform と access-revoke 用。`Access: Apps and Policies Write`。失効の手順を使うなら `Access: Apps and Policies Revoke` も）。Workers の権限は持たない。wrangler（deploy・destroy・tail）には渡さない（スクリプトが外す）。wrangler は `wrangler login` の OAuth を使う
- Zero Trust に Google の IdP があること（その ID を tfvars の `allowed_idp_ids` に入れる）
- `mise.local.toml`（gitignore）に次を書く。値はリポジトリに入れない

```toml
[env]
# PoC のポータル Worker の URL。<subdomain> は workers.dev のアカウントのサブドメイン（デプロイ前から決まっている）
AWSBRIDGE_HUMAN_POC_PORTAL_URL = "https://awsbridge-human-poc-portal.<subdomain>.workers.dev"
# Access のチームドメイン
AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
# access-revoke を使うときだけ
AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID = "<Cloudflare のアカウント ID>"
```

- `scripts/poc/human/portal/access/terraform.tfvars.example` を `terraform.tfvars`（gitignore）にコピーし、`account_id`・`worker_host`
  （URL のホスト部分）・`allowed_idp_ids`・`teams`（チームごとの email）を実値にする。M2 で「片方のアプリに許可されていない人」を作るため、
  infra と dev の email を変えられるようにしておく（Google アカウントが 1 つなら、あとで infra の email を `nobody@example.invalid` に置き換える）

上書きできる既定値（スクリプト側で補う。`mise.toml` の `[env]` には置かない）:

| 変数 | 既定値 |
|---|---|
| `AWS_PROFILE` / `AWS_REGION` | `awsbridge` / `ap-northeast-1` |
| `AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME` | `awsbridge-human-poc-portal`（`awsbridge-human-poc-portal` で始まる名前だけ受け付ける） |
| `AWSBRIDGE_HUMAN_POC_PORTAL_AUDIENCE` | `awsbridge-human-poc-portal` |
| `AWSBRIDGE_HUMAN_POC_PORTAL_SESSION_DURATION` | `3600`（Worker が `getSigninToken` に付ける SessionDuration。`none` で付けない） |
| `AWSBRIDGE_HUMAN_POC_PORTAL_SHARED_TEAMS` / `_RESTRICTED_TEAM` | `infra,dev` / `infra`（deploy-aws がロールの信頼ポリシーに入れる） |
| `AWSBRIDGE_HUMAN_POC_PORTAL_SUBJECT` | `awsbridge-n9-check`（N9 の checks の sub と SourceIdentity。個人の値にしない） |
| `AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR` | `.secrets/poc-human/portal`（鍵・Worker の secret・Cookie・見張りの記録） |
| `AWSBRIDGE_HUMAN_POC_PORTAL_COOKIE_FILE` | `<OUT_DIR>/access-cookie.txt` |
| `AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_DIR` | `scripts/poc/human/portal/access`（Access の Terraform。deploy・revoke-tokens・destroy が読む） |

## 実行順

```sh
mise run poc:human:portal:keygen        # 1. std と admin の署名鍵
mise run poc:human:portal:deploy        # 2. Worker（1 回目。ROLES と AUD の対応は空）。[OK] が 4 行（std / admin × discovery / JWKS）
mise run poc:human:portal:deploy-aws    # 3. OIDC プロバイダー 2 つとロール 3 つ。Outputs を確認
mise run poc:human:portal:checks        # 4. N9（Access を掛ける前）
mise run poc:human:portal:access-plan   # 5. Access アプリの plan（作るのは entry・infra・dev・issuer-documents の 4 つとポリシー 4 つ）
mise run poc:human:portal:access-apply  # 6. apply（-auto-approve。この PoC の state だけ）
mise run poc:human:portal:deploy        # 7. Worker（2 回目。スタックの Outputs と Terraform の出力を読む）。[OK] が 4 行 = Bypass が効いている
mise run poc:human:portal:checks        # 8. N9（Access を掛けた後。IAM が Bypass 越しに文書を読めるか）
#                                         9. N1（M2）・10. N10・11. 余裕があれば（下の手順。ブラウザ）
mise run poc:human:portal:destroy       # 12. 片付け
```

- 2 は AWS を読むだけ（スタックが無ければ ROLES は空）。3 は Cloudflare を呼ばない。`-- --dry-run` でバンドルだけ確かめられる
- Terraform の変数（チームの email・セッション時間）を変えたら `access-apply` のあと `deploy` をやり直す（AUD は変わらないはずだが、照合のため）
- Worker のログは `mise run poc:human:portal:tail`（whoami・login の要約。email は伏せる。トークンは出さない）

## N9: パス付き issuer（手順 4・8）

`checks` のケース（否定ケースは対照と 1 点だけ違う）:

| ID | 鍵 | iss | ロール | 期待 |
|---|---|---|---|---|
| 1 | std | `/std` | Shared | 成功 |
| 2 | admin | `/admin` | Admin | 成功 |
| 3 | std | `/std` | Admin（admin のプロバイダー） | AccessDenied（同じホストの別パスは別のプロバイダー） |
| 4 | admin | `/admin` | Shared（std のプロバイダー） | AccessDenied |
| 5 | std | `/admin` | Admin | エラー（署名の検証で落ちる見込み。コードを記録） |
| 6 | std | `/std/`（末尾スラッシュ） | Shared | 記録 |
| 7 | std | ホストだけ | Shared | エラー（そのホストのプロバイダーは無い） |
| 8 | std | `/std`、チーム dev | InfraOnly | AccessDenied |
| 9 | std | `/std`、チーム infra | InfraOnly | 成功（8 の対照） |
| 10 | std | `/std`、SI なし | Shared | AccessDenied |

確認:

- 3 のあと、IAM コンソールの ID プロバイダーに `<host>/std` と `<host>/admin` が別々に並ぶこと
- 条件キーは `<host>/<path>:aud` とした。**未検証**（AWS の文書で確かめたのは「プロバイダーの URL のパスは ARN に含まれる」まで。条件キーの形は EKS の IRSA の `oidc.eks.<region>.amazonaws.com/id/<id>:sub` が前例）。ケース 1 で確かめる
- 4 と 8 の結果が同じ（Access の有無で変わらない）

### 判定基準（N9）

| 判定 | 条件 |
|---|---|
| 成立 | 3 でスタックが作れ、4・8 とも 1・2・9 が成功、3・4・8・10 が AccessDenied、5・7 がエラー |
| 部分的 | 4 は通るが 8 が通らない（Bypass が IAM の取得に効いていない）。Bypass の対象パスを見直す |
| 条件キーを疑う | 1・2・9 が `AccessDenied`（`InvalidIdentityToken` ではない）。JWT は受理されたが信頼ポリシーの条件が合っていない。`<host>/<path>:aud` の形を疑い、CloudTrail の `AssumeRoleWithWebIdentity` のエラーと IAM のポリシーシミュレーターで確かめる |
| 不成立 | スタックの作成でプロバイダーが作れない、または 1・2 が `InvalidIdentityToken`（パス付き issuer の文書を IAM が読めない） |

## N1（M2）: パスごとの Access アプリと AUD（手順 9。ブラウザ）

Access の状態が混ざらないよう、シークレットウィンドウ（または専用のブラウザプロファイル）で行う。

1. `https://<host>/whoami` を開く → Google でログイン → JSON の `aud` を記録する（入口のアプリの AUD。`entry_aud: true`、`aud_team: null`）
2. `https://<host>/t/infra/whoami` → `aud_team: "infra"`、`team_match: true`。`aud` が 1 と違う値か
3. `https://<host>/t/dev/whoami` → `aud_team: "dev"`。`aud` が 2 と違う値か
4. 2・3 で、IdP（Google）の画面がもう一度出たか（アプリ間で SSO のセッションが共有されるか）。Cookie Path（既定で有効）のため、
   チームを切り替えたときに Access へのリダイレクトが起きたかも記録する
5. パスの一致: `https://<host>/t/infra`（末尾スラッシュなし。HTML の表に `aud` が出る）と `https://<host>/t/infrastructure/whoami`
   （チーム infrastructure は無いので `aud_team` は AUD から決まったものが出る）がどのアプリの `aud` になるか。
   後者は入口のアプリ（`entry_aud: true`）になるのが望ましい。infra の `aud` なら、Access のパスの一致は前方一致で、チーム名の付け方に制約が要る
6. 「片方のアプリに許可されていない人」: tfvars の `teams.infra.emails` を自分以外（例 `nobody@example.invalid`）にして `access-apply` →
   新しいシークレットウィンドウで `https://<host>/t/infra/whoami` が Access のブロック画面になり、`https://<host>/t/dev/whoami` は通ること
7. 入口のアプリのポリシー（全チームの email の和集合）で、6 の後も `https://<host>/whoami` が通ること
8. Issuer の文書は Cookie なしで読めること: `curl -s https://<host>/std/.well-known/openid-configuration`（JSON が返る）

### 判定基準（N1 の M2）

| 判定 | 条件 |
|---|---|
| 成立（R-P を採れる） | 1・2・3 の `aud` がすべて違い、2・3 の `aud_team` がパスのチームと一致、6 で infra だけが拒否される |
| 部分的 | AUD は分かれるが、チームの切り替えのたびに IdP の再ログインが要る（使い勝手の問題として G-1 に記録） |
| 不成立（R-H を検討） | `/t/infra` で入口の AUD が届く（具体的なパスが優先されない）、または 6 で拒否されない |

## N10: Access + Worker の通し経路（手順 10。ブラウザ）

### 通し（ログイン）

1. `https://<host>/t/infra/` を開く（aud とチームの表が出る）→ ロール `shared` で「コンソールを開く」→ コンソールに入れる。
   右上が `AwsbridgeHumanPocPortalShared/human-<email>`
2. CloudTrail（`AssumeRoleWithWebIdentity`）に `principalTags` の `awsbridge_team=infra` と `sourceIdentity=<email>` が残ること
   （前の PoC の `mise run poc:human:trail` はロール名の条件が違うので使えない。CloudTrail のイベント履歴で見る）
3. 否定: `https://<host>/t/dev/` からロール `infra-only` → `sts_denied`（403）。`shared` なら入れる（タグ dev）
4. 否定: 開発者ツールなどで `/t/dev/` のフォームの送信先を `/t/infra/login` に変える → `team_mismatch`（Access の dev の AUD で infra のパスに来たため。
   Cookie Path が有効なら Access が infra のアプリとして扱い、infra の AUD が届くかもしれない。その場合は結果を記録する）
5. コンソールのセッションが切れたとき `https://<host>/t/infra/expired` に戻るか（`SESSION_DURATION` を 900 にして deploy し直すと早く見られる。P-3）

### 所属を外したときに拒否されるまでの時間

Access の文書から読める見込み（確かめる）:

- ポリシーを変えても、発行済みのアプリのトークン（`CF_Authorization`）はアプリのセッション時間が切れるまで使える
- アプリのセッションが切れたとき、グローバルのセッション（IdP のログイン）が残っていれば、IdP にログインし直さずにポリシーで判定し直される
- アプリの「Revoke existing tokens」でセッションは切れるが、ポリシーで許されていれば新しいセッションを始められる

準備: `https://<host>/t/infra/` を開いた状態で、開発者ツールの Application → Cookies から `CF_Authorization`（`/t/infra` のパスのもの）の
値を `.secrets/poc-human/portal/access-cookie.txt`（権限 600）に 1 行で保存する（`chmod 600`）。画面共有・チャットに貼らない。

| ケース | 操作 | 見張り | 記録すること |
|---|---|---|---|
| (a) ポリシーから外す | `teams.infra.emails` から自分を外して `access-apply`（完了時刻を記録） | `mise run poc:human:portal:watch -- --team infra --interval 5` と、ブラウザで `https://<host>/t/infra/?refresh=30`（dev が通り続けることはブラウザの `/t/dev/` で見る） | 見張りの最初の失敗の時刻（期待: セッション時間が切れるまで失敗しない）。ブラウザでブロック画面になった時刻 |
| (b) セッション時間を短くする | `teams.infra.session_duration = "5m"`（下限は未確認。受理されなければ `"15m"`）で apply → 新しいシークレットウィンドウでログインし直し、Cookie を取り直す → (a) と同じく外す | 同上 | 5 分以内に拒否されるか。ブラウザが IdP の画面を出さずにブロック画面になるか（ポリシーで判定し直された） |
| (c) トークンを失効させる | 自分を戻して apply → ログインし直し、Cookie を取り直す → 外して apply → すぐに `mise run poc:human:portal:revoke-tokens -- --app awsbridge-human-poc-portal-infra`（完了時刻を記録） | 同上 | 失効の完了から最初の失敗までの秒数（`-- --summarize <記録> --since <完了時刻>` で読み直す） |
| (d) 外さずに失効だけ | 自分を残したまま (c) の失効だけ | ブラウザ | IdP にログインし直さずに新しいトークン（`iat` が変わる）で戻れるか |

- 見張りは Ctrl-C で止めると要約（最後の成功・最初の失敗とコード・失敗のあとの最初の成功・`iat` が変わった時刻）を出す。記録は `<OUT_DIR>/access-watch-*.jsonl`（Cookie は入らない）
- Cookie は 1 つのアプリ（Cookie Path が有効なら `/t/infra`）の分なので、見張りは `--team` を 1 つにする（別のチームを足すと最初から `access_login_redirect` になる）
- 見張りは IdP のログインをやり直せないので、「今のトークンが受け付けられなくなる時刻」を測る。所属の取り直し（新しい `iat`）はブラウザの `?refresh=30` のページの `iat` の欄で見る
- 失敗のコード: `access_login_redirect`（Access がログインへ送った = セッション切れ・失効）、`access_forbidden`（Access の拒否）、`worker_unauthorized`、`team_mismatch`
- Binding cookie を有効にした（`enable_binding_cookie = true`）ときは、Cookie のファイルに `CF_Authorization=...; CF_Binding=...` の形で両方を書く
- 失効の API（`POST /accounts/{account_id}/access/apps/{app_id}/revoke_tokens`）は、実測で動いた（HTTP 202 を返す。2xx を成功として扱う）。失敗したらダッシュボードのアプリの「Revoke existing tokens」で代え、その時刻を記録する

### 判定基準（N10）

| 判定 | 条件 |
|---|---|
| 通し: 成立 | 1 でコンソールに入れ、2 でタグと SourceIdentity が残り、3 が `sts_denied` |
| 反映時間: 記録 | (a)〜(d) の秒数。設計では「所属を外してから拒否されるまで」の上限を、アプリのセッション時間（と失効の運用）で決める |
| 不成立 | (b) で、アプリのセッションが切れても拒否されない（ポリシーが判定し直されない）。または (c) で失効しても使い続けられる |

## 余裕があれば（手順 11）

- **同じ端末の `aws login`（P-2）**: 1 のコンソールが開いているブラウザが既定のブラウザである状態で、前の PoC の PoC-B と同じく一時的な設定ファイルを使い、
  `aws login --profile portal-poc --region ap-northeast-1`（`--remote` なし）。`aws sts get-caller-identity --profile portal-poc` の Arn が
  `assumed-role/AwsbridgeHumanPocPortalShared/...` になるか
- **`--remote` が拒否されるか**: 同じ状態で `aws login --profile portal-poc-remote --region ap-northeast-1 --remote`。ロールには localhost だけを許すポリシーを付けているので、
  認可かトークン発行が拒否されるはず（エラーを記録する）
- **マルチセッション（P-1）**: コンソールの右上のメニューからマルチセッションを有効にする → `/t/infra/` から `shared` で入る →
  別のタブで `/t/dev/` から `shared` で入る。2 つ目がセッションの追加になるか（右上のアカウントの一覧に 2 つ並ぶか）、上書きになるか、切り替わらないかを記録する。
  有効にしていない状態で同じことをして、切り替わらないこと（前の PoC の観察）が再現するかも記録する

## 結果の記録

実行日・CLI のバージョン・リージョンを書く。アカウント ID・email・AUD・URL・workers.dev のサブドメインは書かない（`checks` の表は伏せ字済み）。

### N9

| ID | 期待 | 実際（Access 前） | 実際（Access 後） | 判定 |
|---|---|---|---|---|
| 1〜10 | | | | |

| 項目 | 結果 |
|---|---|
| パス付き issuer をプロバイダーに登録できたか | |
| 同じホストの 2 つのパスを別のプロバイダーにできたか | |
| 末尾スラッシュつきの iss（ケース 6） | |

### N1（M2）

| 項目 | 結果 |
|---|---|
| 入口・infra・dev の `aud` が互いに違うか | |
| `/t/infra` で infra の `aud` が届くか（具体的なパスの優先） | |
| チームの切り替えで IdP の再ログインが要ったか | |
| `/t/infra`・`/t/infra/x`・`/t/infrastructure` のアプリ | |
| infra から外した人が `/t/infra` で拒否され、`/t/dev` は通るか | |

### 実測の要約（2026-11-11）

開発環境: 個人の Zero Trust、IdP は Google、開発用 AWS アカウント 1 つ。アカウント ID・email・実サブドメイン・AUD の値は書かない。

- N9（パス付き issuer）: Access の前・後とも 10 ケースで FAIL 0。1 つのホストの `/std` と `/admin` を別の OIDC プロバイダーとして登録でき、それぞれで引き受けられた。階層をまたぐ引き受けは AccessDenied。鍵と issuer の食い違いは InvalidIdentityToken。issuer の末尾スラッシュ違い（`/std/`）は InvalidIdentityToken（完全一致が必要）
- M2: 入口・`/t/infra`・`/t/dev` の Access JWT の `aud` は 3 つとも別の値で、`aud_team` はパスのチームと一致。アプリを切り替えても IdP の再ログインは出なかった（グローバルセッションが共有される）。`/t/infrastructure` は入口のアプリになった（前方一致ではない）。infra のポリシーから自分を外すと（失効後）`/t/infra` だけが拒否され、`/t/dev` は通り続けた
- N10 通し: `/t/infra/` からロール shared でコンソールに入れた（右上が `AwsbridgeHumanPocPortalShared/human-<email>`）。`/t/dev/` から infra-only は `sts_denied`（403）。CloudTrail の `AssumeRoleWithWebIdentity` に principalTags の `awsbridge_team` と `sourceIdentity`（本人の email）が残った（呼び出し元の IP は Cloudflare）
- N10 所属の反映:
  - (a) ポリシーから外すだけでは、発行済みのアプリのトークン（infra は 24 時間）は使い続けられた
  - (c) 外して約 20 秒後に `revoke_tokens` すると、Access は新しいトークンを発行して通した（ポリシーの変更がまだ反映されていなかったとみられる）。約 2 分 15 秒後にもう一度失効させると、IdP の再ログインなしに「That account does not have access」で拒否された
  - (b) dev（セッション 15 分）から外し、トークンの期限切れ後に開くと、IdP の再ログインなしに拒否された（期限切れでポリシーが判定し直される）
  - (d) は実施していない
- 実行中に見つかった問題:
  1. ブラウザに前の PoC で消したロールのコンソールセッションが残っていると、新しいログインリンクが「Credentials invalid」になった。コンソールからサインアウトすると通った
  2. ポータルの CSP の `form-action` に signin しか入れていなかったため、サインインからコンソールへのリダイレクトで遷移が止まった。`form-action` に `https://console.aws.amazon.com` と `https://*.console.aws.amazon.com` を足して直した（`handler.ts` とテストは修正済み）
  3. Worker の deploy・delete は、`mise.local.toml` に `CLOUDFLARE_API_TOKEN`（Access 用で Workers の権限なし）があると wrangler がそれを使って失敗した。`CLOUDFLARE_API_TOKEN` を外して実行した → スクリプトで wrangler に渡さないようにした
  4. `revoke_tokens` の API は HTTP 202 を返す（スクリプトは 200 以外を失敗としていた）→ 2xx を成功とした
  5. `access-apply` / `destroy` の terraform が対話の確認で止まる → `-auto-approve` を付けた（この PoC の state だけ。destroy のガードは維持）
- 片付け: Access（8 リソース）を `terraform destroy`、CFN スタック削除、Worker 削除。OIDC プロバイダー・ロールは 0 件、Worker の URL は 404 を確認

### N10

| ケース | 操作の完了（UTC） | 最初の失敗（コード） | 秒数 | ブラウザ | メモ |
|---|---|---|---|---|---|
| 通し | - | - | - | | |
| (a) ポリシーから外す | | | | | |
| (b) セッション時間 5m | | | | | |
| (c) 外して失効 | | | | | |
| (d) 失効だけ | | | | | |

| 余裕があれば | 結果 |
|---|---|
| 同じ端末の `aws login` | |
| `--remote` の拒否 | |
| マルチセッションでの追加 | |

## 片付け

```sh
mise run poc:human:portal:destroy
```

- スタック（`awsbridge-human-poc-portal` で始まる名前だけ）→ Worker `awsbridge-human-poc-portal` → Access アプリ（`portal/access` の state にあるものだけ。
  state に Access のアプリ・ポリシー以外があれば止まる。`terraform destroy -auto-approve` で対話の確認なしに消す）の順に消す
- `<OUT_DIR>` の `worker-secrets.json`・`access-cookie.txt`・`dist/` を消す。署名鍵と見張りの記録は残すので、結果を書き写してから `rm -rf .secrets/poc-human/portal` で消す
- ブラウザのシークレットウィンドウを閉じ、`aws login` の一時ディレクトリを消す（`aws logout` → `rm -rf`）
- MCP 用・前の PoC のスタック・Worker・Access アプリ（`infra/cloudflare`）には触らない
