# PoC N6: Admin の階層の署名鍵を AWS KMS に置く

コンソールログインの Admin の階層では、JWT の署名鍵を取り出せない KMS の非対称鍵に置くことが決裁の条件（D4）。
この PoC はその成立を開発環境で確かめる。結果は cto の G1（Admin 側の発行の設計）に付ける。
前の PoC（人間のログイン）は [../human/README.md](../human/README.md)。

| # | 確かめること |
|---|---|
| K1 | KMS の非対称鍵（RS256 = RSA_2048 / RSASSA_PKCS1_V1_5_SHA_256、ES256 = ECC_NIST_P256 / ECDSA_SHA_256）で Worker が JWT に署名し、GetPublicKey から作った JWKS を discovery と一緒に配り、STS の AssumeRoleWithWebIdentity が通るか（SourceIdentity・セッションタグ付き。既存 PoC の Tagged と同じ信頼ポリシーの形） |
| K2 | Worker から KMS を呼ぶ認証情報の持ち方。PoC は最小権限の形（IAM ユーザーは kms:Sign だけ、鍵ポリシーでも縛る）で 1 つ動かす。ほかの候補は文書で比べる（決めない） |
| K3 | 所要時間: KMS の Sign の往復と、ログイン全体（署名 → STS → getSigninToken） |
| K4 | 監査: CloudTrail に Sign が残り、AssumeRoleWithWebIdentity と突き合わせられるか。DisableKey で発行が止まるまでの時間 |
| K5 | 鍵の差し替え: JWKS に新旧 2 つの kid を並べて切り替えられるか |

## 構成

```
手元（scripts/poc/admin-kms/*.ts）          Cloudflare（workers.dev）                     AWS（スタック awsbridge-admin-kms-poc）
  deploy.ts: GetPublicKey → JWKS ──────▶ Worker awsbridge-admin-kms-poc                  KMS の鍵 rsa（RSA_2048）・ec（ECC_NIST_P256）・rsa-next（RSA_2048）
  run.ts ──bearer──▶ POST /poc/login ──▶   KMS Sign（IAM ユーザーのアクセスキー）──────▶  鍵ポリシー: Sign は Worker のユーザーだけ・RAW だけ・方式は固定
                     POST /poc/sign          → JWT（header.payload.signature）
                                            → STS AssumeRoleWithWebIdentity（署名なし）──▶ OIDC プロバイダー（issuer = Worker）・ロール AwsbridgeAdminKmsPoc（権限なし）
                                            → getSigninToken（Federation）
                     GET /.well-known/openid-configuration・jwks.json（静的。deploy.ts が作る）
```

- claim は Worker が固定する（`iss`・`aud`・`sub`・`iat`・`exp`（5 分）・`jti`、入れ子形式のセッションタグ `access_profile=poc-admin`、SourceIdentity = sub）。
  呼び出し側の payload には署名しない。`sub` は個人の値にしない（既定 `awsbridge-kms-check`）
- `RoleSessionName` は `kms-<KMS の Sign の RequestId>`（K4 の突き合わせ用）
- `/poc/*` は Worker secret `CALLER_TOKEN` の bearer が必須。応答は所要時間・kid・成否・RequestId だけで、JWT・認証情報・SigninToken は返さない
- KMS の Sign は `MessageType: RAW`（JWT の署名対象は 1 KB 程度。4096 バイトの上限は lib.ts で検査する）。ES256 は KMS の DER 署名を r||s（64 バイト）に直す
- JWKS は deploy 時に GetPublicKey から作って静的に配る（JWKS を KMS の可用性に依存させない。Worker の認証情報は kms:Sign だけで足りる）
- アクセスキーは CloudFormation で作らない（秘密をスタックに残さない）。`access-key.ts create` が作り、権限 600 の一時ファイル経由で Worker の secret に入れて消す

ファイル:

- `lib.ts`（Worker と手順で共有する純粋関数: DER → r||s、JWS の組み立て、SPKI → JWK、claim、KMS の要求と応答、計測の集計）/ `handler.ts` / `worker.ts` / `wrangler.jsonc`: Worker。
  テストは `test/unit/poc-admin-kms-{lib,handler}.test.ts`、E2E は `test/e2e/poc-admin-kms.test.ts`（wrangler dev + 偽の KMS・STS・Federation）
- `poc-admin-kms.yaml`: CloudFormation（`mise run lint` の cfn-lint 対象）。テストは `test/unit/poc-admin-kms-template.test.ts`
- `ops.ts`（手順の純粋関数: 設定、Outputs、GetPublicKey、DisableKey の集計、CloudTrail の突き合わせ、伏せ字）。テストは `test/unit/poc-admin-kms-ops.test.ts`
- `deploy-aws.sh` / `deploy.ts` / `access-key.ts` / `run.ts` / `disable-watch.ts` / `trail.ts` / `destroy.sh`: 手順。テストは `test/unit/poc-admin-kms-scripts.test.ts`

## 前提

- `mise install`・`mise run install` 済み。`pnpm exec wrangler login` 済み。AWS プロファイル（既定 `awsbridge`）で CloudFormation・IAM・KMS を作れること
- `mise.local.toml`（gitignore）に次を書く

```toml
[env]
AWSBRIDGE_ADMIN_KMS_POC_ISSUER = "https://awsbridge-admin-kms-poc.<subdomain>.workers.dev"
```

上書きできる既定値（スクリプト側で補う）: `AWS_PROFILE`（awsbridge）・`AWS_REGION`（ap-northeast-1）・`AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME`（awsbridge-admin-kms-poc。この名前で始まるものだけ）・
`AWSBRIDGE_ADMIN_KMS_POC_AUDIENCE`（awsbridge-admin-kms-poc）・`AWSBRIDGE_ADMIN_KMS_POC_SUBJECT`（awsbridge-kms-check）・`AWSBRIDGE_ADMIN_KMS_POC_OUT_DIR`（.secrets/poc-admin-kms）

## 実行順

IAM は OIDC プロバイダーを作るときに issuer の `.well-known/openid-configuration` を読む（読めないと作成が失敗する）。
JWKS には鍵が要るので、スタックを 2 段階でデプロイする。

```sh
mise run poc:admin-kms:deploy-aws -- --keys-only   # 1. 鍵 3 つと IAM ユーザーだけ
mise run poc:admin-kms:deploy                      # 2. Worker（JWKS は rsa だけ。ROLE_ARN は空）。[OK] が 2 行
mise run poc:admin-kms:access-key -- create        # 3. アクセスキー → Worker の secret（CALLER_TOKEN も）
mise run poc:admin-kms:deploy-aws                  # 4. OIDC プロバイダーとロールを足す
mise run poc:admin-kms:deploy                      # 5. Worker（ROLE_ARN を入れる）
mise run poc:admin-kms:run -- --key rsa            # K1 RS256
mise run poc:admin-kms:deploy -- --jwks rsa,ec     # K1 ES256 の準備（JWKS に ec を足す）
mise run poc:admin-kms:run -- --key ec             # K1 ES256
mise run poc:admin-kms:run -- --mode sign --key rsa --variant digest   # K2 Worker でも DIGEST・PSS は鍵ポリシーで拒否されるか（--variant pss）
mise run poc:admin-kms:run -- --mode sign --key rsa --n 30             # K3 Sign の往復
mise run poc:admin-kms:run -- --key rsa --n 10 --interval-ms 1000      # K3 ログイン全体
mise run poc:admin-kms:deploy -- --jwks rsa,rsa-next                   # K5 新旧を並べる → --key rsa-next / rsa で run
mise run poc:admin-kms:deploy -- --jwks rsa-next                       # K5 旧を外す → --key rsa で run（拒否されるはず）
mise run poc:admin-kms:disable-watch -- --key rsa                      # K4 DisableKey → 止まるまで → EnableKey
mise run poc:admin-kms:trail -- --since <開始時刻 UTC>                  # K4 CloudTrail（反映に数分かかるので最後に）
mise run poc:admin-kms:access-key -- delete        # 片付け 1（destroy も先に消す）
mise run poc:admin-kms:destroy                     # 片付け 2（鍵は 7 日後の削除の予約。予定日を出す）
```

記録は `<OUT_DIR>/runs.jsonl`・`disable-watch.jsonl`（JWT・認証情報は入らない）、鍵の ARN は `kms-keys.txt`（destroy が書く）。

## 結果の要約（2026-11-12、開発用アカウント 1 つ、ap-northeast-1、Worker の colo は NRT）

詳細と未測定の項目は、リポジトリの外の引き継ぎの記録（gitignore の `.claude/handover/`）にある。

- **K1 成立**: RS256（RSA_2048）も ES256（ECC_NIST_P256）も、KMS で署名した JWT で AssumeRoleWithWebIdentity が通った（SourceIdentity・セッションタグ付き。
  RSA だけの JWKS → RSA と EC を並べた JWKS の順で確かめ、混在でも RS256 は通った）。getSigninToken も通った
- **K2**: IAM ユーザー（kms:Sign だけ・3 つの鍵だけ）＋鍵ポリシー（Sign は Worker のユーザー以外・RAW 以外・方式違いを Deny）で動いた。
  AdministratorAccess の管理者でも Sign は鍵ポリシーの明示的な Deny で拒否、Worker のユーザーでも DIGEST・PSS は拒否された。
  鍵ポリシーで縛れたのはメッセージの形式（kms:MessageType）と方式（kms:SigningAlgorithm）で、署名する中身を縛る条件キーは KMS の文書で見た範囲には見当たらなかった
  （見つからない限り、Sign を呼べる者は任意の Admin のトークンを作れる前提で考える）
- **K3**: Worker（NRT）→ KMS（ap-northeast-1）の Sign の往復は中央値 11 ms（p90 36〜39 ms、初回 32〜45 ms）。
  ログイン全体（署名 → STS → getSigninToken）は 2 回目以降の中央値 約 210 ms（p90 約 500 ms、初回 約 700 ms）で、大半は getSigninToken（中央値 約 163 ms）
- **K4**: CloudTrail に Sign が残る（呼び出した IAM ユーザー・アクセスキー ID・鍵・方式・MessageType。署名の中身は残らない）。
  AssumeRoleWithWebIdentity の `requestParameters.webIdentityTokenId` が JWT の `jti` と一致した（28/28）。
  Worker が RoleSessionName に入れた KMS の RequestId でも全件対になった（28/28）。送信元 IP は Sign と STS で 28 組すべて違った。
  DisableKey で発行が止まりきるまで（最後の成功）: 1 回目は CLI の完了から +5.3 秒（最初の失敗は +2.1 秒で、その後も成功が混ざった）、2 回目は完了後の成功 0（最初の失敗 +1.1 秒）
- **K5**: JWKS に新旧 2 つの kid を並べ、新しい鍵での署名がデプロイ直後の 1 回目から通った。旧い kid を JWKS から外すと、直後の旧鍵の署名は InvalidIdentityToken で拒否された（各 1 回の観察）
