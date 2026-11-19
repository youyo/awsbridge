# awsbridge

[English](README.md) | 日本語

Bridge AI agents to AWS.

awsbridge は、Cloudflare Access で認証された利用者の身元を、利用者ごとの AWS の一時認証情報に変えます。動くのは、自分自身が OIDC の issuer になる Cloudflare Worker です。Worker が利用者のために短命の JWT に署名し、AWS STS（`AssumeRoleWithWebIdentity`）がそれを対象のアカウントのロールの認証情報に引き換えます。Worker には長期の AWS のアクセスキーを置きません。

> 開発初期段階です。設計は [docs/specs/](docs/specs/) にあります。MCP の中継は [architecture.md](docs/specs/architecture.md)、コンソールログインは [console-login.md](docs/specs/console-login.md)・[console-login-portal.md](docs/specs/console-login-portal.md)・[console-login-admin.md](docs/specs/console-login-admin.md) です。下の手順のうち「まだ実行していない」「未測定」と書いたものは、例として読んでください。

前身: [youyo/aws-mcp-gateway](https://github.com/youyo/aws-mcp-gateway)

## awsbridge でできること

awsbridge の機能は 2 つです。機能ごとに Worker・issuer・IAM の OIDC プロバイダー・audience・ロールが分かれていて、片方だけでも使えます。

1. **MCP の中継**（`src/index.ts`、[`wrangler.jsonc`](wrangler.jsonc)）: 利用者の身元を利用者ごとの AWS 一時認証情報（STS）に変換し、SigV4 署名して AWS MCP Server へ中継します。Cloudflare MCP Portal の背後に置くことを前提としています。引数 `aws_profile` で AWS アカウントを切り替えられます。
2. **コンソールログイン**（`src/console/`、[`wrangler.console.jsonc`](wrangler.console.jsonc)）: 人が Cloudflare Access の背後のポータルを開き、AWS マネジメントコンソールか、CLI の `aws login` にログインします。入口・アカウントとロールの一覧・すべてのロールの発行を 1 つの Worker が受け持ち、issuer・署名鍵・OIDC プロバイダーは境界ごとに 1 つです。チームとロールには階層があります。
   - **Standard**（例 Viewer）: `aws login` は同じ端末と `--remote` の両方で使えます。
   - **Admin**（例 Administrator）: チームごとに短いセッションの Access のアプリを持ち、ロールは専用のパスに置いて `MaxSessionDuration` は 1 時間、`aws login --remote` は Deny です。チームの画面には Admin の印が付き、Administrator は Admin のチームのログインの画面（確認画面。入口の一覧はそこへつなぐだけ）からだけ発行します。突き合わせではより厳しく扱います。

   階層は Worker・issuer・鍵・ホストを分けません。発行で階層を分けるのは、チームと、ロールの信頼ポリシーのチームの条件だけです（下の受容 d）。ロールの権限の強さは保証しません（`docs/specs/console-login.md` §3.3）。

MCP 用のロール（`FederatedAwsBridgeMcpViewer` / `FederatedAwsBridgeMcpDebugger`）は、人のコンソールログインのロール（例 `FederatedAwsBridgeViewer` / `FederatedAwsBridgeAdministrator`）とは別のロールです。人にコンソールのロールを与えても、MCP 用ロールの権限は変わりません。

この README の段階は、`docs/specs/console-login.md` §7 の段階導入に従います。段階 1 はコードの完成、段階 2 は個人の環境での導入と試験、段階 3 は会社への導入です。下流リポジトリでの本番の導入の段は [本番でのコンソールログインの導入](docs/console-production-rollout_ja.md) に書きました。

## コンソールログインを使う前に（受容する限界）

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
> 1 つの Worker が分けるのは階層の間の権限で、可用性は分けません。鍵の設定の不備（例: 1 つの鍵が 2 つの境界にある、今の kid が公開鍵に無い。今の kid を外すとこれになります）では、Worker のどの経路も `500 server_misconfigured` になります。すべての境界のポータルと issuer の文書、両方の階層です。
>
> 発行記録はこの Worker 自身が書くので、この Worker に書ける者に対しては、CloudTrail との突き合わせは独立の検知ではありません。
>
> 発行を止める手段（停止スイッチ・kid の削除・プロバイダーの削除・信頼ポリシーの拒否）は新しい発行と引き受けを止めるだけで、発行済みのセッションは止めません。発行済みを止めるのはロールの revoke です。
>
> Admin のチームの Access JWT の経過時間の上限（既定 15 分）は、JWT が発行されてからの時間です。利用者が認証してからの時間ではありません。再認証を求めるかは Access と IdP の設定で決まります。
>
> Workers Logs を読める人は、発行記録（伏せ字）を読めます。ログの閲覧の権限も、この Worker の権限と同じ重さで扱ってください。
>
> 退役したチーム名の台帳（下）について: 台帳は運用者の取り違えを止める守りで、設定を書ける者への守りではありません。生成物を消して初回の指定（`--ledger-init`）を付ければ外せます。管理外に出たアカウントの古いロールは `mise run console:inspect` でも見えず、守りは台帳だけです。

チームの階層を変えるときは新しい名前にします（同じ名前を別の階層で使い直さない。古いスタックの信頼ポリシーに残った名前が、別の階層の人を通すため）。チームを消すときは、設定の `retiredTeams`（退役したチーム名の台帳）へ移します。`mise run console:config:generate` は、台帳の名前を今のチームに使うこと・台帳から名前を消すこと・消したチームを台帳へ移さないこと・同じ名前の階層を変えることを誤りにします。 手順は「コンソールログインのセットアップ」の「退役したチーム名の台帳」に書きました。

## 上流と下流

このリポジトリは**上流**です。OSS で、コード・テンプレート・道具と、値がプレースホルダー（`example.com`・`111111111111`）の設定の例だけを持ちます。本番はここからは動かしません。

本番は private の**下流**リポジトリから動かします。下流は awsbridge の clone で、awsbridge を `upstream` のリモートとして残し、自分のファイルを足します。実際のホスト・アカウント ID・email・鍵は下流にだけ置きます（秘密は gitignore したファイルにだけ置きます）。

| | 上流（このリポジトリ） | 下流（private） |
|---|---|---|
| 持つもの | Worker、CloudFormation のテンプレート、参考の Terraform、mise のタスク、例（`config/*.example.json`、`example.com` を書いた `wrangler*.jsonc`） | `wrangler.<name>.jsonc`（MCP）、`wrangler.<name>-console.jsonc`（コンソールログイン）、`mise.<name>.toml`、`.miserc.toml`、`deploy/profiles.json`、コンソールログインの設定ファイル（例 `deploy/console.json`） |
| 持たないもの | 実際のホスト・アカウント ID・email・鍵 | 上流のファイルの編集（新しいファイルを足すだけなので、`git pull` で衝突しない） |
| 秘密 | なし | `mise.local.toml` と `.secrets/`（gitignore。コミットしない） |

下流リポジトリの組み方の順番は「下流リポジトリでの運用」に書きました。

## 構成

Cloudflare 側（Worker）と AWS 側（CloudFormation）は完全に分かれています。Worker のデプロイは AWS を呼ばず、CloudFormation のデプロイは Cloudflare を呼びません。対象の AWS アカウントには CloudFormation だけを流せば足ります。AWS のアカウントが issuer を信頼するのは IAM の OIDC プロバイダーを通してだけで、issuer のホストは 1 つの Worker が出します。

### MCP の中継

```
MCP クライアント（Claude など）
  │
  ▼
Cloudflare MCP Portal ─▶ Cloudflare Access（接続先のホストのアプリ）
  │  https://awsbridge-mcp.example.com/mcp
  ▼
MCP の Worker（wrangler.jsonc）
  │ 1. Access JWT を検証し（ACCESS_AUD）、email を取る
  │ 2. SIGNING_JWK で 5 分の JWT に署名する（issuer = AWSBRIDGE_ISSUER）
  │ 3. 選ばれた aws_profile のロールで STS AssumeRoleWithWebIdentity
  │ 4. 要求に SigV4 で署名して中継する
  ▼
AWS MCP Server ─▶ 対象のアカウントの AWS の API

STS は https://awsbridge-oidc-mcp.example.com/.well-known/* を読む（公開。同じ Worker が出す）
対象のアカウントごと: infra/aws/awsbridge.yaml（IAM の OIDC プロバイダー + MCP 用のロール 2 つ）
```


### コンソールログイン

```
人のブラウザか端末
  │
  ▼
Cloudflare Access（入口のアプリと、/t/<チーム> ごとのチームのアプリ。
                  Admin の階層のチームのアプリはセッションが短い）
  │
  ▼
コンソールの Worker（wrangler.console.jsonc）。両方の階層で 1 つ
  │ ポータル https://awsbridge-console.example.com                  入口・一覧・/t/<チーム> での発行
  │ issuer   https://awsbridge-oidc-console.example.com/console     discovery と JWKS だけ
  │ 鍵       境界ごとの secret_key（CONSOLE_KEY_*）。両方の階層で使う
  │ 1. Access JWT を確かめ（aud はちょうど 1 つ）、AUD からチームを（チームから階層を）決める
  │ 2. 5 分の JWT に署名（aud awsbridge-console、チームをセッションタグに）
  ▼
対象アカウントの STS AssumeRoleWithWebIdentity
  │ 信頼ポリシー: コンソールのプロバイダー・aud awsbridge-console・チームのタグ（ロールの階層のチームだけ）・SourceIdentity 必須
  ▼
getSigninToken ─▶ AWS マネジメントコンソール（か aws login）

対象アカウントごと: 必須のスタック infra/aws/console/base.yaml（境界ごとに OIDC プロバイダー 1 つ + 両階層の守りの部品）
                    + 設定から生成するロールのスタック（kind.<kind>.yaml）。Administrator のロールは別スタック
発行記録（console_issue）─▶ Workers Logs ─▶ mise run console:reconcile（CloudTrail と突き合わせ）
```

- Worker がチームを決めるのは、要求が通ってきた Access のアプリの AUD からだけで、そのチームをセッションタグに入れます。誰がどのロールに入れるかは、AWS がロールの信頼ポリシーで決めます。チームと種類（アカウントの種類）とロールの対応は、コンソールの設定ファイルとロールのスタックにあり、Worker にはありません。
- 境界は信頼の境界です（`managed`、管理外の先方は `partner:<id>`）。境界ごとに issuer・鍵・プロバイダーを持ち、Standard と Admin の階層で同じものを使います。
- 階層はチームとロールの区分として残ります。階層が決めるのは、チームの Access のアプリ（Admin の階層のチームはセッションが短く、Worker もその Access JWT の経過時間を絞ります）、ロールのパス（`/awsbridge-console/std/` か `/awsbridge-console/admin/`）、ロールの形（Admin の階層は `MaxSessionDuration` がちょうど 1 時間で、`aws login --remote` なし）、守りの部品、確認画面、突き合わせでの扱いです。

### ホスト

| ホスト（例） | Worker | 用途 | Access |
|---|---|---|---|
| `awsbridge-mcp.example.com` | MCP | MCP の接続先（`/mcp`） | 守る。アプリの AUD が Worker の `ACCESS_AUD` |
| `awsbridge-oidc-mcp.example.com` | MCP | MCP の issuer（`/.well-known/*`） | 公開（STS が読む）。ほかのパスは 401 |
| `awsbridge-console.example.com` | コンソール | ポータル（入口と、両階層のチームの `/t/<チーム>`） | 入口とチームのアプリ。Cookie Path を有効にする |
| `awsbridge-oidc-console.example.com` | コンソール | コンソールの issuer（`/console`。管理外の先方は `/p/<id>/console`） | Access のアプリを置かない（STS が読む）。issuer の文書以外のパスは 404 |

- 本番の設定（コンソールの Worker と、MCP の Worker の `env.prod`）は、Cloudflare のアカウントにあるゾーンの Custom Domain を使い、`workers_dev` と `preview_urls` を `false` にして、Access を経由しない入口を閉じます。workers.dev を使うのは MCP の試用の設定 `env.dev` だけです。
- 接頭辞 `awsbridge-oidc-` は、issuer だけのホストの目印で、持ち主も示します。同じドメインで別の仕組みの OIDC を立てたときに、issuer ごとの持ち主が分かるようにするためです。
- **issuer のホストは、IAM の OIDC プロバイダーが信頼する相手です。** これを乗っ取った者は、AWS が受け付けるトークンを発行できます。ドメインの自動更新を有効にし、レジストラでドメインをロックし、ゾーン（DNS・Routes・Custom Domain）の編集と Worker のデプロイができる人を絞ってください。

## 下流リポジトリでの運用

実運用は private の下流リポジトリで行う想定です。awsbridge を `upstream` として登録して更新を pull し続けます。**上流のファイルは一切編集せず、新しいファイルを足すだけ**で自分の環境にデプロイできます（`git pull` で衝突しません）。以下の `<name>` は環境名です（例 `awsbridge-mcp`）。

### 初回の順番の全体像

1. 下流リポジトリを作り、ファイルを足します（下の手順 1〜4）。
2. MCP の中継: 「MCP の中継のセットアップ」の「初回の順序」に従います。
3. コンソールログイン（任意。あとからでもよい）: 「コンソールログインのセットアップ」の「初回の順番（コンソールログイン）」に従います。まず Standard の階層（Viewer）だけを組み、Admin の階層は [本番でのコンソールログインの導入](docs/console-production-rollout_ja.md) の確認を済ませてから足します。
4. コンソールログインが動き始めたら、「日々の運用」の毎日の確認を始めます。

### 手順

1. 下流リポジトリを作り、上流を取り込む。

```
git clone <awsbridge の URL> my-awsbridge && cd my-awsbridge
git remote rename origin upstream
git remote add origin <private リポジトリの URL>   # 下流の push 先
```

2. MCP の Worker 用に `wrangler.<name>.jsonc` を足す（コミットする。ロール ARN は秘密ではない）。`main` などは上流の `wrangler.jsonc` と同じ値にし、`name` / `workers_dev` / `preview_urls` / `routes` / `alias` だけ自分用にします。`alias` で、プロファイル一覧の JSON（例のすぐあとで説明する `deploy/profiles.json`）をモジュール `awsbridge:profiles` として差し替えます。env セクションは使いません（値はダミーです）。

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "awsbridge-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "awsbridge-mcp.example.com", "custom_domain": true },
    { "pattern": "awsbridge-oidc-mcp.example.com", "custom_domain": true }
  ],
  "alias": { "awsbridge:profiles": "./deploy/profiles.json" }
}
```

   `awsbridge-mcp.example.com` が MCP の接続先、`awsbridge-oidc-mcp.example.com` が issuer のホスト（`AWSBRIDGE_ISSUER=https://awsbridge-oidc-mcp.example.com`）です。どちらも自分のドメインに置き換えます。workers.dev で試すだけなら、`workers_dev` を `true` にし、`preview_urls` と `routes` を外します。

   `deploy/profiles.json` の形式は「マルチアカウント」の JSON と同じです（コミットする。ロール ARN は秘密ではない）。上流の `config/profiles.example.json` をコピーして書き換えると早いです。

   コンソールログインを使うなら、同じやり方で `wrangler.<name>-console.jsonc` を足します。上流の `wrangler.console.jsonc` を元にし、`routes` と `vars` を自分の値にします（`alias` は `.generated/console/` の生成物に向けたままにします）。設定ファイル（例 `deploy/console.json`。`config/console.example.json` か `config/console.company.example.json` を元にする）も足します。詳しくは「コンソールログインのセットアップ」です。

3. 下流用の mise 設定ファイルを足す。`mise.<name>.toml` と、それを有効にする `.miserc.toml` の 2 つです（どちらもコミットする。秘密値は入れない）。

```toml
# mise.awsbridge-mcp.toml
[env]
AWSBRIDGE_WRANGLER_CONFIG = "wrangler.awsbridge-mcp.jsonc"
AWSBRIDGE_WRANGLER_ENV = ""                      # 空 = --env を付けない（未設定だと上流の dev になる）
AWSBRIDGE_STACK_NAME = "awsbridge-mcp"
AWSBRIDGE_KEY_FILE = ".secrets/awsbridge-mcp-signing-key.json"   # 環境ごとに別の鍵にする
# AWS_PROFILE = "<デプロイに使う AWS CLI プロファイル>"
# AWSBRIDGE_AUDIENCE = "awsbridge"               # 変える場合は Worker の var STS_AUDIENCE も揃える
# コンソールログイン（使うときだけ）
# AWSBRIDGE_CONSOLE_CONFIG = "deploy/console.json"
# AWSBRIDGE_CONSOLE_WRANGLER_CONFIG = "wrangler.awsbridge-mcp-console.jsonc"
```

```toml
# .miserc.toml
env = ["awsbridge-mcp"]
```

4. 秘密値と環境固有値を `mise.local.toml`（gitignore。コミットしない）に書く。`AWSBRIDGE_ISSUER`（issuer の URL。例 `https://awsbridge-oidc-mcp.example.com`）、`AWSBRIDGE_ALLOWED_SUBJECTS`、`AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS`、`AWSBRIDGE_ACCESS_TEAM_DOMAIN`、`AWSBRIDGE_ACCESS_AUD` など（「`mise.local.toml` の変数」を参照）と、コンソールログインの各節に書いた道具の変数です。プロファイル一覧は `mise.local.toml` ではなく `deploy/profiles.json` に置きます。

5. MCP の中継をデプロイする（初回）。Cloudflare Access を含む全体の順は、「MCP の中継のセットアップ」の「初回の順序」です。

```
mise run keygen                                               # AWSBRIDGE_KEY_FILE に署名鍵を生成
AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker  # 初回は wrangler.<name>.jsonc で明示の経路（Worker と Custom Domain を作る）→ secrets を登録
AWS_PROFILE=<対象> mise run deploy:aws                         # アカウントごとに CloudFormation を流し、出力 ReadOnlyRoleArn / DebugRoleArn を deploy/profiles.json に書く
mise run deploy:worker                                        # プロファイル一覧をバンドルする（既定の経路）
```

6. 上流の更新を取り込む。

```
git pull --no-rebase upstream main
```

### 注意

- **署名鍵は環境ごとに分ける。** 上流の開発用デプロイと同じ鍵・同じ issuer を使い回さないでください（`AWSBRIDGE_KEY_FILE` を別パスにする）。鍵の入れ替えは「署名鍵のローテーション（MCP の中継）」の手順（`mise run key:prepare` → `secrets` → 待つ → `key:activate` → `secrets` → 待つ → `key:retire` → `secrets`）で止めずに行えます。
- **issuer（issuer の URL）が環境ごとに変わる**ので、IAM OIDC プロバイダーとロールを作る CloudFormation スタックも環境ごとに別です（`AWSBRIDGE_STACK_NAME` を分ける）。同じアカウントに複数の環境を置くときはロール名も分ける（`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`）。
- mise は `mise.<name>.toml` を `mise.toml` より、`mise.local.toml` を `mise.<name>.toml` より優先します。`.config/mise/conf.d/*.toml` は `mise.toml` に負けるので使えません。
- 上流の `wrangler.jsonc`（`name: awsbridge` / `env.dev`）は上流の開発用です。下流では使いません。上流の `wrangler.console.jsonc` も例なので、下流では使いません。

### セットアップ用スキル（Claude Code）

下流の private リポジトリを対話しながらセットアップする Claude Code スキルを `.claude/skills/setup-downstream/` に同梱しています（`.agents/skills/setup-downstream/` は同じファイルへのリンクです）。awsbridge を clone すればそのまま使えます（初回はフォルダーの信頼を求められます）。

```
git clone https://github.com/youyo/awsbridge <下流リポジトリ名>
cd <下流リポジトリ名> && claude
/setup-downstream <下流リポジトリ名>
```

スキルは、リモートの付け替え（`origin` → `upstream`）・下流リポジトリの作成・Worker のデプロイ・CloudFormation・Cloudflare Access/Portal・動作確認を順に案内します。扱うのは MCP の中継だけで、コンソールログインは扱いません。外部に影響する操作は、各段階で実行前に確認します。スキルはコードと一緒に版管理されるので、`git pull --no-rebase upstream main` で下流にも更新が届きます。

## Worker のデプロイの経路（既定と明示）

`scripts/wrangler.sh deploy` は、指定がなければ**既定の経路**を通ります。`wrangler versions upload` を流し、出力から Version ID を取り出して `wrangler versions deploy <version-id>@100% --yes` を流します。変わるのは Worker のコード・vars・バインディングだけです。Custom Domain と Route（triggers）は同期しないので、トークンにゾーンの権限は要りません。日常のデプロイは「その Worker だけの Individual Workers Editor で、ゾーンの権限なし」のトークンで足ります。

これはすべての Worker に効きます。MCP の Worker は `mise run deploy:worker` がこれを使います。コンソールログインの Worker をデプロイする mise のタスクはありません。「コンソールログインのセットアップ」に書いたとおり、コンソール用の wrangler の設定を指定して `scripts/wrangler.sh` を流します（`AWSBRIDGE_WRANGLER_CONFIG=<コンソール用の wrangler の設定> AWSBRIDGE_WRANGLER_ENV= bash scripts/wrangler.sh deploy`）。

- 理由: ゾーンの Workers Routes Write を持つトークンは、ほかの Worker の Custom Domain のホストに Route を足して応答を奪えるためです。日常のデプロイは、その権限を持たないトークンで行います。
- 引数: `--var`・`--message`・`--tag`・`--outdir`・`--minify`・`--keep-vars` など、`wrangler versions upload` が受け付けるものを引き継ぎます。`--config` と `--env` は、これまでどおり `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` で渡します。`versions upload` が受け付けない引数（`--routes` など）が来たら、黙って捨てずにエラーで止めます。出力から Version ID が取れなければ exit 1 で、`versions deploy` は流しません。
- `deploy --dry-run`（ビルド系のタスクが使う）は、これまでどおり `wrangler deploy --dry-run` を流します。何も書き込みません。
- **明示の経路**: `AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy` を指定すると `wrangler deploy` を流し、triggers（Custom Domain・Route）と workers.dev・Preview URL の設定も同期します。初回のデプロイ（`versions upload` は、まだ無い Worker を作れません）と、Custom Domain や Route の追加・変更・削除（`workers_dev` / `preview_urls` の変更を含む）のときに使います。ゾーンの権限を持つ、利用者自身の短命のトークンで流し、終わったらトークンを破棄します。

  ```
  AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy CLOUDFLARE_API_TOKEN=<短命のトークン> mise run deploy:worker
  ```

- **ゾーンの権限がないトークンで `wrangler deploy` を流さないでください。** コードの upload を先に行い、あとの triggers の段で失敗するため、**新しいコードが本番に出たあとでも**コマンドは失敗の終了コードで終わります。この失敗は「デプロイされたが triggers は同期されていない」と読みます。
- `versions upload` は Worker の `workers_dev` と `preview_urls` を変えません。これらは直前の明示の `wrangler deploy` で設定した状態のままです。そのときに `false` になっていることを確かめてください（このリポジトリの設定は、どちらも `false` に固定しています）。
- Worker の Custom Domain と Route は、明示の経路でしか変わりません。

## MCP の中継のセットアップ

### 前提

- [mise](https://mise.jdx.dev/)（`mise install` でランタイムと cfn-lint が入ります）
- Cloudflare 側: `wrangler login` 済みのアカウント
- AWS 側: IAM と CloudFormation を操作できる権限を持つ AWS プロファイル

### ホストを決める（独自ドメインが基本）

Worker の issuer の URL は IAM の OIDC プロバイダーの URL になるので、先にホストを決めます。基本の形は、自分のドメインのホストを、issuer と MCP の接続先に分けて使います（下の `example.com` はプレースホルダーです）。1 つの MCP Worker に Custom Domain を 2 つ付けます。

| 役割 | 例 | 備考 |
|---|---|---|
| OIDC issuer | `https://awsbridge-oidc-mcp.example.com`（パスなし） | `AWSBRIDGE_ISSUER`。STS がここの `/.well-known/*` を読むので公開にする（ホストを覆う広い Access のアプリがあるなら bypass にする）。`/mcp` を含むほかのパスは、Worker が Access JWT を検証し、このホストに来た要求には付いていないので 401 になる |
| MCP の接続先 | `https://awsbridge-mcp.example.com/mcp` | MCP クライアントが接続するホスト。Access のアプリはこのホストを守り、その AUD が Worker の `ACCESS_AUD` になる |

- Worker の設定は `wrangler.jsonc` の `env.prod` です（`routes` に `custom_domain` が 2 つ。`workers_dev` と `preview_urls` は `false`）。`AWSBRIDGE_WRANGLER_ENV=prod` で選びます。下流リポジトリは、これを自前の `wrangler.<name>.jsonc` に写し、ホストを自分の値にします。
- ドメインは Cloudflare のアカウントにあるゾーンにします。Custom Domain の DNS レコードと証明書は Cloudflare が作ります。issuer のホストは「ホスト」に書いたとおりに守ってください。
- 手軽に試すだけなら workers.dev も使えます。既定の `AWSBRIDGE_WRANGLER_ENV=dev` は `awsbridge-dev` を `https://<worker>.<subdomain>.workers.dev` にデプロイし、この 1 つのホストが issuer と接続先を兼ねます。実際の運用は独自ドメインにしてください。

### 初回の順序

issuer の URL が OIDC issuer になるため、次の順で進めます。

1. Cloudflare 側: `mise run keygen` → `mise.local.toml` に `AWSBRIDGE_ISSUER`（`https://awsbridge-oidc-mcp.example.com`）・`AWSBRIDGE_WRANGLER_ENV`（`prod`）などを設定 → `cp config/profiles.example.json config/profiles.json`（ビルドに必須。中身はこの時点ではダミーのままでよい）→ `AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker`（初回は明示の経路 `deploy` が要る。「Worker のデプロイの経路」を参照。issuer の URL を確定させる。この時点ではダミーのロール ARN なので `/mcp` は使えない）。`deploy:worker` は続けて `secrets` を流し、これは `AWSBRIDGE_ACCESS_TEAM_DOMAIN` か `AWSBRIDGE_ACCESS_AUD` が空だと止まる。手順 4 で Access のアプリができるまでは、`AWSBRIDGE_ACCESS_AUD` に仮の値（`pending` など）を置く。差し替えるまで `/mcp` は 401 になる
2. AWS 側: `AWS_PROFILE=<対象> mise run deploy:aws`（出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える）
3. プロファイル一覧を登録する。`config/profiles.json` に出力のロール ARN を書き（「マルチアカウント」）、`mise run deploy:worker` で反映する。一覧は環境変数ではなく Worker にバンドルされる JSON なので、`config/profiles.json` が無いとビルドが失敗する（未設定はエラー）
4. 接続先のホストを Cloudflare Access で守る（`infra/cloudflare` を参照）。アプリは `awsbridge-mcp.example.com` だけに置き、`awsbridge-oidc-mcp.example.com` の `/.well-known/openid-configuration` と `/.well-known/jwks.json` は公開のままにする。アプリの AUD を `AWSBRIDGE_ACCESS_AUD` に入れて `mise run secrets` を実行する。そのあと、`awsbridge-oidc-mcp.example.com` の `/mcp` が 401 になること、workers.dev と Preview URL が応答しないことを確かめる

```
mise run keygen                                               # 署名鍵を生成（.secrets/、既存なら上書きしない）
# mise.local.toml に AWSBRIDGE_ISSUER / AWSBRIDGE_ACCESS_* などを設定
cp config/profiles.example.json config/profiles.json          # プロファイル一覧（gitignore）。ロール ARN を書く
AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker  # 初回: wrangler deploy → secrets（AWS は呼ばない）
mise run deploy:worker                                        # 2 回目から: versions upload → versions deploy → secrets
```

2 回目以降は、変更した側だけを流します。

### AWS 側（対象アカウントごと）

[infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml) を流すだけです。Worker の issuer の URL を issuer とする IAM OIDC プロバイダーと、Worker 発行の JWT で引き受ける 2 つのロール（読み取り専用 `FederatedAwsBridgeMcpViewer`、デバッグ `FederatedAwsBridgeMcpDebugger`）を作ります。この MCP 用ロールは、人のコンソールログインのロール（Viewer / Administrator）とは独立した別のロールで、人にコンソールのロールを与えても MCP 用ロールの権限は変わりません。Viewer（`FederatedAwsBridgeMcpViewer`）は全員が使えます。Debugger（`FederatedAwsBridgeMcpDebugger`）を誰に渡すかは、下流の設定（`DebugAllowedSubjects`）で決めます（上流は規則を持ちません）。渡すときの注意: Debugger はリモートシェルなどで実行先のロールの権限を得られ、その権限には MCP 経由の条件が付きません。

```
AWS_PROFILE=<対象> mise run deploy:aws    # CloudFormation をデプロイ（何度でも別アカウントに流せる）
AWS_PROFILE=<対象> mise run destroy:aws   # 片付け: スタックを削除
```

`AWS_PROFILE` は呼び出し側の値が優先されます（未設定なら `awsbridge`）。`AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_AUDIENCE` も同様に環境変数で上書きできます（これらの既定値は `scripts/` 側にあり、`mise.toml` の `[env]` には置いていません）。一方、`mise.local.toml` や下流リポジトリの `mise.<name>.toml` に書いた値は、呼び出し側の環境変数より優先されます。対象アカウントを `AWS_PROFILE=<対象>` で切り替えたい場合は、`AWS_PROFILE` をこれらのファイルに書かないでください。

```
mise exec -- env AWS_PROFILE=<対象> AWSBRIDGE_ALLOWED_SUBJECTS="user@example.com" AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS="admin@example.com" bash scripts/deploy-aws.sh
```

マネジメントコンソールや StackSets でテンプレートを直接流すこともできます。そのときのパラメーター:

| パラメーター | 説明 |
|---|---|
| `IssuerHost` | OIDC issuer のホスト、つまり `AWSBRIDGE_ISSUER` のホスト（`https://` と末尾 `/` なし。例: `awsbridge-oidc-mcp.example.com`。workers.dev の試用なら `awsbridge-dev.example.workers.dev`） |
| `Audience` | JWT の audience（既定 `awsbridge`。Worker の `STS_AUDIENCE` と一致させる） |
| `AllowedSubjects` | 読み取り専用ロールを引き受けられる利用者（カンマ区切り。下記の書式。小文字で指定） |
| `DebugAllowedSubjects` | デバッグロールを引き受けられる利用者（同じ書式。読み取り専用より絞ることを勧めます） |
| `ReadOnlyRoleName` | 読み取り専用ロール名（既定 `FederatedAwsBridgeMcpViewer`） |
| `DebugRoleName` | デバッグロール名（既定 `FederatedAwsBridgeMcpDebugger`） |
| `DebugAdditionalPolicyArns` | 任意。デバッグロールに追加で付ける管理ポリシー（カンマ区切り。空なら付けない） |
| `DebugPassableEcsTaskRoleArns` | 任意。`ecs:RunTask` でタスクに渡してよい IAM ロール ARN（カンマ区切り。ワイルドカード不可）。空なら `iam:PassRole` を付けない |
| `DebugPassableBedrockServiceRoleArns` | 任意。`bedrock:CreateEvaluationJob` / `CreateModelInvocationJob` で Bedrock の評価ジョブ・バッチ推論ジョブに渡してよい IAM ロール ARN（カンマ区切り。ワイルドカード不可）。空なら Bedrock 用の `iam:PassRole` を付けない。そのジョブ専用のロールだけを列挙してください |

デプロイ後、出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控えます（`aws cloudformation describe-stacks` でも取れます）。

#### ロールの権限と注意

| ロール | 権限 |
|---|---|
| `FederatedAwsBridgeMcpViewer` | AWS 管理ポリシー `ReadOnlyAccess` + SSM パラメーターの取得（`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`）と Secrets Manager の値の取得（`secretsmanager:GetSecretValue` / `BatchGetSecretValue`）の明示 Deny（条件なし） |
| `FederatedAwsBridgeMcpDebugger` | `ReadOnlyAccess` + インラインポリシー（調査の読み取り強化・軽い運用操作・費用のかかる操作・接続と実行。Allow はすべて `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com` の条件付き。読み取り専用ロールと同じ、SSM パラメーターと Secrets Manager の値の取得の無条件の Deny を含む）+ 任意の `DebugAdditionalPolicyArns` |

デバッグロールのインラインポリシーは、次のグループに分かれています（Allow はすべて `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com` の条件付き、Resource は `*`）。削除系の操作・IAM 変更・組織変更は含みません（ただし Knowledge Bases の同期は、結果として索引の文書を消すことがあります。`Operations` を参照）。

| グループ（Sid） | 内容 |
|---|---|
| `Investigation` | `ReadOnlyAccess` より深い調査用の読み取り。Logs Insights / ログ取得 / Live Tail、X-Ray、CloudTrail（`LookupEvents`・クエリ）、Athena のクエリ実行、EC2 コンソール出力 / スクリーンショット、AWS Config の `SelectResourceConfig` / `GetResourceConfigHistory` |
| `DenySsmParameterRead` / `DenySecretsManagerRead` | **Deny**（条件なし。読み取り専用ロールと同じ）: `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`、`secretsmanager:GetSecretValue` / `BatchGetSecretValue`。直接の呼び出しにも AWS MCP 経由の呼び出しにも効き、`DebugAdditionalPolicyArns` で足した管理ポリシーの Allow より優先します。`kms:Decrypt` は付けません（下の注意を参照） |
| `Operations` | 副作用のある軽い運用操作（削除の API なし）: ECS の `UpdateService` / `StopTask`、EC2 の起動・停止・再起動、Lambda の同時実行数の変更、Auto Scaling の台数変更、RDS / ElastiCache の再起動、CloudFront の `CreateInvalidation`、Bedrock Knowledge Bases の同期の開始・中止（`bedrock:StartIngestionJob` / `StopIngestionJob`）。同期は削除操作ではありませんが、データソース（S3 など）から消えた文書はベクトルストアからも消えます。<br>止める・再起動する: `states:StopExecution`、`glue:BatchStopJobRun` / `StopCrawler`、`codebuild:RetryBuild` / `StopBuild`、`autoscaling:SuspendProcesses` / `ResumeProcesses`、`rds:FailoverDBCluster` / `RebootDBCluster`、`elasticache:TestFailover`、`elasticbeanstalk:RestartAppServer`。<br>止める・抑える: `cloudwatch:DisableAlarmActions` / `EnableAlarmActions`、`events:EnableRule` / `DisableRule` / `CancelReplay`、`autoscaling:SetInstanceHealth` / `EnterStandby` / `ExitStandby`、`rds:StartDBInstance` / `StopDBInstance` / `StartDBCluster` / `StopDBCluster`、`ssm:StopAutomationExecution`、`batch:CancelJob`、`codepipeline:StopPipelineExecution` |
| `CostIncurring` | **費用がかかる**操作: `bedrock:InvokeModel` / `InvokeModelWithResponseStream`（Converse を含む）/ `ApplyGuardrail` / `RetrieveAndGenerate`、`sagemaker:InvokeEndpoint` / `InvokeEndpointAsync`、`rds:CreateDBSnapshot` / `CreateDBClusterSnapshot`、`ec2:CreateSnapshot`、`lambda:PutProvisionedConcurrencyConfig`。Bedrock の評価・バッチ推論・プロンプト最適化: `bedrock:OptimizePrompt`、`CreateEvaluationJob` / `StopEvaluationJob`、`CreateModelInvocationJob` / `StopModelInvocationJob`、`CreateAdvancedPromptOptimizationJob` / `StopAdvancedPromptOptimizationJob`。Transcribe: `transcribe:StartTranscriptionJob`。スナップショットを共有する権限は含みません |
| `Execution` | 接続・実行: `ssm:SendCommand` / `StartSession` など、EC2 Instance Connect、`ecs:ExecuteCommand` / `RunTask`、`lambda:InvokeFunction`、`states:StartExecution`、`sqs:SendMessage`、`sns:Publish`、`rds-db:connect`。業務ロジック・デプロイの実行: `states:RedriveExecution` / `StartSyncExecution`、`bedrock:InvokeAgent`、`lambda:InvokeFunctionUrl`、`glue:StartCrawler` / `StartWorkflowRun`、`ssm:StartAutomationExecution`、`events:StartReplay` / `PutEvents`、`codepipeline:RetryStageExecution`。`ecs:RunTask` 用の `iam:PassRole` は別 Statement で、`DebugPassableEcsTaskRoleArns` を指定したときだけ付き、渡せるロールをその ARN、渡し先を `ecs-tasks.amazonaws.com` に限定します（空ならタスクロール無しのタスク定義だけ実行できます） |
| `PassRoleForBedrockJobs` | `bedrock:CreateEvaluationJob` / `CreateModelInvocationJob` 用の `iam:PassRole`。別 Statement で、`DebugPassableBedrockServiceRoleArns` を指定したときだけ付き、渡せるロールをその ARN、渡し先を `bedrock.amazonaws.com` に限定します（`aws:CalledViaAWSMCP` の条件も付きます）。バッチ推論も、評価ジョブと同じく `DebugPassableBedrockServiceRoleArns` で列挙したロールを渡します。Transcribe の `DataAccessRoleArn`（ロールを渡す形）は、`transcribe.amazonaws.com` 宛の `iam:PassRole` が無いので使えません |

Athena のクエリは結果バケットへの書き込み（`s3:PutObject`）が別に必要です。このポリシーには含めていないので、必要なら `DebugAdditionalPolicyArns` で足してください。

Knowledge Bases の同期（`bedrock:StartIngestionJob` / `StopIngestionJob`）も、ほかのグループと同じく Resource は `*` です。デバッグロールはアカウント内のどのリソースでも調べられることを前提にしており、ほかの操作（ECS・EC2・RDS など）も対象の ARN をパラメーターにしていないため、Knowledge Base の ARN で絞るパラメーターは設けていません（`DebugAdditionalPolicyArns` は権限を足すだけで、絞ることはできません）。対象を絞るなら、テンプレートの `Operations` の Resource を `arn:${Partition}:bedrock:${Region}:${Account}:knowledge-base/${KnowledgeBaseId}` に書き換えるか、`aws:ResourceTag` の条件を足してください。

- **デバッグロールはリモート実行相当の権限を含みます。** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` はリモートシェルと同等で、秘密情報や認証情報、ファイルの内容が見えてしまうことがあります（コマンドはインスタンスやタスクのロールの権限で動き、そのロールが秘密値を読めることがあります）。`Operations` と `lambda:InvokeFunction`・`states:StartExecution`・`sqs:SendMessage`・`sns:Publish` は副作用のある処理を実行します。
- **費用がかかる操作とデプロイを伴う操作を含みます。** `CostIncurring` のモデル・推論エンドポイントの呼び出し、スナップショットの作成、プロビジョンド同時実行は課金されます（`rds:StopDBInstance` もスナップショットを作れます）。`codepipeline:RetryStageExecution` は失敗したステージを再試行し、本番へのデプロイを走らせることがあります。`events:StartReplay` / `PutEvents`、`bedrock:InvokeAgent`、`glue:StartCrawler` / `StartWorkflowRun`、`ssm:StartAutomationExecution` は、それぞれのターゲット・ジョブ・オートメーションを実行します。`glue:StartCrawler` は、クローラーの設定次第でカタログのテーブルを削除・非推奨にします。
- **Bedrock の評価ジョブ・バッチ推論・Advanced Prompt Optimization・Transcribe のジョブは、セッションを切っても走り続け、費用がかかります。** `bedrock:CreateEvaluationJob`、`CreateModelInvocationJob`、`CreateAdvancedPromptOptimizationJob`、`transcribe:StartTranscriptionJob` が始めるジョブは、セッションを閉じても止まりません。止めるには `bedrock:StopEvaluationJob` / `StopModelInvocationJob` / `StopAdvancedPromptOptimizationJob` が要ります（すべて付けています）。これらの Stop は Resource が `*` なので、このセッションが作っていないほかの人のジョブも止められます。止めても、発生済みの費用は戻りません。Transcribe には止める操作が無く（`DeleteTranscriptionJob` だけで、これは付けていません）、始めた文字起こしジョブはここからは止められません。Bedrock のジョブに渡せる範囲は「`DebugPassableBedrockServiceRoleArns` に列挙したロール × ここで許した Create の操作（`CreateEvaluationJob`、`CreateModelInvocationJob`）」で決まり、`DebugAdditionalPolicyArns` で足した権限や、将来足す Bedrock の操作も含めた、ロールの実効権限で決まります。評価ジョブとバッチ推論は、渡したサービスロールの権限で動くので、そのロール経由で、デバッグロールが直接読めないデータを読み、そのロールが許す出力先に書けます。デバッグロールの秘密値読み取りの Deny は、サービスロールには引き継がれません。列挙するロールは、そのジョブ専用の最小権限にして（入力・出力のプレフィックス、モデル、KMS を限定）、既存の広い権限のロールは列挙しないでください。信頼ポリシーには `aws:SourceAccount` に加え、対応していれば `aws:SourceArn` も使ってください（そのジョブ種別でキーが提供されるかは要確認）。`aws:SourceAccount` は混乱した代理への対策にすぎず、サービスロール自体の権限の広さは別に絞る必要があります。
- **止める・抑える操作は戻し忘れに注意してください。** `cloudwatch:DisableAlarmActions` や `events:DisableRule`、`autoscaling:SuspendProcesses` / `EnterStandby` は、戻し忘れると障害の見逃しや自己修復の停止につながります。`autoscaling:SetInstanceHealth` で Unhealthy にしたインスタンスは終了・置き換えされます。
- **Secrets Manager と SSM パラメーターストアの値は、API で直接は読めません（両ロール）。** 両ロールとも `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory` と `secretsmanager:GetSecretValue` / `BatchGetSecretValue` を条件なしで Deny するので、AWS MCP を経由するかどうかに関係なく効きます。`ReadOnlyAccess`（v191）は `ssm:Get*` を含み（SecureString も `aws/ssm` キーならキーポリシー側で復号できます）、Deny が無いとセッションで SSM パラメーターを読めてしまいます。`ReadOnlyAccess` は `secretsmanager:GetSecretValue` と `kms:Decrypt` を含まず、インラインポリシーもどちらも付けません。明示 Deny は常に優先するので、`DebugAdditionalPolicyArns` で管理ポリシーを足しても、これらの取得は戻せません。
- **デバッグロール自身には S3 への書き込み権限を付けていません（`s3:PutObject` なし）。ジョブへの影響は次のとおりです（すべて未実測）。** これはデバッグロールだけの話で、渡すサービスロールの権限は制限しません（前の項目を参照）。評価ジョブ（`CreateEvaluationJob`）とバッチ推論（`CreateModelInvocationJob`）は、渡したサービスロールが S3 を読み書きするので、このロールに S3 の書き込みは要りません。ただし入力データを S3 に置く作業は、別の手段（ほかのロール）で行います。Advanced Prompt Optimization は呼び出し元の権限（Forward Access Session）で S3 とモデルを使います。AWS の文書（https://docs.aws.amazon.com/bedrock/latest/userguide/advanced-prompt-optimization-prereqs.html）に「using the permissions of your calling identity」とあり、呼び出し元に入力の読み取りと出力先の書き込みが要ると書かれています。そのため、このロールだけでは出力を書けず失敗する見込みです（実際の挙動は未実測）。`DebugAdditionalPolicyArns` で `s3:PutObject` を足す場合、追加の管理ポリシーにはインラインの MCP 条件が自動では付かないので、出力先のバケット・プレフィックスに限定し、`aws:CalledViaAWSMCP` の条件も自分で付けてください。実際に必要な権限は未実測で、出力の書き込み以外にも要る可能性があります。文字起こしのジョブ（`StartTranscriptionJob`）で `OutputBucketName` を指定した場合も同様の見込みです（未実測）。Amazon Transcribe のガイド（「Permissions required for IAM roles」）は、リクエストを出す IAM エンティティに出力バケットへの `s3:PutObject` が要ると説明していますが、どの身元が使われるかまでは書いていません。`OutputBucketName` を指定しなければ、結果はサービス管理のバケットに出るので、書き込み権限は要りません。
- **まだ実測していない項目（実環境で確かめていません）:** (1) Advanced Prompt Optimization と Transcribe が呼び出し元の権限（Forward Access Session）で行う下流の呼び出しに `aws:CalledViaAWSMCP` が付くか、(2) global 推論プロファイルの挙動、(3) `iam:PassRole` を伴うジョブの作成。
- **権限昇格の経路は、一部を塞いでいますが、すべてではありません（下のリモートシェルが残ります）。** `iam:PassRole` を `*` に付けると、任意のロールでタスクを動かせてしまうため、既定では付けず、`DebugPassableEcsTaskRoleArns`（ECS）と `DebugPassableBedrockServiceRoleArns`（Bedrock の評価ジョブ・バッチ推論）で明示したロールだけに限ります。また `lambda:UpdateFunctionConfiguration`（実行ロールや環境変数の差し替え）と `autoscaling:UpdateAutoScalingGroup`（起動テンプレートの差し替え）は付けていません。`glue:StartJobRun` と `batch:SubmitJob` も付けていません。引数やコマンド・環境変数を上書きして、ジョブのロールの権限で任意のコードを動かせるためです（`codebuild:StartBuild` と同じ理由です）。`codepipeline:StartPipelineExecution` も付けていません。`sourceRevisions` でソースのコミット・S3 オブジェクト・イメージを差し替えられ、`variables` で任意の値をパイプラインに渡せるためです（引数を上書きできる `codebuild:StartBuild` と同じ理由です。再実行は `RetryStageExecution` で行います）。`ssm:StartAutomationExecution` 用の `iam:PassRole` は付けないため、オートメーションは呼び出し元の権限の範囲でだけ動きます。
- **残るリスク:** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` / EC2 Instance Connect は、対象のインスタンスやタスクに付いたロールの権限で動けます。権限の強いインスタンス・タスクが同じアカウントにあると、その権限を借りられます。本番ではタグ条件や SSM ドキュメントで対象を絞ってください。
- **「秘密値を読めない」わけではありません。** 上の 2 つの API 以外の経路は残ります: リモートシェル（デバッグロール。`ssm:SendCommand` / `StartSession`、`ecs:ExecuteCommand`、EC2 Instance Connect はインスタンスやタスクのロールの権限で動き、そのロールで秘密値を読めることがあります）、SSM のコマンドの実行結果（`ssm:GetCommandInvocation` / `ListCommandInvocations`）と Automation の実行結果、Lambda の環境変数と `lambda:GetFunction` で得るコードの取得 URL、ECS のタスク定義と CodeBuild プロジェクトの平文の環境変数、EC2 のユーザーデータ、CloudFormation のテンプレートと出力、AppConfig の設定内容、S3 のオブジェクト（`s3:GetObject`）、ログ、`rds-db:connect`（デバッグロール）。ECS の秘密の参照（`secrets` / `valueFrom`）や CodeBuild の `SECRETS_MANAGER` / `PARAMETER_STORE` 型の環境変数で見えるのは参照先だけで、値ではありません（平文の環境変数とは別です）。これらの多くは調査で日常的に使うため Deny していません。ここに秘密値があるなら、`AllowedSubjects` / `DebugAllowedSubjects` を絞るか、権限境界・SCP で独自に Deny してください。
- **`ReadOnlyAccess` のバージョンは固定されません。** AWS 管理ポリシーなので、AWS の更新で読める範囲が変わることがあります。上の Deny は値を取得する API を名指しで止めるので、その部分は更新の影響を受けません。
- **`ReadOnlyAccess` は MCP 経由に限定されません。** AWS 管理ポリシーには IAM 条件を付けられないため、セッションの認証情報で直接 API を呼んでも読み取り権限は有効です。`aws:CalledViaAWSMCP` で絞られるのは、デバッグロールのインラインポリシーの Allow だけです。
- 本番では `Resource` を特定の ARN・タグ・SSM ドキュメントに絞り、セッションログ（SSM Session Manager のログ、ECS Exec のログ、Lambda の CloudWatch Logs）を必ず有効にしてください。CloudTrail だけでは足りません。
- 利用者はロールごとに `AllowedSubjects`（読み取り専用）と `DebugAllowedSubjects`（デバッグ）で分けます。`DebugAllowedSubjects` は読み取り専用より狭くしてください。

### `mise.local.toml` の変数

固定の既定値は `mise.toml` にあります。アカウント固有の値は `mise.local.toml`（gitignore）に書きます（値はすべてプレースホルダーです）。

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge-oidc-mcp.example.com"             # OIDC issuer（自分のドメインの専用ホスト。パスなし）。MCP の接続先 awsbridge-mcp.example.com とは別
AWSBRIDGE_WRANGLER_ENV = "prod"                               # wrangler.jsonc の env.prod（Custom Domain）。既定は dev（workers.dev。試用向け）
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # 読み取り専用ロールを引き受けられる利用者（カンマ区切り）
AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS = "admin@example.com"       # デバッグロールを引き受けられる利用者（カンマ区切り）
# AWSBRIDGE_READONLY_ROLE_NAME = "FederatedAwsBridgeMcpViewer"        # 任意。ロール名（既定値）
# AWSBRIDGE_DEBUG_ROLE_NAME = "FederatedAwsBridgeMcpDebugger"          # 任意。ロール名（既定値）
# AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS = "arn:aws:iam::<アカウントID>:policy/<名前>" # 任意。デバッグロールに追加する管理ポリシー（カンマ区切り）
# AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS = "arn:aws:iam::<アカウントID>:role/<名前>"     # 任意。DebugPassableEcsTaskRoleArns
# AWSBRIDGE_DEBUG_PASSABLE_BEDROCK_SERVICE_ROLE_ARNS = "arn:aws:iam::<アカウントID>:role/<名前>" # 任意。DebugPassableBedrockServiceRoleArns
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # poc:sts の正常ケースで使う利用者（検証用）
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # Access のチームドメイン
AWSBRIDGE_ACCESS_AUD = "<Access アプリケーションの AUD タグ>"   # このアプリケーションの AUD
```

`AWSBRIDGE_ALLOWED_SUBJECTS` と `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS` の書式（どちらも同じ）: 各要素は `user@example.com` または `*@example.com` の形です。ワイルドカードを使えるのはメールのローカル部だけで、ドメイン部（`*@*` や `*@*.com`）や `*` 単独は使えません（全員に許可してしまうため）。空要素や前後の空白もエラーです。email は小文字に正規化して照合します（Worker は Access JWT の email を小文字にして STS に渡し、`deploy:aws` もこれらを小文字にして CloudFormation に渡します）。`deploy:aws` は AWS を呼ぶ前にこれを検証し、CloudFormation テンプレートの `AllowedPattern` でも同じ検査をします。

`AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS` で付ける管理ポリシーは、デバッグロールを引き受けた利用者が実行できる操作そのものになります。必要最小限の権限だけを付けてください（未設定なら何も付けません）。

上書きできる既定値（`scripts/` 側で補います。環境変数・`mise.local.toml`・下流の mise 設定ファイルで変更可）: `AWS_PROFILE`（`awsbridge`）、`AWSBRIDGE_AUDIENCE`（`awsbridge`）、`AWSBRIDGE_STACK_NAME`（`awsbridge`）、`AWSBRIDGE_KEY_FILE`（リポジトリルートの `.secrets/dev-signing-key.json`）、`AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE`（鍵ローテーション用。既定は `AWSBRIDGE_KEY_FILE` の拡張子の前に `.next` / `.previous` を付けたもの）、`AWSBRIDGE_WRANGLER_CONFIG`（`wrangler.jsonc`）、`AWSBRIDGE_WRANGLER_ENV`（未設定なら `dev`。**空文字なら `--env` を付けない**）、`AWSBRIDGE_WRANGLER_DEPLOY_MODE`（未設定なら `versions`。明示の経路は `deploy`）。

### Worker の設定

secret（`mise run secrets` が登録）: `SIGNING_JWK`、`ADDITIONAL_PUBLIC_JWKS`（任意。署名鍵のローテーション用の追加の公開鍵。通常は `[]`）、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。`secrets` は単独でも実行できます。`wrangler secret bulk` に標準入力で JSON を渡すので、値がコマンドライン引数に出ません。プロファイル一覧は secret にしません（Workers の環境変数は 1 つ 5 KB が上限で、270 プロファイルなら約 38 KB になるため）。バンドルした JSON モジュール（`awsbridge:profiles`。必須。「マルチアカウント」参照）で渡します。

var（任意。既定値を上書きするときだけ）: `ISSUER`（deploy 時に `--var` で設定）、`IDENTITY_CLAIM`（既定 `email`）、`ACCESS_MAX_TOKEN_AGE_SECONDS`、`STS_AUDIENCE`（既定 `awsbridge`）、`STS_REGION`（既定 `us-east-1`）、`STS_ENDPOINT`、`AWS_MCP_REGION`（既定 `us-east-1`）、`AWS_MCP_ENDPOINT`、`TARGET_AWS_REGION`（既定 `ap-northeast-1`）、`ALLOWED_ORIGINS`（カンマ区切りの完全一致オリジン。既定は空）。

`/mcp` は CSRF 対策として、`Origin` ヘッダーが付いたリクエスト（ブラウザ由来）を `ALLOWED_ORIGINS` に含まれない限り 403 `forbidden_origin` で拒否します。`Origin` が無い MCP クライアント・Portal のサーバー間通信は通ります。また POST は `Content-Type` が `application/json`（`; charset=utf-8` などのパラメーター可）のときだけ受け付け、それ以外（Content-Type 無しを含む）は 415 `unsupported_media_type` です。Access はブラウザの Cookie を検証して `Cf-Access-Jwt-Assertion` を差し込むため、認証だけでは CSRF を防げません。

`/mcp` のエラーは `{"error":"<code>"}` で返ります: `unauthorized`（401）、`forbidden`（403。ロールを引き受ける権限がない）、`upstream_auth_failed`（502。サーバー側の設定不整合）、`temporarily_unavailable`（503）、`server_misconfigured`（500）、`unknown_aws_profile` / `invalid_aws_profile` / `batch_not_supported`（400）。原因ごとの対応表は `docs/specs/architecture.md` の「エラーと HTTP ステータスの対応」を参照してください。

### マルチアカウント

複数の AWS アカウントを、MCP の `tools/call` の引数 `aws_profile` で切り替えられます。Worker は選ばれたアカウントのロールを AssumeRoleWithWebIdentity で直接引き受けます（チェーンしません）。誰がどのアカウントを使えるかは各アカウントの信頼ポリシー（`AllowedSubjects` / `DebugAllowedSubjects`）で決まり、許可外は 403 `forbidden` になります。

1. 対象アカウントごとに `AWS_PROFILE=<対象> mise run deploy:aws` を流し、出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える。
2. プロファイル一覧（必須）を JSON ファイルに書く。上流の開発用デプロイでは `cp config/profiles.example.json config/profiles.json` で作ります（gitignore。値はプレースホルダー）。一覧は環境変数ではなく、wrangler の `alias` で JSON モジュール `awsbridge:profiles` として Worker にバンドルされるので、プロファイル数に実質的な上限はありません（Workers の環境変数は 1 つ 5 KB が上限）。ファイルが無いとビルド（`wrangler deploy` / `wrangler dev`）が `Cannot find module` で失敗します。`profiles` は配列で書くのを推奨します。配列の順が `list_aws_profiles` の返す一覧の順になります（`default` は常に先頭）。

```json
{
  "default": "dev-readonly",
  "profiles": [
    { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedAwsBridgeMcpViewer", "description": "開発（読み取り専用）" },
    { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedAwsBridgeMcpDebugger", "description": "開発（デバッグ）" },
    { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedAwsBridgeMcpViewer" },
    { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedAwsBridgeMcpDebugger" }
  ]
}
```

`profiles` はオブジェクト（`"profiles": { "dev-readonly": { "roleArn": "..." }, ... }`）でも書けます（従来の形式）。ただしオブジェクトのキーの順は、Worker に届くまでの経路で保たれないことがあります（原因は未特定。実環境で、`dev-readonly` → `dev-debug` と書いたのに Portal の enum が名前順になった例があります）。順を意図するなら配列で書いてください。配列形式の `name` は必須で、重複は 500 `server_misconfigured` です。

- プロファイル名: 英数字・`_`・`-` の 1〜32 文字（超えると 500 `server_misconfigured`）。数字だけの名前はオブジェクトの規則で数値順に先に並ぶので、順を意図するなら避けてください。
- `default`: 必須。`aws_profile` を省略したとき、および `tools/list` など `tools/call` 以外で使うプロファイル。
- `tools`: 任意。`aws_profile` の対象ツール（省略時は全ツール。通常は省略でよい）。名前は AWS MCP Server が返す実際のツール名（例: `aws___run_script`。`tools/list` で確認できる）で、存在しない名前を書くと `aws_profile` が効きません。対象外ツールに付いた `aws_profile` は無視して取り除きます。
- `tools/list` の応答には、対象ツールの `inputSchema.properties.aws_profile`（`{type: "string", description}`。`enum` は持たず、description にも既定値やプロファイル名は入れません）を注入し、あわせて `list_aws_profiles` ツールを追加します（`tools/list` のページングで 2 ページ目以降には追加しません）。クライアント（Claude など）は `list_aws_profiles` を呼んで、使えるプロファイルを実行時に取得します。このツールは認証後に Worker が自分で応答し、`{default, profiles: [{name, description?}]}` を返します（`roleArn` は含めません）。注入するスキーマはプロファイル一覧に依存しないので、プロファイルを追加するだけなら MCP Portal の再同期も claude.ai の再接続も要りません。再同期・再接続が要るのは、上流のツール構成が変わったとき、または awsbridge の更新で注入するスキーマが変わったときです（`enum` を外して `list_aws_profiles` を追加した更新を取り込む初回を含みます）。上流が既に `aws_profile` を持つツールは注入しません。応答を加工できないときは原文のまま返します。
- `aws_profile` は上流へ送る前に取り除きます。単一の `tools/call` では、一覧にない名前（`unknown_aws_profile`）も文字列以外（`invalid_aws_profile`）も、HTTP 200 の JSON-RPC 結果 `isError: true` で返します。本文にエラーコード・使えるプロファイル名・既定のプロファイルを含むので、クライアントは 1 回で直せます。JSON-RPC バッチのときは 400 `{"error": "<code>"}` です。
- JSON-RPC バッチは、対象ツールの `aws_profile` がすべて同じ（省略は `default`）ならそのロールで中継し、異なれば 400 `batch_not_supported`。
- 一覧が不正（形式エラー・重複・空など）なら 500 `server_misconfigured`（ログには `config: invalid profiles: <種別>` だけを出し、設定値は出しません）。未設定はビルドの失敗になります。
- STS の `RoleSessionName` は `gw-<利用者>-<プロファイル名>` です（CloudTrail で見分けられます）。

下流リポジトリは上流の `wrangler.jsonc` を編集せず、自分の `wrangler.<name>.jsonc` の `alias` で自前の JSON（例 `deploy/profiles.json`）に向けます（「下流リポジトリでの運用」参照）。詳細は `docs/specs/architecture.md` の「マルチアカウント（aws_profile）」を参照してください。

## コンソールログインのセットアップ

本番に入れるときは、[本番でのコンソールログインの導入](docs/console-production-rollout_ja.md) の段の順序・確認と期待値・Administrator を入れる前のチェックリストに従います。

### 初回の順番（コンソールログイン）

各段の中身は下の節に書きました。鍵と CSRF の鍵の道具は、人が手元から実行します。CI からは実行しません。**コンソールの Worker のデプロイと鍵の操作は、最初のデプロイから、Administrator を発行してよい人だけが行います**（受容 b）。Viewer だけを設定している間も同じです。

1. **設定**: 設定ファイルを書き、`mise run console:config:check` で検査します（「設定ファイルと生成物」）。初回は Admin の階層のチームと Administrator のロールを入れません。
2. **Access**: 入口のアプリとチームのアプリを Cookie Path を有効にして作り、AUD を保存します（「コンソールログインの Access アプリ（Cookie Path）」）。
3. **生成**: 初回は `mise run console:config:generate -- --ledger-init`（比べる台帳がまだ無いため。「退役したチーム名の台帳」）、2 回目からは `mise run console:config:generate` です。チームの AUD が要ります。入口の AUD は、Standard のチームが 2 つ以上のときに要ります。そのあと、生成物の `access.json` を読む `mise run console:access:inspect` で Access のアプリを確かめます。最初のデプロイの前に、対象のアカウントごとに `mise run console:inspect -- --profile=<p>` を回します（`--ledger-init` のあとは必須）。コンソールのロールもプロバイダーもまだ無いアカウントでは、期待する誤りは `role_missing` と `provider_missing` だけです。`trust_team_retired`・`trust_team_tier`・`unlisted_role` が出たら、説明がつくまで先へ進みません。
4. **Worker**: デプロイし、境界ごとの署名鍵と CSRF の鍵を入れ、鍵の vars を書いてもう一度デプロイし、`mise run console:key:check` を回します（「コンソールログインの署名鍵」）。issuer が公開されるのは、この段のあとです。
5. **base のスタック**を対象のアカウントごとに配ります。issuer が公開されてから配ります。IAM はプロバイダーを作るときに issuer の discovery を読むためです。これは以前の階層ごとの Admin の issuer と同じ仕組みからの推論で、1 つの issuer では実測していません（「コンソールログインの必須のスタック（base）」）。
6. **ロールのスタック**を、生成した `kind.<kind>.yaml` から配ります（「ロールのスタック」）。
7. **確認**: アカウントごとに `mise run console:inspect -- --profile=<p>`（誤り 0）、そして `mise run console:exposure-check` を回し、「日々の運用」の毎日の確認を始めます。
8. **Admin の階層**（Administrator を配るときだけ。本番では導入の文書の段を済ませてから）: 「Admin の階層と Administrator を足す」に従います。

### 設定ファイルと生成物

どんなチームがいて、どんなロールを用意し、どの種類のアカウントでどのチームがどのロールに入れるかは、1 つの設定ファイルで決めます。上流が持つのはスキーマ（`src/console/config.ts`）・例・道具だけで、実際の値は下流に置きます（`docs/specs/console-login-portal.md` §11）。

- 例: [`config/console.example.json`](config/console.example.json)（個人用の最小構成。チーム 1 つ・Viewer・アカウント 1 つ）と [`config/console.company.example.json`](config/console.company.example.json)（Admin の階層を持つ会社用の形）。どちらかを `config/console.json`（上流の開発用。gitignore）か、下流のファイル（例 `deploy/console.json`。`AWSBRIDGE_CONSOLE_CONFIG` で渡す）にコピーします。
- 入力（環境変数。既定値は `scripts/console/config.ts` が補います）: `AWSBRIDGE_CONSOLE_CONFIG`（既定 `config/console.json`）、`AWSBRIDGE_CONSOLE_AUD_FILE`（Terraform の出力 `{ "teams": { <チーム>: <AUD> }, "entry": <AUD> }`。任意。Terraform を使わない個人の構成では、代わりに設定ファイルに `access.aud` を書けます）、`AWSBRIDGE_CONSOLE_INVENTORY_FILE`（`placement: ou` の Organization のアカウント。任意。email を含むのでコミットしない）、`AWSBRIDGE_CONSOLE_OUT_DIR`（既定 `.generated/console`。gitignore）、`AWSBRIDGE_CONSOLE_SOURCE_REVISION`（任意。生成物に記録する設定のコミット）。
- どちらのタスクも AWS・Cloudflare・Terraform を呼びません。設定の誤りは生成の時点で止めます（出力はキーのパスと誤りの種別だけで、値は出しません）。

| 生成物 | 使う側 |
|---|---|
| `worker.json` | コンソールの Worker（`alias`）。両階層のチームの AUD と階層・ロールの ARN・境界の issuer |
| `display.json` | コンソールの Worker（`alias`）。入口の一覧だけが読む。Administrator の行は表示用で、email・AUD・ARN を持たない |
| `stacksets.json` | base のスタック（`providers`）と、種類ごとのロールのスタックのパラメーター、退役したチーム名の台帳 |
| `access.json` | `mise run console:access:inspect` と、CI での Terraform との突き合わせ |
| `kind.<kind>.yaml` | 種類ごとのロールのテンプレート（参考の形。「ロールのスタック」） |

```bash
cp config/console.example.json config/console.json   # 上流の開発用。下流は自前のファイルと AWSBRIDGE_CONSOLE_CONFIG
mise run console:config:check      # スキーマ・参照・重複・階層（AWSBRIDGE_CONSOLE_AUD_FILE を渡せば AUD の対応も）。何も書かない
mise run console:config:generate   # 生成物を AWSBRIDGE_CONSOLE_OUT_DIR に書く（初回は -- --ledger-init）
```

#### 退役したチーム名の台帳

- 比べる相手は、出力先の前回の生成物（`stacksets.json`）と、渡したときは `--ledger-baseline <path>`（保管しておいた `stacksets.json`）です。両方を渡したら、どちらにも通ることを要します。読めない・形が違う baseline は誤りです。
- 比べる台帳が無い生成（前回の生成物も baseline も無い・前回がコンソールを 1 つの Worker・issuer・プロバイダーにする前の形）は誤りです。初めての生成とその前の形からの移行だけ、`mise run console:config:generate -- --ledger-init`（初回の指定）で通します。前回か baseline に台帳があるのに付けると誤りです。通したことは標準出力と `stacksets.json` の meta（`ledgerInit`）に残ります（次の生成で消えます）。
- `--ledger-init` を使ったら、デプロイの前に `mise run console:inspect` を回します（信頼ポリシーに古いチームや退役したチームの名前が残っていないか）。
- 前回の生成物（`.generated/console/stacksets.json`）か baseline を保管します（生成物は gitignore です。新しいチェックアウトでは `--ledger-baseline <path>` で渡します）。
- `mise run console:config:check` は今のまま、前回が無ければ黙り、あれば比べます。

### コンソールログインの Access アプリ（Cookie Path）

コンソールログインのポータル（入口の画面）は Cloudflare Access のアプリの背後に置きます。ポータルのホストの入口のアプリと、`<ホスト>/t/<チーム>` のチームごとのアプリです。パスでチームを分ける構成（`portal.routing: path`。既定）では、**入口のアプリとすべてのチームのアプリで Cookie Path（`path_cookie_attribute`）を有効にする**ことが要件です（Standard と Admin の階層のチームは同じホストの `/t/<チーム>` に並びます）。無効だと、同じホストの別のアプリの AUD も Access JWT の `aud` に入り、Worker の「`aud` はちょうど 1 つ」の検査で断られます（ログインができなくなります）。ホストでチームを分ける構成（`routing: host`）では Cookie もホストで分かれるので、警告にとどめます。Worker は Cookie Path を強制しません。次の 2 つで見ます。

- 参考の Terraform: [`infra/cloudflare/console/`](infra/cloudflare/console/)（MCP 用の `infra/cloudflare/` とは別の state）。入口のアプリ（1 つ）とチームのアプリ（`for_each`）を作り、`path_cookie_attribute = true` に固定します（変数にしません）。Admin の階層のチームのアプリはセッションを短くします（`admin_session_duration`。既定 15 分）。apply は検証していない例です。`terraform output -json console_aud` を `AWSBRIDGE_CONSOLE_AUD_FILE` に保存して使えます。
- 検査: `mise run console:access:inspect`。先に `mise run console:config:generate` で `access.json` を作り、Cloudflare API を読んで（GET だけ。書き込みません）、入口とチームの AUD に当たるアプリが在るか・種類が `self_hosted` か・対象が `<ホスト>/t/<チーム>` か・Cookie Path が有効かを確かめます。R-P では Cookie Path の無効（false・欠落）を誤り（終了コード 1）、設定に無い `/t/` 配下のアプリを警告にします。出力に AUD・トークン・アカウント ID を出しません。
- トークンは読み取り専用の専用トークン（Access: Apps and Policies の Read だけ）を `AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN` に、アカウント ID を `AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID` に `mise.local.toml` で与えます。`wrangler login` の OAuth には落とさず、ほかの道具のトークンも読みません。
- 誤り 0 が保証しないもの: アプリのポリシーが誰を許すか（include・require・exclude の規則）、セッションの長さ、同じパスを覆うほかのアプリ・Allow のポリシー・Bypass の規則。Admin の階層のアプリの設定を誤ると、正しい Admin の階層の AUD で人を通してしまい、Worker では断れません。Admin の階層のアプリのポリシーとセッションの設定は、人が見て記録します。
- issuer のホストには Access のアプリを作りません。IAM と STS が認証なしで取りに来るためです。

### コンソールログインの署名鍵

コンソールログインの Worker（`wrangler.console.jsonc`。Viewer と Administrator の両方を発行する 1 つの Worker）は、境界（`managed`・`partner:<id>`）ごとに、Workers の `secret_key` 型のバインディング（取り出せない `CryptoKey`。RSASSA-PKCS1-v1_5 / SHA-256、usages は `sign` だけ）で STS に渡す JWT に署名します。境界の鍵は Viewer と Administrator の両方に使います（受容 a）。文字列の秘密鍵 JWK を secret に入れる形は使いません。

- 鍵は `mise run console:key:put -- --boundary <境界>` が手元のメモリの中で作り、Cloudflare API で入れます。ファイルに書かず、出力もしません。CI やログを通しません。実行するのは人で、手元からだけです。wrangler には `secret_key` を入れるコマンドがありません。
- バインディングの名前は `CONSOLE_KEY_<kid の先頭 8 バイトの 16 進>` で、kid から決まります（境界の名前は入りません）。道具は同じ名前への投入を断ります。差し替えは必ず別の名前で入れます。
- Worker は vars の `CONSOLE_CURRENT_KEYS`（境界 → 今の鍵の名前と kid）と `CONSOLE_PUBLIC_JWKS`（境界 → 公開鍵。新旧 2 つまで）を読みます。どちらかが空・壊れている、今の kid がその境界の公開鍵に無い、同じ鍵が 2 つの境界にある、ときはどの経路も `500 server_misconfigured` です。署名の前にその境界のバインディングを確かめ（`CryptoKey`・取り出せない・`sign` だけ・`exportKey` が失敗する）、タグのチームの階層とロールの ARN のパスの階層が同じことを確かめ、署名した JWT を vars の公開鍵で確かめます。合わなければその境界の発行は `503 signing_unavailable` です。境界の issuer の JWKS は、その境界の vars の公開鍵だけを出します。
- 鍵を入れるまで（vars が空のあいだ）は、どの経路も `500` です。初回は「Worker をデプロイ → 鍵と CSRF の鍵を入れる → vars を書いてデプロイ」の順にします。
- CSRF の鍵 `CONSOLE_CSRF_KEY` は `secret_text` のままです。`mise run console:secrets -- --yes` が 32 バイトの乱数を手元で作って入れます（ファイルに書かず、表示しません）。作り直すと、開いている画面のフォームは開き直しが要ります。
- トークン: `AWSBRIDGE_CONSOLE_CF_API_TOKEN` には、コンソールの Worker だけを書けるトークン（ゾーンの権限なし）を使います（無ければ `wrangler login` の OAuth をメモリの中だけで使います）。**デプロイと鍵の操作は、Administrator を発行してよい人だけが行います**（受容 b）。鍵を取り出せなくても、Worker のコードや secret を書き換えられる人は任意の JWT に署名できます。
- 停止: vars `LOGIN_DISABLED` を `true` にすると全体の、`ADMIN_LOGIN_DISABLED` を `true` にすると Admin の階層のチームだけの新しい発行を止めます（どちらも `false`・`0`・空・未設定以外は止める側に倒します）。発行済みのセッションは止まりません（revoke）。Admin の階層のチームの Access JWT の経過時間の上限は vars `ADMIN_ACCESS_MAX_AGE_SECONDS`（秒。60〜86400。既定 `900`）です。
- 更新の経路: `secret_key` のバインディングは、`wrangler deploy`、別の secret を更新する `wrangler secret put`・`wrangler secret bulk`・`wrangler secret delete`、`wrangler versions secret put / bulk` → `versions deploy` のあとも残ることを開発環境で確かめました（試験用の Worker で測定）。ダッシュボードや Terraform で Worker のバインディングを管理する経路は測っていないので使いません。
- 変数（`mise.local.toml`）: `AWSBRIDGE_CONSOLE_CF_ACCOUNT_ID`（または wrangler の設定の `account_id`）、`AWSBRIDGE_CONSOLE_CF_API_TOKEN`（任意）、`AWSBRIDGE_CONSOLE_WRANGLER_CONFIG`（既定 `wrangler.console.jsonc`）、`AWSBRIDGE_CONSOLE_ACCESS_TOKEN`（任意。`check` の key-check に使う Access のトークン。`--team <チーム>` で Admin の階層のチームのパスでも開けます）。
- Worker のほかの vars: `ACCESS_TEAM_DOMAIN`、`STS_REGION`（CloudTrail の `AssumeRoleWithWebIdentity` はこのリージョンに残ります）。発行記録は Workers Logs に出し、wrangler の設定は `observability.head_sampling_rate` を `1` に固定しています。

バンドルの確認・手元の起動・デプロイ（先に `mise run console:config:generate` が要る。wrangler の設定は `AWSBRIDGE_CONSOLE_WRANGLER_CONFIG`、既定 `wrangler.console.jsonc`。MCP 用の `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` はこれらのタスクでは読まない）:

```bash
mise run console:build   # wrangler deploy --dry-run --outdir dist/console（鍵の vars が空でもバンドルできる）
mise run console:dev     # wrangler dev（手元用。secret_key のバインディングは作れないので、鍵の vars が空なら全経路 500）
# デプロイは承認したあと手で行う（routes と vars を先に確かめる）。初回と Custom Domain を変えるときは明示の経路:
#   例: AWSBRIDGE_WRANGLER_CONFIG=wrangler.console.jsonc AWSBRIDGE_WRANGLER_ENV= AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy bash scripts/wrangler.sh deploy
# 2 回目から（vars を変えたときなど）は既定の経路: AWSBRIDGE_WRANGLER_DEPLOY_MODE を外す
# （versions upload のあとも鍵が残ることは、以前の階層ごとの Admin の Worker で 1 回測った〈記録は docs/specs/console-login-admin.md〉。
#  1 つのコンソールの Worker では同じ仕組みからの推論なので、デプロイのあと mise run console:key:check を回す）
```

初回の投入（境界ごと）:

```bash
mise run console:key:put -- --boundary managed            # 何をするかの表示だけ（API を呼ばない）
mise run console:key:put -- --boundary managed --yes      # 鍵を作って secret_key として入れる。名前・kid・公開鍵と、次に入れる vars を表示する
# put は wrangler の設定の vars を読んで、その境界だけを入れ替えた vars を表示する。
# 次の境界へ進む前に、表示された CONSOLE_PUBLIC_JWKS と CONSOLE_CURRENT_KEYS を wrangler の設定の vars に書く（書かずに続けると前の境界が抜ける）
mise run console:key:put -- --boundary partner:partner-x --yes
# 同じく、表示された vars を wrangler の設定に書く
mise run console:secrets -- --yes                         # CSRF の鍵（secret_text）
# vars をすべての境界で書いたらデプロイする
mise run console:key:check     # 境界ごとのバインディングの型・discovery と JWKS・key-check（取り出せない・exportKey が失敗する・自己検証）
```

差し替えは「日々の運用」の「鍵の差し替え」に書きました。

### コンソールログインの必須のスタック（base）

[`infra/aws/console/base.yaml`](infra/aws/console/base.yaml)（StackSet `awsbridge-console-base`）は、コンソールログインの IAM の OIDC プロバイダー（1 つ。Viewer と Administrator で同じ）と、階層ごとの守りの部品（顧客管理ポリシー。明示の Deny だけ）を作ります。ロールは作りません（参考のロールのテンプレートは [`infra/aws/console/kind.example.yaml`](infra/aws/console/kind.example.yaml)。生成器を変えたら `mise run console:template:example` で作り直します）。設計は `docs/specs/console-login.md` §4.2・§4.8 です。アカウントごとのパラメーターは生成物の `stacksets.json`（`providers`）にあります。

| パラメーター | 既定 | 内容 |
|---|---|---|
| `IssuerHost` | なし（必須） | issuer のホスト（例 `awsbridge-oidc-console.example.com`） |
| `IssuerPath` | `console` | issuer のパス。issuer は `https://<IssuerHost>/<IssuerPath>`（管理外の先方は `p/<id>/console`） |
| `Audience` | `awsbridge-console` | 固定 |

- プロバイダーは境界ごとに 1 つで、Standard と Admin の階層のロールの両方が同じプロバイダーを信頼します。Viewer と Administrator を分けるのは、ロールの信頼ポリシーのチームの条件（`aws:RequestTag/awsbridge_team`）だけです（受容 d）。
- Admin の守りの部品（`AwsbridgeConsoleGuardAdmin`。`aws login --remote` の Deny を含む）と、その Export は、どのアカウントでもいつも作ります。Administrator を配るかどうかは、Administrator のロールのスタック（別スタック）を作るかどうかだけで決まります。
- 両方の部品が、コンソール用のプロバイダー（`<IssuerHost>` の下のすべてのパス）への書き込み（作成・削除・ClientID の追加など）を Deny します。1 つのホストにした Deny の文は、まだ実物で測っていません（未検証。下流の本番の導入で測ります）。検査の道具（`mise run console:inspect`）は、この形の部品を期待します（違えば `guard_version_mismatch`）。
- **`mise run console:inspect` は、Administrator のロールを作った直後と、チームかロールの設定を変えたあとに必ず回します**（[下流の本番の導入](docs/console-production-rollout_ja.md)では、段 4（Admin の階層を入れる段）でも回します）。信頼ポリシーのチームの値がロールの階層のチームでなければ `trust_team_tier`、退役したチーム名が残っていれば `trust_team_retired`（どちらも誤り）です。
- 順序: issuer（コンソールの Worker の discovery と JWKS）を公開してから、このスタックを配ります。IAM はプロバイダーを作るときに discovery を読みます。この順はその仕組みからの推論で、1 つの issuer では実測していません。
- 配布と更新は、コンソール用のロール以外の主体（StackSets の実行ロールなど）で行います。部品が付いたコンソール用のロールのセッションからは、このスタックを更新できません。
- プロバイダーの ARN は Output に出しますが Export しません。ロールのテンプレートは `IssuerHost`・`IssuerPath` とアカウント ID（`AWS::AccountId`）から ARN を組むので、ロールのスタックのパラメーターにアカウント ID は入りません。
- プロバイダーの削除（L2）は CloudFormation の外で行い、Viewer も止まります。「発行を Cloudflare に頼らずに止める（L2 と信頼ポリシーの拒否）」を見てください。

### ロールのスタック

`mise run console:config:generate` は、種類ごとのロールのテンプレート（`kind.<kind>.yaml`。設定の `roles` から生成）と、そのパラメーター（`stacksets.json`。ロールごとに受け付けるチームを `<ロール>Teams` で持つ。例 `ViewerTeams`）を書きます。パラメーターが空のロールは作りません。各ロールには、その境界のコンソールのプロバイダーの信頼ポリシー（`<ロール>Teams` のチームのタグ。`<ロール>Teams` の `AllowedPattern` は、その種類でそのロールに割り当てたチームだけを受け付けます。`TagKeys`・SourceIdentity 必須）、`aws login` のポリシー（Standard は同じ端末と `--remote`、Admin は同じ端末だけ）、その階層の守りの部品が付きます。参考の出力は [`infra/aws/console/kind.example.yaml`](infra/aws/console/kind.example.yaml) です。生成器を変えたら `mise run console:template:example` で作り直します。

- テンプレートは参考の形です。ロールを手で書いてもかまいませんが、構造の要件（階層・パス `/awsbridge-console/<tier>/`・信頼ポリシーの形・停止が効くこと。`docs/specs/console-login.md` §4.8）は守ります。手で作ったロールの強さは下流の責任です。
- 種類のスタック（名前の型 `awsbridge-console-kind-<kind>`）は、StackSets か、単独のアカウントなら CloudFormation で、コンソール用のロール以外の主体で配ります。
- Administrator のロールは別のスタックに置きます。「Admin の階層と Administrator を足す」を見てください。


### Admin の階層と Administrator を足す

Admin 専用の Worker・issuer・鍵・ホストはありません。Admin の階層のチームは同じポータルのホストに自分の Access のアプリを持ち、コンソールの Worker が `/t/<チーム>` で発行します。本番では [本番でのコンソールログインの導入](docs/console-production-rollout_ja.md) の順に足します。まず Administrator を持たない弱い Admin の階層のロール（段 4）、人が承認したあとで Administrator のロール（段 5）です。

- Admin の階層のチームには、Standard のチームが使っていない・使ったことのない新しい名前を付けます（受容 d。生成器も、台帳の名前と、同じ名前の階層の変更を断ります）。
- その Access のアプリはセッションを短くし（参考の Terraform の `admin_session_duration`。既定 15 分）、vars `ADMIN_ACCESS_MAX_AGE_SECONDS`（既定 `900`）をそれに揃えます。
- `ADMIN_LOGIN_DISABLED` は Admin の階層のチームの新しい発行だけを止めます。`LOGIN_DISABLED` は全部を止めます。

Administrator を配る順（**まだ実行していない例**で、下流の本番の導入で確かめます）: 設定に Admin の階層のチーム（Access のアプリ。セッションは短く）とロールを足して `mise run console:config:generate` を回し、`ADMIN_LOGIN_DISABLED` を `"true"` にして Worker をデプロイしてから、Administrator のロールを Viewer のスタック（`awsbridge-console-kind-default` など）と**別のスタック**で、同じ種類のテンプレート（生成の `kind.<kind>.yaml`）から作ります（止めている間も Viewer のスタックを更新でき、中断はスタックの削除 1 回で済みます）。条件:

- スタック名は型 `awsbridge-console-kind-<kind>` に当たらない名前にします（例 `awsbridge-console-admin-default`）。偽の種類の名前は、SCP と CI の条件（種類のスタックの名前の型）に当たりうるためです。
- パラメーターは、Admin のスタックでは `AdministratorTeams` だけに値を入れ、ほかのチームのパラメーターは空にします。**Viewer のスタックの `AdministratorTeams` は空のまま**にします（同じ名前のロールを 2 つのスタックで作らない）。`AdministratorTeams` の `AllowedPattern` は、その種類で Administrator に割り当てた Admin の階層のチームだけを受け付けます（Standard のチームは渡せません）。
- 作成の change set を見て、変更が **`AdministratorRole` の `Add` だけ**であることを確かめてから実行します。
- 作成の直後・最初の発行の前に、`aws iam get-role` で信頼ポリシーがコンソールのプロバイダーを名指し、チームの条件が Admin の階層のチームだけであること、`aws iam list-attached-role-policies` で Admin の守りの部品が付いていることを確かめ、`mise run console:inspect` を回します（Administrator の棚卸しの節のコマンド）。これらが通ってから `ADMIN_LOGIN_DISABLED` を `"false"` に戻してデプロイします（導入の文書の段 5）。
- Viewer のスタックを更新するときは、必ず change set を見ます。**`AdministratorRole` が出たら実行しません**（Viewer のスタックの `AdministratorTeams` が空でなくなっている）。
- 中断するときは、**Admin のスタックを消し、かつ設定から Administrator を外して生成し直します**（生成物とポータルの一覧に Administrator を残さない）。そのあと Worker をデプロイし、ポータルに Administrator が出なくなったことを確かめます。

## 日々の運用

コンソールログインが動き始めたら、毎日 2 つの確認を回します。発行記録と CloudTrail の突き合わせ（`console:reconcile`）と、コンソールの issuer の外からの確認（`console:exposure-check`）です。署名鍵は間隔を決めて差し替えます。

### コンソールログインの突き合わせ（発行記録 × CloudTrail）

`mise run console:reconcile` は、コンソールの Worker の発行記録（構造化ログ `console_issue`）と、プロファイルのアカウントの CloudTrail の `AssumeRoleWithWebIdentity` を、JWT の `jti`（= `requestParameters.webIdentityTokenId`）で突き合わせます。**記録に無い引き受け**（作られた JWT か、Worker の外からの発行）を誤りとして知らせます。突き合わせは検知の材料で、完全性の証明ではありません（侵害された Worker は偽の記録も書けます）。**発行記録はコンソールの Worker 自身が書きます。コンソールの Worker に書ける者（Viewer だけを扱う人を含む）に対しては、照合は独立の検知ではありません**（受容した限界です。冒頭の受容の節）。

- 1 回で 1 アカウント（`--profile` が要る）。CloudTrail は、そのアカウントの**有効な全リージョン**を読みます（`account list-regions`。使えなければ `ec2 describe-regions`）。読めなかったリージョンは誤りです。
- 呼ぶ aws のコマンドは照会の 4 種類だけです: `sts get-caller-identity`・`account list-regions`・`ec2 describe-regions`・`cloudtrail lookup-events`。プロファイルに要る権限は `sts:GetCallerIdentity`・`account:ListRegions`（または `ec2:DescribeRegions`）・`cloudtrail:LookupEvents` です。
- コンソールの引き受けだけを見ます（ロールのパスが `/awsbridge-console/`、またはプロバイダーのホストが設定の issuer のホスト）。MCP の引き受けは数えません。コンソールのロールを設定に無いプロバイダーで引き受けたものは誤りです。
- 除外した引き受け: どちらにも当たらず照合の対象から外した `AssumeRoleWithWebIdentity` の件数を `excluded assumes (not console): <n>` に出します（所見にはせず、終了コードは変わりません）。期待値は、MCP を同じアカウントで使っていなければ 0 です。初回と、0 でない日は次を確かめます: CloudTrail でそのイベントのロール ARN とプロバイダー（`userIdentity.identityProvider`）を見て、MCP 用のロール（`FederatedAwsBridgeMcpViewer` など）と MCP の issuer のものか。そうでなければ、パスの外のロールを設定に無いプロバイダーで引き受けたもの（たとえば Administrator が残した入口。Administrator の棚卸しの節）でないかを調べ、技術の判断者に上げます。
- 発行記録の入力は 2 つです。どちらか 1 つを渡します。
  - `--records <file|dir>`: NDJSON（生の行・Logpush の Trace Events の包み・Workers Logs のイベント。`.gz` も読みます）。
  - `--logs-api`: Cloudflare の API（`POST /accounts/{account_id}/workers/observability/telemetry/query`）から Workers Logs を読みます。道具が呼ぶ Cloudflare の API はこの照会だけです。窓ごとに、まず一致するイベントの件数（`calculations` の view。`abr_level` が 1 で `sampleInterval` が 1 のときだけ信用する）を得てから、イベントを読みます。長い窓では読み取りが間引かれる（`abr_level` が 1 より大きい）ことがあるので、読んだ行が件数に届かないときや間引かれたときは、窓を半分に割って読み直します。1 分の窓でも届かなければ `record_read_incomplete`（誤り）を出し、終了コード 1 で、state を進めません。
- 発行記録の置き場所（段階 2 の個人の環境）は Workers Logs です（保持は Workers Paid で 7 日）。コンソールの Worker の wrangler の設定は、間引きで記録が落ちないよう `observability.head_sampling_rate` を `1` に固定しています。
- 保持の窓: 既定のさかのぼりは 6 日です（保持の 7 日より短く。状態が無い初回の読み始めで、状態があっても読み始めはこれより前に戻りません。下の「読み始め」）。記録の保持より古く記録の無い引き受けは「検証できない（`unverifiable`）」として別に数えます。さかのぼりを保持より長くすると警告です（`--retention-days` で保持の日数を変えられます）。
- 切られた記録の行（`$cloudflare.truncated` など）と読めない行は、位置だけを出して誤りにします。
- 時間の検査: 対になった引き受けの時刻が、発行の時刻（`jwt.iat`。無ければ記録の時刻）から「JWT の寿命 300 秒＋時計ずれ」を超えて後なら `assume_time_gap`（誤り。終了コード 1）。引き受けが発行より時計ずれを超えて前でも同じ所見です（時計の異常か、作られた JWT に記録を合わせた形。向きは詳細の `+NNNs` / `-NNNs` で見分けます）。時計ずれの既定は 60 秒で、`--clock-skew-seconds <n>` で変えられます。段階 2 の実測で正規の差がこの範囲に収まったので、警告から誤りに上げました。出力の `time from issue: standard n=<件数> min <秒>s max <秒>s, admin …` に、対になった引き受けの発行からの時間差の、階層ごとの件数・最小・最大を出します（しきい値を見直すときの記録に使います）。
- 利用者の検査: 発行記録の利用者（SourceIdentity に使った値）と、CloudTrail の SourceIdentity が**両方あるとき**だけ、伏せ字（`a***@***.com`）どうしで比べ、食い違えば `identity_mismatch`（誤り。終了コード 1）です。発行記録は email を伏せて残すため、比較は弱い一致です（先頭 1 文字と末尾のドメインだけ）。**見つかるのは別のドメインか別の頭文字だけ**で、同じ頭文字・同じドメインの別の人は見分けられません（一致は同じ人を証明しません）。どちらかが無い対は、黙って飛ばさず `identity: compared <n>, not compared <m> (admin <k>)` と `identity_not_compared`（注記）に件数を出します。Administrator の階層（Admin の階層のロール。記録の階層・記録のチームの階層・ロールのパス `/awsbridge-console/admin/` のどれかが Admin の対。プロバイダーは両階層で 1 つなので階層を決めない）で比べられなかった対は、対ごとに `identity_not_compared_admin`（誤り。終了コード 1）です。この階層は Administrator だけでなく Admin の階層のロール全部を含むので、弱い Admin のロールの引き受けでも、比べられなければ誤りになります。
- 階層の検査: 記録の階層とロールのパスの階層が違えば `tier_mismatch`、記録のチームの設定での階層が記録の階層かロールのパスの階層と違えば `team_tier_mismatch`、設定に無いチームの記録は `team_not_in_config`（どれも誤り）。
- Administrator の階層の発行: `admin issues: <n> (<時刻> <結果>, …)` に、読んだ期間の Admin の階層の発行記録の件数と、各時刻（UTC）と結果を出します。毎日の照合で、覚えのない発行が無いかを見ます。Admin の発行の即時の通知はありません（段階 3 で扱います）。
- 確認済みの区間: アカウントごとに「確認済みの区間の終わり」を状態のファイル（`--state <file>`。既定 `.secrets/console-reconcile-state.json`。`.secrets/` は gitignore 済み）に残します。今回の読み始めがそれより後（間に読んでいない区間がある）なら `coverage_gap`（誤り。終了コード 1）です。ファイルが無い初回は穴なしとして扱い、出力に `coverage: first run` と出します。ファイルにはアカウント ID と時刻だけを書き、トークン・email・`jti` は書きません。**区間を進めるのは終了コード 0 の実行だけ**です（終わりは「今回の終わり − 反映の遅れ」）。保証するのは、その実行で読んだ窓に誤りがあれば区間を進めないことまでです。検出した誤りは状態のファイルに残りません。誤りの時刻が窓の外へ出ると（状態が止まったまま約 6 日たつ、`--overlap-seconds` を短くする、`--since` を変える）、次の実行では読まれず、終了コード 0 で区間が進みます。そこで、誤りのある実行は出力の `oldest error finding:` の行に、時刻を持つ誤りの最も古い時刻と、それが既定の窓から外れる時刻を出します。壊れた状態のファイルは初回として扱わず、実行しません（終了コード 2）。穴の誤りを直すには、調べたうえで `--since` を前回の終わり以前に戻して回します（穴を受け入れると決めたときも、状態のファイルは消さずに作り直します。下の運用の「状態が進まず、窓が古くなって読めなくなったとき」）。
- 読み始め: `--since` を渡さなければ、読み始めは「確認済みの区間の終わり − 重なり」と「今 − 6 日」の遅いほうです。重なりは `--overlap-seconds <n>`（既定 `86400` = 24 時間、下限 `3600` = 1 時間。下限より短いと実行しません。終了コード 2）で、反映の遅れ（`--lag-seconds`）とは別の値です。前回の終わりより前の引き受けが CloudTrail に遅れて出ても、重なりの中なら読み直して突き合わせます（記録が無ければ `assume_without_record`）。状態が無い初回は 6 日のままで、`coverage_gap` の判定も変わりません（状態から決めた読み始めは前回の終わり以前なので穴になりません。前回の終わりが 6 日より前なら今までどおり `coverage_gap` です）。出力の `read start:` の行に、読み始めの時刻と決め方（`from the state`・`default lookback`・`--since`）を出します。`--since` を渡せばそれが勝ちます。全部を読み直す監査には `--since 6d` を使います。`--since` と `--overlap-seconds` を一緒に渡すと、`--overlap-seconds` を使わないことを 1 行出します。`--until` だけを過去にして、状態から決めた読み始めが `--until` 以後になると実行しません（終了コード 2）。
  - 終了コード 0 は、重なりの外に遅れて出た引き受けが無いことの証明ではありません（読み始めが 6 日で切り詰められたときも同じです）。重なりの 24 時間と下限の 1 時間は、推測の値と設定の下限で、安全を裏付けた値ではありません。重なりを短くする条件は、実測（遅れの分布）で決めます（導入の段 2 で記録します）。
  - 理由: 状態があっても毎回 6 日を読み直していたとき、古い区間を含む照会で件数が間引かれ（`sampleInterval` が 1 より大きい）、`record_read_incomplete` と、読めなかった記録に当たる `assume_without_record` の誤りになりました。間引かれたのが保存のときか照会のときかは確かめていません。読み始めを状態から決めるのは緩和策です。偽の API の試験では避けられました。実物で効くかは、導入の段 2 で確かめます。重なりの 24 時間も推測の値です（実測で直します）。
- **限界（状態のファイル）**: 状態のファイルを書ける者は、確認済みの区間の終わりを先へ進めて、読み始めを後ろにずらし、その間を読み飛ばさせられます（`coverage_gap` も出ません）。状態のファイルは照合を回す人だけが書ける場所に置きます。照合はこれを見つけません。
- 出力は伏せ字です（`jti` は先頭 8 文字、email は出さない、アカウント ID は末尾 4 桁）。要約に、読んだ期間・リージョン数・検証できない件数・切られた行・記録をどこから読んだか（`source: api` か `file`）を出します。
- 終了コード: `0` 誤りなし / `1` 誤りあり、または検証できない引き受けが 1 件以上（誤りが 0 でも 0 で終わらせない）/ `2` 実行できない（入力・aws・API の失敗）。
- 変数（`mise.local.toml`）: `AWSBRIDGE_CONSOLE_LOGS_TOKEN`（`--logs-api` の API のトークン。環境変数だけ）、`AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID`（Cloudflare のアカウント ID）、`AWSBRIDGE_CONSOLE_LOGS_WORKERS`（任意。Worker の名前。既定 `awsbridge-console`）、`AWSBRIDGE_CONSOLE_CONFIG`（設定ファイル）。
- トークン: 読み取りだけのトークンが望ましいですが、Cloudflare の API の仕様では `telemetry/query` は「Workers Observability Write」の権限しか受け付けません。読み取り（Read）だけで通るかは段階 2 で確かめます。トークンは Workers Observability だけに絞り、Worker や secret を書ける権限を付けません。

```bash
mise run console:reconcile -- --profile <プロファイル> --logs-api               # Workers Logs から（読み始めは状態から。初回は 6 日）
mise run console:reconcile -- --profile <プロファイル> --records ./issue-logs/   # 取り出したファイルから
mise run console:reconcile -- --profile <プロファイル> --logs-api --since 2026-11-10T00:00:00Z
mise run console:reconcile -- --profile <プロファイル> --logs-api --since 6d     # 全部を読み直す（監査用）
```

運用:

- **突き合わせは毎日回します。Administrator の発行の有無に関係なく回します**。回せない日があっても、6 日以内に回せば検証の穴はできません。発行記録の保持は 7 日なので、**7 日以内に突き合わせなかった発行は、あとから検証できません**。回さなかった区間は、道具が `coverage_gap`（誤り。終了コード 1）で知らせます。ただし、空けた日数だけ読む窓が長くなり（読み始めは前回の終わり − 重なり）、古い区間を含む照会は間引かれて `record_read_incomplete` になることがあります。**空けた日数が、間引かれずに読めると実測で確かめた期間を超えると、今の道具の読み方では、その間を完全に読めたことを確かめられません**（その期間はまだ確かめていません）。空けずに毎日回します。
- **誤りが出た実行は区間を進めません**。誤りを調べて決着したら、`--since` を前回の終わり以前に戻して回し直し、区間を進めます。ただし記録の保持の 7 日を過ぎた分は検証できません。放置すると、次の実行から `coverage_gap` が重なって出ます。誤りが出たら、その日のうちに、所見を道具の外に記録します（時刻・code・`jti` の先頭・ロール。検出した誤りは状態に残らず、時刻が窓の外へ出ると次の実行で読まれないため）。原因が分かるまで `--overlap-seconds` と `--since` を変えず、状態のファイルを作り直しません。解決か受け入れを記録してから再開します（解決した日も、解決の記録を残します）。
- **状態が進まず、窓が古くなって読めなくなったとき**: 誤りが続いて区間が進まないと、読み始めは前回の終わり − 重なりのままで、窓は日ごとに長くなります。古い区間を含む照会が間引かれて `record_read_incomplete` が続き、読めなくなったら、次の順に進めます。(1) 保持の期限（7 日）の内に証拠を残します: どの区間を検証できなかったかを記録します（前回の終わりと、出力の `read start:`・`window:` の時刻）。所見と出力もそのまま残します。(2) 短い窓で読み直します: `--since` と `--until` で窓を短く区切って回します（毎日の状態のファイルを動かさないよう、`--state` に別のファイルを渡します）。(3) それでも読めない区間が残ったときだけ、受け入れるかを人が判断します。再開は 2 つを言葉で分けます。**検証して再開**は、短い窓をすべて終了コード 0 で読み終えたときで、読み終えた終わりまで状態のファイルを作り直します。**検証できないまま受け入れて再開**は、読めない区間を人が受け入れたときで、状態のファイルを作り直す前に、道具の外の消えない記録に次を残します: 対象のアカウント・検証できなかった区間・未解決の所見・受け入れの理由・判断した人と日時・状態のファイルの変更の前後。状態のファイルの中身は、どちらの再開でも同じ形（確認済みの区間の終わり）になるので、区別はこの記録だけに残ります。状態のファイルを黙って消しません（消すと初回として扱われ、検証できなかった区間がどこにも残りません）。
- **`assume_time_gap`・`identity_mismatch`・`identity_not_compared_admin` が出たら**: 停止スイッチ（Admin の発行なら vars `ADMIN_LOGIN_DISABLED`、それ以外は `LOGIN_DISABLED` を `true`）で発行を止め、該当の発行と引き受け（発行記録と CloudTrail のイベント）を調べ、技術の判断者に上げます。誤りが残る間、区間は進みません。発行記録（Workers Logs）の保持は 7 日で、過ぎると該当の発行を調べられなくなるので、放置しません。
- **`--since` を渡すとき、`--since` は回す間隔より 5 分以上長くします**（確認済みの区間の終わりが「今回の終わり − 反映の遅れ（既定 300 秒）」になるため、ちょうどの長さでは穴が出ます）。例: 毎日回すなら既定の 6 日のままにします（`--since` を付けません。6 日は読み始めの上限で、状態があれば読み始めは状態から決まります）。
- 毎日の実行は awsbridge の外（MCP 経由のエージェントなど）で行います。awsbridge には定期の実行の仕組みを入れません。通知も awsbridge の外で、仕組みは利用者が決めます。
- 段階 2 の最初に、実物で次を確かめます: Cloudflare の API の応答の形（`events`・`$metadata.id` のカーソル・`count` の意味・切られた印が `$workers.truncated` か `$cloudflare.truncated` か）、CloudTrail の `AssumeRoleWithWebIdentity` のフィールド名（`requestParameters.webIdentityTokenId`・`userIdentity.identityProvider` など）。違えば `scripts/console/reconcile-cf.ts`・`src/console/reconcile-input.ts` とフィクスチャを直します。

### コンソールログインの issuer の外からの確認（毎日）

`mise run console:exposure-check` は、コンソールの issuer の `/.well-known/openid-configuration` と `jwks.json` を**外から取り**、設定の公開鍵と比べます。AWS の IAM の OIDC プロバイダーは issuer のホストが返す JWKS を信頼するので、Route などでそのホストの応答を差し替えられると、作られた JWT（たとえば Administrator）が通りえます。これは「awsbridge が出しているものが正しいこと」の毎日の確認で、`console:reconcile` と合わせて毎日の確認の 2 つになります: (i) この外からの比較、(ii) 上の突き合わせ。

- **対象**: 境界ごとの issuer（Viewer と Administrator で同じ issuer）。
- **比べる相手**: wrangler の設定の vars の公開鍵（`CONSOLE_PUBLIC_JWKS`。`console:key:check` が読むのと同じファイル）と、生成物 `worker.json` の境界の issuer の URL。`kid` だけでなく、鍵の中身（`kty`・`n`・`e`・`alg`・`use`・余分なメンバー）、discovery の `issuer` と `jwks_uri`、HTTP の状態（200 だけ）を比べます。
- **誤りにするもの**（すべて合ったときだけ「一致」）: 200 以外の状態、**リダイレクト（追わずに誤り）**、取得の失敗・タイムアウト、JSON でない・形が違う応答、`issuer` / `jwks_uri` の違い、欠けた鍵、**余分な鍵**、中身の違う鍵、`kid` の重複。
- **取り方**: 手元の DNS（否定のキャッシュを含む）に左右されないよう、公開の DNS over HTTPS（`https://cloudflare-dns.com/dns-query`。A と AAAA）でホストを引き、その IP に TLS で接続します。SNI と `Host` はもとのホスト名で、証明書もホスト名で検査します。文書ごとに GET は 1 回、再試行なし、タイムアウト 10 秒。**Cloudflare・AWS のトークンは使わず**、`Authorization` も送りません（公開の HTTP の GET だけ）。
- **出力と終了コード**: issuer ごとの `[OK]` / `[NG]` の行と結論。応答の値（`n`、知らない鍵の `kid`）は出さず、アカウント ID・email は伏せます。`0` すべて一致 / `1` 不一致あり / `2` 実行できない（設定が読めない・期待する鍵を得られない など）。
- 変数（鍵の道具と同じ。`mise.local.toml` に置く）: `AWSBRIDGE_CONSOLE_OUT_DIR`（既定 `.generated/console`）、`AWSBRIDGE_CONSOLE_WRANGLER_CONFIG`（既定 `wrangler.console.jsonc`）。先に `mise run console:config:generate` を回します。

```bash
mise run console:exposure-check
```

限界と、ゾーンの持ち主が持つもの:

- **ゾーンの設定の見張りは、ゾーンの持ち主の運用で持ちます**。awsbridge はゾーンを読めるトークンを持ちません。見るべきもの: **コンソールの 2 つのホスト（ポータルと issuer）に当たる Route が無いこと**。`*.<zone>/*` のようなワイルドカードで当たるものも数えます。確かめ方の例: Zone Read などを持つトークンをその場で使い、`GET /zones/{zone_id}/workers/routes` を**全ページ**読みます。**一覧が取れない・途中で終わったときは、0 本とみなしません**。awsbridge はこのためのトークンを常には持ちません。Custom Domain を変えたときは、そのとき使ったトークンを消す前に、同じトークンで 1 回確かめます。
- **外からの比較は検知であって、予防ではありません**。残っている差し替えは次の確認で見つかりますが、確認の間に足して外したものは見つかりません。ポータルのホストに Route を重ねられると、ログイン済みの利用者として発行されうり、その発行は突き合わせでは正常に見えます（推測。測っていません）。

### 鍵の差し替え

#### 署名鍵のローテーション（MCP の中継）

MCP の Worker の署名鍵（secret `SIGNING_JWK`）を、止めずに入れ替える手順です。STS は JWKS をキャッシュするので、単純に差し替えると切り替え直後に検証が失敗します。そこで、新しい鍵の公開鍵を先に JWKS（`/.well-known/jwks.json`）へ載せ、STS が取り込んでから署名を切り替えます。

```
mise run key:prepare    # 1. 次の鍵を生成（AWSBRIDGE_NEXT_KEY_FILE。既にあれば中止）
mise run secrets        #    次の鍵の公開鍵を JWKS に載せる（署名は現行の鍵のまま）
# ── 最低 1 時間（安全側に 24 時間）待つ: STS の JWKS キャッシュが切れるまで ──
mise run key:activate   # 2. 現行 → PREVIOUS、NEXT → 現行
mise run secrets        #    署名を新しい鍵に切り替える（JWKS には前の鍵の公開鍵も残る）
# ── JWT の有効期限（5 分）以上待つ ──
mise run key:retire     # 3. 前の鍵（PREVIOUS）を削除
mise run secrets        #    古い公開鍵を JWKS から外す
```

- STS の JWKS キャッシュの長さは公開されていないため、待ち時間は目安です。1 回目の待ちは最低 1 時間、確実にするなら 24 時間。2 回目の待ちは JWT の有効期限（5 分）以上で、`/.well-known/jwks.json` の `cache-control: max-age=300` も考慮して余裕を見てください。
- `mise run secrets` は、`AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE`（既定は `AWSBRIDGE_KEY_FILE` の拡張子の前に `.next` / `.previous` を付けたもの）のファイルがあれば、その**公開鍵だけ**を secret `ADDITIONAL_PUBLIC_JWKS` に登録します（秘密成分は secret に入れません）。どちらも無ければ空配列 `[]` を登録し、前回の追加鍵を消します。署名は常に `SIGNING_JWK`（現行の鍵）だけで行います。
- 鍵ファイルは 0600 で作り、上書きしません。各タスクは操作の前に存在を確認し、条件に合わなければ何も動かさず中止します（`key:prepare`: NEXT が既にある、`key:activate`: NEXT が無い・PREVIOUS が既にある）。`key:retire` は PREVIOUS が無ければ何もしません。
- `ADDITIONAL_PUBLIC_JWKS` の**要素**が不正（短い鍵・壊れた base64url・RSA 以外など）なら、Worker はその要素だけを捨てて `jwks: invalid additional key skipped (index=<n>)` を warn で出し、署名鍵の公開鍵と正しい追加鍵は返します（JWKS 全体は止まりません）。JSON として壊れている・配列でない場合も、追加鍵なしで 200 を返します。`SIGNING_JWK` が不正なときだけ 500 `server_misconfigured` です。なお捨てられた鍵で署名しても STS は検証できないので、`mise run secrets` は next / previous の鍵ファイルを同じ検証にかけ、通らなければ登録せずに止まります。
- 仕組みの詳細は `docs/specs/architecture.md` の「署名鍵のローテーション」を参照してください。

#### コンソールログインの署名鍵

境界ごと。90 日以下を目安に。侵害の疑いがあれば必ず替え、旧い kid を外す。1 つの鍵なので Viewer と Administrator の両方に効く:

```bash
mise run console:key:put -- --boundary managed --yes      # 1. 新しい鍵を別の名前で入れる
# 2. vars CONSOLE_PUBLIC_JWKS のその境界を新旧 2 つにしてデプロイする（JWKS に並べる）
# ── 最低 1 時間（安全側に 24 時間）待つ: STS の JWKS キャッシュが切れるまで ──
# 3. vars CONSOLE_CURRENT_KEYS のその境界を新しい鍵にしてデプロイし、mise run console:key:check
# 4. JWT の有効期限（5 分）より長く待ってから、旧い公開鍵を CONSOLE_PUBLIC_JWKS から外してデプロイする
mise run console:key:retire -- --binding CONSOLE_KEY_<旧い鍵> --yes   # 5. 旧い鍵を消す（今の鍵・vars と JWKS に残る鍵・CSRF の鍵は断る）
```

## 発行を止める（コンソールログイン）

| 手段 | やり方 | 止まるもの |
|---|---|---|
| 停止スイッチ | コンソールの Worker の vars `LOGIN_DISABLED` を `true` にしてデプロイする（発行は `503 login_disabled` になる） | すべてのチームの新しい発行 |
| Admin の停止スイッチ | vars `ADMIN_LOGIN_DISABLED` を `true` にしてデプロイする（Admin の階層のチームだけ、同じ `503 login_disabled`） | Admin の階層のチームの新しい発行 |
| kid を外す | `CONSOLE_PUBLIC_JWKS` のその境界から kid を外してデプロイする（今の鍵の kid なら、Worker は vars の誤りとみなし、どの経路も `500 server_misconfigured` を返す） | その鍵での発行。Viewer も Administrator も（鍵は境界ごとに 1 つ）。今の kid を外すと、すべての境界・両方の階層のどの経路も止まる |
| プロバイダーの削除（L2） | 下の「発行を Cloudflare に頼らずに止める（L2 と信頼ポリシーの拒否）」。Cloudflare に頼らない | そのアカウントのすべてのコンソールのロールの新しい引き受け。Viewer も止まる |
| 信頼ポリシーでの拒否 | 下の「ロールの信頼ポリシーでの拒否」。Cloudflare に頼らない | そのロールの新しい引き受け（Administrator だけを止める手段） |
| Administrator のスタックの削除 | そのアカウントの Administrator の別スタックを消す。Cloudflare に頼らない | そのアカウントでの Administrator の新しい引き受け（発行済みのセッションも終わるかは未測定） |
| revoke（L3） | ロールのセッションの失効（IAM の「アクティブなセッションを取り消す」） | そのロールで発行済みのセッション |
| 1 人停止（L3-1） | 下の「コンソールログインの 1 人停止」 | その人の発行済みと新しいセッション |

- 発行済みの AWS のセッションを止めるのは、revoke（L3）と 1 人停止（L3-1）だけです。ほかの手段が止めるのは、新しい発行か新しい引き受けだけです。
- revoke も 1 人停止の Deny も、`aws login` のリフレッシュトークンを無効にしません。外すと、`aws login` は次の更新で再ログインなしに新しい認証情報を取ります。外す時機は `docs/specs/console-login.md` §6.3 です。
- どの停止も、固定の時間を待って完了にせず、拒否されたことを確かめて完了にします（`docs/specs/console-login.md` §6.1）。
- **Worker で止められないとき**: Worker をデプロイできない、`503 login_disabled` を確かめられない、Worker を信用できない（コード・secret・デプロイの権限・依存物が侵害されたかもしれない）ときは、停止スイッチを試し続けません。AWS の側で止めます。下の「発行を Cloudflare に頼らずに止める（L2 と信頼ポリシーの拒否）」のとおり、信頼ポリシーでの拒否、Administrator のスタックの削除、プロバイダーの削除（Viewer も止まる）です。発行済みのセッションには revoke（L3）を足します。

### コンソールログインの 1 人停止

1 人だけを止めるときは、その人の SourceIdentity（既定は email）を、コンソールログイン用のロールのインラインポリシーの予約名 `AwsbridgeConsoleDenySourceIdentity` に Deny として書きます（`aws:SourceIdentity` が一致するセッションの全操作の Deny。設計は `docs/specs/console-login.md` §6.3）。書くのは停止の道具です。

- 停止の一覧は検査の `--stops` と同じ形のファイル（`{ "sourceIdentities": ["..."] }`）で、これが「止めている一覧」の正本です。**email を含むので、`.secrets/` か下流のリポジトリに置き、公開リポジトリにコミットしません。**
- `console:stop:apply` は、対象の全ロールの予約名の中身をファイルの一覧に合わせます。対象は、設定のロール（アカウントにあるもの）、`/awsbridge-console/` のパスのロール、パスの外でコンソールのプロバイダーを信頼する設定に無いロール（計画の表示で「設定に無いロール」と出ます。出どころは `unlisted`）です。
- `--yes` が無ければ計画の表示だけです。ただし今の状態との差を出すため、IAM の読み取りと `sts get-caller-identity` は呼びます（鍵の道具の「`--yes` なしは API を使わない」とは違います）。書き込みは `iam put-role-policy` と `iam delete-role-policy` の 2 種類だけです。
- `--allow-remove` が無ければ足すだけです。各ロールの予約名を「今の値とファイルの値を合わせたもの」にします。ファイルに無い値がロールに残っていても消さず、件数だけを余分（`EXTRA`）として表示します。余分があるだけなら終了コードは 0 です。足す値が 1 つも無く外す値だけがある実行（解除だけ）は、`--allow-remove` が無ければ何も書かずに終了コード 2 で止まります。
- `--allow-remove` を付けると、ファイルの一覧にそろえます（停止の解除）。全ロールに足し終えてから外すので、外す側の失敗が足す側を止めません。§6.3 の解除の条件（そのロールの `MaxSessionDuration` が切れるまで外さない、原因の除去、古い鍵の排除、新規の発行ができないことの確認）を表示します。道具はこれらを確かめられないので、人が確かめます。設定に無いロールからも外します。
- どちらでも 1 つのロールのために全体を止めません。予約名に停止の形でない文書があるロール・インラインの合計が 10,240 文字を超えるロール・書き込みに失敗したロールは書かずに報告し、ほかのロールには書いて、終了コード 1 で終わります。
- `--reason` は必須です。実行の結果を 1 行の JSON（時刻・アカウントの末尾 4 桁・ロール・件数の変化・理由。値は入れません）で標準出力に出すので、運用者が保管します。出力に email の値と全桁のアカウント ID は出しません。
- コンソール用のロール（設定のロール名か `/awsbridge-console/` のパス）のセッションからは実行しません（守りの部品が書き込みを Deny するため）。IAM Identity Center など別の入口から実行します。

```bash
mise run console:stop:show -- --profile=<p> --stops=.secrets/console-stops.json      # 読み取りだけ。ロールごとの件数と、足りない・余分
mise run console:stop:apply -- --profile=<p> --stops=.secrets/console-stops.json --reason="<理由>"         # 計画の表示
mise run console:stop:apply -- --profile=<p> --stops=.secrets/console-stops.json --reason="<理由>" --yes   # 書き込む
mise run console:inspect -- --profile=<p> --stops=.secrets/console-stops.json        # 書いたあと、設定のロールを確かめる
```

`console:inspect --stops` が確かめるのは設定のロールです。設定に無いロールとパスの外のロールは、停止の道具が書いたあとの読み直しで確かめます（結果は道具の出力の表）。

終了コード: 0 書き終えた（または変更なし。余分が残るだけなら 0）/ 1 書けなかったロールがある / 2 実行しなかった（入力の誤り・読み取りの失敗・呼び出し元・`--allow-remove` が無い解除だけの実行）。

### 発行を Cloudflare に頼らずに止める（L2 と信頼ポリシーの拒否）

**Administrator だけを止める L2 はありません**（受容 e）。プロバイダーは Viewer と Administrator で 1 つなので、プロバイダーの削除（L2）は Viewer も止めます。Administrator だけを Cloudflare に頼らずに止めるのは、Administrator のロールの信頼ポリシーでの拒否（下）と、Administrator のスタックの削除です。発行済みの AWS のセッションはどれも止まらないので、revoke（L3）と合わせます。**CloudFormation の外で行います。** 下の削除と戻す手順は、段階 2 の個人の環境で（コンソールのプロバイダーを 1 つにする前の、階層ごとの Admin のプロバイダーで。仕組みは同じです）実行しました: 消したあとの発行はポータルで `upstream_auth_failed`（「このアカウントは現在ログインを受け付けていません」）になり、消す前の CLI のセッションは続きました。同じ URL・client ID・タグで作り直すと ARN も同じで、作り直しのあとに届いた最初の発行（約 2 分後）は通りました。

1. コンソール用のロール以外の主体で、対象のアカウントのコンソールのプロバイダーを削除します（部品の Deny は、コンソール用のロールからの書き込みだけを塞ぎます）。Viewer も止まります。

   ```sh
   aws iam delete-open-id-connect-provider --profile <運用者のプロファイル> \
     --open-id-connect-provider-arn arn:aws:iam::<アカウントID>:oidc-provider/awsbridge-oidc-console.example.com/console
   ```

2. **止めている間は、base のスタック（そのアカウントのスタックインスタンス）を更新しません。** プロバイダーはスタックから見てドリフトになっていて、その間の更新の挙動（失敗するか、作り直すか）は未測定です。作り直されると、止めた意味が無くなります。
3. 戻すときは、同じ URL・同じ client ID・同じタグでプロバイダーを作り直します。ARN は URL で決まるので、ロールの信頼ポリシーは変えません。

   ```sh
   aws iam create-open-id-connect-provider --profile <運用者のプロファイル> \
     --url https://awsbridge-oidc-console.example.com/console \
     --client-id-list awsbridge-console \
     --tags Key=project,Value=awsbridge
   ```

4. 作り直したら、発行を 1 回通し、スタックのドリフトの検出で差が無いことを確かめてから、スタックの更新を再開します。作り直したプロバイダーはドリフトが残りません（その実行では、作り直したプロバイダーの指紋も元と同じで、base のドリフトの検出が IN_SYNC）。

未測定のまま: 止めている間の base のスタックの更新の挙動（その実行では行っていません）。消してから引き受けが止まるまでの時間は、Standard の形で約 12 秒の測定（`docs/specs/console-login.md` §6.1）だけです。

#### ロールの信頼ポリシーでの拒否

Cloudflare に頼らないもう 1 つの発行の停止で、Administrator だけを止められる手段です。止めたいロールの信頼ポリシーに、`sts:AssumeRoleWithWebIdentity` の `Deny` の文を足します（コンソール用のロール以外の主体で、手で行います）。同じ段階 2 の実行（Admin の階層のロール）では、足したあとの発行はポータルで `sts_denied`（「このロールに入れませんでした」。CloudTrail は `AccessDenied`）になり、プロバイダーの削除（`upstream_auth_failed`）と区別できました。既存の CLI のセッションは続きました（止めるのは revoke）。

- **信頼ポリシーの Deny は CloudFormation の管理の外にあります。止めている間はロールのスタックを更新しません。戻しは手で行い、発行 1 回とドリフト検出で確かめます。**
- 測った 2 通りの更新（変更なしの更新、スタックのタグだけを変える更新）では、Deny は消えませんでした（CloudFormation はテンプレートの信頼ポリシーを書き戻しませんでした）。信頼ポリシー自体が変わる更新で Deny が消えるかは未測定です（チームの割り当ての変更など）。未測定なので、止めている間は更新しません。

## コンソールログインの Administrator の残った権限の棚卸し

Administrator は対象のアカウントの全権なので、アクセスキー・ロール・プロバイダー・信頼ポリシーの変更などで、コンソールログインを止めたあとも使える入口を残せます。revoke（L3）や 1 人停止（L3-1）ではこれらは止まりません（`docs/specs/console-login-admin.md` §7）。止めたあと（または定期の確認で）、次の手順で棚卸しし、残ったものを個別に消します。**下のコマンドはまだ実行していない例**で、停止の訓練（段階 2 と、[本番の導入](docs/console-production-rollout_ja.md)の訓練）で確かめます。読み取りだけの例で、消す操作はここに書きません。コンソール用のロール以外の主体（IAM Identity Center など）のプロファイルで実行します。 **この棚卸しは完全な復旧を保証しません**。見つかるのは、ここに挙げた読み取りで見えるものだけです。

1. **コンソール用のロールそのもの**: `mise run console:inspect -- --profile=<p>` で、信頼ポリシー・管理ポリシー（守りの部品とその版を含む）・インラインポリシー・`MaxSessionDuration`・プロバイダーを、設定から作った期待の形と比べます。道具を使わずに見るときは次のとおりです。

   ```sh
   aws iam get-role --role-name FederatedAwsBridgeAdministrator --profile <p>                     # 信頼ポリシー（AssumeRolePolicyDocument）・パス・MaxSessionDuration
   aws iam list-attached-role-policies --role-name FederatedAwsBridgeAdministrator --profile <p>  # 管理ポリシー（AdministratorAccess と Admin の守りの部品だけか）
   aws iam list-role-policies --role-name FederatedAwsBridgeAdministrator --profile <p>           # インラインポリシーの名前（AwsLogin・予約名の停止など）
   aws iam get-role-policy --role-name FederatedAwsBridgeAdministrator --policy-name <名前> --profile <p>
   ```

2. **プロバイダー**: OIDC プロバイダーの一覧が、MCP 用とコンソール用（境界の issuer。Viewer と Administrator で 1 つ）だけかを見ます。URL・client ID・タグを、base のスタックが作るものと比べます。SAML プロバイダーも見ます。

   ```sh
   aws iam list-open-id-connect-providers --profile <p>
   aws iam get-open-id-connect-provider --open-id-connect-provider-arn <ARN> --profile <p>
   aws iam list-saml-providers --profile <p>
   ```

3. **その人のセッションが行った書き込み**: CloudTrail の管理イベントから、`userIdentity.sessionContext.sourceIdentity` がその人の SourceIdentity（既定は email）のものを拾います。`lookup-events` は過去 90 日・1 リージョンずつで、絞り込みの属性は 1 回に 1 つだけです。SourceIdentity では絞り込めないので、`EventSource` などで絞ってから、`CloudTrailEvent`（JSON の文字列）の中身で絞ります。IAM のイベントは基本的に us-east-1 に記録されます（CloudTrail の文書の「Global service events」。ほかのリージョンに記録されるグローバルサービスのイベントもあるとされる）。ほかのサービスも含め、有効なリージョンごとに見ます。**引き受けたあとの操作のイベントに `sourceIdentity` が残るか（`docs/specs/console-login.md` で未確認の項目）は、このリポジトリではまだ確かめていません**。段階 2 で確かめ、残らなければこの手順を直します（RoleSessionName の `console-<email>` で拾う形など）。

   ```sh
   aws cloudtrail lookup-events --region us-east-1 --profile <p> \
     --lookup-attributes AttributeKey=EventSource,AttributeValue=iam.amazonaws.com \
     --start-time 2026-11-01T00:00:00Z --output json \
     | jq '.Events[].CloudTrailEvent | fromjson
           | select(.userIdentity.sessionContext.sourceIdentity == "user@example.com")
           | {eventTime, eventName, requestParameters}'
   ```

   見る操作の例: `CreateUser`・`CreateAccessKey`・`CreateLoginProfile`・`CreateRole`・`UpdateAssumeRolePolicy`・`PutRolePolicy`・`AttachRolePolicy`・`PutUserPolicy`・`AttachUserPolicy`・`CreatePolicyVersion`・`CreateOpenIDConnectProvider`・`AddClientIDToOpenIDConnectProvider`・`CreateSAMLProvider`。IAM の外でも、リソースポリシー（S3 のバケットポリシー・KMS のキーポリシー・Lambda の関数の権限や関数 URL など）を他の主体に開く変更を見ます。

4. **CloudTrail に頼らない一覧**: CloudTrail を止められた・消された可能性もあるので、IAM の今の状態を一覧にして、前回の一覧（または期待する状態）と比べます。 IAM の外も同じです。使っているサービスごとに今のリソースポリシー（例: S3 のバケットポリシー、KMS のキーポリシー、Lambda の関数のポリシーと関数 URL）を取り、Administrator を使う前に取った基準と比べます。

   ```sh
   aws iam get-account-authorization-details --profile <p> > authz-<日付>.json   # ユーザー・ロール・グループ・ポリシーの全体（中身にアカウント ID を含むので公開リポジトリに置かない）
   aws iam list-users --profile <p>
   aws iam list-access-keys --user-name <ユーザー> --profile <p>
   ```

5. 見つけたものを、原因を確かめてから個別に消し、消したものと時刻を記録します。消し終えるまで、そのアカウントでの停止（L3・L3-1）は外しません（`docs/specs/console-login.md` §6.3 の解除の条件）。

## MCP の中継の既存のデプロイの移行

この節は、古い版の awsbridge でデプロイした MCP の中継にだけ当てはまります。

### 既存デプロイからの移行（`AWS_PROFILES` の廃止）

以前は `AWS_PROFILES` を vars または secret（`mise.local.toml` の `AWSBRIDGE_PROFILES`）で渡していました。これは廃止したので、次の手順で移します。

```
# 上流の開発用デプロイ: mise.local.toml の AWSBRIDGE_PROFILES（JSON 文字列）の中身を config/profiles.json に書く
cp config/profiles.example.json config/profiles.json   # 中身を自分の一覧に置き換える。mise.local.toml の AWSBRIDGE_PROFILES は削除
# 下流リポジトリ: wrangler.<name>.jsonc の vars.AWS_PROFILES を deploy/profiles.json に移し、vars を消して alias を足す
mise run deploy:worker
# 不要になった Worker secret を消す（secret で持っていた場合のみ。--config / --env は使っていた設定に合わせる）
bash scripts/wrangler.sh secret delete AWS_PROFILES
```

`AWS_PROFILES` の vars / secret が残っていても Worker は読みません（無視されます）。ただし secret は Worker に残り続けるので、`secret delete` で消してください。

### 移行（既定のロール名の変更とデバッグロールの縮小）

既定のロール名を `FederatedMcpReadOnly` → `FederatedAwsBridgeMcpViewer`、`FederatedMcpDebug` → `FederatedAwsBridgeMcpDebugger` に変えました。短い期間だけ既定が `FederatedMcpViewer` / `FederatedMcpDebugger` だったことがあり、そのスタックでも同じ移行になります（パラメーター名 `ReadOnlyRoleName` / `DebugRoleName`、出力 `ReadOnlyRoleArn` / `DebugRoleArn`、環境変数 `AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME` は変わりません）。

- **旧名が保たれるのは、既存スタックを `scripts/deploy-aws.sh` で更新し、名前を指定しない場合だけです。** `scripts/deploy-aws.sh`（`mise run deploy:aws`）は `aws cloudformation deploy` を使い、ロール名は環境変数を設定したときだけ渡します。既存スタックでは、渡さないパラメーターにスタックの既存の値が使われます。次の場合はロールが置き換えられ、`roleArn` と一意 ID が変わります: (1) `AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME` で新しい名前を指定した（新しい名前に移るときはこれ）。(2) それ以外のやり方でテンプレートを流した（マネジメントコンソール、`UsePreviousValue` を付けない `create-change-set` / `update-stack`、StackSets など。指定しないパラメーターにテンプレートの既定値、つまり新しい名前が使われることがあります）。(3) スタックを削除して作り直した。
- **移行の前に、変更を下見してください。** `scripts/deploy-aws.sh` と同じ引数に `--no-execute-changeset` を付けて `aws cloudformation deploy` を実行し、`aws cloudformation describe-change-set --stack-name <スタック> --change-set-name <名前> --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]'` で、`ReadOnlyRole` / `DebugRole` に `Replacement: True` が出ないか確かめます。変更セットは実行しなければ何も変わりません。確かめたら `aws cloudformation delete-change-set` で削除してください。
- **移行の前に、旧ロールの ARN を参照しているものを確かめてください:** KMS のキーポリシー、S3 のバケットポリシー、SCP、ほかのロールの信頼ポリシーなど。旧 ARN を書いたポリシーは新しいロールには当たりません。リソースポリシーの `Principal` に書いたロールは一意 ID で保存されるので、置き換えのあとは同じ名前のロールでも信頼は戻りません。これらのポリシーを直してください。
- **OIDC プロバイダーの削除や信頼ポリシーの変更では、発行済みの STS 認証情報は失効しません。** 旧ロールのセッションは有効期限まで残ります（Worker が求める長さは 900 秒。上限はロールの `MaxSessionDuration`、既定 3600 秒）。すぐに止めたいなら、削除の前に旧ロールでセッションの失効（IAM の「アクティブなセッションを取り消す」）をかけてください。
- **削除の完了は CloudFormation の結果だけでなく、IAM の実体で確かめてください。** スタックを削除したら、対象のアカウントすべてで、ロールと OIDC プロバイダーが実際に消えたことを確かめます。
- **デバッグロールで秘密値を API で読めなくなりました。** `SecretRead`（`secretsmanager:GetSecretValue`、`ssm:GetParameter*`）と `SecretDecrypt`（`kms:Decrypt`）を削除し、両ロールでこれらの取得を条件なしで Deny します。これは非互換の変更で、`DebugAdditionalPolicyArns` で追加ポリシーを付けても戻せません（明示 Deny が優先します）。ロール名を変えるかどうかに関係なく、スタックを更新すると効きます。

#### 同じスタックで改名する（切り替えの間 MCP は失敗する）

1. 新しい名前でスタックを更新する: `AWSBRIDGE_READONLY_ROLE_NAME=FederatedAwsBridgeMcpViewer AWSBRIDGE_DEBUG_ROLE_NAME=FederatedAwsBridgeMcpDebugger AWS_PROFILE=<対象> mise run deploy:aws`。新しい出力 `ReadOnlyRoleArn` / `DebugRoleArn` を控える
2. プロファイル一覧（`config/profiles.json`、下流なら `deploy/profiles.json`）の `roleArn` を更新する
3. Worker をデプロイする: `mise run deploy:worker`
4. 両ロールで確かめる（読み取り専用とデバッグのプロファイルでそれぞれツールを呼ぶ）

手順 1 から手順 3 が終わるまで、MCP の呼び出しは失敗します（プロファイル一覧が、もう無い旧 ARN を指しているため）。

#### 別スタックで並行稼働する（issuer の URL も変える場合）

issuer の URL（issuer のホスト）も変えるなら、新しいスタックを旧スタックと並べて動かし、停止時間をほぼ無くして切り替えられます。issuer の URL（`AWSBRIDGE_ISSUER`）・スタック名（`AWSBRIDGE_STACK_NAME`）・ロール名（`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`）の 3 つをすべて旧と違う値にしてください。IAM の OIDC プロバイダーは URL ごとに 1 つで、ロール名はアカウント内で一意なので、どれかが同じだと並行できません。上流のコードの変更は要りません（どれもパラメーター化済みです）。

始める前に決めること:

- **旧スタックの削除は移行の一部です。期限を決めてください。** 旧スタックを削除するまで旧デバッグロールは `SecretRead` を持ったまま残るので、それまでは「秘密値を API で直接読めなくする」が効いていません。
- **署名鍵を新旧で同じにするか分けるか。** 同じにすると、鍵が漏れたとき旧スタックを削除するまで旧ロール（秘密値を読める旧デバッグロールを含む）にも届くので、上の期限が特に重要です。分けるなら、`AWSBRIDGE_KEY_FILE` を新しいファイルに向けて `mise run keygen` で新しい鍵を作ります。鍵を更新する機会になります（既存の手順は「署名鍵のローテーション（MCP の中継）」を参照）。
- **URL が変わると、Cloudflare Access のアプリ（AUD）と MCP クライアントの接続先も変わります。** 新しい接続先のホストを Access のアプリで守り、新しい issuer のホストでは `/.well-known/*` を公開のままにし（「ホストを決める」と `infra/cloudflare` を参照）、新しい Worker の `ACCESS_AUD`（`AWSBRIDGE_ACCESS_AUD`）を新しいアプリの AUD にしてください。Worker は `ACCESS_AUD` で Access の JWT を自分でも検証するので、Access を通らずに届いた要求（issuer のホスト・別のホスト・Preview URL）は 401 になります。新しいホストでもこれを確かめてください（例: issuer のホストの `/mcp` が 401 になる）。workers.dev の URL と Preview URL は閉じたままにします（独自ドメインの形と同じく `workers_dev` と `preview_urls` を `false` にする）。

手順（Worker が先です。初回と同じく、IAM は OIDC プロバイダーを作るときに issuer の `/.well-known/openid-configuration` を読みます）:

1. 新しい URL で応答する別名の Worker を、`ISSUER` = 新しい URL でデプロイする（例: `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` で別の wrangler 設定を使い、`AWSBRIDGE_ISSUER` を新しい URL にする。`mise run deploy:worker` は `ISSUER` の指定とプロファイル一覧のバンドルを同じデプロイで行う。新しい Worker なので明示の経路 `AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy` が要る）。STS は issuer の URL からディスカバリーと JWKS を取りに来て、ディスカバリーの issuer は Worker の `ISSUER` です。Worker は `ISSUER` を 1 つしか持たないので、旧 Worker は新しい issuer を出せません。並行稼働にはこの別名の Worker が要ります。この時点のプロファイル一覧は、初回と同じくダミーでかまいません
2. 新しい `AWSBRIDGE_ISSUER`・`AWSBRIDGE_STACK_NAME`・ロール名を設定して、`mise run deploy:aws` で新しいスタックを作る。対象のアカウントすべてで行う
3. 新しい Worker のプロファイル一覧に新しい `roleArn` を書き、もう一度デプロイする
4. クライアントを切り替える前に、新しいロールを 1 回引き受けられることを確かめる: `AWSBRIDGE_ISSUER=<新しい URL> AWSBRIDGE_STACK_NAME=<新スタック> AWS_PROFILE=<対象> mise run poc:sts`（`AWSBRIDGE_KEY_FILE` の鍵で JWT に署名する。新しい URL の Worker と同じ鍵にする。デバッグロールは `--role-arn <DebugRoleArn>` を渡す）
5. MCP クライアントの接続先を新しい接続先の URL（`https://<接続先のホスト>/mcp`。「ホストを決める」のようにホストを分けると、issuer の URL とは別）に変える。接続先の URL と Access のアプリが新しくなるので、クライアント側の再設定と再認可が要ります
6. 両ロールで確かめる
7. 期限までに、すべてのアカウントで旧スタックを削除する（`AWSBRIDGE_STACK_NAME=<旧スタック> AWS_PROFILE=<対象> mise run destroy:aws`）。旧の OIDC プロバイダーとロールが消えます。すべてのアカウントで、IAM 上で消えたことを確かめる
8. すべてのアカウントで旧の OIDC プロバイダーが消えてから、旧 Worker を片付け、旧の issuer のホスト名（ドメイン、または workers.dev のサブドメイン）を手放す。逆の順にすると、手放したホスト名を第三者が取ったとき、残ったプロバイダーがそれを発行者として信頼してしまいます

この方法なら、切り替える前に旧と新を並べて確かめられます。別名の Worker を使わない場合は並行稼働になりません。Worker の `ISSUER` を新しい URL に移してからでないと新しいスタックを作れず、その後、新しいスタックと新しい `roleArn` をデプロイし終えるまで MCP の呼び出しは失敗します（旧ロールは Worker の JWT を受け付けなくなるため）。その方法を取るなら、切り戻しの手順（旧の `ISSUER` と旧の `roleArn` で Worker を再デプロイする。新しい側が動くまで旧スタックは残す）を先に用意してください。

## 開発

ランタイムとコマンドは [mise](https://mise.jdx.dev/) で管理します。`mise tasks` ですべてのタスクを一覧できます。

```
mise install            # ランタイムと道具（node・pnpm・cfn-lint・terraform・tflint・gitleaks）
mise run install        # 依存パッケージ（pnpm install）
mise run test           # Unit + E2E（test:unit / test:e2e。E2E は wrangler dev を起動して検証する）
mise run lint           # biome・型チェック・CloudFormation テンプレートの cfn-lint・Terraform サンプルの検査
mise run fmt            # フォーマット
mise run build          # MCP の Worker をデプロイせずにバンドルする
mise run dev            # MCP の Worker を手元で起動する
mise run secrets:scan   # gitleaks でコミットの履歴と作業ツリーを検査する
```

検証用: `poc:*` のタスクは実際の AWS か Cloudflare を呼ぶので、明示的に実行したときだけ使います（例 `mise run poc:sts`: MCP の鍵で署名した JWT で `AssumeRoleWithWebIdentity` を流し、正常 1 + 否定 4 ケースを確かめる）。
