# コンソールログイン: Admin 側の発行の設計（X1: Cloudflare で完結）

- 作成日: 2026-11-12
- 改訂: 2026-11-12（後半の cto の決裁と利用者の判断）。この文書は G1（Admin の署名を AWS の KMS に置く）の資料だった。決裁「Administrator の発行を Cloudflare で完結」（X1）に合わせて、本文を X1 の設計に書き直した。(1) Admin も Cloudflare の Worker で署名する。鍵は Workers の `secret_key` 型（取り出せない `CryptoKey`）。別の Worker・別の issuer・別の鍵・別のホスト（D3 は保つ）。(2) Admin の issuer は Cloudflare の別ホストの `/admin`（I-B）に戻った。(3) 受容の文面（4 点）と補う手段、鍵の差し替え（別の名前・新旧 2 つの `kid`・90 日以下）、停止、Access JWT の追加の検査、`key-check`、G2・G5 の条件を書いた。(4) C-4（AWS 側の署名役）・I-C（AWS 側の issuer）・KMS の設計と PoC（N6・G1-b）は消さず、「退避先」（付録 A）に移した
- 状態: 設計は X1 で定まっている。X1 は **① の実装と ② の個人の環境について条件付きで承認**された（cto の決裁）。**③ の会社の Administrator は承認されていない**（G5 で会社のセキュリティの承認を取る）。実装は PR #27（未マージ）が Admin の Worker の署名までを入れた。何が実装済みかは [console-login.md](console-login.md) §7.4.1 にまとめた
- 対象: Administrator（Admin の階層）のコンソールログインの発行。署名鍵の持ち方、別の Worker と発行のオリジン、Admin の issuer、受容と補う手段、鍵の差し替え、停止、監査、セッションの長さ、P1・P2、D2、G2 と G5 の条件
- 関連:
  - [console-login.md](console-login.md): 全体設計。この文書は §2.2（D3・D4）・§3.1（Admin の issuer）・§4.8（Admin の階層の守りの部品）・§6（停止）・§7（段階導入と G1〜G5）を前提にする
  - [console-login-portal.md](console-login-portal.md): ポータル。この文書は §8（P1'）・§9.3（検査の 9 段）・§9.10（バンドルの分離）・§10（非機能・監査ログ）・§11（設定）を前提にする
- 表記: console-login.md と同じ。**[確認済み]** 一次資料（出典つき）や PoC で確かめたもの、**[資料]** 設計文書と cto の決裁にあるもの、**[推測]** 作成者の推論、**[未検証]** まだ試していないもの・調べて分からなかったもの
- PoC の道具について: N6 の道具は `scripts/poc/admin-kms/` にコミット済み(手順は `scripts/poc/admin-kms/README.md`)。G1-b と X1 の道具は未コミットで、このリポジトリのブランチにはない。2026-11-12 の PoC(N6・G1-b・X1)の結果はこの文書に要約を入れた。識別子（アカウント ID・鍵 ID・AUD・email・ドメイン）は書かない
- 値の表記: 実ドメインは `<domain>`、Admin の issuer のホストは `<admin-issuer-host>`、アカウント ID は `<account-id>` と書く。実際の値は書かない（awsbridge は public リポジトリ）

## 目次

1. 前提（決裁済みのこと）
2. 構成
3. 発行の流れ
4. 署名鍵（`secret_key`）
5. 受容と補う手段
6. 鍵の差し替え
7. 停止
8. 監査と検知
9. Admin のセッションの長さ（D6）
10. P1・P2（プロバイダーの統合）
11. D2（別リポジトリにするか）
12. G2 と G5 の条件、実装の状態
13. 決まったことの行き先と未決事項
- 付録 A. 退避先: C-4（AWS 側の署名役）・I-C（AWS 側の issuer）・KMS

---

## 1. 前提（決裁済みのこと）

| 項目 | 決まっていること | 出典 |
|---|---|---|
| 分離 | コンソールログイン用は MCP 用と別の Worker・issuer・鍵・Access アプリ・ロール・audience（制約 1）。MCP 用のバンドルにコンソールログイン用の経路が入らないことをテストで確かめる（D2） | [資料: cto の決裁（制約 1・D2）] |
| 鍵の分け方 | 階層（Standard / Admin）× 境界（管理下 / 管理外の先方ごと）。1 つの issuer に 1 つの鍵（D3）。**Admin は Standard と別の Worker・別の issuer・別の鍵・別のホスト**（D3 は X1 でも保つ） | [資料: D3、X1 の条件 (a)] |
| Admin の鍵 | **Workers の `secret_key` 型の署名鍵**（取り出せない `CryptoKey`。Admin の署名は Cloudflare で完結する）。D4 の「Admin は KMS 必須」は、X1 の決裁で人の受容に置き換わった（D4 は危険を下げる上乗せの層で、文書が正直なら偽になる主張が無い）。受容する人は、被害範囲の持ち主（② は利用者本人、③ は会社） | [資料: X1 の決裁と利用者の判断（2026-11-12）] |
| Standard の鍵 | Standard も `secret_key` に揃える（Admin の実装のあとの別 PR で、G2 までに。② は最終の形で試験する）。条件は §4.5。**「会社で Administrator を配る前まで Workers secret」という D4 の期限は無くなった**（X1 の決裁の「消える」に D4 の言い直しが入っている [推測: 文面の読み]） | [資料: 「Standard も secret_key に揃える」の決裁] |
| 入口と発行のオリジン | **P1'**: 入口と一覧は Standard と Admin で共通。Administrator の行は Admin のオリジンの S2 へのリンク（GET）。発行（S2 の POST）は **Admin のオリジンの Admin の Worker だけ**。Standard の Worker は代わりに行わない。同じホストのパス分けは不可 | [資料: 2026-11-12 の P1'。portal §8] |
| Admin の issuer | **I-B で確定**: Cloudflare の別ホストの `/admin`。Admin の Worker が discovery と JWKS を出す。Standard の issuer のホストとも、ポータルのホストとも別。実値は環境ごと | [資料: X1 の決裁（A-3 は I-B に戻る）] |
| Standard のバンドル | Admin の情報は表示用だけ（Administrator の行と、Admin のチームの Object ID）。Admin のチームの AUD・Access のポリシー ID・Admin の鍵の参照は入れない | [資料: P1'・U2。portal §9.10] |
| 自前の JWT | `azp` を出さない。`transitive_tag_keys` を設定しない。SourceIdentity 必須（email） | [資料: P1' の条件、3-B、2026-11-12 の SourceIdentity の決裁] |
| Admin の守りの部品 | Standard の部品に、`aws login --remote` の明示の Deny を足したもの。事故防止で、強制の境界ではない（Administrator は外せる）。監査の Deny（CloudTrail・Config・GuardDuty などの停止・削除）の中身は G2 で決める | [資料: console-login.md §4.8、G1 の決裁 A-12] |
| セッションの長さ | Admin はロールの `MaxSessionDuration` を **1 時間**にする。② で実際に切れるかを測る | [資料: D6、G1 の決裁 A-8] |
| P1・P2・P3 | **P1' のまま**（G1 の決裁 A-9）。P3 は却下 | [資料: 2026-11-12 の決裁] |
| 承認の範囲 | X1 は ① の実装と ② の個人の環境まで。③ の会社の Administrator は承認していない（G5 で会社のセキュリティの承認を取る。取れなければ X3 か X2 [資料: 決裁に名前だけがあり、X2・X3 の中身はこのリポジトリの資料に無い]） | [資料: X1 の決裁] |
| 人の判断 | Administrator の発行は X1（Cloudflare で完結）を選んだ。② について、受容の文面（§5.1 の 4 点）に受容した。X1 の受容の文面と補う手段への Sol のレビューは G2 に付ける（2026-11-12） | [資料: 利用者の判断] |

---

## 2. 構成

```
利用者のブラウザ
  │ ① 共通の入口（Standard のオリジン https://portal.<domain>/）の一覧で Administrator の行を選ぶ（GET のリンク）
  ▼
Cloudflare Access（Admin の階層のチームのアプリ: https://admin-portal.<domain>/t/<team>/）
  ▼
Admin の Worker（Admin のデプロイ。Admin のオリジンと Admin の issuer のホストだけ）
  │ ② S2（確認）→ ③ POST /t/<team>/login → 検査の 9 段（portal §9.3）と Access JWT の追加の検査（§3.1）
  │ ④ JWT の claim を組み、Workers の secret_key（取り出せない CryptoKey）で署名（§3.2）
  │ ⑤ STS AssumeRoleWithWebIdentity（各アカウント）
  ▼
各アカウント: Admin のプロバイダー（https://<admin-issuer-host>/admin）＋ Administrator のロール（/awsbridge-console/admin/）＋ Admin の守りの部品
  ▼
getSigninToken → 302 でコンソール（aws login は同じ端末だけ）

issuer の公開文書（discovery と JWKS）: Admin の Worker が <admin-issuer-host>/admin/... で出す（公開鍵は vars）
```

| 部品 | 内容 | 置き場所 |
|---|---|---|
| Admin の Worker | Admin のオリジンの S1〜S5 と発行（POST）、`key-check`、Admin の issuer の discovery と JWKS。Standard の一覧の行・Standard の鍵・Standard のチームの AUD・入口の AUD を持たない | 別の Worker デプロイ（`wrangler.console-admin.jsonc`）。`workers_dev: false`・`preview_urls: false`。互換フラグ（`nodejs_compat`・`webcrypto_modern_algorithms`）は使わない |
| 発行のオリジン | `https://admin-portal.<domain>`（設定の `portal.adminOrigin`）。Standard のオリジン（`portal.standardOrigin`）と別のホスト | Custom Domain |
| Admin の issuer のホスト | `https://<admin-issuer-host>`（設定の `boundaries[].issuers.admin` は `https://<admin-issuer-host>/admin`）。Standard の issuer のホストとも、ポータルのホストとも別。Access アプリは置かない | Custom Domain |
| 署名鍵 | 管理下の Admin の鍵 1 つ（差し替えの間だけ 2 つ。§6）。Worker の `secret_key` バインディング。公開鍵は vars | Cloudflare（§4） |
| Admin のプロバイダー | 基盤のスタックの Admin のプロバイダー。**まだ実装していない**（§12.3） | Administrator を配る各アカウント |
| Administrator のロール | `/awsbridge-console/admin/` の下。信頼ポリシーの `Principal` は Admin のプロバイダー 1 つだけ。`MaxSessionDuration` は 1 時間（§9） | 同じ |
| Admin の守りの部品 | 顧客管理ポリシー（console-login.md §4.8 の Admin の列） | 基盤のスタック |
| Access アプリ | Admin の階層のチームごと（`admin-portal.<domain>/t/<team>/`）。**すべてのチームのアプリで Cookie Path を有効にする**（§3.1）。Admin の Worker の設定にだけ AUD を入れる | Cloudflare |

### 2.1 Admin の issuer の形（I-B で確定）

| 案 | issuer | 扱い |
|---|---|---|
| I-A（同じホストの `/admin`） | `https://<issuer-host>/admin` を Workers Routes で Admin の Worker に向ける | **不採用**。Routes の設定を変えられる者が Admin の JWKS を差し替えられる [資料: Sol のレビュー（G1）の指摘 3]。パスで別の Worker に振り分ける形の確認（P-9）は要らない |
| **I-B（別ホスト）** | `https://<admin-issuer-host>/admin`。Custom Domain で Admin の Worker に向ける | **確定**（X1 の決裁で、A-3 は I-B に戻った） |
| I-C（AWS 側に静的に置く） | S3 / CloudFront の既定のドメイン + `/admin` | 退避先（付録 A.3）。G1・G1-b で第一候補だった |

- 生成器（`src/console/config.ts`。PR #27 と #26）は、Admin の issuer の次の誤りを生成の時点で止める: パスが `/admin` でない（`admin_issuer_path`）、Admin の issuer を持つ境界が複数ある（`admin_issuer_multiple`。Admin の鍵と JWKS は 1 組）、ホストが Standard の issuer のホストと同じか入れ子（`admin_issuer_host_shared`）。さらに、どの issuer のホストも、ポータル（Standard・Admin）とホスト方式のチームのホストと同じか入れ子なら止める（`issuer_host_overlaps_portal`。ラベル単位で比べる。G-8）
- **I-B でも、同じ Cloudflare の管理権限からは隔てられない**。Admin の issuer の JWKS・DNS・Routes・Custom Domain・Worker のデプロイを変えられる者は、攻撃者の鍵を JWKS に載せるか、Worker のコードを変えて、任意の Admin の JWT を作れる。X1 ではこれが受容の 4 点目になる（§5.1）。鍵を取り出せないことは、これを防がない
- Admin のオリジンと Admin の issuer のホストで、Access を迂回する入口（workers.dev・Preview URL・ほかの Route）を塞ぐ確認は残る（console-login.md §5.4 の「Access を経由しない入口」。引き継いだ条件 (2) と同じ型）。Admin の issuer のホストに Access が掛かる環境では、discovery と JWKS の 2 つのパスに Bypass が要る [資料: PR #27 の注意。実物では確かめていない]
- Admin の Worker は、チームのパスと Admin の issuer の 2 つの文書のパス以外を、処理の最初（env も Access JWT も見る前）に 404 にする [資料: G-6 の承認。PR #23・#27]

### 2.2 配布とデプロイの順

**IAM は OIDC プロバイダーを作るときに、issuer の `.well-known/openid-configuration` を読み、読めないと作成が失敗する**（`Please check .well-known/openid-configuration of provider ... is valid`）[確認済み: N6 の途中で分かったこと]。そのため、issuer（Admin の Worker）を先に公開してから、各アカウントにプロバイダーを作る順番が要る。

| 段 | 操作 | 置き場所 | 確かめること |
|---|---|---|---|
| 1 | 署名鍵を作る（手元のメモリで作り、`secret_key` として Worker に投入する。§4.2） | Cloudflare | 鍵の名前と `kid` が出る。投入した鍵が取り出せない（`console:admin-key:check`） |
| 2 | 公開鍵（`ADMIN_PUBLIC_JWKS`）と今の鍵（`ADMIN_CURRENT_KEY`）を vars に入れ、Admin の Worker をデプロイする | Cloudflare | discovery と JWKS が公開されていて、`kid` が鍵と一致する |
| 3 | Admin のプロバイダー（基盤のスタック）と Administrator のロールを配る | 各アカウント | プロバイダーの作成が成功する。引き受けが通る |

- 決裁のデプロイの順は 鍵 → Worker → プロバイダー [資料: X1 の決裁]。README の手順（鍵の投入 → vars に公開鍵を入れる → デプロイ）はこの順に当たる。新しい Worker に最初の鍵を投入するとき、Worker のスクリプトが先に存在している必要があるかは確かめていない [未検証]
- 世代つきの新しいパスに移るとき（§6.3）も、新しい issuer を先に公開してから新しいプロバイダーを配る

---

## 3. 発行の流れ

[資料: portal §8・§9.3、X1 の決裁。実装は PR #27 と #23]

1. 利用者は共通の入口（Standard のオリジンの S0）で Administrator の行を選ぶ。行はその行のチームのパスの Admin のオリジンの S2 へのリンク（GET）。Standard の Worker は Admin の発行を代わりに行わない
2. Access（Admin の階層のチームのアプリ）を通り、Admin の Worker が S2（確認）を返す。CSRF トークンの鍵（`csrf_key`）は Admin の Worker だけの secret（Standard と共有しない [推測]）
3. `POST /t/<team>/login`。検査の 9 段（portal §9.3）は Standard と同じ。違いは次の点だけ:
   - 手順 1〜2: Access JWT の検査に §3.1 の追加の検査を足す。AUD → チームの対応は **Admin の階層のチームだけ**（Standard のチームの AUD と入口の AUD は未知として断る）
   - 手順 3: `Origin` は `portal.adminOrigin` と完全一致
   - 手順 7: `entry` は **Admin の階層の行だけ**
   - 手順 9: 署名は §3.2。署名の部品が接続されていない・使えないときは 503 `signing_unavailable`（G1 の決裁 A-11。STS と `getSigninToken` を呼ばない）
4. `AssumeRoleWithWebIdentity`（`DurationSeconds` はロールの `sessionSeconds`）→ `getSigninToken`（`SessionDuration`）→ 発行記録 → 302

### 3.1 Access JWT の追加の検査

X1 の条件 (f): AWS 側の署名役に求めた検査を、Admin の Worker に求める。Standard では掛けないものを含む [資料: X1 の決裁、G1-b の決裁 A-2 の (1)〜(4)]。

| 検査 | 内容 | 根拠・実装 |
|---|---|---|
| aud はちょうど 1 つ | Admin のチームの AUD の表にあること。2 つ以上（混在）は断る。入口の AUD と Standard のチームの AUD は発行に受けない | **G1-b の PoC で、Cookie Path が無効のとき、Standard の階層のアプリで得た JWT の aud に 2 つの AUD が入り、aud の完全一致を見ない実装で Admin の JWT が発行された**（2 回）[確認済み: A.4 の P-a]。実装は PR #18（jose の `audience` は使わず、検証後に自分で判定する）|
| 人であること | `email` が空でない。`sub` が空でない。`common_name` があれば断る（サービストークン） | サービストークンの実物は `common_name` があり `sub` が空。`type` はどちらも `app` で、種別の判定に使えない [確認済み: A.4 の P-a]。実装は PR #18 |
| 鮮度 | `iat` を必須にし、`iat` からの経過時間に上限を掛ける（既定 900 秒 = Admin の Access のセッションの長さ。vars `ACCESS_MAX_AGE_SECONDS`）。未来の `iat`（30 秒超）と上限超えは 401。`exp`・`nbf` も見る | Cookie Path が無効のとき、`exp - iat = 86400` の JWT が Admin のパスに届いた [確認済み: A.4 の P-a]。実装は PR #27（Admin だけ。Standard の振る舞いは変えない）。**Access アプリのセッションの長さを、この値に揃える**必要がある |
| JWT の検証の仕様 | アルゴリズムは RS256 に固定。JWKS はチームドメインから取る（静的に持たない）。未知の `kid` と取得の失敗は断る | [資料: G1-b の決裁 A-2 の (4)]。実装は PR #18（JWKS はチームドメインごとにキャッシュ）。入力の大きさの上限と必須 claim の型の検査は、G2 で確かめる [未検証] |
| Cookie Path | **Standard も Admin も、すべてのチームのアプリで Cookie Path（`path_cookie_attribute`）を有効にする**（R-P の要件）。無効だと、同じホストの別のアプリの AUD も JWT の `aud` に入る。aud ちょうど 1 つの検査で断られるので、破れるのは可用性だが、ログインができなくなる | [資料: G1-b の決裁]。Access の Terraform・設定の検査・README に要件として書く(**未着手**)。生成器や検査での強制も未実装（§12.3） |

### 3.2 署名

1. JWT のヘッダー `{"alg":"RS256","kid":"<今の鍵の kid>","typ":"JWT"}`。`kid` は公開鍵の RFC 7638 の thumbprint
2. claim: `iss`（Admin の issuer）、`aud`（`awsbridge-console`）、`sub`（email）、`https://aws.amazon.com/tags`（`principal_tags.awsbridge_team` だけ。`transitive_tag_keys` なし）、`https://aws.amazon.com/source_identity`（email）、`jti`（一意）、`iat`、`exp`（`iat + 300`）。`azp` は出さない。値は Admin の Worker が検証済みの Access JWT とチームの表から決め、利用者の入力は使わない
3. 署名は WebCrypto の `RSASSA-PKCS1-v1_5` / SHA-256。JWS は WebCrypto だけで組む。署名のたびに、バインディングを検査し（§4.3）、返す JWT の形を照合し、vars の公開鍵で自己検証する。どれかが合わなければ発行せず 503 `signing_unavailable`
4. 発行記録に `jti`・`kid`・STS の応答の 3 つの ID を残す（§8）

- アルゴリズムは RS256。今の MCP 用と Standard の鍵・`src/keys.ts` と同じ形で、DER の変換が要らない [推測]。ES256 は KMS の PoC（N6）で通ったが、`secret_key` の PoC（X1）では RSASSA-PKCS1-v1_5 だけを試した。ES256・RSA-PSS・`pkcs8` / `key_base64` の形式は試していない [確認済み: PoC X1 の K1]

### 3.3 `key-check`

デプロイ後の確認のための経路。`GET <team-base>/key-check` は、Admin のチームの Access の検証と回数の制限（キー `admin-key-check:<sub>`）の後ろで、Admin の Worker だけが返す。**署名は返さない**。返すのは、鍵の性質（`CryptoKey` であること、取り出せないこと、`exportKey` が失敗すること、vars の公開鍵での自己検証）と `kid` だけ [資料: PR #27]。`mise run console:admin-key:check` が、バインディングの型・discovery と JWKS・`key-check` を続けて確かめる。**本物の `secret_key` のバインディングが Worker の検査を通ること、secrets の API の応答の形は、PR #27 の時点で実物では確かめていない**（最初の実物の確認がこの `check`）。

---

## 4. 署名鍵（`secret_key`）

### 4.1 鍵

| 項目 | 内容 |
|---|---|
| 形 | RSA 2048 bit 以上、RS256（`RSASSA-PKCS1-v1_5` / SHA-256）。Workers の `secret_key` バインディング（`format: jwk`、`usages: ["sign"]`、`extractable` は false）。公開指数は 65537 |
| バインディングの名前 | `ADMIN_KEY_<kid の先頭 8 バイトの 16 進>`。`kid` から決める。**同じ名前への投入は、直後から鍵を置き換える**（K6 (4)）ので、道具は既存の名前を断る。新しい鍵は必ず別の名前 [資料: 「Standard も secret_key に揃える」の条件 (d) と同じ規則。実装は PR #27] |
| 公開鍵 | vars `ADMIN_PUBLIC_JWKS`（新旧 2 つまで）。Admin の issuer の JWKS と自己検証に使う。`webcrypto_modern_algorithms` の `getPublicKey` は使わない（ドラフトの実装で、API が変わりうると文書にある）[資料: Standard の条件 (a)] |
| 今の署名鍵 | vars `ADMIN_CURRENT_KEY`（バインディングの名前と `kid` の組） |
| 置き場所 | Cloudflare の Admin の Worker だけ。Standard の Worker・MCP 用の Worker とは共有しない |
| 自動のローテーション | 無い。差し替えは新しい鍵を別の名前で入れて切り替える（§6） |

### 4.2 投入

- 鍵は**手元の道具の中のメモリで作り**、Cloudflare の API（`PUT /accounts/{account}/workers/scripts/{script}/secrets`）で `secret_key` として入れる。ファイルに書かず、表示もしない。手元の写しは残さない。CI とログを通さない [資料: X1 の条件 (c)]。wrangler には `secret_key` を入れるコマンドが無い（`secret put` は文字列だけ）[確認済み: PoC X1 の K1]
- 投入は人が手元で行う。CI に secret の書き込みのトークンを置かない。**Admin の Worker のトークンと Standard の Worker のトークンは分ける**（トークンが無いときは `wrangler login` の OAuth をメモリの中だけで使う）[資料: Standard の条件 (e)。実装は PR #27]
- 道具: `mise run console:admin-key:put`（既定は dry-run。`--yes` で投入）、`console:admin-key:retire`、`console:admin-key:check`、`secrets:scan`（gitleaks）。手順は README

### 4.3 バインディングの検査と自己検証

署名のたびに次を確かめる。合わなければ発行せず 503 `signing_unavailable` [資料: Standard の条件 (b)(c) と同じ規則。実装は PR #27]。

- バインディングが `CryptoKey` で、private、`extractable` が false、`usages` が sign だけ、アルゴリズムが RS256、2048 bit 以上、公開指数が 65537
- Worker の中で `exportKey` が失敗する
- 署名した JWT を vars の公開鍵で検証できる（自己検証）
- 文字列の秘密鍵（JWK）を読む経路と、試験用の鍵の作り方は、本番のバンドルに入れない（バンドル試験で確かめる）

### 4.4 PoC X1 の結果

開発環境（開発用の AWS アカウント 1 つ・東京リージョン、Cloudflare の開発用アカウント、Worker の colo は NRT、wrangler 4.112.0）で、2026-11-12 に行った。AWS と Cloudflare の資源は片付けた（スタックなし・ロール 0・PoC のプロバイダー 0・Worker 0。KMS は呼んでいない）。回数が少ない測定は回数を書いた [確認済み: PoC X1]。

| # | 結果 | 要点 | 未測定・注意 |
|---|---|---|---|
| K1 | **成立** | API に `type: secret_key`、`format: jwk`、`algorithm: RSASSA-PKCS1-v1_5 / SHA-256`、`usages: ["sign"]`、`key_jwk` を送ると HTTP 201（新規 2 回）、同じ名前への置き換えは HTTP 200。応答は `name` と `type` だけ | wrangler には入れるコマンドが無い。`pkcs8` / `key_base64`・ES256・RSA-PSS は試していない |
| K2 | **成立** | `env.<名前>` は `CryptoKey`（private・`extractable` false・`usages` は sign だけ）。`exportKey` は jwk・pkcs8・spki・raw のすべて、`wrapKey` も `InvalidAccessError`。用途外の操作も失敗。`structuredClone` は `DataCloneError`。`JSON.stringify(key)` に秘密の値は無い。`process.env` には入らない。`node:crypto` の `KeyObject.from(key).export()` も失敗した | **Worker のコードを変えられる者（Workers Scripts の書き込み権限）は、任意の JWT に署名できる**（鍵を持ち出せないだけ）。手元の Node 24.21.0 では、同じ経路（`KeyObject.from` → `export`、`toCryptoKey(…, true)` → `exportKey`）で取り出せない鍵を書き出せた。workerd は本番と手元（wrangler dev の workerd 1.20260714）の両方で塞いでいた。試していない経路（ほかの Node 互換 API・将来の workerd の変更）はありうる |
| K2 補足 | `getPublicKey` が使える | 互換フラグ `webcrypto_modern_algorithms` を付けると、`CryptoKey` から公開鍵を得られる | ドラフトの実装。公開鍵は vars で渡す形にした（K5・K6 はこの形で通した） |
| K3 | **成立** | 投入の直後と後から、secret の一覧・取得、設定、本体のダウンロード、`content/v2`、版と最新版の詳細、deployments、`services/.../settings`、`wrangler secret list` を走査した。秘密成分の値の一致は 0。取得は `name` と `type` だけ | ダッシュボードの画面・Logpush・Tail・監査ログは見ていない |
| K4 | **成立** | 鍵があった状態で、`wrangler deploy` 4 回・`--keep-vars` 1 回・`versions upload` → `versions deploy` 1 回のどの後も、鍵が `CryptoKey` のまま残った（別の鍵でも `deploy` 3 回の後に残った） | **`wrangler secret put`（別の secret の更新）・`secret bulk`・ダッシュボードからのデプロイ・Workers Builds 経由は測っていない** |
| K5 | **成立** | Worker が `CryptoKey` で署名した JWT（`aud`・`sub`・入れ子のセッションタグ・SourceIdentity・`jti`・`exp = iat + 300`）で、信頼ポリシーが aud・sub・RequestTag・TagKeys・`sts:SourceIdentity` を照合するロールの `AssumeRoleWithWebIdentity` が通った。13 回成功（鍵 a が 3 回、鍵 b が 10 回）。STS の往復は 18〜340 ms | `getSigninToken` は呼んでいない（N6 で確認した経路と同じ）。CloudTrail での `jti` の突き合わせはしていない |
| K6 | **成立（各段 1〜3 回の観察）** | (1) 新しい鍵 b を別の名前で入れて JWKS に a・b を並べると両方通った。(2) JWKS から a を外すと、a の署名はデプロイ直後から `InvalidIdentityToken`（約 45 秒で 3 回）、b は通った。(3) `DELETE .../secrets/<名前>`（HTTP 200）の直後から、Worker にバインディングが無くなり login は失敗した。(4) 同じ名前への PUT は直後から新しい鍵に置き換わり、旧い `kid` の署名は拒否された | 同じ名前の置き換えでは「新旧を並べる」期間が取れない。運用は別の名前で入れる。AWS 側の JWKS のキャッシュの長さは測っていない |

- **`secret_key` は KMS の代わりになるものではない**。KMS は、署名を頼める主体を鍵ポリシーで縛り、署名の記録を Cloudflare の外の CloudTrail に残し、`DisableKey` で Cloudflare に触らず止められた（付録 A.10）。`secret_key` はこの 3 つを持たない。`secret_key` が与えるのは、「鍵の中身を読み出せない」ことだけで、署名を頼める主体の絞り込み・外部の記録・外部からの停止は、別の手段で補う（§5）
- 手元の開発（`wrangler dev` / miniflare）には `secret_key` のバインディングを作る設定が無い。E2E は、Worker の中で取り出せない鍵を作る試験用のエントリで代用する。試験用のエントリは本番のバンドルに入れない（§4.3）[確認済み: PoC X1 の所見]

### 4.5 Standard も `secret_key` に揃える

[資料: cto の決裁「Standard も secret_key に揃える」（2026-11-12）。条件付き承認。**決裁済み・未実装**]

- 時機: Admin の実装のあとの別 PR で、G2 までに。② は最終の形で試験する。MCP 用の Worker の鍵には効かない（別の上申）
- 条件（Admin と Standard 共通）: (a) 公開鍵は vars、`webcrypto_modern_algorithms` は使わない (b) 使う前にバインディングが `CryptoKey`・`extractable` false・`usages` が sign だけかを確かめ、合わなければ 503。文字列の JWK を読む経路を本番のバンドルに残さない。試験用の鍵の作り方は別エントリにして、バンドル試験で本番に入らないことを見る (c) 起動後の最初の署名を vars の公開鍵で自己検証し、合わなければ発行しない (d) 差し替えは別の名前で。バインディングの名前の規則（`kid` を含む形）と「今の署名鍵」（名前と `kid` の組）を設定に持つ。同じ名前への PUT を道具が断る (e) 鍵は道具の中でメモリ上に作り API で入れ、ファイルに書かない。投入は人が手元で、CI に secret の書き込みのトークンを置かない。Admin と Standard でトークンを分ける (f) コンソールの Worker では `nodejs_compat` を要らなければ有効にしない (g) デプロイ後の確認に「`exportKey` が失敗する」を入れる (h) Standard を移す前に、`wrangler secret put`・`secret bulk` で別の secret を更新したあとに `secret_key` が残るかを測る (i) 文書で「KMS 相当」と書かない
- **今の Standard は secret の JSON**（`CONSOLE_SIGNING_KEYS`。PR #21・#22）。`secret_key` への移行は実装していない。(h) は未測定
- Sol のレビュー: G2 の論点に、`secret_key` の前提と (b)(c) を入れる

---

## 5. 受容と補う手段

### 5.1 X1 で増えるもの（受容の 4 点）

[資料: X1 の決裁。利用者は ② について、この 4 点を含む受容の文面に受容した（2026-11-12）。文面そのものはこのリポジトリの資料に無い。ここには 4 点を書く]

| # | 増えるもの | 補う手段 |
|---|---|---|
| (1) | **Worker のデプロイ権限・secret・依存物の混入のどれか 1 つで、任意の Administrator の JWT を作れる**。AWS 側に署名を頼める主体を絞る場所が無い | 鍵は取り出せない（§4）。Admin の Worker に実行時の外部依存を入れず、依存を固定する（lockfile。jose の版を固定した。PR #27）。デプロイは Standard と別のトークンで、承認つきの environment から。Cloudflare アカウントの権限と API トークンを最小にし、ハードウェアキーの MFA（console-login.md §5.4）。Admin のパスと署名の部品に CODEOWNERS（§11） |
| (2) | **盗まれた鍵は Cloudflare に触らずに使え**、長寿命の通行証（STS は `exp` の上限を見ない。A.4 の P-c）を作り置きでき、**`kid` を外すまで使える** | 鍵は手元のメモリで作って投入し、写しを残さず、CI とログを通さない（§4.2）。差し替えは 90 日以下。**盗まれた疑いがあれば必ず鍵を替えて旧 `kid` を外す**（§6）。発行記録と引き受けの突き合わせ（§8） |
| (3) | **Cloudflare に頼らない発行の停止と、独立の発行記録が無くなる**（KMS の `DisableKey` と、署名の CloudTrail の記録が無い）| 停止は L0・`kid` を外す・L2・L3（§7）。**Cloudflare に頼らない停止は、全アカウントの L2（Admin のプロバイダーの削除）だけ**。300〜500 アカウントでの所要時間を G5 の前に測る。検知は CloudTrail の Administrator の引き受けと発行記録の突き合わせ（§8）|
| (4) | **JWKS が Cloudflare に戻り、「Cloudflare の管理者 = Administrator を配った全アカウントの Admin」になる** | Cloudflare アカウントの権限・MFA・復旧経路を、署名鍵と同じ重さで扱う（console-login.md §5.4 の「Cloudflare の信頼基盤」）。変更の通知(案)。issuer の文書を定期に取り、期待した `kid` と公開鍵に一致することを見張る(案)。**U-7（Cloudflare アカウントの分離）は ② では求めず、③ の Administrator では必須** |

- G1 の人の受容のうち「Administrator は対象アカウントに入口を残せる。停止は revoke では完了せず、棚卸しが要る」（受容 1）は、X1 の決裁の「消える」に挙がっていない [推測: 残る]。「Cloudflare Access の設定を変えられる者は、Administrator として発行できる」（受容 2）は、X1 の (1)(4) が包含する [推測]。管理アカウントに署名を置く案の受容（受容 f）は、案ごと消えた

### 5.2 ③ の条件

X1 を ③ の会社の Administrator に使うことは、今は承認されていない。G5 で次を求める（§12.2）: 会社のセキュリティの承認（X1 を使う例外）、U-7、Administrator の引き受けの全件の人への通知。承認が取れなければ X3 か X2 [資料: 決裁に名前だけがある。中身はこのリポジトリの資料に無い]。

### 5.3 継ぎ目

署名の部品の継ぎ目を残す [資料: X1 の条件 (h)]。署名は `TokenSigner`（`src/console/issue/signer.ts`）の差し込み口を通る。Admin の本番の実装は `secret_key` の署名で、部品が接続されていないときは `unavailableSigner`（503）になる。C-4・I-C に戻す場合は、この口に AWS 側の署名役を差し込む形になる [推測]。戻す条件と手順は決まっていない（付録 A.1）。

### 5.4 独立レビュー

X1 の受容の文面と補う手段には Sol のレビューを取る。① は止めない。**G2 に付け、G5 の前は必須** [資料: X1 の決裁]。**未実施**。

---

## 6. 鍵の差し替え

[資料: X1 の条件 (e)。実装は PR #27 の道具と README]

### 6.1 計画的な差し替え（90 日以下）

| 段 | 操作 | JWKS（vars） | 署名する鍵 | 次に進む前に |
|---|---|---|---|---|
| 0 | 通常 | 今の鍵 | 今の鍵 | — |
| 1 | `console:admin-key:put -- --yes` で新しい鍵を**別の名前**で入れる | 今 | 今の鍵 | 名前と `kid` と公開鍵を控える |
| 2 | `ADMIN_PUBLIC_JWKS` に新旧の 2 つを入れてデプロイ | 今 + 新 | 今の鍵 | STS が新しい `kid` を読むまで。PoC (K6 (1)) では並べた直後から両方通った。README は安全側に 1 時間以上（24 時間）待つ。**STS の JWKS のキャッシュの長さは公開されておらず、測っていない**（N5）。どちらに合わせるかは G2 で確定する |
| 3 | `ADMIN_CURRENT_KEY` を新しい鍵に替えてデプロイ。`console:admin-key:check` | 今 + 新 | 新しい鍵 | 自前の JWT の有効期限（5 分）以上 |
| 4 | 旧い公開鍵を `ADMIN_PUBLIC_JWKS` から外してデプロイ | 新 | 新しい鍵 | K6 (2) では、外した直後から旧い `kid` の JWT が拒否された（3 回の観察） |
| 5 | `console:admin-key:retire -- --binding ADMIN_KEY_<旧> --yes` で旧い鍵を削除 | 新 | 新しい鍵 | 道具は今の鍵と、JWKS にまだある鍵を断る |

- 同じ名前に入れると即座に置き換わる（K6 (4)）ので、「新旧を並べる」期間が取れない。別の名前で入れるのはそのため
- 周期は **90 日以下**（X1 の条件 (e)）。定期の差し替えを道具にすることを G2 の条件に入れる（§12.1）。差し替えの通しは G2 の合格条件

### 6.2 鍵の疑い・Worker の侵害

- **盗まれた疑いがあれば、必ず鍵を替えて旧い `kid` を外す**。発行記録と引き受けの記録が全件で対になることは、替えない理由にしない [資料: X1 の条件 (e)、G1-b の決裁の A-5 の改訂]
- 理由: 鍵が使える者は、`exp` の遠い長寿命の JWT を作り置きできる。STS は `exp` の上限を見ない（365 日先でも通った。A.4 の P-c）。作られた JWT を使えなくする手段は、JWKS から `kid` を外すことと、各アカウントのプロバイダーの削除（L2）だけ
- 外す順: 新しい鍵を別の名前で入れる → JWKS を新だけにする → 旧い鍵のバインディングを削除する。STS の JWKS のキャッシュが残る可能性（N5）があるので、確実に止めるには L2 と L3 を合わせる [推測]
- Worker のコードを変えられる者が鍵を盗むのではなく署名を使う場合（Worker の侵害）は、鍵を替えるだけでは足りない。侵害を取り除いてから替える

### 6.3 世代つきの新しいパス（JWKS を信用できない）

- console-login.md §3.1 の規則: 平常時の URL に世代を入れず、必要なときに世代を付けた新しいパス（例 `/admin-2`）に移る（`^[a-z0-9-]+$`）。ただし生成器は Admin の issuer のパスを `/admin` だけに限っている（`admin_issuer_path`）。世代つきのパスに移るときは、この規則も変える必要がある [資料: PR #27 の実装。手順は未決]
- 手順の案（Standard も同じ）: (1) 新しい鍵と新しい issuer（世代つきのパス）を用意 (2) 基盤のスタックで新しいプロバイダーを配る（古いものと並べる）(3) Administrator のロールの信頼ポリシーの `Principal` と条件キーを新しいプロバイダーに切り替える (4) 古いプロバイダーを削除する (5) 古いプロバイダーで作られたセッションを revoke（L3）[推測: N5 と一緒に G2 で確かめる]
- X1 では、JWKS を信用できない状況（Cloudflare 側の侵害。A13〜A15）では、鍵の差し替えだけでは足りない。Cloudflare の側が信用できないので、各アカウントのプロバイダーの削除（L2）が先になる

---

## 7. 停止

console-login.md §6 の L0〜L3・L3-1 に、Admin の `kid` を外す操作を足す。**KMS の `DisableKey`（H-0）は X1 で無くなった**（付録 A.8）。

| # | 手段 | 止まるもの | 止まらないもの | 実測 |
|---|---|---|---|---|
| L0 | Admin の Worker の停止スイッチ（vars `LOGIN_DISABLED`。POST を 503 `login_disabled`）| 新しい発行 | 作られた JWT（`kid` が JWKS にあり期限内なら受理されうる）と、発行済みの AWS のセッション。**Cloudflare の操作に依存する** | 未測定（Worker の設定の反映）|
| L-kid | `kid` を外す: JWKS（vars）から外してデプロイする。または鍵のバインディングを削除する | その鍵で作られた JWT の新しい引き受け。バインディングの削除なら、新しい署名も止まる | 発行済みの AWS のセッション。**Cloudflare の操作に依存する**。JWKS のキャッシュの保証は無い（N5）| JWKS から外した直後から拒否された（3 回、約 45 秒）。バインディングの削除は直後から login が失敗した [確認済み: PoC X1 の K6] |
| L2 | Admin のプロバイダーの削除（各アカウント）| 新しい引き受け（作られた JWT の利用も含む）| 発行済みの AWS のセッション。**Cloudflare に頼らない停止は、これだけ** | Standard の形で約 12 秒 [資料: console-login.md §6.1]。**全アカウントでの所要時間は未測定。300〜500 アカウントでの所要時間を G5 の前に測る** |
| L3・L3-1 | Administrator のロールの revoke / 1 人の Deny | 発行済みの AWS のセッション | — | Viewer の形で確認済み。Administrator で確かめるのは ②（console-login.md §7.5）|

停止を段階に分ける（時間は観察値で、保証値ではない。`kid` を外すことも即時の失効の手段として保証せず、AWS 側の手段と組み合わせる）:

| 段階 | 止める手段 | 止まらないもの |
|---|---|---|
| 新しい発行 | L0、鍵のバインディングの削除 | 作られた JWT。Cloudflare の側が侵害されているなら、止めた設定を戻されうる |
| 作られた JWT からの新しい STS セッション | `kid` を外す、L2 | 発行済みの AWS のセッション |
| 既存のセッション（STS・コンソール・`aws login`）| L3（revoke）・L3-1 | 外すと再ログインなしで戻る（console-login.md §6.3）|
| 残った権限（Administrator が作ったアクセスキー・ロール・プロバイダー・信頼の変更など）| 棚卸しと個別の削除（SourceIdentity で CloudTrail から拾う。G2 に付け、② で訓練する）| revoke では止まらない |

手順の案（Admin の鍵か Worker の侵害）:

1. **新しい署名を止める**: L0 と、鍵のバインディングの削除。Cloudflare の侵害が疑われるときは、止めた設定を戻されうるので、2〜3 を並行する
2. **作られた JWT を使わせない**: `kid` を外す。確実にするには、Administrator を配った各アカウントの Admin のプロバイダーを削除（L2）。**Cloudflare が信用できないときは L2 が先**
3. **発行済みを止める**: 新規が止まったことを確かめてから L3（console-login.md §6.2 の順）
4. **調べる**: §8 の突き合わせ
5. **戻す**: 原因を取り除く → 鍵を替える（§6.2）→ プロバイダーを作り直す → console-login.md §6.3 の解除の条件で revoke を外す

- 退職・端末の紛失など 1 人の停止は Standard と同じ（L1 と L3-1。過去の email も Deny。console-login.md §6.2）
- 「Cloudflare に頼らない停止」の入口は、Entra と awsbridge に依存しない入口である必要がある。E0 の受容と Entra を通らない停止の経路は console-login.md §6.6・§6.7。X1 では L0 と `kid` を外す操作が Cloudflare を通るので、E0 の欠落が大きくなる [推測]

---

## 8. 監査と検知

[資料: X1 の条件 (g)。付録 A.9 は KMS の場合]

X1 には、署名の独立の記録（KMS の Sign の CloudTrail）が無い。AWS 側に残るのは、**各アカウントの CloudTrail の `AssumeRoleWithWebIdentity`** だけで、これを Admin の Worker の発行記録と突き合わせる。

| 記録 | 置き場所 | 中身 | 突き合わせのキー |
|---|---|---|---|
| Admin の Worker の発行記録 | Logpush で自社のセキュリティ用の置き場所（portal §10.3）| portal §10.3 の項目（`jti`・STS の応答の 3 つの ID など）に、署名した `kid` を足す（案）| `jti`、STS の応答の ID |
| `AssumeRoleWithWebIdentity` | Administrator を配った各アカウントの CloudTrail | `requestParameters.webIdentityTokenId` が JWT の `jti` と一致（N6 で 28/28、G1-b で 31/31）。ほかに `roleSessionName`・`sourceIdentity`・`principalTags`・`userIdentity`・`identityProvider` [確認済み: N6 の K4、G1-b の P-a]。X1 の PoC では CloudTrail の突き合わせはしていない | `webIdentityTokenId` = `jti`（主）。STS の応答の 3 つの ID（console-login.md §5.6）|

突き合わせ（案）:

| # | 見るもの | 疑うこと |
|---|---|---|
| 1 | 引き受けの記録で、`webIdentityTokenId` が発行記録の `jti` に無いもの | 作られた JWT か、Worker の外からの発行。**X1 で見つけられる主な手がかり** |
| 2 | 発行記録にあって、引き受けの記録に無いもの | 記録の欠け（反映の遅れを除く）、利用者が STS に渡さなかった |
| 3 | 引き受けの件数・時刻・アカウントの急な変化 | 鍵の使われ方の異常 |

- **突き合わせは検知の材料で、完全性の証明ではない**。侵害された Worker は偽の発行記録も作れる（その場合、表の 1 に当たらない）。同じ `jti` の JWT を期限内に何度も引き受けに使える。欠けや食い違いを攻撃と断定せず、再試行・重複・反映の遅れを見分ける [資料: Sol のレビュー（2026-11-12）]
- **検知の道具**: ② は道具で突き合わせる。**道具は未実装**（② の合格条件の (b)(e) で用意する）。**③ は、Administrator の引き受けの全件を人に通知することを G5 の条件にする** [資料: X1 の条件 (g)]
- CloudTrail のイベント履歴への反映の遅れは、観察した範囲で約 1 分〜2 分 20 秒だった（N6 の K4）。失敗した `AssumeRoleWithWebIdentity`（`InvalidIdentityToken`）はイベント履歴で見当たらなかった（N6、G1-b とも）ので、拒否の見張りを CloudTrail だけに頼らない
- `RoleSessionName` は `console-<email>` に確定している（console-login.md §3.4）ので、`jti` や鍵の情報を入れる案は採れない
- 見張り(案。ADR の補う手段にはない): Cloudflare の監査ログ（Worker のデプロイ・secret の更新と削除・DNS・Routes・Custom Domain・API トークンの作成）を外部へ送り、通知する。issuer の discovery と JWKS を定期に取り、期待した `kid` と公開鍵に一致することを確かめる。Admin のログイン（すべて通知）

---

## 9. Admin のセッションの長さ（D6）

| 項目 | 事実・案 |
|---|---|
| ロールの `MaxSessionDuration` | 1 時間〜12 時間 [確認済み: STS の `AssumeRoleWithWebIdentity` の文書]。**1 時間より短くは AWS 側で強制できない** |
| `DurationSeconds`（引き受け）| 900 秒〜ロールの `MaxSessionDuration` [確認済み: 同じ文書] |
| コンソールの `SessionDuration` | 900〜43200 秒。文書は「ロールの最大のセッションの長さ以上にはできない」と書く [確認済み: IAM のカスタムの ID ブローカーの文書]。PoC では `MaxSessionDuration` と同じ 43200 が受理された [資料: cto の決裁の記録（前提の訂正）。文書の記述との食い違いは未解決] |
| `aws login` | 15 分ごとに更新し、ロールのセッションの長さまで使える [資料: portal §6.5] |
| **決定** | Administrator のロールの `MaxSessionDuration` を **1 時間**（AWS が強制できる最短）にする。Worker の `sessionSeconds` も 1 時間 [資料: G1 の決裁 A-8]。**② で実際に 1 時間で切れるかを測る** |
| 1 時間より短くしたいとき | Worker が `DurationSeconds`・`SessionDuration` に 900 秒などを渡す形になる。**これは Worker の振る舞いで、AWS の強制ではない**（侵害された Worker や作られた JWT はロールの上限まで取れる）。生成の検査で、Admin の階層のロールの `MaxSessionDuration` に 3600 未満を渡さない（CloudFormation で失敗する）ようにする。**この検査は生成器にまだ無い** [資料: 司令塔の引き継ぎ（後続の作業）] |
| Access のセッション（Admin の階層のチームのアプリ）| Standard より短く（例 5〜15 分。PIM と合わせて決める。PIM は G3・G5）[資料: console-login.md §6.4]。**Worker の `ACCESS_MAX_AGE_SECONDS`（既定 900 秒）と揃える**（§3.1）|

---

## 10. P1・P2（プロバイダーの統合）

[資料: cto の決裁 2026-11-12「プロバイダーの統合と Admin の分離」、Sol のレビュー（決裁ではない）]

| 案 | 内容 | 失うもの | 得るもの | 採る条件 |
|---|---|---|---|---|
| **P1'（今の設計。G1 の決裁 A-9 で維持）** | 入口と一覧は共通。Worker・issuer・鍵・発行のオリジンは分ける | — | 画面は 1 つ。署名の権限と発行のオリジンが分かれ、Standard の画面の欠陥や Standard の Worker・鍵の侵害が Admin に届かない | — |
| P1（Standard と Admin を同じ Worker）| 1 つの Worker が Standard の鍵と Admin の鍵の両方で署名する | D3 の「Admin は別の Worker デプロイ」。その Worker は共通の認証局になる。実行環境・依存・デプロイの事故の分離、Admin だけ厳しく変更管理する境界、オリジンの分離（Cookie の Path は境界にならない）を失う [資料: Sol のレビュー] | Worker のデプロイが 1 つ減る | 人の受容。D3 の緩和として再上申 |
| P2（Standard と Admin の issuer を 1 つ）| コンソール側のプロバイダー・Worker・鍵が 1 つずつ | D3・D4。IAM はその issuer の JWKS のどの鍵の署名も受け入れ、ロールの側で鍵を縛れない [資料]。Admin だけを L2 で止める手段を失う | 各アカウントのコンソール用のプロバイダーが 1 つになる | 人の受容。D3・D4 の変更として再上申 |

- **P1' のまま**（G1 の決裁）。理由は決裁の理由と同じ（表示は認可ではない。発行のオリジンと署名の権限が同じだと、Standard の欠陥が Admin の発行に届く）。P1・P2 は、利用者が「プロバイダーを 1 つにしたい」「Worker を 1 つにしたい」と望むとき（U-18 の回答）にだけ再審議する
- **人の受容の記録はない**（console-login.md §9.2 の U-18 は人の確認待ち）
- P3（MCP とコンソールのプロバイダーを 1 つ）は却下済み。開き直さない

---

## 11. D2（別リポジトリにするか）

前の決裁: D2 は「awsbridge 内の別エントリ。MCP 用のバンドルに人間用の経路が入らないことをテストで確かめる。段階 3 の前に別リポジトリを見直す」。G1 の決裁 A-10: **① は同じリポジトリの別エントリ**とし、G5 の前に見直す [資料]。

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| R-a 今のまま（同じリポジトリの別エントリ）| MCP 用・Standard・Admin を同じリポジトリの別エントリ（別の wrangler 設定・別のデプロイ）にする | 署名・STS の呼び出し・JWKS などの安全の要（`src/oidc.ts`・`src/keys.ts`・`src/sts.ts`）を共有でき、複製の差が出ない。バンドルの分離の試験が既にある | 変更の管理（誰がマージできるか）とデプロイの権限の境界を、リポジトリより細かい単位で作る必要がある |
| R-b コンソールログイン（Standard と Admin）を別リポジトリ | MCP 用とコンソールログイン用を分ける | MCP 用と変更管理・CI・Cloudflare のアカウントを分けやすい | 署名の部品を複製するか、共有のパッケージにする手間 |
| R-c Admin だけ別リポジトリ | Admin の Worker と Admin の設定を別にする | Admin だけ厳しい変更管理（承認の人数・保護ブランチ）とデプロイの権限にできる | ポータルの大半が Standard と同じコードで、複製か共有パッケージが要る |

- 決定: **① は R-a**。条件（G1 の決裁 A-10 の (1)〜(4)。X1 の条件 (d) と合わせる）: (1) Admin のエントリは別の wrangler 設定と別のデプロイのジョブ・**Standard と別のデプロイ用トークン**（承認つきの environment）。Admin の Worker に実行時の外部依存を入れない (2) バンドルの分離の試験を 3 方向にする（MCP に Standard・Admin がない、Standard に Admin の鍵の参照・Admin の AUD・ポリシー ID がない、Admin に Standard の一覧の行と Standard の鍵がない。portal §9.10）(3) Admin のパスと署名の部品に CODEOWNERS を付ける (4) 公開リポジトリに秘密・実値を置かない
- 見直しの時機: 会社で Administrator を配る前（G5）に、U-7・G-14 と一緒に R-b・R-c にするかを見直す

---

## 12. G2 と G5 の条件、実装の状態

### 12.1 G2 の合格条件に足すもの

[資料: G1-b の決裁の「迷い 1」、X1 の決裁、「Standard も secret_key に揃える」の決裁]

- **Admin に許されていない別の利用者での試験**: 旧い Cookie、Access の設定変更のあとに残る JWT も含む。G1-b の PoC で確かめたのは、両方のアプリに入れる 1 人の利用者の混在 AUD だけで、許されていない人からの昇格は未確認 [確認済み: A.4 の P-a]
- **開発環境で、権限のあるロールで実際のコンソールへログインする**。PoC は `getSigninToken` の取得までで、権限なしのロールだった（Sol の指摘 G の 7）
- **鍵の差し替えの通し**（§6.1。90 日以下の周期を道具にすることを含む）
- **`secret_key` の前提**: §4.5 の (b)(c)(g)、本番のバンドルに文字列の JWK の経路と試験用の鍵の作り方が入らないこと、`wrangler secret put` / `secret bulk` / ダッシュボード / Workers Builds のあとに `secret_key` が残るか（(h)）
- Standard の `secret_key` への移行（別 PR。§4.5）
- 入力の大きさの上限と必須 claim の型の検査（§3.1）
- 守りの部品の監査の Deny の中身（G1 の決裁 A-12）
- Sol のレビュー（X1 の受容の文面と補う手段。§5.4）
- 発行記録の置き場所と、CloudTrail の引き受けとの不一致の通知(X1 の条件 (g)。検知の道具は未実装。§8)

### 12.2 G5 の条件に足すもの

[資料: X1 の決裁]

- 会社のセキュリティの承認（X1 を会社の Administrator に使う例外）。取れなければ X3 か X2
- U-7（Cloudflare アカウントの分離）: ② では求めず、③ の Administrator では必須
- **Administrator の引き受けの全件を人に通知する**こと
- Cloudflare に頼らない停止（全アカウントの L2）の所要時間（300〜500 アカウント）の測定
- Sol のレビュー（§5.4。G5 の前は必須）
- 既存の G5 の合格条件（console-login.md §7.6）

### 12.3 実装の状態（Admin）

[PR #16〜#27 はすべて未マージ。全体は console-login.md §7.4.1]

| 項目 | 状態 |
|---|---|
| Admin の Worker（画面・9 段・署名の差し込み口・`unavailableSigner`）| PR #23（署名は 503 固定）|
| `secret_key` の署名・Admin の issuer の文書・Access JWT の鮮度の検査・`key-check`・生成器の `admin_issuer_*` | PR #27 |
| 運用の道具（`console:admin-key:put` / `retire` / `check`、`secrets:scan`）| PR #27 |
| 負の試験・3 方向のバンドルの分離の試験 | PR #26 |
| Admin のプロバイダー（基盤のスタック）| **未実装**。基盤のスタック（PR #17）は Admin のプロバイダーを作らない。ロールのテンプレート（PR #20）は `AdminProviderArn` が空なら Admin のロールを作らない。Admin のプロバイダーは別のホストなので、`IssuerHost` を階層ごとに分けるパラメーターの形が要る。`AdminProviderArn` にアカウント ID が入るため、StackSet で 1 つの値にできない。形は未決 |
| Admin の Worker に対する `secret_key` の実物での確認 | 未実施（`console:admin-key:check` が最初）|
| Cookie Path の強制（生成器か Terraform の出力で見る）| 未実装 |
| Admin の `MaxSessionDuration` の下限（3600）の生成器での強制 | 未実装 |
| 変更の通知・検知の道具（引き受けの突き合わせ）| 未実装 |

---

## 13. 決まったことの行き先と未決事項

### 13.1 G1 の決裁（A-1〜A-16）の X1 のもとでの扱い

[資料: cto の決裁 G1（2026-11-12）、G1-b、X1]

| # | G1 の決裁 | X1 のもとでの扱い |
|---|---|---|
| A-1 | KMS の鍵の形（RSA_2048・RS256）と専用の署名用アカウント | 鍵の形（RSA_2048・RS256）は `secret_key` でも同じ。**署名用のアカウントは消えた**（付録 A.5）|
| A-2 | Worker が署名する認証情報（第一候補 C-4）| X1 で置き換え。C-4 は退避先（付録 A.2・A.6）|
| A-3 | Admin の issuer の形（第一候補 I-C）| **I-B に戻った**（§2.1）。I-C は退避先（付録 A.3）|
| A-4 | 鍵ポリシーの形 | KMS 用。退避先（付録 A.5）|
| A-5 | 鍵の差し替え | `kid` を外す基準（秘密の持ち出し・Worker の侵害）は §6.2 に引き継ぐ。ARN と `kid` の組は「名前と `kid` の組」に。KMS 用の基準は付録 A.7 |
| A-6 | `DisableKey` を基準の停止に。鍵の管理役の入口 | **消えた**（X1）。停止は §7 |
| A-7 | 監査: `jti` = `webIdentityTokenId`、KMS の RequestId、署名用アカウントの証跡 | `jti` = `webIdentityTokenId` は §8 に残る。KMS の RequestId と署名用アカウントの証跡は付録 A.9 |
| A-8 | 1 時間 | 残る（§9）|
| A-9 | P1' のまま | 残る（§10）|
| A-10 | D2 | 残る（§11）|
| A-11 | 503 `signing_unavailable` | 残る（§3）|
| A-12 | 守りの部品の監査の Deny の中身は G2 | 残る。**未決** |
| A-13 | console-login.md §7.7 の作成者の扱いを承認 | 残る。P-9 は「I-C の成立で閉じる」だった。I-B に戻ったので、閉じたとは書かない。別ホストなら振り分けの確認は要らず、迂回の確認は残る（§2.1）|
| A-14 | portal §12.2 の G-1・2・3・5・7・9 を確定（Admin の issuer の URL は G1-b まで）| 残る。Admin の issuer の URL は §2.1 |
| A-15 | ② でも Admin のチームは別 | 残る（console-login.md §9.2 の U-23 を閉じる）|
| A-16 | 鍵は別スタック・削除されない設定 | KMS 用。退避先（付録 A.5）。X1 の鍵は Worker のバインディング |

### 13.2 未決のまま残すもの

- **X2・X3 の中身**: 決裁に名前だけがある。このリポジトリの資料に無い。G5 で会社のセキュリティの承認が取れなかったときの代替
- Sol のレビュー（X1 の受容の文面と補う手段）: 未実施（§5.4）
- `wrangler secret put` / `secret bulk` / ダッシュボード / Workers Builds の経路で、別の secret を更新したあとに `secret_key` が残るか（K4 の未測定。Standard の (h)）
- STS の JWKS のキャッシュの長さ（N5）。差し替えの待ち時間は README（1 時間以上）と PoC の観察（直後）を両方書き、G2 で確定する（§6.1）
- Cloudflare に頼らない停止（全アカウントの L2）の所要時間（G5 の前）
- Admin のプロバイダーのスタックの形（別ホストのパラメーター、`AdminProviderArn` のアカウント ID）。§12.3
- `signing.accountIds` と誤り `signing_account`（署名を置くアカウントにコンソールのロールを配らない。PR #20）: G1 の「署名用アカウント」のために作られた。X1 では署名用アカウントが無いので、残すか退避先専用にするかは未決
- Admin の issuer のホストに Access が掛かる環境での Bypass（§2.1）、本物の `secret_key` のバインディングでの Worker の検査（§3.3）
- 新しい Worker に最初の鍵を投入するときの、スクリプトの存在の要否（§2.2）
- 入力の大きさの上限・必須 claim の型の検査（§3.1）
- ES256・RSA-PSS・`pkcs8` / `key_base64` の形式での `secret_key`（K1 で未試験）
- 守りの部品の監査の Deny の中身（A-12）
- PIM と Admin の階層の Access のセッションの長さ（G3・G5）
- Cookie Path と `MaxSessionDuration` の下限の強制（§12.3）
- 検知の道具の形（引き受けと発行記録の突き合わせ）

---

## 付録 A. 退避先: C-4（AWS 側の署名役）・I-C（AWS 側の issuer）・KMS

この付録は、G1・G1-b の審議で書いた設計と PoC を、X1 の決裁（「C-4・I-C の設計と PoC は退避先として残す」）に従って残したもの。**消していない**。本文（§1〜§13）は X1 の設計で、付録 A は今は使わない。A.5〜A.11 は G1 の審議の資料として書いた文章をほぼそのまま移した。「作成者の推奨」「G1 で決める」と書いた箇所は審議の時点の記述で、決裁の結果は A.6 と §13.1 にある。

### A.1 位置づけ

- 署名を AWS の KMS に置き、Access JWT を検証する署名役（Lambda など）を AWS に置くと、Cloudflare の侵害だけでは任意の Administrator の JWT を作れなくなる（Worker の秘密が漏れても、有効な Access JWT が要る）。X1 はこの層を外し、人の受容に置き換えた（§5）
- **この設計に戻す条件と手順は決まっていない**。戻すときは再上申する [推測]。会社の Administrator で X1 のセキュリティの承認が取れないとき（G5）の代替は X3 か X2 と決裁に書かれているが、この資料には X2・X3 の中身が無く、C-4 に戻す話なのかは分からない
- 戻すための継ぎ目は残してある: 署名の差し込み口 `TokenSigner`（`src/console/issue/signer.ts`）。Admin の Worker は署名の部品を差し替えられる形で書かれている（§5.3）
- 「KMS 相当」と書かない: `secret_key` は KMS の代わりになるものではない（§4.4）

### A.2 C-4（AWS 側の署名役が Access JWT を検証してから署名する）の条件

[資料: cto の決裁 G1（第一候補 C-4。C-2 は退避先にしない。C-2'・C-3 は不採用）と G1-b（C-4 の条件）]

G1 の条件:

- (a) 署名役が claim を自分で組む。入力は Access JWT だけ。チームは署名役の AUD → チームの表で決める
- (b) `iss`・`aud`・`iat`・`exp`（5 分）・`jti` は署名役が固定・生成する
- (c) Access JWT の検証（署名・`iss`・`aud` は Admin のアプリだけ・`exp`・サービストークンを断る）
- (d) Worker の秘密は呼び出しだけの権限。持たない形も比較した
- (e) 署名役が AWS 側に独立の記録を残す
- (f) 署名役のコードと設定を変えられる主体が発行の権威。鍵ポリシーの Sign は署名役の実行ロールだけ
- (g) Cloudflare の管理者は防げないと書く（U-7 は G5 の前）

G1-b の条件（A-2。決裁は C-4 の呼び出しの秘密ありを採った）:

1. aud はちょうど 1 つで、Admin のチームの AUD の表にある。混在は断る
2. `email` と `sub` が空でないことを求め、`common_name` があれば断る
3. Access JWT の `iat` からの経過時間に上限（Admin の Access のセッションの長さ、既定 15 分）。`exp`・`nbf` も見る
4. JWT の検証の仕様: アルゴリズム固定、certs は固定のチームドメインから、未知の `kid` と取得の失敗は断る、入力の大きさの上限、必須の claim と型。certs の静的保持はしない
5. 発行する JWT: `iss`・`aud` 固定、`exp = iat + 300`、`jti` 一意、本文に余計な項目があれば断る
6. 呼び出しの秘密は claim の根拠にしない。署名役はハッシュだけを持つ。新旧 2 つを受けて差し替えられる。ログに出さない
7. 実行ロールは Admin の鍵の `kms:Sign` とログだけ。Admin の鍵以外の `kms:Sign` を Deny。自分を変える権限なし
8. 鍵ポリシーで `kms:CreateGrant` を Deny
9. 呼び出し数・エラー・費用の見張りと、停止の手段（関数 URL の停止か同時実行数 0）
10. AUD → チームの表は、生成器が Worker と同じ元から出す。署名役での STS の交換は採らない

発行の権威の一覧に足すもの: 実行ロールとその信頼、関数 URL の設定とリソースポリシー、Lambda のレイヤーと依存物、KMS の Grant、バケットポリシーと OAC、配信の配信元、これらのスタック、デプロイする主体。変更の通知の一覧（`UpdateFunctionCode`・`UpdateFunctionConfiguration`・`PutKeyPolicy`・`CreateGrant`・JWKS の書き込み・`UpdateDistribution`・実行ロールの変更）は G2 に付ける。JWKS の書き込みは S3 のデータイベントとして証跡に残す。

### A.3 I-C（Admin の issuer の discovery と JWKS を署名用アカウントの AWS 側に静的に置く）の条件

[資料: cto の決裁 G1-b（A-3 は I-C。CloudFront + OAC、既定のドメイン）]

1. issuer はパス付き（`/admin`）。CloudFront でのパス付きを ① の開発環境で確かめる
2. 配信・バケット・鍵は削除されない設定（Retain）。消す順は 信頼ポリシー → プロバイダー → 配信。「横取りできない」と書かない
3. JWKS のキャッシュを短くする。`kid` を外すときは無効化も行う。外してから STS が断るまでの時間を G2 までに測る
4. Admin の Worker は issuer の文書を出さない

ホスト名は S3 / CloudFront の既定のもの、または Route 53 のもの。Cloudflare の DNS のホスト名は不可 [資料: G1-b の決裁。理由は Cloudflare の側から JWKS を差し替えられないようにするため [推測]]。S3 の公開読み取りは 1 バケットの例外まで（CloudFront + OAC を優先）。Admin の issuer の URL は「CloudFront の既定のドメイン + `/admin`」で確定していた（実値は環境ごと）。

G1 の再上申の決裁（② の署名の置き場所）: ② では署名の鍵・署名役・JWKS を個人の Organization の**管理アカウント**に置く（G1 の A-1「② でも署名用アカウントを分ける」を置き換え）。条件 (a) ② に限る。③ は専用の署名用アカウントか、Administrator を配らない管理用のメンバーアカウント (b) 署名を置くアカウントにコンソールのプロバイダーとロールを配らないことを道具で守る（設定に署名アカウントの ID。生成器が対象に含めたら誤り。検査の道具でも）(c) 署名役の実行ロールはその鍵の `kms:Sign` とログの書き込みだけ。信頼は Lambda だけ。専用スタック。片付けを ② の合格に (d) S3 の公開がアカウント単位の Block Public Access を外すなら CloudFront + OAC を優先 (e) 署名役の入口が公開なら同時実行数の上限 (f) 人の受容「個人の Organization の管理アカウントに、インターネットから届く署名役と公開の文書を置く。署名役の欠陥は、Administrator を配った全アカウントの全権の発行につながる。管理アカウント自体の権限には届かない形にする。管理アカウントには SCP が効かない」（利用者は受容した）。**X1 の決裁で、この管理アカウント案とその受容は消えた**。鍵の管理役の入口（A-6。自社は IIC、顧客のアカウントは顧客の IIC）も消えた。

### A.4 G1-b の PoC の結果（C-4 の通しと I-C）

開発用の AWS アカウント 1 つ（東京リージョン）、Cloudflare の開発用ゾーンの Custom Domain に置いた Worker と Access（IdP は Google）で、2026-11-12 に行った。ブラウザの操作は Claude in Chrome。回数が少ない測定は回数を書いた [確認済み: PoC G1-b。道具はリポジトリにコミットしていない]。

要約:

1. **C-4 の通しは成立**: Access（Google）→ Worker → 署名役（Lambda の関数 URL）→ Access JWT の検証 → KMS の Sign → STS → `getSigninToken`。S3 の issuer でも CloudFront の issuer でも通った。呼び出しの秘密の有無（open / secret）のどちらでも通った
2. **同じホストに Admin と Standard の階層のアプリを置くと、Access JWT の `aud` に両方の AUD が入る**（Cookie Path が無効のとき）。aud の完全一致を見ない最初の署名役は、Standard の階層のアプリで得た JWT で Admin の JWT を 2 回発行した。署名役に `aud_mixed` の拒否を足した。Cookie Path を有効にすると、アプリごとに別の JWT（aud は 1 つ）になった
3. **I-C は S3 の公開読み取りと CloudFront + OAC のどちらでも成立**。パスなしの issuer もパス付き（`/pc`）も通った
4. **P-c: STS は `exp` の上限を見ない**（365 日先でも通った）。時計ずれの許容は ±5 分程度
5. **P-d: IAM の Resource の絞りだけでは足りない**。鍵ポリシーで実行ロールに Sign を許した別の鍵には、IAM の許可が無くても Sign できた。実行ロールに「Admin の鍵以外の `kms:Sign` を Deny」を足すと拒否された

| # | 結果 | 根拠（実測） | 未測定・注意 |
|---|---|---|---|
| P-a 通し | **成立** | ブラウザ → `/t/infra/login`。S3 の issuer で、open・secret とも n=10 が全件成功。CloudFront の issuer で n=3 が全件成功。発行した JWT の claim は `iss`・`aud`・`sub`・`iat`・`exp`（iat+300）・`jti`・タグ・source_identity の 8 つだけ | コンソールへの実際のログインはしていない（`getSigninToken` の取得まで）|
| P-a 別のアプリの AUD | Cookie Path を有効にすれば断られる（`aud_not_admin`）。無効のままだと最初の実装では通ってしまった | Cookie Path が無効: `/std` のログイン後、JWT の aud = [std, admin]・`exp - iat = 86400`（Standard の階層のセッションの 24 時間）。同じ Cookie が `/t/infra` にも送られ、2 回発行された。Cookie Path を有効にして入り直すと、`/std` の JWT は aud=[std] だけで断られ、`/t/infra` の JWT は aud=[admin] だけで発行できた。無効・有効とも各 1 回の観察 | **Admin に許されていない人が Standard の階層のアプリにログインしたとき、aud に Admin の AUD が入るかは試していない**（Google のアカウントが 1 つ）。Admin のアプリの 15 分を過ぎても通るかは測っていない |
| P-a 期限切れ | 断られる（`expired`、401）| サービストークンで得た Access JWT（`exp - iat` = 900 秒）を残し、期限の 47 秒後に関数 URL へ直接送った | 署名役の時計の許容は 30 秒。本人の JWT の期限切れは試していない |
| P-a サービストークン | 断られる（`service_token`、403）| 本物の JWT の claim: サービストークンは `common_name` があり `sub` が空。利用者は `email`・`country` などがあり、Cookie Path が有効なら `pathCookie` と `pathText` も付く。`type` はどちらも `app` なので、種別の判定に使えない | — |
| P-a Worker の偽の値 | 本文に添えれば断られる（`unexpected_fields`、400）。ヘッダーに添えても使われない | forged-body → 400。forged-header → 発行はされたが、`sub` は Access JWT の email・チームは表のまま | — |
| P-a 偽の Access JWT | 断られる | 偽の鍵で署名し `iss`・`aud` は本物にした JWT → `invalid_signature` | — |
| P-a 記録（e） | 突き合わせられた | 署名役の CloudWatch Logs の `kms_request_id` が、CloudTrail の Sign の `requestID` と 31/31 一致。Admin のロールの `AssumeRoleWithWebIdentity` の `webIdentityTokenId` は 31/31 で `jti` と同じ | 失敗した `AssumeRoleWithWebIdentity` はイベント履歴に見当たらなかった。署名役が書くログは署名役の実行ロールで書き換えられないわけではない |
| P-b S3 | 成立 | アカウントのリージョンの名前空間のバケット。公開は `.well-known` の 2 オブジェクトの GetObject だけ。同じバケットの別のキー → 403 | 公開ポリシーを付けるため BlockPublicPolicy・RestrictPublicBuckets は false。Organizations 側の S3 の公開の制御があれば変わりうる |
| P-b CloudFront | 成立 | 既定のドメイン。OAC で非公開バケットから配った。配信元のバケットを S3 から直接読むと 403。スタックの base の作成は 254 秒 | 削除に約 3.5 分 |
| P-c | exp の上限なし。時計ずれは ±5 分程度 | 成功: exp +5 分〜+365 日、iat +60 秒・+5 分、exp -60 秒。拒否: iat +10 分以上、nbf +10 分、iat なし、exp -5 分以前 | 許容の正確な境目（5〜10 分の間）は詰めていない |
| P-d IAM | IAM の Resource の絞りだけでは足りない | Admin の鍵 → ok、既定の鍵ポリシーの別の鍵 → AccessDenied、鍵ポリシーで実行ロールに Sign を許した別の鍵 → **ok** | — |
| P-d IAM の Deny | 実行ロールの明示の Deny で、鍵ポリシーが許す別の鍵も止まった | `kms:Sign` を `NotResource` = Admin の鍵で Deny → 別の鍵はどちらも AccessDenied | SCP・権限境界での同じ縛りは試していない |
| P-d 鍵ポリシー | Admin の鍵の Sign は実行ロールだけ | `AdministratorAccess` の SSO ロールが Admin の鍵で Sign → AccessDenied | — |

所要時間（ミリ秒。Worker の中で測った値。n=10、warm）: 署名役の往復は中央値 60（open）・104（secret）、STS は 22、`getSigninToken` は 176、ログイン全体は 262（open）・299（secret）。コールドスタートは 3 回で、署名役の往復が 1917〜2207。大部分は新しい実行環境が Access の certs を初めて取る時間（0.9〜1.5 秒）。

設計に効くこと:

1. Admin と Standard を同じホストに置くなら、Cookie Path を有効にし、署名側で aud の完全一致を見る。**より強いのは Admin を別のホストに分けること**（Cookie が分かれる）。X1 ではこの両方を採る（§2・§3.1）
2. JWT の寿命は発行側が決める（STS は `exp` の上限を見ない）。X1 の受容の 2 点目の根拠
3. 署名役の実行ロールには、Admin の鍵の Sign の Allow に加えて「Admin の鍵以外の `kms:Sign` の Deny」を入れる
4. コールドスタートの大部分は Access の certs の初回取得。certs を静的に持つ形は鍵のローテーションに追従できず、非推奨（Sol のレビュー）
5. 「AWS 側の独立の記録」は、CloudWatch Logs（署名役が書く）と CloudTrail の Sign（AWS が書く）の 2 つ。突き合わせは KMS の RequestId と `jti` で、どちらも全件一致した

I-C の公開の形の比較:

| | S3 の公開読み取り | CloudFront + OAC |
|---|---|---|
| 公開の範囲 | バケット単位の例外。ポリシーで公開するのは文書のオブジェクトだけ | バケットは非公開のまま。読めるのはこの配信だけ |
| アカウントの設定 | アカウント単位の Block Public Access が有効な環境では使えない | 影響なし |
| issuer のホスト名 | `<bucket>.s3.<region>.amazonaws.com` | `<ランダム>.cloudfront.net`（選べない）|
| 名前の横取り | 削除したバケット名は他のアカウントが取れる。アカウントのリージョンの名前空間なら取れない | 既定のドメインは選べない。削除後に再び割り当てられるかの記述は見つからなかった |
| 共通 | OIDC プロバイダーが残ったまま issuer の名前を他人に取られると、その人が JWKS を置いて信頼ポリシーの条件に合う JWT を作れる。消すときは OIDC プロバイダー（と信頼ポリシー）を先に消す | 同じ |

### A.5 KMS の鍵と鍵ポリシー（KMS の場合）

> この節（A.5）〜A.11 は G1 の審議用に書いた資料で、X1 の決裁により退避先として残す。「② での置き場所」の行は、G1 の再上申の決裁で管理アカウント案に変わり、X1 の決裁でそれも消えた（A.3）。

#### A.5.1 鍵

| 項目 | 案 | 根拠 |
|---|---|---|
| 鍵の種類 | 非対称・`KeyUsage: SIGN_VERIFY`・`KeySpec: RSA_2048` | 今の鍵（RSA 2048・RS256）と同じ形。秘密鍵は KMS の外に暗号化されない形で出ない [確認済み: KMS の概要の文書（KMS の鍵は HSM で守られ、暗号化されない形でサービスの外に出ない）] |
| 署名のアルゴリズム | `RSASSA_PKCS1_V1_5_SHA_256`（RS256）。ES256 も N6 で成立した | §3 |
| 置き場所 | **専用の署名用 AWS アカウント**（コンソールログイン用のロールを置かない、人の入口を最小にしたアカウント）。管理アカウントには置かない | 前の設計上申 §5.4 の案。Sign の記録が Cloudflare の外に残り、`DisableKey` が Cloudflare に依存しない停止の経路になる [資料] |
| ② での置き場所 | 個人の Organization のメンバーアカウント（管理アカウントには置かない）。Administrator を配るアカウントと同じでもよいか、分けるかは G1 で決める [推測] | console-login.md §7.5 |
| リージョン | 1 つのリージョン。KMS の鍵はリージョンの資源なので、そのリージョンの KMS が止まると Admin の発行が止まる（代わりは B1・B2）。マルチリージョンの鍵は使わない案 [推測: 使うと鍵の複製の管理が増える] | portal §10.2 |
| 鍵の数 | 階層 × 境界ごと。今は管理下の Admin の 1 つ（差し替えの間だけ 2 つ。§A.7） | D3 |
| 自動のローテーション | **使えない**（非対称の KMS の鍵は自動のローテーションに対応しない）。差し替えは新しい鍵を作って切り替える（§A.7）[確認済み: KMS の FAQ と GetKeyRotationStatus の文書] | — |
| 費用 | 鍵 1 つで月 1 ドル（時間で按分）[確認済み: KMS の料金のページ]。RSA の Sign の要求の単価は料金のページで確かめられなかった [未確認]。Admin のログインの回数は少ない見込みで、要求の費用は小さい [推測] | — |
| 呼び出しの上限 | RSA の暗号操作の要求の上限（クォータ）は確かめていない [未確認]。Admin のログインの頻度では問題にならない見込み [推測] | — |

#### A.5.2 鍵ポリシー（案）

N6 で動かした形（管理はアカウントに残し、Sign を Deny で絞る）を元にした案。値は例。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AccountAdministration",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111111111111:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "DenySignExceptSigner",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "arn:aws:iam::111111111111:<署名役>" } }
    },
    {
      "Sid": "DenySignOtherForms",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "StringNotEquals": { "kms:MessageType": "RAW" } }
    },
    {
      "Sid": "DenySignOtherAlgorithms",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "StringNotEquals": { "kms:SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256" } }
    }
  ]
}
```

| 要点 | 内容 |
|---|---|
| Sign を絞る | **Deny で絞る**。N6 では、`AdministratorAccess` の管理者の Sign も鍵ポリシーの明示の Deny で拒否された。署名役でも `MessageType: DIGEST` と `RSASSA_PSS_SHA_256` は拒否され、`RAW` と PKCS1 だけが通った [確認済み: N6 の K2] |
| 縛れないもの | **署名する中身（`sub`・タグなどの claim）を縛る条件キーは、KMS の条件キーの文書で見た範囲には無い**。条件で縛れるのは形式（`kms:MessageType`）と方式（`kms:SigningAlgorithm`）まで。つまり **Sign を呼べる者は、任意の Admin のトークンを作れる** [確認済み: N6 の K2 と KMS の条件キーの文書] |
| 署名役 | IAM の側でも `kms:Sign` だけ、対象はこの鍵だけ。`GetPublicKey`・鍵の管理・`Verify` を持たせない。署名役で別の鍵に Sign できないことは N6 で測っていない [未検証] |
| 管理 | N6 はアカウントの root の文（アカウントに管理を委ねる既定の形）を残した。`DisableKey` などの管理の権限は、署名用のアカウントの IAM で鍵の管理役に絞る。**Worker の認証情報からは届かない**主体にする。入口が Entra に依存しなければ停止の経路になる（§A.8。E0 との関係） |
| JWKS | 公開鍵は `GetPublicKey`（DER の SubjectPublicKeyInfo）で取り、**デプロイの時に** JWK に直して Admin の Worker に静的に入れる。Worker に `GetPublicKey` の権限を与えない。JWKS は KMS の可用性に依存しない [確認済み: N6 の形] |
| 送信元の条件 | `aws:SourceIp` で Cloudflare の出口に絞る案は、出口のアドレスが Cloudflare の利用者全体で共有され、N6 では Sign と STS の送信元も毎回違ったので、効果は弱い [確認済み: N6 の K4（送信元の不一致）。絞った場合の動作は未測定]。Cloudflare Gateway の専用の出口 IP（Enterprise のプラン）を Workers の出口に使える形が文書にあるが、KMS の呼び出しで使えるかは確かめていない [未検証] |

---

### A.6 Worker が KMS を呼ぶ認証情報の候補

> **決裁の結果**（G1・G1-b・X1。以下の「作成者の推奨」は審議時点の記述）: G1 は第一候補を **C-4**、A-2 の退避先に C-2 を置かず、C-2'・C-3 を不採用とした（C-1・C-1' は選ばれていない）。G1-b は C-4 を、呼び出しの秘密ありの形（A.2 の条件）で採った。X1 の決裁は、A-2 を AWS 側に置くこと自体を外した。

Cloudflare Workers には、AWS に直接使えるワークロードの ID（Workers の実行環境が発行する、AWS の IAM が信頼できるトークン）は、Cloudflare の文書を探した範囲では見つからなかった [未確認。N6 の調査でも同じ]。そのため、Admin の Worker は **何らかの秘密を持つ**。C-4 を除くどの案でも、その秘密が漏れれば `kms:Sign` を呼べ、**任意の Admin のトークン**（任意の email・チームのタグで、Admin のプロバイダーを信頼する全アカウントの Administrator）を作れる（鍵ポリシーで中身は縛れない。§A.5.2）。KMS が防ぐのは「鍵そのものの持ち出し」で、「署名を頼まれること」は防がない [資料: Sol のレビューの指摘 3、console-login.md §5.1 の A2]。

N6 の比較表（6 候補）と突き合わせた候補。名前は C-1〜C-5 とし、N6 の結果の番号（K1〜K5。§A.10）と区別する。N6 での名前を括弧に書いた。どれを採るかは G1 で決める:

| 案 | 内容 | Worker に置く秘密 | 漏れたときの被害 | N6 |
|---|---|---|---|---|
| **C-1 IAM ユーザーのアクセスキー**（N6 の A） | 署名用のアカウントに `kms:Sign` だけを許す IAM ユーザーを作り、そのアクセスキーで SigV4 の署名をして KMS を呼ぶ | アクセスキー ID とシークレット（Workers secret） | 無効化するまで、任意の Admin のトークン | **実装・実測**（N6 の K1〜K5） |
| C-1' C-1 のキーを Cloudflare の Secrets Store に置く（N6 の A'） | C-1 と同じ。置き場所だけアカウント単位の Secrets Store にする | 同じ（Secrets Store） | C-1 と同じ | 文書だけ。値の作成とバインドを役割で分けられ、監査ログがある（N6 の記録が引く Cloudflare の文書）。長期の秘密であることは同じ |
| **C-2 WebIdentity のブートストラップ**（D4 の (b) の元の案） | Admin の Worker が、**Admin 専用の小さな鍵（ブートストラップの鍵）**で短命の JWT を作り、署名用のアカウントの**ブートストラップ専用の OIDC プロバイダー**に対して `AssumeRoleWithWebIdentity` で署名役のロールを引き受ける。得た一時認証情報（1 時間など）で KMS を呼ぶ。一時認証情報は isolate の中に有効期限の手前までキャッシュする | ブートストラップの鍵（Workers secret） | 止めるまで、任意の Admin のトークン | 未実装 |
| C-2' ブートストラップに Standard の鍵を使う（N6 の C） | C-2 のブートストラップの JWT を Standard の鍵で作る | Standard の鍵 | **Standard の鍵が漏れると Admin のトークンも作れる** | 未実装。D3・D4 の意図（Admin は Standard の鍵の漏れから分ける）に反するので**採らない**（作成者の扱い） |
| **C-3 IAM Roles Anywhere**（N6 の B） | 署名用のアカウントに信頼アンカー（自前の CA か AWS Private CA）を置き、X.509 の証明書と秘密鍵で `CreateSession` を呼んで署名役のロールの一時認証情報を得る [確認済み: IAM Roles Anywhere の信頼モデルと CreateSession の文書] | 証明書と秘密鍵（Workers secret） | 証明書の期限か失効まで、任意の Admin のトークン | 未実装 |
| **C-4 AWS 側の署名役が Access JWT を検証してから署名**（N6 の D） | Worker は利用者の Cloudflare Access JWT（Admin の階層のチームのアプリの AUD）を AWS 側の署名役（例: Lambda）に渡す。署名役が Access の JWKS で検証し、claim を自分で組み立て、自分の実行ロールで Sign する | 署名役の入口を呼ぶための認証情報 | **Worker 側の認証情報だけでは任意の中身に署名できない**（有効な Access JWT が要る）。Access JWT も盗まれると、その利用者として発行できる | 未実装（文書だけ） |
| C-5 Cloudflare の Worker の身元を AWS に連携する（N6 の E） | Cloudflare が Worker に OIDC トークンを発行し、AWS が信頼する形 | なし | — | 文書を探した範囲では見つからなかった（無いとは言えない） |

#### A.6.1 比較

| 観点 | C-1 IAM ユーザーのアクセスキー | C-2 WebIdentity のブートストラップ | C-3 IAM Roles Anywhere | C-4 AWS 側の署名役 |
|---|---|---|---|---|
| 漏れたときの被害 | 任意の Admin のトークン（止めるまで） | 同じ | 同じ（証明書の有効期限まで、または止めるまで） | Worker の秘密だけなら署名役の入口を叩けるだけ。Access JWT も要る |
| 秘密の寿命 | 長期（手で替えるまで） | ブートストラップの鍵は長期。AWS の認証情報は短命 | 証明書の有効期限で上限が決まる | 入口の認証の方式次第 |
| 長期の AWS の認証情報 | **ある**（会社の方針でセキュリティ例外になりうる [推測]） | ない | ない | 入口の認証の方式次第（Worker から AWS の入口を呼ぶ認証が別に要る） |
| 停止の手段 | アクセスキーの無効化・削除。共通: `DisableKey`・鍵ポリシーの変更・JWKS から `kid` を外す | ブートストラップのプロバイダーの削除・署名役の信頼ポリシーの変更・署名役の revoke。共通: 同じ | 信頼アンカーの無効化・CRL [確認済み: AWS Security Blog]。共通: 同じ | 署名役の停止。共通: 同じ |
| ローテーション | アクセスキーを 2 つ並べて切り替える [推測: IAM の一般的な手順] | JWKS に 2 つの `kid` を並べて切り替える（N6 の K5 と同じ型） | 証明書を作り直す。CA の運用が要る | 入口の認証による |
| 所要時間 | Sign の往復は中央値 11 ms、ログイン全体は中央値約 210 ms（大半は `getSigninToken`）[確認済み: N6 の K3] | C-1 に、一時認証情報の取得（キャッシュが切れたときだけ）が足される [推測] | C-2 と同じ型 [推測] | 往復が 1 段増える [推測] |
| 実装の手間 | 小さい（SigV4 だけ。N6 で実装済み） | 中（ブートストラップの JWT と STS の呼び出しは今の `src/oidc.ts`・`src/sts.ts` と同じ形 [推測]）。ブートストラップの issuer の公開文書の置き場所が要る | 大（`CreateSession` 用の X.509 の SigV4 を自前で実装する。N6 で使った `aws4fetch` には無い）。CA の運用 | 大（署名役のデプロイ、Access の JWKS の取得、時計、Access JWT の再利用の対策、AUD → チームの対応（A12）を AWS 側にも持つ） |
| Cloudflare の侵害（Worker のコード・secret を使える。A2・A16） | 秘密を読まれる・署名処理を悪用される。任意の Admin のトークン | 同じ（ブートストラップの鍵を読まれる・悪用される） | 同じ（証明書の秘密鍵） | 署名役の入口を呼ばれ、通る利用者の Access JWT を盗まれうる。その利用者として発行される |
| Cloudflare の侵害（Admin の issuer の JWKS・DNS・Routes・Custom Domain を差し替えられる。A13〜A15） | **KMS を迂回される**: 攻撃者の鍵を JWKS に載せれば、その鍵で任意の Admin の JWT を作れる。KMS の Sign の記録も残らない | 同じ。加えて、ブートストラップの issuer の JWKS を差し替えられると、鍵を盗まずに署名役になれる | 同じ | 同じ（署名役も迂回される） |
| D3 との関係 | — | ブートストラップの鍵と issuer は Standard・MCP・Admin の発行用と共有しない（C-2' は採らない） | — | 検査の 9 段の一部（AUD → チーム、claim の組み立て）が AWS 側に移る。portal §9.3 との整合を設計し直す |
| 費用 | なし | IAM だけ（無料） | AWS Private CA なら月額 [未確認] | 署名役の実行の費用 [未確認] |

#### A.6.2 推奨

- 作成者の推奨: **C-2**（WebIdentity のブートストラップ）。理由: D4 の元の案で、長期の AWS の認証情報を Worker に置かない。止め方と差し替えは JWKS に `kid` を並べる型で、N6 の K5 で新旧 2 つの `kid` の切り替えが動いた。Sign の往復は中央値 11 ms で、C-2 で足される一時認証情報の取得もキャッシュすればログインの所要時間に大きく効かない見込み [推測: N6 の K3 からの見込み。C-2 自体は測っていない]
- 条件（案）: ブートストラップの鍵と issuer は Admin 専用（Standard・MCP・Admin の発行用と共有しない。C-2' は採らない）。ブートストラップのプロバイダーは署名用のアカウントにだけ登録する。署名役のロールの信頼ポリシーはそのプロバイダーの `aud` と `sub`（固定値）で絞る。署名役の権限は `kms:Sign` だけで、鍵ポリシーの Deny でも絞る（§A.5.2）。ブートストラップの issuer の公開文書は Admin の Worker が出す（§2.2 の順で、プロバイダーより先に公開する）
- 退避先: **C-1**。N6 で最小権限の形（IAM は `kms:Sign` だけ、鍵ポリシーで署名役以外・`RAW` 以外・方式違いを Deny）で動いた [確認済み: N6 の K2]。長期の AWS の認証情報になるので、会社で使うときは人の判断（セキュリティ例外に当たるか）が要る [推測]
- **C-4 は、被害の大きさを変えられる唯一の候補**（Worker の認証情報だけでは任意の中身に署名できない）。部品と往復が増え、検査の 9 段の一部が AWS 側に移る。「Sign を呼べる＝任意の Admin のトークン」（§A.5.2）を受け入れられないなら、G1 で C-4 を検討してほしい [推測]
- C-3 は、会社に既存の PKI と運用があるなら候補になる。今は手間に見合わない [推測]

**どの案でも残ること**: Worker か秘密が奪われると（C-4 では Access JWT も）、止めるまで Admin のトークンを作られる。**Admin の issuer の JWKS を差し替えられると、どの案でも KMS と署名役は迂回され、KMS の Sign の記録も残らない**（§2.1。issuer の DNS・TLS・Worker・Routes・Custom Domain・デプロイの権限は、Administrator を配る全アカウントの Admin の権限と同じ重さで扱う）。KMS で得るのは、(1) 鍵そのものは持ち出されない、(2) 署名の全件が Cloudflare の外（署名用のアカウントの CloudTrail）に残る（N6 の K4）、(3) Cloudflare と各アカウントに触らずに `DisableKey` で新しい署名を止められる（N6 では完了から +1.1〜2.1 秒で止まり始め、最後の成功は +5.3 秒。2 回の観察。§A.8）、の 3 つ。止める前に作られたトークンの扱いは §A.7.2・§A.8。

---

### A.7 鍵の差し替え（KMS の場合）

3 つの場面に分ける。console-login.md §2.2 の「1 つの issuer に 1 つの鍵」は**平常時の署名に使う鍵が 1 つ**という意味で、差し替えの間だけ JWKS に `kid` が 2 つ並ぶ（MCP 用と同じ）[推測: 決裁の文言の読み。G1 で確認]。

#### A.7.1 計画的な差し替え（KMS の鍵を新しくする）

architecture.md「鍵のローテーション」の手順と同じ型（JWKS に先に載せ、STS が取り込んでから署名を切り替える）[資料]。

| 段 | 操作 | JWKS | 署名する鍵 | 次に進む前に |
|---|---|---|---|---|
| 0 | 通常 | 今の鍵 | 今の鍵 | — |
| 1 | 新しい KMS の鍵を作る（同じ鍵ポリシー）。`GetPublicKey` から JWK を作り、Admin の Worker の JWKS に足してデプロイ | 今 + 新 | 今の鍵 | STS の JWKS のキャッシュが切れるまで。MCP 用の手順は最低 1 時間・安全側に 24 時間（キャッシュの長さは公開されていない [資料: architecture.md]）。N6 では、JWKS に足した新しい `kid` の署名が **1 回目から**受理された [確認済み: N6 の K5。1 回の観察] ので、待ち時間を短くできる見込みがある。キャッシュの有無と長さは確かめていない（N5） |
| 2 | Worker の設定の「署名に使う鍵」（鍵の ARN と `kid` の組）を新しい鍵に替えてデプロイ | 新 + 今 | 新しい鍵 | 自前の JWT の有効期限（約 5 分）以上 |
| 3 | 古い `kid` を JWKS から外してデプロイ（N6 では外した直後から古い `kid` の JWT が `InvalidIdentityToken` になった。1 回の観察）。古い鍵を `DisableKey`。しばらく様子を見て `ScheduleKeyDeletion`（待ち期間は 7〜30 日 [確認済み: AWS Security Blog の KMS の鍵の削除の記事]） | 新 | 新しい鍵 | — |

- 署名に使う鍵は、エイリアスではなく**鍵の ARN と `kid` の組**で設定に持つ案 [推測]。エイリアス（`Sign` はエイリアスでも呼べる [確認済み: Sign の API 文書]）を付け替えると、JWT のヘッダーの `kid` と実際の鍵がずれる時間ができるため
- 平常時の差し替えの周期は G1 で決める（自動のローテーションはない。§A.5.1）

#### A.7.2 Worker の認証情報の漏えい（KMS の鍵は持ち出されていない）

- 替えるのは認証情報（C-2 ならブートストラップの鍵、C-1 ならアクセスキー）。各アカウントのプロバイダーと信頼ポリシーには触らない
- ただし、**漏れていた間に作られた Admin の JWT** は KMS の鍵で正しく署名されているので、その `kid` が JWKS にある間は STS に受理されうる。攻撃者は `exp` を自由に決められる。STS が `exp` の遠いトークンを受け付けるか（トークンの寿命の上限）は N6 で測っていない [未検証: N6-7]。`DisableKey` は新しい署名を止めるだけで、作られた JWT は止めない [確認済み: N6 の K4]
- そのため、認証情報の漏えいでも、**その間の Sign を CloudTrail と発行記録で突き合わせて説明できないものがあれば、KMS の鍵も差し替える**（§A.7.1 を急ぎで行い、古い `kid` を JWKS から外す）。N6 では、JWKS から外した `kid` の JWT は外した直後に拒否された（1 回の観察）[確認済み: N6 の K5]。STS がキャッシュを持たない保証はない（N5）ので、確実に止めるには L2（Admin のプロバイダーの削除）と L3（Administrator のロールの revoke）を合わせる [推測]
- 突き合わせで説明できない Sign がなければ、KMS の鍵は替えなくてよい [推測: G1 で判断を求める]

#### A.7.3 世代つきの新しいパス（鍵が漏れた・JWKS を信用できない）

- console-login.md §3.1 の規則: 平常時の URL に世代を入れず、必要なときに世代を付けた新しいパス（例 `/admin-2`）に移る（`^[a-z0-9-]+$`）
- 手順の案（Standard も同じ）: (1) 新しい鍵と新しい issuer（世代つきのパス）を用意 (2) 基盤のスタックの `AdminPath` を新しいパスにした版で、新しいプロバイダーを配る（古いものと並べる。プロバイダーは issuer の URL ごとに 1 つ）(3) Administrator のロールの信頼ポリシーの `Principal` と条件キー（`<host>/<path>:aud`）を新しいプロバイダーに切り替える (4) 古いプロバイダーを削除する (5) 古いプロバイダーで作られたセッションを revoke（L3。解除は console-login.md §6.3 の条件）[推測: 前の版で「段階 2 の前に書く」とされていた手順の案。N5 と一緒に G2 で確かめる]
- KMS の場合、鍵そのものは漏れないので、世代つきのパスに移るのは「Admin の issuer の JWKS（Cloudflare の側）を信用できない」とき（A13〜A15 の侵害）と、§A.7.2 で N5 の結果が悪いとき [推測]

---

### A.8 停止（KMS の場合）

console-login.md §6 の L0〜L3・L3-1 に、KMS の操作を足す。

| # | 手段 | 止まるもの | 止まらないもの | 実測 |
|---|---|---|---|---|
| H-0 | **`DisableKey`**（鍵の管理役。署名用のアカウント） | 新しい署名（= Admin の新しい発行）。Cloudflare と各アカウントに触らない | 既に作られた JWT（`kid` が JWKS にあり、期限内なら受理されうる）と、発行済みの AWS のセッション | **N6（2 回）**: `DisableKey` の完了から、最初の失敗は +2.1 秒・+1.1 秒。1 回目は止まり始めてから成功が 3 回混ざり、最後の成功は +5.3 秒（結果整合）。2 回目は完了後の成功 0。`EnableKey` から成功に戻るまで 3.2 秒・1.2 秒 [確認済み: N6 の K4]。止まるのは新しい署名だけ。JWKS は静的なので、無効化しても `kid` は公開されたまま |
| H-1 | Worker の認証情報の無効化（C-2: ブートストラップのプロバイダーの削除か署名役の信頼の変更、C-1: アクセスキーの無効化） | 新しい署名 | H-0 と同じ。C-2 では署名役の発行済みの一時認証情報が残るので、署名役の revoke も行う [推測] | 未測定 |
| H-2 | 鍵ポリシーで署名役の Sign も Deny する | 新しい署名 | H-0 と同じ | 未測定 |
| H-3 | JWKS から `kid` を外す（Admin の Worker のデプロイ） | その鍵で作られた JWT の新しい引き受け（作られた JWT を含む） | 発行済みの AWS のセッション。Cloudflare の操作に依存する | N6 で外した直後に `InvalidIdentityToken`（1 回の観察）[確認済み: N6 の K5]。STS のキャッシュは未確認（N5） |
| L2 | Admin のプロバイダーの削除（各アカウント） | 新しい引き受け（作られた JWT の利用も含む） | 発行済みの AWS のセッション | Standard の形で約 12 秒 [資料: console-login.md §6.1] |
| L3・L3-1 | Administrator のロールの revoke / 1 人の Deny | 発行済みの AWS のセッション | — | Viewer の形で確認済み。Administrator で確かめるのは ②（console-login.md §7.5） |

停止を段階に分ける（時間は観察値で、保証値ではない。JWKS から `kid` を外すことも即時の失効の手段として保証せず、AWS 側の手段と組み合わせる）:

| 段階 | 止める手段 | 観察した時間 | 止まらないもの |
|---|---|---|---|
| 新しい署名 | H-0（`DisableKey`）・H-1・H-2 | H-0: 完了から +1.1〜2.1 秒で止まり始め、最後の成功は +5.3 秒（N6。2 回）。H-1・H-2 は未測定 | 作られた JWT。JWKS の差し替えによる発行（KMS を通らない） |
| 作られた JWT からの新しい STS セッション | H-3（JWKS から `kid` を外す）・L2（プロバイダーの削除） | H-3: 外した直後に拒否（N6。1 回）。L2: Standard の形で約 12 秒（前の PoC） | 発行済みの AWS のセッション |
| 既存のセッション（STS・コンソール・`aws login`） | L3（revoke）・L3-1 | Viewer の形で確認済み（console-login.md §6.1）。Administrator は ② で確かめる | 外すと再ログインなしで戻る（console-login.md §6.3。最長のセッションが切れるまで外さない） |
| 残った権限（Administrator が作ったアクセスキー・ロール・プロバイダー・信頼の変更など） | 棚卸しと個別の削除。Admin の守りの部品は Administrator が外せる（console-login.md §4.8） | 未設計 | revoke では止まらない。Admin が解除できない守り（SCP など）をどこまで置くかは §A.11 で G1 に審議を求める |

手順の案（Admin の鍵か Worker の侵害）:

1. **新しい署名を止める**: H-0（`DisableKey`）。Cloudflare の操作に頼らない。Entra に依存しない入口で署名用のアカウントに入れるなら、H-0 は Entra を通らない停止の経路の一部になる（E0 の受容は G5 の前まで。console-login.md §6.6）[推測]
2. **作られた JWT を使わせない**: KMS の鍵の `kid` を JWKS から外す（H-3。N6 では直後に拒否）。確実にするには、Administrator を配った各アカウントの Admin のプロバイダーを削除（L2）
3. **発行済みを止める**: 新規が止まったことを確かめてから L3（console-login.md §6.2 の順）
4. **調べる**: §A.9 の突き合わせ
5. **戻す**: 原因を取り除く → 認証情報の差し替え（と必要なら KMS の鍵の差し替え。§A.7）→ `EnableKey` かプロバイダーを作り直す → console-login.md §6.3 の解除の条件で revoke を外す

- 退職・端末の紛失など 1 人の停止は Standard と同じ（L1 と L3-1。過去の email も Deny。console-login.md §6.2）
- 鍵の削除（`ScheduleKeyDeletion`）は停止の手段にしない。待ち期間（7〜30 日）があり、削除されると取り消せない。原因の調べが済むまで `DisableKey` のままにする [推測]。削除の予約中（`PendingDeletion`）の Sign の挙動と、鍵ポリシーの変更（H-2）で止まるまでの時間は N6 で測っていない

---

### A.9 監査（KMS の場合）

**AWS の記録には、Sign と `AssumeRoleWithWebIdentity` を結ぶ共通の項目が無い**。送信元の IP も N6 の 28 組すべてで違った（どちらも Cloudflare の出口だが別のアドレス）ので、IP では突き合わせられない [確認済み: N6 の K4]。結ぶのは Worker の発行記録で、主なキーは **JWT の `jti` と、STS の `webIdentityTokenId`** にする。

| 記録 | 置き場所 | 中身（N6 で見たもの） | 突き合わせのキー |
|---|---|---|---|
| Admin の Worker の発行記録 | Logpush で自社のセキュリティ用の置き場所（portal §10.3） | portal §10.3 の項目（`jti`・STS の応答の 3 つの ID など）に、**KMS の鍵の ARN・`kid`・KMS の Sign の要求 ID（`RequestId`）**を足す（案） | `jti`、KMS の `RequestId`、STS の応答の ID |
| `AssumeRoleWithWebIdentity` | Administrator を配った各アカウントの CloudTrail | **`requestParameters.webIdentityTokenId` が JWT の `jti` と 28/28 一致**。ほかに `roleSessionName`・`sourceIdentity`・`principalTags`・`userIdentity.userName`（= `sub`）・`identityProvider` [確認済み: N6 の K4] | `webIdentityTokenId` = `jti`（主）。STS の応答の 3 つの ID（console-login.md §5.6） |
| KMS の Sign | 署名用のアカウントの CloudTrail | `userIdentity`（呼び出し元・アクセスキー ID）、`requestParameters`（`keyId`・`signingAlgorithm`・`messageType`）、**`requestID`（= KMS の応答の `RequestId`）**、`sourceIPAddress`、`tlsDetails`。**署名した中身・ダイジェストは残らない**。`userAgent` は無かった [確認済み: N6 の K4・KMS の CloudTrail の Sign の例] | `requestID` = 発行記録の KMS の `RequestId` |

突き合わせ（案）:

| # | 見るもの | 疑うこと |
|---|---|---|
| 1 | 引き受けの記録で、`webIdentityTokenId` が発行記録の `jti` に無いもの | 作られた JWT か、Worker の外からの発行 |
| 2 | Sign の記録で、`requestID` が発行記録の KMS の `RequestId` に無いもの | 署名役の認証情報が Worker の外で使われた |
| 3 | 発行記録にあって、Sign か引き受けの記録に無いもの | 記録の欠け（反映の遅れを除く） |

- 時刻は同じ秒に並んだ（表示した行で確認）。CloudTrail のイベント履歴への反映の遅れは、観察した範囲で約 1 分〜2 分 20 秒の間だった（Sign は約 2 分後の照会で見えた。`DisableKey` は約 1 分後の照会では見えず、約 2 分 20 秒後に見えた）[確認済み: N6 の K4。照会の時刻からの観察で、保証値ではない]。突き合わせは反映を待ってから行う
- **N6 の案 2（`RoleSessionName` に KMS の `RequestId` を入れる）は採れない**: コンソールログインの `RoleSessionName` は `console-<email>` に確定している（console-login.md §3.4。変えにくい名前）。N6 の 28/28 の対応は、この案 2 と `jti` の両方で取れた [確認済み: N6 の K4]
- **失敗の記録**（N6）: `DisabledException` の Sign は `keyId` 付きで残った。`AccessDenied` の Sign は残ったが `requestParameters` が空で `resources` も無く、鍵の ARN と呼び出し元は `errorMessage` の文の中にだけある（`DIGEST` と PSS のどちらで拒否されたかは分からない）。`InvalidIdentityToken` で失敗した `AssumeRoleWithWebIdentity` は、約 10 分後の照会でもイベント履歴に見当たらなかった（記録されないのか、もっと遅れるのかは未確認）[確認済み: N6 の K4]。拒否の見張りを CloudTrail だけに頼らない
- **console-login.md との整合**: console-login.md §3.4・§5.6 と portal §10.3 の「`jti` は CloudTrail に引き継がれない」は、N6 の観察に合わせて訂正した。Standard の発行記録にも `jti` を残し、同じキーで突き合わせる
- **突き合わせは検知の材料で、完全性の証明ではない**。侵害された Worker は偽の発行記録も作れる。同じ `jti` の JWT を有効期限の間に何度も引き受けに使える。Sign のあとのタイムアウトや STS の失敗でも、対応のない記録が生じる。欠けや食い違いを攻撃と断定せず、再試行・重複・反映の遅れを見分ける [資料: Sol のレビュー（2026-11-12）]
- Worker を通った署名の記録は、Cloudflare が侵害されても署名用のアカウントに残る（署名用のアカウントの管理が別なら）[資料: 前の設計上申 §7.1]。ただし Admin の issuer の JWKS を差し替えられた場合は KMS を通らないので、Sign の記録は残らない。その発行は表の 1（引き受けの記録で発行記録に無いもの）でしか見つからない
- **KMS の記録を外させない**: CloudTrail には証跡ごとに KMS のイベントを除外する設定がある（`ExcludeManagementEventSources: kms.amazonaws.com`、または高度なイベントセレクターで `eventSource` を除外）[確認済み: KMS の CloudTrail の文書]。また Sign は読み取り（`readOnly: true`）の管理イベントなので、書き込みだけを記録する証跡には入らない [確認済み: 同じ例の `readOnly`。証跡の設定との関係は [推測]]。署名用のアカウントの証跡は読み取りを含む管理イベントを記録し、`cloudtrail:PutEventSelectors` を持つ主体を絞り、変更を通知する
- 見張り（案）: Sign の回数の急増、発行記録との件数のずれ（表の 1〜3）、`DisableKey`・`PutKeyPolicy`・`ScheduleKeyDeletion` の実行。署名役の送信元の IP は、Cloudflare の出口が共有で毎回変わるので、手がかりにならない
- G5 の合格条件「Administrator の発行記録と通知が ② で動いた」「突き合わせで説明できない引き受けなし」は、この表の 1〜3 を含める案 [推測]

---

### A.10 N6 の PoC の結果（KMS の署名）

開発環境（開発用の AWS アカウント 1 つ・東京リージョン、Cloudflare の workers.dev の Worker、colo は東京）で、2026-11-12 に行った。道具と手順は `scripts/poc/admin-kms/README.md`。識別子は書かない。回数の少ない測定（各 1〜2 回の観察）はそう書いた。PoC は C-1 の候補（IAM ユーザーのアクセスキー）で動かした。

| # | 結果 | 要点 | 未測定・注意 |
|---|---|---|---|
| K1 | **成立** | RS256（`RSA_2048` / `RSASSA_PKCS1_V1_5_SHA_256`）と ES256（`ECC_NIST_P256` / `ECDSA_SHA_256`）の両方で、KMS で署名した JWT による `AssumeRoleWithWebIdentity` と `getSigninToken` が通った。両方の鍵を混在させた JWKS でも両方通った。20 回すべて成功（各 10 回）。SourceIdentity とセッションタグ付き（既存 PoC と同じ形の信頼ポリシー） | RS384 などほかの方式は試していない |
| K2 | **最小権限の形で動いた**（どれを採るかは決めない。§A.6） | IAM ユーザーは `kms:Sign` だけ。鍵ポリシーで、`aws:PrincipalArn` が Worker の主体以外・`kms:MessageType` が `RAW` 以外・`kms:SigningAlgorithm` が鍵の方式以外の Sign を Deny。`AdministratorAccess` の管理者の Sign は明示の Deny で拒否。Worker の主体でも `DIGEST` と PSS は拒否。`GetPublicKey` はデプロイの時に管理者が呼ぶだけ | **署名する中身を縛る条件キーは無い**（§A.5.2）。Worker の主体で別の鍵に Sign できないこと、`aws:SourceIp` で絞る案は未測定 |
| K3 | 所要時間 | Sign の往復は中央値 11 ms（RSA・EC とも。p90 は 36・39 ms）。ログイン全体（Worker の中）は中央値約 210 ms、手元から見た往復は約 290〜300 ms。大半は `getSigninToken`（中央値 163 ms）。RSA と EC の差は見えなかった。初回はログイン全体で約 0.7 秒 | 測ったのは東京の colo と東京リージョンだけ。ログインの中の Sign（中央値 26〜27 ms）が Sign だけを続けた場合より遅い理由は未確認（要求ごとに新しい接続になっている可能性） |
| K4 監査 | **突き合わせられる**（§A.9） | Sign は CloudTrail に残る（`requestID` = KMS の応答の `RequestId`。中身は残らない）。`AssumeRoleWithWebIdentity` の `webIdentityTokenId` が `jti` と 28/28 一致。送信元の IP は 28 組すべてで Sign と STS が違い、IP では突き合わせられない | AWS 側に Sign と引き受けを結ぶ共通の項目は無い。`AccessDenied` の Sign は `requestParameters` が空。`InvalidIdentityToken` の引き受けはイベント履歴で見当たらなかった。反映の遅れは観察した範囲で約 1 分〜2 分 20 秒の間 |
| K4 停止 | **`DisableKey` の完了から +1.1〜2.1 秒で止まり始め、最後の成功は +5.3 秒。発行済みは止まらない** | 完了から最初の失敗まで +2.1 秒・+1.1 秒。1 回目は成功が 3 回混ざり、最後の成功は +5.3 秒。`EnableKey` から戻るまで 3.2 秒・1.2 秒 | 2 回だけ。止まるのは新しい署名だけで、署名済みの JWT（5 分）・STS のセッション・コンソールは止まらない（それらは前の PoC の P4 の手段）。`PendingDeletion` 中の挙動、鍵ポリシーの変更で止める時間は未測定 |
| K5 | **新旧 2 つの `kid` を並べて切り替えられた** | JWKS に新しい `kid` を足すと、その署名が 1 回目から成功。新しい `kid` だけの JWKS にした直後、古い `kid` の JWT は `InvalidIdentityToken` | 各 1 回の観察。STS の JWKS のキャッシュの有無と時間は確かめていない（Worker は `cache-control: max-age=300` を付けた）。運用は「新を足す → 新で署名 → 旧の JWT の期限が過ぎてから旧を外す」の順（§A.7.1） |

途中で分かったこと（設計に効くもの）:

- **IAM は OIDC プロバイダーの作成時に issuer の discovery を読み、読めないと作成が失敗する**。鍵 → Worker → プロバイダーの順のデプロイが要る（§2.2）。プロバイダーと同じスタックで作った KMS の鍵は、ロールバックで削除の予約になった
- 片付け: PoC の AWS と Cloudflare の資源は削除済み（KMS の鍵は削除の予約中）

N6 の項目と結果の対応:

| # | 確かめること | 結果 |
|---|---|---|
| N6-1 | KMS の `Sign`（RS256）で作った JWT を STS が受理するか | **成立**（ES256 も成立）。K1 |
| N6-2 | 署名の遅延（portal §12.3 の P-6） | Sign は中央値 11 ms、ログイン全体は中央値約 210 ms。K3 |
| N6-3 | Worker が KMS を呼ぶ認証情報が Worker から使えるか | **C-1（IAM ユーザーのアクセスキー）で成立**。推奨の C-2（ブートストラップ）は測っていない |
| N6-4 | `DisableKey` が `Sign` に効くまでの時間と `EnableKey` で戻る時間 | +1.1〜2.1 秒で止まり始め、最後の成功は +5.3 秒。`EnableKey` から 1.2〜3.2 秒で戻る（2 回の観察）。K4 |
| N6-5 | 鍵ポリシーの条件で違う形・方式の Sign が拒否されるか | **拒否された**（`DIGEST`・PSS・署名役以外）。K2 |
| N6-6 | Sign の記録の中身と要求 ID の一致 | `requestID` = `RequestId`。中身は残らない。K4 |
| N6-7 | `exp` の遠い JWT を STS が受理するか | **未測定** |

---

### A.11 Sol のレビュー（G1。2026-11-12。決裁ではない）

外部レビュー（決裁ではない）の要点。中身の判断は G1 で求める。この文書の推奨は書き換えていない。

| 区分 | 指摘の要点 | 関わる節 |
|---|---|---|
| 認証方式 | C-2 の優位性は過大。長期の AWS アクセスキーはなくなるが、署名役の資格情報を何度でも得られる長期の秘密（ブートストラップの鍵）が残る。C-1 より安全とは今は判断できない | §A.6.2 |
| 認証方式 | 推奨は**条件付きの C-4**: AWS 側が Access JWT の署名・issuer・Admin 専用の aud・有効期限・利用者の種別を検証し、利用者 → チーム → 対象アカウントとロールを独立に認可して claim を作る。Worker が渡す email・タグ・対象ロールを信用すると効果がない。C-1 は残るリスクを明示した限定の PoC 用、C-2 は運用上の利点を実証してから再評価 | §A.6 |
| 信頼の境界 | JWKS の差し替えで KMS と C-4 を丸ごと迂回できる（Sign の記録も残らない）。issuer の DNS・TLS・Worker・Routes・Custom Domain・デプロイの権限は、全対象アカウントの Admin の権限として管理する。I-B は同じ管理権限からの隔離ではない | §2.1・§A.6.1 |
| 信頼の境界 | 5 分の `exp` は署名役の侵害時の上限ではない（任意の `exp`・`iat`・`jti` を付けられる。`DisableKey` 後も使われうる）。**長寿命の JWT の試験は承認の前に必須** | §A.7.2・§A.10（N6-7） |
| 信頼の境界 | Administrator による永続化と停止の回避が未整理（ロールの信頼・権限、プロバイダー、別の管理者、アクセスキーの作成で revoke 後も権限が残る）。監査の停止の Deny だけでは足りない。**Admin が解除できない守り（SCP など）**で、信頼の基盤・停止の仕組み・ログ・永続の資格情報の作成をどこまで守るか | §A.8、console-login.md §4.8・§6.5 |
| 信頼の境界 | プロバイダーが 1 つというだけではチームの境界にならない。各ロールで aud とチーム・利用者・対象アカウントの対応を強制する条件が要る。ただし署名者が自由に付けるタグ・email・SourceIdentity は、署名者の侵害への防壁にも独立した本人の証明にもならない | console-login.md §4.3・§4.8 |
| 停止 | 停止の時間を 1 つの数値にしない（新しい署名・作られた JWT からの新しい STS・既存のセッション・作られた永続の権限）。JWKS からの除去は即時の失効として保証せず、AWS 側の信頼の拒否・権限の Deny と組み合わせる | §A.8 |
| 停止 | revoke の対象（署名役の資格情報・各 Administrator のロール・そこから引き受けたセッション）と復旧の条件を分ける。email・SourceIdentity が偽造される侵害では 1 人の Deny は足りない。新しい引き受けの阻止と既存の権限の遮断はできるだけ並行で行い、revoke を外したときの旧セッションの復活も確かめる | §A.8 |
| 差し替え | 通常のローテーションと侵害時の交換を分ける。通常は JWT の有効期間・時刻のずれ・STS のキャッシュを踏まえた重複期間、侵害時は旧鍵の受理の終了を優先。認証情報だけの漏えいでも長寿命の JWT を作られうるので、秘密鍵が漏れていなくても KMS の鍵の交換が要る条件を定義する | §A.7 |
| 監査 | 突き合わせは検知の材料で、完全性の証明ではない（偽の発行記録、同じ `jti` の再利用、Sign 後の失敗）。再試行・重複・遅延をモデル化する。C-4 なら AWS 側で claim や署名対象のハッシュ・認可の結果・RequestId を独立に記録する価値がある | §A.9 |
| G1 の承認条件 | 追加の決定事項: ① 許容する侵害主体と最大の影響範囲 ② C-4 の採否と AWS 側の認可の仕様 ③ issuer の管理権限の分離と変更の承認 ④ 各アカウントの解除できない守り ⑤ 停止の段階ごとの目標時間と独立した緊急の入口 ⑥ 長寿命の JWT・再利用・キャッシュ・旧セッションの復活の試験 ⑦ 停止の訓練の担当と頻度 | §13.1 |
| 境界の明文化 | discovery と JWKS は公開が要るが、issuer のホストや別の Route から発行の API に到達できてはいけない。発行の側は Access JWT を必ず検証し、Access の経路の設定だけを認証の境界にしない | §2・§3 |
| 識別子とセッション | email の変更・再利用を踏まえた不変の ID、`RoleSessionName` の 64 文字の上限、STS とコンソールの実効の有効期間を確かめる。JWT の 5 分と AWS のセッションの 1 時間は別のリスク | §9、console-login.md §3.4 |

### A.11b Sol のレビュー（G1-b。2026-11-12。決裁ではない）

C-4・I-C の成立は確認され、「次ゲートへは条件付き可。本番の全権ロール接続は保留」という判定だった。要点（X1 のもとでは、署名役と I-C に関わるものは退避先の根拠、Access JWT・STS・停止・監査に関わるものは本文に引き継いだ）:

| 区分 | 指摘の要点 | 引き継ぎ先 |
|---|---|---|
| A. 複数 AUD | 対策の方向は妥当だが、実証できたのは両方に入れる利用者の混在 AUD だけで、Admin 非許可者からの昇格は未確認。Admin は別ホストにし、署名側で aud が Admin の単一値だけであることを検証する。Cookie Path はブラウザの送信範囲で、認可境界の代用にはならない。Access JWT の鮮度（`exp` だけでなく `iat`・`nbf`・最大経過時間）も制限し、旧 Cookie と設定変更後に残る JWT も試す | §3.1、§12.1 |
| B. STS の `exp` | `exp = iat + 300` は正常コードの制約で、鍵の制約ではない。署名側が侵害されると長寿命の JWT を作れる。JWT の寿命と AWS のセッションの寿命は別で、`jti` は STS で一回限りを保証しない | §5.1 (2)、§6.2、§9 |
| C. 呼び出し秘密 | 提示の二択なら呼び出し秘密ありを推奨。同時実行数 5 は費用の上限ではない | A.2 の 6 |
| D. issuer の公開 | CloudFront + OAC を推奨。ただし JWKS の書き換え防止は OAC だけでは達成しない。「横取り不能」と扱わない | A.3 |
| E. 実行ロールの Deny | `kms:Sign` + `NotResource` の Deny は採用。ただし本来の Admin の鍵で任意の JWT を署名する攻撃は防がない | A.2 の 7 |
| F. 見落とし | 管理アカウントは SCP が効かない（専用のメンバーアカウントを推奨）。信頼の根は鍵だけではない（Lambda 更新・依存物・環境変数・実行ロール・KMS ポリシー・JWKS 書き込み・CloudFront の配信元変更・対象ロールの信頼変更）。AWS 側の信頼ポリシーも限定する。人間判定・MFA・本人識別が未確定。監査は件数の一致だけでは claim の正当性を証明しない | A.2、§8 |
| G. 次ゲートの必須条件 | 認証試験（非許可の別ユーザー・旧 Cookie・混在 AUD・長寿命の JWT・サービストークン・失効後）、JWT の検証仕様、権限境界、セッション仕様、鍵運用、監査・運用、隔離環境での実際のコンソールログイン | §3.1、§12.1 |

## 参考

- Cloudflare: Secrets Store（Workers のバインド・役割・監査ログ。N6 の記録が引いた文書）: https://developers.cloudflare.com/secrets-store/integrations/workers/ 、https://developers.cloudflare.com/secrets-store/access-control/
- AWS KMS: 概要（KMS の鍵は HSM で守られ、暗号化されない形でサービスの外に出ない）: https://docs.aws.amazon.com/kms/latest/developerguide/overview.html
- AWS KMS: Sign の API（`Message` は 4096 バイトまで、`MessageType`、`SigningAlgorithm`、エイリアスでも呼べる、結果整合）: https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
- AWS KMS: 鍵の仕様（RSA の鍵で使える署名のアルゴリズム）: https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html
- AWS KMS: 条件キー（`kms:MessageType`・`kms:SigningAlgorithm`・`kms:KeySpec`・`kms:KeyUsage`）: https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html
- AWS KMS: FAQ（非対称の鍵は自動のローテーションに対応しない）: https://aws.amazon.com/kms/faqs/
- AWS KMS: CloudTrail の Sign の記録の例: https://docs.aws.amazon.com/kms/latest/developerguide/ct-sign.html
- AWS KMS: CloudTrail で KMS のイベントを除外する設定: https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html
- AWS KMS: DisableKey（結果整合）: https://docs.aws.amazon.com/kms/latest/APIReference/API_DisableKey.html
- AWS Support: KMS の鍵の無効化が効くまで数分かかりうる（Support の認可の文脈）: https://docs.aws.amazon.com/awssupport/latest/user/support-authorization-kms.html
- AWS Security Blog: KMS の鍵の削除の待ち期間（7〜30 日）: https://aws.amazon.com/blogs/security/identify-unused-aws-kms-keys-and-prevent-accidental-key-deletions/
- AWS KMS: 料金（鍵 1 つで月 1 ドル）: https://aws.amazon.com/kms/pricing/
- AWS re:Post: IAM の OIDC のフェデレーションの署名のアルゴリズム（RS256 など）: https://repost.aws/knowledge-center/iam-oidc-idp-federation
- AWS STS: AssumeRoleWithWebIdentity の `DurationSeconds` とロールの最大のセッションの長さ（1〜12 時間）: https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html
- AWS IAM: カスタムの ID ブローカーでコンソールに入る（`SessionDuration` とロールの最大の長さ）: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html
- IAM Roles Anywhere: 信頼モデル: https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html
- IAM Roles Anywhere: CreateSession: https://docs.aws.amazon.com/rolesanywhere/latest/userguide/authentication-create-session.html
- AWS Security Blog: IAM Roles Anywhere（信頼アンカーの無効化で新しいセッションを止める、CRL）: https://aws.amazon.com/blogs/security/extend-aws-iam-roles-to-workloads-outside-of-aws-with-iam-roles-anywhere/
- Cloudflare: Egress policies（専用の出口 IP は Enterprise）: https://developers.cloudflare.com/cloudflare-one/traffic-controls/egress-policies/
- Cloudflare: Workers の出口を Gateway に通す（VPC Network のバインディング）: https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/
