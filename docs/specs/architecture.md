# awsbridge アーキテクチャ仕様（初版・設計合意メモ）

- 作成日: 2026-11-05
- 状態: 設計合意済み / 構成 A' の PoC 完了（2026-11-05、[PoC 結果](#poc-結果構成-a-2026-11-05) 参照）
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
   │ 5. 必要ならチェーン AssumeRole（ASSUME_ROLE_ARN / aws_profile）
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
| `ASSUME_ROLE_ARN`（チェーン） | 継承。起点は federated ロール。チェーンのセッションは最大 1 時間 |
| `_meta` への AWS リージョン注入 | 継承 |
| `ALLOWED_DOMAINS` / `ALLOWED_EMAILS` | 廃止（Access ポリシーに一本化） |
| `COOKIE_SECRET` / `SIGNING_KEY_HEX`(OAuth 用) / DynamoDB ストア | 廃止（OAuth を持たない） |
| `aws_profile` | **未決**（下記）。継承する場合は federated ロール起点のチェーンに再設計 |
| `/mcp/assumerole/...` パスルーティング | **未決**（推奨: 廃止して `aws_profile` に一本化） |
| `AWS_PROFILE_CONFIG_S3` | 継承する場合は KV か wrangler var に移す（S3 を読む認証情報が無いため） |

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

## テスト方針

- Unit: vitest + `@cloudflare/vitest-pool-workers`。JWT 検証・JWT 発行・STS XML パース・SigV4・claim マッピング（Google / Entra フィクスチャ）
- E2E: `wrangler dev` + mock（JWKS を出す擬似 Access、擬似 STS、SigV4 を検証する擬似 MCP Server）。STS / MCP エンドポイントは env で差し替え可能にする
- コマンドは `mise run test` / `test:unit` / `test:e2e` / `lint` / `fmt` / `build` / `dev`

## PoC 結果（構成 A'、2026-11-05）

未決事項 1 の検証。Worker（`*.workers.dev`）を OIDC issuer として IAM に登録し、Worker と同じ署名コード（`src/oidc.ts` の `signStsToken`）で発行した JWT で STS を呼んだ。**構成 A' は成立する。**

再現手順（値は `mise.local.toml` に置く。アカウント ID・email・Worker の URL はリポジトリに入れない）:

```
mise run keygen             # 開発用 RSA 鍵を .secrets/ に生成
mise run deploy:worker      # Worker をデプロイ
mise run secret:signing-key # 秘密鍵 JWK を Worker secret SIGNING_JWK に登録（Worker 作成後）
mise run deploy:aws         # CloudFormation（OIDC プロバイダー + ロール）をデプロイ
mise run poc:sts            # 正常 1 + 否定 4 ケース（ロールはスタックの Output RoleArn）
mise run destroy:aws        # 後片付け（CloudFormation スタックの削除）
```

2 回目以降は `mise run deploy`（`deploy:worker` → `deploy:aws` を順に実行）でよい。IAM 側のリソースは `infra/aws/awsbridge.yaml`（CloudFormation）で作る。

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
2. `aws_profile` を継承するか
3. `/mcp/assumerole/...` を廃止するか
4. 会社のセキュリティ方針上、A'（Worker 鍵を AWS が信頼）が許容されるか。不可なら C

## 参考

- [MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
