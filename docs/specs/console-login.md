# コンソールログイン: 全体設計（段階 1 のゲート用）

- 作成日: 2026-11-11
- 改訂: 2026-11-11 段階 1 のゲートの cto の決裁（条件付き承認）と、Sol のレビューのうち採った指摘を反映した。名前を「human」から「console」に改めた（audience・ロールのパス・RoleSessionName・StackSet と SCP の名前・ファイル・タスク・環境変数）。PoC（`scripts/poc/human/`）の名前と記録は変えていない
- 改訂: 2026-11 設定例のロール名を `Federated*`（`FederatedViewer` / `FederatedDeveloper` / `FederatedAdministrator`）に、MCP 用ロールの既定名を `FederatedMcpViewer` / `FederatedMcpDebugger` に改めた。MCP 用ロールとの関係（§2.3 の決裁 S2）を書き足した
- 状態: 設計案。段階 1 のゲートは、Sol のレビューのあと cto が**条件付きで承認**した。段階 1 を 1a（会社環境で運用者だけ・1 アカウント）と 1b（試行者・5 アカウント以下）に分け、1a は §7.2 の条件を満たし人の承認が出れば始めてよい。実装済みは設定のスキーマ・検証・生成だけ（`src/console/`）。そのほかの内容はまだ実装していない
- 対象: awsbridge 方式（自前の OIDC issuer → 各アカウントの IAM OIDC プロバイダー → `AssumeRoleWithWebIdentity`）による、人が使う AWS コンソールと `aws login` へのログイン（この仕組みを「コンソールログイン」と呼ぶ）
- 関連:
  - [console-login-portal.md](console-login-portal.md): ポータル（画面・エンドポイント・CSRF・設定ファイル）の詳細設計。この文書は、ポータルの外側（issuer・鍵・テンプレート・脅威モデル・停止・段階）を受け持つ
  - [architecture.md](architecture.md): MCP 用の構成。コンソールログイン用はこれと分ける（§2.3）
  - [scripts/poc/human/README.md](../../scripts/poc/human/README.md)（PoC-A/B・P2〜P4）と [scripts/poc/human/portal/README.md](../../scripts/poc/human/portal/README.md)（N9・M2・N10）: PoC の手順と結果（PoC の名前は改名前の `human` のまま）
- 「cto の決裁」は、このリポジトリの外にある技術決裁を指す。この文書に効く条件は §1 にまとめた。「Sol のレビュー」は段階 1 のゲートで取った外部レビュー（決裁ではない）を指し、採った指摘だけをこの文書に入れた
- 表記: **[確認済み]** PoC で観測したもの・一次資料で確かめたもの、**[資料]** 設計文書と cto の決裁にあるもの、**[推測]** 作成者の推論、**[未検証]** まだ試していないもの・調べて分からなかったもの
- 実測値の但し書き: PoC の秒数は、開発環境（IdP は Google、AWS は開発用アカウント 1 つ、利用者 1 人）で**1 回ずつ測った値**である。会社の環境（Entra ID）と複数アカウントでの値は測っていない。**保証値として使わない**（手順は固定の待ち時間ではなく「拒否を確かめて完了」にする。§6）
- 値の表記: 実ドメインは `<domain>`、issuer のホストは `<issuer-host>`、アカウント ID は `<account-id>`、利用者は `<email>` と書く。この文書に実際の値は書かない（awsbridge は public リポジトリ）
- 用語: 「**コンソールログイン**」はこの仕組みの名前で、AWS コンソールへのログインと `aws login`（CLI）の両方を含む。単に「コンソール」と書くときは AWS マネジメントコンソールを指す。「**階層**」は Standard / Admin（デプロイと issuer の分かれ目）。「**ロール**」は設定の `roles[]`（例 ReadOnly・Developer・Admin）。「**境界**」は信頼の境界（管理下 `managed` / 管理外の先方 `partner:<id>`）

## 目次

1. cto の条件とゲートの対応（ギャップ分析）
2. 全体構成
3. 配布後に変えにくい名前
4. CloudFormation / StackSets のテンプレート
5. 脅威モデル
6. 緊急停止と break-glass
7. 段階 1 の範囲・開始条件・合格条件（1a / 1b）
8. 未検証のまま段階 1 に入るもの
9. 段階 1 のゲートの決裁と未決事項

---

## 1. cto の条件とゲートの対応（ギャップ分析）

### 1.1 条件（3-B）

| # | cto の条件 | 状態 | どこに書いたか・実装 | 残り |
|---|---|---|---|---|
| 1 | Worker は検証した Access JWT の AUD だけからチームを決め、未知の AUD には発行しない。AUD → チームの対応の作り方と、Access ポリシーの形を CI で検査する | 設計済み。対応の生成と突き合わせは実装済み | 判定: portal §3.1・§9.3 の 2・§9.4（`unknown_audience`・`team_mismatch`。`aud` が複数・未知・曖昧なら発行しない）。対応の生成: portal §11.4（Terraform の出力 → `AWSBRIDGE_CONSOLE_AUD_FILE` → 生成物）。突き合わせ: `src/console/generate.ts`（AUD の欠落・食い違い・重複、設定にないチーム）。検査の順: portal §11.5。ポリシーの形の検査の定義: この文書 §4.6。AUD → チームの対応は**認可の設定**として保護する（§5.1 の A12） | ポリシーの形の検査は下流の CI で、まだない（上流は `access.json` と検査の定義を渡す）。Worker 側の判定（`aud` が複数・未知なら発行しない単体テストを含む）はポータル本体と一緒に実装する |
| 2 | 脅威モデルに「種類の定義を置く private リポジトリと StackSets 更新用の CI ロール」「Access の Terraform と適用権限」の 2 つの資産を足す | この文書で追加 | §5.1 の A10・A11、§5.3 の T9・T10、§5.4 | 承認 1 人は段階 1 に限り受け入れる（§9.1 の G-14） |
| 3 | 配布後に変えにくい名前（issuer の URL・audience・ロールのパス・タグ）を段階 1 の前に確定する | **確定**（cto の決裁。§3） | §3。audience の定数とロールのパス（P-2）は実装済み（`src/console/config.ts` の `AUDIENCE`・`ROLE_PATH_PREFIX`・`rolePath`） | Admin の issuer の形（方向 I-B）の確定は段階 3 |
| 4 | `transitive_tag_keys` を設定しない | 方針は portal §0 にあった。JWT の形とテンプレートに書いた | §3.4・§4.3 | 実装（ポータル本体の署名部分）で単体テストにする |
| 5 | `aws login --remote` を既定で許さない方向 | 方針は portal §6.5・G-4。塞ぎ方を調べた | §4.4 | localhost だけのポリシーで `--remote` が拒否されるかは 1a の前の条件（§7.2 の (1)）。不成立なら段階 1 は `aws login` を案内しない |
| 6 | architecture.md の IdP の記述（83 行目付近）を直す | 済み | architecture.md「IdP について」（Access の JWT だけを見る形に直した。コミット `1bcf1bd`） | なし |
| 7 | 利用者への暫定案（名前で照合）を訂正する | このリポジトリからは確かめられない | 文書は M2（Access ポリシーが Object ID で所属を判定）に一本化した。名前の照合は却下と書いた（portal §0・§12.4、この文書 §2.1） | 利用者への訂正の連絡が済んだかは、上申者が確かめる |

### 1.2 段階 1 の前のゲート（3-C）

| ゲート | 状態 | 根拠 |
|---|---|---|
| N9 パス付き issuer | 成立（開発環境） | 1 つのホストの `/std` と `/admin` を別の OIDC プロバイダーに登録でき、階層をまたぐ引き受けは AccessDenied、issuer の末尾スラッシュ違いは InvalidIdentityToken（完全一致）[確認済み: portal PoC の README]。PoC は 1 つの Worker が両方のパスを出した。Admin の issuer は方向 I-B（階層ごとのホスト）で、確定は段階 3（§3.1） |
| N1 の M2（パスごとに AUD が分かれるか） | 成立（開発環境・Google の IdP） | 入口・`/t/infra`・`/t/dev` の `aud` が別。`/t/infrastructure` は前方一致にならない。片方のアプリから外すとそのパスだけ拒否 [確認済み: 同じ README]。**会社の Entra のグループ（Object ID）での確認は 1a の合格条件**（§7.3） |
| N10 Access + Worker の通し経路 | コンソールは成立。`aws login` と Entra は残り | コンソールの通し、タグ `awsbridge_team` と SourceIdentity の CloudTrail への記録、別チームの経路での `sts_denied` [確認済み]。所属の反映はポリシーの伝播（約 20 秒では足りず、約 2 分 15 秒で反映）＋トークンの失効、またはアプリのセッションの期限切れ [確認済み]。**同じ端末の `aws login` と `--remote` の拒否（P-2）は 1a の前の条件**（§7.2） |
| 詳細設計（エンドポイント・CSRF・テンプレート） | 書いた | エンドポイントと CSRF: portal §9.2〜§9.7。テンプレート: この文書 §4。全体と脅威モデル: この文書 |
| Sol のレビュー | **済み**。採った指摘をこの文書と portal に反映した | 指摘と反映先は §9.1 の「Sol のレビューの指摘の反映」 |
| cto の決裁 | **条件付き承認**。段階 1 を 1a・1b に分ける | §7・§9 |

---

## 2. 全体構成

### 2.1 構成図

```
利用者のブラウザ / 端末
   │
   ▼
Cloudflare Access（コンソールログイン用。MCP 用とは別のアプリ）
   │  チームごとのアプリ（R-P: https://portal.<domain>/t/<team>/）。ポリシーはそのチームの Entra グループ（Object ID）
   │  IdP は Access の設定（会社は Entra ID）。この設計の前提にはしない
   ▼
console Worker（Standard のデプロイ）        console Worker（Admin のデプロイ。段階 3 まで作らない）
   │ Access JWT を検証 → AUD だけからチーム     │ 同じ処理。Admin の階層のチームと行だけを持つ
   │ → 一覧（表示用）で選択を確かめる            │ 鍵は KMS（段階 3。N6 の成立が条件）
   │ → Standard の鍵で短命 JWT に署名           │
   ▼                                        ▼
STS AssumeRoleWithWebIdentity（各アカウント）
   │ 信頼ポリシー: そのロールの階層の issuer のプロバイダー・aud・aws:RequestTag/awsbridge_team・TagKeys・SourceIdentity 必須
   ▼
getSigninToken → 302 でコンソール ──（コンソールのセッションから）──▶ aws login（localhost だけ）

issuer の公開文書（discovery と JWKS）: https://<issuer-host>/std/...（Standard の Worker）。Admin は方向 I-B で別のホスト（Admin の Worker。確定は段階 3）。§3.1
各アカウント: 基盤の StackSet（OIDC プロバイダー）＋ 種類の StackSet（ロール）。§4
```

- 認可の権威は AWS 側に置く。所属（人 → チーム）は Entra のグループ、割り当て（チーム × 種類 → ロール）は設定ファイルの `kinds` → StackSets → 各ロールの信頼ポリシー。Worker は「どの Access アプリを通ったか（AUD）」をタグに写すだけで、対応表を権威として持たない [資料: cto の決裁 D5・D9・D10]
- 所属の確認は M2（チームごとの Access アプリ）。グループ名で照合する案（M1）と、Worker に対応表を持たせる案は却下済み [資料: cto の決裁 D5]

### 2.2 デプロイと鍵の分け方

| 項目 | 決定・案 | 根拠 |
|---|---|---|
| Worker | コンソールログイン用は MCP 用と別の Worker。awsbridge リポジトリ内の別エントリ。MCP 用のバンドルにコンソールログイン用の経路が入らないことをテストで確かめる（実装済み: `test/e2e/console-bundle.test.ts`・`test/unit/console-layout.test.ts`） | [資料: cto の決裁 D2] |
| Standard と Admin | 別の Worker デプロイ。Standard のバンドルに Admin の行・鍵の参照・AUD を入れない（portal §8・§9.10） | [資料: cto の決裁 D3] |
| 鍵 | 「階層（Standard / Admin）× 境界（管理下 / 管理外の先方ごと）」で分ける。issuer も同じ単位で分け、1 つの issuer に 1 つの鍵 | [資料: cto の決裁 D3]。設定の検査（issuer の URL の重複を誤りにする）は実装済み（`src/console/config.ts`） |
| 鍵の保管 | Standard: 段階 1・2 は Workers secret。Admin: KMS 必須（段階 3。N6 の成立が条件）。Standard を KMS に移すかは段階 3 で見直す | [資料: cto の決裁 D4] |
| Cloudflare アカウント | 段階 1 は既存の Cloudflare アカウントを使う。コンソールログイン用に分けるかは段階 2 のゲートで決める | [資料: cto の決裁（G-13）] |
| 段階 1 で作るもの | Standard の Worker・管理下の境界の Standard の issuer と鍵 1 本だけ。Admin のデプロイ・Admin の issuer・Admin のプロバイダーは作らない | §7 |

### 2.3 MCP 用との分離

| 項目 | MCP 用（既存） | コンソールログイン用 |
|---|---|---|
| Worker | `awsbridge`（workers.dev） | 別の Worker。ポータルは自社ドメインの Custom Domain、issuer は専用ホスト（§3.1）。**workers.dev と Preview URL は無効にする**（§5.4 の「Access を経由しない入口」） |
| Access アプリ | MCP Portal と self-hosted のアプリ | 入口とチームごとのアプリ（portal §9.1）。issuer のホストには Access アプリを置かない（§3.1） |
| issuer と鍵 | 1 つ（Worker の URL） | 階層 × 境界ごと |
| audience | `awsbridge`（`infra/aws/awsbridge.yaml`） | `awsbridge-console`（§3.2） |
| ロール | `FederatedMcpViewer` / `FederatedMcpDebugger`（パスなし） | `/awsbridge-console/<tier>/` の下（§3.3） |
| 認可の条件 | `<issuer>:sub` の許可リスト | `aws:RequestTag/awsbridge_team` の許可値・`aws:TagKeys`・SourceIdentity 必須。`sub` は照合しない |
| CSRF の前提 | ブラウザを想定しない（Origin があれば検査、Content-Type は JSON） | ブラウザが本線。Origin 必須・CSRF トークン・フォームの POST（portal §9.5） |
| 設定 | `config/profiles.json`（バンドル） | 設定ファイル → 生成物（portal §11） |

分ける理由（cto の決裁の要約）: 同じ issuer でタグや SourceIdentity を出すと、TagSession / SetSourceIdentity のない既存ロールの引き受けが失敗する [確認済み: PoC の P2 ケース 9]。CSRF の前提が逆。Access ポリシーを別に厳しくできる。鍵が漏れたときの影響範囲を分けられる。

**ロールは共有しない（決裁 S2、2026-11。MCP 用とコンソール用でロールを共有する案 S1 は却下。原則はエージェントの権限 ≤ 人の権限）。** MCP 用ロール（`FederatedMcpViewer` / `FederatedMcpDebugger`）は、人の階層（Viewer / Developer / Administrator。設定例のロール名は `FederatedViewer` / `FederatedDeveloper` / `FederatedAdministrator`）と独立した別のロールで、信頼ポリシー・issuer・audience も別である。人にコンソールのロールを与えても、MCP 側の権限には効かない。MCP 用ロールを渡す人は、人の階層と次のように揃える（利用者の決定）:

- MCP の Viewer（`FederatedMcpViewer`）は全員が使える。
- MCP の Debugger（`FederatedMcpDebugger`）は、人の Administrator か Developer を持つ人にだけ渡す。Viewer だけの人には渡さない。Debugger はリモートシェルなどで実行先（インスタンス・タスク）のロールの権限を得られ、その権限には MCP 経由の条件が付かないため、人に Developer / Administrator を渡すかどうかの判断と揃える。
- 原則は「そのアカウントで Administrator か Developer を持つ人に渡す」。ただし、人の権限の所持から自動で判定することは今はできない（MCP 側の認可は email の許可リスト `DebugAllowedSubjects` で、チームの情報を持たない）。当面は、グループ（チーム）ごとに Debugger を渡すかを決めてよい。
- 運用: 下流が「Debugger を渡すチーム」をアカウントごとに決め、そのチームのメンバーを `DebugAllowedSubjects` に入れる。許可リストはアカウントごとの設定なので、合わせる単位は「そのアカウント」（別のアカウントで Developer を持つだけの人は入れない）。チームのメンバーが変わったときや、人から Developer / Administrator を外したときは、`DebugAllowedSubjects` も直す。外し忘れは気付きにくいので、所属変更の手順に入れる。
- 将来: MCP 側の認可をチーム（Access アプリ → セッションタグ）に寄せれば、チームごとの割り当てを自動で強制できる（別の設計として扱う。未着手）。

---

## 3. 配布後に変えにくい名前

各アカウントの IAM（プロバイダーの URL・信頼ポリシーの条件キー・ロールの ARN）と CloudTrail に入る名前は、配ったあとに変えると、全アカウントの StackSets の更新と、発行済みのセッションの切断を伴う。段階 1 のゲートで、cto が次のとおり確定した [資料: cto の決裁]。

| 名前 | 確定した値 | 節 |
|---|---|---|
| Standard の issuer | `https://<issuer-host>/std`（世代つきのパスの規則も可） | §3.1 |
| Admin の issuer | 方向 I-B（階層ごとのホスト）。確定は段階 3 | §3.1 |
| audience | `awsbridge-console`（定数 1 つ。全階層・全境界で同じ） | §3.2 |
| ロールのパス | `/awsbridge-console/<tier>/`（P-2。`<tier>` は `std` / `admin`） | §3.3 |
| タグのキー | `awsbridge_team` | §3.4 |
| RoleSessionName | `console-<email>`（email は 56 文字まで） | §3.4 |
| StackSet・SCP の名前 | `awsbridge-console-base`・`awsbridge-console-kind-<kind>`・`awsbridge-console-stop-*` | §3.5 |

### 3.1 issuer の URL

**確定**: Standard は `https://<issuer-host>/std`（管理外の先方は `https://<issuer-host>/p/<partner-id>/std`）[資料: cto の決裁]

| 部分 | 規則 | 例 |
|---|---|---|
| スキーム | `https` | — |
| ホスト | 自社ドメインの、issuer **専用**のホスト（`<issuer-host>`。例 `id.<domain>` のような名前）。ポータルのホストと分ける。`workers.dev` は使わない | — |
| `<tier>` | `std`（Standard）/ `admin`（Admin） | `/std`・`/admin` |
| 管理外 | `/p/<partner-id>/<tier>`。`<partner-id>` は先方の名前を含まない不透明な短い ID（`^[a-z0-9]{2,16}$`。例 `p01`）。discovery は誰でも読めるので、URL から取引先が分からないようにする | `/p/p01/std` |
| 末尾 | スラッシュなし。クエリ・フラグメントなし（IAM は issuer を完全一致で照合する [確認済み: N9 のケース 6]） | — |
| 公開文書 | `<issuer>/.well-known/openid-configuration` と `<issuer>/.well-known/jwks.json`（N9 と同じ） | `/std/.well-known/jwks.json` |

ポータルのホストと分ける理由:

- ポータルのホスト名を変えても issuer が変わらない（ポータルの名前は利用者向けで、変えたくなりうる）
- ポータルのホストは Access アプリで覆う。同じホストに issuer を置くと Bypass のアプリが要り、Access の設定の誤りが IAM の検証（全アカウントのログイン）を止めうる。専用ホストには Access アプリを置かない
- ポータルは Custom Domain でホスト全体を 1 つの Worker に向ける（portal §3.1）。同じホストに Admin の issuer を置けない

Standard と Admin の 2 つの Worker への振り分け（N9 は 1 つの Worker で確かめた。2 つの Worker に分けた形は**未検証**）:

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| I-A 1 ホスト + Workers Routes | `<issuer-host>/std/*`・`<issuer-host>/p/*` を Standard の Worker、`<issuer-host>/admin/*` を Admin の Worker に Routes で向ける（ホストは Cloudflare のプロキシの DNS レコード） | URL が N9 で確かめた形のまま | Routes の振り分けを 2 つの Worker で試していない [未検証]。**同じホストに置くと、ルーティング（Routes）の管理者からは Standard と Admin を隔離できない**。振り分けの設定を変えられる者は Admin の JWKS を差し替えられる [資料: Sol のレビューの指摘 3] |
| **I-B 階層ごとにホスト**（cto の決裁の方向） | `https://<issuer-host-std>/std` と `https://<issuer-host-admin>/admin`。それぞれ Custom Domain | Custom Domain だけで済む。Worker ごとにホストが完全に分かれ、Admin のホストの管理権限を分けられる | ホストが 2 つになる。同じゾーン・同じ Cloudflare アカウントのままなら、ゾーンと Workers の管理者からの分離にはならない（Cloudflare アカウントを分けるかは段階 2 のゲート） |

- **Admin の issuer は方向 I-B で、確定は段階 3**（cto の決裁）。段階 1 は Standard の Worker と `/std` だけを使う。Admin の URL は段階 3 で初めて各アカウントに配るので、段階 1・2 の配布には影響しない
- Standard のホスト（`<issuer-host>`）の名前は、I-B でも `/std` のパスのまま使う（段階 1 で配った URL を変えない）
- 鍵が漏れたあとは、同じ URL での作り直し（JWKS のキャッシュ。N5）に頼らず、世代を付けた新しいパス（例 `/std-2`）に移れる規則にしておく（`^[a-z0-9-]+$`）。平常時の URL には世代を入れない。移る手順（新しいプロバイダーの配布 → 信頼ポリシーの切り替え → 古いプロバイダーの削除）は段階 2 の前に書く [資料: cto の決裁で可。Sol のレビューの指摘 12]

### 3.2 audience

**確定**: `awsbridge-console`（全階層・全境界で同じ値。定数 1 つ）[資料: cto の決裁]

- MCP 用の `awsbridge` と重ならない
- issuer を階層 × 境界で分けているので、aud まで分けなくても、Standard の JWT で Admin のロールには入れない（条件キーが `<issuer-host>/std:aud` と `<issuer-host>/admin:aud` で別。N9 のケース 3・4 で AccessDenied [確認済み]）。共通の audience は、issuer が分かれていれば欠陥ではない [資料: Sol のレビューの指摘 12]
- 実装: 上流の定数 `AUDIENCE`（`src/console/config.ts`。`TEAM_TAG_KEY`・`ROLE_PATH_PREFIX` と同じ並び）にし、生成物（`stacksets.json` の `audience`）に入れた。下流ごとに変える理由がないので、設定スキーマには入れない

### 3.3 ロールのパスと名前

| 項目 | 確定 | 備考 |
|---|---|---|
| パス | **P-2**: `/awsbridge-console/<tier>/`（`/awsbridge-console/std/`・`/awsbridge-console/admin/`）[資料: cto の決裁] | SCP や `aws:PrincipalArn` の条件で「コンソールログイン用すべて」（`arn:aws:iam::*:role/awsbridge-console/*`）と「Admin の階層だけ」（`.../awsbridge-console/admin/*`）を、ロール名を知らずに止められる。ArnLike の `*` がパスの `/` をまたいで一致するかは [推測]（SCP の訓練で確かめる）。実装: `rolePath(tier)`（`src/console/config.ts`）。一覧の `roleArn` と `stacksets.json` の `roles[].rolePath` はこの値、`rolePathPrefix` は `/awsbridge-console/` |
| tier とパスの意味 | パスの `<tier>` は停止の対象選びに使う名前で、**権限の強さを保証しない**（Standard のロールに強い権限を付けることは、パスでは防げない。portal §11.5 の検査と A10 の保護で防ぐ）[資料: Sol のレビューの指摘 10・12] | — |
| ロール名 | 設定の `roles[].roleName`（下流が決める。例 `FederatedViewer`）。上流は名前を決めない | ロールの名前を変えると、そのロールのセッションは切れる |
| MCP 用との区別 | パスで区別できる（MCP 用はパスなし） | — |

### 3.4 タグと JWT の claim

| 項目 | 確定 | 備考 |
|---|---|---|
| タグのキー | `awsbridge_team`（上流の定数 `TEAM_TAG_KEY`。実装済み） | キーの大文字・小文字は区別される [確認済み: P2 ケース 7] |
| タグの値 | チーム名。`^[a-z][a-z0-9-]{0,31}$`（設定の `teams[].name`。実装済み） | 信頼ポリシー・Access アプリの名前・URL のパスにも入るので、チームの改名は「新しいチームを作って移す」になる |
| Admin の階層のチーム | 設定で明示する（`tier: "admin"`）。名前の規則は下流の自由とし、例は `<team>-elevated` | 暗黙に `-elevated` を付ける規則は持たない（portal §11.4） |
| タグの数 | 1 個（`aws:TagKeys` で他のキーを拒否） | パック後 4096 バイトの制限に余裕がある（1 個で SessionTokenUtilization 25%）[確認済み: P2] |
| `sub` | 利用者の email（小文字） | 信頼ポリシーでは照合しない |
| SourceIdentity | 段階 1 は利用者の email（小文字）。`https://aws.amazon.com/source_identity` の claim | AWS の文書は 2〜256 文字・英数字と `_.,+=@-` [確認済み: IAM の文書]。前の資料の「64 文字」とは食い違うので、実装は短い方（64 文字）に合わせ、超えたら `identity_unsupported`。**不変の ID（Access の `sub` など）に変えるかは段階 2 のゲートで決める**。段階 1 は信頼ポリシーに SourceIdentity の形の条件を足さず、発行記録に Access JWT の `sub` を残して判断材料にする [資料: cto の決裁。Sol のレビューの指摘 9] |
| RoleSessionName | `console-<email>` | 2〜64 文字で、接頭辞 `console-` が 8 文字なので、email は 56 文字まで（超えたら `identity_unsupported`）。portal §6.1 |
| タグの claim | `https://aws.amazon.com/tags` の `principal_tags` に `awsbridge_team` だけ。**`transitive_tag_keys` は入れない** | §4.3 |
| JWT の有効期限 | 約 5 分。`jti` を付け、発行記録に残す | MCP 用と同じ。`jti` は CloudTrail に引き継がれないので、CloudTrail との突き合わせには STS の応答の ID を使う（§5.6） |

### 3.5 そのほかの名前

| 項目 | 確定 |
|---|---|
| StackSet の名前 | 基盤 `awsbridge-console-base`、種類 `awsbridge-console-kind-<kind>`（`<kind>` は設定の `kinds[].name`）。SCP のドリフト防止の除外条件と CI の権限に入る |
| 停止用の SCP の名前 | `awsbridge-console-stop-all`・`awsbridge-console-stop-admin` |
| 停止用の固定の Deny 管理ポリシー（段階 2 で E1 の直した形を採る場合） | 段階 1 は E0 を選んだので作らない。段階 2 のゲートで経路を決めるときに名前も決める（§6.6・§6.7） |
| ポータルのホスト | 下流の設定（`portal.standardOrigin`）。段階 1 の前に下流で確定する（portal §3.1） |

---

## 4. CloudFormation / StackSets のテンプレート

実装はまだない。ここではテンプレートの形と、設定・生成物との対応を決める。

### 4.1 構成

| StackSet | 単位 | 中身 | 配り方 |
|---|---|---|---|
| 基盤 `awsbridge-console-base` | Organization ごとに 1 つ（管理下）。管理外は先方が 1 本流す | OIDC プロバイダー（Standard、と Admin を使うなら Admin） | service-managed。段階 2 以降は Organization の全メンバーアカウント。**段階 1 は種類のスタックと同じ対象アカウントだけに、運用者が手作業で配る**（§7.1。CI に適用権限を持たせない）。管理アカウントは対象外（コンソールログイン用ロールを置かない） |
| 種類 `awsbridge-console-kind-<kind>` | 種類 × Organization ごと | その種類で割り当てのあるロールだけ | 段階 2 以降: S1（種類の OU に自動デプロイ）か S3（アカウントを列挙。自動デプロイなし）。段階 1: 対象アカウントを列挙して手作業で配る（自動デプロイは使わない [推測: cto の決裁の「手作業で配る」からの読み取り]）。管理外は先方 |

- 種類の StackSet は基盤の StackSet に依存させる（StackSet 間の依存）[資料: 前の設計上申 §4.6.6。AWS の文書で確認]
- プロバイダーを種類の StackSet に入れない。種類を変える（OU を移す）と自動デプロイが古いスタックを消すので、プロバイダーまで作り直しになるため
- 種類の OU を入れ子にしない（子 OU も対象になり、同じ名前のロールが 2 つの StackSet から配られる）。CI で検査する（portal §11.5）
- 種類のテンプレートは、設定の `roles` から生成する案（K1）を推す（portal §11.4・G-9）。上流は生成器とテストを持ち、下流は生成物を cfn-lint とレビューにかける
- **段階 1 では CI に StackSets の適用権限を持たせない**。配布は運用者が手作業で行い、CI は検査（設定・生成物・テンプレート・ドリフト）だけを行う [資料: cto の決裁。Sol のレビューの指摘 1: Organization 全体に任意のロールを配れる CI を使うと、段階 1 の侵害時の影響範囲が試験の範囲と一致しない。サービス管理型 StackSets のサービスリンクロールには SCP が効かない]。CI に適用権限を持たせるのは、対象アカウント・対象スタック・許可したテンプレートに絞れることと、本人以外の承認（G-14）を確かめてから（段階 2 のゲート）

### 4.2 基盤のテンプレート

| パラメーター | 型と規則 | 生成物の出どころ |
|---|---|---|
| `IssuerHost` | ホスト名だけ（スキーム・パス・末尾スラッシュなし） | `stacksets.json` の `providers[].issuers.standard` のホスト部分。**Admin の issuer は方向 I-B で別のホストになる**（§3.1）。Admin のホストのパラメーターの形は段階 3 で決める（段階 1・2 は Admin を作らない） |
| `StandardPath` | `^[a-z0-9-]+(/[a-z0-9-]+)*$`（例 `std`・`p/p01/std`） | 同じ URL のパス部分 |
| `AdminPath` | 同じ規則。**空なら Admin のプロバイダーを作らない**（`Conditions`）。段階 1・2 は空 | `providers[].issuers.admin`（なければ空） |
| `Audience` | `AllowedValues: [awsbridge-console]` | `stacksets.json` の `audience`（上流の定数 `AUDIENCE`。§3.2） |

| リソース | 内容 |
|---|---|
| `StandardProvider` | `AWS::IAM::OIDCProvider`。`Url: https://${IssuerHost}/${StandardPath}`、`ClientIdList: [Audience]`。`ThumbprintList` は付けない（N9 の PoC も付けずに作れた [確認済み]） |
| `AdminProvider` | 同じ。`Condition: HasAdmin` |

### 4.3 種類のテンプレート（ロールごと）

設定の `roles[]` の 1 件ごとに、次のパラメーターとリソースを生成する。

| パラメーター | 内容 | 生成物の出どころ |
|---|---|---|
| `<Name>Teams` | そのロールが受け付けるチーム名のカンマ区切り。**空ならロールを作らない**（`Conditions`）。型は `String`（空を許すため） | `stacksets.json` の `assignments[].parameters`。名前は `teamsParameterName`（`readonly` → `ReadonlyTeams`、`read-only` → `ReadOnlyTeams`） |

| 項目 | 内容 | 生成物の出どころ |
|---|---|---|
| `RoleName` / `Path` | `roleName` / `/awsbridge-console/<tier>/`（§3.3 の P-2） | `roles[].roleName`・`roles[].rolePath` |
| `MaxSessionDuration` | `sessionSeconds`（900〜43200） | `roles[].sessionSeconds` |
| `ManagedPolicyArns` | 設定の AWS 管理ポリシー | `roles[].managedPolicyArns` |
| インラインポリシー | (1) `AwsLoginLocalhostOnly`（§4.4）、(2) 下流のポリシー文書（`inlinePolicyFiles`）、(3) 自分自身の保護（`/awsbridge-console/*` のロールの信頼ポリシー・ポリシー・パスの変更と、コンソールログイン用のプロバイダーの変更を Deny）、(4) **ロールチェーンの禁止**（`sts:AssumeRole` を明示の Deny。§4.7）。(3) は Admin のロールが自分で外せるので、管理下では SCP（§6）で補う [推測] | `roles[].inlinePolicyFiles`、上流の固定の文書 |
| 信頼ポリシー | 下の形。`Principal` は、そのロールの階層のプロバイダー（`arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/<その階層の issuer のホスト>/<その階層のパス>`）だけ。Admin のホストは方向 I-B で Standard と別（段階 3） | 基盤と同じ issuer のホスト・パス、`tagKey`、`audience` |

信頼ポリシーの形（PoC の `scripts/poc/human/portal/poc-portal.yaml` と同じ。P2・P3・N9・N10 で許可と拒否が分かれた [確認済み]）:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/<issuer-host>/std" },
  "Action": ["sts:AssumeRoleWithWebIdentity", "sts:TagSession", "sts:SetSourceIdentity"],
  "Condition": {
    "StringEquals": {
      "<issuer-host>/std:aud": "awsbridge-console",
      "aws:RequestTag/awsbridge_team": ["<team>", "<team>"]
    },
    "ForAllValues:StringEquals": { "aws:TagKeys": ["awsbridge_team"] },
    "Null": { "sts:SourceIdentity": "false" }
  }
}
```

| 条件 | 役割 | 確かめたこと |
|---|---|---|
| `<issuer>:aud` | コンソールログイン用の audience だけ | N9 |
| `aws:RequestTag/awsbridge_team` | 許可するチーム。タグがなければ一致しないので拒否される（`ForAllValues` だけでは空集合が通るため、この条件が要る） | P2 ケース 4・5、N10 の `sts_denied` |
| `ForAllValues:StringEquals aws:TagKeys` | 未知のキーを拒否 | P2 ケース 6 |
| `Null sts:SourceIdentity = false` | SourceIdentity 必須 | P2 ケース 8、N9 ケース 10 |
| `sub` | 照合しない（所属は Access が判定済み。許可リストは 8,192 文字の上限と配布の手間で破綻する） | — |
| `sts:SourceIdentity` の形（例 `StringLike *@<domain>`） | 付けない案を推す。ドメインを信頼ポリシーに入れると下流ごとに変わり、鍵が漏れたときは偽造できるので防御にならない [推測] | — |

`transitive_tag_keys` を設定しない（cto の条件）ことの意味:

- コンソールログイン用のロールから別のロールへチェーンしたとき、`awsbridge_team` は引き継がれない。チェーン先の信頼ポリシーがタグで判定することはない
- SourceIdentity はチェーン先にも引き継がれる。そのため、**チェーン先のロールの信頼ポリシーに `sts:SetSourceIdentity` がないと、チェーンが失敗する** [確認済み: AWS の文書（IAM の SourceIdentity の説明と AWS Security Blog）]。また、SourceIdentity を必須にしたロールには、コンソールの Switch Role で入れない [確認済み: IAM の文書]。コンソールログイン用のセッションから既存のロールへのチェーン（N12）は、段階 2 の前に確かめる（§8）

### 4.4 `aws login` と `--remote` の塞ぎ方

調べた結果:

| 項目 | 内容 | 状態 |
|---|---|---|
| リソースの ARN | 同じ端末の `aws login` は `arn:aws:signin:<region>:<account-id>:oauth2/public-client/localhost`、`--remote` は `.../oauth2/public-client/remote`。アクションは `signin:AuthorizeOAuth2Access` と `signin:CreateOAuth2Token` | [確認済み: AWS Sign-In の文書（`SignInLocalDevelopmentAccess` の説明）] |
| 管理ポリシー | `SignInLocalDevelopmentAccess` は両方を許す。文書は「どちらかを制御するには、自前の管理ポリシーか SCP でこの ARN を許可・拒否する」と書く | [確認済み: 同じ文書] |
| 条件キー | `signin:OAuthRedirectUri`・`signin:OAuthGrantType` がある。文書の例は AWS MCP Server の OAuth（`service-principal/aws-mcp.amazonaws.com`）向けで、`aws login` の `--remote`（リダイレクト先が `https://<region>.signin.aws.amazon.com/v1/sessions/confirmation`）を塞ぐのに使えるかは書かれていない | **未確認** |
| 個別のセッションの拒否 | `aws:SignInSessionArn` で特定のサインインのセッションを Deny できると文書にある（AWS MCP Server の OAuth の文脈） | `aws login` に効くかは**未確認** |

設計:

| 対策 | 対象 | 内容 |
|---|---|---|
| (1) ロールのポリシー（全境界） | 種類のテンプレートの全ロール | 管理ポリシーを付けず、`AwsLoginLocalhostOnly`（2 つのアクション、リソースは `arn:${AWS::Partition}:signin:*:${AWS::AccountId}:oauth2/public-client/localhost` だけ）を付ける。PoC のテンプレートと同じ形 |
| (2) 生成の検査 | 設定 | `roles[].permissions.managedPolicyArns` に `SignInLocalDevelopmentAccess`（と、`signin:*` を含む広い管理ポリシーを付けたときの警告）を誤りにする。未実装 |
| (3) SCP（管理下） | 停止用とは別の常設の SCP | `signin:AuthorizeOAuth2Access`・`signin:CreateOAuth2Token` の `.../oauth2/public-client/remote` を、`/awsbridge-console/*` のロールについて Deny する。`AdministratorAccess`（`Action: *`）のように `signin:*` を含むポリシーを付けたロールでも塞げる（SCP の Deny は許可より強い） |
| 未検証 | — | (1) で同じ端末の `aws login` が通り、`--remote` が拒否されること（P-2）。**1a の前の条件 (1)（開発環境。§7.2）**。不成立なら段階 1 は `aws login` を案内しない |

### 4.5 パラメーターと生成物の対応（まとめ）

| テンプレートの値 | 生成物（`stacksets.json`） | 状態 |
|---|---|---|
| issuer のホストとパス | `providers[].issuers`（URL のまま） | 生成物は URL。ホストとパスへの分解はテンプレートの生成で行う |
| audience | `audience` | あり（上流の定数 `AUDIENCE`。§3.2） |
| タグのキー | `tagKey` | あり |
| ロールのパス | `roles[].rolePath`（`/awsbridge-console/<tier>/`）と `rolePathPrefix`（`/awsbridge-console/`） | あり（P-2） |
| ロールの定義 | `roles[]`（`roleName`・`tier`・`rolePath`・`sessionSeconds`・`managedPolicyArns`・`inlinePolicyFiles`・`teamsParameter`） | あり |
| `<Name>Teams` | `assignments[].parameters` | あり |
| 配る先 | `assignments[].target`（`ous` か `accounts`） | あり |
| StackSet の名前 | なし | 欠落。§3.5 の規則で生成時に作る |
| 停止の印（§6.7 の案） | なし | 段階 2 の前に決める（N8） |

### 4.6 Access ポリシーの形の CI 検査（cto の条件 1）

下流の CI で、`terraform show -json`（plan と state）を読み、次を確かめる。上流はこの検査の定義と `access.json`（portal §11.4）を渡す。

| 検査 | 内容 |
|---|---|
| チームのアプリ | 1 つのチームに 1 つ。対象のパスが `<portal>/t/<team>`（R-P）と一致する |
| ポリシー | チームのアプリのポリシーは Allow が 1 つで、include は `access.json` のそのチームの `groupObjectIds`（Entra のグループ）だけ。`everyone`・email・email のドメイン・他のチームのグループを含まない。exclude と require は持ってよい（狭める側） |
| Bypass | issuer を専用ホストに置く場合（§3.1。G-8）: ポータルのホストに Bypass のアプリがない。ポータルのホストに置く場合: Bypass のアプリの対象が issuer の公開文書のパスだけ |
| 入口のアプリ | どのチームの AUD とも違う |
| AUD の対応 | Terraform の出力のチーム → AUD が、Worker 用の生成物の対応と全単射（`mise run console:config:check` に AUD のファイルを渡す。実装済み） |
| 想定外の認証方法 | チームのアプリ・入口のアプリに、Bypass・Service Auth（サービストークン）・`everyone` の include など、Entra のグループ以外で通る規則がない [資料: Sol のレビューの指摘 2] |
| 時機 | PR では plan、マージ後と定期に state。違えば Worker のデプロイを止める |

### 4.7 段階 1 の ReadOnly ロールの中身

段階 1 で配るのは Standard の ReadOnly ロール 1 つだけ（§7.1）。ReadOnly は安全な権限の上限とは限らない（データの読み出し・リソースポリシー経由の権限）[資料: Sol のレビューの指摘 10] ので、次の形に固定する。

| 項目 | 内容 | 根拠 |
|---|---|---|
| 管理ポリシー | `ReadOnlyAccess`（AWS 管理） | MCP 用の ReadOnly ロールと同じ（`infra/aws/awsbridge.yaml` の `ReadOnlyRole`） |
| ロールチェーンの禁止 | インラインポリシーで `sts:AssumeRole` を明示の Deny（`Resource: *`）。案内に書くだけでなく、権限で禁じる | Sol のレビューの指摘 4。SourceIdentity 付きのセッションからのチェーン（N12）は段階 2 のゲート |
| `aws login` | `signin:AuthorizeOAuth2Access`・`signin:CreateOAuth2Token` は `.../oauth2/public-client/localhost` だけを許す（§4.4 の (1)）。`SignInLocalDevelopmentAccess` は付けない。`--remote` が拒否されることは 1a の前の条件（§7.2 の (1)） | §4.4 |
| SSM パラメーター | **推奨: MCP 用の ReadOnly ロールと同じく Deny する**（`ssm:GetParameter`・`ssm:GetParameters`・`ssm:GetParametersByPath`・`ssm:GetParameterHistory`、`Resource: *`。`infra/aws/awsbridge.yaml` の `DenySsmParameterRead` と同じ文）。`ReadOnlyAccess` は SecureString の取得を許すので、パラメーターに置いた秘密を読める [推測: `ReadOnlyAccess` の中身は段階 1a で `iam:GetPolicyVersion` で確かめる]。人がコンソールで SSM の値を見る用途は、段階 1 では諦める | MCP 用と同じ扱いにそろえる。見たい要望が出たら段階 2 のゲートで見直す |
| そのほかの機微データ | `ReadOnlyAccess` には S3 のオブジェクトやデータベースの項目の読み取りが含まれうる。段階 1 は非本番の数アカウントに限るので受け入れ、段階 2 のゲートで「機微データの読み取り・IAM・signin の許可」を棚卸しする | Sol のレビューの指摘 10 [推測] |
| 自分自身の保護 | §4.3 のインラインポリシー (3) | — |

---

## 5. 脅威モデル

前の設計上申の脅威モデルを、その後の決定（タグのキー `awsbridge_team`、設定ファイルの `kinds`、ロールに付けるのは localhost だけのポリシー、Admin のチームの明示、承認は 1 人）に合わせて直し、cto の条件の資産 2 つ（A10・A11）を足した。段階 1 のゲートで、Sol のレビューの指摘 2・3・11 から資産 A12〜A16 と経路 T11〜T14 を足した。

### 5.1 資産

| # | 資産 | 置き場所 | 失われたときに起きること |
|---|---|---|---|
| A1 | issuer の署名鍵（階層 × 境界ごと） | Standard: Workers secret。Admin: KMS（段階 3） | その issuer を信頼する全アカウントで、信頼ポリシーが許す範囲のタグと SourceIdentity を**偽造して**引き受けられる |
| A2 | Worker のコード・依存パッケージ・ビルド成果物と、デプロイ権限（デプロイ用の API トークン） | リポジトリ・パッケージのレジストリ・CI・Cloudflare アカウント | A1 と同じ（任意のトークンを出させられる。secret の鍵は読み出せる）。KMS（段階 3）は鍵の持ち出しを防ぐだけで、侵害された Worker に Sign を呼ばれるのは防げない [資料: Sol のレビューの指摘 3] |
| A3 | Access アプリ・ポリシー・IdP の連携 | Cloudflare アカウント | 所属の判定を緩められる |
| A4 | Entra のグループ（と段階 3 の PIM） | Entra ID | 所属の権威そのもの |
| A5 | 各アカウントの信頼ポリシー・プロバイダー | 各アカウント（StackSets / 先方） | 許可値を変えられる（アカウントの管理者なら元々できる） |
| A6 | 表示用の一覧・生成物 | 下流の CI・Worker のバンドル | 表示の誤りだけ（権限は広がらない） |
| A7 | ログイン URL・一時認証情報・`aws login` のキャッシュとリフレッシュトークン | ブラウザ・端末（共有端末を含む） | そのセッション（最大はロールの MaxSessionDuration）を奪われる。`aws login` のリフレッシュトークンを持ち出されると、別の端末で更新を続けられる（revoke で更新が拒否されることは確認済み。P4(a)）。共有端末ではキャッシュが次の利用者に残る [資料: Sol のレビューの指摘 11] |
| A8 | 監査ログ（発行記録・Access のログ・CloudTrail） | Logpush の先・各アカウント | 追跡と検知ができなくなる |
| A9 | break-glass の認証情報 | 金庫・ハードウェアキー | 入口を通らずに入られる |
| **A10** | **種類の定義（設定ファイル）を置く private リポジトリと、StackSets を更新する CI のロール** | 会社の下流リポジトリ（GitHub）・管理アカウント（または StackSets の委任管理者）の CI 用ロール | 設定を変えると、任意のチームに任意のロールを割り当てられる（`kinds[].assign`）、ロールの権限を増やせる（`permissions`）、`tier` を偽って強い権限を Standard に置ける。CI のロールを奪えば、設定を経由せずに、その Organization の全メンバーアカウントに任意のロールと信頼を配れる（実質 Organization の管理者） |
| **A11** | **Access の Terraform（state を含む）と適用権限（API トークン）** | 下流リポジトリ・Terraform の state の置き場所・CI の secret | チームのアプリのポリシーを緩めれば、任意の人を任意のチーム（Admin の階層を含む）として通せる。Entra のグループを改ざんしたのと同じ効果（T4）を、Entra の監査の外で起こせる |
| **A12** | **AUD → チームの対応**（Terraform の出力 → `AWSBRIDGE_CONSOLE_AUD_FILE` → Worker 用の生成物） | 下流の CI・Worker のバンドル | **表示用ではなく認可の設定**。信頼ポリシーは `sub` を照合しないので、この対応と発行のコードが所属の判定をすべて担う。取り違えると、あるチームのアプリを通った人に別のチームのタグが付く [資料: Sol のレビューの指摘 2・cto の決裁] |
| **A13** | **DNS と証明書**（issuer のホスト・ポータルのホスト） | Cloudflare のゾーン | issuer のホストを別の行き先に向けられれば、JWKS を差し替えて**鍵を盗まずに発行者になれる** |
| **A14** | **Workers Routes / Custom Domains** | Cloudflare アカウント | A13 と同じ（issuer のパスを別の Worker に向ける）。Access を経由しない入口（別ホスト・別 Route）を作られる |
| **A15** | **discovery・JWKS の応答とキャッシュ** | issuer の Worker・Cloudflare のキャッシュ・STS 側のキャッシュ | 偽の JWKS を一度でも読ませれば、キャッシュが切れるまで偽の鍵が信頼される。古い鍵がキャッシュに残ると差し替えが効かない（N5） |
| **A16** | **Cloudflare アカウントの復旧経路**（管理者の email・MFA の復旧・API トークンの発行権限） | Cloudflare・管理者の email | 復旧経路を奪われると、A2・A3・A11・A13・A14 をまとめて奪われる |
| **A17** | **Cloudflare ダッシュボードの Entra 以外のログイン**（ID/パスワード/パスキー。利用者が今後設定する予定） | Cloudflare アカウント | **停止の経路であると同時に、署名鍵と同じ重さの信頼基盤への新しい入口になる**。Standard の鍵は Worker の secret なので、アカウントに入れる者は発行者になれる（A1・A2）。Entra の条件付きアクセス・MFA・監査の外から入れる。L0・L1 を Entra なしで操作できる代わりに、A2・A3・A11・A13・A14 もまとめて奪われうる |

### 5.2 信頼の境界

```
[ブラウザ/端末] ─ [Cloudflare Access] ─ [Entra ID]
                        │ Access JWT（AUD = チーム）
                        ▼
                  [console Worker（Standard / Admin）] ─ (KMS: 段階 3)
                        │ 自前の JWT（iss = 階層 × 境界）
                        ▼
     [STS / 各アカウントの OIDC プロバイダー + 信頼ポリシー]
        ├─ 管理下・メンバーアカウント（SCP が効く）
        ├─ 管理下・管理アカウント（SCP が効かない → コンソールログイン用ロールを置かない）
        └─ 管理外の Organization（先方の管理。自社は SCP を打てない）

   設定の経路: [下流リポジトリ（A10）] ─ CI ─▶ StackSets（各アカウントのロール）
                                    └ CI ─▶ Terraform（A11）─▶ Access のアプリとポリシー
```

### 5.3 攻撃者・経路と影響範囲

| # | 攻撃者・経路 | 何ができるか | 影響範囲 | 主な対策 |
|---|---|---|---|---|
| T1 | 署名鍵の漏洩（secret の流出・鍵を作った端末・CI） | 任意の sub・タグ・SourceIdentity の JWT | その issuer を信頼する全アカウント × 信頼ポリシーが許すロール | 鍵の分割（§2.2）。Admin は KMS。発行記録と CloudTrail の突き合わせ（portal §10.3）。停止（§6） |
| T2 | Cloudflare アカウントの管理者（悪意・乗っ取り） | Worker の差し替え・secret の読み出し・Access の緩和・Routes の差し替え | T1 + T10 | 管理者を最小にし、ハードウェアキーの MFA。デプロイは CI と承認から。Cloudflare の監査ログを外部へ送り通知。Admin の鍵は KMS（持ち出せない） |
| T3 | Worker のバグ | AUD とチームの取り違え、入力の注入、CSRF、URL のログ出力 | 1 つの issuer の範囲で、信頼ポリシーが許す値に限られる | fail-closed、許可リストの照合、POST + CSRF トークン（portal §9） |
| T4 | Entra のグループの改ざん | 自分をチームのグループに入れる | そのチームが割り当てられた全アカウント | 所属変更の通知・アクセスレビュー。Admin の階層は role-assignable グループと PIM（段階 3。ライセンスは要確認） |
| T5 | ブラウザ・端末 | ログイン URL（15 分）・Cookie・`aws login` のキャッシュとリフレッシュトークンの窃取・持ち出し。共有端末に残ったキャッシュ | その利用者のセッション（リフレッシュトークンなら更新が続く限り） | URL は 302 だけ。セッションを階層で短く。`--remote` を塞ぐ（§4.4）。共有端末では `aws login` を使わない・使ったら `aws logout` する案内。停止（§6。revoke で更新も止まる） |
| T6 | Access のトークンの長寿命 | 外した人のトークンが残る | その人 | チームのアプリのセッションを短く（§6.4）。外すときは失効も行い、拒否を確かめる（§6.1 の L1） |
| T7 | 管理外の先方の視点 | 自社の T1・T2 が先方に及ぶ | 先方の全アカウント | 先方ごとに issuer と鍵（§3.1）。先方は自分でプロバイダーを消せる。契約で通知と停止手順を決める |
| T8 | 一覧・ポータルの偽装 | 偽のリンクへ誘導 | 限られる | Access の背後にだけ置く。リンクは Worker が組み立てる |
| **T9** | **A10 の侵害**（下流リポジトリへの書き込み、レビューのすり抜け、CI のロールの奪取） | 割り当て・権限・`tier` の改ざん。CI のロールでは任意の StackSets の操作 | Organization 全体（設定経由なら、改ざんした種類のアカウント） | §5.4 の A10 |
| **T10** | **A11 の侵害**（Terraform の API トークン・state・適用の CI） | チームのアプリのポリシーを緩める・入口とチームの対応を崩す | そのチームが割り当てられた全アカウント（Admin の階層のチームなら Admin） | §5.4 の A11 |
| **T11** | **Access を経由しない入口**（workers.dev・Preview URL・別ホスト・別 Route から Worker を直接呼ぶ。偽の `Cf-Access-Jwt-Assertion`、失効済み・期限内の Access JWT の持ち込み） | Access のポリシー・失効を飛ばして発行させる（Worker は署名と期限だけを見るので、失効した JWT もオフラインの検証は通る） | 持ち込んだ JWT のチーム | §5.4 の「Access を経由しない入口」 |
| **T12** | **A13〜A15 の侵害**（DNS・証明書・Routes・Custom Domains・JWKS のキャッシュ） | JWKS を差し替え、鍵を盗まずに発行者になる | T1 と同じ | §5.4 の「Cloudflare の信頼基盤」 |
| **T13** | **A16 の侵害**（Cloudflare アカウントの復旧経路の乗っ取り） | T2 と同じ | T1 + T10 + T12 | §5.4 の「Cloudflare の信頼基盤」 |
| **T14** | **発行 API の乱用**（大量の POST、STS のスロットリング、Workers・ログの費用の枯渇） | 正規の利用者のログインを止める。費用を増やす。ログを埋めて追跡を難しくする | 全利用者（可用性と費用） | 利用者ごとの回数の制限（portal §9.3 の 6。429 `rate_limited`）。値と全体の上限・費用の見張りは未決（§9.2） |

### 5.4 対策

**A10（種類の定義のリポジトリと StackSets の CI ロール）**

| 対策 | 内容 |
|---|---|
| リポジトリ | private。保護ブランチ（直接の push と force push を禁止、マージは PR だけ、管理者も例外にしない）。CODEOWNERS で設定ファイル・テンプレートの生成物・CI の定義を必須レビューにする |
| 差分の検出 | Admin の階層の割り当てが広がる差分、どの階層でもロールの `permissions` か `tier` が変わる差分を、CI が検出して PR に印を付ける（portal §11.5） |
| 承認の人数 | 利用者の決定は「承認 1 人・レビュー担当は利用者本人」。**利用者本人が書いた PR は本人が承認できない**（GitHub は作成者の承認を数えない）ので、実際には管理者の例外か承認なしのマージになりやすい [推測]。cto の決裁: **段階 1 に限り受け入れる**。本人以外の承認（G-14）は段階 2 の前に足す |
| CI のロール | **段階 1 は検査用（読み取りだけ）のロールだけを作り、適用用は作らない**（配布は手作業。§4.1）。段階 2 以降: GitHub Actions の OIDC で引き受け、信頼ポリシーで `sub` をリポジトリの保護ブランチ（または承認つきの environment）に限る。PR の検査用（読み取りだけ）と適用用を分ける。適用用は `awsbridge-console-*` の StackSet の操作だけを許し、管理アカウントではなく **StackSets の委任管理者のアカウント**に置く [推測: 委任管理者で service-managed の全操作ができるかは N11 で確かめる] |
| 検知 | CI 以外からの StackSet の作成・更新・削除（CloudTrail）を通知する。定期のドリフト検出（portal §11.5） |
| 防止（管理下） | SCP で、`/awsbridge-console/*` のロールとコンソールログイン用のプロバイダーの変更を、StackSets の実行ロール以外に Deny する（N11 で書き方を確かめる） |

**A11（Access の Terraform と適用権限）**

| 対策 | 内容 |
|---|---|
| API トークン | Access のアプリとポリシーの書き込みだけ（Workers・DNS の権限を持たせない）。CI の secret（承認つきの environment）に置き、適用はマージ後の CI だけ。人の手元に置かない |
| state | 置き場所への書き込みを CI に限る。state は秘密を含まないが、AUD とポリシーの ID を含むので private にする |
| 検査 | §4.6 の検査を PR・マージ後・定期に実行する。違えば Worker のデプロイを止める |
| 検知 | Cloudflare の監査ログ（Access のアプリ・ポリシー・IdP の変更）を外部に送り、CI のトークン以外の変更を通知する |
| 段階 3 の前に見直す | Admin の階層の Access アプリを別の Cloudflare アカウント（または別の Terraform の state とトークン）に分けるか |

**A12（AUD → チームの対応）**: 認可の設定として、A10・A11 と同じ保護を掛ける [資料: cto の決裁]

| 対策 | 内容 |
|---|---|
| 変更の保護 | 対応は Terraform の出力から CI だけが生成し、手で書き換えない（会社の下流では手書きの `access.aud` を禁じる。portal G-9 の (d)）。生成物を Worker のバンドルに入れる経路は A10 と同じ保護ブランチ・必須レビュー・承認つきの environment |
| 監査 | 生成物に `generatedAt`・`sourceRevision` を入れ（実装済み）、発行記録に一覧の版を残す（portal §10.3）。対応の差分（チームの追加・AUD の変化）を PR とデプロイの記録に残す |
| 環境間の取り違えの防止 | 開発・本番などの環境ごとに AUD のファイルと生成物を分け、取り違えを検査する（Terraform の出力の AUD が、その環境の Access アプリの AUD と全単射。§4.6）。違えば Worker のデプロイを止める |
| 判定 | `aud` はちょうど 1 つで既知のときだけ発行する。複数・空・未知・曖昧なら発行しない（portal §9.3 の 2）。失敗時は閉じる |

**Access を経由しない入口**（T11）[資料: cto の決裁（1a の前の条件 (2)(3)）・Sol のレビューの指摘 2]

| 対策 | 内容 | 示し方 |
|---|---|---|
| workers.dev・Preview URL | コンソールログイン用の Worker（ポータル・issuer）は `workers_dev: false`・`preview_urls: false` にする | wrangler の設定と、それを確かめる単体テスト。デプロイ後に workers.dev と Preview URL が応答しないことを確かめる |
| ほかの Route | ポータルの Worker に向く Route・Custom Domain は、設定にあるポータルのホストだけ | wrangler の設定のテストと、Cloudflare の API で Route の一覧を取り、設定と一致することを CI で検査する |
| 偽の `Cf-Access-Jwt-Assertion` | 署名の不正・別のチームドメインの JWT・期限切れは 401 | 1a の前の条件 (2) で、Access を経由しない経路から送って発行されないことを試験する |
| 失効済みの JWT の持ち込み | Access で失効させた（期限内の）JWT を、Access を経由しない経路で送る | 上の 2 つで入口がないことを示し、1a の前の条件 (2) で発行されないことを試験する |
| `aud` が複数・未知 | 発行しない（`unknown_audience`） | 単体テスト（1a の前の条件 (3)） |
| 失敗時 | 判定に使う値が読めない・壊れているときは発行しない（fail-closed） | 単体テスト |

**Cloudflare の信頼基盤**（A13〜A16、T12・T13）: DNS・Routes・デプロイ権限は署名鍵と同じ重さの信頼基盤として扱う [資料: Sol のレビューの指摘 3]

| 対策 | 内容 |
|---|---|
| 権限 | DNS・Routes・Custom Domains・Workers のデプロイの権限を持つ人と API トークンを最小にする。Access の Terraform のトークン（A11）にこれらの権限を持たせない |
| 検知 | Cloudflare の監査ログ（DNS・Routes・Custom Domains・Workers のデプロイ・API トークンの作成）を外部に送り、CI 以外の変更を通知する。issuer の discovery と JWKS を定期に取り、期待した鍵（`kid` と公開鍵）と一致することを見張る |
| ビルド | 依存パッケージを固定し（lockfile）、ビルドとデプロイは CI だけで行う。デプロイ用のトークンは承認つきの environment に置く |
| 復旧経路 | Cloudflare アカウントの管理者の email と MFA の復旧手段を、ハードウェアキーと管理された email に限る。復旧の手順を break-glass と一緒に書く |
| Entra 以外のログイン（A17） | 設定するなら次の 3 つを満たす: (1) **フィッシング耐性のある MFA（ハードウェアキー）を必須**にする。ID/パスワードだけ・SMS・TOTP は認めない。(2) そのログインの**使用に気付ける**ようにする（Cloudflare の監査ログの通知。ログインの成功を外部に送り、通知する）。(3) **SSO を強制しているドメインで別のログインがどう扱われるかを、Cloudflare の文書で確かめてから設定する**（強制が別のログインを塞ぐのか、塞がないのか）。確かめる前に設定しない [未検証]。復旧経路（上の行）と合わせて、この入口の資格情報もハードウェアキーと金庫で管理する |
| Admin の分離 | Admin の issuer は別ホスト（方向 I-B。§3.1）にし、管理権限も分ける。Cloudflare アカウントを分けるかは段階 2 のゲート |

**その他（前の上申からの持ち越し）**

- 管理アカウントにはコンソールログイン用ロールを置かない（SCP が効かないため [確認済み: AWS Organizations の文書]）
- Admin のロールの MaxSessionDuration を短くする（cto の決裁 D6）
- 耐フィッシング MFA は Entra の条件付きアクセスで要求する（コンソールログイン用の Access の IdP 連携に専用のアプリ登録を使う案。会社の Entra の運用次第 [推測]）

### 5.5 侵害の種類 × 対策の早見表

| 侵害 | 最初の一手 | 発行済みのセッション | 新しい発行 | 復旧 |
|---|---|---|---|---|
| 利用者 1 人 | Entra で無効化、チームのアプリのトークンを失効（L1。拒否を確かめて完了） | ロールの権限ポリシーに `aws:SourceIdentity` を条件とする明示の Deny（L3-1。測定中）。結果が出るまでは**ロール全体の revoke**（同じロールの全員が切れる） | Access で止まる（拒否を確かめる） | — |
| Worker のバグ | 停止スイッチ（§6.1 の L0） | 影響したロールを revoke | 止まる | 修正して再デプロイ |
| 署名鍵の漏洩・Cloudflare の管理者 | プロバイダーの削除（新規を止める）。Cloudflare の操作に頼らない | 新規を止めてから revoke（解除は §6.3 の条件を満たしてから） | プロバイダーの削除で止まる | 新しい鍵と世代つきの新しいパス（§3.1。同じ URL での作り直しは N5 の結果次第） |
| A10（設定・CI ロール） | CI のロールを無効化（信頼ポリシーの変更）。疑わしい StackSet の操作を止める | 広げられたロールを revoke | 設定を正しい版に戻して再適用 | — |
| A11（Access） | トークンの失効と Access の変更の巻き戻し、チームのアプリのトークンを失効 | 該当チームが入れるロールを revoke | Access が正しく戻れば止まる | — |

### 5.6 発行記録と CloudTrail の突き合わせ

- 自前の JWT の `jti` は CloudTrail に引き継がれない。突き合わせは、発行記録に残す **STS の応答の `AccessKeyId`・`AssumedRoleUser.AssumedRoleId`・要求 ID（RequestId）** で行う（portal §10.3）[資料: cto の決裁（1a の前の条件 (5)）・Sol のレビューの指摘 9]
- 発行記録には Access JWT の `sub` も残す。不変の ID を何にするか（email のままか、`sub` か）は段階 2 のゲートで決める判断材料にする
- 照合: CloudTrail の `AssumeRoleWithWebIdentity` のイベント（`requestID`・`responseElements.credentials.accessKeyId`・`responseElements.assumedRoleUser.assumedRoleId`）を、発行記録の 3 つの値で引く。**発行記録にない引き受け**は、鍵の漏洩か Worker の外からの発行を疑う。その後の API のイベントは `accessKeyId` と SourceIdentity でたどる [推測: CloudTrail のフィールド名は 1a の合格条件の突き合わせで確かめる]
- 1a の合格条件に「発行記録と CloudTrail の突き合わせ」を入れる（§7.3）

---

## 6. 緊急停止と break-glass

### 6.1 停止手段（実測と未検証）

| # | 手段 | 止まるもの | 実測 | 段階 1 で使うか |
|---|---|---|---|---|
| L0 | ポータルの停止スイッチ（Worker の変数。POST を 503 `login_disabled`。portal §10.2） | 新しい発行（鍵が漏れていなければ） | 未測定（Worker の設定の反映） | 使う |
| L1 | Access: チームのポリシーから外す（会社では Entra のグループから外す）→ チームのアプリのトークンを失効（`revoke_tokens`）→ **拒否されたことを確かめて完了**。またはアプリのセッションの期限切れ | その人の新しい発行 | ポリシーの伝播は約 20 秒では足りず、約 2 分 15 秒で反映。失効か期限切れのときに IdP の再ログインなしで判定し直された [確認済み: N10。Google の IdP] | 使う。**固定の待ち時間で完了にしない**（§6.4） |
| L2 | OIDC プロバイダーの削除 | 新しい引き受けだけ（発行済みは使えたまま） | 約 12 秒 [確認済み: P4(b)] | 使う |
| L3 | ロールの Revoke Sessions（`AWSRevokeOlderSessions`） | 発行済みの STS 認証情報・コンソール・`aws login` の更新 | STS と `aws login` は約 8 秒、コンソールは約 1 分以内。`aws login` の更新も拒否され、20 分戻らなかった。**外すと約 17 秒で古い認証情報が復活する** [確認済み: P4(a)] | 使う。**新規の発行を止めてから付け、解除は §6.3 の条件を満たしてから** |
| L3-1 | 1 人だけの停止: ロールの権限ポリシーに、`aws:SourceIdentity` がその人の値のときの明示の Deny（`aws:TokenIssueTime` と組み合わせてもよい） | その人の発行済みと新規のセッション（同じロールのほかの人は止めない） | **測定中**（1a の前の条件 (4)。CloudFormation の更新で消えないかと、止まるまでの時間）[資料: Sol のレビューの指摘 4。管理外のアカウントにも使える] | 結果が出るまでは「**個人の停止 = ロール全体の revoke（L3）**」として運用する |
| L4 | SCP（`/awsbridge-console/*` を `aws:PrincipalArn` で Deny、または `aws:SourceIdentity` で個人を Deny） | 発行済みと新規の両方 | **未検証**（N3。PoC のアカウントは管理アカウントで SCP が効かない） | §6.5 |
| L5 | 鍵の差し替え | — | 同じ URL での作り直しで JWKS のキャッシュが捨てられるかは未検証（N5） | 段階 1 は「止めたまま、世代つきの新しいパスで新しい鍵を用意する」でよい（ReadOnly・非本番） |

- 秒数は 1 アカウント・1 ロールで 1 回測った値。複数アカウントでの所要時間は測っていない（段階 1 の訓練で測る）。**どの手順も、固定の待ち時間ではなく、拒否されたことを確かめて完了にする**
- revoke・Deny・プロバイダーの削除は、CloudFormation の外の変更ならドリフトになる。次の §6.3 のとおり管理する。revoke を付けたままでもスタックの削除は通った [確認済み: P4]

### 6.2 手順（段階 1。鍵の漏洩・Worker の侵害）

1. **新しい発行を止める**: L0。鍵の漏洩が疑われるときは L0 では足りない（鍵があれば Worker なしで署名できる）ので 2 へ進む
2. **新しい引き受けを止める**: 対象のアカウントのプロバイダーを削除（L2）。段階 1 の数アカウントでは手作業かスクリプトでよい。止まったこと（新しい引き受けが拒否されること）を確かめる
3. **発行済みを止める**: 新規の発行が止まったことを確かめて**から**、対象のロールに revoke（L3）。止まったこと（権限の要る API が拒否されること）を確かめる。先に revoke すると、止める前に発行された新しいセッションが revoke の時刻より後になり、止まらない
4. **調べる**: 発行記録と CloudTrail の `AssumeRoleWithWebIdentity` を、STS の応答の `AccessKeyId`・`AssumedRoleId`・RequestId で突き合わせ（§5.6）、発行記録にない引き受けを探す
5. **戻す**: 原因を取り除く → 新しい鍵と世代つきの新しいパスでプロバイダーを作る（§3.1）→ 古い鍵が JWKS とプロバイダーに残っていないことを確かめる → L0 を戻す → §6.3 の解除の条件を満たしてから revoke を外す

利用者 1 人の停止: L1（ポリシーから外す → 失効 → 拒否を確かめる）。発行済みのセッションは、L3-1 の結果が出るまで、**ロール全体の revoke**（同じロールの全員が切れる）で止める。

### 6.3 revoke と Deny の管理と解除の条件

[資料: cto の決裁（1a の前の条件 (4)）・Sol のレビューの指摘 5]

| 項目 | 内容 |
|---|---|
| 付ける順 | **新規の発行を止めてから** revoke を付ける（§6.2 の 2→3） |
| 消えないこと | revoke（`AWSRevokeOlderSessions`）と L3-1 の Deny が、**通常のデプロイ（StackSets の更新）・ロールの作り直し・ドリフトの修復で消えない**ように管理する。CloudFormation が管理しないポリシー名を使い、更新とドリフトの修復で消えないかを 1a の前の条件 (4) で確かめる。消えるなら、テンプレートのパラメーターで持つ形（§6.7）に寄せる |
| 記録 | 付けた時刻・対象・理由を記録し、定期にロールのインラインポリシーの一覧を取って、付いたままのものを見張る |
| 解除の条件 | 時間（最長のセッション + 余裕）が過ぎたことだけでは外さない。**原因の除去**（漏れた鍵・侵害された経路の排除）、**古い鍵の排除**（JWKS・プロバイダーに古い鍵が残っていない）、**新規の発行ができないことの確認**（止めた経路で新しいセッションが作れない）の 3 つを満たしてから外す。外したあと、古い認証情報が復活しない（拒否される）ことを確かめる |
| **ロールの置換** | revoke や `aws:SourceIdentity` の Deny を CloudFormation の外で付けている間は、**ロールの置換を伴う更新（`Path`・`RoleName` の変更など）をしない**。**ドリフトの自動修復もしない**。開発環境の実測（2026-11-11）では、その場での更新 2 回ではインラインポリシーは残ったが、ロールの置換では消える（CloudFormation の `AWS::IAM::Role` の仕様。置換は実測していない）。1a の配布後にロールの名前とパスを変えないという条件（§3.3）と同じ理由。付けている間にやむを得ず置換するときは、置換のあとにポリシーが残っているかを確かめ、消えていたら付け直す |
| 注意 | `getSigninToken` の成功は、コンソールのセッションが 12 時間続くことの証明ではない（N2）。revoke の期間はロールの `MaxSessionDuration` から決める |

### 6.4 チームのアプリのセッションの長さ（推奨）

所属を外した人がポータルから発行できる最長の時間は、おおよそ「Entra の反映 + Access のポリシーの伝播 + **チームのアプリのセッションの長さ**（失効を忘れた・失効が効かなかったとき）」になる。時計は 5 つある（Entra の反映、Access の再評価、Access JWT の期限・失効、自前の JWT の期限、STS・コンソール・CLI の有効期間）[資料: Sol のレビューの指摘 7]。

| 項目 | 推奨 | 根拠 |
|---|---|---|
| チームのアプリ（Standard） | **15 分** | PoC で、15 分のセッションの期限切れのあと IdP の再ログインなしにポリシーで判定し直され、拒否された [確認済み: N10 の (b)]。グローバルのセッション（IdP のログイン）が残っていれば利用者に再ログインは出ないので、短くしても使い勝手は落ちにくい。5 分は試していない [未検証] |
| 入口のアプリ | チームのアプリと同じか長め（入口では発行しない） | [推測] |
| Admin の階層のチーム（段階 3） | Standard より短く（例 5〜15 分。PIM と合わせて段階 3 で決める） | [推測] |
| 発行済みのセッション | アプリのセッションでは止まらない。ロールの `MaxSessionDuration` まで残る。止めるには L3（L3-1） | P4(a) |

- L1 の手順は「外す → 失効 → 拒否を確かめる」とし、上の時間は**失効を忘れたときの上限の目安**として使う。2 分 15 秒（伝播）は 1 回の測定で、保証値にしない
- Entra では、直接のメンバー・入れ子のグループ・アカウントの無効化・IdP のセッションが残っている場合の拒否を、1a の合格条件で確かめる（§7.3）

### 6.5 SCP の扱い

SCP（L4）は段階 2 のゲート（N3）で確かめる予定だが、段階 1 の対象は管理下の Organization のメンバーアカウントなので、そこで試せる。

- 案 S-a: 段階 1 の停止の訓練で、停止用の SCP（§3.5 の名前）を 1 つのアカウントに付けて、所要時間と `aws login` の更新の拒否を測る（N3 の一部を段階 1 で行う）。SCP の作成と付与は人の承認が要る
- 案 S-b: 段階 1 は L0〜L3 だけで組み、SCP は段階 2 の前の N3 で別に確かめる

作成者の案は S-a。cto の決裁は 1a の合格条件の停止の訓練を「L0〜L3 と解除」としたので、SCP を 1a に含めるかは未決（§9.2）。

### 6.6 Entra を通らない停止の経路

Entra（と Cloudflare・CI）が使えないときにも、発行の停止・プロバイダーの削除・revoke・ログの確認ができる経路が要る。段階 3 まで待たず、段階 1 の条件にする（既存の非常用の経路の流用でもよい）[資料: cto の決裁・Sol のレビューの指摘 6]。

cto の決裁: **E1 か E0 のどちらかを利用者が選ぶ**。**利用者は E0 を選んだ**（2026-11-11）。「**段階 1 では、Entra を通らない停止経路が無いことを受け入れる**」と明示した。

| 案 | 内容 | 条件 |
|---|---|---|
| E1 減らす側だけの受け口ロール | 停止専用の入口から、各アカウントの受け口ロールに入って次だけを行う: (1) 固定の Deny 管理ポリシーを `/awsbridge-console/` 配下のロールに attach する（`iam:AttachRolePolicy` を `iam:PolicyARN` の条件でその管理ポリシーに限る）、(2) コンソールログイン用の OIDC プロバイダーの削除、(3) 最小の読み取り。**`PutRolePolicy`・`DeleteRolePolicy`・`DetachRolePolicy`・StackSets の操作は入れない**（停止を外す・広げる操作を持たせない）。受け口ロール自体は `/awsbridge-console/` の**外**に置く（自分を止める Deny の対象にしない）。MFA 必須、使用を通知する | 開発用アカウントで 3 点を確かめることが採用の条件 |
| E0 経路を持たずに始める | 段階 1 に限り、Entra の障害・侵害時は復旧まで止められないことを、利用者が受容を明示する | 段階 1 に限る |

**E0 の受容の範囲と中身**（人の承認。利用者の明示: 2026-11-11）

- 範囲は**段階 1（1a・1b）に限る**。**段階 2 では失効する**。段階 2 に進むには、Entra を通らない停止経路を用意し、実際に 1 回操作して確かめる（§6.7・§7.4・§9.2 U-1）
- 受容の中身: Entra の障害・侵害のときは、復旧まで止められない経路がある。**Cloudflare のダッシュボードに Entra を通らないログインが設定されるまでは、L0・L1 も Entra に依存する**（L0 は Cloudflare の Worker の設定、L1 は Access のポリシーと Entra のグループの操作で、どちらも Cloudflare のダッシュボードまたは Entra を通る）。L2・L3 は各アカウントの IAM の操作なので、AWS 側に別の入口（管理者のログイン）があれば Entra に依存しない。ただし管理アカウントのルートの認証情報の保持者は未回答（§9.2 U-10）
- 利用者の確認（2026-11-11）: 受容には、Cloudflare に Entra 以外のログインを設定するまで L0・L1 も Entra の障害・侵害時に使えないことも含まれる
- API トークンでの L0（wrangler）が Entra を通らない可能性は未確認。確かめれば、E0 の実際の欠落が「L0 も不可」か「L2・L3 だけ不可」かが分かる（§9.2 U-11）
- Cloudflare のダッシュボードに Entra 以外のログインを設定するなら、新しい入口になる。資産と条件は §5.1 の A17 と §5.4
- 1 人の停止（L3-1）と、E1 の固定の Deny 管理ポリシーは別物。E1 の Deny はロール全体を止める

### 6.7 段階 2 の前に決めること

- **Entra を通らない停止経路（段階 2 のゲートの必須条件）**: E0 の受容は段階 1 に限る（§6.6）。段階 2 のゲートまでに、Entra を通らない停止経路（E1 の直した形など）を用意し、**実際に 1 回操作して確かめる**。E1 の元の案は開発用アカウントで 3 点を確かめることが条件（§6.6 の表）。1a・1b の合格条件には含めない
- 全アカウントへの停止の一括配布（テンプレートに停止の印を持たせ、StackSets でプロバイダーの削除と revoke を一度に配る案）。所要時間は N8 で測る [推測: 設計の案]
- revoke をテンプレート（`aws:TokenIssueTime` の Deny をパラメーターで付ける）で持つか、CFN の外の操作にするか（1a の前の条件 (4) の結果で決める）

### 6.8 break-glass

| 選択肢 | 内容 | 段階 1 |
|---|---|---|
| B1 既存の Identity Center（Entra に直結。管理下） | **消さない**。コンソールログイン用の仕組みは追加の入口として入れる | ログインの代わりにはこれで足りる（段階 1 は ReadOnly・非本番で、IC は並行して残る）。ただし Entra を通るので、停止の経路にはならない（§6.6） |
| B2 Organization ごとの break-glass の IAM ユーザー（管理アカウント、ハードウェアキー、金庫、使ったら通知） | IdP（Entra）の障害にも備える | 段階 3（Admin）の前に整える。作るかは人の承認 |
| B4 管理外 | 先方自身の入口。自社が先方に入る break-glass は持たない | 段階 4 |

- break-glass の手順はポータルの外に置き、ポータルにはリンクだけを置く（portal §10.2）
- 採否は人の承認（cto の決裁 D7）

---

## 7. 段階 1 の範囲・開始条件・合格条件（1a / 1b）

cto の決裁で、段階 1 を **1a**（会社環境で運用者だけ・1 アカウント）と **1b**（試行者・5 アカウント以下）に分けた。1a は §7.2 の条件を満たし人の承認が出れば、再上申なしで始めてよい [資料: cto の決裁]。

### 7.1 範囲

| 項目 | 1a | 1b |
|---|---|---|
| Organization | 管理下の 1 つ（会社環境） | 同じ |
| アカウント | 非本番の **1 アカウント**。管理アカウントは含めない | 非本番の **5 アカウント以下**。管理アカウントは含めない |
| 利用者 | **運用者だけ** | 少人数の試行者。チームは 1〜3 |
| ロール | ReadOnly だけ（Standard の階層。中身は §4.7） | 同じ |
| デプロイ | Standard の Worker だけ。Admin のデプロイ・issuer・プロバイダーは作らない | 同じ |
| issuer と鍵 | 管理下の境界の Standard（`https://<issuer-host>/std`）、Workers secret の鍵 1 本 | 同じ |
| 配り方 | 基盤 + 種類のスタックを**運用者が手作業で**配る。**CI に StackSets の適用権限を持たせない**（CI は検査だけ。§4.1）。基盤（OIDC プロバイダー）も対象のアカウントだけに配る | 同じ（対象の数アカウントだけ。自動デプロイは使わない） |
| 承認 | 承認 1 人（レビュー担当は利用者本人）を段階 1 に限り受け入れる（G-14） | 同じ |
| 既存の入口 | Identity Center はそのまま残す | 同じ |

### 7.2 1a の開始条件

次をすべて満たし、人の承認が出たら始めてよい。

**cto の条件（3-B）**: §1.1 の条件を満たす。

**開発環境で確かめること**（cto の決裁の「1a の前の条件」。開発環境で確かめる）:

| # | 確かめること | 合格の基準 | 不成立のとき |
|---|---|---|---|
| (1) | localhost だけのポリシー（§4.4 の (1)）で、同じ端末の `aws login` が通り、`--remote` が拒否される | どちらも期待どおり | 段階 1 は `aws login` を案内しない（コンソールだけで運用する） |
| (2) | コンソールログイン用の Worker の workers.dev・Preview URL を無効にし、ほかの Route がないことを設定とテストで示す。Access を経由しない経路への、偽の `Cf-Access-Jwt-Assertion` と失効済み JWT の持ち込みで発行されない | 応答しない、または 401。どの経路でも発行されない | 段階 1 を始めない |
| (3) | `aud` が複数・未知なら発行しない。失敗時は閉じる | 単体テストが通る（portal §9.3 の 2） | 段階 1 を始めない |
| (4) | revoke と `aws:SourceIdentity` の Deny が、CloudFormation の更新（通常のデプロイ・ロールの作り直し・ドリフトの修復）で消えないか。1 人の停止（L3-1）までの時間 | 消えない（または消えない管理の形が決まる）。所要時間を記録する | 1 人の停止は「ロール全体の revoke」で運用する（§6.1）。消えるなら §6.3 の管理を見直す |
| (5) | 設計書の改訂（発行記録は `AccessKeyId`・`AssumedRoleId`・RequestId で突き合わせる、AUD → チームは認可の設定として保護する、段階 1 の ReadOnly の中身、チームのアプリのセッションの長さ、L1 は拒否を確かめて完了） | この文書（§5.1 の A12・§5.4・§5.6・§4.7・§6.4・§6.1）と portal §9.3・§10.3 に反映した | — |
| (6) | 段階 1 では CI に StackSets の適用権限を持たせない（手作業で配る、CI は検査だけ） | 下流の CI のロールが検査用だけであること | 段階 1 を始めない |

**人の承認**: 会社のセキュリティ承認（人のアクセスに Worker の鍵を使うこと）、会社の Entra と Access の変更（チームのグループ・アプリ）、対象の Organization での StackSets（スタック）の作成（と案 S-a なら SCP）。Entra を通らない停止の経路は、利用者が **E0 を選び、段階 1 では経路が無いことを受け入れると明示した**（2026-11-11。範囲は段階 1 に限り、段階 2 では失効する。§6.6）。

**下流で確定**: ポータルのホスト・issuer のホスト（§3.1）・チームと ReadOnly のロールの設定。

### 7.3 1a の合格条件

| # | 確かめること | 合格の基準 |
|---|---|---|
| 1a-1 | 会社の Entra のグループ（Object ID）で M2: チームのアプリごとに AUD が分かれ、所属していないチームで拒否され、アプリ間で再ログインが要らない | 開発環境の M2 と同じ結果（portal PoC の判定基準） |
| 1a-2 | Entra で外したときの拒否: **直接のメンバー・入れ子のグループ・アカウントの無効化・IdP のセッションが残っている場合**のそれぞれで、L1 の手順（外す → 失効 → 拒否を確かめる）で拒否される | どれも拒否される。所要時間を記録し、§6.4 のセッションの長さを見直す |
| 1a-3 | 停止の訓練: L0〜L3 と、その解除（§6.3 の条件で）。Entra を通らない経路は E0 で持たない（§6.6）ので、その経路からの操作は条件に含めない（段階 2 のゲートの条件。§6.7） | 新規と発行済みが止まり、解除のあとに古い認証情報が復活しない |
| 1a-4 | 発行記録と CloudTrail の突き合わせ（§5.6） | すべての引き受けに発行記録があり、STS の応答の ID で一意に対応する |

合格しなければ 1b に進まない。

### 7.4 1b の開始条件と合格条件

| 項目 | 内容 |
|---|---|
| 開始条件 | 1a の合格。人の承認（**1b の試行者と対象のアカウント**）[資料: cto の決裁]。1a の結果の cto への報告 [推測: 1b の前に再上申が要るかは決裁に明記がない。§9.2] |
| 合格条件（作成者の案） | [推測: cto の決裁に 1b の合格条件の細部はない。§9.2 で確認する] 2 週間ほど運用し、次を済ませる: L1（Entra のグループから外す）と L2 + L3 の訓練を対象のアカウントで 1 回ずつ、発行記録と CloudTrail の突き合わせ、下流の CI の検査（設定・Access ポリシーの形・AUD の対応・ドリフト）が動いていること、`unknown_audience`・`team_mismatch`・`forbidden_origin`・`csrf_failed` が出ていない（出たら原因が分かっている）こと |
| 次へ | 結果を cto に報告し、段階 2 のゲート（N3・N8・N11・N12、不変の ID、代替案の比較の訂正、Cloudflare アカウントの分離、本人以外の承認、**Entra を通らない停止経路を用意して実際に 1 回操作して確かめること**、管理アカウントのルートの認証情報の保持者の確定）に進む |

---

## 8. 未検証のまま段階 1 に入るもの

| 項目 | 内容 | 段階 1 での扱い |
|---|---|---|
| N1 の残り（会社の Entra） | Entra のグループ（Object ID）での M2、App Launcher の表示、Cookie Path の切り替え | 1a-1 で最初に確かめる。合格しなければ止める |
| N10 の残り | Entra のグループから外したときの反映（直接・入れ子・無効化・IdP のセッション残り） | 1a-2。結果で §6.4 を見直す |
| P-2 | 同じ端末の `aws login`、localhost だけのポリシーでの `--remote` の拒否 | 1a の前の条件 (1)（開発環境）。通らなければ `aws login` の案内を出さない |
| L3-1 | `aws:SourceIdentity` の Deny による 1 人の停止 | 1a の前の条件 (4)。結果が出るまでは「個人の停止 = ロール全体の revoke」 |
| N3 SCP | ロールのパス・SourceIdentity での Deny、伝播時間 | §6.5 の S-a / S-b（未決）。段階 2 のゲート |
| N12 チェーン | コンソールログイン用のセッションから既存のロールへのチェーン（チェーン先に `sts:SetSourceIdentity` が要る） | 段階 1 は `sts:AssumeRole` を明示の Deny で禁じる（§4.7）。段階 2 のゲート |
| N2 12 時間 | コンソールのセッションが実際に 12 時間続くか | ReadOnly の `sessionSeconds` は下流の設定。続かなくても入り直すだけ |
| N5 JWKS のキャッシュ | 同じ URL でプロバイダーを作り直したときに、STS が新しい鍵を読むか | 鍵の差し替えは「止めたまま、世代つきの新しいパス」でよい（§6.1 の L5）。段階 3 のゲート |
| N4 | コンソール操作のイベントの SourceIdentity | 段階 1 の CloudTrail で見る |
| N8・N11 | 停止の一括配布・StackSets の運用（委任管理者・OU の移動・ドリフトの防止） | 段階 1 は手作業で配る。段階 2 のゲート |
| Admin の issuer（方向 I-B） | 階層ごとのホスト | 段階 1 は Standard だけなので要らない。確定は段階 3 |
| P-1・P-3・P-4 | マルチセッション、`Issuer` への戻り、POST での受け渡し | ポータルの使い勝手。段階 1 は T1（302）で、案内を出す（portal §6） |

---

## 9. 段階 1 のゲートの決裁と未決事項

### 9.1 決まったこと

| # | 論点 | 決定 [資料: cto の決裁] | 反映 |
|---|---|---|---|
| G-5 | 変えにくい名前（issuer の URL・audience・ロールのパス・タグ・RoleSessionName） | §3 の冒頭の表のとおり確定 | §3 |
| G-8 | issuer のホストをポータルと分けること、Admin の issuer の形 | Standard は専用ホストの `https://<issuer-host>/std`。Admin は方向 I-B（階層ごとのホスト）、確定は段階 3 | §3.1 |
| G-10 | ロールのパスを階層で分けるか | P-2 `/awsbridge-console/<tier>/` | 実装済み（`rolePath`）。§3.3 |
| G-11 | audience を上流の定数にすること | 定数 `awsbridge-console` 1 つ | 実装済み（`AUDIENCE`。`stacksets.json` の `audience`）。§3.2 |
| G-13 | Cloudflare アカウント | 段階 1 は既存。分離は段階 2 のゲート | §2.2 |
| G-14 | 承認 1 人 | 段階 1 に限り受け入れる。本人以外の承認は段階 2 の前 | §5.4 |
| 段階 1 の分割 | 1a / 1b | §7 のとおり | §7 |
| CI の権限 | 段階 1 は CI に StackSets の適用権限を持たせない | 手作業で配り、CI は検査だけ | §4.1・§5.4 |
| 不変の ID | 段階 2 のゲートで決める | 段階 1 は email。信頼ポリシーに形の条件を足さず、発行記録に Access の `sub` を残す | §3.4・§5.6 |

Sol のレビューの指摘の反映（決裁ではない。採ったものだけ）:

| Sol の指摘 | 反映 |
|---|---|
| 1 CI の侵害範囲と段階 1 の範囲 | 段階 1 は CI に適用権限を持たせない（§4.1・§5.4） |
| 2 Access を経由しない入口・失効・`aud` の扱い・AUD → チームの保護 | T11・A12 と対策（§5.1・§5.3・§5.4）、portal §9.3 |
| 3 DNS・Routes・デプロイ権限・JWKS・復旧経路 | A13〜A16・T12・T13（§5.1・§5.3・§5.4）、A2 の拡張、Admin の issuer は別ホストの方向（§3.1） |
| 4 1 人の停止（`aws:SourceIdentity` の Deny）とロールチェーンの禁止 | L3-1（§6.1）、`sts:AssumeRole` の明示の Deny（§4.7） |
| 5 revoke の付け方と解除の条件 | §6.2・§6.3 |
| 6 Entra から独立した停止の経路 | §6.6（利用者が E0 を選んだ。段階 1 に限る。段階 2 のゲートの必須条件は §6.7） |
| 7 所属変更の時計と「拒否を確かめる」手順 | L1（§6.1）・§6.4・1a-2 |
| 8 代替案の比較の偏り | 段階 2 のゲートの宿題（§9.2） |
| 9 不変の ID・`jti` は CloudTrail に残らない | §3.4・§5.6、portal §10.3 |
| 10 ReadOnly は安全な上限とは限らない | §4.7 |
| 11 `aws login` のリフレッシュトークン・共有端末 | A7・T5（§5.1・§5.3） |
| 12 名前（共通 audience・tier は権限を保証しない・世代つきの issuer・レート制限） | §3.1・§3.2・§3.3、T14 と §9.2 |

### 9.2 未決事項

| # | 論点 | 決める人・時機 | 現状 |
|---|---|---|---|
| U-1 | Entra を通らない停止の経路: E1（減らす側だけの受け口ロール）か E0（段階 1 に限り受容） | **決定済み（E0。利用者、2026-11-11）**。段階 1 に限り、経路が無いことを受け入れる。段階 2 では失効する | §6.6。段階 2 のゲートの必須条件: Entra を通らない停止経路（E1 の直した形など）を用意し、実際に 1 回操作して確かめる（§6.7）。E1 を採るなら開発用アカウントで 3 点を確かめる |
| U-2 | 代替案の比較の訂正（案 1 + 横断ランチャーは IC を繋がなくても成り立つ、案 2 は 500 件から選ぶ形が必須ではない、案 6 の「SourceIdentity を必須にできない」が IC 起点の制約か一般の制約か、ランチャー案と混成案の小さな実測） | 段階 2 のゲートの宿題 | 未着手 [資料: cto の決裁・Sol のレビューの指摘 8] |
| U-3 | 不変の ID（email のままか、Access の `sub` などにするか）。SourceIdentity と RoleSessionName の形 | 段階 2 のゲート | 段階 1 は email。発行記録に `sub` を残す |
| U-4 | 発行 API のレート制限とコストの枯渇（利用者ごと・全体の上限の値、STS のスロットリングの扱い、Workers・Logpush の費用の見張りと上限の通知） | 段階 1b の前に値を決める [推測] | 利用者ごとの制限（429 `rate_limited`）だけを設計した（portal §9.3 の 6）。値は未定 |
| U-5 | SCP を段階 1 の訓練で試すか（S-a / S-b） | cto | §6.5。1a の合格条件の訓練は L0〜L3 と解除 |
| U-6 | 1b の合格条件の細部と、1b の前に cto への再上申が要るか | cto | §7.4 は作成者の案 |
| U-7 | Cloudflare アカウントの分離 | 段階 2 のゲート | 段階 1 は既存 |
| U-8 | 本人以外の承認（G-14） | 段階 2 の前 | 段階 1 は承認 1 人 |
| U-9 | portal §12.2 の残りの論点（G-1〜G-4・G-6・G-7・G-9） | portal §12.2 のとおり | — |
| U-10 | 管理アカウントのルートの認証情報の保持者（誰が持ち、どこに保管し、使ったことをどう通知するか） | 利用者。段階 2 のゲートまで | **未回答**。停止経路（§6.6）と break-glass（§6.8 の B2）に関わる |
| U-11 | API トークンでの L0（wrangler）が Entra を通るか | 利用者。確かめられる時機に | **未確認**。Entra を通らない可能性がある。確かめれば、E0 の実際の欠落が「L0 も不可」か「L2・L3 だけ不可」かが分かる（§6.6） |
| U-12 | Cloudflare のダッシュボードの Entra 以外のログイン（ID/パスワード/パスキー。利用者が今後設定する予定）の設定前の確認 | 利用者。設定の前 | 設定するなら §5.4 の条件を満たす。SSO を強制しているドメインで別のログインがどう扱われるかを、Cloudflare の文書で確かめてから設定する 利用者は §5.4 の 3 条件に同意し、セキュリティ例外には当たらないと判断した（2026-11-11） |

## 参考

- AWS: AWS Sign-In の管理ポリシー（`SignInLocalDevelopmentAccess` と、`localhost` / `remote` のリソース ARN）: https://docs.aws.amazon.com/signin/latest/userguide/security-iam-awsmanpol.html
- AWS: AWS Sign-In の条件キー（`signin:OAuthRedirectUri` など）: https://docs.aws.amazon.com/signin/latest/userguide/reference-signin-condition-keys.html
- AWS: SourceIdentity（`sts:SetSourceIdentity` がないロールへの引き受けは失敗する、長さと文字種、SourceIdentity 必須のロールにはコンソールの Switch Role で入れない）: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html
- AWS: SCP は管理アカウントに効かない: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html
- AWS: StackSets の自動デプロイ（OU 間の移動・子 OU・上書き・依存）: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-manage-auto-deployment.html
