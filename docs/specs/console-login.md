# コンソールログイン: 全体設計

- 作成日: 2026-11-11
- 改訂: 2026-11-11 段階 1 のゲートの cto の決裁（条件付き承認）と、Sol のレビューのうち採った指摘を反映した。名前を「human」から「console」に改めた（audience・ロールのパス・RoleSessionName・StackSet と SCP の名前・ファイル・タスク・環境変数）。PoC（`scripts/poc/human/`）の名前と記録は変えていない
- 改訂: 2026-11 設定例のロール名を `Federated*`（`FederatedViewer` / `FederatedDeveloper` / `FederatedAdministrator`）に、MCP 用ロールの既定名を `FederatedMcpViewer` / `FederatedMcpDebugger` に改めた。MCP 用ロールとの関係（§2.3 の決裁 S2）を書き足した
- 改訂: 2026-11-12 cto の決裁と利用者の判断を反映した。(1) 人のロールは Viewer（Standard）と Administrator（Admin）の 2 つにし、Developer と人の Debugger を廃止した。設定例のロール名は `FederatedAwsBridgeViewer` / `FederatedAwsBridgeAdministrator`（§2.3・§3.3）。(2) `aws login --remote` は Standard（Viewer）で許し、Administrator は同じ端末だけにした。1a の前の条件 (1) を「同じ端末と `--remote` の両方が Viewer で通る」に書き直し、開発環境の再試験で成立した（§4.4・§7.2）。(3) SCP に頼らず、守りはロールとプロバイダーのスタックだけで成り立たせる。SCP は管理下のメンバーアカウントでの追加の層にし、L4・N3 を任意に下げた（§4.8・§6.5）。(4) どのグループにどのロールを渡すかは設定ファイルに任せ、ロールの CloudFormation は参考の形にした。必須はプロバイダーのスタックと守りの部品（§4.8）。(5) 段階 1 の SourceIdentity は email のまま、不透明な識別子として扱う（§3.4）。発行記録・停止の手順に email の間の運用を足した（§5.6・§6.3）。(6) 測定済みの項目（L3-1、1a の前の条件 (2)・(4)）の状態を直した。Sol のレビュー（2026-11-12）のうち採った指摘を入れた（§4.8・§4.9）
- 改訂: 2026-11-12 同じ日の残りの決裁を反映した。(1) 入口と一覧を Standard と Admin で共通にし、署名の権限（Worker・issuer・鍵）と発行のオリジンは分けたままにする（P1'。§2.2・§3.1）。P1・P2 は段階 3 で再上申できる、P3（MCP とコンソールのプロバイダーを 1 つ）は却下（§2.3）。Admin の issuer は「発行のオリジンを分ける」形に具体化し、issuer のホストは Standard と同じホストの `/admin` でもよい（確定は段階 3。§3.1）。(2) チームを選ばせず、所属する全チームの行を 1 つの一覧に出す（U2）。表示のためだけに Entra グループの Object ID → チームの対応を Worker に持たせてよい（D5 は保つ。§2.1）。会社の Entra での実証を 1a-1・1a-2 に足した（§7.3）。(3) F2・M2-MCP の決裁への利用者の回答を記録した（§2.3）。(4) App Launcher は使わない（§8）。(5) MCP 用 Debugger は「割り当ては設定で決める」とだけ書き、決裁にない目安を外した（§2.3）
- 改訂: 2026-11-12 同じ日の残りの決裁を反映した。(1) **会社の Entra でも SourceIdentity は email**（U-3 を閉じた。§3.4）。停止は過去の email（改名の履歴）も全部 Deny、監査の人の特定は発行記録と Entra の記録を合わせる、会社に入る前に email の再利用を確かめる（§5.6・§6.2・§6.3）。受容の文面を記録した（§6.3）。(2) **段階導入（D8）を「① 完成 → ② 個人で導入・試験 → ③ 会社に導入」に書き直した**。ゲートは G1〜G5（§7）。旧い段階（1a・1b・段階 2・段階 3）の名前で書いた条件を、決裁の「旧条件の行き先」どおりに付け替えた（§7.7）。D4 を言い直した（§2.2）。U-13 は置き換えで閉じた。(3) G1 の資料として Admin 側の発行の設計書（[console-login-admin.md](console-login-admin.md)）を足した
- 状態: 設計案。段階導入は「① 完成 → ② 個人で導入・試験 → ③ 会社に導入」（cto の決裁 2026-11-12。§7）。いまは **① の実装の前のゲート G1**（Admin 側の発行の設計と N6 の PoC。[console-login-admin.md](console-login-admin.md)）の準備中。実装済みは設定のスキーマ・検証・生成だけ（`src/console/`）。そのほかの内容はまだ実装していない。前の版の「段階 1 のゲート（1a・1b）」の承認と条件は §1・§7.2・§7.3 に残した（行き先は §7.7）
- 対象: awsbridge 方式（自前の OIDC issuer → 各アカウントの IAM OIDC プロバイダー → `AssumeRoleWithWebIdentity`）による、人が使う AWS コンソールと `aws login` へのログイン（この仕組みを「コンソールログイン」と呼ぶ）
- 関連:
  - [console-login-portal.md](console-login-portal.md): ポータル（画面・エンドポイント・CSRF・設定ファイル）の詳細設計。この文書は、ポータルの外側（issuer・鍵・テンプレート・脅威モデル・停止・段階）を受け持つ
  - [console-login-admin.md](console-login-admin.md): Admin 側の発行（KMS の署名・Worker が KMS を呼ぶ認証情報・別の Worker と発行のオリジン・鍵の差し替え）の設計。G1 の資料
  - [architecture.md](architecture.md): MCP 用の構成。コンソールログイン用はこれと分ける（§2.3）
  - [scripts/poc/human/README.md](../../scripts/poc/human/README.md)（PoC-A/B・P2〜P4）と [scripts/poc/human/portal/README.md](../../scripts/poc/human/portal/README.md)（N9・M2・N10）: PoC の手順と結果（PoC の名前は改名前の `human` のまま）
- 「cto の決裁」は、このリポジトリの外にある技術決裁を指す。この文書に効く条件は §1 にまとめた。「Sol のレビュー」は段階 1 のゲートで取った外部レビュー（決裁ではない）を指し、採った指摘だけをこの文書に入れた
- 表記: **[確認済み]** PoC で観測したもの・一次資料で確かめたもの、**[資料]** 設計文書と cto の決裁にあるもの、**[推測]** 作成者の推論、**[未検証]** まだ試していないもの・調べて分からなかったもの
- 実測値の但し書き: PoC の秒数は、開発環境（IdP は Google、AWS は開発用アカウント 1 つ、利用者 1 人）で**1 回ずつ測った値**である。会社の環境（Entra ID）と複数アカウントでの値は測っていない。**保証値として使わない**（手順は固定の待ち時間ではなく「拒否を確かめて完了」にする。§6）
- 値の表記: 実ドメインは `<domain>`、issuer のホストは `<issuer-host>`、アカウント ID は `<account-id>`、利用者は `<email>` と書く。この文書に実際の値は書かない（awsbridge は public リポジトリ）
- 用語: 「**コンソールログイン**」はこの仕組みの名前で、AWS コンソールへのログインと `aws login`（CLI）の両方を含む。単に「コンソール」と書くときは AWS マネジメントコンソールを指す。「**階層**」（tier）は Standard / Admin（発行する Worker・issuer・鍵の分かれ目。**権限の強さは保証しない**。§3.3）。「**ロール**」は設定の `roles[]`（参考の形は Viewer・Administrator の 2 つ）。「**境界**」は信頼の境界（管理下 `managed` / 管理外の先方 `partner:<id>`）

## 目次

1. cto の条件とゲートの対応（ギャップ分析）
2. 全体構成
3. 配布後に変えにくい名前
4. CloudFormation / StackSets のテンプレート
5. 脅威モデル
6. 緊急停止と break-glass
7. 段階導入: ① 完成 → ② 個人で導入・試験 → ③ 会社に導入（G1〜G5）
8. 未検証の項目と確かめる時機
9. 決裁と未決事項

---

## 1. cto の条件とゲートの対応（ギャップ分析）

### 1.1 条件（3-B）

| # | cto の条件 | 状態 | どこに書いたか・実装 | 残り |
|---|---|---|---|---|
| 1 | Worker は検証した Access JWT の AUD だけからチームを決め、未知の AUD には発行しない。AUD → チームの対応の作り方と、Access ポリシーの形を CI で検査する | 設計済み。対応の生成と突き合わせは実装済み | 判定: portal §3.1・§9.3 の 2・§9.4（`unknown_audience`・`team_mismatch`。`aud` が複数・未知・曖昧なら発行しない）。対応の生成: portal §11.4（Terraform の出力 → `AWSBRIDGE_CONSOLE_AUD_FILE` → 生成物）。突き合わせ: `src/console/generate.ts`（AUD の欠落・食い違い・重複、設定にないチーム）。検査の順: portal §11.5。ポリシーの形の検査の定義: この文書 §4.6。AUD → チームの対応は**認可の設定**として保護する（§5.1 の A12） | ポリシーの形の検査は下流の CI で、まだない（上流は `access.json` と検査の定義を渡す）。Worker 側の判定（`aud` が複数・未知なら発行しない単体テストを含む）はポータル本体と一緒に実装する |
| 2 | 脅威モデルに「種類の定義を置く private リポジトリと StackSets 更新用の CI ロール」「Access の Terraform と適用権限」の 2 つの資産を足す | この文書で追加 | §5.1 の A10・A11、§5.3 の T9・T10、§5.4 | 承認 1 人は G5 の前まで受け入れる（前の決裁では「段階 1 に限り」。§9.1 の G-14、行き先は §7.7） |
| 3 | 配布後に変えにくい名前（issuer の URL・audience・ロールのパス・タグ）を段階 1 の前に確定する（当時の条件） | **確定**（cto の決裁。§3） | §3。audience の定数とロールのパス（P-2）は実装済み（`src/console/config.ts` の `AUDIENCE`・`ROLE_PATH_PREFIX`・`rolePath`） | Admin の issuer の形（方向 I-B）は G1 で審議する（[console-login-admin.md](console-login-admin.md)） |
| 4 | `transitive_tag_keys` を設定しない | 方針は portal §0 にあった。JWT の形とテンプレートに書いた | §3.4・§4.3 | 実装（ポータル本体の署名部分）で単体テストにする |
| 5 | `aws login --remote` を既定で許さない方向 | **改めた**（cto の決裁 2026-11-12）: Standard（Viewer）は同じ端末と `--remote` の両方を許す。Administrator は同じ端末だけで、`--remote` は Admin の階層の守りの部品の明示の Deny で拒否する | §4.4 | Viewer で両方が通ることは 1a の前の条件 (1)（書き直し版）で成立。Administrator で `--remote` が拒否されることは N2（① の PoC、G2） |
| 6 | architecture.md の IdP の記述（83 行目付近）を直す | 済み | architecture.md「IdP について」（Access の JWT だけを見る形に直した。コミット `1bcf1bd`） | なし |
| 7 | 利用者への暫定案（名前で照合）を訂正する | このリポジトリからは確かめられない | 文書は M2（Access ポリシーが Object ID で所属を判定）に一本化した。名前の照合は却下と書いた（portal §0・§12.4、この文書 §2.1） | 利用者への訂正の連絡が済んだかは、上申者が確かめる |

### 1.2 段階 1 の前のゲート（3-C。前の段階の定義のときの記録）

| ゲート | 状態 | 根拠 |
|---|---|---|
| N9 パス付き issuer | 成立（開発環境） | 1 つのホストの `/std` と `/admin` を別の OIDC プロバイダーに登録でき、階層をまたぐ引き受けは AccessDenied、issuer の末尾スラッシュ違いは InvalidIdentityToken（完全一致）[確認済み: portal PoC の README]。PoC は 1 つの Worker が両方のパスを出した。Admin の issuer は方向 I-B（2026-11-12 に「分けるのは発行のオリジン。issuer は同じホストの `/admin` でもよい」と具体化。§3.1）。形は G1 で審議する |
| N1 の M2（パスごとに AUD が分かれるか） | 成立（開発環境・Google の IdP） | 入口・`/t/infra`・`/t/dev` の `aud` が別。`/t/infrastructure` は前方一致にならない。片方のアプリから外すとそのパスだけ拒否 [確認済み: 同じ README]。**会社の Entra のグループ（Object ID）での確認は 1a-1**（§7.3。行き先は G4） |
| N10 Access + Worker の通し経路 | コンソールと `aws login`（開発環境）は成立。Entra は残り | コンソールの通し、タグ `awsbridge_team` と SourceIdentity の CloudTrail への記録、別チームの経路での `sts_denied` [確認済み]。所属の反映はポリシーの伝播（約 20 秒では足りず、約 2 分 15 秒で反映）＋トークンの失効、またはアプリのセッションの期限切れ [確認済み]。`aws login` は 1a の前の条件 (1)（書き直し版: 同じ端末と `--remote` の両方が Viewer で通る）で成立（§7.2） |
| 詳細設計（エンドポイント・CSRF・テンプレート） | 書いた | エンドポイントと CSRF: portal §9.2〜§9.7。テンプレート: この文書 §4。全体と脅威モデル: この文書 |
| Sol のレビュー | **済み**。採った指摘をこの文書と portal に反映した | 指摘と反映先は §9.1 の「Sol のレビューの指摘の反映」 |
| cto の決裁 | **条件付き承認**。段階 1 を 1a・1b に分ける（当時）。2026-11-12 に段階の定義を「① 完成 → ② 個人で導入・試験 → ③ 会社に導入」に置き換え、条件を付け替えた | §7・§9 |

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
console Worker（Standard のデプロイ）        console Worker（Admin のデプロイ。① で作る。会社で配るのは G5 のあと）
   入口と 1 つの一覧（共通。Admin の行も表示）  │ Admin のオリジン: Admin の行の S2 と発行だけ
   │ Access JWT を検証 → AUD だけからチーム     │ 同じ処理。Admin の階層のチームと行だけを持つ
   │ → 一覧（表示用）で選択を確かめる            │ 鍵は KMS（N6 の成立が条件。G1）
   │ → Standard の鍵で短命 JWT に署名           │
   ▼                                        ▼
STS AssumeRoleWithWebIdentity（各アカウント）
   │ 信頼ポリシー: そのロールの階層の issuer のプロバイダー・aud・aws:RequestTag/awsbridge_team・TagKeys・SourceIdentity 必須
   ▼
getSigninToken → 302 でコンソール ──（コンソールのセッションから）──▶ aws login（Standard: 同じ端末と --remote / Admin: 同じ端末だけ）

issuer の公開文書（discovery と JWKS）: https://<issuer-host>/std/...（Standard の Worker）。Admin の issuer は Admin の Worker が出す。ホストは Standard と同じホストの /admin でもよい（/admin の経路が Admin の Worker に向くことが条件。形は G1 で審議）。§3.1
各アカウント: 基盤の StackSet（OIDC プロバイダー）＋ 種類の StackSet（ロール）。§4
```

- 認可の権威は AWS 側に置く。所属（人 → チーム）は Entra のグループ、割り当て（チーム × 種類 → ロール）は設定ファイルの `kinds` → StackSets → 各ロールの信頼ポリシー。Worker は「どの Access アプリを通ったか（AUD）」をタグに写すだけで、対応表を権威として持たない [資料: cto の決裁 D5・D9・D10]
- ただし認可の権威は 1 か所ではない。「誰をどのロールへ」は Worker と設定ファイル（とその変更権限・レビュー）が、「そのロールで何ができるか」は下流が作る IAM のロールが決める。設定の変更権限とレビューも制御面として守る（A10）。設定に書いていないロールでも、プロバイダーを信頼していれば STS で直接引き受けられうる（§4.8）[資料: Sol のレビュー 2026-11-12 の A]
- 所属の確認は M2（チームごとの Access アプリ）。グループ名で照合する案（M1）と、Worker に対応表を持たせて発行を判断する案は却下済み [資料: cto の決裁 D5]
- **2026-11-12 の修正（U2）**: 入口の 1 つの一覧のために、Worker は Entra グループの Object ID → チームの対応を**表示のためだけに**持ってよい。発行の認可には使わない（発行の経路はこの対応表と照合のコードを読まない）。D5 は保つ（portal §7）

### 2.2 デプロイと鍵の分け方

| 項目 | 決定・案 | 根拠 |
|---|---|---|
| Worker | コンソールログイン用は MCP 用と別の Worker。awsbridge リポジトリ内の別エントリ。MCP 用のバンドルにコンソールログイン用の経路が入らないことをテストで確かめる（実装済み: `test/e2e/console-bundle.test.ts`・`test/unit/console-layout.test.ts`） | [資料: cto の決裁 D2] |
| Standard と Admin | 別の Worker デプロイ（D3 のこの部分は保つ）。**入口と一覧は共通**（P1'。2026-11-12）で、Administrator の行も Standard の一覧に表示用だけで出す。Admin の発行は Admin のオリジンの Worker だけが行い、Standard の Worker は代わりに行わない。Standard のバンドルに Admin の鍵の参照・Admin のチームの AUD・Access のポリシー ID を入れない（portal §8・§9.10） | [資料: cto の決裁 D3、2026-11-12 の P1'] |
| 鍵 | 「階層（Standard / Admin）× 境界（管理下 / 管理外の先方ごと）」で分ける。issuer も同じ単位で分け、1 つの issuer に 1 つの鍵 | [資料: cto の決裁 D3]。設定の検査（issuer の URL の重複を誤りにする）は実装済み（`src/console/config.ts`） |
| 鍵の保管 | Admin: KMS 必須（N6 の成立が条件。G1。[console-login-admin.md](console-login-admin.md)）。Standard: **Workers secret は会社で Administrator を配る前（G5 の前）まで**。会社では最初から Standard も KMS にするかを G2 で決める（D4 の言い直し、cto の決裁 2026-11-12。前の版は「Standard の Workers secret は段階 1・2 に限る」） | [資料: cto の決裁 D4・2026-11-12] |
| Cloudflare アカウント | 既存の Cloudflare アカウントを使う。コンソールログイン用に分けるか（U-7）は G5 の前に決める（前の版は「段階 2 のゲート」） | [資料: cto の決裁（G-13）・2026-11-12 の行き先] |
| 作るものと配るもの | ① で Standard と Admin の両方（Worker・issuer・鍵・プロバイダーのスタック）を作る。② で個人の Organization のメンバーアカウントに両方を配る。③ は Viewer（Standard）を先に配り（G3）、Admin は G5 のあと。境界は管理下だけ（顧客のアカウントは「完了」の外） | §7 |

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

**人のロールは Viewer と Administrator の 2 つ**（cto の決裁と利用者の判断、2026-11-12）:

| ロール | 階層・パス | 名前（設定例。配る時点の名前を記録し、配ったあとは変えない） | 配る時機 |
|---|---|---|---|
| Viewer | Standard・`/awsbridge-console/std/` | `FederatedAwsBridgeViewer` | ② から（会社は G3 のあと） |
| Administrator | Admin・`/awsbridge-console/admin/` | `FederatedAwsBridgeAdministrator` | ② から（会社は G5 のあと。それまで会社の IAM を伴う開発は既存の入口） |

- **Developer と人の Debugger は廃止した**。`PowerUserAccess` を元にした中間のロールは、`cloudformation:UpdateStack` で CDK の `AdministratorAccess` の実行ロールに届くため、Administrator との差を保てない [資料: cto の決裁。一次情報は CDK の bootstrapping のカスタマイズと CloudFormation のサービスロールの文書]。IAM が要る開発者は Administrator を持つ（利用者が受容）
- MCP 用ロールは Debugger（`FederatedMcpDebugger`）と Viewer（`FederatedMcpViewer`）。新しい名前（`FederatedAwsBridge*`）に変えるか、その時期と方法は未決（MCP の統合の上申で決める。§7.1）

**今はロールを共有しない。** MCP 用ロール（`FederatedMcpViewer` / `FederatedMcpDebugger`）は、人のロールと独立した別のロールで、信頼ポリシー・issuer・audience も別である。人にコンソールのロールを与えても、MCP 側の権限には効かない。

- 共有の方向: 共有するのは Viewer だけ、という方向が条件付きで承認された（cto の決裁 2026-11-12。決裁 S2 の「共有しない」を縮めた形で開き直した）。Viewer に MCP の文を足すのは**MCP の統合の上申のあと**（前の版は「段階 2 のゲートの再上申」。12 時間の受容・発行者ごとの停止の実測・負の試験・Sol のレビューなどが条件）。共有するかは G3 までに決める（§7.7）。利用者の回答（2026-11-12）: M2-MCP と MCP の統合にはまだ着手しない。Administrator に MCP の文を置くことは段階を問わず却下。それまでは同じアカウントに人の `FederatedAwsBridgeViewer` と MCP の `FederatedMcpViewer` が並ぶ
- MCP の Viewer（`FederatedMcpViewer`）は全員が使える
- MCP の Debugger（`FederatedMcpDebugger`）を誰に渡すかは下流が決める。**上流は割り当ての規則を持たない**（「Administrator か Developer を持つ人にだけ」という前の規則は取り下げた。cto の決裁 2026-11-12）。割り当ては設定（`DebugAllowedSubjects`）で決める。渡すときの注意: Debugger はリモートシェルなどで実行先（インスタンス・タスク）のロールの権限を得られ、その権限には MCP 経由の条件が付かない
- 運用: MCP 側の認可は email の許可リスト（`DebugAllowedSubjects`）で、アカウントごとの設定。Debugger を渡す人を変えたとき（チームのメンバーの変更など）は許可リストも直す。外し忘れは気付きにくいので、所属変更の手順に入れる
- 将来: MCP 側の認可をチーム（Access アプリ → セッションタグ。M2-MCP）に寄せる設計は別に扱う。ロールを設定ファイルで管理する方向（§4.8）は、M2-MCP の着手の承認ではない（それまでは email の許可リスト）

**MCP の認可のチーム化（M2-MCP）とアカウント台帳（F2）の状態**（cto の決裁 2026-11-11 は、方向を設計と PoC まで条件付き承認。実装と下流の移行は PoC の結果を付けて再上申）。2026-11-12 の利用者の回答:

| 論点 | 回答 |
|---|---|
| MCP 用 Debugger の割り当て | チームごとに自由。台帳の検査は警告だけにし、生成のエラーにはしない（その後の決裁で、上流は割り当ての規則を持たないことになった。上の表と §4.8） |
| 個人用の MCP の下流 | チームは使わない（email の許可リストのまま）。移行方式の選択は要らない |
| PoC M-1〜M-6（M2-MCP） | 段階 2 のゲートの前に開発環境で行う。今は着手しない（2026-11-12 の段階の書き直しで、M2-MCP は MCP の統合の上申に移った。§7.1） |
| Admin の階層のチームの名前 | 例は `<team>-elevated` にそろえる（§3.4） |

**プロバイダーを 1 つにする案（P3）は却下**（cto の決裁 2026-11-12）。MCP 用とコンソール用の OIDC プロバイダーを 1 つにすると、MCP 用 Worker（エージェントからインターネット越しに呼ばれる）の侵害や鍵の漏えいが、全アカウントのコンソールのロールに届き、プロバイダーの削除（L2）で両方が同時に止まる。MCP と Standard だけを共通にする形、稼働中の MCP の issuer を広げる形も却下（人が受容しても技術承認しない）。IAM は issuer の JWKS のどの鍵で署名されたトークンも受け入れ、ロールの側で鍵を縛れないため、issuer を分けることが鍵と Worker の侵害の影響を分ける手段になる [資料: cto の決裁 2026-11-12]。ロールの共有（上の Viewer の方向）は、プロバイダーの共有とは別の論点

---

## 3. 配布後に変えにくい名前

各アカウントの IAM（プロバイダーの URL・信頼ポリシーの条件キー・ロールの ARN）と CloudTrail に入る名前は、配ったあとに変えると、全アカウントの StackSets の更新と、発行済みのセッションの切断を伴う。段階 1 のゲートで、cto が次のとおり確定した [資料: cto の決裁]。

| 名前 | 確定した値 | 節 |
|---|---|---|
| Standard の issuer | `https://<issuer-host>/std`（世代つきのパスの規則も可） | §3.1 |
| Admin の issuer | 方向 I-B を具体化（2026-11-12）: 分けるのは発行のオリジン。issuer のホストは Standard と同じホストの `/admin` でもよい。形は G1 で審議する（[console-login-admin.md](console-login-admin.md)） | §3.1 |
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
| **I-B 階層ごとにホスト**（cto の決裁の方向。2026-11-12 に下の箇条書きのとおり具体化） | `https://<issuer-host-std>/std` と `https://<issuer-host-admin>/admin`。それぞれ Custom Domain | Custom Domain だけで済む。Worker ごとにホストが完全に分かれ、Admin のホストの管理権限を分けられる | ホストが 2 つになる。同じゾーン・同じ Cloudflare アカウントのままなら、ゾーンと Workers の管理者からの分離にはならない（Cloudflare アカウントを分けるか（U-7）は G5 の前） |

- **Admin の issuer は方向 I-B**（cto の決裁）。形は G1 で審議する（前の版は「確定は段階 3」。[console-login-admin.md](console-login-admin.md)）。Admin の URL は Administrator を配るアカウント（② の個人、会社は G5 のあと）に初めて配るので、会社の Viewer の配布（G3）には影響しない
- **I-B の具体化**（cto の決裁 2026-11-12。形は G1 で審議）: 分けるのは**発行のオリジン**（Admin の発行は Admin のオリジン（`portal.adminOrigin`）の Admin の Worker だけ。portal §8）。issuer のホストは Standard と同じホストの `/admin` でもよい（上の I-A の形）。条件は `/admin` の経路が Admin の Worker に向くこと。パスで別の Worker に振り分ける形でのプロバイダーの登録・引き受けと、Access を迂回する入口の遮断を確かめる（portal §12.3 の P-9。実施の時機は G1 で決める）。I-A の欠点（振り分けの設定を変えられる者は Admin の JWKS を差し替えられる）は残るので、G1 で扱う
- Admin 用の別の Entra グループ（PIM など）は必須にしない（人が決める。PIM は G3・G5 で扱う）
- Standard の issuer の名前は変えない。Standard のホスト（`<issuer-host>`）の名前は `/std` のパスのまま使う（配った URL を変えない）
- P1（Standard と Admin を同じ Worker にする）・P2（Standard と Admin の issuer を 1 つにする）は決めていない。**G1 で扱う**（前の版は「段階 3 のゲートで再上申できる」）。採るには人の受容が要る（P1 は D3 の緩和、P2 は D3・D4 の変更）。評価は [console-login-admin.md](console-login-admin.md)。順位は P1' > P1 > P2。どの案でも、Administrator を配るアカウントにはコンソール用のプロバイダーが 2 つ（Standard・Admin）並ぶ（P2 を除く）
- 鍵が漏れたあとは、同じ URL での作り直し（JWKS のキャッシュ。N5）に頼らず、世代を付けた新しいパス（例 `/std-2`）に移れる規則にしておく（`^[a-z0-9-]+$`）。平常時の URL には世代を入れない。移る手順（新しいプロバイダーの配布 → 信頼ポリシーの切り替え → 古いプロバイダーの削除）の案は G1 の資料（[console-login-admin.md](console-login-admin.md)）に書いた（Standard も同じ手順）。前の版は「段階 2 の前に書く」で、新しい行き先は決裁に明記がない（§7.7）[資料: cto の決裁で可。Sol のレビューの指摘 12]

### 3.2 audience

**確定**: `awsbridge-console`（全階層・全境界で同じ値。定数 1 つ）[資料: cto の決裁]

- MCP 用の `awsbridge` と重ならない
- issuer を階層 × 境界で分けているので、aud まで分けなくても、Standard の JWT で Admin のロールには入れない（条件キーが `<issuer-host>/std:aud` と `<issuer-host>/admin:aud` で別。N9 のケース 3・4 で AccessDenied [確認済み]）。共通の audience は、issuer が分かれていれば欠陥ではない [資料: Sol のレビューの指摘 12]
- 実装: 上流の定数 `AUDIENCE`（`src/console/config.ts`。`TEAM_TAG_KEY`・`ROLE_PATH_PREFIX` と同じ並び）にし、生成物（`stacksets.json` の `audience`）に入れた。下流ごとに変える理由がないので、設定スキーマには入れない

### 3.3 ロールのパスと名前

| 項目 | 確定 | 備考 |
|---|---|---|
| パス | **P-2**: `/awsbridge-console/<tier>/`（`/awsbridge-console/std/`・`/awsbridge-console/admin/`）[資料: cto の決裁] | SCP や `aws:PrincipalArn` の条件で「コンソールログイン用すべて」（`arn:aws:iam::*:role/awsbridge-console/*`）と「Admin の階層だけ」（`.../awsbridge-console/admin/*`）を、ロール名を知らずに止められる。ArnLike の `*` がパスの `/` をまたいで一致するかは [推測]（SCP の訓練で確かめる）。実装: `rolePath(tier)`（`src/console/config.ts`）。一覧の `roleArn` と `stacksets.json` の `roles[].rolePath` はこの値、`rolePathPrefix` は `/awsbridge-console/` |
| tier とパスの意味 | **tier は発行経路と鍵の分離で、権限の強さは保証しない**。tier が決めるのは「どの Worker・issuer・鍵で署名したトークンで、そのロールに入れるか」と、停止の対象選びに使うパスの名前だけ。Standard のパスに強い権限のロールを置くことは、パスでも信頼ポリシーでも防げない（手作りのロールの強さが階層を超えないことは下流の責任。利用者が受容。§4.8）。参考の形のまま使えば、Standard には Viewer だけが入る [資料: Sol のレビューの指摘 10・12、Sol のレビュー 2026-11-12 の A、cto の決裁 2026-11-12] | — |
| ロール名 | 設定の `roles[].roleName`（下流が決める）。設定例と配る名前は `FederatedAwsBridgeViewer` と `FederatedAwsBridgeAdministrator`。配る時点の名前を記録し、配ったあとは変えない（前の版は「1a の配布の時点の名前を記録し、段階 1 の間は変えない」）[資料: cto の決裁 2026-11-12]。上流のスキーマは名前を強制しない | ロールの名前を変えると、そのロールのセッションは切れる |
| MCP 用との区別 | パスで区別できる（MCP 用はパスなし） | — |

### 3.4 タグと JWT の claim

| 項目 | 確定 | 備考 |
|---|---|---|
| タグのキー | `awsbridge_team`（上流の定数 `TEAM_TAG_KEY`。実装済み） | キーの大文字・小文字は区別される [確認済み: P2 ケース 7] |
| タグの値 | チーム名。`^[a-z][a-z0-9-]{0,31}$`（設定の `teams[].name`。実装済み） | 信頼ポリシー・Access アプリの名前・URL のパスにも入るので、チームの改名は「新しいチームを作って移す」になる |
| Admin の階層のチーム | 設定で明示する（`tier: "admin"`）。名前の規則は下流の自由とし、例は `<team>-elevated` | 暗黙に `-elevated` を付ける規則は持たない（portal §11.4） |
| タグの数 | 1 個（`aws:TagKeys` で他のキーを拒否） | パック後 4096 バイトの制限に余裕がある（1 個で SessionTokenUtilization 25%）[確認済み: P2] |
| `sub` | 利用者の email（小文字） | 信頼ポリシーでは照合しない |
| SourceIdentity | 利用者の email（小文字）。**会社の Entra でも email に決定**（利用者の判断、2026-11-12。§9.2 の U-3 は閉じた）。`https://aws.amazon.com/source_identity` の claim | AWS の文書は 2〜256 文字・英数字と `_.,+=@-` [確認済み: IAM の文書]。前の資料の「64 文字」とは食い違うので、実装は短い方（64 文字）に合わせ、超えたら `identity_unsupported`。**値は不透明な識別子として扱い、形に依存しない**（信頼ポリシーに形の条件を足さない。停止の Deny は値の完全一致で書く）。**値の出どころは設定で切り替えられる形にする**（既定は email。MCP 用の `IDENTITY_CLAIM` と同じ考え方。実装はポータル本体と一緒に行う。§9.2 の U-14）。認可は email を見ない（チームのタグで決まる。D5）ので、email の影響は停止（L3-1）と監査に限られる。改名・再利用の扱いは §6.3、監査で人を特定する手順は §5.6。M2-MCP でも email にする。Entra の `oid` は将来の選択肢（会社の Entra の設定と実証が要る）。発行記録には email・Access の `sub`・取れれば `oid` を残す（§5.6）[資料: cto の決裁 2026-11-12「会社の Entra でも SourceIdentity は email」。Sol のレビューの指摘 9] |
| RoleSessionName | `console-<email>`（今のまま。U-3 と一緒に決めた） | 2〜64 文字で、接頭辞 `console-` が 8 文字なので、email は 56 文字まで（超えたら `identity_unsupported`）。portal §6.1 |
| タグの claim | `https://aws.amazon.com/tags` の `principal_tags` に `awsbridge_team` だけ。**`transitive_tag_keys` は入れない** | §4.3 |
| JWT の有効期限 | 約 5 分。`jti` を付け、発行記録に残す | MCP 用と同じ。開発環境の N6 で、STS の `AssumeRoleWithWebIdentity` の CloudTrail の `requestParameters.webIdentityTokenId` に JWT の `jti` が入った（28/28。1 回の測定）[確認済み: N6。console-login-admin.md §8]。CloudTrail との突き合わせの主なキーは `jti` ＝ `webIdentityTokenId` で、STS の応答の ID も併せて使う（§5.6）。前の版の「`jti` は CloudTrail に引き継がれない」は訂正した |

### 3.5 そのほかの名前

| 項目 | 確定 |
|---|---|
| StackSet の名前 | 基盤 `awsbridge-console-base`、種類 `awsbridge-console-kind-<kind>`（`<kind>` は設定の `kinds[].name`）。SCP のドリフト防止の除外条件と CI の権限に入る |
| 停止用の SCP の名前 | `awsbridge-console-stop-all`・`awsbridge-console-stop-admin` |
| 停止用の固定の Deny 管理ポリシー（Entra を通らない停止の経路で E1 の直した形を採る場合） | 会社は E0 を選んだので今は作らない。G5 の前（または会社で Viewer を全アカウントに広げる前）に経路を決めるときに名前も決める（§6.6・§6.7） |
| ポータルのホスト | 下流の設定（`portal.standardOrigin`）。最初に配る前に下流で確定する（② は個人の下流、③ は会社の下流。portal §3.1） |

---

## 4. CloudFormation / StackSets のテンプレート

実装はまだない。ここではテンプレートの形と、設定・生成物との対応を決める。

**ロールは設定に任せる**（cto の決裁 2026-11-12。§4.8）: どのグループ（チーム）にどのロールを渡すかは設定ファイルで管理し、上流は割り当ての規則を持たない。**必須の CloudFormation はプロバイダーのスタック**（OIDC プロバイダーと守りの部品の顧客管理ポリシー。§4.2）。**ロールの CloudFormation は参考の形**（§4.3）で、下流はそのまま使っても、自分でロールを作って設定に書いてもよい。ただし構造の要件（§4.8）は守る。

### 4.1 構成

| StackSet | 単位 | 中身 | 配り方 |
|---|---|---|---|
| 基盤 `awsbridge-console-base`（**必須**） | Organization ごとに 1 つ（管理下）。管理外・単独のアカウントは先方（またはその持ち主）が 1 本流す | OIDC プロバイダー（Standard、と Admin を使うなら Admin）と、階層ごとの守りの部品（顧客管理ポリシー。§4.8） | **② と ③ の Viewer の配布の間は、種類のスタックと同じ対象アカウントだけに、運用者が手作業で配る**（§7.2 の (6)。CI に適用権限を持たせない）。広げるときは service-managed で Organization の全メンバーアカウント。管理アカウントは対象外（コンソールログイン用ロールを置かない） |
| 種類 `awsbridge-console-kind-<kind>`（**参考の形**） | 種類 × Organization ごと | その種類で割り当てのあるロールだけ。下流がロールを手で作るなら使わなくてよい | 手作業の間（② と ③ の Viewer）: 対象アカウントを列挙して手作業で配る（自動デプロイは使わない [推測: cto の決裁の「手作業で配る」からの読み取り]）。広げるとき: S1（種類の OU に自動デプロイ）か S3（アカウントを列挙。自動デプロイなし）。管理外は先方 |

- 種類の StackSet は基盤の StackSet に依存させる（StackSet 間の依存）[資料: 前の設計上申 §4.6.6。AWS の文書で確認]
- プロバイダーを種類の StackSet に入れない。種類を変える（OU を移す）と自動デプロイが古いスタックを消すので、プロバイダーまで作り直しになるため
- 種類の OU を入れ子にしない（子 OU も対象になり、同じ名前のロールが 2 つの StackSet から配られる）。CI で検査する（portal §11.5）
- 種類のテンプレートは、設定の `roles` から生成する案（K1）を推す（portal §11.4・G-9）。上流は生成器とテストを持ち、下流は生成物を cfn-lint とレビューにかける。生成したロールのテンプレートは参考の形で、使うかは下流が決める（§4.8）
- **② と ③ の Viewer の配布の間は、CI に StackSets の適用権限を持たせない**（前の版は「段階 1 では」）。配布は運用者が手作業で行い、CI は検査（設定・生成物・テンプレート・ドリフト）だけを行う [資料: cto の決裁。Sol のレビューの指摘 1: Organization 全体に任意のロールを配れる CI を使うと、試行の間の侵害時の影響範囲が試験の範囲と一致しない。サービス管理型 StackSets のサービスリンクロールには SCP が効かない]。CI に適用権限を持たせるのは、対象アカウント・対象スタック・許可したテンプレートに絞れることと、本人以外の承認（G-14）を確かめてから（G-14 は G5 の前。適用権限を持たせる時機は決裁に明記がない）

### 4.2 基盤のテンプレート

| パラメーター | 型と規則 | 生成物の出どころ |
|---|---|---|
| `IssuerHost` | ホスト名だけ（スキーム・パス・末尾スラッシュなし） | `stacksets.json` の `providers[].issuers.standard` のホスト部分。**Admin の issuer は Standard と同じホストの `/admin` でも別のホストでもよい**（§3.1。形は G1 で審議）。Admin のホストのパラメーターの形は G1 の結果で決める |
| `StandardPath` | `^[a-z0-9-]+(/[a-z0-9-]+)*$`（例 `std`・`p/p01/std`） | 同じ URL のパス部分 |
| `AdminPath` | 同じ規則。**空なら Admin のプロバイダーを作らない**（`Conditions`）。Administrator を配らないアカウント（会社の G5 の前など）は空 | `providers[].issuers.admin`（なければ空） |
| `Audience` | `AllowedValues: [awsbridge-console]` | `stacksets.json` の `audience`（上流の定数 `AUDIENCE`。§3.2） |

| リソース | 内容 |
|---|---|
| `StandardProvider` | `AWS::IAM::OIDCProvider`。`Url: https://${IssuerHost}/${StandardPath}`、`ClientIdList: [Audience]`。`ThumbprintList` は付けない（N9 の PoC も付けずに作れた [確認済み]） |
| `AdminProvider` | 同じ。`Condition: HasAdmin` |
| 守りの部品（Standard） | 顧客管理ポリシー。中身は §4.8（ロールチェーンの禁止、awsbridge のロールとプロバイダーへの書き込みの Deny、1 人停止の Deny の置き場所）。signin の Allow は入れない |
| 守りの部品（Admin） | 同じ中身に、`aws login --remote` の明示の Deny を足したもの（§4.4）。`Condition: HasAdmin`。Administrator を配らないアカウントでは作らない |

### 4.3 種類のテンプレート（ロールごと。参考の形）

設定の `roles[]` の 1 件ごとに、次のパラメーターとリソースを生成する。これは参考の形で、下流が手でロールを作るときも §4.8 の構造の要件を満たす。

| パラメーター | 内容 | 生成物の出どころ |
|---|---|---|
| `<Name>Teams` | そのロールが受け付けるチーム名のカンマ区切り。**空ならロールを作らない**（`Conditions`）。型は `String`（空を許すため） | `stacksets.json` の `assignments[].parameters`。名前は `teamsParameterName`（`readonly` → `ReadonlyTeams`、`read-only` → `ReadOnlyTeams`） |

| 項目 | 内容 | 生成物の出どころ |
|---|---|---|
| `RoleName` / `Path` | `roleName` / `/awsbridge-console/<tier>/`（§3.3 の P-2） | `roles[].roleName`・`roles[].rolePath` |
| `MaxSessionDuration` | `sessionSeconds`（900〜43200） | `roles[].sessionSeconds` |
| `ManagedPolicyArns` | 設定の AWS 管理ポリシー | `roles[].managedPolicyArns` |
| インラインポリシー | (1) `aws login` の Allow（§4.4。Standard は `localhost` と `remote`、Admin は `localhost` だけ）、(2) 下流のポリシー文書（`inlinePolicyFiles`） | `roles[].inlinePolicyFiles`、上流の固定の文書 |
| 守りの部品 | 参考の形では、その階層の守りの部品（§4.2・§4.8。自分自身の保護・**ロールチェーンの禁止**・1 人停止の Deny の置き場所、Admin は `--remote` の Deny も）を付ける。前の版はこれらをロールのインラインポリシーに置いていた。最初の配布から部品を配るか、インラインのままにするかは未決（§9.2 の U-15）。Admin のロールは部品を自分で外せる（部品は事故防止で、強制の境界ではない。§4.8） | 基盤のスタックの出力（部品のポリシーの ARN） |
| 信頼ポリシー | 下の形。`Principal` は、そのロールの階層のプロバイダー（`arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/<その階層の issuer のホスト>/<その階層のパス>`）だけ。Admin の issuer のホストは G1 で審議（§3.1） | 基盤と同じ issuer のホスト・パス、`tagKey`、`audience` |

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
- SourceIdentity はチェーン先にも引き継がれる。そのため、**チェーン先のロールの信頼ポリシーに `sts:SetSourceIdentity` がないと、チェーンが失敗する** [確認済み: AWS の文書（IAM の SourceIdentity の説明と AWS Security Blog）]。また、SourceIdentity を必須にしたロールには、コンソールの Switch Role で入れない [確認済み: IAM の文書]。コンソールログイン用のセッションから既存のロールへのチェーン（N12）は、全アカウントに広げる前に確かめる（§8・§7.7）

### 4.4 `aws login` と `--remote` の扱い

調べた結果:

| 項目 | 内容 | 状態 |
|---|---|---|
| リソースの ARN | 同じ端末の `aws login` は `arn:aws:signin:<region>:<account-id>:oauth2/public-client/localhost`、`--remote` は `.../oauth2/public-client/remote`。アクションは `signin:AuthorizeOAuth2Access` と `signin:CreateOAuth2Token` | [確認済み: AWS Sign-In の文書（`SignInLocalDevelopmentAccess` の説明）] |
| 管理ポリシー | `SignInLocalDevelopmentAccess` は両方を許す。文書は「どちらかを制御するには、自前の管理ポリシーか SCP でこの ARN を許可・拒否する」と書く | [確認済み: 同じ文書] |
| 条件キー | `signin:OAuthRedirectUri`・`signin:OAuthGrantType` がある。文書の例は AWS MCP Server の OAuth（`service-principal/aws-mcp.amazonaws.com`）向けで、`aws login` の `--remote`（リダイレクト先が `https://<region>.signin.aws.amazon.com/v1/sessions/confirmation`）を塞ぐのに使えるかは書かれていない | **未確認** |
| 個別のセッションの拒否 | `aws:SignInSessionArn` で特定のサインインのセッションを Deny できると文書にある（AWS MCP Server の OAuth の文脈） | `aws login` に効くかは**未確認** |

設計（cto の決裁 2026-11-12。前の版の「全ロールで `--remote` を塞ぐ」を改めた）:

| 対策 | 対象 | 内容 |
|---|---|---|
| (1) Standard のロールのポリシー | 参考の形の Viewer（Standard の階層） | 管理ポリシー `SignInLocalDevelopmentAccess` は付けず、`signin:AuthorizeOAuth2Access`・`signin:CreateOAuth2Token` を `arn:${AWS::Partition}:signin:*:${AWS::AccountId}:oauth2/public-client/localhost` と `.../oauth2/public-client/remote` の 2 つのリソースだけに Allow する。同じ端末と `--remote` の両方を許す |
| (2) Admin のロールのポリシー | 参考の形の Administrator（Admin の階層） | 同じ 2 つのアクションを `.../localhost` だけに Allow する。`AdministratorAccess`（`Action: *`）は `signin:*` を含み `--remote` も許してしまうので、(3) の Deny で塞ぐ |
| (3) Admin の階層の守りの部品 | Admin の階層のロール（手作りのロールも、部品を付けていれば） | `.../oauth2/public-client/remote` への 2 つのアクションを明示の Deny。**本人（Administrator）が部品を外せるので、これはフィッシングへの守りであって封じ込めではない**。Deny が効くのは部品が付いている間だけ。Standard の部品には入れない |
| (4) 生成の検査 | 設定 | Admin の階層のロールの `roles[].permissions.managedPolicyArns` に `SignInLocalDevelopmentAccess` があれば誤りにする（`--remote` を許すため）。Standard の階層での扱いは未決（参考の形は付けない）。未実装 |
| (5) SCP（管理下のメンバーアカウントだけの任意の層） | 停止用とは別の常設の SCP | Admin の階層のロール（`/awsbridge-console/admin/*`）について `.../oauth2/public-client/remote` を Deny する。基準の守りにはしない（SCP は管理外・単独のアカウントに掛けられない。§6.5） |

確かめたこと・残り:

| 項目 | 状態 |
|---|---|
| Viewer と同じ形のロール（(1)）で、同じ端末の `aws login` と `--remote` の両方が通る（1a の前の条件 (1) の書き直し版） | **成立**（開発環境、2026-11-12。§7.2） [確認済み: `scripts/poc/human/README.md`] |
| `--remote` の同意画面 | アカウントのエイリアスと ID、ロール名 / セッション名、ログインからの経過時間が出る。**開始した端末・要求の時刻・コードの期限は出ない**。コードは既定で隠され、コピーのボタンと注意書きがある。セッションを選んだ時点でコードが出て、別の承認ボタンはない [確認済み] |
| CloudTrail での区別 | `requestParameters.client_id` が `arn:aws:signin:::devtools/cross-device`（`--remote`）と `.../devtools/same-device`（同じ端末）で分かれる。`AuthorizeOAuth2Access`・コードの交換・更新（`CreateOAuth2Token`）の 3 種すべてにある。`resources` は記録されない。イベントはそのリージョン（開発環境では ap-northeast-1）だけ [確認済み] |
| `--remote` のセッションに L3・L3-1 が効くか | 効く。更新も止まる（§6.1）[確認済み] |
| Administrator で `--remote` が拒否されること | N2（① の PoC。G2） |
| 未測定（旧「1b の前の確認」。② で確かめ、G3 に持っていく） | 同じ端末の 15 分後の更新、アクティブなセッションが 1 つのときの確認画面。2 人目の対照、`--remote` でブラウザと CLI の `sourceIPAddress` が分かれるか |

`--remote` を許すことに伴う運用（Viewer）:

- **通知**: `--remote` の発行を CloudTrail で通知する。条件は `requestParameters.client_id = arn:aws:signin:::devtools/cross-device`（② で組み、G3 に持っていく）。通知は事後の検知で、防止ではない
- **案内**: 「自分で始めた URL だけ開く」「コードを人に渡さない」「一覧で選ぶセッション（アカウントとロール）を確かめる」「共有の端末では使ったあと `aws logout` する」
- **残るリスク**（受容）: 攻撃者が始めた `aws login --remote` の URL を Viewer が開いてコードを渡すと、攻撃者は Viewer の権限をロールの上限の時間まで使える。防ぐのは利用者の注意だけ（画面に要求元の端末が出ない）
- **見直しの条件**: `--remote` に L3・L3-1 が効かないと分かったら、Viewer も `localhost` だけに戻す [資料: cto の決裁 2026-11-12 の再審議条件]

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
| 停止の印（§6.7 の案） | なし | 全アカウントに広げる前に決める（N8） |

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

### 4.7 Viewer ロールの中身

Standard の階層の参考の形は Viewer ロール（`FederatedAwsBridgeViewer`）1 つ。会社で最初に配るのもこれだけ（§7.6）。Viewer は安全な権限の上限とは限らない（データの読み出し・リソースポリシー経由の権限）[資料: Sol のレビューの指摘 10] ので、次の形に固定する。

| 項目 | 内容 | 根拠 |
|---|---|---|
| 管理ポリシー | `ReadOnlyAccess`（AWS 管理） | MCP 用の Viewer ロールと同じ（`infra/aws/awsbridge.yaml` の `ReadOnlyRole`） |
| ロールチェーンの禁止 | `sts:AssumeRole` を明示の Deny（`Resource: *`）。案内に書くだけでなく、権限で禁じる。置き場所はロールのインラインポリシーか守りの部品（§4.8）で、最初の配布でどちらにするかは未決（§9.2 の U-15） | Sol のレビューの指摘 4。SourceIdentity 付きのセッションからのチェーン（N12）は全アカウントに広げる前 |
| `aws login` | `signin:AuthorizeOAuth2Access`・`signin:CreateOAuth2Token` を `.../oauth2/public-client/localhost` と `.../remote` だけに許す（§4.4 の (1)）。`SignInLocalDevelopmentAccess` は付けない。両方が通ることは 1a の前の条件 (1)（書き直し版）で成立 | §4.4 |
| 秘密値 | **決定: 読めない**（利用者の判断 2026-11-12）。MCP 用の Viewer ロールと同じ明示の Deny（SSM の `GetParameter`・`GetParameters`・`GetParametersByPath`・`GetParameterHistory` と、Secrets Manager の `GetSecretValue`・`BatchGetSecretValue`。`Resource: *`、条件なし。`infra/aws/awsbridge.yaml` の `DenySsmParameterRead`・`DenySecretsManagerRead` と同じ文）。一覧（`DescribeParameters`・`ListSecrets`・`DescribeSecret`）は `ReadOnlyAccess` で見られる | MCP 用と同じ扱いにそろえる |
| **Viewer は「機密を読めない」ではない** | 上の Deny は SSM と Secrets Manager の値だけを塞ぐ。`ReadOnlyAccess` で、S3 のオブジェクト・ログ（CloudWatch Logs など）・データベースの項目（DynamoDB など）・Lambda の環境変数・CloudFormation のテンプレートと出力など、**データそのものは読める**。そこに複製された秘密も読める。Viewer を渡すアカウントは「そのアカウントのデータを読まれてよい人」に限る（許容するデータの範囲は下流が決める）。前の版は「段階 1 は非本番の数アカウントに限るので受け入れ、段階 2 のゲートで「機微データの読み取り・IAM・signin の許可」を棚卸しする」。棚卸しの新しい時機は決裁に明記がない（[推測] 会社の Viewer の前の G3。§7.7） | Sol のレビューの指摘 10、Sol のレビュー 2026-11-12 の E |
| 自分自身の保護・1 人停止 | ロールチェーンの禁止と同じく、置き場所はインラインか守りの部品（§4.8）。最初の配布でどちらにするかは未決（U-15）。1 人停止の Deny は、1a の前の条件 (4) で確かめた CloudFormation の外のインラインポリシーの形で効く（§6.1） | — |

### 4.8 ロールを設定に任せる形と守りの部品

[資料: cto の決裁 2026-11-12（C-a と守りの部品）と利用者の判断。Sol のレビュー 2026-11-12 のうち採った指摘]

**割り当て**: どのグループ（チーム）にどのロールを渡すかは、すべて設定ファイル（`kinds[].assign`）で管理する。上流は割り当ての規則（「このロールはこのロールを持つ人にだけ」など）を持たない。下流は好きにロールを作り、設定に書いてよい。

**上流が持つもの**: 参考の形（プロバイダーのスタック・ロールのテンプレート）、Worker が断る条件、検査の道具（§4.9）の 3 つだけ。手作りのロールの強さが階層を超えないこと（例: Standard のパスに `AdministratorAccess` のロールを置かないこと）は**下流の責任**（利用者が受容）。

**構造の要件**（手作りのロールも満たす。利用者の判断で残す）:

| 要件 | 内容 |
|---|---|
| tier | ロールは `standard` か `admin` のどちらかに属する。Worker は自分の階層の行だけを持ち、他の階層のパスのロールには発行しない |
| パス | `/awsbridge-console/<tier>/` に置く（§3.3） |
| 信頼ポリシーの形 | `Principal` は**その階層のプロバイダー 1 つだけ**。`<issuer>:aud` = `awsbridge-console`、`aws:RequestTag/awsbridge_team` の値（そのロールを渡すチーム）、`aws:TagKeys` の制限、SourceIdentity 必須（§4.3 の形） |
| 停止が効く | revoke（L3）と 1 人停止（L3-1）が効く。1 人停止の Deny の置き場所を守りの部品にするなら、部品が付いていることが要る [推測: 決裁は要件として「停止が効くこと」だけを挙げた] |

**D3・D4 の言い直し**（前の版は「Standard の鍵では Admin の権限に届かない」と書いていた）:

| 区分 | 内容 |
|---|---|
| Worker と検査が守る部分（どのロールでも成り立つ） | 鍵と issuer は階層 × 境界で分かれる。Standard の Worker・鍵のトークンは、Admin のプロバイダーを信頼するロールには入れない。Standard の Worker は Admin のパスのロールに発行しない。信頼ポリシーの形（その階層のプロバイダー 1 つだけ）は検査の道具で確かめる |
| 参考の形のまま使えば成り立つ性質 | Standard の鍵・Worker が侵害されても、届くのは Viewer の権限まで（Administrator には届かない）。Administrator の権限は Admin の Worker と KMS の鍵の経路だけで発行される |
| 成り立たないもの | 手作りのロールに強い権限を付けて Standard のパスに置けば、Standard の鍵でその権限に届く。tier は発行経路と鍵の分離で、**権限の強さは保証しない**（§3.3） |

**守りの部品**（プロバイダーのスタック = 必須のスタックに置く、階層ごとの顧客管理ポリシー）:

| 中身 | Standard の部品 | Admin の部品 |
|---|---|---|
| ロールチェーンの禁止（`sts:AssumeRole` の明示の Deny） | あり | あり |
| awsbridge のロールとプロバイダーへの書き込みの Deny（`/awsbridge-console/*` のロールの信頼ポリシー・ポリシー・パスの変更、コンソールログイン用のプロバイダーの変更）。部品のポリシー自体の変更も Deny に入れるかは未決 | あり | あり |
| 1 人停止の Deny の置き場所（`aws:SourceIdentity` の値の Deny を足す場所。§6.3） | あり | あり |
| `aws login --remote` の明示の Deny（§4.4 の (3)） | なし | あり |
| signin の Allow | 入れない（ロール側に置く） | 入れない |
| 監査の Deny（CloudTrail・Config・GuardDuty などの停止・削除） | — | Administrator の設計に引き継ぐ（前の版は「段階 3 で決める」。① で作る前に決める。[console-login-admin.md](console-login-admin.md) の未決事項） |

- **部品は事故防止のためのもので、強制の境界ではない**。Administrator は部品の版を作り直す（`CreatePolicyVersion`・`SetDefaultPolicyVersion`）、ロールを消して作り直す、別の主体を作る、`PassRole` と CloudFormation・Lambda で代わりに操作させる、といった方法で外せる。管理外・単独のアカウントでは、先方の管理者と root も外せる（防げないので、ドリフトの検知と契約で扱う）[資料: Sol のレビュー 2026-11-12 の C、SCP に頼らない方針]
- SCP に頼らない: 守りの基準は、各アカウントのロールとプロバイダーのスタックだけで成り立たせる。SCP は管理下のメンバーアカウントで重ねる任意の層で、合格条件にしない。管理外の Organization のアカウントと単独のアカウント（Organization に入っていない）には自社は SCP を掛けられないので、どの種類のアカウントでも同じ文書で守る [確認済み: AWS Organizations の文書（SCP はすべての機能を有効にした Organization のメンバーアカウントにだけ効く）]
- ① の PoC（測るのは ① と ②。前の版は「段階 2 の課題」）: 部品の版の更新が発行済みのセッションにいつ効くか。**新しい引き受け・既存のセッション・`aws login --remote` の更新を別々に測る**（インラインポリシーの約 10 秒は実測で、保証値ではない）。管理ポリシーの大きさの上限（6,144 文字）は停止のリストの容量の制約になる。版は最大 5 つなので、更新・古い版の削除・競合・容量を超えたときの手順を ① で決める（G2）[資料: Sol のレビュー 2026-11-12 の C]
- MCP 用ロールを設定で管理する方向（M2-MCP）は、この節の承認とは別で、着手の承認ではない

### 4.9 検査の道具

上流が持つ検査の道具の項目（実装はまだない。① で作る。②（と ③ の最初）は運用者が手で回す。CI の読み取りロールは G3 で決める）[資料: cto の決裁 2026-11-12、Sol のレビュー 2026-11-12 の B]:

| 項目 | 内容 |
|---|---|
| 使う API | `iam:GetRole`（信頼ポリシー・パス・`MaxSessionDuration`）・`iam:ListAttachedRolePolicies`・`iam:ListRolePolicies`・`iam:GetRolePolicy`・`iam:GetPolicy` と `iam:GetPolicyVersion`（守りの部品の**現在のデフォルト版の中身**まで見る）・`iam:ListRoles`（棚卸し）。これらが `ReadOnlyAccess` に入るかを確かめる |
| 棚卸し | アカウントのロールをすべて列挙し、コンソールログイン用のプロバイダーを信頼するロールを見つける。設定に書いていないロールでも、プロバイダーを信頼していれば STS で直接引き受けられうるため |
| 信頼ポリシーの検査の方式 | **承認済みの厳格な形だけを許す許可リスト方式**。演算子名や必須キーの有無だけを見ない。すべての Allow 文で `Principal`・`Action`・`Condition` を組で評価する（別の Allow 文、値の追加、ワイルドカード、`IfExists`、`Null`、集合演算子で迂回できるため）。余分な文・Action・条件の緩和も誤りにする |
| SourceIdentity | Worker が検証済みの利用者から作る値で、利用者が選べないこと（信頼ポリシーで必須にし、値の形には依存しない。§3.4） |
| 正常性の検査 | 強すぎる Deny で使えなくなっていないか、停止の Deny の対象が違っていないか（越権の検査とは別に見る） |
| 守りの部品 | 部品が付いていること、部品の現在の版が上流の形と一致すること |
| 強さ | 既知の広い管理ポリシー（`AdministratorAccess`・`PowerUserAccess`・`IAMFullAccess` など）が Standard の階層のロールに付いていれば警告する。強さの判定はここまで（手作りのロールの強さは下流の責任） |
| 限界 | 手で回す検査は、検査のあとの改変を防がない。定期に回し、CloudTrail の変更の通知と組み合わせる |

---

## 5. 脅威モデル

前の設計上申の脅威モデルを、その後の決定（タグのキー `awsbridge_team`、設定ファイルの `kinds`、Admin のチームの明示、承認は 1 人）に合わせて直し、cto の条件の資産 2 つ（A10・A11）を足した。段階 1 のゲートで、Sol のレビューの指摘 2・3・11 から資産 A12〜A16 と経路 T11〜T14 を足した。2026-11-12 に、Viewer の `--remote` を許したこと（T15）と、ロールを設定に任せたこと（A10 の範囲）を足した。

### 5.1 資産

| # | 資産 | 置き場所 | 失われたときに起きること |
|---|---|---|---|
| A1 | issuer の署名鍵（階層 × 境界ごと） | Standard: Workers secret（会社で Administrator を配る前まで。§2.2）。Admin: KMS（N6。G1） | その issuer を信頼する全アカウントで、信頼ポリシーが許す範囲のタグと SourceIdentity を**偽造して**引き受けられる |
| A2 | Worker のコード・依存パッケージ・ビルド成果物と、デプロイ権限（デプロイ用の API トークン） | リポジトリ・パッケージのレジストリ・CI・Cloudflare アカウント | A1 と同じ（任意のトークンを出させられる。secret の鍵は読み出せる）。Admin の KMS は鍵の持ち出しを防ぐだけで、侵害された Worker に Sign を呼ばれるのは防げない [資料: Sol のレビューの指摘 3] |
| A3 | Access アプリ・ポリシー・IdP の連携 | Cloudflare アカウント | 所属の判定を緩められる |
| A4 | Entra のグループ（と PIM。G3・G5 で扱う） | Entra ID | 所属の権威そのもの |
| A5 | 各アカウントの信頼ポリシー・プロバイダー | 各アカウント（StackSets / 先方） | 許可値を変えられる（アカウントの管理者なら元々できる） |
| A6 | 表示用の一覧・生成物 | 下流の CI・Worker のバンドル | 表示の誤りだけ（権限は広がらない） |
| A7 | ログイン URL・一時認証情報・`aws login` のキャッシュとリフレッシュトークン | ブラウザ・端末（共有端末を含む） | そのセッション（最大はロールの MaxSessionDuration）を奪われる。`aws login` のリフレッシュトークンを持ち出されると、別の端末で更新を続けられる（revoke で更新が拒否されることは確認済み。P4(a)）。共有端末ではキャッシュが次の利用者に残る [資料: Sol のレビューの指摘 11] |
| A8 | 監査ログ（発行記録・Access のログ・CloudTrail） | Logpush の先・各アカウント | 追跡と検知ができなくなる |
| A9 | break-glass の認証情報 | 金庫・ハードウェアキー | 入口を通らずに入られる |
| **A10** | **種類の定義（設定ファイル）を置く private リポジトリと、StackSets を更新する CI のロール** | 会社の下流リポジトリ（GitHub）・管理アカウント（または StackSets の委任管理者）の CI 用ロール | 設定を変えると、任意のチームに任意のロールを割り当てられる（`kinds[].assign`）、ロールの権限を増やせる（`permissions`）、`tier` を偽って強い権限を Standard に置ける。CI のロールを奪えば、設定を経由せずに、その Organization の全メンバーアカウントに任意のロールと信頼を配れる（実質 Organization の管理者）。ロールを設定に任せた（§4.8）ので、**設定の変更権限とレビューは「誰をどのロールへ」を決める制御面**そのものになる |
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
                  [console Worker（Standard / Admin）] ─ (KMS: Admin)
                        │ 自前の JWT（iss = 階層 × 境界）
                        ▼
     [STS / 各アカウントの OIDC プロバイダー + 信頼ポリシー]
        ├─ 管理下・メンバーアカウント（SCP が効く）
        ├─ 管理下・管理アカウント（SCP が効かない → コンソールログイン用ロールを置かない）
        ├─ 管理外の Organization（先方の管理。自社は SCP を打てない）
        └─ 単独のアカウント（Organization に入っていない。SCP がない）

   設定の経路: [下流リポジトリ（A10）] ─ CI ─▶ StackSets（各アカウントのロール）
                                    └ CI ─▶ Terraform（A11）─▶ Access のアプリとポリシー
```

### 5.3 攻撃者・経路と影響範囲

| # | 攻撃者・経路 | 何ができるか | 影響範囲 | 主な対策 |
|---|---|---|---|---|
| T1 | 署名鍵の漏洩（secret の流出・鍵を作った端末・CI） | 任意の sub・タグ・SourceIdentity の JWT | その issuer を信頼する全アカウント × 信頼ポリシーが許すロール | 鍵の分割（§2.2）。Admin は KMS。発行記録と CloudTrail の突き合わせ（portal §10.3）。停止（§6） |
| T2 | Cloudflare アカウントの管理者（悪意・乗っ取り） | Worker の差し替え・secret の読み出し・Access の緩和・Routes の差し替え | T1 + T10 | 管理者を最小にし、ハードウェアキーの MFA。デプロイは CI と承認から。Cloudflare の監査ログを外部へ送り通知。Admin の鍵は KMS（持ち出せない） |
| T3 | Worker のバグ | AUD とチームの取り違え、入力の注入、CSRF、URL のログ出力。入口の表示用の照合（U2）の誤り | 1 つの issuer の範囲で、信頼ポリシーが許す値に限られる。表示用の照合の誤りは表示だけ（発行はチームのアプリと AUD で決まる） | fail-closed、許可リストの照合、POST + CSRF トークン（portal §9）。入口と一覧を共通にしても、Admin の発行は別のオリジンの別の Worker だけが行う（Standard の画面の欠陥で動くスクリプトが Admin の発行を呼べないように。P1'） |
| T4 | Entra のグループの改ざん | 自分をチームのグループに入れる | そのチームが割り当てられた全アカウント | 所属変更の通知・アクセスレビュー。Admin の階層は role-assignable グループと PIM（G3・G5 で扱う。ライセンスは要確認） |
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
| **T15** | **`aws login --remote` のフィッシング**（攻撃者が始めた `--remote` の URL を利用者に開かせ、表示されたコードを渡させる） | 攻撃者の端末で、その利用者のロールの認証情報を更新し続ける | Viewer の権限を、ロールの上限の時間まで（更新が止められるまで） | Viewer だけに許す（Administrator は `localhost` だけで、`--remote` は Admin の階層の守りの部品の Deny。§4.4）。確認画面にはアカウントとロールが出るが、要求元の端末は出ない。案内（自分で始めた URL だけ開く・コードを渡さない・一覧で選ぶセッションを確かめる）、CloudTrail の `client_id = devtools/cross-device` の通知（② で組む。事後の検知）。止めるのは L3・L3-1（`--remote` の更新も止まる。§6.1） |

### 5.4 対策

**A10（種類の定義のリポジトリと StackSets の CI ロール）**

| 対策 | 内容 |
|---|---|
| リポジトリ | private。保護ブランチ（直接の push と force push を禁止、マージは PR だけ、管理者も例外にしない）。CODEOWNERS で設定ファイル・テンプレートの生成物・CI の定義を必須レビューにする |
| 差分の検出 | Admin の階層の割り当てが広がる差分、どの階層でもロールの `permissions` か `tier` が変わる差分を、CI が検出して PR に印を付ける（portal §11.5） |
| 承認の人数 | 利用者の決定は「承認 1 人・レビュー担当は利用者本人」。**利用者本人が書いた PR は本人が承認できない**（GitHub は作成者の承認を数えない）ので、実際には管理者の例外か承認なしのマージになりやすい [推測]。cto の決裁: **段階 1 に限り受け入れる**（2026-11-12 の付け替えで G5 の前まで）。本人以外の承認（G-14）は G5 の前に足す |
| CI のロール | **② と ③ の Viewer の配布の間は検査用（読み取りだけ）のロールだけを作り、適用用は作らない**（配布は手作業。§4.1・§7.2 の (6)）。そのあと適用用を作るとき: GitHub Actions の OIDC で引き受け、信頼ポリシーで `sub` をリポジトリの保護ブランチ（または承認つきの environment）に限る。PR の検査用（読み取りだけ）と適用用を分ける。適用用は `awsbridge-console-*` の StackSet の操作だけを許し、管理アカウントではなく **StackSets の委任管理者のアカウント**に置く [推測: 委任管理者で service-managed の全操作ができるかは N11 で確かめる] |
| 検知 | CI 以外からの StackSet の作成・更新・削除（CloudTrail）を通知する。定期のドリフト検出（portal §11.5） |
| 防止 | 基準はロールだけで成り立たせる: 守りの部品（§4.8）で、`/awsbridge-console/*` のロールとコンソールログイン用のプロバイダーへの書き込みを Deny する（事故防止。Administrator は外せる）。管理外・単独のアカウントでは、先方の管理者の変更はドリフトの検知と契約で扱う。**管理下のメンバーアカウントでは任意の追加の層として** SCP で同じ変更を StackSets の実行ロール以外に Deny できる（N11 で書き方を確かめる） |

**A11（Access の Terraform と適用権限）**

| 対策 | 内容 |
|---|---|
| API トークン | Access のアプリとポリシーの書き込みだけ（Workers・DNS の権限を持たせない）。CI の secret（承認つきの environment）に置き、適用はマージ後の CI だけ。人の手元に置かない |
| state | 置き場所への書き込みを CI に限る。state は秘密を含まないが、AUD とポリシーの ID を含むので private にする |
| 検査 | §4.6 の検査を PR・マージ後・定期に実行する。違えば Worker のデプロイを止める |
| 検知 | Cloudflare の監査ログ（Access のアプリ・ポリシー・IdP の変更）を外部に送り、CI のトークン以外の変更を通知する |
| 会社で Administrator を配る前に見直す（行き先は決裁に明記なし。[推測] U-7 と同じ G5 の前） | Admin の階層の Access アプリを別の Cloudflare アカウント（または別の Terraform の state とトークン）に分けるか |

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
| `aud` が複数・未知 | 発行しない（`unknown_audience`） | 単体テスト（1a の前の条件 (3)。G2） |
| 失敗時 | 判定に使う値が読めない・壊れているときは発行しない（fail-closed） | 単体テスト |

**Cloudflare の信頼基盤**（A13〜A16、T12・T13）: DNS・Routes・デプロイ権限は署名鍵と同じ重さの信頼基盤として扱う [資料: Sol のレビューの指摘 3]

| 対策 | 内容 |
|---|---|
| 権限 | DNS・Routes・Custom Domains・Workers のデプロイの権限を持つ人と API トークンを最小にする。Access の Terraform のトークン（A11）にこれらの権限を持たせない |
| 検知 | Cloudflare の監査ログ（DNS・Routes・Custom Domains・Workers のデプロイ・API トークンの作成）を外部に送り、CI 以外の変更を通知する。issuer の discovery と JWKS を定期に取り、期待した鍵（`kid` と公開鍵）と一致することを見張る |
| ビルド | 依存パッケージを固定し（lockfile）、ビルドとデプロイは CI だけで行う。デプロイ用のトークンは承認つきの environment に置く |
| 復旧経路 | Cloudflare アカウントの管理者の email と MFA の復旧手段を、ハードウェアキーと管理された email に限る。復旧の手順を break-glass と一緒に書く |
| Entra 以外のログイン（A17） | 設定するなら次の 3 つを満たす: (1) **フィッシング耐性のある MFA（ハードウェアキー）を必須**にする。ID/パスワードだけ・SMS・TOTP は認めない。(2) そのログインの**使用に気付ける**ようにする（Cloudflare の監査ログの通知。ログインの成功を外部に送り、通知する）。(3) **SSO を強制しているドメインで別のログインがどう扱われるかを、Cloudflare の文書で確かめてから設定する**（強制が別のログインを塞ぐのか、塞がないのか）。確かめる前に設定しない [未検証]。復旧経路（上の行）と合わせて、この入口の資格情報もハードウェアキーと金庫で管理する |
| Admin の分離 | Admin の発行は別のオリジン・別の Worker（P1'。§3.1）。issuer のホストを Standard と同じにする場合は、`/admin` の振り分けの設定を変えられる者を最小にする。Cloudflare アカウントを分けるか（U-7）は G5 の前。Admin の発行の詳細は [console-login-admin.md](console-login-admin.md) |

**その他（前の上申からの持ち越し）**

- 管理アカウントにはコンソールログイン用ロールを置かない（SCP が効かないため [確認済み: AWS Organizations の文書]）
- Admin のロールの MaxSessionDuration を短くする（cto の決裁 D6）
- 耐フィッシング MFA は Entra の条件付きアクセスで要求する（コンソールログイン用の Access の IdP 連携に専用のアプリ登録を使う案。会社の Entra の運用次第 [推測]）

### 5.5 侵害の種類 × 対策の早見表

| 侵害 | 最初の一手 | 発行済みのセッション | 新しい発行 | 復旧 |
|---|---|---|---|---|
| 利用者 1 人 | Entra で無効化、チームのアプリのトークンを失効（L1。拒否を確かめて完了） | `aws:SourceIdentity` を条件とする明示の Deny（L3-1。成立。§6.1）。値は発行時点の email と、Entra で調べた過去の email（改名の履歴）の全部（§6.3） | Access で止まる（拒否を確かめる） | Deny はロールの最長のセッションが切れるまで外さない（§6.3） |
| Worker のバグ | 停止スイッチ（§6.1 の L0） | 影響したロールを revoke | 止まる | 修正して再デプロイ |
| 署名鍵の漏洩・Cloudflare の管理者 | プロバイダーの削除（新規を止める）。Cloudflare の操作に頼らない | 新規を止めてから revoke（解除は §6.3 の条件を満たしてから） | プロバイダーの削除で止まる | 新しい鍵と世代つきの新しいパス（§3.1。同じ URL での作り直しは N5 の結果次第） |
| A10（設定・CI ロール） | CI のロールを無効化（信頼ポリシーの変更）。疑わしい StackSet の操作を止める | 広げられたロールを revoke | 設定を正しい版に戻して再適用 | — |
| A11（Access） | トークンの失効と Access の変更の巻き戻し、チームのアプリのトークンを失効 | 該当チームが入れるロールを revoke | Access が正しく戻れば止まる | — |

### 5.6 発行記録と CloudTrail の突き合わせ

- 自前の JWT の `jti` は、CloudTrail の `AssumeRoleWithWebIdentity` のイベントの `requestParameters.webIdentityTokenId` に入る（開発環境の N6 で 28/28。1 回の測定 [確認済み: N6。console-login-admin.md §8]）。前の版の「`jti` は CloudTrail に引き継がれない」は訂正した。突き合わせは、発行記録に残す **`jti`**（主なキー。Standard と Admin の両方の発行記録に残す）と、**STS の応答の `AccessKeyId`・`AssumedRoleUser.AssumedRoleId`・要求 ID（RequestId）** で行う（portal §10.3、console-login-admin.md §8 と同じキー）[資料: cto の決裁（1a の前の条件 (5)）・Sol のレビューの指摘 9]
- 発行記録には、SourceIdentity に使った値（email）に加えて、**Access JWT の `sub` と、取れれば Entra の `oid`** も残す（cto の決裁 2026-11-12）。email の変更・再利用のあとでも、誰の発行かをたどれるようにするため。将来 SourceIdentity の値を `oid` に移す場合（§9.2 の U-3。将来の選択肢）の対応表にもなる
- **人の特定**（監査の手順）: CloudTrail の SourceIdentity（email）だけで人を決めない。同じ email が時期によって別の人のものになりうる（再利用）・同じ人の email が変わりうる（改名）ため、**発行記録（時刻・email・Access の `sub`）と Entra の記録（その時刻にその email を持っていた人、改名の履歴、在籍）を合わせて特定する** [資料: cto の決裁 2026-11-12「会社の Entra でも SourceIdentity は email」]
- 照合: CloudTrail の `AssumeRoleWithWebIdentity` のイベントの `requestParameters.webIdentityTokenId` を発行記録の `jti` で引く（主）。あわせて `requestID`・`responseElements.credentials.accessKeyId`・`responseElements.assumedRoleUser.assumedRoleId` を発行記録の 3 つの値で引く。**発行記録にない引き受け**は、鍵の漏洩か Worker の外からの発行を疑う。その後の API のイベントは `accessKeyId` と SourceIdentity でたどる [推測: CloudTrail のフィールド名は突き合わせ（1a-4。最初は ②）で確かめる]
- 発行記録と CloudTrail の突き合わせ（1a-4）は、② と会社の G4・G5 の条件にする（§7.3）。Admin の発行では、KMS の Sign の記録とも突き合わせる（[console-login-admin.md](console-login-admin.md)）

---

## 6. 緊急停止と break-glass

### 6.1 停止手段（実測と未検証）

| # | 手段 | 止まるもの | 実測 | 基準の停止で使うか |
|---|---|---|---|---|
| L0 | ポータルの停止スイッチ（Worker の変数。POST を 503 `login_disabled`。portal §10.2） | 新しい発行（鍵が漏れていなければ）。**発行済みの AWS のセッションは止めない** | 未測定（Worker の設定の反映） | 使う |
| L1 | Access: チームのポリシーから外す（会社では Entra のグループから外す）→ チームのアプリのトークンを失効（`revoke_tokens`）→ **拒否されたことを確かめて完了**。またはアプリのセッションの期限切れ | その人の新しい発行。**発行済みの AWS のセッションは止めない** | ポリシーの伝播は約 20 秒では足りず、約 2 分 15 秒で反映。失効か期限切れのときに IdP の再ログインなしで判定し直された [確認済み: N10。Google の IdP] | 使う。**固定の待ち時間で完了にしない**（§6.4） |
| L2 | OIDC プロバイダーの削除 | 新しい引き受けだけ（発行済みは使えたまま） | 約 12 秒 [確認済み: P4(b)] | 使う |
| L3 | ロールの Revoke Sessions（`AWSRevokeOlderSessions`） | 発行済みの STS 認証情報・コンソール・`aws login` の更新（`--remote` を含む） | STS と `aws login` は約 8 秒、コンソールは約 1 分以内。`aws login` の更新も拒否され、20 分戻らなかった。**外すと約 17 秒で古い認証情報が復活する** [確認済み: P4(a)]。Viewer の形のロールの `--remote`: 8 秒で拒否、更新も約 21 分拒否、外すと約 20 秒で戻る [確認済み: 2026-11-12 の再試験] | 使う。**新規の発行を止めてから付け、解除は §6.3 の条件を満たしてから** |
| L3-1 | 1 人だけの停止: ロールの権限ポリシーに、`aws:SourceIdentity` がその人の値のときの明示の Deny（`aws:TokenIssueTime` と組み合わせてもよい） | その人の発行済みと新規のセッション（同じロールのほかの人は止めない） | **成立**（1a の前の条件 (4)、2026-11-11）: 1 人目の STS・新しい引き受け・`aws login`（更新を含む）が約 11 秒、コンソールが 48 秒以内に止まり、2 人目は止まらない。外すと 7〜20 秒で戻る。CloudFormation の外のインラインポリシーはスタックの更新 2 回で残った（置換は未実測）。Viewer の形のロールの `--remote`: 10 秒で拒否、更新も約 18 分拒否、外すと約 13 秒で戻る（2026-11-12）[確認済み: `scripts/poc/human/README.md`。資料: Sol のレビューの指摘 4。管理外のアカウントにも使える] | 使う。値は発行時点の SourceIdentity（段階 1 は email。§6.3） |
| L4 | SCP（`/awsbridge-console/*` を `aws:PrincipalArn` で Deny、または `aws:SourceIdentity` で個人を Deny） | 発行済みと新規の両方 | **未検証**（N3。PoC のアカウントは管理アカウントで SCP が効かない） | **任意**。管理下のメンバーアカウントだけで使える追加の層で、基準の停止の手段にしない（§6.5） |
| L5 | 鍵の差し替え | — | 同じ URL での作り直しで JWKS のキャッシュが捨てられるかは未検証（N5） | Standard の Workers secret の鍵は「止めたまま、世代つきの新しいパスで新しい鍵を用意する」でよい。Admin（KMS）の鍵の差し替えと `DisableKey` は [console-login-admin.md](console-login-admin.md) |

- 秒数は 1 アカウント・1 ロールで 1 回測った値。複数アカウントでの所要時間は測っていない（② と会社の訓練で測る）。**どの手順も、固定の待ち時間ではなく、拒否されたことを確かめて完了にする**
- 基準の停止は L0〜L3 と L3-1（SCP に頼らない）。**L0・L1・L2 は新しい発行・引き受けを止めるだけで、発行済みの AWS のセッション（STS の認証情報・コンソール・`aws login`）は止めない**。発行済みを止めるのは L3・L3-1 だけ。自前の JWT（約 5 分）が残っていれば、L2 の前なら引き受けに使える [資料: Sol のレビュー 2026-11-12 の E]
- revoke も L3-1 の Deny も、リフレッシュトークンを無効にしない。外すと、`aws login` は次の更新で同じリフレッシュトークンから新しい認証情報を取り、**再ログインなしで戻る** [確認済み: 2026-11-12 の再試験]。外す時機は §6.3
- revoke・Deny・プロバイダーの削除は、CloudFormation の外の変更ならドリフトになる。次の §6.3 のとおり管理する。revoke を付けたままでもスタックの削除は通った [確認済み: P4]

### 6.2 手順（鍵の漏洩・Worker の侵害）

1. **新しい発行を止める**: L0。鍵の漏洩が疑われるときは L0 では足りない（鍵があれば Worker なしで署名できる）ので 2 へ進む
2. **新しい引き受けを止める**: 対象のアカウントのプロバイダーを削除（L2）。対象が数アカウント（② と ③ の最初）なら手作業かスクリプトでよい。広げたあとは一括の配布（§6.7・N8）。Admin の鍵が KMS なら、先に `DisableKey` で新しい署名を止められる（[console-login-admin.md](console-login-admin.md)）。止まったこと（新しい引き受けが拒否されること）を確かめる
3. **発行済みを止める**: 新規の発行が止まったことを確かめて**から**、対象のロールに revoke（L3）。止まったこと（権限の要る API が拒否されること）を確かめる。先に revoke すると、止める前に発行された新しいセッションが revoke の時刻より後になり、止まらない
4. **調べる**: 発行記録と CloudTrail の `AssumeRoleWithWebIdentity` を、STS の応答の `AccessKeyId`・`AssumedRoleId`・RequestId で突き合わせ（§5.6）、発行記録にない引き受けを探す
5. **戻す**: 原因を取り除く → 新しい鍵と世代つきの新しいパスでプロバイダーを作る（§3.1）→ 古い鍵が JWKS とプロバイダーに残っていないことを確かめる → L0 を戻す → §6.3 の解除の条件を満たしてから revoke を外す

利用者 1 人の停止: L1（ポリシーから外す → 失効 → 拒否を確かめる）。発行済みのセッションは L3-1（その人の SourceIdentity の Deny）で止める。**その人の過去の email（改名の履歴）を Entra で調べ、今の email と合わせて全部を Deny に書き、拒否を確かめて完了にする**（改名の前の email で発行されたセッションの止め漏れを防ぐ。新しい発行は L1 で止まるので、止め漏れが残るのは最長のセッションまで）[資料: cto の決裁 2026-11-12]。退職・端末の紛失など**戻してはいけない停止**は、Entra 側の停止（アカウントの無効化・グループから外す）と合わせる（L3-1 の Deny だけでは、外したときに戻るため）。

### 6.3 revoke と Deny の管理と解除の条件

[資料: cto の決裁（1a の前の条件 (4)）・Sol のレビューの指摘 5]

| 項目 | 内容 |
|---|---|
| 付ける順 | **新規の発行を止めてから** revoke を付ける（§6.2 の 2→3） |
| 消えないこと | revoke（`AWSRevokeOlderSessions`）と L3-1 の Deny が、**通常のデプロイ（StackSets の更新）・ロールの作り直し・ドリフトの修復で消えない**ように管理する。CloudFormation が管理しないポリシー名を使い、更新とドリフトの修復で消えないかを 1a の前の条件 (4) で確かめる。消えるなら、テンプレートのパラメーターで持つ形（§6.7）に寄せる |
| 記録 | 付けた時刻・対象・理由を記録し、定期にロールのインラインポリシーの一覧を取って、付いたままのものを見張る |
| 解除の条件 | 時間（最長のセッション + 余裕）が過ぎたことだけでは外さない。**原因の除去**（漏れた鍵・侵害された経路の排除）、**古い鍵の排除**（JWKS・プロバイダーに古い鍵が残っていない）、**新規の発行ができないことの確認**（止めた経路で新しいセッションが作れない）の 3 つを満たしてから外す。外したあと、古い認証情報が復活しない（拒否される）ことを確かめる |
| **ロールの置換** | revoke や `aws:SourceIdentity` の Deny を CloudFormation の外で付けている間は、**ロールの置換を伴う更新（`Path`・`RoleName` の変更など）をしない**。**ドリフトの自動修復もしない**。開発環境の実測（2026-11-11）では、その場での更新 2 回ではインラインポリシーは残ったが、ロールの置換では消える（CloudFormation の `AWS::IAM::Role` の仕様。置換は実測していない）。配ったあとにロールの名前とパスを変えないという条件（§3.3）と同じ理由。付けている間にやむを得ず置換するときは、置換のあとにポリシーが残っているかを確かめ、消えていたら付け直す |
| 注意 | `getSigninToken` の成功は、コンソールのセッションが 12 時間続くことの証明ではない（N2）。revoke の期間はロールの `MaxSessionDuration` から決める |
| **最長のセッションが切れるまで外さない** | revoke（L3）も 1 人停止の Deny（L3-1）も、**そのロールの最長のセッション（`MaxSessionDuration`）が切れるまで外さない**。外すと、発行済みのセッションと `aws login` が再ログインなしで戻る（§6.1）。上の解除の条件はこれに加えて満たす [資料: cto の回答 2026-11-12] |
| 1 人停止の値 | SourceIdentity は email（§3.4）。Deny には**発行の時点の email** を書く。加えて、**その人の過去の email（改名の履歴）を Entra で調べ、全部を Deny に書き、拒否を確かめて完了にする**。停止の前後で email が変わった（改名）ときも、**旧と新の両方**を書く（書き漏れは止め漏れになる） |
| 退職者の Deny | 退職者の 1 人停止の Deny は、最長のセッションが切れるまで残してから外す。**残し続けると、同じ email を再利用した別の人が止まる**（止めすぎ）。Entra 側の停止と合わせる（§6.2） |
| email の再利用 | **会社に入る前（③ の G3 の前）に確かめる**: 会社で email を再利用しないか（退職者のアドレスを別の人に割り当てないか）。再利用するなら、**再利用までの期間がロールの最長のセッションより長いか**。再利用するなら、上の Deny の外し忘れで別の人が止まり、外すのが早すぎると退職者が戻る。監査では、同じ email の操作が時期によって別の人のものになる（読み違い。人の特定は §5.6）[資料: cto の決裁 2026-11-12] |
| 置き場所 | 1a の前の条件 (4) で確かめたのは、CloudFormation の外のインラインポリシーの形。守りの部品（§4.8）に置く形は、版の更新の反映を ① の PoC で測り、② で確かめる（§7.4・§7.5）。最初の配布でどちらにするかは未決（§9.2 の U-15） |

**email を SourceIdentity に使うことの受容**（人の承認。利用者が同意、2026-11-12）。文面:

> SourceIdentity に email を使う。email の改名や再利用があると、1 人停止の対象がずれうる。また、同じ email の操作が時期によって別の人のものになる。改名は旧新の両方で止め、再利用はしない運用で扱い、人の特定は発行記録と Entra の記録を合わせて行う。

再審議の条件（cto の決裁）: 改名・再利用で止め漏れか読み違いが実際に起きたとき / 認可で email を使うことになったとき / 会社が短い期間で email を再利用すると分かったとき。

### 6.4 チームのアプリのセッションの長さ（推奨）

所属を外した人がポータルから発行できる最長の時間は、おおよそ「Entra の反映 + Access のポリシーの伝播 + **チームのアプリのセッションの長さ**（失効を忘れた・失効が効かなかったとき）」になる。時計は 5 つある（Entra の反映、Access の再評価、Access JWT の期限・失効、自前の JWT の期限、STS・コンソール・CLI の有効期間）[資料: Sol のレビューの指摘 7]。

| 項目 | 推奨 | 根拠 |
|---|---|---|
| チームのアプリ（Standard） | **15 分** | PoC で、15 分のセッションの期限切れのあと IdP の再ログインなしにポリシーで判定し直され、拒否された [確認済み: N10 の (b)]。グローバルのセッション（IdP のログイン）が残っていれば利用者に再ログインは出ないので、短くしても使い勝手は落ちにくい。5 分は試していない [未検証] |
| 入口のアプリ | チームのアプリと同じか長め（入口では発行しない） | [推測] |
| Admin の階層のチーム | Standard より短く（例 5〜15 分。PIM と合わせて決める。PIM は G3・G5。Admin のセッションの長さは [console-login-admin.md](console-login-admin.md)） | [推測] |
| 発行済みのセッション | アプリのセッションでは止まらない。ロールの `MaxSessionDuration` まで残る。止めるには L3（L3-1） | P4(a) |

- L1 の手順は「外す → 失効 → 拒否を確かめる」とし、上の時間は**失効を忘れたときの上限の目安**として使う。2 分 15 秒（伝播）は 1 回の測定で、保証値にしない
- Entra では、直接のメンバー・入れ子のグループ・アカウントの無効化・IdP のセッションが残っている場合の拒否を、1a-2 で確かめる（§7.3。G4）

### 6.5 SCP の扱い

**SCP に頼らない**（cto の決裁 2026-11-12。異論なし）。SCP は「すべての機能」を有効にした Organization のメンバーアカウントにだけ効き、管理アカウント・単独のアカウント・他社の Organization のアカウントには自社は掛けられない [確認済み: AWS Organizations の文書]。単独のアカウントや先方のアカウントも対象にするので、守りと停止の基準は、ロールとプロバイダーのスタックだけで成り立たせる（§4.8、停止は L0〜L3 と L3-1）。SCP（L4）は**管理下のメンバーアカウントで重ねる任意の層**に下げ、合格条件にしない。N3 も任意に下げる（管理下のメンバーアカウントだけで確かめる）。

② の個人の Organization と会社の管理下の Organization のメンバーアカウントでは、任意の層として試すことはできる。

- 案 S-a: 停止の訓練（② か会社）で、停止用の SCP（§3.5 の名前）を 1 つのアカウントに付けて、所要時間と `aws login` の更新の拒否を測る（N3 の一部）。SCP の作成と付与は人の承認が要る
- 案 S-b: 訓練は L0〜L3 だけで組み、SCP は N3 で別に確かめる

作成者の案は S-a（前の版のまま）。SCP は任意の層になったので、どちらを選んでも合格条件には影響しない。SCP を訓練に含めるかは未決のまま（§9.2 の U-5）。

### 6.6 Entra を通らない停止の経路

Entra（と Cloudflare・CI）が使えないときにも、発行の停止・プロバイダーの削除・revoke・ログの確認ができる経路が要る。前の版は「段階 3 まで待たず、段階 1 の条件にする（既存の非常用の経路の流用でもよい）」。2026-11-12 の付け替えで、**会社で G5 の前（または会社で Viewer を全アカウントに広げる前）の条件**になった。② の個人の環境の条件にはしない（E0 は会社の話）[資料: cto の決裁・Sol のレビューの指摘 6・cto の決裁 2026-11-12]。

cto の決裁: **E1 か E0 のどちらかを利用者が選ぶ**。**利用者は E0 を選んだ**（2026-11-11）。「**段階 1 では、Entra を通らない停止経路が無いことを受け入れる**」と明示した。

| 案 | 内容 | 条件 |
|---|---|---|
| E1 減らす側だけの受け口ロール | 停止専用の入口から、各アカウントの受け口ロールに入って次だけを行う: (1) 固定の Deny 管理ポリシーを `/awsbridge-console/` 配下のロールに attach する（`iam:AttachRolePolicy` を `iam:PolicyARN` の条件でその管理ポリシーに限る）、(2) コンソールログイン用の OIDC プロバイダーの削除、(3) 最小の読み取り。**`PutRolePolicy`・`DeleteRolePolicy`・`DetachRolePolicy`・StackSets の操作は入れない**（停止を外す・広げる操作を持たせない）。受け口ロール自体は `/awsbridge-console/` の**外**に置く（自分を止める Deny の対象にしない）。MFA 必須、使用を通知する | 開発用アカウントで 3 点を確かめることが採用の条件 |
| E0 経路を持たずに始める | Entra の障害・侵害時は復旧まで止められないことを、利用者が受容を明示する（受容の文面は「段階 1 では」） | 付け替え後は G5 の前（または会社で Viewer を全アカウントに広げる前）まで |

**E0 の受容の範囲と中身**（人の承認。利用者の明示: 2026-11-11）

- 範囲: 受容したときは**段階 1（1a・1b）に限る**、段階 2 で失効する、だった。2026-11-12 の付け替え（§7.7）で、**E0 は G5 の前（または会社で Viewer を全アカウントに広げる前）に失効する**。それまでに、Entra を通らない停止経路を用意し、実際に 1 回操作して確かめる（G5 の合格条件。§6.7・§7.6・§9.2 U-1）。利用者の受容の文面は「段階 1 では」のままで、付け替え後の範囲について受容を取り直したかの記録はない
- 受容の中身: Entra の障害・侵害のときは、復旧まで止められない経路がある。**Cloudflare のダッシュボードに Entra を通らないログインが設定されるまでは、L0・L1 も Entra に依存する**（L0 は Cloudflare の Worker の設定、L1 は Access のポリシーと Entra のグループの操作で、どちらも Cloudflare のダッシュボードまたは Entra を通る）。L2・L3 は各アカウントの IAM の操作なので、AWS 側に別の入口（管理者のログイン）があれば Entra に依存しない。ただし管理アカウントのルートの認証情報の保持者は未回答（§9.2 U-10）
- 利用者の確認（2026-11-11）: 受容には、Cloudflare に Entra 以外のログインを設定するまで L0・L1 も Entra の障害・侵害時に使えないことも含まれる
- API トークンでの L0（wrangler）が Entra を通らない可能性は未確認。確かめれば、E0 の実際の欠落が「L0 も不可」か「L2・L3 だけ不可」かが分かる（§9.2 U-11）
- Cloudflare のダッシュボードに Entra 以外のログインを設定するなら、新しい入口になる。資産と条件は §5.1 の A17 と §5.4
- 1 人の停止（L3-1）と、E1 の固定の Deny 管理ポリシーは別物。E1 の Deny はロール全体を止める

### 6.7 会社で広げる前・Administrator を配る前に決めること

- **Entra を通らない停止経路（G5 の合格条件）**: E0 の受容は G5 の前（または会社で Viewer を全アカウントに広げる前）まで（§6.6）。それまでに、Entra を通らない停止経路（E1 の直した形など）を用意し、**実際に 1 回操作して確かめる**。E1 の元の案は開発用アカウントで 3 点を確かめることが条件（§6.6 の表）。② の合格条件と G3 には含めない
- 全アカウントへの停止の一括配布（テンプレートに停止の印を持たせ、StackSets でプロバイダーの削除と revoke を一度に配る案）。所要時間は N8 で測る [推測: 設計の案]
- revoke をテンプレート（`aws:TokenIssueTime` の Deny をパラメーターで付ける）で持つか、CFN の外の操作にするか（1a の前の条件 (4) の結果で決める）

### 6.8 break-glass

| 選択肢 | 内容 | 扱い |
|---|---|---|
| B1 既存の Identity Center（Entra に直結。管理下） | **消さない**。コンソールログイン用の仕組みは追加の入口として入れる | ログインの代わりにはこれで足りる（会社の Viewer の間も、IC は並行して残る）。ただし Entra を通るので、停止の経路にはならない（§6.6） |
| B2 Organization ごとの break-glass の IAM ユーザー（管理アカウント、ハードウェアキー、金庫、使ったら通知） | IdP（Entra）の障害にも備える | 会社で Administrator を配る前に整える（前の版は「段階 3 の前」。行き先は決裁に明記なし。[推測] G5 の前）。作るかは人の承認 |
| B4 管理外 | 先方自身の入口。自社が先方に入る break-glass は持たない | 対象外（顧客のアカウントは「完了」の外。前の版は「段階 4」） |

- break-glass の手順はポータルの外に置き、ポータルにはリンクだけを置く（portal §10.2）
- 採否は人の承認（cto の決裁 D7）

---

## 7. 段階導入: ① 完成 → ② 個人で導入・試験 → ③ 会社に導入

cto の決裁（2026-11-12。D8 の段階導入の書き直しを条件付きで承認）。利用者は次の 3 点を確かめた（2026-11-12）: ① の完成に Administrator を含める / ② の個人の環境にも Administrator を配る / 顧客のアカウント（他社の Organization・単独のアカウント）は「完了」の外。前の段階の定義（段階 1（1a・1b）→ 段階 2 → 段階 3）と、その書き直し案（§9.2 の U-13）は、この節で置き換えた。

**原則**: ゲートが縛るのは**配る範囲**（誰に、どの強さのロールを、どのアカウントに）で、コードの完成ではない。作るのと配るのを分ける。Administrator のコードは ① で作るが、会社で Administrator を配るのは G5 のあと [資料: cto の決裁 2026-11-12]。

### 7.1 区切りとゲート（G1〜G5）

| 区切り | 中身 | ゲート |
|---|---|---|
| ① 完成 | コードベースで完成させる。Viewer と Administrator の両方（中身は §7.4）。開発環境の PoC を含む | **G1**（① の実装の前。再上申）: Admin 側の発行の設計（KMS の署名、Worker が KMS を呼ぶ認証情報の持ち方、別の Worker と発行のオリジン、鍵の差し替え）。**N6 の PoC を最初に行う**。P1・P2、D2 の「別リポジトリの見直し」も扱う。Sol のレビューを取る。資料は [console-login-admin.md](console-login-admin.md)。**G2**（① の完成。再上申）: 最終の技術レビュー。Sol のレビューを取る |
| ② 個人で導入・試験 | 個人の Organization のメンバーアカウントに、Viewer と Administrator を配って試す（§7.5） | 再上申なし。**G2 の合格と人の承認**で始めてよい。結果は cto に報告する |
| ③ 会社に導入 | 会社の Entra・Access・アカウントに配る。**Viewer を先、Administrator を後**（§7.6） | **G3**（会社で Viewer を配る前。再上申）。**G4**（会社の Viewer を広げる前。報告でよい）。**G5**（会社で Administrator を配る前。再上申。Sol のレビューを取り、Astra を取るかは G5 で判断する） |

- **完了**: ③ で会社に導入して完了とする。顧客のアカウント（他社の Organization・単独のアカウント）は「完了」の外。管理外の境界（`partner:<id>`）の設計は残すが、配る予定は決めていない
- **MCP の統合**（MCP 用のロールと CloudFormation を 1 つにまとめる新しいセット、Viewer の共有、F2、M2-MCP）は ① に含めない。別の上申にする。利用者の回答（2026-11-12）: M2-MCP と MCP の統合には**まだ着手しない**。Viewer を MCP と共有するかだけは G3 までに決める（§2.3）
- 再審議の条件（cto の決裁）: 利用者の意図が違ったとき / N6 が成り立たないとき / ② で停止か突き合わせが不合格のとき / 会社が Viewer と Administrator の同時の配布を求めたとき

### 7.2 引き継いだ条件（旧「1a の前の条件」(1)〜(6)）

段階 1 のゲートの cto の決裁が「1a の前」に求めた条件。新しい区切りに引き継いだ（cto の決裁 2026-11-12）。名前は識別子として残す（PoC の記録と決裁が名前で引くため）。行き先: (1)(2)(4)(5) は成立・反映済みのまま引き継ぐ。**(3) の単体テストは G2**（① の完成）で確かめる。**(6) は ② と ③ の Viewer の配布の間**の条件にする。

| # | 確かめること | 合格の基準 | 不成立のとき |
|---|---|---|---|
| (1) | **書き直し版**（cto の決裁 2026-11-12）: Viewer と同じ形のロール（§4.4 の (1)。`localhost` と `remote` だけを許す）で、同じ端末の `aws login` と `--remote` の**両方が通る**。前の版は「localhost だけのポリシーで `--remote` が拒否される」で、2026-11-11 に成立していた | どちらも通る。`--remote` に L3・L3-1 が効き、更新も止まる | `aws login` を案内しない（コンソールだけで運用する）。`--remote` に L3・L3-1 が効かなければ Viewer も `localhost` だけに戻す |
| (2) | コンソールログイン用の Worker の workers.dev・Preview URL を無効にし、ほかの Route がないことを設定とテストで示す。Access を経由しない経路への、偽の `Cf-Access-Jwt-Assertion` と失効済み JWT の持ち込みで発行されない | 応答しない、または 401。どの経路でも発行されない（応答しない・Access で 302 も可） | 配らない。Admin の Worker と Admin のオリジンも同じ条件にする案 [推測: 決裁は Standard の Worker について書いた。① で確かめる] |
| (3) | `aud` が複数・未知なら発行しない。失敗時は閉じる | 単体テストが通る（portal §9.3 の 2）。**G2 で確かめる** | [推測] ① を完成としない（G2 の条件） |
| (4) | revoke と `aws:SourceIdentity` の Deny が、CloudFormation の更新（通常のデプロイ・ロールの作り直し・ドリフトの修復）で消えないか。1 人の停止（L3-1）までの時間 | 消えない（または消えない管理の形が決まる）。所要時間を記録する | 1 人の停止は「ロール全体の revoke」で運用する（§6.1）。消えるなら §6.3 の管理を見直す |
| (5) | 設計書の改訂（発行記録は `AccessKeyId`・`AssumedRoleId`・RequestId で突き合わせる、AUD → チームは認可の設定として保護する、段階 1 の ReadOnly（今の Viewer）の中身、チームのアプリのセッションの長さ、L1 は拒否を確かめて完了） | この文書（§5.1 の A12・§5.4・§5.6・§4.7・§6.4・§6.1）と portal §9.3・§10.3 に反映した | — |
| (6) | **② と ③ の Viewer の配布の間は**、CI に StackSets の適用権限を持たせない（手作業で配る、CI は検査だけ） | 下流の CI のロールが検査用だけであること | 配らない |

**結果**（開発環境）: (1) 書き直し版は**成立**（2026-11-12。同じ端末と `--remote` の両方が通り、`--remote` に L3・L3-1 が効いて更新も止まった。§4.4・§6.1）。(2) **成立**（2026-11-11。workers.dev は応答せず、API で workers.dev・Preview の無効と Custom Domain 1 つだけを確かめた。偽のヘッダー・Cookie と、失効した本物の Access JWT は Access で 302）。(3) PoC で判定した。本番の Worker では単体テストにする（G2）。(4) **成立**（2026-11-11。CloudFormation の外のインラインポリシーはスタックの更新 2 回で残った。置換は未実測。1 人の停止の時間は §6.1 の L3-1）。(5) 反映済み。(6) 下流で確かめる [確認済み: `scripts/poc/human/README.md`・`scripts/poc/human/portal/README.md`]

### 7.3 会社の Entra での確認と停止の訓練（旧「1a の合格条件」1a-1〜1a-4）

前の版で 1a（会社環境で運用者だけ・1 アカウント）の合格条件だったもの。名前は識別子として残し、行き先を付け替えた（cto の決裁 2026-11-12）。

| # | 確かめること | 合格の基準 | 行き先 |
|---|---|---|---|
| 1a-1 | 会社の Entra のグループ（Object ID）で M2: チームのアプリごとに AUD が分かれ、所属していないチームで拒否され、アプリ間で再ログインが要らない。**入口の一覧（U2）のための実証**: 入口のアプリの Access の身元に Entra のグループが入るか（Object ID か、直接・入れ子・ゲストの扱い、多数所属で全部そろうか、溢れたことを見分けられるか）、一覧の判定がチームのアプリの判定と一致するか | M2 は開発環境と同じ結果（portal PoC の判定基準）。U2 の実証は結果を記録する。**U2 が成り立たなくても止めない**（入口は全チームへのリンクに落とす） | **G4**（会社の Viewer を広げる前に合格していること）。G5 の合格条件にも入る |
| 1a-2 | Entra で外したときの拒否: **直接のメンバー・入れ子のグループ・アカウントの無効化・IdP のセッションが残っている場合**のそれぞれで、L1 の手順（外す → 失効 → 拒否を確かめる）で拒否される。入口の一覧（U2）に外したことが反映されるまでの時間 | どれも拒否される。所要時間を記録し、§6.4 のセッションの長さを見直す | **G4**。G5 の合格条件にも入る |
| 1a-3 | 停止の訓練: L0〜L3 と、その解除（§6.3 の条件で）。L3-1 も訓練に含める案 [推測] | 新規と発行済みが止まり、解除のあとに古い認証情報が復活しない | **②**（個人の環境で Viewer と Administrator の両方）と、会社の **G4・G5**（G5 の合格条件は「会社の Viewer で停止の訓練に合格」）。Entra を通らない経路からの操作は §6.7 の時機 |
| 1a-4 | 発行記録と CloudTrail の突き合わせ（§5.6） | すべての引き受けに発行記録があり、STS の応答の ID で一意に対応する | **②** と会社の **G4・G5**（G5 の合格条件は「説明できない引き受けがない」） |

### 7.4 ① 完成（G1・G2）

**完成の定義**（cto の決裁 2026-11-12）:

| 区分 | 中身 |
|---|---|
| 作るもの | Viewer と Administrator の参考のテンプレート（§4.3）、守りの部品（§4.8）、Standard と Admin の Worker、ポータル（1 つの一覧。U2）、生成器（§9.2 の U-19）、検査の道具（§4.9）、SourceIdentity の値の出どころの設定（§9.2 の U-14） |
| テスト | `mise run test`・`mise run lint`、負の試験、バンドルの分離の試験（portal §9.10。MCP・Standard・Admin） |
| 開発環境の PoC | N2（Administrator で `--remote` が拒否されること、セッションの長さ）・N5（JWKS のキャッシュ）・N6（KMS の署名。G1 の最初）、守りの部品の版の更新の反映（§4.8） |
| 文書 | 設計書 §7 の書き直しと、§9.2 の付け替え（この改訂） |

| ゲート | 時機 | 扱うこと |
|---|---|---|
| G1 | ① の実装の前 | Admin 側の発行の設計（[console-login-admin.md](console-login-admin.md)）。N6 の PoC の結果。P1・P2（今の設計は P1'。§3.1）。D2 の別リポジトリの見直し。Sol のレビュー |
| G2 | ① の完成 | 最終の技術レビュー（Sol）。N2・N5 の結果。(3) の単体テスト。**会社では最初から Standard も KMS にするか**を決める（D4 の言い直し。§2.2） |

- 守りの部品・検査の道具・設定に任せたロールは、**作るのは ①、測るのは ②**
- Admin 側の詳細設計（G1 の資料）: [console-login-admin.md](console-login-admin.md)

### 7.5 ② 個人で導入・試験

| 項目 | 内容 |
|---|---|
| 範囲 | 個人の Organization の**メンバーアカウント**（具体的なアカウントと数の指定はない。利用者の判断 2026-11-12）。**管理アカウントには配らない**。Viewer と Administrator の両方。Standard と Admin の Worker・KMS の鍵 |
| 構成 | 構造の要件（§4.8）は会社と同じ（所属は Access のポリシー）。チームは、前の決裁（1a を個人から）では「1 つ」だった（Viewer だけの前提）。② は Administrator も配るので、**Admin の階層のチームが別に要る見込み**（設定の生成は、Admin のロールに Standard のチームを割り当てると誤りにする。portal §11.6）[推測: 決裁に明記なし。§9.2 の U-23]。portal §11.7 の個人用の最小構成（Admin の階層を省く形）ではない。E0 と Entra を通らない停止の経路は会社の話で、② の条件にしない。稼働中の個人用 MCP と同じアカウントなら**別のスタック**にし、MCP のスタックに触らない。同じ名前のロールが無いことを配る前に確かめる [資料: cto の決裁 2026-11-12（1a を個人から）] |
| 始める条件 | G2 の合格と人の承認。cto への再上申はしない。結果は報告する |
| 人の承認（前提） | 費用（KMS・Workers・ログ）／個人のアカウントに全権の新しい入口ができる（鍵か Worker を取られると、そのアカウントの全権）／稼働中の個人用 MCP と同じ環境（別のスタックで、MCP のスタックに触らない）／メンバーアカウントだけ（管理アカウントには配らない）。**前提の 4 点は利用者が了承した（2026-11-12）**。② の導入そのものの承認は、G2 の合格のあと始めるときに取る |
| 配り方 | 引き継いだ条件 (6): CI に StackSets の適用権限を持たせない（手作業で配る） |
| 合格条件 | 決裁は「3-C の ② の行の全部と片付けの手順」とした。下の行は、行き先の表（§7.7）で ② に割り当てたものを並べた（決裁の全文はこのリポジトリの資料に無い）: (a) 停止の訓練（1a-3。L0〜L3 と解除、Viewer と Administrator。L3-1 も含める案 [推測]）(b) 発行記録と CloudTrail の突き合わせ（1a-4。KMS の Sign の記録との突き合わせを含む。console-login-admin.md）(c) 旧「1b の前の確認」（同じ端末の `aws login` の 15 分後の更新、セッションが 1 つのときの確認画面、`--remote` の発行の通知 = `requestParameters.client_id = arn:aws:signin:::devtools/cross-device`）と U-4（回数の制限と費用の見張り）を確かめる。結果は G3 に持っていく (d) 守りの部品・検査の道具・設定に任せたロールを測る（部品の付与と版、検査の道具を回す）(e) Administrator の発行記録と通知が動く (f) Admin の負の試験が通る (g) **片付けの手順**（スタック・プロバイダー・Worker・Access アプリ・KMS の鍵の削除の予約）がある |

### 7.6 ③ 会社に導入（G3・G4・G5）

**G3**（会社で Viewer を配る前。再上申）:

| 項目 | 内容 |
|---|---|
| ② から持っていくもの | 旧「1b の前の確認」と U-4 の結果（§7.5 の (c)） |
| 検査の道具を CI に | CI の読み取りロールを決める（§4.9） |
| 会社の確認 | email を再利用しないか、再利用までの期間がロールの最長のセッションより長いか（§6.3）。Viewer を MCP と共有するか（MCP の統合の上申。§2.3） |
| 人の承認 | 会社のセキュリティ承認（人のアクセスに Worker の鍵を使うこと。G3・G5）、PIM の扱い（G3・G5）、会社の Entra と Access の変更（チームのグループ・アプリ、U2 のためにグループを身元に載せる設定）、対象のアカウントでのスタックの作成 |
| 下流で確定 | ポータルのホスト・issuer のホスト（§3.1）・チームと Viewer のロールの設定 |
| 配り方 | 引き継いだ条件 (6)（CI に適用権限を持たせない）。Viewer だけ（Standard の階層。中身は §4.7）。Administrator は配らない |
| 最初の範囲 | **決裁に明記なし**。前の 1a（運用者だけ・1 アカウント）・1b（試行者・5 アカウント以下）の数は、新しい決裁に書かれていない。G3 で決める [推測] |
| Entra を通らない停止の経路 | 利用者は E0 を選んだ（§6.6）。E0 の受容の範囲は、G5 の前（または会社で Viewer を全アカウントに広げる前）まで |

**G4**（会社の Viewer を広げる前。報告でよい）:

- 1a-1・1a-2 の合格（§7.3）
- 停止の訓練と突き合わせ（1a-3・1a-4）を会社の Viewer で行う
- 全アカウントに広げる前に、N8・N11・N12（§8）。Entra を通らない停止の経路の用意と 1 回の操作は、G5 の前か、会社で Viewer を全アカウントに広げる前（§6.7）

**G5**（会社で Administrator を配る前。再上申。Sol、Astra は G5 で判断）:

| 合格条件（cto の決裁） |
|---|
| 会社の Viewer で停止の訓練に合格している |
| 突き合わせで説明できない引き受けがない |
| 1a-1・1a-2 に合格している |
| Entra を通らない停止の経路を 1 回操作して確かめた |
| 本人以外の承認（G-14）が動いている |
| Administrator の発行記録と通知が ② で動いた |
| Admin の負の試験が、② と会社の 1 アカウントで通った |

- G5 の前に済ませること: G-14（本人以外の承認）・U-7（Cloudflare アカウントの分離）・U-10（管理アカウントのルートの認証情報の保持者）。E0 の受容の失効と、Entra を通らない停止の経路（§6.6・§6.7）
- D4 の言い直し: **Standard の鍵の Workers secret は、会社で Administrator を配る前まで**。会社では最初から Standard も KMS にするかは G2 で決める [資料: cto の決裁 2026-11-12]。読み: 会社で Administrator を配るまでに、Standard の鍵を Workers secret から移す（移す先は KMS の見込み）[推測: 言い直しの文面からの読み]
- 人の承認: 会社のセキュリティ承認（Administrator 相当を含む）、PIM の扱い

### 7.7 旧い段階の条件の行き先

[資料: cto の決裁 2026-11-12 の「旧条件の行き先」]

| 旧い条件 | 行き先 |
|---|---|
| 1a の前の条件 (1)〜(6) | 引き継ぎ（§7.2）。(3) の単体テストは G2、(6) は ② と ③ の Viewer の配布の間 |
| 1a-1・1a-2（会社の Entra） | G4 |
| 停止の訓練（1a-3）・突き合わせ（1a-4） | ② と G4・G5 |
| 1b の前の確認・U-4 | ② で確かめ、G3 |
| E0 の失効と Entra を通らない停止の経路 | G5 の前（または会社で Viewer を全アカウントに広げる前） |
| G-14・U-7・U-10 | G5 の前 |
| N8・N11・N12 | 全アカウントに広げる前 |
| 守りの部品・検査の道具・設定に任せたロール | 作るのは ①、測るのは ② |
| 検査の道具を CI に | G3 |
| N6 | G1 |
| N2・N5 | G2 |
| D4（鍵の保管） | 言い直し: Standard の Workers secret は会社で Administrator を配る前まで。会社は最初から Standard も KMS にするかを G2 で決める |
| P1・P2 | G1 |
| Viewer の共有・F2・M2-MCP | MCP の統合の上申（G3 までに Viewer を共有するかだけ決める） |
| PIM・会社のセキュリティ承認 | G3・G5 |
| 顧客のアカウント | 「完了」の外（利用者が確認） |
| U-13（段階の定義の書き直し案） | この節で置き換えて閉じた |

決裁の表に行き先が書かれていないもの（作成者の扱い。決まったものではない）:

| 旧い条件 | 作成者の扱い |
|---|---|
| U-2 代替案の比較の訂正（旧「段階 2 のゲートの宿題」） | 行き先は未定。[推測] 会社に入る前（G3）に扱う |
| §4.7 の Viewer の機微データの棚卸し（旧「段階 2 のゲート」） | 行き先は未定。[推測] G3（会社の Viewer の前） |
| B2 break-glass の IAM ユーザー（旧「段階 3（Admin）の前」） | 行き先は未定。[推測] G5 の前 |
| Admin の階層の Access アプリを別の Cloudflare アカウント（または別の Terraform の state とトークン）に分けるか（旧「段階 3 の前に見直す」） | 行き先は未定。[推測] U-7 と同じく G5 の前 |
| 世代つきの新しいパスへ移る手順（旧「段階 2 の前に書く」） | Admin と Standard の手順の案を G1 の資料（console-login-admin.md）に書いた。確かめるのは N5 と一緒に G2 [推測] |
| P-9（パスで別の Worker に振り分ける形。旧「段階 3 の前」） | G1 で扱う（Admin の issuer の形と一緒。実施の時機は G1 で決める） |
| U-5（SCP を訓練で試すか）・N3 | SCP は任意の層（§6.5）。合格条件に入れない |
| U-6（1b の合格条件） | 1b がなくなったので閉じた。代わりは ② の合格条件（§7.5）と G4 |
| N4（コンソール操作の SourceIdentity。旧「段階 1 の CloudTrail で見る」） | [推測] ② で見る |
| 管理外の境界（旧「段階 4」の break-glass B4 など） | 顧客のアカウントは「完了」の外 |
| ③ の最初の配布の範囲（人とアカウントの数） | G3 で決める（§7.6） |

---

## 8. 未検証の項目と確かめる時機

時機は §7 の区切り（①・②・③）とゲート（G1〜G5）で書く。行き先は §7.7。

| 項目 | 内容 | 確かめる時機と扱い |
|---|---|---|
| N6 KMS の署名 | Worker → KMS の Sign（RS256）で作った JWT を STS が受理するか。遅延。Worker が KMS を呼ぶ認証情報。`DisableKey` が効くまでの時間 | **G1 の最初**（[console-login-admin.md](console-login-admin.md)）。不成立なら再審議（§7.1） |
| N2 | コンソールのセッションが実際に 12 時間続くか。Administrator で `--remote` が拒否されること | ① の PoC（G2）。Viewer の `sessionSeconds` は下流の設定で、続かなくても入り直すだけ |
| N5 JWKS のキャッシュ | 同じ URL でプロバイダーを作り直したときに、STS が新しい鍵を読むか | ① の PoC（G2）。それまで鍵の差し替えは「止めたまま、世代つきの新しいパス」でよい（§6.1 の L5） |
| 守りの部品 | 部品の版の更新が、新しい引き受け・既存のセッション・`aws login --remote` の更新にいつ効くか | ① の PoC で測り（G2）、② で確かめる（§4.8）。最初の配布で部品を配るかは未決（§9.2 の U-15） |
| Admin の issuer（方向 I-B の具体化） | 発行のオリジンを分け、issuer は同じホストの `/admin` でもよい。パスで別の Worker に振り分ける形（P-9） | 形は G1 で審議する。P-9 の実施の時機は G1 で決める |
| P-2 | 同じ端末の `aws login` と `--remote`（Viewer の形） | 1a の前の条件 (1)（書き直し版）で成立。残り: 同じ端末の 15 分後の更新、セッションが 1 つのときの確認画面（旧「1b の前」。② で確かめ G3）。Administrator で `--remote` が拒否されることは N2 |
| L3-1 | `aws:SourceIdentity` の Deny による 1 人の停止 | 1a の前の条件 (4) で成立（§6.1）。複数アカウント・複数ロールでの所要時間は ② と会社の訓練で測る |
| N4 | コンソール操作のイベントの SourceIdentity | [推測] ② の CloudTrail で見る（前の版は「段階 1 の CloudTrail で見る」） |
| N1 の残り（会社の Entra） | Entra のグループ（Object ID）での M2、Cookie Path の切り替え（App Launcher は使わないので確かめない）。入口の一覧（U2）のためのグループの取得 | 1a-1（G4）。M2 が合格しなければ会社の Viewer を広げない。U2 の取得が成り立たなくても止めない |
| N10 の残り | Entra のグループから外したときの反映（直接・入れ子・無効化・IdP のセッション残り） | 1a-2（G4）。結果で §6.4 を見直す |
| N8・N11 | 停止の一括配布・StackSets の運用（委任管理者・OU の移動・ドリフトの防止） | 全アカウントに広げる前。それまでは手作業で配る |
| N12 チェーン | コンソールログイン用のセッションから既存のロールへのチェーン（チェーン先に `sts:SetSourceIdentity` が要る） | 全アカウントに広げる前。それまでは `sts:AssumeRole` を明示の Deny で禁じる（§4.7） |
| N3 SCP | ロールのパス・SourceIdentity での Deny、伝播時間 | **任意**（SCP は管理下のメンバーアカウントでの追加の層。§6.5）。確かめるなら管理下のメンバーアカウントで |
| P-1・P-3・P-4 | マルチセッション、`Issuer` への戻り、POST での受け渡し | ポータルの使い勝手。最初は T1（302）で、案内を出す（portal §6）。開発環境で確かめる |

---

## 9. 決裁と未決事項

### 9.1 決まったこと

| # | 論点 | 決定 [資料: cto の決裁] | 反映 |
|---|---|---|---|
| G-5 | 変えにくい名前（issuer の URL・audience・ロールのパス・タグ・RoleSessionName） | §3 の冒頭の表のとおり確定 | §3 |
| G-8 | issuer のホストをポータルと分けること、Admin の issuer の形 | Standard は専用ホストの `https://<issuer-host>/std`。Admin は方向 I-B（2026-11-12 に「発行のオリジンを分ける。issuer は同じホストの `/admin` でもよい」と具体化）。形は G1 で審議する（前の版は「確定は段階 3」） | §3.1 |
| G-10 | ロールのパスを階層で分けるか | P-2 `/awsbridge-console/<tier>/` | 実装済み（`rolePath`）。§3.3 |
| G-11 | audience を上流の定数にすること | 定数 `awsbridge-console` 1 つ | 実装済み（`AUDIENCE`。`stacksets.json` の `audience`）。§3.2 |
| G-13 | Cloudflare アカウント | 既存を使う。分離（U-7）は G5 の前（前の版は「段階 1 は既存。分離は段階 2 のゲート」） | §2.2 |
| G-14 | 承認 1 人 | G5 の前まで受け入れる。本人以外の承認は G5 の前（前の版は「段階 1 に限り」「段階 2 の前」） | §5.4 |
| 段階の定義 | 段階 1 を 1a / 1b に分けた（当時） | 2026-11-12 に「① 完成 → ② 個人で導入・試験 → ③ 会社に導入」（G1〜G5）に置き換えた | §7 |
| CI の権限 | ② と ③ の Viewer の配布の間は CI に StackSets の適用権限を持たせない（前の版は「段階 1 は」） | 手作業で配り、CI は検査だけ | §4.1・§5.4・§7.2 |
| 不変の ID | 段階 2 のゲートで決める（当時） | 段階 1 は email。信頼ポリシーに形の条件を足さず、発行記録に Access の `sub` を残す。**2026-11-12 に email で決定**（下の表の SourceIdentity） | §3.4・§5.6 |

2026-11-12 の決裁と利用者の判断:

| 論点 | 決定 | 反映 |
|---|---|---|
| 人のロール | Viewer（Standard）と Administrator（Admin）だけ（配る時機は §2.3・§7）。Developer と人の Debugger は廃止。IAM が要る開発者は Administrator（利用者が受容）。名前は `FederatedAwsBridgeViewer` / `FederatedAwsBridgeAdministrator`、パスは `/awsbridge-console/<tier>/` | §2.3・§3.3 |
| ロールの共有 | 共有するのは Viewer だけの方向（条件付き承認）。MCP の文を足すのは MCP の統合の上申のあと（前の版は「段階 2 のゲートの再上申」。G3 までに共有するかだけ決める）。Administrator に MCP の文は置かない | §2.3 |
| `aws login --remote` | Viewer は同じ端末と `--remote` の両方を許す。Administrator は同じ端末だけで、`--remote` は Admin の階層の守りの部品の明示の Deny（本人が外せるので、フィッシングへの守りで封じ込めではない）。N2（① の PoC。G2）は「Administrator で `--remote` が拒否されること」 | §4.4 |
| SCP | 頼らない。基準はロールとプロバイダーのスタックだけ。SCP は管理下のメンバーアカウントでの任意の層。L4・N3 は任意 | §4.8・§6.5 |
| ロールの管理 | 設定ファイルに任せる（割り当ての規則なし）。必須はプロバイダーのスタックと守りの部品、ロールの CloudFormation は参考。構造の要件は残す。手作りロールの強さは下流の責任（利用者が受容） | §4.8・§4.9 |
| MCP 用 Debugger の割り当て | 「Administrator か Developer を持つ人にだけ」の規則を取り下げた。割り当ては設定で決める | §2.3、`infra/aws/awsbridge.yaml` のコメント |
| Viewer の秘密値 | SSM と Secrets Manager の値は読めない（Deny を残す）。一覧は見られる | §4.7 |
| SourceIdentity | **会社の Entra でも email**（cto の決裁「会社の Entra でも SourceIdentity は email」を条件付き承認、受容の文面に利用者が同意。前の決裁の「会社は `oid`」は取り下げ）。RoleSessionName も今のまま。不透明な識別子として扱い、形の条件を足さず、出どころは設定で切り替えられる形（既定 email）。M2-MCP でも email。発行記録に email・`sub`・取れれば `oid`。停止は過去の email も全部 Deny、監査の人の特定は発行記録と Entra の記録を合わせる、会社に入る前に email の再利用を確かめる。`oid` は将来の選択肢（会社の Entra の設定と実証が要る） | §3.4・§5.6・§6.2・§6.3 |
| 停止の手順 | revoke と 1 人停止の Deny は最長のセッションが切れるまで外さない。退職・紛失は Entra 側でも止める | §6.1〜§6.3 |
| 入口と一覧（P1'） | Standard と Admin で共通。署名の権限（Worker・issuer・鍵）と発行のオリジンは分けたまま。Standard のバンドルに入れる Admin の情報は表示用だけ。自前の JWT に `azp` を出さない。P1・P2 は G1 で扱う（前の版は「段階 3 で再上申可」）、P3 は却下 | §2.2・§2.3・§3.1、portal §8 |
| 1 つの一覧（U2） | チームを選ばせず、所属する全チームの行を出す。表示用の対応表（Object ID → チーム）を Worker に持たせてよいが、発行には使わない。操作は 2 回のまま。会社の Entra での実証を 1a-1・1a-2 に足す（成り立たなくても止めない。行き先は G4）。U1・U3・U4 は却下 | §2.1・§7.3、portal §4.1・§7 |
| App Launcher | 使わない | portal §7 |
| 段階導入（D8） | 「① 完成 → ② 個人で導入・試験 → ③ 会社に導入」。ゲートは G1（① の実装の前）・G2（① の完成）・G3（会社の Viewer の前）・G4（会社の Viewer を広げる前。報告）・G5（会社の Administrator の前）。② は G2 の合格と人の承認で始め、再上申なし。旧条件は決裁の「旧条件の行き先」どおりに付け替えた。利用者が 3 点を確認、② の前提を了承、M2-MCP と MCP の統合にはまだ着手しない | §7 |
| D4 の言い直し | Standard の Workers secret は会社で Administrator を配る前まで。会社で最初から Standard も KMS にするかは G2 | §2.2 |
| F2・M2-MCP への回答 | Debugger の割り当てはチームごとに自由（台帳は警告だけ）、個人用の MCP はチームを使わない、M-1〜M-6 は段階 2 のゲートの前（2026-11-12 に MCP の統合の上申へ移った。まだ着手しない） | §2.3 |

Sol のレビュー（2026-11-12。決裁ではない）のうち採った指摘: 認可の権威の分散と「tier は権限の強さを保証しない」（§2.1・§3.3）、厳格な形の許可リスト方式の検査・`GetPolicyVersion` と `ListRoles`・正常性の検査（§4.9）、部品は事故防止で強制境界ではない・反映時間は 3 種を別に測る・容量と版の手順は ①（前の版は段階 2。§4.8）、Viewer の `--remote` は残るリスクの受容で通知は事後の検知（§4.4）、Viewer は「機密を読めない」ではない（§4.7）、L0〜L2 は発行済みのセッションを止めない（§6.1）。SourceIdentity の識別子の指摘は cto の決裁（上の表）で扱った。

Sol のレビューの指摘の反映（決裁ではない。採ったものだけ）:

| Sol の指摘 | 反映 |
|---|---|
| 1 CI の侵害範囲と段階 1 の範囲 | ② と ③ の Viewer の配布の間は CI に適用権限を持たせない（§4.1・§5.4・§7.2） |
| 2 Access を経由しない入口・失効・`aud` の扱い・AUD → チームの保護 | T11・A12 と対策（§5.1・§5.3・§5.4）、portal §9.3 |
| 3 DNS・Routes・デプロイ権限・JWKS・復旧経路 | A13〜A16・T12・T13（§5.1・§5.3・§5.4）、A2 の拡張、Admin の issuer は別ホストの方向（§3.1） |
| 4 1 人の停止（`aws:SourceIdentity` の Deny）とロールチェーンの禁止 | L3-1（§6.1）、`sts:AssumeRole` の明示の Deny（§4.7） |
| 5 revoke の付け方と解除の条件 | §6.2・§6.3 |
| 6 Entra から独立した停止の経路 | §6.6（利用者が E0 を選んだ。受容の範囲は付け替えで G5 の前（または会社で Viewer を全アカウントに広げる前）まで。G5 の合格条件は §6.7） |
| 7 所属変更の時計と「拒否を確かめる」手順 | L1（§6.1）・§6.4・1a-2 |
| 8 代替案の比較の偏り | §9.2 の U-2（行き先は未定。§7.7） |
| 9 不変の ID・`jti` は CloudTrail に残らない | §3.4・§5.6、portal §10.3（`jti` の部分は N6 で訂正: `webIdentityTokenId` に入る） |
| 10 ReadOnly は安全な上限とは限らない | §4.7 |
| 11 `aws login` のリフレッシュトークン・共有端末 | A7・T5（§5.1・§5.3） |
| 12 名前（共通 audience・tier は権限を保証しない・世代つきの issuer・レート制限） | §3.1・§3.2・§3.3、T14 と §9.2 |

### 9.2 未決事項

| # | 論点 | 決める人・時機 | 現状 |
|---|---|---|---|
| U-1 | Entra を通らない停止の経路: E1（減らす側だけの受け口ロール）か E0（受容） | **決定済み（E0。利用者、2026-11-11）**。受容の文面は「段階 1 では」。2026-11-12 の付け替えで、E0 は G5 の前（または会社で Viewer を全アカウントに広げる前）に失効する | §6.6。G5 の合格条件: Entra を通らない停止経路（E1 の直した形など）を用意し、実際に 1 回操作して確かめる（§6.7）。E1 を採るなら開発用アカウントで 3 点を確かめる。付け替え後の範囲で受容を取り直すかは U-21 |
| U-2 | 代替案の比較の訂正（案 1 + 横断ランチャーは IC を繋がなくても成り立つ、案 2 は 500 件から選ぶ形が必須ではない、案 6 の「SourceIdentity を必須にできない」が IC 起点の制約か一般の制約か、ランチャー案と混成案の小さな実測） | 行き先は決裁に明記なし（前の版は「段階 2 のゲートの宿題」。[推測] G3） | 未着手 [資料: cto の決裁・Sol のレビューの指摘 8] |
| U-3 | 不変の ID。SourceIdentity と RoleSessionName の形 | **閉じた: email に決定（利用者の判断、2026-11-12）** | SourceIdentity も RoleSessionName（`console-<email>`）も email のまま（§3.4）。前の決裁の「会社の Entra は `oid`」の方向は取り下げた。`oid` は将来の選択肢（会社の Entra の設定と実証が要る）。email の間の運用（停止は過去の email も全部 Deny・監査は発行記録と Entra の記録を合わせる・会社に入る前に email の再利用を確かめる）は §5.6・§6.2・§6.3 |
| U-4 | 発行 API のレート制限とコストの枯渇（利用者ごと・全体の上限の値、STS のスロットリングの扱い、Workers・Logpush の費用の見張りと上限の通知） | ② で確かめ、G3（行き先の表。前の版は「段階 1b の前」） | 利用者ごとの制限（429 `rate_limited`）だけを設計した（portal §9.3 の 6）。値は未定 |
| U-5 | SCP を停止の訓練で試すか（S-a / S-b） | cto | §6.5。訓練（1a-3）は L0〜L3 と解除。SCP は任意の層になった（2026-11-12）ので合格条件には入れない |
| U-6 | 1b の合格条件の細部と、1b の前に cto への再上申が要るか | **閉じた**（1b がなくなった。2026-11-12） | 代わりは ② の合格条件（§7.5）と G4（§7.6） |
| U-7 | Cloudflare アカウントの分離 | G5 の前（前の版は段階 2 のゲート） | それまでは既存 |
| U-8 | 本人以外の承認（G-14） | G5 の前（前の版は段階 2 の前） | それまでは承認 1 人。G5 の合格条件は「G-14 が動いている」 |
| U-9 | portal §12.2 の残りの論点（G-1〜G-4・G-6・G-7・G-9） | portal §12.2 のとおり | — |
| U-10 | 管理アカウントのルートの認証情報の保持者（誰が持ち、どこに保管し、使ったことをどう通知するか） | 利用者。G5 の前まで（前の版は段階 2 のゲート） | **未回答**。停止経路（§6.6）と break-glass（§6.8 の B2）に関わる |
| U-11 | API トークンでの L0（wrangler）が Entra を通るか | 利用者。確かめられる時機に | **未確認**。Entra を通らない可能性がある。確かめれば、E0 の実際の欠落が「L0 も不可」か「L2・L3 だけ不可」かが分かる（§6.6） |
| U-12 | Cloudflare のダッシュボードの Entra 以外のログイン（ID/パスワード/パスキー。利用者が今後設定する予定）の設定前の確認 | 利用者。設定の前 | 設定するなら §5.4 の条件を満たす。SSO を強制しているドメインで別のログインがどう扱われるかを、Cloudflare の文書で確かめてから設定する 利用者は §5.4 の 3 条件に同意し、セキュリティ例外には当たらないと判断した（2026-11-11） |
| U-13 | 段階の定義の書き直し | **閉じた（置き換え）**: cto の決裁 2026-11-12 の「① 完成 → ② 個人で導入・試験 → ③ 会社に導入」で置き換えた | §7。前の案（1a-個人 → 1a-会社 → 1b）のうち、個人でも構造の要件は同じ・E0 は会社の話・MCP のスタックに触らない・同じ名前のロールが無いことを確かめる、は ② の構成（§7.5）に移した |
| U-14 | SourceIdentity の値の出どころを設定で切り替える形（既定 email）の、設定のスキーマ | ポータル本体の実装のとき | 未実装。設定のスキーマ（`src/console/config.ts`）には今は項目がない |
| U-15 | 守りの部品を最初の配布から配るか。Viewer のロールチェーンの禁止・自分自身の保護・1 人停止の Deny を、ロールのインラインポリシーに置くか部品に置くか | cto / ① の完成（G2）まで [推測] | 決裁は部品の中身と、部品を作るのは ①・測るのは ② ということだけを決めた（前の版は「版の更新の反映を段階 2 の PoC で測る」）。1a の前の条件 (4) で確かめたのはインラインの形（§4.3・§4.7・§6.3） |
| U-16 | 生成の検査（§4.4 の (4)）: Standard の階層のロールに `SignInLocalDevelopmentAccess` を付けたときの扱い | 実装のとき | Admin の階層では誤り。Standard は未決（参考の形は付けない） |
| U-17 | 1 つの一覧（U2）の受け入れ: 操作が 2 回のままでよいか、会社の Entra と Access でグループを身元に載せる設定の変更、所属が取れないときに全チームへのリンクに落ちる見え方 | 利用者 | 人の確認待ち（portal §12.1 の Q-P11） |
| U-18 | 入口の共通化（P1'）で何をやめたいか: Administrator の見た目の区別を残すか、Admin 用の別グループを必須にするか。「プロバイダーを 1 つにしたい」意図なら P2 を G1 で審議（前の版は段階 3） | 利用者 | 人の確認待ち（portal §12.1 の Q-P12）。別のポータルはやめた |
| U-19 | 生成器と設定のスキーマを P1'・U2 に合わせること: Standard の生成物に表示用の Admin の行と表示用の対応表を入れる、`portal.entryAud.admin` の扱い（Admin の入口がなくなったが、今の生成器は Admin の階層のチームが 2 つ以上なら `deploy` で求める） | ポータル本体の実装のとき | 未実装（portal §5.2・§11.3） |
| U-20 | ③ の最初の配布の範囲（会社の Viewer を、誰に・何アカウントに） | G3 | 決裁に明記なし。前の 1a（運用者だけ・1 アカウント）・1b（試行者・5 アカウント以下）の数は新しい決裁にない（§7.6） |
| U-21 | E0 の受容の範囲の付け替え: 利用者の受容の文面は「段階 1 では」。付け替えで E0 は G5 の前（または会社で Viewer を全アカウントに広げる前）まで続く | 利用者 | 付け替え後の範囲で受容を取り直したかの記録はない（§6.6） |
| U-22 | 決裁の「旧条件の行き先」に書かれていない旧条件（U-2、Viewer の機微データの棚卸し、B2、Admin の Access アプリの分離、世代つきパスの手順、P-9、N4） | cto（G1 で確認） | 作成者の扱いは §7.7 の 2 つ目の表。どれも決まったものではない |
| U-23 | ② の個人の環境のチームの数: 前の決裁（1a を個人から）は「チームは 1 つ」。② は Administrator も配るので、Admin の階層のチームが別に要る見込み | cto（G1 で確認）/ 下流の設定 | 決裁に明記なし（§7.5） |

## 参考

- AWS: AWS Sign-In の管理ポリシー（`SignInLocalDevelopmentAccess` と、`localhost` / `remote` のリソース ARN）: https://docs.aws.amazon.com/signin/latest/userguide/security-iam-awsmanpol.html
- AWS: AWS Sign-In の条件キー（`signin:OAuthRedirectUri` など）: https://docs.aws.amazon.com/signin/latest/userguide/reference-signin-condition-keys.html
- AWS: SourceIdentity（`sts:SetSourceIdentity` がないロールへの引き受けは失敗する、長さと文字種、SourceIdentity 必須のロールにはコンソールの Switch Role で入れない）: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html
- AWS: SCP は管理アカウントに効かない: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html
- AWS: StackSets の自動デプロイ（OU 間の移動・子 OU・上書き・依存）: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-manage-auto-deployment.html
