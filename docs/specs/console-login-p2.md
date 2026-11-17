# コンソールログイン: P2（B）の設計メモ — Worker・issuer・鍵・プロバイダーを 1 つにする

- 状態: **承認済み（2026-11-17 の決裁、条件付き）**。cto の決裁 2026-11-17「P2（B）の設計メモ」: 設計メモを承認し、切り替えの PR の実装にブランチで進んでよい。マージは §10 の条件と cto への報告のあと。このメモはコードと既存の文書を変えない
- 書いた日: 2026-11-17
- 前提の決裁（日付と要旨。決裁の原文はこのリポジトリの外の決裁記録にある）:
  - cto の決裁 2026-11-17「コンソールのプロバイダー・Worker・鍵を 1 つにする（P2）の再審議」: B を方向として条件付き承認。受容 a〜e を定義。D3 の「階層で鍵と Worker を分ける」を外し、MCP とコンソールの分離は保つ。X1 の (c)(d)(e)(f) をコンソールの Worker 全体に掛ける。A-15・Admin のチームの Access のセッション 15 分・Administrator の確認画面・MaxSessionDuration 1 時間・`--remote` の Deny・Administrator の別スタックは保つ。足すもの: チーム名が階層をまたいで重ならない検査、階層をまたぐ負の試験。下流の本番の順序（B のとき）を示した
  - 利用者の判断 2026-11-17: 構成は B。「B に統一」は OSS の設計も B だけ（階層ごとの issuer の継ぎ目を残さない）。受容 a〜e を受け入れる。コンソールの Worker のデプロイと鍵の操作は利用者だけ。Administrator の確認画面は残す。入口のリージョンの選択はなくし既定のリージョンで開く
  - cto の決裁 2026-11-17「P2（B）の続き — OSS を B だけにする」: OSS を B だけにすることを技術承認（実装の承認はこのメモの再上申のあと）。X1 の (h) を取り下げ、退避先は「③ で階層の分離や AWS 側の署名が要るなら、新しい設計として G5 の前に上申」。消すのは階層ごとの Worker・issuer・鍵・ホストだけで、階層という考えは残す。PR の分け方 ①〜⑤、実測は下流の本番の段 4（弱い Admin ロール、Administrator なし）
  - cto の決裁 2026-11-17「ポータルの流れ（一覧から 1 回で開く）」と「②b の条件の整理し直し（OSS と下流）」
- 読む人: 技術決裁者（cto）・独立レビュー（Sol）・実装の担当。内部の区切りの呼び名（①〜⑤・G2-A・G5 など）はこのメモでは使う

---

## 0. 要約

| # | 論点 | 結論（cto の決裁 2026-11-17「P2（B）の設計メモ」で承認。条件付き） |
|---|---|---|
| 1 | 変える決裁 | D3・X1 の (a)(h)・A-9・P-A・base.yaml の `Rules`・P1' の「発行のオリジンを分ける」を、§1 の新しい形に置き換える。「階層」の定義を「発行する Worker・issuer・鍵の分かれ目」から「チームとロールに付く区分（Access のアプリ・ロールのパス・ロールの形・守りの部品・照合の扱いを決める）」に直す |
| 2 | 消す・移す・残す | `src/console/admin/` の Worker と鍵の名前は消し、Admin の Worker にしかなかった守りは 1 つの Worker の中へ移す。設定は `schemaVersion` 2（`portal.origin`・`boundaries[].issuer`）。試験は対象が消えたものだけ消し、守りの試験は 1 つの Worker の形に書き直す（§2.7 の表） |
| 3 | 変えにくい名前 | issuer のパスは `/console`（決裁で決定。§3.1）。ホストは 2 つ（ポータル `awsbridge-console.<domain>`・issuer `awsbridge-oidc-console.<domain>`）。aud は `awsbridge-console` のまま。ロールのパス `/awsbridge-console/std/`・`/admin/` は保つ |
| 4 | 外への通信 | 3 つの固定の宛先（Access の certs・STS の地域の endpoint・getSigninToken）だけ。入口の get-identity は未接続のままにし、つなぐなら別の上申。実行時の依存は jose だけ、を Worker 全体の試験にする |
| 5 | Admin の Worker の守りの行き先 | aud ちょうど 1 つ・署名の自己検証・回数の制限は Worker 全体（もとから共通）。Access JWT の経過時間の上限は Admin の階層のチームだけ。「チームのパス以外を最初に 404」は形が変わる（入口があるので、Worker 全体の「既知の経路以外を env を読む前に 404」にする）。Admin のオリジンを分けていた性質は失われる（受容 c） |
| 6 | 守りの部品 | 2 つ（Standard・Admin）を残す。プロバイダーの Deny は 1 つのホストだけにする（base.yaml:186-191・:266-268 を書き直す）。Admin の部品は条件を外していつも作る（決裁で決定）。D3 の `Rules` は消す |
| 7 | 階層をまたぐ検査 | 既存（チーム名の重複・`tier_mismatch`・`AdministratorTeams` の `AllowedPattern`）に、生成物の検査・署名の部品の多重の検査・inspect の検査を足す。Worker の負の試験は unit と E2E。STS の側は、段 4 で弱い Admin ロールの信頼ポリシーのチームの値を API でずらし、本物の Worker の発行で断られることを測る（決裁の (3)。§7.4）。退役名の台帳を足す |
| 8 | 脅威モデルと受容 | README の目立つ所に「コンソールの Worker をデプロイできる者と、その secret・依存物に触れる者は、Administrator を配った全アカウントの全権を持つ」と受容 a〜e の一般の形（§8.2） |
| 9 | 照合・inspect・exposure-check | プロバイダーから階層を決める枝を消し、階層は「記録の tier・記録のチームの階層・ロールのパス」で決める。`identity_not_compared_admin` は保つ。設定の `issuers` は `issuer` 1 つに |
| 10 | PR | ① このメモ → ② 切り替え（生成器・テンプレート・設定・Worker・照合・inspect・exposure-check・Admin の Worker のエントリの撤去を一緒に）→ ③ 片付け（使われない道具・タスク・文書）→ ④ 画面 → ⑤ 流れ。#51 は ② のあとに B の順序へ改訂。② のマージは旧い構成の撤去と cto への報告のあと（§10 の c1〜c6） |
| 11 | 実測 | 下流の本番の段 4 で、弱い Admin ロールで取り直す（§11.1）。DN1〜DN8・60 分・revoke・信頼ポリシーの Deny・Route の上書き・照合の修正・L2 は引き継ぐ |
| 12 | 下流の本番の順序 | 段 0〜5（§12.1）。段 4 は「Admin の Worker を入れる」から「Admin のチームと弱い Admin ロールで 1 回発行し、階層をまたぐ負の試験と照合」に変わる |
| 13 | 迷い・Sol の論点 | §13（各論点に決裁の答えを書いた） |
| 14 | Sol のレビューの採否 | 決裁で確定: 採用 11・一部採用 4・不採用 1・既に満たす 2（§14） |

---

## 1. 変える決裁と新しい形

### 1.1 用語の直し

今の定義（`docs/specs/console-login.md:26`）: 「階層」（tier）は Standard / Admin（**発行する Worker・issuer・鍵の分かれ目**。権限の強さは保証しない）。`docs/specs/console-login.md:220` も「tier が決めるのは、どの Worker・issuer・鍵で署名したトークンで、そのロールに入れるか」と書く。B ではこれが偽になる。

新しい定義（案）: 「階層」はチームとロールに付く区分（`teams[].tier`・`roles[].tier`）。階層が決めるのは次のものだけで、Worker・issuer・鍵・ホストは階層で分けない。**権限の強さは保証しない**（今と同じ）。

- Access のアプリ（チームごと。Admin の階層のチームはセッションを短く）
- ロールのパス（`/awsbridge-console/std/`・`/awsbridge-console/admin/`）と、ロールの形（MaxSessionDuration、`aws login --remote` の可否、守りの部品の種類）
- Worker の検査（Admin の階層のチームの Access JWT の経過時間の上限、Admin の確認画面）
- 照合と inspect での扱い（Administrator の階層の誤りの基準、発行の件数の表示）
- 署名の issuer は境界ごとに 1 つで、階層をまたいで同じ。階層を分けるのは「Access の AUD → チーム → タグ」と、ロールの信頼ポリシーのチームの条件（受容 d）

境界（`managed` / `partner:<id>`）は消さない。B で 1 つになるのは「階層 × 境界」の階層の次元だけで、issuer と鍵は境界ごとに 1 つ残る。個人の環境（境界 1 つ）では、MCP のプロバイダーと合わせてプロバイダーは 2 つになる。

### 1.2 変える決裁の一覧

| 決裁（日付と要旨） | 今の形と根拠 | 新しい形（案） |
|---|---|---|
| D3（2026-11-11 の設計上申への決裁 D1〜D10 のうち「階層 × 信頼の境界で鍵を分け、Admin の issuer は Standard と別の Worker デプロイ」） | 鍵は「階層 × 境界」、Standard と Admin は別の Worker（`docs/specs/console-login.md:106-107`、`docs/specs/console-login.md:118`、`src/console/config.ts:803-811`） | 鍵と issuer は**境界ごと**に 1 つ。Worker はコンソールに 1 つ。**MCP とコンソールの分離（D2・P3 の却下）は保つ**。issuer の URL の重複の検査は「境界ごと」で残す |
| X1 の (a)（2026-11-12「Administrator の発行を Cloudflare で完結」: D3 は保つ。Admin は別 Worker・別 issuer・別の鍵・別ホスト） | `docs/specs/console-login-admin.md:42`・`:351`、`src/console/admin/worker.ts:3` | 取り下げ。Admin の発行はコンソールの Worker が、Admin の階層のチームのパスで行う |
| X1 の (c)(d)(e)(f) | Admin の Worker だけに掛けていた（鍵の手元での生成・CI を通さない／実行時の外部依存なし・別トークン／90 日以下の差し替え／aud ちょうど 1 つ・email と sub の検査・経過時間の上限・exp=iat+300・Cookie Path） | **コンソールの Worker 全体**に掛ける。(d) の「Standard と別のトークン」は「デプロイと鍵の操作は利用者だけ（受容 b）」に読み替える。(f) の経過時間の上限は Admin の階層のチームだけ（§5） |
| X1 の (h)（署名の部品の継ぎ目を残す。C-4・I-C は退避先） | `docs/specs/console-login-admin.md:228-230` | 取り下げ（cto の決裁 2026-11-17 続き）。`TokenSigner` の差し込み口（`src/console/issue/signer.ts`）は試験の都合で残すが、「退避先へ戻す継ぎ目」とは書かない。C-4・I-C・X2・X3 の文書と PoC の記録は「履歴。現行ではない」と明記して残す |
| A-10（2026-11-12 G1: ① は同じリポジトリの別エントリ。条件 (1) Admin のエントリは別の wrangler 設定・別のデプロイのジョブ・Standard と別のデプロイ用トークン・実行時の外部依存なし (2) バンドルの分離の試験を 3 方向に (3) Admin のパスと署名の部品に CODEOWNERS (4) 公開リポジトリに秘密・実値を置かない） | `docs/specs/console-login-admin.md:371` | (1) コンソールの wrangler の設定・デプロイは 1 つ。デプロイは利用者だけ（受容 b）。実行時の依存は jose だけを Worker 全体に（§4.2）(2) 2 方向（MCP ↔ コンソール）と「発行の経路が表示の照合を import しない」に（§2.7）(3) リポジトリに CODEOWNERS は無い（このワークツリーで `CODEOWNERS` と `.github/` を探して無かった）。置くなら対象は `src/console/` 全体（§13 の論点 13）(4) 変えない |
| A-9（2026-11-12 G1: P1' のまま） | `docs/specs/console-login-admin.md:48`・`:441`、`docs/specs/console-login-portal.md:769`、`docs/specs/console-login.md:204` | P2（B）に置き換え。順位「P1' > P1 > P2」の記述は履歴にする |
| P-A（2026-11-13: Admin のプロバイダーを base.yaml に条件付き。`AdminIssuerHost`・`AdminPath`、`Rules` で D3、両方の部品の Deny に Admin のホスト） | `infra/aws/console/base.yaml:15-20`・`:88-120`・`:186-191`・`:205-217`・`:266-268` | Admin のプロバイダー・`AdminIssuerHost`・`AdminPath`・`Rules` を消す。Admin の部品は残し、条件を外す（§6）。「Administrator を配るアカウントだけ」のゲートは、Administrator のロールのスタック（別スタック）の有無だけになる |
| base.yaml の `Rules`（D3: `AdminIssuerHost` ≠ `IssuerHost`） | `infra/aws/console/base.yaml:111-120` | 消す（比べる相手が無い） |
| P1'（2026-11-12: 入口と一覧は共通、署名の権限と発行のオリジンは分ける）と、ポータルの P1' の記述 | `docs/specs/console-login-portal.md:52`・`:160`・`:743-776`・`:831`、`docs/specs/console-login-admin.md:42-45` | 入口・一覧・Standard と Admin の発行が**同じオリジン・同じ Worker**（受容 c）。Administrator の行は同じオリジンの Admin のチームのパスの S2 へのリンク。確認画面は残す（利用者の判断） |
| ポータルの流れ（2026-11-17）の「S1 に Admin の階層の行を Admin のオリジンの S2 へのリンクだけで出す」 | 決裁の文 | 「同じオリジンの Admin のチームのパスの S2 へのリンクだけ」に読み替える。ほかの条件（Viewer だけ 1 回で開く・CSRF を検証した POST だけ・他のチームの email を HTML と JSON に入れない・入口の AUD を発行の表に載せない）は変えない |
| G-6（2026-11-12: Admin の Worker はチームのパス以外を処理の最初に 404。Admin のオリジン全体を断る Access アプリの採否は G5 の前） | `docs/specs/console-login-portal.md:1290`、`src/console/portal/worker.ts:236-245` | Admin のオリジンが無くなるので、後半は対象なし。前半は Worker 全体の「既知の経路以外は env を読む前に 404」へ形を変える（§5） |
| G-8 と X1 の Admin の issuer の形（I-B: 別ホストの `/admin`。`admin_issuer_*` の検査） | `docs/specs/console-login.md:201`、`src/console/config.ts:830-845` | 対象なし。issuer のホストとポータルのホストを分ける検査（`issuer_host_overlaps_portal`）は残す |
| 2026-11-17 の②b の整理の「段 4 で Admin の Worker とプロバイダーを Administrator のロールなしで入れ、c1-d と Admin の key-check」 | 決裁の文、#51 の段 4 | §12 の段 4（弱い Admin ロールで 1 回発行）に置き換え。c1-d と Admin の key-check は対象なし |
| L2「Admin のプロバイダーだけを消す」 | `docs/specs/console-login-admin.md:279`、`README_ja.md:310` | Administrator だけを止める L2 は無くなる（受容 e）。プロバイダーの削除は Viewer も止める。Administrator だけを Cloudflare に頼らず止めるのは、信頼ポリシーの Deny と Administrator のスタックの削除 |
| 「Standard の issuer の名前は変えない」（P1' の条件） | `docs/specs/console-login-portal.md:752`・`:763` | §3.1 で決め直す |

変えないもの（念のため）: D2（MCP 用のバンドルにコンソールが入らない）、P3 の却下（MCP とコンソールのプロバイダーを分ける）、D5（所属は Access のアプリと AUD）、D6・A-8（Admin は MaxSessionDuration 1 時間）、A-15（Admin のチームは別）、`--remote` の Deny、SourceIdentity は email、受容 1（Administrator は対象アカウントに入口を残せる）、Administrator の別スタック、Workers Logs の発行記録と毎日の照合。

---

## 2. 消す・移す・残すもの

### 2.1 コード（`src/console/`）

| ファイル | 扱い | 中身 |
|---|---|---|
| `src/console/admin/index.ts` | **消す** | Admin のエントリ（`awsbridge:console-worker-admin` を読む） |
| `src/console/admin/worker.ts` | **消す（守りは移す）** | `ACCESS_MAX_AGE_SECONDS` の読み取り（`:52-63`）→ Worker 全体の env の読み取りへ（名前は §3.2）。`teamPathOnly`・`isIssuerDoc`（`:84-88`）→ 共通の工場の「既知の経路以外は env を読む前に 404」へ。key-check の形（`:123-126`）→ 境界ごとの形（`src/console/standard/worker.ts:121-139`）に一本化 |
| `src/console/admin/issuer.ts` | **消す** | `/admin` の issuer の文書（`:12-23`）。境界ごとの文書（`src/console/standard/issuer.ts`）に一本化 |
| `src/console/admin/key.ts`・`sign-admin.ts` | **消す** | `ADMIN_KEY_`・`ADMIN_CURRENT_KEY`・`ADMIN_PUBLIC_JWKS`（`src/console/admin/key.ts:35`・`:46-61`）。規則は `src/console/signing/key.ts` に残っている |
| `src/console/standard/*` | **移す**（`src/console/worker/` などへ改名。名前は §3.2） | 1 つの Worker のエントリ・issuer の文書・境界ごとの鍵の vars。`StandardEnv`・`STANDARD_*` の名前を階層によらない名前へ |
| `src/console/issue/sign-standard.ts` | **移す**（改名） | 境界ごとの署名。§7.2 の多重の検査（タグのチームの階層 = ロールのパスの階層）をここに足す |
| `src/console/portal/worker.ts` | **直す** | `spec.tier`（`:178`）をやめ、階層は要求ごとに「パスのチーム → その階層」で決める。`teamPathOnly`（`:124`・`:238-245`）を Worker 全体の早い 404 に置き換える。`accessMaxAgeSeconds`（`:109-112`・`:336-338`）をパスのチームの階層で選ぶ。key-check の回数の制限のキー（`:351`）をチームの階層で作る |
| `src/console/portal/login.ts` | **直す** | `ctx.tier`（`:35`）をやめ、行の検査（`findRow`。`:107-135`）は「パスのチームの階層 = ロールの階層 = ARN のパスの階層」を求める（`:124` の ARN の照合はパスのチームの階層で作る）。回数の制限のキー（`:302`）はチームの階層で作る。ログと発行記録の `tier`（`:148`・`:254`）はチームの階層 |
| `src/console/portal/worker-config.ts` | **直す** | `readWorkerConfig(raw, tier)`（`:85-89`）の `tier` の照合をやめ、チームごとの `tier` を読む。行の ARN（`:196-200`）はその行のロールの階層で照合し、行のチームはすべてロールと同じ階層であること（新しい種別 `row_team_tier`）。`peerOrigin`（`:101-102`）を消す |
| `src/console/portal/routes.ts` | 残す | 1 つの `portal.origin`（`:57-92`）。チームは全階層のチームの表から引く |
| `src/console/portal/pages.ts`・`assets.ts` | 直す（④⑤ と合わせる） | `peerOrigin` へのリンク（`src/console/portal/pages.ts:224`）を同じオリジンのチームのパスに。`[ADMIN]` の印（`src/console/portal/pages.ts:48-51`）の扱いは利用者の判断（見た目の区別は最小限）に従う |
| `src/console/display/*` | 直す | `adminOrigin`（`src/console/display/display-config.ts:50-51`、`src/console/display/entry.ts:78-80`、`src/console/display/entry-page.ts:13`）を消し、Administrator の行のリンクは同じオリジンのチームのパス。表示用の生成物は**別ファイルのまま**（発行の経路が表示の照合を import しない性質は保つ） |
| `src/console/types.ts` | **契約を変える** | `WorkerConfig.tier`・`portal.peerOrigin`（`:41-61`）を消し、`WorkerTeam` に `tier`、`WorkerRole` に `tier` を足す。`DisplayConfig.portal.adminOrigin`（`:91`）を消す。`schemaVersion` を 2 に（§2.4） |
| `src/console/constants.ts` | 残す | `AUDIENCE`・`TEAM_TAG_KEY`・`ROLE_PATH_PREFIX`・`rolePath`・`ADMIN_MAX_SESSION_SECONDS`（`:9-30`）。`CONSOLE_SCHEMA_VERSION`（`:7`）を 2 に |
| `src/console/config.ts` | **直す** | §2.3 |
| `src/console/generate.ts` | **直す** | 基盤の StackSet の出力（`src/console/generate.ts:524`）は境界の `issuer` 1 つ。発行用の生成物は階層ごと（`src/console/generate.ts:364-410`・`:571-576`）から 1 つ（`worker.json`）に |
| `src/console/template.ts` | **直す** | §2.5 |
| `src/console/guard.ts` | **直す** | `issuerHosts`（`:9-12`・`:56-57`）を 1 つのホストに。Admin の部品の `DenyAwsLoginRemote`（`:74-80`）は残す |
| `src/console/inspect.ts`・`reconcile.ts`・`exposure.ts` | **直す** | §9 |
| `src/console/signing/*`・`issue/access.ts`・`issue/csrf.ts`・`issue/claims.ts`・`issue/federation.ts`・`http/headers.ts` | 残す | もとから階層に共通 |

### 2.2 mise のタスク（`mise.toml`）

| 今のタスク | 扱い |
|---|---|
| `console:admin-key:put`・`retire`・`check`（`mise.toml:172-182`） | **消す**（鍵は境界ごとに 1 つ） |
| `console:secrets:admin`（`mise.toml:184-186`） | **消す**（CSRF の鍵は Worker に 1 つ） |
| `console:standard-key:put`・`retire`・`check`（`mise.toml:194-204`） | **改名**して残す（案 `console:key:put`・`retire`・`check`。§3.2）。`check` は key-check を全チーム（Admin の階層のチームも）のパスで開けるようにする |
| `console:secrets:standard`（`mise.toml:206-208`） | 改名（案 `console:secrets`） |
| `console:build:standard`・`console:dev`（`mise.toml:213-219`） | 改名（案 `console:build`）。環境変数 `AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG`・`AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG`（`mise.toml:170`・`:192`）は 1 つ（案 `AWSBRIDGE_CONSOLE_WRANGLER_CONFIG`）に |
| `console:reconcile`・`console:exposure-check`・`console:inspect`・`console:access:inspect`・`console:stop:*`・`console:config:*`・`console:template:example` | 残す（中身は §9） |
| `poc:*` | 残す（PoC の記録。B の新しい測定に要るなら §11.2 の試験用 issuer を使う） |

### 2.3 設定のスキーマ（`src/console/config.ts`・`config/console*.example.json`）

`schemaVersion` を 2 にする。1 の設定は `schema_version` の誤りで止め、エラーの文で新しいキーを案内する（黙って読み替えない）。

| 項目 | 今 | 新しい形（案） |
|---|---|---|
| `portal.standardOrigin`・`portal.adminOrigin`（`src/console/config.ts:66-68`） | 2 つ | `portal.origin` 1 つ。`adminOrigin`・`admin_origin_missing`・`origin_same`（`:847-855`）を消す |
| `portal.entryAud`（`src/console/config.ts:72`） | `{ standard?, admin? }` | 1 つの文字列。生成器の `entry_aud_missing`（`src/console/generate.ts:178-193`）は「Standard の階層のチームが 2 つ以上」の条件のまま（ポータルの流れの決裁） |
| `boundaries[].issuers`（`src/console/config.ts:49`・`:538-558`） | `{ standard, admin? }` | `boundaries[].issuer` 1 つ |
| `admin_issuer_path`・`admin_issuer_multiple`・`admin_issuer_host_shared`（`src/console/config.ts:830-845`） | 誤り | **消す**（対象なし） |
| `boundary_tier_missing`（`src/console/config.ts:919-930`） | 境界に Admin の issuer が無いのに Admin のロールが届けば誤り | **消すと守りが黙って消える**ので、置き換える（案）: 新しい誤り `admin_boundary` = 「Admin の階層のロールが届く境界は `managed` だけ」。今は「Admin の issuer を持つ境界は 1 つ」と「issuer の無い境界に Admin を届けない」の 2 つで、管理外の先方に Administrator を配れなかった。生成器に加えて、Worker の生成物の検査（`src/console/portal/worker-config.ts`）でも拒否する。**保証は「Admin の階層に分類したロール」についてだけ**で、Standard に分類した強いロールを管理外へ配ることは止めない（tier は権限の強さを保証しない。`docs/specs/console-login.md:220`。§14 の S15）。§13 の論点 6 |
| `issuer_host_overlaps_portal`（`src/console/config.ts:813-828`） | 誤り | 残す（1 つのポータルと境界の issuer） |
| issuer の URL の重複（`src/console/config.ts:803-811`） | 「境界 × 階層」で重複を誤り | 「境界ごと」で残す |
| `teams[].tier`・`roles[].tier`・`tier_mismatch`（`src/console/config.ts:874`）・`admin_session_seconds`・`signin_access_admin` | 誤り | 残す |
| チーム名の重複（`src/console/config.ts:763`） | 全階層で 1 つの名前の表 | 残す（§7.1） |
| `signing.accountIds`（`src/console/config.ts:87-90`） | 署名を置くアカウント（KMS 案のころの名残。X1 で署名は Cloudflare） | 残す（害は無い）。消すかは ③ で判断 |

### 2.4 生成物の契約（`src/console/types.ts`）

| 生成物 | 今 | 新しい形（案） |
|---|---|---|
| 発行用 | `worker.standard.json`・`worker.admin.json`（階層ごと。`tier` を持つ） | `worker.json` 1 つ。`teams[]` に `tier`、`roles[]` に `tier`。`boundaries[]` は境界ごとの `issuer`。`portal.origin` 1 つ（`peerOrigin` なし） |
| 表示用 | `display.standard.json`（`adminOrigin` を持つ） | `display.json`（`adminOrigin` なし）。発行の経路から読まない性質は保つ |
| `stacksets.json` | `providers[].issuers.{standard,admin}` | `providers[].issuer` |
| `access.json`（Terraform の入力） | `origins.{standard,admin}` | `origin` 1 つ。チームの `tier` は残す（セッションの長さに使う） |

Worker は起動時（最初の要求）に、`schemaVersion` 1 の生成物を `server_misconfigured` で断る。

### 2.5 テンプレートと Rules

| 対象 | 扱い |
|---|---|
| `infra/aws/console/base.yaml` の `AdminIssuerHost`・`AdminPath`（`:88-109`）、`Rules`（`:111-120`）、`AdminProvider`（`:205-217`）、`AdminProviderArn`（`:297-303`） | **消す** |
| `AdminTierEnabled`（`infra/aws/console/base.yaml:122-127`）と、それで付けていた `AdminGuardPolicy`・`AdminGuardPolicyArn` の条件（`:222`・`:311`） | 条件を外して**いつも作る**（案。§6.2） |
| `StandardProvider`（`infra/aws/console/base.yaml:130-141`） | 名前は §3.1 で決める。タグ `awsbridge-console-tier: standard`（`:140-141`）は意味を失うので外す（案） |
| `StandardPath`（`infra/aws/console/base.yaml:74-81`） | パラメーター名を階層によらない名前に（案 `IssuerPath`。既定は §3.1） |
| 部品の `DenyConsoleProviderWrites` の Resource（`infra/aws/console/base.yaml:186-191`・`:266-268`） | 1 つのホスト `oidc-provider/${IssuerHost}/*` だけ（§6.1） |
| `src/console/template.ts` の `ISSUER_PARAMS`・`provider(tier)`（`:139-150`）、Admin のパラメーター（`:205-224`）、`HasAdminProvider`（`:237-240`） | Admin のパラメーターと条件を消し、どちらの階層のロールも同じプロバイダーを `Principal` にする。Admin のロールを作る条件は「`AdministratorTeams` が空でない」だけ |
| `src/console/template.ts:281-284` の ImportValue の注記（Admin の Export が無い基盤で解決に失敗しうる） | Admin の部品をいつも作るなら、注記の理由は消える。「割り当ての無いロールに ImportValue を出さない」は残してよい（害は無い） |
| ロールのテンプレートの `<Name>Teams` の `AllowedPattern`（`infra/aws/console/kind.example.yaml:33`・`:38`） | **残す**。B ではこれが「Admin のロールに Standard のチームを渡せない」テンプレート側の守りになる（§7.1） |
| `infra/aws/console/kind.example.yaml` | `mise run console:template:example` で作り直す |

### 2.6 Cloudflare の Terraform と道具

| 対象 | 扱い |
|---|---|
| `infra/cloudflare/console/variables.tf:16-24`（`admin_host`）、`infra/cloudflare/console/main.tf:12-23`（階層ごとのホストと入口のアプリ） | `admin_host` を消し、ホストは 1 つ。入口のアプリは 1 つ。チームのアプリは同じホストの `/t/<チーム>` で、セッションの長さは階層ごと（`admin_session_duration` は残す） |
| `scripts/console/access-inspect-lib.ts:37`、`src/console/access-inspect.ts:57-63` | 階層ごとのホストの読み分けをやめ、1 つのホストで全チームのアプリを見る |
| `scripts/console/admin-key*.ts`・`secrets-admin.ts` | 消す（③） |
| `scripts/console/standard-key*.ts`・`secrets.ts`・`secrets-lib.ts`・`key-tool-common.ts` | 改名して残す |
| `scripts/console/config.ts:122-125`（`worker.admin.json` を書く・前回の分を消す） | `worker.json` 1 つ。古い `worker.*.json` が残っていれば消す |
| `scripts/console/reconcile.ts:81`（既定の Worker の名前 2 つ） | 1 つ（§3.2） |
| `scripts/console/exposure-check-lib.ts:3-8`・`:114-130` | Admin の issuer と `ADMIN_PUBLIC_JWKS` の読み取りを消す（§9.3） |
| `scripts/poc/g2/time-gap.ts:31`（既定の Worker の名前 2 つ）、`scripts/poc/g2/clean-check-lib.ts:28-34`（ホストの接頭辞 4 つ）、`scripts/poc/g2/probe-lib.ts:145-149`（設定の `standardOrigin`・`adminOrigin` を本物のホストとして読む） | 1 つの Worker・2 つのホスト・`portal.origin` に直す（③。#51 の段 1 は `poc:g2:clean-check` を使う） |
| `wrangler.console-admin.jsonc` | 消す |
| `wrangler.console-standard.jsonc`（`name` は `wrangler.console-standard.jsonc:36`、`main` は `:37`） | 改名（案 `wrangler.console.jsonc`）。`name`・`main`・alias・vars の名前を §3.2 のとおり |

### 2.7 試験

方針: **消すのは対象が無くなったものだけ**。守りを確かめる試験は 1 つの Worker の形に書き直し、弱めない。陽性の対照は残す。

| 試験 | 扱い | 理由・新しい形 |
|---|---|---|
| `test/e2e/console-admin.test.ts`（Admin の Worker の通し） | **書き直し** | 1 つの Worker で Admin の階層のチームの通し（S2 → POST → 302、JWT の検証、発行記録の `tier admin`）。「Admin の issuer のホストの JWKS」は境界の issuer の JWKS に |
| `test/e2e/console-negative.test.ts:520-558`（陽性の対照。Standard・Admin の鍵あり・鍵なし・大きな JWT・certs） | 書き直し | 同じ Worker の Standard のチームと Admin のチーム（鍵なしの対照は「境界の鍵が無い」形） |
| `test/e2e/console-negative.test.ts:562-896`（`describe.each([stdT, adminT])` の両階層に共通の負の試験: Access JWT・Origin・CSRF・行・本文・メソッド） | **残す**（送り先だけ直す） | 2 つの Worker の代わりに、同じ Worker の Standard のチームと Admin のチームで回す。件数は減らさない |
| `test/e2e/console-negative.test.ts:898-940`（Standard 固有: Admin の行は `not_listed`・Admin のチームのパスは 404・鍵の不一致 503・鍵なし 500） | **書き直し（強める）** | `:902` → Admin の行を Standard のチームのパスに POST で 404 `not_listed`（残す）。`:906` → Admin のチームのパスは同じ Worker にあるので「Standard のチームの JWT で Admin のチームのパスは 403 `team_mismatch`」に。`:924`・`:928` は残す。§7.3 の X1〜X12 を足す |
| `test/e2e/console-negative.test.ts:942-985`（Standard の key-check） | 残す（送り先を直す） | Admin のチームの AUD での 403 は「チームの食い違い」の形に |
| `test/e2e/console-negative.test.ts:987-1034`（issuer のホストからポータルの経路に届かない） | 残す | `:1025` の「Admin のポータルのホスト」は対象なし（ホストが無い）。未知のホストの 404 は残す |
| `test/e2e/console-negative.test.ts:1036-1083`（チーム以外のパス・未知のチーム・入口の負の試験） | 残す | `:1067` の「Admin の入口の AUD」は対象なし（入口の AUD は 1 つ）。§5 の「env を読む前に 404」を足す |
| `test/e2e/console-negative.test.ts:1085-1133`（Admin 固有: Standard の AUD は Admin のチームのパスで 403、Origin が Standard のオリジンなら 403、チームのパス以外は処理の最初に 404） | 書き直し | `:1089` → Standard のチームの AUD は Admin のチームのパスで 403 `team_mismatch`。`:1095` は対象なし（オリジンが 1 つ）。`:1099-1133` は Worker 全体の早い 404 に |
| `test/e2e/console-negative.test.ts:1135-1176`（Admin の鍵の不一致・経過時間の上限・未来の iat・Admin の key-check） | **残す（Admin のチームのパスで）** | 経過時間の上限は Admin の階層のチームだけ（X6） |
| `test/e2e/console-negative.test.ts:1178-1234`（Admin の issuer のホストの 2 つの文書・ほかのホストでは出さない） | **対象なし（消す）** | Admin の issuer のホストが無い。境界の issuer の文書は `:987-1034` が受け持つ |
| `test/e2e/console-negative.test.ts:1240-1270`（`describe.each` の停止スイッチ） | 残す・足す | 同じ Worker の両チームで `LOGIN_DISABLED`。`ADMIN_LOGIN_DISABLED` の X10 |
| `test/e2e/console-negative.test.ts:1274-1316`（`describe.each` の Access アプリの無いチーム） | 残す | 両階層のチーム（`noapp` を Standard と Admin の両方に置く） |
| `test/e2e/console-negative.test.ts:1318-1350`（secret が壊れているとき） | 書き直し | `:1321`・`:1335` は同じ Worker の両チームで 500。`:1344` は Worker 全体の「既知の経路以外は env を読まずに 404」に |
| `test/e2e/console-isolation.test.ts:320-406`（2. Standard のバンドルに Admin の固有値が入らない） | **it ごとに分ける** | 対象なし: `:330`（Admin のエントリを読み込まない）・`:335`（Admin の発行に使える値が入らない）・`:349`（Admin の鍵の参照）。**残す（1 つの Worker のバンドルで）**: `:321`・`:355`（陽性の対照）、`:366`（文字列の JWK の経路が入らない）、`:375`（試験用の鍵を作るエントリが入らない）、`:382`（表示用の生成物は表示の形だけ。AUD・ARN を持たない）、`:392`（外部の script を読まない）、`:398`（MCP のコード・設定の解析器・生成器・scripts/ を読み込まない）。KMS の参照が入らない（`:349` の後半）も残す |
| `test/e2e/console-isolation.test.ts:408-527`（3. Admin のバンドル） | **it ごとに分ける** | 残す（1 つの Worker のバンドルに移す）: `:435`・`:442`・`:458-474`（**実行時の依存は jose だけ**）・`:519`。書き直し: `:409`・`:420`（陽性の対照は 1 つのバンドルで）。対象なし: `:450`・`:476`・`:491`（Standard のものが入らない）、`:507`（表示のコードを持たない。表示は同じバンドルに入る。ただし「発行の経路が表示を import しない」は別の試験で残す） |
| `test/e2e/console-isolation.test.ts:529-534`（KMS の参照の確認の対照） | 残す | |
| `test/e2e/console-isolation.test.ts:245-276`（生成物の対照） | 書き直し | 1 つの生成物に両階層の値があり、表示用には AUD・ARN が無い |
| `test/e2e/console-isolation.test.ts:278-318`（1. MCP のバンドルにコンソールが入らない） | 残す | D2 |
| 発行の経路が表示の照合を import しない（`test/unit/console-standard-layout.test.ts`・`console-isolation`） | 残す | U2 の条件 |
| `test/unit/console-admin-worker.test.ts:100-233`（Admin の 9 段目・前の段を Standard と同じに断る） | **書き直し** | 1 つの Worker の Admin の階層のチームで。`:131`（Standard の鍵の vars を読まない）・`:145`（Admin の入口の AUD が無くても動く）は対象なし。`:171`（Origin が Standard のオリジン）は対象なし |
| `test/unit/console-admin-worker.test.ts:235-309`（チームのパス以外は処理の最初に 404） | **書き直し（形を変える）** | Worker 全体: 既知の経路（入口・既知のチームのパス・境界の issuer の文書）以外は env を読む前に 404。env が壊れていても 404。`:291`（ホスト方式でホスト自体の / は 404）は「入口がある」形に |
| `test/unit/console-admin-worker.test.ts:311-337`（Access アプリの無いチームのパスは必ず断る） | 書き直し | AUD の無いチーム（どちらの階層も）は JWT があっても 403 |
| `test/unit/console-admin-worker.test.ts:339-398`（画面は Access JWT を確かめてから描く・S2 は Admin の行だけ・行の無いアカウントは 404・S0 は無い） | 書き直し | `:340`・`:356`・`:382` は Admin のチームのパスで残す。`:389`（S0 は無い）は対象なし（入口は同じ Worker にある） |
| `test/unit/console-admin-worker.test.ts:400-440`（`[ADMIN]` の印） | ④ で利用者の判断に合わせて書き直す | 見た目は守りではない |
| `test/unit/console-admin-worker-key.test.ts:154-243`（鍵があれば 302・使えなければ 503） | 書き直し | 境界の鍵で Admin の階層のチームの発行（`test/unit/console-standard-worker-key.test.ts` と合わせる） |
| `test/unit/console-admin-worker-key.test.ts:244-280`（`ADMIN_CURRENT_KEY`・`ADMIN_PUBLIC_JWKS` の形の誤りは 500） | 対象なし（`ADMIN_*` の vars が無い） | 同じ形の検査は境界ごとの鍵の vars の試験（`test/unit/console-standard-worker-key.test.ts`）にある。無い種別があれば移す |
| `test/unit/console-admin-worker-key.test.ts:281-320`（Access JWT の経過時間の上限） | **書き直し（足す）** | Admin の階層のチームのパスで 15 分を超えれば 401。**Standard のチームのパスでは見ない**（`:306` の対照を残す）。Admin のチームのパスに Standard の AUD で古い iat → 401（上限が先）、Standard のパスに Admin の AUD → 403 `team_mismatch` |
| `test/unit/console-admin-worker-key.test.ts:322-415`（Admin の issuer の文書） | **対象なし（消す）** | 境界の issuer の文書の試験（`test/unit/console-standard-worker.test.ts`）が受け持つ |
| `test/unit/console-admin-worker-key.test.ts:417-560`（key-check） | 書き直し | 回数の制限のキーは `admin-key-check:<sub>`（チームの階層）。Admin のチームの key-check はそのチームの行の境界だけ |
| `test/unit/console-admin-signer.test.ts`・`console-admin-key-tool.test.ts`・`console-admin-secrets.test.ts`・`test/e2e/console-admin-key-cli.test.ts` | **対象なし（消す）** | 規則の試験は `test/unit/console-signing-key.test.ts`・`console-standard-key-tool.test.ts` が持つ。消す前に、Admin にしか無かった検査（例 `test/unit/console-admin-signer.test.ts:306` の「行の issuer が固定と違えば署名しない」）が共通側にあるかを 1 件ずつ確かめ、無ければ共通側へ移す |
| `test/unit/console-base-template.test.ts:59-80`・`:250-311`・`:322-334`・`:385-398`・`:476-486` | **対象なし（消す）** | Admin のパラメーター・`Rules`・Admin のプロバイダー |
| `test/unit/console-base-template.test.ts:377`・`:399`（Admin の部品 = Standard と同じ文 + remote の Deny） | 残す | 部品は 2 つ残る |
| `test/unit/console-base-template.test.ts:468`（Admin の部品は Admin の階層を使うときだけ Export） | 書き直し | いつも Export する（§6.2 の案のとき） |
| `test/unit/console-base-template.test.ts`（部品の 6,144 文字の上限: ホストが 2 つの最悪） | 書き直し | ホスト 1 つで最悪の長さ（余裕が増える） |
| `test/unit/console-role-template.test.ts:152-260`・`:312-354`（Admin の Principal・`AdminIssuerHost`） | **書き直し** | Admin のロールの `Principal` は境界の 1 つのプロバイダー。**`AdministratorTeams` の `AllowedPattern` に Standard のチームが入らない**ことを新しく確かめる（§7.1） |
| `test/unit/console-config.test.ts:461-541`・`:546-560`・`:823-830` | 書き直し・消す | `adminOrigin`・Admin の issuer の検査は対象なし。`boundary_tier_missing` は `admin_boundary`（§2.3）に書き直す |
| `test/unit/console-config.test.ts:808-822`（`tier_mismatch`） | 残す | §7.1 |
| `test/unit/console-generate.test.ts:53-200`・`:404-460`・`:556` | 書き直し | 1 つの生成物。`row_team_tier` の陰性 |
| `test/unit/console-inspect.test.ts:344-351`・`:372-420`・`:494-530` | 書き直し | Admin のロールは境界の 1 つのプロバイダーを信頼。部品は 1 つのホスト。**Admin のロールの信頼ポリシーに Standard のチームがあれば誤り**（§7.1） |
| `test/unit/console-reconcile.test.ts:186`（プロバイダーの階層とロールのパスの食い違い） | **対象なし（消す）** | プロバイダーは階層を持たない。`:180`（記録の tier とロールのパス）と `:663`（admin の判定）は書き直して残す |
| `test/unit/console-exposure-check-lib.test.ts`・`test/e2e/console-exposure-check-cli.test.ts` | 書き直し | 境界ごとの issuer だけ |
| `test/e2e/console-wrangler-config.test.ts` | 書き直し | wrangler の設定 1 つ（`workers_dev`・`preview_urls` が false、`head_sampling_rate` 1、互換フラグなし） |
| `test/unit/console-standard-layout.test.ts:132`・`test/unit/console-layout.test.ts` | 書き直し | Admin のエントリの import の追跡を消し、1 つのエントリで MCP の部品を読まないことを見る |
| `test/unit/console-portal-pages.test.ts`（`createAdminWorker` を使う） | 書き直し | |
| `test/unit/console-issuer-path.test.ts:17-73` | §3.1 の決定に合わせて書き直し | `/console` にするなら、例・README・参考のテンプレートの既定の照合を変える。「issuer の URL に旧いパスを書かない」の走査は残す |
| `test/unit/readme.test.ts:65-100`（Admin の署名鍵・CSRF の鍵・初回の順） | 書き直し | 1 つの鍵の手順 |
| `test/unit/readme.test.ts:228-238`・`:328-357`（L2 の文） | 書き直し | 「Administrator だけの L2 は無い」・信頼ポリシーの Deny |
| `test/unit/readme.test.ts:359`（Administrator の別スタックの条件） | 残す | 別スタックは保つ |
| `test/unit/console-rollout-doc.test.ts`（#51 のブランチ。必須の文字列に `console:admin-key:check` など） | #51 の改訂で書き直し | §12.2 |

試験の数の見積もり: 継ぎ目（階層ごとの issuer を設定で持てる形）を残すと、Worker・生成器・テンプレート・照合の試験を「issuer 1 つ」と「issuer 2 つ」の両方で持つことになる。B だけにしたので、Admin 固有の試験（上の表で「対象なし」）は消え、その代わりに階層をまたぐ負の試験（§7.3）が増える。

---

## 3. 変えにくい名前

下流の本番の前に確定する。下流の本番にはまだコンソールのプロバイダーが無い前提（段 1 で確かめる）なので、今変える費用は上流の既定・例・試験・文書だけ。配ったあとは変えない。

### 3.1 IAM・CloudTrail に残る名前

| 名前 | 案 A（決裁で採用） | 案 B | 判断の材料 |
|---|---|---|---|
| issuer の URL | **決定**: `https://awsbridge-oidc-console.<domain>/console`（管理外は `/p/<id>/console`、世代つきは `/console-2`） | `https://awsbridge-oidc-console.<domain>/standard` のまま | `/standard` のままだと、Administrator の信頼ポリシーの条件キーが `<host>/standard:aud`、CloudTrail の `identityProvider` も `.../standard` になり、読む人を誤らせる。変える費用は今は上流の既定・例・試験・文書だけ（検証環境は片付けるので移行が無い）。案 B の利点は変更が少ないこと |
| issuer のパスを `/` にする案 | 採らない | — | `DenyConsoleProviderWrites` の Resource `oidc-provider/<host>/*`（`infra/aws/console/base.yaml:187`）は、パスの無いプロバイダー `oidc-provider/<host>` に当たらない [推測: ARN の照合の規則から。測っていない]。管理外の `/p/<id>/...` と入れ子にもなる |
| ホスト | ポータル `awsbridge-console.<domain>`、issuer `awsbridge-oidc-console.<domain>`（4 → 2） | — | `awsbridge-admin-console.*`・`awsbridge-oidc-admin-console.*` は使わない。issuer 専用のホストとポータルのホストを分ける理由（`docs/specs/console-login.md:187-190`）は変わらない |
| aud | `awsbridge-console`（定数 1 つ）のまま | 階層ごとの aud（例 `awsbridge-console-admin`） | 階層ごとの aud は、署名する Worker と鍵が同じなので侵害には効かない。効くのは Worker の取り違えのバグ（Standard のチームの行に Admin の aud を付けるなど）だけで、それは行の検査と信頼ポリシーのチームの条件で塞いでいる。aud を分けると OIDC プロバイダーの ClientIdList が 2 つになり、試験と文書が増える。**決定: 1 つのまま**（cto の決裁 2026-11-17「P2（B）の設計メモ」。G5 の前の議題に残す。§13 の論点 4） |
| ロールのパス | `/awsbridge-console/std/`・`/awsbridge-console/admin/` を保つ | — | 停止（SCP・`aws:PrincipalArn`）・照合・Worker の ARN の照合が階層をパスで見る。cto の決裁「階層という考えは残す」 |
| タグのキー・RoleSessionName・SourceIdentity | 変えない（`awsbridge_team`・`console-<email>`・email） | — | |
| 守りの部品の名前と Export | `AwsbridgeConsoleGuardStandard`・`AwsbridgeConsoleGuardAdmin`、`awsbridge-console-guard-*-arn`（`src/console/reserved.ts:20-32`）を保つ | — | 部品は 2 つ残る。名前は配ったあとに変えない |
| StackSet・スタックの名前 | `awsbridge-console-base`・`awsbridge-console-kind-<kind>`・Administrator の別スタック（例 `awsbridge-console-admin-default`）を保つ | — | |
| プロバイダーのタグ | `project: awsbridge` だけ（`awsbridge-console-tier` を外す） | `awsbridge-console-tier: console` | プロバイダーが階層を持たなくなるので、階層の名前を付けない |

### 3.2 リポジトリと Cloudflare の中だけの名前（IAM には出ない。下流の本番の前に決めれば足りる）

| 名前 | 今 | 案 |
|---|---|---|
| Worker の名前 | `awsbridge-console-standard`・`awsbridge-console-admin`（`wrangler.console-standard.jsonc:36`、`wrangler.console-admin.jsonc:35`） | `awsbridge-console`。照合の既定の Worker の名前（`scripts/console/reconcile.ts:81`）も同じ |
| wrangler の設定 | 2 つ | `wrangler.console.jsonc`（下流は `wrangler.<name>-console.jsonc`） |
| 鍵のバインディングの接頭辞 | `STANDARD_KEY_`・`ADMIN_KEY_` | `CONSOLE_KEY_` |
| 鍵の vars | `STANDARD_CURRENT_KEYS`・`STANDARD_PUBLIC_JWKS`・`ADMIN_CURRENT_KEY`・`ADMIN_PUBLIC_JWKS` | `CONSOLE_CURRENT_KEYS`・`CONSOLE_PUBLIC_JWKS`（境界 → 値の形は今の Standard と同じ） |
| 経過時間の上限の vars | `ACCESS_MAX_AGE_SECONDS`（Admin の Worker だけ） | `ADMIN_ACCESS_MAX_AGE_SECONDS`（Admin の階層のチームにだけ効くことを名前に出す。既定 900） |
| Admin だけの停止スイッチ（新しく足す案。§5） | — | `ADMIN_LOGIN_DISABLED` |
| 生成物 | `worker.standard.json`・`worker.admin.json`・`display.standard.json` | `worker.json`・`display.json` |
| alias | `awsbridge:console-worker`・`awsbridge:console-worker-admin`・`awsbridge:console-display` | `awsbridge:console-worker`・`awsbridge:console-display` |
| 署名のログのイベント | `console_standard_signer`・`console_admin_signer` | `console_signer` |
| 発行記録の `tier` | `standard`・`admin` | 変えない（照合が読む。値はチームの階層） |

---

## 4. 1 つの Worker が外に出す通信

### 4.1 宛先の一覧

| 宛先 | 何のため | どの経路で | 根拠 |
|---|---|---|---|
| `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`（`ACCESS_TEAM_DOMAIN` の vars の固定のオリジン） | Access JWT の署名の検証の鍵 | 入口・チームの画面・発行・key-check（両階層） | `src/console/issue/access.ts:122-128`。オリジンは起動時に検査（`src/console/portal/worker.ts:153-161`） |
| `https://sts.<STS_REGION>.amazonaws.com/` | `AssumeRoleWithWebIdentity`（POST） | 発行（両階層） | `src/sts.ts:97`、`src/console/issue/federation.ts:170`。リージョンは起動時に検査（`src/console/portal/worker.ts:198-204`） |
| `https://signin.aws.amazon.com/federation` | `getSigninToken`（POST、リダイレクトを追わない） | 発行（両階層） | `src/console/issue/federation.ts:9`・`:114-130` |
| （未接続）Access の身元のグループ（get-identity など） | 入口の一覧（U2）の表示の絞り込み | 入口だけ | 差し込み口だけで、本番のエントリは渡さない（`src/console/standard/index.ts:4`、`src/console/display/groups.ts:26`） |

- バインディング（`LOGIN_RATE_LIMITER`・`CF_VERSION_METADATA`・`secret_key`）と Workers Logs（`console.log`）は外への通信ではない
- ブラウザ側: CSP は `default-src 'self'`・`script-src 'self'`・`form-action` は自分と AWS の signin・console だけ（`src/console/http/headers.ts:20-29`）。外部の script・CDN は使わない（`src/console/portal/assets.ts:4`）
- 消えるもの: Admin の issuer のホスト（Custom Domain）。宛先は増えない

### 4.2 「実行時の外部依存なし」（X1 の (d)）の扱い

X1 の (d) の「実行時の外部依存」は npm の実行時の依存物のことで、Admin の Worker で「jose だけ・版を固定」を試験している（`test/e2e/console-isolation.test.ts:458-474`）。B では:

- **Worker 全体に掛ける**。Standard のエントリが引き込むものも、import をたどると jose だけ（`src/console/portal/login.ts:11`・`src/console/issue/access.ts:7`。MCP の `aws4fetch` は `src/proxy.ts` だけ）[推測: import をたどった。metafile での確認は ② の試験で行う]
- **外への通信を共通の関数に集める**（§14 の S16 を採用）: Worker の `fetch` を 1 つの関数に通し、用途ごとに宛先を検証する。Access の certs は `GET <ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`、STS は `POST https://sts.<STS_REGION>.amazonaws.com/`、getSigninToken は `POST https://signin.aws.amazon.com/federation` で、オリジン・パス・メソッドの完全一致だけを通し、どれも**リダイレクトを追わない**。今は getSigninToken（`src/console/issue/federation.ts:131`）と jose の JWKS の取得（`node_modules/jose/dist/webapi/jwks/remote.js:14`）が `redirect: "manual"` で、STS の呼び出し（`src/sts.ts:110-114`）は指定が無く既定の追従になっている。jose の取得は `createRemoteJWKSet` の独自の fetch の差し込み口でこの関数に通す。試験: 全 fetch の宛先を記録する擬似の fetch で、発行・画面・key-check の各経路の到達先がこの 3 つだけであること、3xx を失敗にすること
- 補助の試験（案）: バンドルの本文に現れる `https://` のホストの許可リスト。**通信先の制限ではなく補助の検査**（文字列の結合・vars の値・リダイレクトは見えない）。許可は `sts.<region>.amazonaws.com` の形・`signin.aws.amazon.com`・`console.aws.amazon.com`（CSP の `form-action`）に絞り、`amazonaws.com` 全体にしない。Access の certs の宛先は vars から来るので本文に出ず、上の共通の関数の試験が受け持つ
- 入口の get-identity は**つながない**まま ② を入れる。つなぐなら、Admin の発行と同じ Worker からの新しい宛先になるので、別に上申する（条件の案: 宛先は `ACCESS_TEAM_DOMAIN` のオリジンだけ・応答は表示だけに使い発行の経路は読まない・失敗は全チームのリンクに落とす・Sol）

---

## 5. Admin の Worker が持っていた守りの行き先

| 守り | 今（Admin の Worker） | B での行き先 | 範囲 | 試験 |
|---|---|---|---|---|
| チームのパスと issuer の文書以外を処理の最初に 404（env も JWT も見ない） | `src/console/portal/worker.ts:236-245`、`src/console/admin/worker.ts:84-88` | **形が変わる**。Admin のオリジンが無くなるので、「Admin の発行のオリジンには入口も Standard の画面も無い」性質は**失われる**（受容 c）。代わりに Worker 全体で「既知の経路（入口の `/` と `/assets/<許可リストの名前>`・既知のチームのパス・境界の issuer の文書）以外は env を読む前に 404」にする（今の Standard は env を読んだあとに 404） | 全体 | §2.7 の書き直し |
| Access JWT の `iat` からの経過時間の上限（既定 900 秒） | `src/console/admin/worker.ts:52-63`、`src/console/issue/access.ts:147-148`・`:170-176` | **Admin の階層のチームだけ**。パスのチームの階層で選んで `verifyConsoleAccess` に渡す（`src/console/portal/worker.ts:336-338`・`src/console/portal/login.ts:182`）。JWT の検証の前に選ぶが、AUD はパスのチームと一致しなければ断る（`src/console/issue/access.ts:194`）ので、選び方は回避できない。**これは「Access の JWT が発行されてからの時間」で、「利用者が認証してからの時間」ではない**（§14 の S4）。Access のアプリのセッション（15 分）や IdP の SSO が生きていれば、利用者が再認証しなくても新しい JWT が出て `iat` は新しくなる。XSS がその状態で Admin の発行を起こすことは、この上限では止まらない。再認証・MFA を求めるかは Access の設定（セッションの長さ・IdP への再認証の要求）と IdP の実際の挙動で決まり、§11.1 の M10 で測る | 階層ごと | Admin のチームのパスで古い iat → 401。Standard のパスでは見ない |
| aud ちょうど 1 つ・入口の AUD を受けない・サービストークンを断る・email と sub | `src/console/issue/access.ts:178-194` | もとから共通 | 全体 | 残す |
| 署名の自己検証・取り出せない鍵の検査・exp=iat+300・jti | `src/console/signing/signer.ts:1-9` | もとから共通（境界ごとの鍵） | 全体 | 残す |
| 回数の制限（`LOGIN_RATE_LIMITER`。キー `admin:<sub>`） | `src/console/portal/login.ts:302`、`src/console/portal/worker.ts:351` | 1 つのバインディング。キーはチームの階層で作る（`admin:<sub>`・`standard:<sub>`。key-check は `admin-key-check:<sub>`）ので、Viewer の発行が Admin の回数を使い切らない。**キーを分けて防げるのは利用者ごとの枠の干渉だけ**で、Worker・STS・Workers Logs などの共有の資源が詰まれば Admin の発行も止まる（§14 の S2）。バインディングが無い・例外のときは発行しない（`src/console/portal/login.ts:295-311`。fail-closed） | 階層ごと（キー） | キーの形の試験を書き直す |
| CSRF の鍵 | Admin と Standard で別の値（`wrangler.console-admin.jsonc:22-23`） | **1 つになる**。トークンは検証済みの aud と sub に束縛する（`src/console/issue/csrf.ts:2-3`）ので、Standard のチームのページのトークンは Admin のチームの POST に使えない。鍵が分かれていたことの上乗せは失われる。トークンの MAC は版・aud・sub・発行時刻を含み、期限は 10 分（`src/console/issue/csrf.ts:2`・`:9`）。**用途（どの画面の操作か）と行（アカウント・ロール）には束縛していない**ので、同じチームの S2 で取ったトークンを同じチームの別の行の POST に使える。行への束縛は**採らない**（cto の決裁 2026-11-17「P2（B）の設計メモ」。同じオリジンのスクリプトは止まらず、検証は `/login` だけのため。§14 の S3）。同じチームの別の行の POST に使えるのは仕様 | 全体 | Standard のチームの CSRF で Admin のチームに POST → 403 `csrf_failed`（§7.3） |
| 停止スイッチ（`LOGIN_DISABLED`） | Worker ごと（Admin だけ止められた） | `LOGIN_DISABLED` は全体を止める。**Admin の階層だけを止める `ADMIN_LOGIN_DISABLED` を足す**（決裁で決定。止める側に倒す読み方は `LOGIN_DISABLED` と同じ。`src/console/portal/worker.ts:147-151`）。**止めるのは新しい発行だけ**で、発行済みの STS のセッションは止まらない（§8.3） | 全体と Admin | Admin だけ止めると Admin のチームの POST が 503、Standard は通る |
| デプロイ用のトークンを分ける（X1 の (d)） | Admin 用と Standard 用 | 1 つ。**デプロイと鍵の操作は利用者だけ**（受容 b）。日常のトークンは「その Worker だけの Individual Workers Editor・ゾーン権限なし」（2026-11-16 の c1 の決裁）のまま | — | 段 2 の確認（§12） |
| 発行のオリジンの分離（P1'） | 別ホスト | **失われる**（受容 c）。ただし「同じオリジン」はパス方式（`routing: path`。既定）の話で、ホスト方式（`routing: host`）ではチームごとのオリジン `<team>.<host>` になる（`src/console/portal/routes.ts:67-82`）。ホスト方式では、Standard のチームの画面と Admin のチームの発行はオリジンが分かれ、入口とは別のオリジンになる | — | §8・§13 |

---

## 6. 守りの部品

### 6.1 プロバイダーのホストを条件にする文の書き直し

今の `DenyConsoleProviderWrites` は、Standard の部品で `oidc-provider/${IssuerHost}/*` と（Admin の階層があれば）`oidc-provider/${AdminIssuerHost}/*`（`infra/aws/console/base.yaml:186-191`）、Admin の部品で両方を条件なしで（`:266-268`）並べる。B では両方の部品を次の 1 つにする。

```yaml
Resource:
  - Fn::Sub: "arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/${IssuerHost}/*"
```

- 管理外の先方の issuer（`/p/<id>/...`）は同じホストの下なので、この 1 つで覆う
- `src/console/guard.ts:56-57` と inspect の照合（`src/console/inspect.ts:421-432`）も 1 つのホストにする
- G2-A で測った DN1〜DN3・DN8 は 2 つのホストの文だった。文が変わるので、§11.1 の M3 で測り直す。**測れなければ「書き直した文は未検証」と書いて残す**（G2-A の実測を引き継いで安全とは書かない。§14 の S17）

### 6.2 部品を 2 つ残すか

**2 つ残す**（Standard・Admin）。Admin の部品だけが `DenyAwsLoginRemote` を持ち（`infra/aws/console/base.yaml:281-287`）、`--remote` の Deny は保つ決裁がある。部品を 1 つにして `--remote` の Deny を Admin のロールのインラインに移す案は、守りの置き場所を変える別の論点なので採らない。

Admin の部品を何で作るか（`AdminTierEnabled` は `AdminIssuerHost` に依っていた。`infra/aws/console/base.yaml:122-127`）:

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| **P-1（決裁で採用）** | 条件を外し、Admin の部品と Export をいつも作る | パラメーターが減る。Admin のロールの ImportValue がどのアカウントでも解決する（`src/console/template.ts:281-284` の事情が消える）。「Admin をやめるとき Export を import されていて基盤の更新が失敗する」順序の罠（`infra/aws/console/base.yaml:19-20`）が消える | Administrator を配らないアカウントにも Admin の部品（Deny だけの管理ポリシー）が並ぶ |
| P-2 | 新しいパラメーター（例 `AdminTier: enabled|disabled`）で作る | 配らないアカウントに Admin の名前が出ない | P-A で外した `EnableAdminTier` と同じ形に戻る。順序の罠が残る |

P-1 のとき、「Administrator を配るアカウントだけ」のゲートは、Administrator のロールのスタック（別スタック）を作るかどうかだけになる。

---

## 7. 階層をまたぐ検査と負の試験

### 7.1 チーム名が階層をまたいで重ならない検査

B では、Viewer と Administrator の JWT は同じ issuer・同じ鍵・同じ aud で、違いはタグのチームの値だけ（受容 d）。Standard のチームと同じ名前が Admin のロールの信頼ポリシーに入ると、Standard のチームの人が Administrator に入れる。

| 層 | 検査 | 状態 |
|---|---|---|
| 設定 | チーム名は全階層で 1 つの表で重複を誤り（`src/console/config.ts:763`） | **既存** |
| 設定 | ロールとチームの階層が違う割り当ては `tier_mismatch`（`src/console/config.ts:874`） | **既存** |
| 参考のテンプレート | `<Name>Teams` の `AllowedPattern` は、その種類でそのロールに割り当てたチームだけ（`infra/aws/console/kind.example.yaml:33`）。StackSets のパラメーターの上書きで Standard のチームを `AdministratorTeams` に渡せない | **既存**。「Admin のロールのパターンに Standard のチームが入らない」を明示の試験にする（新） |
| 生成物（Worker が読む） | 行のチームはすべてその行のロールと同じ階層（新しい種別 `row_team_tier`）。チーム名の重複（`src/console/portal/worker-config.ts:136-139`）は既存 | **新規** |
| 署名の部品 | 署名の直前に、タグに入れるチームの階層と、ロールの ARN のパスの階層が同じことを確かめ、違えば署名しない（行の検査と別の層の多重の防御） | **新規** |
| inspect | Admin のパスのロールの信頼ポリシーの `aws:RequestTag/awsbridge_team` の値が、すべて設定の Admin の階層のチームであること（違えば誤り。逆向き（Standard のロールに Admin のチーム）も誤り）。今は「設定の割り当てと一致」（`src/console/inspect.ts:481-490`）で、手で足した値と、階層を変えて再利用した名前を、階層の誤りとして名指ししない | **新規**（新しい種別。例 `trust_team_tier`） |
| 運用の規則 | チームの階層を変えるときは新しい名前にする（同じ名前を別の階層で使い直さない）。古いスタックの信頼ポリシーに残った名前が、別の階層の人を通すため | **新規**（文書） |
| 設定（退役名の台帳） | 設定に `retiredTeams: [{ name, tier }]` を持ち、生成器は今のチーム名が台帳にあれば誤り（例 `team_retired`。同じ階層でも別の階層でも）にする。チームを消すときは台帳へ移す。**台帳から名前を消せないことを生成器で守る**（cto の決裁 2026-11-17「P2（B）の設計メモ」。例: 前回の生成物の台帳の名前が今の台帳に無ければ誤り）。inspect は、台帳の名前が信頼ポリシーに残るロールを誤りにする | **新規**（案。§14 の S10 を採用）。管理の外に出たアカウントの古いロールは inspect でも見えないので、使い直しを止めるのは台帳になる |
| タグの値（変わらない ID） | タグの値をチーム名ではなく、名前と別の変わらない ID（例 `t-<不透明な 8 文字>`）にする | **採らない**（cto の決裁 2026-11-17「P2（B）の設計メモ」）。タグの値はチーム名のまま（`docs/specs/console-login.md:228`） |

### 7.2 Worker の中の階層の決め方

- 階層は**要求ごと**に「パスのチーム → 設定のそのチームの `tier`」で決める（デプロイが階層を持つ今の形 `src/console/portal/worker.ts:178`・`src/console/portal/login.ts:124`・`src/console/portal/worker-config.ts:198` をやめる）
- パスのチームは Access の AUD と一致しなければ断る（`src/console/issue/access.ts:192-194`）ので、階層の根拠は検証済みの AUD
- 行の検査（7 段目）は、パスのチーム・行のロール・ARN のパスの 3 つの階層がそろうことを求める。そろわなければ `not_listed`
- 署名の部品は §7.1 の多重の検査を持つ

### 7.3 負の試験（Worker。unit と E2E）

| # | 要求 | 期待 |
|---|---|---|
| X1 | Standard のチームの AUD の JWT で、Standard のチームのパスに `entry=<account>:administrator` を POST | 404 `not_listed`（STS を呼ばない） |
| X2 | Standard のチームの AUD の JWT で、Admin のチームのパスに POST（Admin の行） | 403 `team_mismatch` |
| X3 | Standard のチームのページの CSRF トークンを付けて、Admin のチームの AUD の JWT で Admin のチームのパスに POST | 403 `csrf_failed`（aud に束縛） |
| X4 | Admin のチームの AUD の JWT で、Admin のチームのパスに `entry=<account>:viewer` を POST | 404 `not_listed` |
| X5 | 入口の AUD の JWT で、Admin のチームのパスに POST | 403 `unknown_audience` |
| X6 | Admin のチームのパスで、15 分より古い `iat` の JWT | 401（`too_old`）。同じ古さの Standard のチームのパスは通る（対照） |
| X7 | 生成物に、Admin のロールの行で Standard のチームを持つものを混ぜる | 起動時に 500 `server_misconfigured`（`row_team_tier`） |
| X8 | 生成物に、Standard のチームの行で ARN が `/awsbridge-console/admin/` のものを混ぜる | 500（`row_tier`） |
| X9 | 署名の部品に、タグのチームの階層と ARN のパスの階層が違う要求を直接渡す（unit） | 署名しない（`signing_unavailable` か新しい種別） |
| X10 | `ADMIN_LOGIN_DISABLED` が真のとき、Admin のチームの POST | 503 `login_disabled`。Standard のチームは 302（対照） |
| X11 | Admin のチームの key-check を Standard のチームの AUD で | 403。回数の制限のキーは `admin-key-check:` |
| X12 | 未知のパス・Admin のチームの名前に似たパス（`/t/<admin-team>x/`）・issuer のホストの `/t/...` | env を読む前に 404 |
| X13 | Admin のチーム A の AUD の JWT で、Admin のチーム B のパス・B だけの行に POST（同じ階層の別のチーム） | 403 `team_mismatch`・404 `not_listed`（§14 の S12） |
| X14 | 行の境界と、その境界の issuer・鍵が食い違う（行は境界 X、境界 X の鍵が無い） | 署名しない。ほかの境界の鍵で代用しない（`src/console/issue/sign-standard.ts:39-41`。`signing_unavailable`） |
| X15 | ホスト方式で、チーム A のホストにチーム B の AUD を送る／設定に無いホスト（別名） | 403 `team_mismatch`／404。Host → チーム → AUD の対応は 1 つだけ |
| X16 | Admin の確認画面の CSRF を、同じチームの別の行の POST に使う | **通る（仕様）**。CSRF は aud と sub に束縛し、行には束縛しない（cto の決裁 2026-11-17「P2（B）の設計メモ」。§14 の S3） |

### 7.4 負の試験（AWS 側）

| # | 内容 | 測り方 |
|---|---|---|
| A1 | Admin のロールの信頼ポリシーが許さないチームのタグで引き受ける → STS が断る | **本物の Worker はこの JWT を作らない**（X1・X2・X7〜X9 で断る設計）。鍵は取り出せないので手で作れない。測り方は cto の決裁 2026-11-17「P2（B）の設計メモ」 の (3): 段 4 で、弱い Admin ロールの信頼ポリシーのチームの値を API で直接**どのチームでもない名前**にずらし、本物の Worker の発行（Admin のチーム）で `sts_denied` を見る。そのあと API で戻し、`get-role` で戻ったことと、発行 1 回で成功することを見る（§11.1 の M2）。**本番の試験用の issuer では測らない** |
| A2 | Admin のチームのタグの JWT で、Viewer のロールを引き受ける → 断る | A1 と同じ形（Viewer のロールの信頼ポリシーには Admin のチームが入らないことを inspect で見る。§7.1） |

**A1 の測り方（cto の決裁 2026-11-17「P2（B）の設計メモ」 の (3)。§14 の S11）**: 過去の実測（P2・N10）は、B の「同じ issuer・同じ aud でタグだけが違う」形を直接測ったものではない。決裁の測り方は、本物の Worker・本物の issuer・本物のプロバイダーで「信頼ポリシーのチームの値と、タグのチームが合わなければ STS が断る」を測る。タグなし・未知のタグの値・タグの値が 2 つ・余分なタグのキー・SourceIdentity なしは、PoC の実測（P2 ケース 4〜8、N9 ケース 10。`docs/specs/console-login.md:336-338`）を引き、**「B の形では未検証（IAM の評価は issuer に依らないと推測）」**と書く。本番の試験用の issuer と写しのロールで測る案は採らない（利用者の前提＝このリポジトリでは動かさない、と「検証環境での取り直しは求めない」決裁に合わせ、本番に試験用の発行口も置かない）。信頼ポリシーを API で直接書き換えるので、**操作の一覧を利用者に見せて承認を取ってから**行う

本番の Worker に試験用の発行口（任意のタグで署名する経路）を足す案は採らない。それ自体が受容 a の穴になる。

---

## 8. 脅威モデルと受容の文

### 8.1 変わる箇所

| 文書の箇所 | 今 | B |
|---|---|---|
| `docs/specs/console-login.md:448`（Worker と検査が守る部分） | 鍵と issuer は階層 × 境界で分かれ、Standard の鍵のトークンは Admin のロールに入れない | 「鍵と issuer は境界ごと。Viewer と Administrator を分けるのは、Worker の AUD → チーム → タグと、信頼ポリシーのチームの条件だけ」。**Viewer の発行の経路の欠陥（Worker・鍵・設定）は、Administrator に届きうる** |
| `docs/specs/console-login.md:501`（A1 の資産） | 階層 × 境界ごとの鍵 | 境界ごとの鍵 1 つ。漏れれば、その境界の Viewer と Administrator の両方 |
| `docs/specs/console-login.md:544`（T3 Worker のバグ） | Admin の発行は別のオリジンの別の Worker だけ | 同じオリジン・同じ Worker。画面の欠陥（XSS）で動くスクリプトは、Admin のチームの Access のセッションを持つ人のブラウザで、Admin のチームのパスの S2 を読んで CSRF を取り、POST できる（確認画面は同じオリジンのスクリプトには境界にならない） |
| `docs/specs/console-login.md:611`（Admin の分離） | 別のオリジン・別の Worker・別の issuer のホスト・別の鍵 | 削る。残る分離は Access のアプリ（チーム・セッション 15 分）・ロールのパス・ロールの形・信頼ポリシーのチームの条件 |
| `docs/specs/console-login-admin.md:211-222`（X1 の受容の 4 点） | Admin の Worker が対象 | コンソールの Worker が対象。(1)〜(4) は残り、主語が広がる（Viewer の Worker の侵害 = Administrator） |
| `docs/specs/console-login-admin.md:271-303`（停止） | L0 は Admin の Worker、L2 は Admin のプロバイダー | L0 は `LOGIN_DISABLED`（全体）と `ADMIN_LOGIN_DISABLED`（Admin だけ。案）。`kid` を外すと Viewer も止まる。L2 は全体。Administrator だけの Cloudflare に頼らない停止は、信頼ポリシーの Deny と Administrator のスタックの削除（受容 e） |
| 照合の受容の文（2026-11-17 の c5 の Q5） | 「発行記録は Admin の Worker 自身が書く。Admin の Worker に書ける者に対しては、照合は独立の検知ではない」 | 「発行記録はコンソールの Worker 自身が書く。コンソールの Worker に書ける者（Viewer だけを扱う人を含む）に対しては、照合は独立の検知ではない」 |

### 8.2 README の目立つ所に置く文（案。日英の両方）

置き場所: README の「awsbridge でできること」のコンソールログインの項の直後（#51 の形では `origin/docs/readme-rewrite:README_ja.md:19-24` の位置）。

> **コンソールの Worker をデプロイできる者と、その secret・依存物に触れる者は、Administrator を配った全アカウントの全権を持ちます。**
>
> コンソールログインは、Viewer と Administrator を 1 つの Worker・1 つの issuer・1 つの署名鍵・1 つの OIDC プロバイダーで発行します（境界ごと。MCP の中継とは別）。使う前に、次を受け入れてください。
>
> a. コンソールの Worker 全体が Administrator の発行の権威です。Worker のデプロイの権限、secret（署名鍵のバインディング・CSRF の鍵）、依存物（npm の依存・ビルドの道具）のどれか 1 つで、Administrator を配った全アカウントの全権に届きます。Viewer のためだけの変更でも同じです。
> b. Worker のデプロイと鍵の操作は、Administrator を発行してよい人だけが行います。エージェント・CI・ほかの人に任せるなら、その相手に全権を渡すことになります。
> c. 入口・一覧・画面のスクリプトは、Administrator の発行と同じオリジンで動きます（パス方式（既定）では）。画面の欠陥は、Admin のチームの Access のセッションを持つ人のブラウザから Administrator の発行を起こしえます。確認画面はこれを止めません。
> d. Viewer と Administrator を分けるのは、Worker が Access のアプリの AUD から決めたチームと、そのチームを入れたセッションタグ、ロールの信頼ポリシーのチームの条件だけです。AWS の側では、issuer・鍵・audience に階層の区別がありません。チームの名前を階層をまたいで使い直さないでください。
> e. OIDC プロバイダーを消すと、Viewer も Administrator も止まります。Administrator だけを Cloudflare に頼らずに止める手段は、Administrator のロールの信頼ポリシーでの拒否と、Administrator のスタックの削除です。
>
> 発行記録はこの Worker 自身が書くので、この Worker に書ける者に対しては、CloudTrail との突き合わせは独立の検知ではありません。
>
> 発行を止める手段（停止スイッチ・kid の削除・プロバイダーの削除・信頼ポリシーの拒否）は新しい発行と引き受けを止めるだけで、発行済みのセッションは止めません。発行済みを止めるのはロールの revoke です。
>
> Admin のチームの Access JWT の経過時間の上限（既定 15 分）は、JWT が発行されてからの時間です。利用者が認証してからの時間ではありません。再認証を求めるかは Access と IdP の設定で決まります。
>
> Workers Logs を読める人は、発行記録（伏せ字）を読めます。ログの閲覧の権限も、この Worker の権限と同じ重さで扱ってください。

X1 の受容のうち (2)〜(4)（盗まれた鍵は Cloudflare に触らずに使え、`kid` を外すまで使える／Cloudflare に頼らない発行の停止と独立の発行記録が無い／Cloudflare の管理者 = Administrator を配った全アカウントの Admin）と受容 1（Administrator は対象アカウントに入口を残せる）は、今の README の該当の節に残す。

### 8.3 停止の書き分け（§14 の S1）

停止は 3 つに分けて書く。どれも、決まった時間を待って完了にせず、断られたことを確かめて完了にする。

| 止めるもの | 手段 | 効かないもの | 実測 |
|---|---|---|---|
| 新しい発行 | `LOGIN_DISABLED`・`ADMIN_LOGIN_DISABLED`・鍵のバインディングの削除 | 作り置きの JWT（期限内で kid が JWKS にあれば）・発行済みのセッション | `LOGIN_DISABLED` の反映は未測定（`docs/specs/console-login.md:659`） |
| 新しい引き受け（作り置きの JWT を含む） | kid を JWKS から外す・プロバイダーの削除（L2。Viewer も止まる）・Administrator のロールの信頼ポリシーの Deny | 発行済みのセッション | 旧い kid は外して約 62 秒以内に断られ、60 分戻らなかった（G2-A の A2）。L2 は約 12 秒（`docs/specs/console-login.md:661`）。信頼ポリシーの Deny は G2-A で測った（引き継ぐ） |
| 発行済みのセッション（STS・コンソール・`aws login`） | ロールの revoke（L3）・1 人停止（L3-1） | 作られた別の入口（アクセスキー・ロールなど） | revoke: Viewer の形で STS と `aws login` は約 8 秒、コンソールは約 1 分以内（`docs/specs/console-login.md:662`）。Administrator の形で付けて 20 秒後から CLI が明示の拒否、コンソールも権限のエラー（G2-A の C5）。何もしなくても MaxSessionDuration で切れる: Administrator の CLI は発行から 60 分で切れた（G2-A の ii-5） |
| 作られた別の入口 | 棚卸しと個別の削除（README の Administrator の残った権限の棚卸し） | — | revoke では止まらない |

G2-A の実測は決裁記録（cto の決裁 2026-11-16「G2-A の合否」）にあり、このリポジトリの仕様書（`docs/specs/console-login-admin.md:339`・`:416` の「② で測る」）にはまだ反映されていない。③ の付録の改訂で直す。

---

## 9. 照合・inspect・exposure-check

### 9.1 照合（`src/console/reconcile.ts`・`scripts/console/reconcile.ts`）

| 箇所 | 今 | B |
|---|---|---|
| 設定の issuer（`src/console/reconcile.ts:80-81`、`scripts/console/reconcile.ts:235-238`） | `{ url, tier }[]`（境界 × 階層） | `{ url }[]`（境界ごと）。コンソールの引き受けの見分け（ロールのパスかプロバイダーのホスト。`src/console/reconcile.ts:184-188`）は変えない |
| `provider_not_in_config`（`src/console/reconcile.ts:221-227`） | 誤り | 残す |
| `tier_mismatch`（プロバイダーの階層 ≠ ロールのパスの階層。`src/console/reconcile.ts:228-234`） | 誤り | **消す**（プロバイダーは階層を持たない） |
| `tier_mismatch`（記録の tier ≠ ロールのパスの階層。`src/console/reconcile.ts:256-262`） | 誤り | 残す |
| 記録のチームの階層 | 見ない | **足す**（案）: 記録の `team` が設定でどの階層か調べ、記録の `tier` とロールのパスの階層と違えば誤り（例 `team_tier_mismatch`）。設定に無いチームの記録も誤り |
| 対の階層（`src/console/reconcile.ts:274-275`） | 記録の tier・ロールのパス・プロバイダーのどれかが admin | 記録の tier・記録のチームの階層・ロールのパスのどれかが admin |
| `identity_not_compared_admin`（`src/console/reconcile.ts:299-303`）・Administrator の階層の発行の件数（`src/console/reconcile.ts:366-367`）・時間差の階層ごとの表示 | 誤り・表示 | **保つ** |
| 既定の Worker の名前（`scripts/console/reconcile.ts:81`） | 2 つ | 1 つ（§3.2） |
| 階層の説明（`src/console/reconcile.ts:38`） | 「記録の tier・ロールのパス・設定の Admin の issuer のどれか」 | 「記録の tier・記録のチームの階層・ロールのパスのどれか」 |

[未検証] CloudTrail の `AssumeRoleWithWebIdentity` のイベントに、引き受けたセッションのタグ（`awsbridge_team`）が出るなら、「タグのチームの階層 × ロールのパスの階層」を、記録に頼らない検査にできる（受容 d の穴を AWS の記録だけで見張れる）。出るかどうかと位置は確かめていない（`src/console/reconcile-input.ts:303` の SourceIdentity の位置と同じく、段 4 で実物の 1 件を読む）。§13 の論点 7。

### 9.2 inspect（`src/console/inspect.ts`）

| 箇所 | 今 | B |
|---|---|---|
| コンソールのホスト（`src/console/inspect.ts:376-384`） | 境界の Standard と Admin の issuer のホスト | 境界の issuer のホスト |
| 部品のホストの組（`src/console/inspect.ts:421-432`） | Admin の行がありかつ境界に Admin の issuer があれば 2 つ | 1 つ |
| ロールの issuer（`src/console/inspect.ts:457-461`・`:482-484`） | 階層ごとの issuer | 境界の issuer（階層によらない） |
| 信頼ポリシーのチーム（`src/console/inspect.ts:481-490`） | 設定の割り当てと一致 | 加えて §7.1 の階層の検査（新） |
| 部品が付いていること・中身（`src/console/inspect.ts:498-516`） | 階層ごとの部品 | 変えない（部品は 2 つ） |
| Admin の部品が付いた Standard のロール（警告）・Standard の部品だけの Admin のロール（誤り） | 既存 | 残す |

### 9.3 exposure-check（`src/console/exposure.ts`・`scripts/console/exposure-check-lib.ts`）

- 外から取る対象は境界ごとの issuer だけ。Admin の issuer の取得（`scripts/console/exposure-check-lib.ts:114-130`・`:157-158`）と `ADMIN_PUBLIC_JWKS` の読み取りを消す
- 判定（`src/console/exposure.ts:43-120`）は変えない
- 「Admin を飛ばした」の表示が無くなる。#51 の段 2 の期待値（`origin/docs/readme-rewrite:docs/console-production-rollout_ja.md:67`）も直す

---

## 10. PR の分け方

**main を半端にしない**: どの PR のあとも、`mise run test`・`mise run lint` が通り、生成器・Worker・テンプレート・道具・README が同じ形を指す。下流は ② 以降が全部入ったあとのコミットを記録して取り込む。

| PR | 中身 | 試験の要点 | レビュー |
|---|---|---|---|
| ① このメモ | 文書だけ | — | Sol → cto に再上申 |
| ② 切り替え | 設定のスキーマ 2（§2.3）・生成物の契約（§2.4）・生成器・base.yaml とロールのテンプレート（§2.5・§6）・Worker（§5・§7.2。Admin の階層のチームを受ける）・照合・inspect・exposure-check（§9）・Terraform と access-inspect（§2.6）・wrangler の設定 1 つ・mise のタスクの改名・**Admin の Worker のエントリと `wrangler.console-admin.jsonc` の撤去**・README の該当の節（タスク名と手順）と **§8.2 の警告の文**（main が B になった時点で README に載っていること）・§2.7 の試験の書き直し | §7.3 の負の試験（X1〜X12）・バンドルの依存と宛先・§2.7 で「書き直し」の全件・`mise run console:template:example` の差分が §2.5 のとおり・**README（日英）に §8.2 の文と a〜e があること**（`test/unit/readme.test.ts` に足す） | Sol |
| ③ 片付け | ② のあと参照されず、試験を変えずに残っていたもの: `scripts/console/admin-key*.ts`・`secrets-admin.ts` とその試験、`src/console/admin/` の残り、旧い PoC の設定の参照、仕様書の改訂（付録の一覧）。X2・X3・C-4・I-C の節に「履歴。現行ではない」 | 消したものを参照する試験・文書が残っていない | — |
| ④ 画面 | 見た目（カード。利用者の判断: 淡い青系、Admin を強調しない、区別は最小限） | 枠の禁止のヘッダー・CSP・`[ADMIN]` の扱い | — |
| ⑤ 流れ | Viewer だけ一覧から 1 回で開く（ポータルの流れの決裁）。設計書の §3.2・§3.3・§4.1・§4.2・§7・§9.2・§11.7・§12.1・§12.4 の改訂 | ポータルの流れの決裁の負の試験（トークンなし・別チームのトークン・期限切れの POST・GET で発行しない・入口の AUD・Admin の行を Standard に POST → `not_listed`・枠の禁止）に、B の X1〜X4 を同じ画面の経路で足す | Sol |

- ② と ③ の線: cto の決裁は「③ で使われない Admin の Worker を消す」だが、② で生成器が `worker.admin.json` を作らなくなると、Admin のエントリ（`src/console/admin/index.ts:4`）と Admin の E2E（`test/e2e/fixtures/console-admin-entry.ts`）は通らなくなる。**main を半端にしないため、Admin の Worker のエントリは ② で外す**（cto の決裁 2026-11-17「P2（B）の設計メモ」 の (a) で承認。§13 の論点 8）。③ に送れるのは「② のあと誰も参照せず、試験を変えずに通るもの」だけ（例: `scripts/console/admin-key-lib.ts:12` と `scripts/console/exposure-check-lib.ts:7-8` が `src/console/admin/` を import しているので、`exposure-check-lib` は ② で直し、`admin-key` の道具は ③ でまとめて消す）
- **検証環境の片付けとの順序（cto の決裁 2026-11-17「P2（B）の設計メモ」 の (4) で承認）**: 検証環境は P1' の形のまま片付け、片付けが済むまで毎日の照合と exposure-check を続ける。② と ③ はその道具の前提（Worker 2 つの照合の既定・Admin の鍵のタスク・Admin の wrangler の設定・設定のスキーマ 1）を変える。**旧い構成の撤去が済むまで ② をマージしない**。コードからエントリを消しても、配備済みの旧い Worker・Route・鍵・プロバイダーは残りうるため。撤去の完了は「旧い Worker 2 つの発行口が応答しない（Route・Custom Domain が無い）」「プロバイダーが無い」「残った資源の一覧が空」を確かめて記録する（人の承認: 検証環境の撤去）
- **足す条件（同じ決裁）**:
  - c1 `mise run console:inspect` を、段 4・Administrator のロールを作った直後・チームかロールの設定を変えたあとに**必ず回す**と、手順（README・導入の文書）に書く
  - c2 `src/sts.ts` のリダイレクトの直しは、**コンソールの呼び出しからだけ**指定を渡す形にする（`src/sts.ts` は MCP の中継も使う。MCP も変えるなら MCP の試験つきの別の PR）
  - c3 外への通信を 1 つの関数に集める直し（§4.2）は**切り替えの PR（②）に入れる**。試験: 到達先が 3 つ（Access の certs・STS・getSigninToken）だけであること、3xx を失敗にすること
  - c4 ② の Sol のレビューには、差分に加えて §11・§12 も渡す
  - c5 **② のマージの前に cto へ報告する**。中身: Sol の結果（と採否）、§7.3 の負の試験（X1〜X16）の結果、消した試験の一覧（§2.7 の「対象なし」の実際）、旧い構成の撤去の記録
  - c6 このメモの PR（文書だけ）は出してよい。出す前に、状態の行・§13 の答え・§7.4 と M2 をこの決裁に合わせ、実値が無いことを確かめる
- #51（README の作り直しと本番の導入の文書）: 今の形でマージしない。② のあとに B の形（§12）へ改訂し、③ と同じころに入れる。`test/unit/console-rollout-doc.test.ts`（#51 のブランチ）の必須の文字列（`console:admin-key:check` など）も直す
- #48（閉じた）・`feat/portal-design-a` は ④ の材料

---

## 11. 実測

### 11.1 取り直す実測（下流の本番の段 4。弱い Admin ロールで、Administrator なし）

検証環境での取り直しは求めない（cto の決裁 2026-11-17 続き）。外れたら `LOGIN_DISABLED`（Admin だけなら `ADMIN_LOGIN_DISABLED`）で止め、再上申する。**本番が測定の場になる**ことは利用者の受容が要る。

弱い Admin ロールの形（案）: パス `/awsbridge-console/admin/`、MaxSessionDuration 3600、Admin の部品、信頼ポリシーは Admin のチームだけ（参考のテンプレートの形）。権限は ReadOnlyAccess に、M3 の測定に要る操作だけの Allow（Resource は試験用のプロバイダーの ARN に限る）。**Allow が無いと暗黙の拒否になり、部品の Deny の判定にならない**（G2-A の DN6 の 1 回目と同じ）。

| # | 測るもの | 期待 | 注意 |
|---|---|---|---|
| M1 | 階層をまたぐ負の試験（Worker）: §7.3 の X1・X2・X5 を本物の Worker と Access で | 404 `not_listed`・403 `team_mismatch`・403 `unknown_audience`。STS を呼ばない（照合に引き受けが出ない） | Access のトークンは利用者のブラウザから |
| M2 | 階層をまたぐ負の試験（AWS）: §7.4 の A1。弱い Admin ロールの信頼ポリシーの `aws:RequestTag/awsbridge_team` の値を、API（`UpdateAssumeRolePolicy`）で**どのチームでもない名前**にずらす → Admin のチームで本物の Worker から発行 → API で戻す → `get-role` で戻ったことを確かめ、発行 1 回 | ずらした間の発行は `sts_denied`（STS が断る）。戻したあとの発行は成功 | cto の決裁 2026-11-17「P2（B）の設計メモ」 の (3)。信頼ポリシーをスタックの外で書き換えるので、**操作の一覧を利用者に見せて承認を取る**。書き換えは運用者（コンソールのロール以外）が行い、終わったらドリフトが無いことを確かめる。タグなし等は「B の形では未検証」（§7.4） |
| M3 | 書き直した部品の文（§6.1）: 弱い Admin ロールのセッションから、**同じホストの下の試験用のプロバイダー**への `TagOpenIDConnectProvider`（DN1 相当）・`AddClientIDToOpenIDConnectProvider`（DN2 相当）・`DeleteOpenIDConnectProvider`（DN8 相当）と、同じホストの別のパスでの `CreateOpenIDConnectProvider`（DN3 相当） | どれも `AccessDenied`・明示の Deny・部品の名前 `AwsbridgeConsoleGuardAdmin` | cto の決裁 2026-11-17「P2（B）の設計メモ」 の (3) で承認。条件: 試験用のプロバイダー（例 `https://<issuer-host>/dn-probe`）は**鍵なし・JWKS は 404・どのロールにも信頼させない**。運用者（コンソールのロール以外）が作り、**測ったら消す**。**本物のプロバイダー（Viewer も使う）には当てない**。弱い Admin ロールの Allow は、この 4 つの操作を試験用のプロバイダー（と DN3 相当で作ろうとするパス）の ARN に限る。**作れなければ、書き直した文は未検証と書く**（G2-A の実測を引き継いで安全とは書かない）。人の承認: 試験用のプロバイダーの作成と削除 |
| M4 | 鍵の差し替えの通し 1 回（新旧 2 つの JWKS → 新しい鍵で署名 → 旧い kid を外す） | Viewer と弱い Admin ロールの発行が途切れない。旧い kid を外したあと `console:key:check` が `[NG]` なし | 1 つの鍵なので Viewer にも効く |
| M5 | Admin のチームに許されていない利用者（別の身元）の発行 | Access が断る（チームのアプリ）。Access の設定の誤りで通っても、Worker が AUD で断る | 2026-11-12 の G1-b の「Admin に許されていない別の利用者での試験」 |
| M6 | 照合に Admin の階層として出ること | `admin issues: 1`（自分の発行の時刻）・identity の行が `admin 0`・誤り 0 | |
| M7 | Admin の階層のチームの Access JWT の経過時間の上限 | 15 分を超えた画面・POST が 401 | |
| M8 | CloudTrail の引き受けのイベントに、セッションタグが出るか（§9.1 の [未検証]） | 出る・出ないを記録 | 読むだけ。照合に使うのは別の PR（cto の決裁 2026-11-17「P2（B）の設計メモ」） |
| M9 | `ADMIN_LOGIN_DISABLED` | Admin のチームの POST が 503、Viewer は 302 | |
| M10 | Admin のチームの Access のセッションと JWT の `iat` の関係（§5）: Access のセッションの中で、再認証なしに新しい JWT が出て `iat` が新しくなるか。Access のセッションが切れたあと、IdP のセッションが生きていれば再認証の画面なしで戻るか | 結果を記録する。受容の文（§8.2）の書き方を確かめる | 利用者のブラウザで |
| M11 | Workers Logs の呼び出しの記録（プラットフォームが書くもの）に、要求のヘッダー（`Cf-Access-Jwt-Assertion`）・本文・302 の `Location` が入るか | 入らない。入るなら記録の範囲を絞るか、ログの閲覧を受容に含める | 実物の 1 件を読む（§14 の S18） |

### 11.2 引き継ぐ実測（仕組みに付くもの。測り直さない）

- DN4〜DN7 と、DN1〜DN3・DN8 のうちホストに依らない部分（明示の Deny が部品の名前つきで出ること。G2-A）
- セッションの切れ方（MaxSessionDuration 1 時間で 60 分）・revoke（L3）・1 人停止（L3-1）
- 信頼ポリシーの Deny（測った 2 通りの更新では戻らない。信頼ポリシーが変わる更新は未測定のまま）
- L2（プロバイダーの削除で新しい引き受けが止まる）。**前の決裁の「L2 は 1 つの issuer で取り直す」は直す**（cto の決裁 2026-11-17 続き）。B では L2 は Viewer も止めるので、本番では試さない
- Route の上書き（2026-11-16 の c1 の結果）と、日常のトークンからゾーンの権限を外す形
- 照合の読み落としの修正（c2）と、c5 の誤りの基準
- 対象なし: A1（Standard 用のトークンで Admin の Worker に書けないこと）と c1-d（Admin 側の同じ確認）。Worker が 1 つなので、トークンも 1 つ

---

## 12. 下流の本番の順序（B）と、導入の文書の直し方

### 12.1 順序

| 段 | 中身（B） | 今の #51 との違い |
|---|---|---|
| 0 | 上流の最新を取り込み、コミットを記録（② 以降がすべて入ったもの） | wrangler の設定は 1 つ |
| 1 | 対象のアカウントの確認（管理アカウントでない・同名のロールなし・コンソールのプロバイダーなし・MCP に触らない・残りものの確認） | 残りものの確認のホストの接頭辞は 2 つ |
| 2 | コンソールの Worker と Viewer だけを入れる。**デプロイと鍵の操作は最初から利用者**（受容 b）。設定に Admin の階層のチームとロールを入れない。初回の発行の当日に key-check・照合（jti 1 対 1）・workers.dev と Preview が応答しない・Cookie Path・aud（入口の AUD → `unknown_audience`、別のチーム → `team_mismatch`）・日常のトークンが Worker 1 つに限られる（2 つのホストへの Route の追加が 403）・exposure-check | Admin のトークン・4 つのホストの記述が無くなる |
| 3 | 毎日の確認が誤りなし・除外の件数が期待値の日が 1 日以上 | 変わらない |
| 4 | 設定に Admin の階層のチーム（Access のアプリ。セッション 15 分）と弱い Admin ロールを足して生成し、利用者が Worker をデプロイ。弱い Admin ロールは別スタックで作る。Admin のチームで 1 回発行し、§11.1 の M1〜M11。`mise run console:inspect` を回す（決裁の c1: 段 4・Administrator のロールを作った直後・チームかロールの設定を変えたあとに必ず回す） | 「Admin の Worker とプロバイダーを入れる」「Admin の key-check」「c1-d」が無くなる |
| 訓練 | 停止の訓練（Viewer の停止スイッチ・1 人停止・revoke、Administrator の棚卸しの前の状態）。足すもの: `ADMIN_LOGIN_DISABLED` と、弱い Admin ロールの信頼ポリシーの Deny（Administrator だけを止める形の練習） | |
| 5 | 実値つきの再上申（Sol 付き）と利用者の承認。そのあと Administrator を別スタックで作る（change set が `AdministratorRole` の `Add` だけ、作成直後に信頼ポリシーと部品を確かめる、Viewer のスタックの `AdministratorTeams` は空のまま）。弱い Admin ロールは、**Administrator の最初の発行を確かめたあとに消す**（cto の決裁 2026-11-17「P2（B）の設計メモ」） | 信頼ポリシーの確認は「コンソールのプロバイダーを名指し、チームの条件が Admin の階層のチームだけ」 |

### 12.2 `docs/console-production-rollout*.md`（#51 のブランチ）の直し方

行番号は `origin/docs/readme-rewrite:docs/console-production-rollout_ja.md`。英語版も同じ箇所を直す。

| 行 | 今 | 直し方 |
|---|---|---|
| :14 | 鍵の操作のタスク（`console:standard-key:put`・`console:admin-key:put`・`console:secrets:*`）。Admin の Worker のデプロイも同じ人 | 1 つの鍵のタスク名。**コンソールの Worker のデプロイ**も同じ人（受容 b） |
| :21 | wrangler の設定 2 つ | 1 つ |
| :37 | 残りものの確認のホストの接頭辞 4 つ | 2 つ |
| :52-55 | Standard と Admin のトークン・`AdminIssuerHost` を渡さない・4 つのホストの Route | 1 つのトークン・2 つのホスト。`AdminIssuerHost` の記述を消す |
| :61・:65 | `console:standard-key:check`。「上流では Admin の Worker でしか測っていない」 | 1 つの鍵のタスク。測った経路の記述は §11.2 に合わせる |
| :64 | 4 つのホスト・Admin の Worker への書き込み | 2 つのホスト。Admin の Worker の行を消す |
| :66 | `AWSBRIDGE_CONSOLE_LOGS_WORKERS` に Worker を 2 つ | 1 つ |
| :67 | Admin を飛ばした旨が出る | 消す |
| :92-110 | 段 4「Admin の Worker とプロバイダーを、Administrator のロールなしで入れる」 | §12.1 の段 4 に書き換え。:105（階層の間の aud）は「Standard のチームのトークンで Admin のチームの key-check と POST が開かない」として残す。:106（2 つのトークン）は消す |
| :112-117 | 停止の訓練 | §12.1 の訓練の足しを入れる |
| :127 | 署名の鍵の置き場所（Admin の Worker と `secret_key`） | コンソールの Worker と、その `secret_key`・vars・secrets を変えられる人。§8.2 の a〜e を読んで受容していること |
| :128 | 照合の受容（Admin の Worker） | §8.1 の書き直した文 |
| :137 | 信頼ポリシーが Admin のプロバイダーだけを名指し | コンソールのプロバイダーを名指し、チームの条件が Admin の階層のチームだけ |
| :142 | Admin のプロバイダーだけを止める（L2） | 「Administrator だけの L2 は無い」。信頼ポリシーでの拒否と、Administrator のスタックの削除 |

---

## 13. 迷っている点・Sol に見てほしい論点

### 13.1 cto に決めてほしいこと（cto の決裁 2026-11-17「P2（B）の設計メモ」 の答えを各論点の下に書いた）

1. **AWS 側の階層をまたぐ負の試験（§7.4 の A1）の測り方**: 本物の Worker は作らない JWT なので、(i) 既存の実測（P2 ケース 4・5、N10）で足りるとする、(ii) 試験用の issuer と写しのロールで条件の形を測る、(iii) 段 4 で信頼ポリシーを静的に確かめる、のどれ（組み合わせ）か。暫定: (i) + (iii)、(ii) は Sol が求めれば
   → **決裁**: 段 4 で弱い Admin ロールの信頼ポリシーのチームの値を API で直接ずらして測る（§7.4・§11.1 の M2）。タグなし等は「B の形では未検証」
2. **issuer のパス**（§3.1）: `/console`（推す）か `/standard` のままか
   → **決裁**: `/console`
3. **Admin の部品の作り方**（§6.2）: いつも作る（推す）か、パラメーターで作るか
   → **決裁**: いつも作る（P-1）
4. **aud**（§3.1）: 1 つのまま（推す）か、階層ごとか
   → **決裁**: 1 つのまま。G5 の前の議題に残す。付録の理由を書き換える
5. **チーム名の使い直しを道具で止めるか**（§7.1）: 文書の規則と inspect の検査だけにする（暫定）か、退役したチーム名の一覧を設定に持って生成器で止めるか
   → **決裁**: 退役名の台帳を採用。台帳から名前を消せないことを生成器で守る。変わらない ID は採らない
6. **管理外の先方の境界に Administrator を配れなくする守り**（§2.3）: `admin_boundary`（Admin の階層のロールは `managed` だけ）で置き換える（暫定）か、境界ごとの明示の印にするか
   → **決裁**: `admin_boundary` を承認。保証は Admin の階層に分類したロールに限って書く
7. **CloudTrail のタグでの照合**（§9.1・§11.1 の M8）: 出るなら ② のあとの別の PR で足すか
   → **決裁**: 別の PR
8. **② と ③ の線**（§10）: Admin の Worker のエントリを ② で外すこと（決裁の文では ③）
   → **決裁**: Admin の Worker のエントリを ② で外すことを承認
9. **`ADMIN_LOGIN_DISABLED` を足すか**（§5）: 暫定は足す（Administrator だけを Cloudflare の側で止める手段が L0 に戻る）
   → **決裁**: 足す。止める側に倒す読み方（`LOGIN_DISABLED` と同じ）
10. 段 4 の弱い Admin ロールを段 5 のあとに消すか（暫定: 消す）
   → **決裁**: Administrator の最初の発行を確かめたあとに消す
11. **書き直した部品の文の測り方**（§11.1 の M3）: 同じホストの試験用のプロバイダーで測る（暫定）。作れなければ G2-A の実測の引き継ぎと inspect の静的な照合で足りるとするか
   → **決裁**: 試験用のプロバイダーで測る（鍵なし・JWKS 404・どのロールも信頼しない、測ったら消す）。作れなければ未検証
12. **検証環境の片付けとの順序**（§10）: 片付けが済むまで ② をマージしない（暫定）か、② の前のコミットを控えてそこから道具を回すか
   → **決裁**: 旧い構成の撤去が済むまで ② をマージしない
13. **A-10 の (3) CODEOWNERS**（§1.2）: リポジトリに CODEOWNERS が無い。B で対象を `src/console/` 全体にして置くか、個人の OSS では置かない（受容 b に含める）か
   → **決裁**: 置かない（受容 b。③ で見直す）
14. **CSRF を行（境界・アカウント・ロール）と用途に束縛するか**（§5・§14 の S3）: cto の決裁 2026-11-17「ポータルの流れ」は CSRF の期限の延長・取り直しを承認の外とし、`/t/<team>/login` の検査の段と順は変えないとした。束縛の範囲を広げることは明記が無いが、CSRF の方式を変えるので判断を仰ぐ（再上申の要否も）
   → **決裁**: 採らない
15. **A1 を本番のアカウントの試験用の issuer で測ること**（§7.4・§11.1 の M2）: 本番に試験用のプロバイダーを一時的に置く。検証環境での取り直しは求めない決裁との関係
   → **決裁**: 測らない（論点 1 の答えのとおり）
16. **タグの値を変わらない ID にするか**（§7.1）: タグの値はチーム名の決定と当たる
   → **決裁**: 採らない

### 13.2 Sol への論点

- **受容 a〜e に漏れは無いか**。候補:
  - Viewer のためだけの変更（一覧の表示・Viewer の 1 回で開く流れ）を入れる人・道具も、Administrator の発行の権威に触れる（a に書いた）
  - 鍵の差し替えと `kid` を外す操作が Viewer と Administrator の両方に効く（片方だけ止められない）
  - CSRF の鍵が 1 つになる（aud に束縛しているので交差はしない、と考えている）
  - 入口の一覧の表示の照合（U2）の欠陥が、同じバンドルの発行の経路に届かないか（import の分離は試験で保つ）
  - localStorage（お気に入り・最近使ったもの。`src/console/portal/assets.ts:108-116`）が階層をまたいで共有される。値は表示とリンクだけに使う
- **同じオリジンで増える経路**:
  - 画面の欠陥（XSS）から、Admin のチームのパスの S2 を読み CSRF を取り POST する経路。今の守りは CSP（`script-src 'self'`・inline なし。`src/console/http/headers.ts:20-29`）、DOM を `textContent` だけで組むこと（`src/console/portal/assets.ts:11`）、Admin のチームの Access のセッション 15 分。足す候補: Admin の階層の POST に `Sec-Fetch-Mode: navigate`・`Sec-Fetch-Dest: document`・`Sec-Fetch-User: ?1`（利用者の操作による遷移）を求める [推測: 主なブラウザがこれらを送る。送らないブラウザの扱いと、スクリプトからのフォームの送信で `Sec-Fetch-User` が付かないことを確かめる要あり]。**補助の防御**で、確認画面・CSRF・Origin の検査の代わりにはしない。XSS は偽のボタンで利用者に押させられるので、「本人が対象のロールを確かめた」証拠にもならない（§14 の S5）。**決裁: Sec-Fetch の検査は入れない**（cto の決裁 2026-11-17「P2（B）の設計メモ」）
  - Access の Cookie Path を有効にしても、同じオリジンのスクリプトは別のパスに要求でき、ブラウザはそのパスの Cookie を付ける（Cookie Path は境界ではない。`docs/specs/console-login-portal.md:762`）
  - 1 回の POST の 302 の `Location`（サインインのトークン）を、同じオリジンのスクリプトが読めるか（`fetch` の `redirect: "manual"` では読めない、と考えている [推測]）。**読めなくても、POST の時点で STS の発行は済んでいる**。フォームの遷移でコンソールへのログインも起こせる。リダイレクトが見えないことを境界に数えない（§14 の S6）
  - ホスト方式（`routing: host`）では、チームごとにオリジンが分かれる（`src/console/portal/routes.ts:67-82`）。**決裁: ホスト方式は既定にしない。受容 c は「パス方式では」と書く**（cto の決裁 2026-11-17「P2（B）の設計メモ」）
- **チームのタグだけで階層を分ける強さ**: 信頼ポリシーの `aws:RequestTag/awsbridge_team` の完全一致・`aws:TagKeys` の制限・SourceIdentity 必須で足りるか。tier を JWT の別の claim や aud に入れても、署名する者が同じなので侵害には効かない、という整理は正しいか
- **退避先の継ぎ目を持たないことの帰結**: ③ で会社が分離を求めたときの作り直しと移行（新しいプロバイダー・信頼ポリシーの切り替え・Worker の分割）の大きさの見積もりが要るか

---

## 14. Sol のレビューの採否

- レビュー: Sol（openai/gpt-6.1-sol、effort medium）、2026-11-17。対象はこのメモの §1・§2.3・§4〜§10・§13。返答は信頼できない入力として扱い、決裁の代わりにしない
- 件数: 高 9・中 9。**決裁で確定: 採用 11・一部採用 4・不採用 1・既に満たす 2**（S3 を不採用、S14 を承認）
- 「既に満たす」は、コードか実測で確かめたものだけにした

| # | 重大度 | 指摘（要旨） | 採否 | 理由 | 根拠・直した節 |
|---|---|---|---|---|---|
| S1 | 高 | 停止しても既発行の権限は残る。「新規の停止」「既存のセッションの失効」「別の入口の除去」を分け、停止の時間を書き過ぎない | 採用 | 分けて書いた。失効の手段は revoke の実測を引いた | §8.3。revoke の実測（`docs/specs/console-login.md:662`、G2-A の C5）。60 分で切れた実測（G2-A の ii-5）。§5 の停止の行・§8.2 の文 |
| S2 | 中 | 共有の資源の枯渇で Admin も止まる。キーの分離は枠の干渉の対策に限って書く | 採用 | 書き方を直した。回数の制限が無い・例外なら発行しない（fail-closed）ことは既存 | §5 の回数の制限の行。`src/console/portal/login.ts:295-311` |
| S3 | 中 | CSRF は用途と行にも束縛する（XSS 対策とは書かない） | **不採用**（cto の決裁 2026-11-17「P2（B）の設計メモ」） | 同じオリジンのスクリプトは CSRF の束縛では止まらず、CSRF の検証は `/login` だけのため。X16 の期待値は「通る（仕様）」。期限（10 分）・aud・sub・版は今のまま MAC に入る | `src/console/issue/csrf.ts:2`・`:9`。§5 の CSRF の行、§7.3 の X16 |
| S4 | 高 | 15 分の `iat` の上限は再認証の保証ではない | 採用 | `iat` は Access の JWT の発行時刻で、Access のセッションや IdP の SSO で再認証なしに新しくなる。受容の文と §5 に明記し、実挙動を段 4 で測る | `src/console/issue/access.ts:170-176`（`iat` を見るだけ）。§5、§8.2、§11.1 の M10 |
| S5 | 中 | `Sec-Fetch-User` は確認画面の代わりにならない | 採用 | 補助の防御とし、確認画面・CSRF・Origin の代わりにしないと書いた。**決裁: Sec-Fetch の検査は入れない**（cto の決裁 2026-11-17「P2（B）の設計メモ」） | §13.2 |
| S6 | 中 | 302 が見えないことは発行の防止にならない | 採用 | 書き方を直した | §13.2 |
| S7 | 中 | localStorage の値を `href` に使う危険・CSP の明示 | 既に満たす | 保存値は読み出すときにチーム名・12 桁の ID・ロール名の形で検査し、合わなければ捨てる。リンクの起点はサーバーが埋め込んだチームの起点で、保存値ではない。URL はこの値から組み直し、ロールは `encodeURIComponent` を通す。CSP は `object-src 'none'`・`base-uri 'none'`・`frame-ancestors 'none'` を明示し、試験がある | `src/console/portal/assets.ts:54-56`・`:129`・`:144`・`:166`。`src/console/http/headers.ts:21-29`、`test/unit/console-http-headers.test.ts:40`・`:48` |
| S8 | 中 | ホスト方式の分離には成立条件がある（Cookie・CORS・別名のホスト） | 一部採用 | Host → チーム → AUD の対応と、別名のホストの拒否を負の試験に足した。Worker は CORS のヘッダーを出さない（`src/console` に `Access-Control` が無いことを grep で確かめた）。Cookie の範囲は Access の設定で、検査は `console:access:inspect` が受け持つ。**決裁: ホスト方式は既定にしない。受容 c は「パス方式では」**（cto の決裁 2026-11-17「P2（B）の設計メモ」） | §7.3 の X15、§13.2 |
| S9 | 高 | 信頼ポリシーは条件の値だけでなく全体（別の Allow・`IfExists`・別のプロバイダー）を見る | 既に満たす（B でも同じ方式を保つ） | inspect の信頼ポリシーの検査は許可リスト方式。Allow の文は 1 つだけ（2 つ以上は `trust_allow_extra`）。Principal・Action・Condition のキー・演算子・値を期待の形と組で照合し、知らないキー・演算子・最上位のキーは誤り。Deny の文は判定できなければ警告。B で足す階層の検査（`trust_team_tier`）も同じ関数に足す | `src/console/inspect.ts:6-9`・`:145-207`・`:240-268`。§7.1 |
| S10 | 高 | 名前の使い直しの禁止を文書だけにしない（退役名の台帳か、変わらない ID） | 一部採用（cto の決裁 2026-11-17「P2（B）の設計メモ」で確定） | 退役名の台帳は採用し、台帳から名前を消せないことを生成器で守る。タグの値を変わらない ID にする案は不採用（タグの値はチーム名のまま。`docs/specs/console-login.md:228`） | §7.1、§13 の論点 5・16 |
| S11 | 高 | A1 を過去の実測だけで保証しない。隔離環境で Standard のタグ・タグなし・未知のタグ・複数・SourceIdentity なしを測る | 一部採用（cto の決裁 2026-11-17「P2（B）の設計メモ」 の (3) で確定） | 過去の実測だけで保証したとは書かない。測り方は決裁の (3): 段 4 で弱い Admin ロールの信頼ポリシーのチームの値を API でずらし、本物の Worker の発行で `sts_denied`、戻して成功。隔離環境・本番の試験用の issuer では測らない。タグなし等は PoC を引き「B の形では未検証（IAM の評価は issuer に依らないと推測）」 | `docs/specs/console-login.md:336-338`。§7.4、§11.1 の M2、§13 の論点 1・15 |
| S12 | 中 | 同じ階層の別のチーム・境界と鍵の食い違い・Host とパスの食い違いも試験する | 採用 | 負の試験に足した。別のチームのパスは既に `team_mismatch` で断り、両階層で試験がある。境界の鍵が無ければほかの境界の鍵で代用しない | `src/console/issue/access.ts:194`、`test/e2e/console-negative.test.ts:666`、`src/console/issue/sign-standard.ts:39-41`。§7.3 の X13〜X15 |
| S13 | 中 | 分離への復帰はコードの変更ではなく再導入になる | 採用 | 下の追記のとおり | 下の「追記」 |
| S14 | 高 | コードの削除と配備済みの環境の撤去は別。撤去の完了をマージの条件にする | 採用（cto の決裁 2026-11-17「P2（B）の設計メモ」 の (4) で承認） | 暫定の案（片付けが済むまで ② をマージしない）を強め、撤去の完了の確かめ方と、先に入れるときの必須の条件を書いた | §10、§13 の論点 12 |
| S15 | 中 | `admin_boundary` は「管理外へ全権を渡さない」保証ではない | 採用 | 保証を「Admin の階層に分類したロール」に限って書いた。Worker の生成物の検査でも拒否する | §2.3。`docs/specs/console-login.md:220`（tier は権限の強さを保証しない） |
| S16 | 高 | バンドルの URL の検索は通信先の制限ではない。通信を共通の関数に集め、用途ごとに検証し、リダイレクトを拒否する | 採用 | 共通の関数の案を書いた。STS の呼び出しはリダイレクトの指定が無く、既定の追従になっていることを確かめた。Access の certs の宛先の漏れも直した。決裁の c2・c3: ② に入れ、`src/sts.ts` の指定はコンソールからだけ渡す | `src/sts.ts:110-114`、`src/console/issue/federation.ts:131`、`node_modules/jose/dist/webapi/jwks/remote.js:14`。§4.2 |
| S17 | 高 | 書き直した Deny を静的な照合だけで済ませない | 採用 | 測れなければ「未検証」と書く。G2-A の実測を引き継いで安全とは書かない | §6.1、§11.1 の M3 |
| S18 | 高 | ログとキャッシュへの認証材料の流出 | 一部採用 | 既に満たす部分は 3 つ: (1) 自前のログは種別だけで、発行記録は SigninToken・ログイン URL・鍵・セッショントークンを持たない。想定外の例外は文言だけを出す。試験がある (2) 画面と 302 は `no-store` で、試験がある (3) Worker は Cache API を使わない。採用する部分は 2 つ: プラットフォームが書く Workers Logs の呼び出しの記録に要求のヘッダー（Access の JWT）が入るかは確かめていないので段 4 で読む。ログの閲覧の権限は受容の文に足した | `src/console/issue/record.ts:6`、`src/console/portal/worker.ts:428`、`test/e2e/console-standard.test.ts:368`、`test/e2e/console-admin.test.ts:388`。`src/console/http/headers.ts:39`、`test/unit/console-http-headers.test.ts:55`・`:99`。§8.2、§11.1 の M11 |

**追記（S13）**: 階層ごとの issuer の継ぎ目は持たない（cto の決裁 2026-11-17 続き）。そのため、③ などで分離が要るときは、署名の部品の差し替えでは済まず**再導入**になる。範囲は 6 つ: 新しい issuer とホスト、プロバイダーの配布、Administrator の信頼ポリシーの切り替え、Worker の分割、Access のアプリとホストの付け替え、旧い構成の撤去。緊急時の即時の退避には使えない。手順の骨組みは、世代つきのパスへ移る手順（`docs/specs/console-login-admin.md:263` の §6.3。新しいプロバイダーの配布 → 信頼ポリシーの切り替え → 古いプロバイダーの削除）と同じ形になる [推測]。

### 決裁の答え（Sol の指摘から。cto の決裁 2026-11-17「P2（B）の設計メモ」）

- S3: CSRF を行と用途に束縛しない。X16 は「通る（仕様）」
- S10: 変わらない ID は採らない。台帳は採用し、台帳から名前を消せないことを生成器で守る
- S11: 本番の試験用の issuer では測らない。決裁の (3) のとおり段 4 で信頼ポリシーのチームの値を API でずらして測る
- S14: 旧い構成の撤去が済むまで ② をマージしない（承認）

---

## 付録: 既存の文書の直す節（承認のあと、③ と ⑤ で）

| 文書 | 節・行 | 直し方 |
|---|---|---|
| `docs/specs/console-login.md` | :26（用語の「階層」） | §1.1 の定義 |
| 同 | §2.2（:101-110） | Worker 1 つ・鍵は境界ごと・作るものと配るもの |
| 同 | §2.3 の表（:118）と P3 の段落（:154） | issuer と鍵は「境界ごと」。P3 の却下は保つ |
| 同 | §3 の表（:160-170）・§3.1（:172-205）・§3.2（:207-213）・§3.3（:215-223。tier の行は :220） | §3 の決定。I-A・I-B の比較は履歴へ。§3.2 の「issuer を階層 × 境界で分けているので aud を分けなくてよい」の理由を、決裁の理由に書き換える: 「aud は 1 つのまま（cto の決裁 2026-11-17「P2（B）の設計メモ」）。階層ごとの aud は署名する Worker と鍵が同じなので侵害には効かず、効くのは取り違えのバグだけで、それは行の検査と信頼ポリシーのチームの条件で塞ぐ。G5 の前の議題に残す」 |
| 同 | §4.2（:269-297）・§4.3・§4.8 の D3・D4 の言い直し（:446-450） | §6・§8.1 |
| 同 | §5（:501・:544・:611 など）・§6.1（L0・L2・L5）・§6.2 | §8 |
| 同 | §7（段階導入。② の順序）・§7.4.1（実装の状態）・§9（決裁の一覧に B を足す） | §11・§12 |
| `docs/specs/console-login-portal.md` | :10・:52・:160・§4.1・§4.8（:472-495）・§8（:743-776）・§9.1（:779-791）・§9.2・§9.3（:814-833）・§9.10（:911-929）・§11.3・§11.4（:1133）・§12.1（Q-P12）・§12.2（G-6） | 同じオリジン・1 つの Worker・1 つの生成物。§9.10 の分離の試験は §2.7 の形。U2 の分離（発行の経路が表示を読まない）は残す |
| `docs/specs/console-login-admin.md` | 冒頭と §1（:34-52）・§2（:54-112）・§3.1・§3.3・§4・§5（:209-236）・§6・§7（:271-303）・§8・§10（:345-360）・§11（D2 の条件 (1)(2)。:371）・§12・§13 | 文書の役割を「Administrator の発行の設計（B）」に直すか、`console-login.md` に吸収して「履歴」にする（③ で決める）。付録 A（C-4・I-C・KMS）と §10 の P1・P2 の比較は「履歴。現行ではない」と明記して残す |
| `README.md`・`README_ja.md`（main）| 「コンソールログインの必須のスタック（base）」（`README_ja.md:291-341`。`AdminIssuerHost`・L2）・「Standard の署名鍵」（:350-396）・「Admin の署名鍵」（:397-447）・突き合わせ・exposure-check の節 | ② で手順とタスク名、§8.2 の文。#51 を改訂して入れるなら、そちらに寄せる |
| `docs/console-production-rollout*.md`（#51） | §12.2 | §12.2 |
| `infra/cloudflare/console/README.md` | Admin のホスト | 1 つのホスト |
