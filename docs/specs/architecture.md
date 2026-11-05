# awsbridge アーキテクチャ仕様（初版・設計合意メモ）

- 作成日: 2026-11-05
- 状態: 本体実装済み（実環境の正常系は未確認）。構成 A' の PoC は完了（2026-11-05、[PoC 結果](#poc-結果構成-a-2026-11-05) 参照）
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

## マルチアカウント（aws_profile）

複数の AWS アカウントを `tools/call` の引数 `aws_profile` で切り替える。前身の `aws_profile` を引き継ぐが、users 対応表と S3 読み込みは持たない。

### 決定

- **各アカウント**: 対象アカウントごとに `infra/aws/awsbridge.yaml` を流し、Worker を信頼するロールを作る。Worker は選ばれたロールを **AssumeRoleWithWebIdentity で直接**引き受ける（チェーン AssumeRole はしない）。
- **認可は AWS 側**: 誰がどのアカウントを使えるかは各アカウントの信頼ポリシー（`AllowedSubjects`）で決まる。許可外は STS の `AccessDenied` → 403 `forbidden`。Worker に users 対応表は持たない。
- **設定**: 環境変数 `AWS_PROFILES`（**必須**）。wrangler の vars（JSON オブジェクト）でも secret（JSON 文字列）でも受け付ける。基点ロール `FEDERATED_ROLE_ARN` は廃止し、設定経路をこれに一本化した。

```json
{
  "default": "dev",
  "profiles": {
    "dev":  { "roleArn": "arn:aws:iam::111111111111:role/awsbridge", "description": "任意" },
    "prod": { "roleArn": "arn:aws:iam::222222222222:role/awsbridge" }
  },
  "tools": ["call_aws"]
}
```

- `default`: 必須。`profiles` のキー名。`aws_profile` を指定しないときに使う。
- `tools`: 任意。`aws_profile` の対象ツール。省略時は全ツール。
- 検証: 名前は `^[A-Za-z0-9_-]{1,32}$`（STS の `RoleSessionName` 64 文字に `gw-<利用者>-<名前>` を収めるため 32 文字まで）、`roleArn` は `^arn:aws[a-z-]*:iam::\d{12}:role/[\w+=,.@/-]{1,128}$`、`profiles` は 1 件以上、`tools` は空配列不可、`default` は `profiles` に存在すること。違反は 500 `server_misconfigured`（ログには `config: invalid AWS_PROFILES: <種別>` のみ。値は出さない）。

### 選び方

| リクエスト | 使うロール |
|---|---|
| 対象ツールの `tools/call` で `params.arguments.aws_profile` が一覧にある | そのプロファイル |
| 対象ツールの `tools/call` で `aws_profile` なし | `default` |
| 対象外ツールの `tools/call`（`aws_profile` が付いていても検証せず無視） | `default` |
| `initialize` / `tools/list` / `ping` / notifications など `tools/call` 以外、GET / DELETE | `default` |
| JSON-RPC バッチ | 対象ツールの `tools/call` が指す `aws_profile` がすべて同じ（省略は `default` 扱い）ならそのロール。異なれば 400 `batch_not_supported` |

`aws_profile` は上流へ送る前にすべての `tools/call` の arguments から取り除く（対象・対象外とも）。本文は handler で 1 回だけ読み、パース結果に対して `aws_profile` の除去と `_meta.AWS_REGION` の注入を行い、直列化は 1 回にする。本文が JSON でない・Content-Type が JSON でない場合は `default` でそのまま中継する。

エラー: `aws_profile` が文字列でない → 400 `invalid_aws_profile`、一覧にない（`__proto__` 等の prototype 由来の名前も不可）→ 400 `unknown_aws_profile`。どちらも認証後に判定し、STS・上流は呼ばない。

### キャッシュと CloudTrail

認証情報キャッシュのキーは `(利用者, roleArn)`。プロファイルごとに別エントリになる。STS の `RoleSessionName` は `gw-<利用者>-<プロファイル名>`（長い利用者名は利用者側を切り詰める）。CloudTrail でどのプロファイルのセッションか見分けられる。

### 下流リポジトリでの運用（fork 的運用）

実運用は private の下流リポジトリで行う。awsbridge を git の upstream として登録し、更新を pull し続ける。下流固有の設定は上流と衝突しにくい場所に置く。

1. `git remote add upstream <awsbridge の URL>` → `git pull upstream main` で追従する。
2. 自分の `wrangler.jsonc` に環境（例 `env.prod`）を追加し、`vars.AWS_PROFILES` に上記 JSON をコミットする（ロール ARN は秘密ではない）。`wrangler.jsonc` の `env.dev` にはダミー値のコメントがある。
3. `AWSBRIDGE_WRANGLER_ENV=prod` を付けて `build` / `dev` / `deploy:worker` を実行する（既定は `dev`）。
4. 各アカウントに `AWS_PROFILE=<対象> mise run deploy:aws` で CloudFormation を流し、出力 `RoleArn` を `AWS_PROFILES` に追記する。
5. 上流自身の開発用デプロイは、`mise.local.toml` の `AWSBRIDGE_PROFILES`（JSON 文字列）を `mise run secrets` が secret `AWS_PROFILES` として登録する。vars で `AWS_PROFILES` を持つ環境では、secret と二重定義にならないよう `AWSBRIDGE_PROFILES` を設定せずに `mise run secrets` を使う（`AWS_PROFILES` は登録されない）。

## MCP Server Portal 背後に置くことの制約

1. ポータル側の **Require user auth は Enabled 必須**（Disabled だと管理者資格で全員が接続する）
2. awsbridge 自体を self-hosted Access アプリにする（直 URL アクセスを Access で塞ぐ）。既存の `x-reader-mcp` / `seekio-mcp` と同じ構成
3. ポータルは tools 一覧を管理者資格で同期・キャッシュするため、`tools/list` への**ユーザー別** `aws_profile` enum 注入は効かない。認可は `tools/call` 側で強制する
4. ポータルの Code Mode（Required）では tools が 2 つに集約されるため、`aws_profile` 引数の説明が届きにくい

## セキュリティ上の注意

- Worker 署名鍵 = AWS への入口。漏洩すると任意の利用者として assume 可能。trust policy では `aud` と許可する `sub` を厳しく絞る
- IAM OIDC プロバイダーに登録する audience は awsbridge 専用のもののみ。ポータル（`mcp_portal`）の AUD を STS 信頼に使わない
- Access JWT は長寿命（観測値 ~30 日）。Access から外した利用者のトークンが残存しうるため、`iat` が古すぎるトークンの拒否や Access アプリのセッション短縮を検討
- `aws:SourceIp` 条件は実質使えない（Cloudflare egress）

### email の正規化

利用者識別子が `email`（既定）のとき、Worker は identity と STS 向け JWT の `sub` を小文字に正規化して照合する。email は大文字小文字を区別しない値で、IdP や入力経路によって表記が揺れても IAM 信頼ポリシーの `StringLike` 照合（大文字小文字を区別する）とずれないようにするため。`deploy:aws` も `AWSBRIDGE_ALLOWED_SUBJECTS` を小文字にして検証・CloudFormation に渡す。`sub` と `custom.*`（例: Entra の `oid`）は不透明な ID なので正規化しない。

### 認証情報キャッシュの残余リスク

Access JWT の検証は毎リクエスト行う。一方、STS から取得済みの認証情報は isolate 内にキャッシュされ、最大「有効期限 − 5 分」まで使われる。このため、Access から外した（または trust policy から外した）利用者でも、キャッシュ済みの認証情報は残り時間のあいだ有効なままになりうる。ただしその利用者は Access JWT の検証で弾かれるので、Worker 経由では使えない。リスクは「認証情報が Worker の外に漏れた場合」に限られる。`DurationSeconds` が 900 秒なら、最大で約 10 分。これを許容できないなら `DurationSeconds` を短くするか、キャッシュを無効にする。

### エラーと HTTP ステータスの対応

`/mcp` のエラー応答は `{"error":"<code>"}`。内部の詳細（STS の本文、例外メッセージ）は返さず、原因の種別だけをログに残す。

| 状況 | HTTP | code |
|---|---|---|
| Access JWT が無い・署名/iss/aud/exp が不正・Cookie のみ | 401 | `unauthorized` |
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
AWS_PROFILE=<対象> mise run deploy:aws   # CloudFormation（OIDC プロバイダー + ロール）をデプロイ。出力 RoleArn を控える

# Cloudflare 側（ロール ARN の反映）
# mise.local.toml に AWSBRIDGE_PROFILES（JSON 文字列。出力 RoleArn を並べる）を設定
mise run secrets            # Worker secret を一括登録（SIGNING_JWK / ACCESS_TEAM_DOMAIN / ACCESS_AUD / AWS_PROFILES）

mise run poc:sts            # 正常 1 + 否定 4 ケース（--role-arn 省略時はスタックの Output RoleArn。AWS_PROFILE で対象を選ぶ）
AWS_PROFILE=<対象> mise run destroy:aws  # 後片付け（CloudFormation スタックの削除）
```

`mise.local.toml` には `AWSBRIDGE_ISSUER` などに加えて `AWSBRIDGE_ACCESS_TEAM_DOMAIN`・`AWSBRIDGE_ACCESS_AUD`・`AWSBRIDGE_PROFILES` が要る。IAM 側のリソースは `infra/aws/awsbridge.yaml`（CloudFormation）で作る。マネジメントコンソールや StackSets でテンプレートを直接流してもよい（パラメーターは README の「AWS 側」を参照）。`AWS_PROFILE` と `AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_ROLE_NAME` / `AWSBRIDGE_AUDIENCE` は呼び出し側の環境変数が優先される（`mise.toml` は未設定時の既定値のみ）。

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
- JWKS は RSA 2048 の公開鍵 1 本。`kid` は JWK thumbprint（RFC 7638）、`use: "sig"`, `alg: "RS256"`
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
- 署名鍵をローテーションすると、STS 側の JWKS キャッシュにより一時的に検証失敗が起きうる。ローテーション時は新旧 2 本を JWKS に並べる期間を設ける必要がある（本実装の検討事項）

## 未決事項

1. ~~**PoC 残り**: Worker が出す discovery / JWKS を IAM が受理するか、Worker 発行 JWT で `AssumeRoleWithWebIdentity` が成功するか~~ → **解決**（[PoC 結果](#poc-結果構成-a-2026-11-05)）
2. ~~`aws_profile` を継承するか~~ → **解決**: 継承。各アカウントへ直接 AssumeRoleWithWebIdentity（[マルチアカウント](#マルチアカウントaws_profile)）
3. ~~`/mcp/assumerole/...` を廃止するか~~ → **解決**: 廃止（`aws_profile` に一本化）
4. 会社のセキュリティ方針上、A'（Worker 鍵を AWS が信頼）が許容されるか。不可なら C

## 参考

- [MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
