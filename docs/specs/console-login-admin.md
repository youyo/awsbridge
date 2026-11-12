# コンソールログイン: Admin 側の発行の設計（G1 の資料）

- 作成日: 2026-11-12
- 状態: 設計案。**G1（① の実装の前のゲート）で cto が審議する資料**。ここに書いた推奨は作成者の案で、決裁ではない。N6 の PoC（開発環境、2026-11-12）の結果を §12 に入れ、§3〜§8 に反映した。PoC の道具と手順は `scripts/poc/admin-kms/README.md`
- 対象: Administrator（Admin の階層）のコンソールログインの発行。KMS の署名、Worker が KMS を呼ぶ認証情報の持ち方、別の Worker と発行のオリジン、鍵の差し替え、停止、監査、セッションの長さ、P1・P2、D2（別リポジトリの見直し）
- 関連:
  - [console-login.md](console-login.md): 全体設計。この文書は §3.1（Admin の issuer。方向 I-B の具体化）・§2.2（D3・D4）・§4.8（Admin の階層の守りの部品）・§6（停止）・§7（段階導入と G1〜G5）を前提にする
  - [console-login-portal.md](console-login-portal.md): ポータル。この文書は §8（P1'）・§9.3（検査の 9 段）・§9.10（バンドルの分離）・§10（非機能・監査ログ）・§11（設定）を前提にする
- 表記: console-login.md と同じ。**[確認済み]** 一次資料（出典つき）で確かめたもの、**[資料]** 設計文書と cto の決裁にあるもの、**[推測]** 作成者の推論、**[未検証]** まだ試していないもの・調べて分からなかったもの
- 値の表記: 実ドメインは `<domain>`、issuer のホストは `<issuer-host>`、アカウント ID は `<account-id>`（署名用のアカウントは `<signing-account-id>`）と書く。例のアカウント ID は `111111111111`。実際の値は書かない（awsbridge は public リポジトリ）

## 目次

1. 前提（決裁済みのこと）
2. 構成
3. 発行の流れ
4. KMS の鍵と鍵ポリシー
5. Worker が KMS を呼ぶ認証情報
6. 鍵の差し替え
7. 停止
8. 監査
9. Admin のセッションの長さ（D6）
10. P1・P2（プロバイダーの統合）
11. D2（別リポジトリにするか）
12. N6 の PoC の結果
13. 未決事項と G1 で決めてほしいこと

---

## 1. 前提（決裁済みのこと）

| 項目 | 決まっていること | 出典 |
|---|---|---|
| 分離 | コンソールログイン用は MCP 用と別の Worker・issuer・鍵・Access アプリ・ロール・audience（制約 1）。MCP 用のバンドルにコンソールログイン用の経路が入らないことをテストで確かめる（D2） | [資料: cto の決裁（制約 1・D2）] |
| 鍵の分け方 | 階層（Standard / Admin）× 境界（管理下 / 管理外の先方ごと）。1 つの issuer に 1 つの鍵（D3）。**Admin は Standard と別の Worker デプロイ**（D3。P1' でも保つ） | [資料: D3、2026-11-12 の P1'] |
| Admin の鍵 | **KMS 必須**（D4。N6 の成立が条件）。Standard の Workers secret は会社で Administrator を配る前まで（D4 の言い直し。会社で最初から Standard も KMS にするかは G2） | [資料: D4、2026-11-12 の段階導入の決裁] |
| 入口と発行のオリジン | **P1'**: 入口と一覧は Standard と Admin で共通。Administrator の行は Admin のオリジンの S2 へのリンク（GET）。発行（S2 の POST）は **Admin のオリジンの Admin の Worker だけ**。Standard の Worker は代わりに行わない。**同じホストのパス分けは不可**（発行のオリジンを分ける） | [資料: 2026-11-12 の P1'。portal §8] |
| Admin の issuer | 方向 I-B を具体化: 分けるのは発行のオリジン。issuer のホストは Standard と同じホストの `/admin` でもよい（`/admin` の経路が Admin の Worker に向くことが条件）。形は G1 で審議 | [資料: 2026-11-12。console-login.md §3.1] |
| Standard のバンドル | Admin の情報は表示用だけ（Administrator の行と、Admin のチームの Object ID）。Admin のチームの AUD・Access のポリシー ID・Admin の鍵の参照は入れない | [資料: P1'・U2。portal §9.10] |
| 自前の JWT | `azp` を出さない。`transitive_tag_keys` を設定しない。SourceIdentity 必須（email） | [資料: P1' の条件、3-B、2026-11-12 の SourceIdentity の決裁] |
| Admin の守りの部品 | Standard の部品（ロールチェーンの禁止・awsbridge のロールとプロバイダーへの書き込みの Deny・1 人停止の Deny の置き場所）に、`aws login --remote` の明示の Deny を足したもの。事故防止で、強制の境界ではない（Administrator は外せる） | [資料: console-login.md §4.8・§4.4] |
| セッションの長さ | 階層別。Admin はロールの `MaxSessionDuration` 自体を短くする（D6） | [資料: D6] |
| P1・P2・P3 | P1（同じ Worker）・P2（issuer を 1 つ）は G1 で扱う。採るには人の受容が要る（P1 は D3 の緩和、P2 は D3・D4 の変更）。順位は P1' > P1 > P2。**P3（MCP とコンソールを 1 つ）は却下**（人が受容しても技術承認しない） | [資料: 2026-11-12 の決裁と段階導入の行き先] |
| ゲート | G1 で: Admin 側の発行の設計、N6 の PoC を最初に、P1・P2、D2 の別リポジトリの見直し、Sol のレビュー | [資料: 2026-11-12 の段階導入の決裁。console-login.md §7] |

---

## 2. 構成

```
利用者のブラウザ
  │ ① 共通の入口（Standard のオリジン https://portal.<domain>/）の一覧で Administrator の行を選ぶ（GET のリンク）
  ▼
Cloudflare Access（Admin の階層のチームのアプリ: https://admin-portal.<domain>/t/<team>/）
  ▼
Admin の Worker（Admin のデプロイ。Admin のオリジンだけ）
  │ ② S2（確認）→ ③ POST /t/<team>/login → 検査の 9 段（portal §9.3）
  │ ④ JWT の claim を組む → KMS の Sign ─────────────────┐
  │                                                  ▼
  │                                   署名用の AWS アカウント（<signing-account-id>）
  │                                     KMS の鍵（RSA_2048・SIGN_VERIFY）。鍵ポリシーで Sign を署名役の主体だけに
  │                                     CloudTrail に Sign の記録
  │ ⑤ STS AssumeRoleWithWebIdentity（各アカウント）
  ▼
各アカウント: Admin のプロバイダー（https://<admin-issuer-host>/admin）＋ Administrator のロール（/awsbridge-console/admin/）＋ Admin の守りの部品
  ▼
getSigninToken → 302 でコンソール（aws login は同じ端末だけ）

issuer の公開文書（discovery と JWKS）: Admin の issuer の分は Admin の Worker が出す（§2.1 の案 I-A / I-B）
```

| 部品 | 内容 | 置き場所 |
|---|---|---|
| Admin の Worker | Admin のオリジンの S1〜S5 と発行（POST）、Admin の issuer の discovery と JWKS。Standard の一覧の行・Standard の鍵・Standard のチームの AUD を持たない | 別の Worker デプロイ（別の wrangler 設定）。`workers_dev: false`・`preview_urls: false`（console-login.md §5.4 と同じ）|
| 発行のオリジン | `https://admin-portal.<domain>`（設定の `portal.adminOrigin`）。Standard のオリジン（`portal.standardOrigin`）と別のホスト | Custom Domain |
| issuer | 管理下の境界の Admin の issuer。形は §2.1 | — |
| KMS の鍵 | 階層 × 境界ごとに 1 つ。管理下の Admin の鍵 1 つ（顧客のアカウントは「完了」の外なので、管理外の境界の Admin の鍵は今は作らない） | 署名用の AWS アカウント（§4） |
| Admin のプロバイダー | 基盤のスタックの `AdminProvider`（`AdminPath` が空でないとき。console-login.md §4.2） | Administrator を配る各アカウント |
| Administrator のロール | `/awsbridge-console/admin/` の下。信頼ポリシーの `Principal` は Admin のプロバイダー 1 つだけ（構造の要件。console-login.md §4.8）。`MaxSessionDuration` は短く（§9） | 同じ |
| Admin の守りの部品 | 顧客管理ポリシー（console-login.md §4.8 の Admin の列） | 基盤のスタック |
| Access アプリ | Admin の階層のチームごと（`admin-portal.<domain>/t/<team>/`）。Admin の Worker の設定にだけ AUD を入れる | Cloudflare |

### 2.1 Admin の issuer の形（G1 で審議）

| 案 | issuer | 利点 | 欠点 | 確かめること |
|---|---|---|---|---|
| I-A（同じホストの `/admin`） | `https://<issuer-host>/admin`。`<issuer-host>/admin/*` を Workers Routes で Admin の Worker に向ける | N9 で確かめた URL の形のまま。ホストが 1 つ | Routes の設定を変えられる者は Admin の JWKS を差し替えられる（Standard と Admin を管理権限で隔離できない）[資料: Sol のレビューの指摘 3] | P-9: パスで別の Worker に振り分ける形で、プロバイダーの登録・引き受けができ、Access を迂回する入口を塞げるか [未検証] |
| I-B（階層ごとにホスト） | `https://<issuer-host-admin>/admin`。Custom Domain | Custom Domain だけで済む。ホストの管理権限を分けられる | ホストが 2 つ。同じゾーン・同じ Cloudflare アカウントなら、ゾーンと Workers の管理者からの分離にはならない（U-7 は G5 の前） | Custom Domain で 2 つの Worker に分けたときのプロバイダーの登録（N9 と同じ形のはず [推測]） |

- **I-B でも、同じ Cloudflare の管理権限からは隔てられない**。Admin の issuer の JWKS・DNS・Routes・Custom Domain・Worker のデプロイを変えられる者は、攻撃者の鍵を JWKS に載せて任意の Admin の JWT を作れ、KMS を通らないので Sign の記録も残らない。I-B は誤設定の防止と、権限を分ける余地を作るだけ [資料: Sol のレビュー（2026-11-12）。§13.3]
- 作成者の推奨: **I-B**（別ホスト）[推測]。I-A の欠点（Routes の管理者が Admin の JWKS を差し替えられる）は、Admin の発行を分ける理由そのものに当たる。I-B なら P-9 のうち「パスで別の Worker に振り分ける形でのプロバイダーの登録・引き受け」の確認は要らない。**Admin のオリジン（と Admin の issuer のホスト）で Access を迂回する入口を塞ぐ確認（workers.dev・Preview URL・ほかの Route。引き継いだ条件 (2) と同じ型）は、どちらの案でも残る**。Standard の issuer（`https://<issuer-host>/std`）は変えない
- どちらでも、発行のオリジン（`admin-portal.<domain>`）は issuer のホストと別にする（ポータルのホストに issuer を置かない。console-login.md §3.1 の理由と同じ）

### 2.2 配布とデプロイの順

**IAM は OIDC プロバイダーを作るときに、issuer の `.well-known/openid-configuration` を読み、読めないと作成が失敗する**（`Please check .well-known/openid-configuration of provider ... is valid`）[確認済み: N6 の途中で分かったこと]。そのため、issuer（Worker）を先に公開してから、各アカウントにプロバイダーを作る順番が要る。KMS の鍵を JWKS に載せる Admin では、次の 3 段になる。

| 段 | 操作 | 置き場所 | 確かめること |
|---|---|---|---|
| 1 | KMS の鍵を作る（鍵ポリシー・署名役） | 署名用のアカウント（鍵のスタック） | 鍵が `Enabled`。署名役以外の Sign が拒否される |
| 2 | `GetPublicKey` から JWKS を作り、Admin の Worker（issuer の discovery と JWKS）をデプロイする | Cloudflare | discovery と JWKS が公開されていて、`kid` が鍵と一致する |
| 3 | Admin のプロバイダー（基盤のスタックの `AdminPath`）と Administrator のロールを配る | 各アカウント | プロバイダーの作成が成功する。引き受けが通る |

- **鍵は、プロバイダーと別のスタックにする**案 [推測]。N6 では、プロバイダーの作成の失敗でスタックがロールバックし、同じスタックで作った KMS の鍵が削除の予約（`PendingDeletion`）になった [確認済み: N6]。鍵のスタックとプロバイダーのスタックを分ければ、段 3 の失敗で鍵が消えない
- Standard も同じ順（issuer を先に公開してからプロバイダー）。console-login.md §4.1 の基盤の StackSet を配る前に、その階層の issuer が公開されていることを確かめる手順にする [推測: Standard の Workers secret の鍵では段 1 が鍵ファイルの用意になる]
- 世代つきの新しいパスに移るとき（§6.3）も、新しい issuer を先に公開してから新しいプロバイダーを配る

---

## 3. 発行の流れ

[資料: portal §8・§9.3。KMS の部分は作成者の案]

1. 利用者は共通の入口（Standard のオリジンの S0）で Administrator の行を選ぶ。行はその行のチームのパスの Admin のオリジンの S2 へのリンク（GET）。Standard の Worker は Admin の発行を代わりに行わない
2. Access（Admin の階層のチームのアプリ）を通り、Admin の Worker が S2（確認）を返す。CSRF トークン（`csrf_key` は Admin の Worker だけの secret。Standard と共有しない [推測]）
3. `POST /t/<team>/login`。検査の 9 段（portal §9.3）は Standard と同じ。違いは次の点だけ:
   - 手順 2: AUD → チームの対応は **Admin の階層のチームだけ**（Standard のチームの AUD は未知として 403 `unknown_audience`）
   - 手順 3: `Origin` は `portal.adminOrigin` と完全一致
   - 手順 7: `entry` は **Admin の階層の行だけ**（このデプロイの階層）
4. 手順 9 の署名を KMS で行う:
   1. JWT のヘッダー `{"alg":"RS256","kid":"<今の鍵の kid>","typ":"JWT"}`。`kid` は公開鍵の RFC 7638 の thumbprint（今の `src/keys.ts` と同じ規則 [推測: 同じ関数を使える]）
   2. claim: `iss`（Admin の issuer）、`aud`（`awsbridge-console`）、`sub`（email）、`https://aws.amazon.com/tags`（`principal_tags.awsbridge_team` だけ。`transitive_tag_keys` なし）、`https://aws.amazon.com/source_identity`（email）、`jti`、`iat`、`exp`（約 5 分）。`azp` は出さない
   3. 署名の入力 `base64url(header).base64url(payload)` を KMS の `Sign` に渡す（`SigningAlgorithm: RSASSA_PKCS1_V1_5_SHA_256`、`MessageType: RAW`）。`Message` は 4096 バイトまで [確認済み: KMS の Sign の API 文書]。JWT の署名の入力は 1 KB 程度の見込み [推測: N6 の README の設計の記述。大きさは測っていない]。`RAW` で STS に受理され、鍵ポリシーで `RAW` 以外（`DIGEST`）の Sign を Deny できた [確認済み: N6 の K1・K2]。`RAW` に固定する（§4.2）
   4. 返った署名を base64url にして JWT を組み立てる（ES256 にするなら、KMS が返す DER の署名を `r||s` の 64 バイトに直す。N6 で確認）。発行記録に `jti` と KMS の応答の要求 ID（`RequestId`。CloudTrail の Sign の `requestID` と同じ値 [確認済み: N6 の K4]）を残す（§8）
5. `AssumeRoleWithWebIdentity`（`DurationSeconds` はロールの `sessionSeconds`）→ `getSigninToken`（`SessionDuration`）→ 発行記録 → 302
6. 失敗の扱い（案）: KMS が使えない（`DisabledException`・`KMSInvalidStateException`・`AccessDenied`・タイムアウト）ときは発行しない（fail-closed）。利用者への応答は 503 で、`code` の名前（例 `signing_unavailable`）は portal §9.4 の表に足す案 [推測: G1 で決める]。内部の詳細は画面に出さない

- アルゴリズム: N6 で **RS256（`RSA_2048` / `RSASSA_PKCS1_V1_5_SHA_256`）と ES256（`ECC_NIST_P256` / `ECDSA_SHA_256`）の両方**で、KMS で署名した JWT による `AssumeRoleWithWebIdentity` と `getSigninToken` が通った。RS256 と ES256 の鍵を混在させた JWKS でも両方通った。所要時間の差は見えなかった [確認済み: N6 の K1・K3]。作成者の案は **RS256**（今の MCP 用と Standard の鍵・`src/keys.ts` と同じ形で、DER の変換が要らない）[推測]。ES256 を選ぶ理由は今は見当たらない

---

## 4. KMS の鍵と鍵ポリシー

### 4.1 鍵

| 項目 | 案 | 根拠 |
|---|---|---|
| 鍵の種類 | 非対称・`KeyUsage: SIGN_VERIFY`・`KeySpec: RSA_2048` | 今の鍵（RSA 2048・RS256）と同じ形。秘密鍵は KMS の外に暗号化されない形で出ない [確認済み: KMS の概要の文書（KMS の鍵は HSM で守られ、暗号化されない形でサービスの外に出ない）] |
| 署名のアルゴリズム | `RSASSA_PKCS1_V1_5_SHA_256`（RS256）。ES256 も N6 で成立した | §3 |
| 置き場所 | **専用の署名用 AWS アカウント**（コンソールログイン用のロールを置かない、人の入口を最小にしたアカウント）。管理アカウントには置かない | 前の設計上申 §5.4 の案。Sign の記録が Cloudflare の外に残り、`DisableKey` が Cloudflare に依存しない停止の経路になる [資料] |
| ② での置き場所 | 個人の Organization のメンバーアカウント（管理アカウントには置かない）。Administrator を配るアカウントと同じでもよいか、分けるかは G1 で決める [推測] | console-login.md §7.5 |
| リージョン | 1 つのリージョン。KMS の鍵はリージョンの資源なので、そのリージョンの KMS が止まると Admin の発行が止まる（代わりは B1・B2）。マルチリージョンの鍵は使わない案 [推測: 使うと鍵の複製の管理が増える] | portal §10.2 |
| 鍵の数 | 階層 × 境界ごと。今は管理下の Admin の 1 つ（差し替えの間だけ 2 つ。§6） | D3 |
| 自動のローテーション | **使えない**（非対称の KMS の鍵は自動のローテーションに対応しない）。差し替えは新しい鍵を作って切り替える（§6）[確認済み: KMS の FAQ と GetKeyRotationStatus の文書] | — |
| 費用 | 鍵 1 つで月 1 ドル（時間で按分）[確認済み: KMS の料金のページ]。RSA の Sign の要求の単価は料金のページで確かめられなかった [未確認]。Admin のログインの回数は少ない見込みで、要求の費用は小さい [推測] | — |
| 呼び出しの上限 | RSA の暗号操作の要求の上限（クォータ）は確かめていない [未確認]。Admin のログインの頻度では問題にならない見込み [推測] | — |

### 4.2 鍵ポリシー（案）

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
| 管理 | N6 はアカウントの root の文（アカウントに管理を委ねる既定の形）を残した。`DisableKey` などの管理の権限は、署名用のアカウントの IAM で鍵の管理役に絞る。**Worker の認証情報からは届かない**主体にする。入口が Entra に依存しなければ停止の経路になる（§7。E0 との関係） |
| JWKS | 公開鍵は `GetPublicKey`（DER の SubjectPublicKeyInfo）で取り、**デプロイの時に** JWK に直して Admin の Worker に静的に入れる。Worker に `GetPublicKey` の権限を与えない。JWKS は KMS の可用性に依存しない [確認済み: N6 の形] |
| 送信元の条件 | `aws:SourceIp` で Cloudflare の出口に絞る案は、出口のアドレスが Cloudflare の利用者全体で共有され、N6 では Sign と STS の送信元も毎回違ったので、効果は弱い [確認済み: N6 の K4（送信元の不一致）。絞った場合の動作は未測定]。Cloudflare Gateway の専用の出口 IP（Enterprise のプラン）を Workers の出口に使える形が文書にあるが、KMS の呼び出しで使えるかは確かめていない [未検証] |

---

## 5. Worker が KMS を呼ぶ認証情報

Cloudflare Workers には、AWS に直接使えるワークロードの ID（Workers の実行環境が発行する、AWS の IAM が信頼できるトークン）は、Cloudflare の文書を探した範囲では見つからなかった [未確認。N6 の調査でも同じ]。そのため、Admin の Worker は **何らかの秘密を持つ**。C-4 を除くどの案でも、その秘密が漏れれば `kms:Sign` を呼べ、**任意の Admin のトークン**（任意の email・チームのタグで、Admin のプロバイダーを信頼する全アカウントの Administrator）を作れる（鍵ポリシーで中身は縛れない。§4.2）。KMS が防ぐのは「鍵そのものの持ち出し」で、「署名を頼まれること」は防がない [資料: Sol のレビューの指摘 3、console-login.md §5.1 の A2]。

N6 の比較表（6 候補）と突き合わせた候補。名前は C-1〜C-5 とし、N6 の結果の番号（K1〜K5。§12）と区別する。N6 での名前を括弧に書いた。どれを採るかは G1 で決める:

| 案 | 内容 | Worker に置く秘密 | 漏れたときの被害 | N6 |
|---|---|---|---|---|
| **C-1 IAM ユーザーのアクセスキー**（N6 の A） | 署名用のアカウントに `kms:Sign` だけを許す IAM ユーザーを作り、そのアクセスキーで SigV4 の署名をして KMS を呼ぶ | アクセスキー ID とシークレット（Workers secret） | 無効化するまで、任意の Admin のトークン | **実装・実測**（N6 の K1〜K5） |
| C-1' C-1 のキーを Cloudflare の Secrets Store に置く（N6 の A'） | C-1 と同じ。置き場所だけアカウント単位の Secrets Store にする | 同じ（Secrets Store） | C-1 と同じ | 文書だけ。値の作成とバインドを役割で分けられ、監査ログがある（N6 の記録が引く Cloudflare の文書）。長期の秘密であることは同じ |
| **C-2 WebIdentity のブートストラップ**（D4 の (b) の元の案） | Admin の Worker が、**Admin 専用の小さな鍵（ブートストラップの鍵）**で短命の JWT を作り、署名用のアカウントの**ブートストラップ専用の OIDC プロバイダー**に対して `AssumeRoleWithWebIdentity` で署名役のロールを引き受ける。得た一時認証情報（1 時間など）で KMS を呼ぶ。一時認証情報は isolate の中に有効期限の手前までキャッシュする | ブートストラップの鍵（Workers secret） | 止めるまで、任意の Admin のトークン | 未実装 |
| C-2' ブートストラップに Standard の鍵を使う（N6 の C） | C-2 のブートストラップの JWT を Standard の鍵で作る | Standard の鍵 | **Standard の鍵が漏れると Admin のトークンも作れる** | 未実装。D3・D4 の意図（Admin は Standard の鍵の漏れから分ける）に反するので**採らない**（作成者の扱い） |
| **C-3 IAM Roles Anywhere**（N6 の B） | 署名用のアカウントに信頼アンカー（自前の CA か AWS Private CA）を置き、X.509 の証明書と秘密鍵で `CreateSession` を呼んで署名役のロールの一時認証情報を得る [確認済み: IAM Roles Anywhere の信頼モデルと CreateSession の文書] | 証明書と秘密鍵（Workers secret） | 証明書の期限か失効まで、任意の Admin のトークン | 未実装 |
| **C-4 AWS 側の署名役が Access JWT を検証してから署名**（N6 の D） | Worker は利用者の Cloudflare Access JWT（Admin の階層のチームのアプリの AUD）を AWS 側の署名役（例: Lambda）に渡す。署名役が Access の JWKS で検証し、claim を自分で組み立て、自分の実行ロールで Sign する | 署名役の入口を呼ぶための認証情報 | **Worker 側の認証情報だけでは任意の中身に署名できない**（有効な Access JWT が要る）。Access JWT も盗まれると、その利用者として発行できる | 未実装（文書だけ） |
| C-5 Cloudflare の Worker の身元を AWS に連携する（N6 の E） | Cloudflare が Worker に OIDC トークンを発行し、AWS が信頼する形 | なし | — | 文書を探した範囲では見つからなかった（無いとは言えない） |

### 5.1 比較

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

### 5.2 推奨

- 作成者の推奨: **C-2**（WebIdentity のブートストラップ）。理由: D4 の元の案で、長期の AWS の認証情報を Worker に置かない。止め方と差し替えは JWKS に `kid` を並べる型で、N6 の K5 で新旧 2 つの `kid` の切り替えが動いた。Sign の往復は中央値 11 ms で、C-2 で足される一時認証情報の取得もキャッシュすればログインの所要時間に大きく効かない見込み [推測: N6 の K3 からの見込み。C-2 自体は測っていない]
- 条件（案）: ブートストラップの鍵と issuer は Admin 専用（Standard・MCP・Admin の発行用と共有しない。C-2' は採らない）。ブートストラップのプロバイダーは署名用のアカウントにだけ登録する。署名役のロールの信頼ポリシーはそのプロバイダーの `aud` と `sub`（固定値）で絞る。署名役の権限は `kms:Sign` だけで、鍵ポリシーの Deny でも絞る（§4.2）。ブートストラップの issuer の公開文書は Admin の Worker が出す（§2.2 の順で、プロバイダーより先に公開する）
- 退避先: **C-1**。N6 で最小権限の形（IAM は `kms:Sign` だけ、鍵ポリシーで署名役以外・`RAW` 以外・方式違いを Deny）で動いた [確認済み: N6 の K2]。長期の AWS の認証情報になるので、会社で使うときは人の判断（セキュリティ例外に当たるか）が要る [推測]
- **C-4 は、被害の大きさを変えられる唯一の候補**（Worker の認証情報だけでは任意の中身に署名できない）。部品と往復が増え、検査の 9 段の一部が AWS 側に移る。「Sign を呼べる＝任意の Admin のトークン」（§4.2）を受け入れられないなら、G1 で C-4 を検討してほしい [推測]
- C-3 は、会社に既存の PKI と運用があるなら候補になる。今は手間に見合わない [推測]

**どの案でも残ること**: Worker か秘密が奪われると（C-4 では Access JWT も）、止めるまで Admin のトークンを作られる。**Admin の issuer の JWKS を差し替えられると、どの案でも KMS と署名役は迂回され、KMS の Sign の記録も残らない**（§2.1。issuer の DNS・TLS・Worker・Routes・Custom Domain・デプロイの権限は、Administrator を配る全アカウントの Admin の権限と同じ重さで扱う）。KMS で得るのは、(1) 鍵そのものは持ち出されない、(2) 署名の全件が Cloudflare の外（署名用のアカウントの CloudTrail）に残る（N6 の K4）、(3) Cloudflare と各アカウントに触らずに `DisableKey` で新しい署名を止められる（N6 では完了から +1.1〜2.1 秒で止まり始め、最後の成功は +5.3 秒。2 回の観察。§7）、の 3 つ。止める前に作られたトークンの扱いは §6.2・§7。

---

## 6. 鍵の差し替え

3 つの場面に分ける。console-login.md §2.2 の「1 つの issuer に 1 つの鍵」は**平常時の署名に使う鍵が 1 つ**という意味で、差し替えの間だけ JWKS に `kid` が 2 つ並ぶ（MCP 用と同じ）[推測: 決裁の文言の読み。G1 で確認]。

### 6.1 計画的な差し替え（KMS の鍵を新しくする）

architecture.md「鍵のローテーション」の手順と同じ型（JWKS に先に載せ、STS が取り込んでから署名を切り替える）[資料]。

| 段 | 操作 | JWKS | 署名する鍵 | 次に進む前に |
|---|---|---|---|---|
| 0 | 通常 | 今の鍵 | 今の鍵 | — |
| 1 | 新しい KMS の鍵を作る（同じ鍵ポリシー）。`GetPublicKey` から JWK を作り、Admin の Worker の JWKS に足してデプロイ | 今 + 新 | 今の鍵 | STS の JWKS のキャッシュが切れるまで。MCP 用の手順は最低 1 時間・安全側に 24 時間（キャッシュの長さは公開されていない [資料: architecture.md]）。N6 では、JWKS に足した新しい `kid` の署名が **1 回目から**受理された [確認済み: N6 の K5。1 回の観察] ので、待ち時間を短くできる見込みがある。キャッシュの有無と長さは確かめていない（N5） |
| 2 | Worker の設定の「署名に使う鍵」（鍵の ARN と `kid` の組）を新しい鍵に替えてデプロイ | 新 + 今 | 新しい鍵 | 自前の JWT の有効期限（約 5 分）以上 |
| 3 | 古い `kid` を JWKS から外してデプロイ（N6 では外した直後から古い `kid` の JWT が `InvalidIdentityToken` になった。1 回の観察）。古い鍵を `DisableKey`。しばらく様子を見て `ScheduleKeyDeletion`（待ち期間は 7〜30 日 [確認済み: AWS Security Blog の KMS の鍵の削除の記事]） | 新 | 新しい鍵 | — |

- 署名に使う鍵は、エイリアスではなく**鍵の ARN と `kid` の組**で設定に持つ案 [推測]。エイリアス（`Sign` はエイリアスでも呼べる [確認済み: Sign の API 文書]）を付け替えると、JWT のヘッダーの `kid` と実際の鍵がずれる時間ができるため
- 平常時の差し替えの周期は G1 で決める（自動のローテーションはない。§4.1）

### 6.2 Worker の認証情報の漏えい（KMS の鍵は持ち出されていない）

- 替えるのは認証情報（C-2 ならブートストラップの鍵、C-1 ならアクセスキー）。各アカウントのプロバイダーと信頼ポリシーには触らない
- ただし、**漏れていた間に作られた Admin の JWT** は KMS の鍵で正しく署名されているので、その `kid` が JWKS にある間は STS に受理されうる。攻撃者は `exp` を自由に決められる。STS が `exp` の遠いトークンを受け付けるか（トークンの寿命の上限）は N6 で測っていない [未検証: N6-7]。`DisableKey` は新しい署名を止めるだけで、作られた JWT は止めない [確認済み: N6 の K4]
- そのため、認証情報の漏えいでも、**その間の Sign を CloudTrail と発行記録で突き合わせて説明できないものがあれば、KMS の鍵も差し替える**（§6.1 を急ぎで行い、古い `kid` を JWKS から外す）。N6 では、JWKS から外した `kid` の JWT は外した直後に拒否された（1 回の観察）[確認済み: N6 の K5]。STS がキャッシュを持たない保証はない（N5）ので、確実に止めるには L2（Admin のプロバイダーの削除）と L3（Administrator のロールの revoke）を合わせる [推測]
- 突き合わせで説明できない Sign がなければ、KMS の鍵は替えなくてよい [推測: G1 で判断を求める]

### 6.3 世代つきの新しいパス（鍵が漏れた・JWKS を信用できない）

- console-login.md §3.1 の規則: 平常時の URL に世代を入れず、必要なときに世代を付けた新しいパス（例 `/admin-2`）に移る（`^[a-z0-9-]+$`）
- 手順の案（Standard も同じ）: (1) 新しい鍵と新しい issuer（世代つきのパス）を用意 (2) 基盤のスタックの `AdminPath` を新しいパスにした版で、新しいプロバイダーを配る（古いものと並べる。プロバイダーは issuer の URL ごとに 1 つ）(3) Administrator のロールの信頼ポリシーの `Principal` と条件キー（`<host>/<path>:aud`）を新しいプロバイダーに切り替える (4) 古いプロバイダーを削除する (5) 古いプロバイダーで作られたセッションを revoke（L3。解除は console-login.md §6.3 の条件）[推測: 前の版で「段階 2 の前に書く」とされていた手順の案。N5 と一緒に G2 で確かめる]
- KMS の場合、鍵そのものは漏れないので、世代つきのパスに移るのは「Admin の issuer の JWKS（Cloudflare の側）を信用できない」とき（A13〜A15 の侵害）と、§6.2 で N5 の結果が悪いとき [推測]

---

## 7. 停止

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
| 残った権限（Administrator が作ったアクセスキー・ロール・プロバイダー・信頼の変更など） | 棚卸しと個別の削除。Admin の守りの部品は Administrator が外せる（console-login.md §4.8） | 未設計 | revoke では止まらない。Admin が解除できない守り（SCP など）をどこまで置くかは §13.3 で G1 に審議を求める |

手順の案（Admin の鍵か Worker の侵害）:

1. **新しい署名を止める**: H-0（`DisableKey`）。Cloudflare の操作に頼らない。Entra に依存しない入口で署名用のアカウントに入れるなら、H-0 は Entra を通らない停止の経路の一部になる（E0 の受容は G5 の前まで。console-login.md §6.6）[推測]
2. **作られた JWT を使わせない**: KMS の鍵の `kid` を JWKS から外す（H-3。N6 では直後に拒否）。確実にするには、Administrator を配った各アカウントの Admin のプロバイダーを削除（L2）
3. **発行済みを止める**: 新規が止まったことを確かめてから L3（console-login.md §6.2 の順）
4. **調べる**: §8 の突き合わせ
5. **戻す**: 原因を取り除く → 認証情報の差し替え（と必要なら KMS の鍵の差し替え。§6）→ `EnableKey` かプロバイダーを作り直す → console-login.md §6.3 の解除の条件で revoke を外す

- 退職・端末の紛失など 1 人の停止は Standard と同じ（L1 と L3-1。過去の email も Deny。console-login.md §6.2）
- 鍵の削除（`ScheduleKeyDeletion`）は停止の手段にしない。待ち期間（7〜30 日）があり、削除されると取り消せない。原因の調べが済むまで `DisableKey` のままにする [推測]。削除の予約中（`PendingDeletion`）の Sign の挙動と、鍵ポリシーの変更（H-2）で止まるまでの時間は N6 で測っていない

---

## 8. 監査

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

## 9. Admin のセッションの長さ（D6）

| 項目 | 事実・案 |
|---|---|
| ロールの `MaxSessionDuration` | 1 時間〜12 時間 [確認済み: STS の `AssumeRoleWithWebIdentity` の文書]。**1 時間より短くは AWS 側で強制できない** |
| `DurationSeconds`（引き受け） | 900 秒〜ロールの `MaxSessionDuration` [確認済み: 同じ文書] |
| コンソールの `SessionDuration` | 900〜43200 秒。文書は「ロールの最大のセッションの長さ以上にはできない」と書く [確認済み: IAM のカスタムの ID ブローカーの文書]。PoC では `MaxSessionDuration` と同じ 43200 が受理された [資料: cto の決裁の記録（前提の訂正）。文書の記述との食い違いは未解決] |
| `aws login` | 15 分ごとに更新し、ロールのセッションの長さまで使える [資料: portal §6.5] |
| 案 | Administrator のロールの `MaxSessionDuration` を **1 時間**（AWS が強制できる最短）。Worker の `sessionSeconds` も 1 時間。設定例の「1〜2 時間」（portal §11.8）のうち短い方 [推測] |
| 1 時間より短くしたいとき | Worker が `DurationSeconds`・`SessionDuration` に 900 秒などを渡す形になる。**これは Worker の振る舞いで、AWS の強制ではない**（侵害された Worker や作られた JWT はロールの上限まで取れる）。console-login.md §4.3 の `sessionSeconds` の範囲（900〜43200）は Worker に渡す値の範囲で、ロールの `MaxSessionDuration` の下限（3600）とは別。生成の検査で、Admin の階層のロールの `MaxSessionDuration` に 3600 未満を渡さない（CloudFormation で失敗する）ようにする [推測] |
| Access のセッション（Admin の階層のチームのアプリ） | Standard より短く（例 5〜15 分）。PIM と合わせて決める（PIM は G3・G5）[資料: console-login.md §6.4] |

---

## 10. P1・P2（プロバイダーの統合）

[資料: cto の決裁 2026-11-12「プロバイダーの統合と Admin の分離」、Sol のレビュー（決裁ではない）]

| 案 | 内容 | 失うもの | 得るもの | 採る条件 |
|---|---|---|---|---|
| **P1'（今の設計）** | 入口と一覧は共通。Worker・issuer・鍵・発行のオリジンは分ける | — | 画面は 1 つ。署名の権限と発行のオリジンが分かれ、Standard の画面の欠陥や Standard の Worker・鍵の侵害が Admin に届かない | — |
| P1（Standard と Admin を同じ Worker） | 1 つの Worker が Standard の鍵と Admin の KMS の両方で署名する | D3 の「Admin は別の Worker デプロイ」。その Worker は共通の認証局になる。KMS は鍵の持ち出しを防ぐが、Sign できる Worker を取られれば Admin の JWT を作れる。実行環境・依存・デプロイの事故の分離、Admin だけ厳しく変更管理する境界、オリジンの分離（Cookie の Path は境界にならない）を失う [資料: Sol のレビュー] | Worker のデプロイが 1 つ減る | 人の受容（「共通の Worker の侵害で Admin まで届くこと」）。D3 の緩和として再上申 |
| P2（Standard と Admin の issuer を 1 つ） | コンソール側のプロバイダー・Worker・鍵が 1 つずつ | D3・D4。IAM はその issuer の JWKS のどの鍵の署名も受け入れ、ロールの側で鍵を縛れない [資料]。Admin の鍵だけを KMS にする意味と、Admin だけを L2 で止める手段を失う | 各アカウントのコンソール用のプロバイダーが 1 つになる | 人の受容。D3・D4 の変更として再上申 |

- 作成者の推奨: **P1' のまま**。理由は決裁の理由と同じ（表示は認可ではない。発行のオリジンと署名の権限が同じだと、Standard の欠陥が Admin の発行に届く）。P1・P2 は、利用者が「プロバイダーを 1 つにしたい」「Worker を 1 つにしたい」と望むとき（U-18 の回答）にだけ再審議する
- **人の受容の記録はない**（console-login.md §9.2 の U-18 は人の確認待ち）。G1 で P1・P2 を採ることはできない [資料: 決裁の条件]
- P3（MCP とコンソールのプロバイダーを 1 つ）は却下済み。開き直さない

---

## 11. D2（別リポジトリにするか）

前の決裁: D2 は「awsbridge 内の別エントリ。MCP 用のバンドルに人間用の経路が入らないことをテストで確かめる。段階 3 の前に別リポジトリを見直す」。段階導入の書き直しで「D2 の別リポジトリの見直し」は G1 で扱う [資料]。

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| R-a 今のまま（同じリポジトリの別エントリ） | MCP 用・Standard・Admin を同じリポジトリの別エントリ（別の wrangler 設定・別のデプロイ）にする | 署名・STS の呼び出し・JWKS などの安全の要（`src/oidc.ts`・`src/keys.ts`・`src/sts.ts`）を共有でき、複製の差が出ない。バンドルの分離のテストが既にある（`test/e2e/console-bundle.test.ts`・`test/unit/console-layout.test.ts`）| 変更の管理（誰がマージできるか）とデプロイの権限の境界を、リポジトリより細かい単位（パスの CODEOWNERS・別のデプロイのジョブ）で作る必要がある。awsbridge の位置づけ（AI エージェント向け）と範囲がずれる |
| R-b コンソールログイン（Standard と Admin）を別リポジトリ | MCP 用とコンソールログイン用を分ける | MCP 用と変更管理・CI・Cloudflare のアカウントを分けやすい | 署名の部品を複製するか、共有のパッケージにする手間。Standard と Admin は同じリポジトリのまま |
| R-c Admin だけ別リポジトリ | Admin の Worker と Admin の設定を別にする | Admin だけ厳しい変更管理（承認の人数・保護ブランチ）とデプロイの権限にできる | ポータル（共通の入口・検査の 9 段・設定の生成）の大半が Standard と同じコードで、分けると複製か共有パッケージが要る。表示用の一覧の生成（U2）は両方にまたがる |

- 作成者の推奨: **① は R-a**（同じリポジトリの別エントリ）[推測]。条件（案）: (1) Admin のエントリは別の wrangler 設定と別のデプロイのジョブ・別のデプロイ用トークン（承認つきの environment）(2) バンドルの分離のテストを 3 方向にする（MCP に Standard・Admin がない、Standard に Admin の鍵の参照・Admin の AUD・ポリシー ID がない、Admin に Standard の一覧の行と Standard の鍵がない。portal §9.10）(3) Admin のパスと署名の部品に CODEOWNERS を付ける (4) 公開リポジトリに秘密・実値を置かない（今と同じ）
- 見直しの時機（案）: 会社で Administrator を配る前（G5）に、U-7（Cloudflare アカウントの分離）・G-14（本人以外の承認）と一緒に、R-b・R-c にするかを見直す [推測: 行き先の表に D2 の再見直しの時機は書かれていない]

---

## 12. N6 の PoC の結果

開発環境（開発用の AWS アカウント 1 つ・東京リージョン、Cloudflare の workers.dev の Worker、colo は東京）で、2026-11-12 に行った。道具と手順は `scripts/poc/admin-kms/README.md`。識別子は書かない。回数の少ない測定（各 1〜2 回の観察）はそう書いた。PoC は C-1 の候補（IAM ユーザーのアクセスキー）で動かした。

| # | 結果 | 要点 | 未測定・注意 |
|---|---|---|---|
| K1 | **成立** | RS256（`RSA_2048` / `RSASSA_PKCS1_V1_5_SHA_256`）と ES256（`ECC_NIST_P256` / `ECDSA_SHA_256`）の両方で、KMS で署名した JWT による `AssumeRoleWithWebIdentity` と `getSigninToken` が通った。両方の鍵を混在させた JWKS でも両方通った。20 回すべて成功（各 10 回）。SourceIdentity とセッションタグ付き（既存 PoC と同じ形の信頼ポリシー） | RS384 などほかの方式は試していない |
| K2 | **最小権限の形で動いた**（どれを採るかは決めない。§5） | IAM ユーザーは `kms:Sign` だけ。鍵ポリシーで、`aws:PrincipalArn` が Worker の主体以外・`kms:MessageType` が `RAW` 以外・`kms:SigningAlgorithm` が鍵の方式以外の Sign を Deny。`AdministratorAccess` の管理者の Sign は明示の Deny で拒否。Worker の主体でも `DIGEST` と PSS は拒否。`GetPublicKey` はデプロイの時に管理者が呼ぶだけ | **署名する中身を縛る条件キーは無い**（§4.2）。Worker の主体で別の鍵に Sign できないこと、`aws:SourceIp` で絞る案は未測定 |
| K3 | 所要時間 | Sign の往復は中央値 11 ms（RSA・EC とも。p90 は 36・39 ms）。ログイン全体（Worker の中）は中央値約 210 ms、手元から見た往復は約 290〜300 ms。大半は `getSigninToken`（中央値 163 ms）。RSA と EC の差は見えなかった。初回はログイン全体で約 0.7 秒 | 測ったのは東京の colo と東京リージョンだけ。ログインの中の Sign（中央値 26〜27 ms）が Sign だけを続けた場合より遅い理由は未確認（要求ごとに新しい接続になっている可能性） |
| K4 監査 | **突き合わせられる**（§8） | Sign は CloudTrail に残る（`requestID` = KMS の応答の `RequestId`。中身は残らない）。`AssumeRoleWithWebIdentity` の `webIdentityTokenId` が `jti` と 28/28 一致。送信元の IP は 28 組すべてで Sign と STS が違い、IP では突き合わせられない | AWS 側に Sign と引き受けを結ぶ共通の項目は無い。`AccessDenied` の Sign は `requestParameters` が空。`InvalidIdentityToken` の引き受けはイベント履歴で見当たらなかった。反映の遅れは観察した範囲で約 1 分〜2 分 20 秒の間 |
| K4 停止 | **`DisableKey` の完了から +1.1〜2.1 秒で止まり始め、最後の成功は +5.3 秒。発行済みは止まらない** | 完了から最初の失敗まで +2.1 秒・+1.1 秒。1 回目は成功が 3 回混ざり、最後の成功は +5.3 秒。`EnableKey` から戻るまで 3.2 秒・1.2 秒 | 2 回だけ。止まるのは新しい署名だけで、署名済みの JWT（5 分）・STS のセッション・コンソールは止まらない（それらは前の PoC の P4 の手段）。`PendingDeletion` 中の挙動、鍵ポリシーの変更で止める時間は未測定 |
| K5 | **新旧 2 つの `kid` を並べて切り替えられた** | JWKS に新しい `kid` を足すと、その署名が 1 回目から成功。新しい `kid` だけの JWKS にした直後、古い `kid` の JWT は `InvalidIdentityToken` | 各 1 回の観察。STS の JWKS のキャッシュの有無と時間は確かめていない（Worker は `cache-control: max-age=300` を付けた）。運用は「新を足す → 新で署名 → 旧の JWT の期限が過ぎてから旧を外す」の順（§6.1） |

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

## 13. 未決事項と G1 で決めてほしいこと

### 13.1 G1 で決めてほしいこと

| # | 論点 | 作成者の推奨 | 節 |
|---|---|---|---|
| A-1 | KMS の鍵の形（`RSA_2048`・`RSASSA_PKCS1_V1_5_SHA_256`。ES256 も N6 で成立）と置き場所（専用の署名用アカウント。② では個人の Organization のメンバーアカウント） | RS256。置き場所は推奨どおり | §4.1・§3 |
| A-2 | Worker が KMS を呼ぶ認証情報（C-1・C-1'・C-2・C-3・C-4。C-2' は採らない、C-5 は見つからない） | C-2（WebIdentity のブートストラップ。Admin 専用の鍵と issuer）。退避先は N6 で動いた C-1。「Sign を呼べる＝任意の Admin のトークン」を受け入れられないなら C-4 | §5 |
| A-3 | Admin の issuer の形（I-A 同じホストの `/admin` / I-B 別ホスト）と、P-9 を確かめるか | I-B。I-B ならパスの振り分けの確認は要らない。Access を迂回する入口を塞ぐ確認は残る | §2.1 |
| A-4 | 鍵ポリシーの形（Sign を Deny で署名役・`RAW`・方式に絞る、管理はアカウントに残して IAM で管理役に絞る） | §4.2 の案（N6 で動いた形） | §4.2 |
| A-5 | 鍵の差し替え: 平常時の周期、署名に使う鍵を ARN と `kid` の組で持つこと、Worker の認証情報の漏えいのときに KMS の鍵も替える判断の基準 | §6 の案 | §6 |
| A-6 | 停止: `DisableKey` を基準の停止の手段に入れること、鍵の管理役の入口（Entra に依存しない入口にするか） | 入れる。入口は人の判断 | §7 |
| A-7 | 監査: `jti` と `webIdentityTokenId` を主なキーにし、発行記録に KMS の `RequestId` を足すこと、署名用のアカウントの証跡の条件 | §8 の案 | §8 |
| A-16 | デプロイの順（鍵 → Worker → プロバイダー）と、KMS の鍵をプロバイダーと別のスタックにすること | §2.2 の案 | §2.2 |
| A-8 | Admin のセッションの長さ（`MaxSessionDuration` 1 時間） | 1 時間 | §9 |
| A-9 | P1・P2 | P1' のまま（人の受容の記録がない） | §10 |
| A-10 | D2 | ① は R-a。G5 の前に見直す | §11 |
| A-11 | KMS が使えないときの応答の `code`（例 `signing_unavailable`。portal §9.4 に足す） | 503 で足す | §3 |
| A-12 | Administrator の監査の Deny（CloudTrail・Config・GuardDuty などの停止・削除。console-login.md §4.8 で「Administrator の設計に引き継ぐ」とされたもの）の中身 | 未決（案なし。① で作る前に決める） | — |
| A-13 | console-login.md §7.7 の「決裁の表に行き先が書かれていないもの」（U-2、Viewer の機微データの棚卸し、B2、Admin の Access アプリの分離、世代つきパスの手順、P-9、N4）の行き先 | §7.7 の作成者の扱いを確認してほしい | console-login.md §7.7 |
| A-14 | portal §12.2 の G-1〜G-3・G-5・G-7・G-9（前の版で「段階 1 の前」）を、どのゲートで決めるか | ① の実装の前に要る。G1 で一緒に確認するか | portal §12.2 |
| A-15 | ② の個人の環境のチーム: Admin の階層のチームを別に持つこと（前の決裁は「チームは 1 つ」） | 持つ（Admin のロールに Standard のチームは割り当てられない） | console-login.md §7.5・§9.2 の U-23 |

### 13.2 未決のまま残すもの

- N6 で測っていないもの: C-2 のブートストラップ、`exp` の遠い JWT（N6-7）、STS の JWKS のキャッシュ（N5）、ほかの colo とリージョンの所要時間、`PendingDeletion` 中の Sign、鍵ポリシーの変更で止まる時間、署名役で別の鍵に Sign できないこと、`aws:SourceIp` の効果、失敗した引き受けが CloudTrail に残るか
- 会社で最初から Standard も KMS にするか（G2。この文書の C-2 の形を Standard に流用できるかも G2 で）[資料: D4 の言い直し]
- RSA の Sign の単価とクォータ（§4.1）
- 署名に使う鍵（KMS の鍵の ARN と `kid` の組）と、ブートストラップの設定を、設定ファイル（portal §11.3 のスキーマ）のどこに持つか。鍵の ARN はアカウント ID を含むので、下流の設定に置く値になる（上流の例は伏せた値）
- Cloudflare Gateway の専用の出口 IP で KMS の呼び出しの送信元を絞れるか（§4.2）
- Workers に AWS 向けのワークロードの ID があるか（見つからなかった。§5 の C-5）
- PIM と Admin の階層の Access のセッションの長さ（G3・G5）

### 13.3 Sol のレビュー（2026-11-12）の指摘、G1 で審議

外部レビュー（決裁ではない）の要点。中身の判断は G1 で求める。この文書の推奨は書き換えていない。

| 区分 | 指摘の要点 | 関わる節 |
|---|---|---|
| 認証方式 | C-2 の優位性は過大。長期の AWS アクセスキーはなくなるが、署名役の資格情報を何度でも得られる長期の秘密（ブートストラップの鍵）が残る。C-1 より安全とは今は判断できない | §5.2 |
| 認証方式 | 推奨は**条件付きの C-4**: AWS 側が Access JWT の署名・issuer・Admin 専用の aud・有効期限・利用者の種別を検証し、利用者 → チーム → 対象アカウントとロールを独立に認可して claim を作る。Worker が渡す email・タグ・対象ロールを信用すると効果がない。C-1 は残るリスクを明示した限定の PoC 用、C-2 は運用上の利点を実証してから再評価 | §5 |
| 信頼の境界 | JWKS の差し替えで KMS と C-4 を丸ごと迂回できる（Sign の記録も残らない）。issuer の DNS・TLS・Worker・Routes・Custom Domain・デプロイの権限は、全対象アカウントの Admin の権限として管理する。I-B は同じ管理権限からの隔離ではない | §2.1・§5.1 |
| 信頼の境界 | 5 分の `exp` は署名役の侵害時の上限ではない（任意の `exp`・`iat`・`jti` を付けられる。`DisableKey` 後も使われうる）。**長寿命の JWT の試験は承認の前に必須** | §6.2・§12（N6-7） |
| 信頼の境界 | Administrator による永続化と停止の回避が未整理（ロールの信頼・権限、プロバイダー、別の管理者、アクセスキーの作成で revoke 後も権限が残る）。監査の停止の Deny だけでは足りない。**Admin が解除できない守り（SCP など）**で、信頼の基盤・停止の仕組み・ログ・永続の資格情報の作成をどこまで守るか | §7、console-login.md §4.8・§6.5 |
| 信頼の境界 | プロバイダーが 1 つというだけではチームの境界にならない。各ロールで aud とチーム・利用者・対象アカウントの対応を強制する条件が要る。ただし署名者が自由に付けるタグ・email・SourceIdentity は、署名者の侵害への防壁にも独立した本人の証明にもならない | console-login.md §4.3・§4.8 |
| 停止 | 停止の時間を 1 つの数値にしない（新しい署名・作られた JWT からの新しい STS・既存のセッション・作られた永続の権限）。JWKS からの除去は即時の失効として保証せず、AWS 側の信頼の拒否・権限の Deny と組み合わせる | §7 |
| 停止 | revoke の対象（署名役の資格情報・各 Administrator のロール・そこから引き受けたセッション）と復旧の条件を分ける。email・SourceIdentity が偽造される侵害では 1 人の Deny は足りない。新しい引き受けの阻止と既存の権限の遮断はできるだけ並行で行い、revoke を外したときの旧セッションの復活も確かめる | §7 |
| 差し替え | 通常のローテーションと侵害時の交換を分ける。通常は JWT の有効期間・時刻のずれ・STS のキャッシュを踏まえた重複期間、侵害時は旧鍵の受理の終了を優先。認証情報だけの漏えいでも長寿命の JWT を作られうるので、秘密鍵が漏れていなくても KMS の鍵の交換が要る条件を定義する | §6 |
| 監査 | 突き合わせは検知の材料で、完全性の証明ではない（偽の発行記録、同じ `jti` の再利用、Sign 後の失敗）。再試行・重複・遅延をモデル化する。C-4 なら AWS 側で claim や署名対象のハッシュ・認可の結果・RequestId を独立に記録する価値がある | §8 |
| G1 の承認条件 | 追加の決定事項: ① 許容する侵害主体と最大の影響範囲 ② C-4 の採否と AWS 側の認可の仕様 ③ issuer の管理権限の分離と変更の承認 ④ 各アカウントの解除できない守り ⑤ 停止の段階ごとの目標時間と独立した緊急の入口 ⑥ 長寿命の JWT・再利用・キャッシュ・旧セッションの復活の試験 ⑦ 停止の訓練の担当と頻度 | §13.1 |
| 境界の明文化 | discovery と JWKS は公開が要るが、issuer のホストや別の Route から発行の API に到達できてはいけない。発行の側は Access JWT を必ず検証し、Access の経路の設定だけを認証の境界にしない | §2・§3 |
| 識別子とセッション | email の変更・再利用を踏まえた不変の ID、`RoleSessionName` の 64 文字の上限、STS とコンソールの実効の有効期間を確かめる。JWT の 5 分と AWS のセッションの 1 時間は別のリスク | §9、console-login.md §3.4 |

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
