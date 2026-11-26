# 本番でのコンソールログインの導入

[English](console-production-rollout.md) | 日本語

このページは、下流リポジトリの運用者に向けたものです（[上流と下流](../README_ja.md#上流と下流)）。コンソールログインを本番に入れる順序、段ごとの確認と期待値、本番のアカウントに Administrator のロールを入れる前のチェックリストを書きます。各操作のやり方は README にあります。このページは README へリンクし、何を確かめるか・どこで止めるかを足します。

コンソールログインは、Viewer と Administrator を、境界ごとに 1 つの Worker・1 つの issuer・1 つの署名鍵・1 つの OIDC プロバイダーで発行します。段 2 の前に [受容する限界](../README_ja.md#コンソールログインを使う前に受容する限界) を読み、受け入れてください。コンソールの Worker をデプロイできる者と、その secret・依存物に触れる者は、Administrator を配った全アカウントの全権を持ちます。

**段は期間ではなく順序で縛ります。** 前の段の確認がすべて期待値どおりになり、結果を記録するまで、次の段を始めません。

## このチェックリストの使い方

- どの確認も結果を記録します。時刻、実行した人、出力。デプロイのたびに、デプロイした Worker の version ID も記録します。コンソールの道具はアカウント ID と email を伏せますが、`aws` の生の出力は伏せません（例: `describe-organization` は管理アカウントの ID と email を出します）。ほかの人が読む記録に入れる前に、自分で伏せます。記録は下流リポジトリの private な場所に置き、上流には置きません。段 5 の判断はこの記録から行います。
- **止める決まり（すべての段）**: 確認が期待値にならなかったら、コンソールの Worker の vars `LOGIN_DISABLED` を `true` にしてデプロイし、発行が `503 login_disabled` になることを確かめてから調べます。Admin の階層だけに関わるとき（段 4 から）は、`ADMIN_LOGIN_DISABLED` を `true` にすると Admin の階層のチームだけが止まります。その発行が `503 login_disabled` になり、Viewer は動くことを確かめます。次の確認へ進みません。原因を直して確認をやり直し、期待値になってから続けます。段 0・1 ではまだ Worker がありません。そこで確認が通らなければ、片付くまで導入を止めるだけです。扱いは [コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail) の誤りのときと同じです。止める手段は [発行を止める](../README_ja.md#発行を止めるコンソールログイン) にあります。
- **Worker で止められないとき**: Worker をデプロイできない、`503 login_disabled` を確かめられない、Worker を信用できない（コード・secret・デプロイの権限・依存物が侵害されたかもしれない）ときは、停止スイッチを試し続けません。AWS の側に切り替えます。信頼ポリシーでの拒否、Administrator のスタックの削除、プロバイダーの削除（Viewer も止まる）です。発行済みのセッションには revoke（L3）を足します（[発行を Cloudflare に頼らずに止める](../README_ja.md#発行を-cloudflare-に頼らずに止めるl2-と信頼ポリシーの拒否)）。
- **省けない確認**: 階層をまたぐ拒否（Worker と AWS。段 4）、Administrator のロールを作った直後の確認（段 5）、`mise run console:inspect` と `mise run console:access:inspect` の誤り 0、停止スイッチの確認（`LOGIN_DISABLED` と `ADMIN_LOGIN_DISABLED` で `503 login_disabled`）。技術の判断者が決めても、確認をやり直して通るまでは先へ進みません。判断で持ち越せるのは、このページで未確認と書いた測定だけです（例: 試験用のプロバイダーを作れず、守りの文を測れないとき）。そのときは、理由・代わりの証拠・期限を記録します。
- `LOGIN_DISABLED` と `ADMIN_LOGIN_DISABLED` が止めるのは新しい発行だけです。発行済みのセッションと `aws login` は動き続けます。それも止めるなら revoke（L3）を足します。
- **コンソールの Worker をデプロイし、鍵の操作をすべて行うのは、最初のデプロイから、Administrator を発行してよい人です**（[受容 b](../README_ja.md#コンソールログインを使う前に受容する限界)）。Viewer だけを設定している間も同じです。その人が `console:key:put`・`console:secrets`・`console:key:retire` を自分の端末で実行し、そこからデプロイします。エージェント・CI・ほかの人の端末に任せません。
- 上流で測ったことは、仕組み（Worker・鍵・停止のふるまい）については有効です。環境に付くもの（アカウント・ゾーン・トークン・ホスト・デプロイした Worker）は、ここでやり直します。1 つの Worker の形の守りのいくつかは、この導入の段 4 で初めて測るので、**本番が測定の場になります**。導入を承認する人が、段 4 の前にこれを受容します。このページで「未確認」「推論」と書いたものは、この形では測っていません。

## 段 0: 上流の最新を取り込む

- [ ] 上流を取り込み、取り込んだ上流のコミット、下流の `HEAD`、作業ツリーがクリーンであること（`git status --porcelain` が何も出さない）を記録します。以降の結果はすべて、これらとデプロイした Worker の version ID についてのものです。導入の途中で取り込み直したら、新しいコミットを記録し、今の段の確認をやり直し、変わった部分に関わる前の段の確認もやり直します。
- [ ] そのコミットに、下の確認が頼るものが入っていること: 既定のデプロイの経路 `versions upload` + `versions deploy`（[Worker のデプロイの経路](../README_ja.md#worker-のデプロイの経路既定と明示)）。1 つのコンソールの Worker（`wrangler.console.jsonc`）と、鍵のタスク `console:key:put` / `console:key:check` / `console:key:retire`、vars `ADMIN_LOGIN_DISABLED` と `ADMIN_ACCESS_MAX_AGE_SECONDS`（[コンソールログインの署名鍵](../README_ja.md#コンソールログインの署名鍵)）。`--ledger-init` と `--ledger-baseline` を持つ退役したチーム名の台帳（[退役したチーム名の台帳](../README_ja.md#退役したチーム名の台帳)）。`assume_time_gap`・`identity_mismatch`・`identity_not_compared_admin`・`tier_mismatch`・`team_tier_mismatch` を誤りにし、`excluded assumes (not console)` と `admin issues` の行を出す照合。タスク `console:exposure-check`（[issuer の外からの確認](../README_ja.md#コンソールログインの-issuer-の外からの確認毎日)）。どれかが無ければ、その版で先へ進みません。
- [ ] 下流のコンソールの wrangler の設定（`wrangler.<name>-console.jsonc`）が `workers_dev` と `preview_urls` を `false` にし、2 つのホスト（ポータルと issuer）を Custom Domain で出していること（[ホスト](../README_ja.md#ホスト)）。

```bash
git pull --no-rebase upstream main
git rev-parse upstream/main          # このコミットを記録する（上流）
git rev-parse HEAD                   # このコミットを記録する（下流）
git status --porcelain               # 何も出ない: 作業ツリーがクリーン
mise tasks | grep console:           # console:key:check・console:reconcile・console:exposure-check が出る
```

## 段 1: 対象のアカウントを確かめる

コンソールログインを入れるアカウントごとに、コンソールのロール以外の主体の読み取り専用のプロファイルで行います。

- [ ] **Organization の管理アカウントでない。** 期待値: `aws organizations describe-organization` の `MasterAccountId` が、`aws sts get-caller-identity` の `Account` と違う（または Organization に入っていない）。`describe-organization` が権限不足で拒否されたら、別の方法（例: Organization の管理者に確かめる）で確かめ、確かめ方を記録します。管理アカウントなら止めます。そこにはコンソールログインを入れず、技術の判断者に上げます。
- [ ] **コンソールのロールと同じ名前のロールが無い。** 期待値: 設定にあるロール名（例 `FederatedAwsBridgeViewer`・`FederatedAwsBridgeAdministrator`）のどれも `aws iam get-role` が `NoSuchEntity`。パス `/awsbridge-console/` の下にロールが無い。あれば止めて、誰が作ったかを調べます。引き継いだり上書きしたりしません。
- [ ] **コンソールの OIDC プロバイダーがまだ無い。** `aws iam list-open-id-connect-providers` に、コンソールの issuer のホストのプロバイダーが無い。出力を前の状態として保存します（アカウント ID を含むので `.secrets/` に置き、公開リポジトリに入れません）。
- [ ] **MCP の中継に触らない。** MCP のスタック（`AWSBRIDGE_STACK_NAME`）の状態と、MCP のプロバイダーの ARN を控えます。コンソールのスタックは別の名前（`awsbridge-console-base`・`awsbridge-console-kind-<kind>`・Admin の階層のスタックの別の名前）で、MCP のスタックとプロバイダーを更新しません。以降の段のたびに、どちらも変わっていないことを確かめます。
- [ ] **残りものの確認。** `mise run poc:g2:clean-check` は、上流の試験環境のために書いた読み取りだけの道具です。期待値: 終了コード 0 で `NG` の行が無い。限界: プロバイダーのホストは決まった接頭辞（README の `awsbridge-console.`・`awsbridge-oidc-console.` と、以前の階層ごとのホストの `awsbridge-admin-console.`・`awsbridge-oidc-admin-console.`）でしか見分けないので、別のホスト名なら前の状態と目で比べます。見るスタックは `--stack` で渡したものだけです。Cloudflare の側は読み取りのトークンが無いと `SKIP` で、それでも終了コードは 0 です。

```bash
aws sts get-caller-identity --profile <読み取り専用のプロファイル>
aws organizations describe-organization --profile <読み取り専用のプロファイル>
aws iam get-role --role-name FederatedAwsBridgeViewer --profile <読み取り専用のプロファイル>          # NoSuchEntity
aws iam get-role --role-name FederatedAwsBridgeAdministrator --profile <読み取り専用のプロファイル>   # NoSuchEntity
aws iam list-roles --path-prefix /awsbridge-console/ --profile <読み取り専用のプロファイル>            # ロールなし
aws iam list-open-id-connect-providers --profile <読み取り専用のプロファイル> > .secrets/providers-before.json
mise run poc:g2:clean-check -- --profile <読み取り専用のプロファイル> --baseline .secrets/providers-before.json \
  --stack awsbridge-console-kind-default
```

## 段 2: コンソールの Worker と Viewer だけを入れる

[初回の順番（コンソールログイン）](../README_ja.md#初回の順番コンソールログイン) の 1〜7 に従い、コンソールの Worker を、Standard の階層と Viewer のロールで組みます。この段では、設定に Admin の階層のチームとロールを入れません。Worker は `LOGIN_DISABLED` を `"true"` にしてデプロイし、下の確認が通るまでそのままにします。

- 初回の生成には比べる台帳がありません。`mise run console:config:generate -- --ledger-init` を回し、回したことを記録します（標準出力に出て、`stacksets.json` の meta に `ledgerInit` として残ります）。生成した `stacksets.json` は、新しいチェックアウトで `--ledger-baseline` に渡す baseline として private な場所に保管します。
- [ ] 最初のデプロイの前に、対象のアカウントごとに `mise run console:inspect -- --profile=<p>`（`--ledger-init` のあとは必須）: 誤りは `role_missing` と `provider_missing` だけ（まだ何も配っていない）。`trust_team_retired`・`trust_team_tier`・`unlisted_role` が出たら、コンソールのロールがすでにあります。止めて、出どころを調べます。
- 初回のデプロイと Custom Domain の変更は、ゾーンの権限を持つ自分の短命のトークンで明示の経路を使い、終わったらトークンを捨てます（[Worker のデプロイの経路](../README_ja.md#worker-のデプロイの経路既定と明示)）。捨てる前に、そのトークンでコンソールの 2 つのホストに当たる Route が 0 本であることを 1 回確かめます。やり方は [issuer の外からの確認](../README_ja.md#コンソールログインの-issuer-の外からの確認毎日) と同じです（全ページ、ワイルドカードも数える。一覧が取れなければ 0 本とみなさない）。
- 日常のデプロイには「コンソールの Worker だけの Individual Workers Editor・ゾーン権限なし」のトークンを使い、上に書いた人が持ちます。作り方は [日常のデプロイ用のトークンの作り方](../README_ja.md#日常のデプロイ用のトークンの作り方) です。

### 最初の発行の前

`LOGIN_DISABLED` が `"true"` のままで:

- [ ] `mise run console:key:check`: `[NG]` が無い（バインディングが `secret_key`、discovery と JWKS が vars と合う、鍵を取り出せない、`exportKey` が失敗する、自己検証が通る）。`secret_key` でない、または `exportKey` が通るなら、止めて技術の判断者に上げます。
- [ ] `mise run console:access:inspect`: 誤り 0（入口のアプリとすべてのチームのアプリで Cookie Path が有効。[Access アプリ](../README_ja.md#コンソールログインの-access-アプリcookie-path)）。
- [ ] **workers.dev と Preview の URL が応答しない。** Worker の workers.dev の URL も Preview の URL も、Worker の応答（ポータルの画面・JSON・issuer の文書）を返さない。404 か Cloudflare のエラーの画面が期待値です。応答すれば Access を通らない入口になります。`workers_dev` / `preview_urls` を直して明示の経路でデプロイし、確かめ直します。
- [ ] **日常のトークンがコンソールの Worker に限られている。** そのトークンで、コンソールの 2 つのホスト（ポータルと issuer）それぞれに Worker の Route を足すことを 1 回ずつ試します（例: ゾーンの Workers Routes の API `/zones/{zone_id}/workers/routes` への `POST`）。期待値: すべて 403。どれかが通ったら、作られたものをすぐ消し、トークンの範囲の誤りとして扱い（消して作り直す）、確かめ直します。
- [ ] **既定の経路で設定が変わらない。** 意味のある変更なしに（例: デプロイのメッセージだけ）既定の経路で 1 回デプロイし、前後を比べます: vars・`secret_key` のバインディング・Custom Domain・Workers Logs（observability）の設定・`workers_dev` と `preview_urls`（どちらも `false` のまま）・`LOGIN_DISABLED` がどれも同じ。そのあと `mise run console:key:check` をもう一度: `[NG]` が無い。既定の経路のあとも鍵が残ることは、以前の階層ごとの Admin の Worker でしか測っていません。1 つのコンソールの Worker では推論で、ここが初めての確認です。
- [ ] `AWSBRIDGE_CONSOLE_LOGS_WORKERS` に、下流の wrangler の設定での名前で、コンソールの Worker の名前を書いている（既定は上流の名前 `awsbridge-console` で、自分の名前とは限りません）。下の最初の `--logs-api` での `console:reconcile` で、記録の読み込みが成功すること（`source: api`、終了コード 2 でない）を期待値にします。
- [ ] `mise run console:exposure-check`: 終了コード 0、すべての境界が `[OK]`。
- [ ] base のスタックとロールのスタックのあと: `mise run console:inspect -- --profile=<p>` が誤り 0、MCP のスタックとプロバイダーが変わっていない。

### 最初の発行の当日

`LOGIN_DISABLED` を `"false"` にしてデプロイし、時刻（T0）を記録します。ポータルから Viewer の発行を行い（使うなら `aws login` でも）、発行の回数を記録します。CloudTrail にイベントが出るまで待ちます。30 分は目安です（未確認）。道具は反映の遅れ（既定 300 秒、`--lag-seconds`）より新しい記録を `pending` として残すので、片付いていなければ待ってから回し直します。そのうえで同じ日に:

- [ ] **workers.dev と Preview の URL が応答しないことを取り直す。** `LOGIN_DISABLED` を `"false"` にしたデプロイのあとも、最初の発行の前と同じ確認で応答しない。

- [ ] 反映の遅れを記録する: 発行の時刻と、`console:reconcile` を回し直して、その引き受けが CloudTrail に初めて見えた時刻（段 5 の判断で、重なり `--overlap-seconds` を決める材料にします）。
- [ ] `console:reconcile`（下のコマンド）: 終了コード 0、`errors: 0`。`regions: read <n>/<n>` の 2 つの数が同じ。`unverifiable: 0, truncated lines: 0, unreadable lines: 0, pending: 0`（`pending` が 0 より多いと `matched` が発行の回数に届かない）。`matched` がコンソールの引き受けの数と発行の回数に等しい（`jti` が 1 対 1 で対になる）。`identity: compared <n>, not compared 0 (admin 0)`。`excluded assumes (not console)` が期待値（同じアカウントで MCP を使わないなら 0。使うなら MCP のロールだけであることを README のとおりに確かめる）。`coverage: first run (explicit --init)`。警告はすべて読みます。このアカウントで照合を回すのは初めてなので、下のコマンドは人が `--init` を付けて回します（状態の行が無いと `state_missing` で止まるため）。`pending` が残って回し直すときは `--init` を付けず、`coverage:` の期待値は、前の回が終了コード 0 なら `coverage: continuous`、誤りだったなら `coverage: unconfirmed` です。
- [ ] **要求ごとに `aud` が 1 つ。** 入口からも各チームのパスからもログインできる（Worker は `aud` が 1 つだけの Access の JWT を受け付ける）。入口のアプリのトークンで `/t/<team>/key-check` に送った要求は `403 unknown_audience`、ほかのチームのアプリのトークンで送った要求は `403 team_mismatch` で断られる（Access が先に断らなければ）。期待値: どちらも断られ、key-check の 200 の JSON を返さない。
- [ ] `mise run console:exposure-check`: 終了コード 0。

```bash
mise run console:reconcile -- --profile <p> --logs-api --since <T0 の 5 分前> --init
mise run console:exposure-check
```

## 段 3: 毎日の確認が誤りなしの日を 1 日以上

最初の発行の翌日から、[日々の運用](../README_ja.md#日々の運用) の 2 つの毎日の確認を回します。

- [ ] 最初の発行の日よりあとに、`console:reconcile` が終了コード 0・`errors: 0`・`excluded assumes (not console)` が期待値で、`console:exposure-check` が終了コード 0 の日が 1 日以上ある。
- 誤りが出たら、止める決まりと [コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail) の扱いに従います。除外の件数が期待値でなければ、そこに書いたとおりに調べます。誤りなしの日に数えるのは、原因が片付いてからです。
- 照合は `--since` を付けずに毎日回します。2 日目からは、読み始めが状態のファイルから決まります（確認済みの区間の終わり − 重なり。既定 24 時間）。出力の `read start:` の行が `from the state` であることを確かめます（未解決の所見がある間は `from the unresolved findings`）。古い区間を含む照会は間引かれて `record_read_incomplete` になることがあり、空けた日数が、間引かれずに読めると実測で確かめた期間を超えると、今の道具の読み方では、その間を完全に読めたことを確かめられません（その期間はまだ確かめていません）。終了コード 0 は、重なりの外に遅れて出た引き受けが無いことの証明ではありません。
- 終了コード 1 が出たら、その日のうちに所見（時刻・code・`jti` の先頭・ロール）を道具の外に記録します。道具は時刻を持つ所見を状態に残し（未解決の所見）、誤り 0 で読み直すか人が受け入れるまで、毎回そこまで読み戻します。所見を記録したときより `--clock-skew-seconds` や `--lag-seconds` を緩めても解決になりません（`unresolved_criteria_looser`）。所見の時刻が 6 日より前になると、受け入れるまで毎回 `unresolved_out_of_window` です（出力の `oldest error finding:` の行が、既定の窓から外れる時刻を出します）。原因が分かるまで `--overlap-seconds` と `--since` を変えず、状態のファイルを作り直しません。解決か受け入れを記録してから再開します。
- 誤りが続いて状態が進まず、窓が古くなって読めなくなったら、どの区間を検証できなかったかを記録し、保持の期限の内に証拠を残し、短い窓で読み直してから、人が判断します。再開は 2 つを分けます: 短い窓をすべて読み終えた**検証して再開**と、読めない区間を人が受け入れた**検証できないまま受け入れて再開**です。受け入れは人が `--accept-unresolved` と理由（`--reason`）を付けて回し（状態のファイルを手で作り直しません。受け入れた区間は状態に確認済みとは別に残ります）、あわせて受け入れの記録（アカウント・検証できなかった区間・未解決の所見・理由・判断した人と日時・状態のファイルの変更の前後）を道具の外に残します。受け入れた区間に遅れて現れた引き受けは誤りになりません。状態のファイルを黙って消しません（[コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail) の運用）。
- 状態のファイルを書ける者は、確認済みの区間を先へ進めて読み飛ばさせられます。照合を回す人だけが書ける場所に置きます。全部を読み直す監査には `--since 6d` を使います。照合を回すマシンを替えるときは状態のファイルをファイルごと移します。失ったときは、失ったもの（確認済みの区間と未解決の所見）を記録してから `--init` を打ちます。同じ状態のファイルで同時に回しません（道具はロックを取り、取れなければ終了コード 2）。受け入れは所見ではなく区間に対して行います。受け入れの実行に `--until` は付けられません（`--accept-unresolved`）。

## 段 4: 弱い Admin のロールで Admin の階層を入れる（Administrator なし）

[Admin の階層と Administrator を足す](../README_ja.md#admin-の階層と-administrator-を足す) のとおりに、Admin の階層のチームを 1 つと、弱い Admin の階層のロールを 1 つ足し、1 回発行します。**この段では Administrator のロールを作りません。** 弱いロールは Admin の階層のロール（パス `/awsbridge-console/admin/`、`MaxSessionDuration` は 1 時間、Admin の守りの部品、Admin の階層のチームだけの信頼ポリシー。参考のテンプレートが作る形）で、権限は `ReadOnlyAccess`（`managedPolicyArns` に書く）と、下の守りの文の試験に要る Allow だけ（試験用のプロバイダーに限る。`inlinePolicyFiles` で渡すポリシー文書）です。

- Admin の階層のチームには、Standard のチームが使っておらず台帳にもない新しい名前を付け、セッションの短い（`admin_session_duration`。既定 15 分）・Cookie Path を有効にした Access のアプリを作り、チームと弱いロールを設定に足して生成し直します（新しいチェックアウトなら、保管した `stacksets.json` を `--ledger-baseline` で渡します）。
- 弱いロールは、名前が `awsbridge-console-kind-<kind>` に当たらない**別スタック**で作ります。Viewer のスタックではその `<Role>Teams` のパラメーターを空のままにし、どのスタックでも `AdministratorTeams` は空のままにし、Viewer のスタックを更新するたびに change set を見ます。
- Administrator を発行してよい人が既定の経路で Worker をデプロイし、`mise run console:key:check` をもう一度回します: `[NG]` が無い。`--team <team>`（Admin の階層のチーム）を付けると、Admin の階層のチームのパスでも key-check を開きます。
- 最初の Admin の階層の発行の前に: `mise run console:access:inspect` が誤り 0（Admin の階層のアプリも含めて）、`mise run console:inspect -- --profile=<p>` が誤り 0（`trust_team_tier` も `trust_team_retired` も無い）。
- **`ADMIN_LOGIN_DISABLED` の前後の順**: (1) `ADMIN_LOGIN_DISABLED` を `"true"` にして Admin の階層のチームをデプロイし、すぐ上の確認を回し、Admin の階層のチームのパスのログインが `503 login_disabled` になることを確かめる。(2) `"false"` にしてデプロイし、時刻と Worker の version ID を記録する。(3) 下の確認を回し、それぞれの時刻と成功した Admin の階層の発行の数を記録する。(4) 失敗したら `"true"` に戻してデプロイし、`503 login_disabled` を確かめてから調べる。

確認（Admin の階層だけに関わる外れは `ADMIN_LOGIN_DISABLED` で、それ以外は `LOGIN_DISABLED` で止め、技術の判断者に上げます）:

- [ ] **Worker での階層をまたぐ拒否。** 本物の Worker と Access で: 弱いロールへのログインを Standard のチームのパスに送ると `404 not_listed`。Standard のチームのアプリのトークンで Admin の階層のチームのパスに送ると `403 team_mismatch`（Access が先に断ることもある）。入口のアプリのトークンで送ると `403 unknown_audience`。期待値: どれも STS を呼ばない（照合に対応する引き受けが出ない）。
- [ ] **AWS での階層をまたぐ拒否。** 先に操作の一覧を人に見せて承認を取ります。コンソールのロール以外の主体で、弱いロールの信頼ポリシーのチームの値（`aws:RequestTag/awsbridge_team`）を、どのチームでもない名前に変え（`aws iam update-assume-role-policy`）、Admin の階層のチームから本物の Worker で弱いロールを発行し、`sts_denied` を期待値にします。そのあと API で信頼ポリシーを戻し、`aws iam get-role` で戻ったことを確かめ、1 回発行して成功を期待値にし、ドリフト検出でスタックに差が無いことを確かめます。ほかの場合（チームのタグの無い JWT など）は、この形では未確認です。前と同じに振る舞うことは、IAM が issuer に関係なく同じように信頼ポリシーを評価することからの推論です。
- [ ] **1 つのホストにした守りの文。** 試験用のプロバイダーの作成と削除を人に承認してもらいます。コンソールのロール以外の主体で、issuer のホストの下に試験用のプロバイダー（例 `https://<issuer-host>/probe`）を作ります。鍵が無く、JWKS が 404 で、どのロールにも信頼させないものにします。弱いロールのセッションから、試験用のプロバイダーに `TagOpenIDConnectProvider`・`AddClientIDToOpenIDConnectProvider`・`DeleteOpenIDConnectProvider` を、同じホストの別のパスに `CreateOpenIDConnectProvider` を試します。期待値: どれも `AwsbridgeConsoleGuardAdmin` を名指す明示の Deny での `AccessDenied`。本物のプロバイダー（Viewer も使う）には当てません。弱いロールに Allow が無いと暗黙の拒否になり、何も示しません。終わったら試験用のプロバイダーを消します。試験用のプロバイダーを作れなければ、守りの文は未確認と記録し、理由・代わりの証拠・期限を添えます。以前の階層ごとの形での測定を、その裏付けに数えません。
- [ ] **鍵の差し替えを 1 回。** [鍵の差し替え](../README_ja.md#鍵の差し替え) のとおりに、境界の鍵を 1 回差し替えます（新しい鍵を JWKS に並べ、それで署名し、旧い kid を外す）。期待値: Viewer と弱いロールの発行が途切れず、旧い kid を外したあと `mise run console:key:check` に `[NG]` が無い。鍵は共通なので、Viewer にも効きます。
- [ ] **Admin の階層のチームに許されていない人。** 別の身元で、Admin の階層のチームの Access のアプリが断る。その人の Standard のチームのアプリのトークンでは、Worker が Admin の階層のパスを `403 team_mismatch` で断る。Admin の階層のアプリの設定を誤ってその人を通したときは、Worker では断れません（JWT が Admin の階層の AUD を持つため）。そこでの守りは Access のポリシーだけです。
- [ ] **照合に Admin の階層として出る。** 決めた窓（`--since`）で、`mise run console:reconcile` が `errors: 0`、`admin issues: <n>` の `<n>` がその窓で記録した成功した Admin の階層の発行の数に等しく、それぞれが記録した時刻にあり、identity の行が `admin 0`。
- [ ] **Admin の階層の Access のアプリを人が見る。** `mise run console:access:inspect` の誤り 0 は、ポリシーが誰を許すか（include・require・exclude の規則）、セッションの長さ、同じパスを覆うほかのアプリ・Allow のポリシー・Bypass の規則を確かめません。Admin の階層のアプリと、Admin の階層のチームの `/t/<team>` を覆うほかのものすべてのポリシーとセッションの設定を読み、記録します。
- [ ] **経過時間の上限。** `ADMIN_ACCESS_MAX_AGE_SECONDS`（既定 15 分）より古い Access JWT での、Admin の階層のチームのパスの画面とログインが 401 で断られる。あわせて、Access がセッションの中で再認証なしに新しい JWT を出すか、Access のセッションが切れたあと IdP が画面なしでまた入れるかを記録します（未確認。上限の読み方を決めます）。
- [ ] **`ADMIN_LOGIN_DISABLED`。** `true` にすると、Admin の階層のチームのパスのログインが `503 login_disabled` になり、Viewer のログインは通る。そのあと戻します。
- [ ] **ログに残るもの。** プラットフォームが Workers Logs に書く呼び出しの記録を 1 件読みます。期待値: 要求のヘッダー `Cf-Access-Jwt-Assertion`・要求の本文・リダイレクトの `Location` が入っていない。入っていれば、記録の範囲を絞るか、ログの閲覧を受容する限界に数えます。
- [ ] CloudTrail の `AssumeRoleWithWebIdentity` のイベントにセッションタグが出るかを記録します（読むだけ。照合は使いません）。
- [ ] ここまでのあと `mise run console:inspect -- --profile=<p>` が誤り 0。`mise run console:exposure-check` が終了コード 0。毎日の確認が誤りなしのまま、`admin issues` に自分のしていない発行が無く、MCP のスタックとプロバイダーが変わっていない。

## 停止の訓練（段 5 の前）

段 5 の判断の前に 1 回行います。どの停止も、固定の時間を待って完了にせず、要求が断られたことを確かめて完了にします（[発行を止める](../README_ja.md#発行を止めるコンソールログイン)）。

- [ ] **Viewer。** 停止スイッチ: `LOGIN_DISABLED` を `true` にすると発行が `503 login_disabled` になる。そのあと戻す。1 人停止: 自分の SourceIdentity で `mise run console:stop:apply` を行うと、自分の Viewer のセッションの要求が通らなくなる（[1 人停止](../README_ja.md#コンソールログインの-1-人停止)）。書き込むには `--stops`・`--reason`・`--yes` が要り、コンソールのロールのセッションからではなく別の入口（IAM Identity Center など）から流します。Viewer のロールの revoke（L3）で、それより前に発行したセッションが断られる。1 人停止の解除は解除の条件（少なくともロールの `MaxSessionDuration`）を待つので、訓練は 2 日にまたがる前提で組みます。
- [ ] **Admin の階層だけを止める。** 段 4 と同じ `ADMIN_LOGIN_DISABLED` と、弱いロールの信頼ポリシーでの Deny（[ロールの信頼ポリシーでの拒否](../README_ja.md#ロールの信頼ポリシーでの拒否)）: 弱いロールの発行が `sts_denied` で失敗し、Viewer は動き続ける。手で戻し、1 回発行してドリフト検出で確かめます。Admin の階層だけを止めるプロバイダーの削除はありません（[発行を Cloudflare に頼らずに止める](../README_ja.md#発行を-cloudflare-に頼らずに止めるl2-と信頼ポリシーの拒否)）。訓練のために本番でプロバイダーを消しません。
- [ ] **Administrator の棚卸し。** [Administrator の残った権限の棚卸し](../README_ja.md#コンソールログインの-administrator-の残った権限の棚卸し) の 2〜4（プロバイダー・CloudTrail・IAM の一覧）を 1 回行います。Administrator のロールはまだ無いので、その節の 1 は飛ばします。一覧は、Administrator を使ったあとに比べる前の状態として残します（アカウント ID を含むので公開リポジトリに入れません）。IAM の外の今のリソースポリシー（例: 使っているサービスの S3・KMS・Lambda）も、その基準として取ります。自分の Viewer のセッションで行った操作のイベントに `sourceIdentity` が出るかを確かめます。出なければ、README のとおり、イベントの拾い方を変える必要があります。

## 段 5: Administrator を入れる前の判断

**ここで止まります。** 結果を技術の判断者に出し直し、技術の承認を取ります。本番のアカウントに Administrator のロールを入れるには、それに加えて、記録をもとにした人の承認が要ります。技術の判断者のレビューはその代わりになりません。

### 判断に要るもの

- [ ] 段 0〜4 と訓練の結果。それぞれの期待値と、外れたものをどう片付けたか、未確認のまま残るものは何か。
- [ ] CloudTrail の反映の遅れの実測: 段 2 からの発行で記録した遅れの分布と観測した期間、重なり `--overlap-seconds` をそれに対してどう決めたか、重なりの外の遅れをどこまで受け入れるか。有限の観測では最大の遅れを保証できず、照合の終了コード 0 は重なりの外の遅れが無いことの証明ではありません。
- [ ] アカウントと Organization の関係: アカウントがどの Organization に属するか、管理アカウントでないこと、Organization を管理するのは誰か、そのアカウントに効く統制（SCP など）。
- [ ] 署名の鍵の置き場所: コンソールの Worker とその `secret_key` のバインディングを持つ Cloudflare のアカウント、コンソールの Worker（コード・vars・secrets・依存物）を変えられる人、コンソールのホストのゾーン（DNS・Route・Custom Domain）を変えられるトークンを持つ人。この一覧の誰でも、Viewer しか扱わない人でも、Administrator の JWT に署名するか issuer を差し替えられます。
- [ ] 受容した限界を、承認する人が読んで受容していること: [受容 a〜e](../README_ja.md#コンソールログインを使う前に受容する限界)。発行記録はコンソールの Worker 自身が書くので、コンソールの Worker に書ける者（Viewer だけを扱う人を含む）に対しては照合は独立の検知ではない（[コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail)）。ゾーンの設定の見張りはゾーンの持ち主の運用で、外からの比較は検知であって予防ではない（[issuer の外からの確認](../README_ja.md#コンソールログインの-issuer-の外からの確認毎日)）。退役したチーム名の台帳は取り違えへの守りで、設定を書ける者への守りではない。
- [ ] 承認そのもの。日付と、段 0 のコミットを添えて。

### 承認のあと: Administrator のスタック

まず `ADMIN_LOGIN_DISABLED` を `"true"` にしてデプロイし、Admin の階層のチームのパスのログインが `503 login_disabled` になることを確かめます。作成の直後の確認（下）がすべて通るまでそのままにします。そのあと設定に Administrator を（Admin の階層のチームに割り当てて）足し、生成し直し、Worker をデプロイし、[Admin の階層と Administrator を足す](../README_ja.md#admin-の階層と-administrator-を足す) のとおりに Administrator のロールを作ります:

- [ ] 生成し直してからスタックを作るまでは、`mise run console:inspect` が Administrator のロールの `role_missing` を出します。期待する誤りはそれだけです。
- [ ] **別スタック**で、名前が `awsbridge-console-kind-<kind>` の型に当たらない（例 `awsbridge-console-admin-default`）。`AdministratorTeams` だけを設定する。
- [ ] 作成の change set が **`AdministratorRole` の `Add` だけ**。そうでなければ実行しません。
- [ ] 作成の直後、最初の発行の前に: `aws iam get-role` の信頼ポリシーがコンソールのプロバイダーを名指し、チームの条件が Admin の階層のチームだけ。`aws iam list-attached-role-policies` に Admin の守りの部品が付いている。そうでなければ中断します（下）。
- [ ] 作成の直後に `mise run console:inspect -- --profile=<p>`: 誤り 0（`role_missing` が消え、`trust_team_tier` も無い）。
- [ ] Viewer のスタック（例 `awsbridge-console-kind-default`）の `AdministratorTeams` は空のまま。更新の前に毎回 change set を見て、`AdministratorRole` が出たら実行しません。
- [ ] 上の確認がすべて通ったあと: `ADMIN_LOGIN_DISABLED` を `"false"` にしてデプロイし、時刻と Worker の version ID を記録し、最初の Administrator の発行を確かめる。失敗したら `"true"` に戻してデプロイする。
- [ ] 最初の Administrator の発行のあと、同じ日に: その時刻からの窓で、`console:reconcile` が `errors: 0`、`admin issues: <n>` がその窓で記録した成功した Admin の階層の発行の数に等しく、identity の行が `admin 0`。`console:exposure-check` が終了コード 0。
- [ ] 最初の Administrator の発行を確かめてから、弱いロール（そのスタックと、設定のロール）を消し、生成し直して Worker をデプロイし、`mise run console:inspect` をもう一度回します。
- 中断するとき: **Administrator のスタックを消し、かつ設定から Administrator を外して生成し直します**（生成物とポータルの一覧に Administrator を残さないため）。そのあと Worker をデプロイし、ポータルに Administrator が出なくなったことを確かめます。
- Cloudflare に頼らずに Administrator の引き受けを止めるには: [ロールの信頼ポリシーでの拒否](../README_ja.md#ロールの信頼ポリシーでの拒否) か、Administrator のスタックの削除。プロバイダーの削除は Viewer も止めます（[発行を Cloudflare に頼らずに止める](../README_ja.md#発行を-cloudflare-に頼らずに止めるl2-と信頼ポリシーの拒否)）。信頼ポリシーの Deny を入れている間はスタックを更新しません。信頼ポリシーが変わる更新で Deny が消えるかは、測っていません。
