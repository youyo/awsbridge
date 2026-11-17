# 本番でのコンソールログインの導入

[English](console-production-rollout.md) | 日本語

このページは、下流リポジトリの運用者に向けたものです（[上流と下流](../README_ja.md#上流と下流)）。コンソールログインを本番に入れる順序、段ごとの確認と期待値、本番のアカウントに Administrator のロールを入れる前のチェックリストを書きます。各操作のやり方は README にあります。このページは README へリンクし、何を確かめるか・どこで止めるかを足します。

**段は期間ではなく順序で縛ります。** 前の段の確認がすべて期待値どおりになり、結果を記録するまで、次の段を始めません。

## このチェックリストの使い方

- どの確認も結果を記録します。時刻、実行した人、出力。コンソールの道具はアカウント ID と email を伏せますが、`aws` の生の出力は伏せません（例: `describe-organization` は管理アカウントの ID と email を出します）。ほかの人が読む記録に入れる前に、自分で伏せます。記録は下流リポジトリの private な場所に置き、上流には置きません。段 5 の判断はこの記録から行います。
- **止める決まり（すべての段）**: 確認が期待値にならなかったら、その Worker の vars `LOGIN_DISABLED` を `true` にしてデプロイし、発行が `503 login_disabled` になることを確かめてから調べます。次の確認へ進みません。原因を直して確認をやり直し、期待値になってから（または技術の判断者が決めてから）続けます。段 0・1 ではまだ Worker がありません。そこで確認が通らなければ、片付くまで導入を止めるだけです。扱いは [コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail) の誤りのときと同じです。止める手段は [発行を止める](../README_ja.md#発行を止めるコンソールログイン) にあります。
- `LOGIN_DISABLED` が止めるのは新しい発行だけです。発行済みのセッションと `aws login` は動き続けます。それも止めるなら revoke（L3）を足します。
- **鍵の操作は、人が自分の端末で行います**: `console:standard-key:put`・`console:admin-key:put`・`console:secrets:standard`・`console:secrets:admin`・`retire` のタスク。エージェント・CI・ほかの人の端末に任せません。Admin の Worker のデプロイも同じ人が行います。
- 上流で測ったことは、仕組み（Worker・鍵・停止のふるまい）については有効です。環境に付くもの（アカウント・ゾーン・トークン・ホスト・デプロイした Worker）は、ここでやり直します。

## 段 0: 上流の最新を取り込む

- [ ] 上流を取り込み、取り込んだコミットを記録します。以降の結果はすべてこのコミットについてのものです。導入の途中で取り込み直したら、新しいコミットを記録し、今の段の確認をやり直します。
- [ ] そのコミットに、下の確認が頼るものが入っていること: 既定のデプロイの経路 `versions upload` + `versions deploy`（[Worker のデプロイの経路](../README_ja.md#worker-のデプロイの経路既定と明示)）、`assume_time_gap`・`identity_mismatch`・`identity_not_compared_admin` を誤りにし、`excluded assumes (not console)` と `admin issues` の行を出す照合、タスク `console:exposure-check`（[issuer の外からの確認](../README_ja.md#コンソールログインの-issuer-の外からの確認毎日)）。どれかが無ければ、その版で先へ進みません。
- [ ] 下流のコンソールの wrangler の設定（`wrangler.<name>-console.jsonc`・`wrangler.<name>-console-admin.jsonc`）が `workers_dev` と `preview_urls` を `false` にし、ホストを Custom Domain で出していること（[ホスト](../README_ja.md#ホスト)）。

```bash
git pull --no-rebase upstream main
git rev-parse upstream/main          # このコミットを記録する
mise tasks | grep console:           # console:reconcile と console:exposure-check が出る
```

## 段 1: 対象のアカウントを確かめる

コンソールログインを入れるアカウントごとに、コンソールのロール以外の主体の読み取り専用のプロファイルで行います。

- [ ] **Organization の管理アカウントでない。** 期待値: `aws organizations describe-organization` の `MasterAccountId` が、`aws sts get-caller-identity` の `Account` と違う（または Organization に入っていない）。`describe-organization` が権限不足で拒否されたら、別の方法（例: Organization の管理者に確かめる）で確かめ、確かめ方を記録します。管理アカウントなら止めます。そこにはコンソールログインを入れず、技術の判断者に上げます。
- [ ] **コンソールのロールと同じ名前のロールが無い。** 期待値: 設定にあるロール名（例 `FederatedAwsBridgeViewer`・`FederatedAwsBridgeAdministrator`）のどれも `aws iam get-role` が `NoSuchEntity`。パス `/awsbridge-console/` の下にロールが無い。あれば止めて、誰が作ったかを調べます。引き継いだり上書きしたりしません。
- [ ] **コンソールの OIDC プロバイダーがまだ無い。** `aws iam list-open-id-connect-providers` に、コンソールの issuer のホストのプロバイダーが無い。出力を前の状態として保存します（アカウント ID を含むので `.secrets/` に置き、公開リポジトリに入れません）。
- [ ] **MCP の中継に触らない。** MCP のスタック（`AWSBRIDGE_STACK_NAME`）の状態と、MCP のプロバイダーの ARN を控えます。コンソールのスタックは別の名前（`awsbridge-console-base`・`awsbridge-console-kind-<kind>`・Administrator のスタックの別の名前）で、MCP のスタックとプロバイダーを更新しません。以降の段のたびに、どちらも変わっていないことを確かめます。
- [ ] **残りものの確認。** `mise run poc:g2:clean-check` は、上流の試験環境のために書いた読み取りだけの道具です。期待値: 終了コード 0 で `NG` の行が無い。限界: プロバイダーのホストは README の例の接頭辞（`awsbridge-console.`・`awsbridge-oidc-console.`・`awsbridge-admin-console.`・`awsbridge-oidc-admin-console.`）でしか見分けないので、別のホスト名なら前の状態と目で比べます。見るスタックは `--stack` で渡したものだけです。Cloudflare の側は読み取りのトークンが無いと `SKIP` で、それでも終了コードは 0 です。

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

## 段 2: Standard と Viewer だけを入れる

[初回の順番（コンソールログイン）](../README_ja.md#初回の順番コンソールログイン) の 1〜6 に従い、Standard の階層と Viewer のロールを組みます。この段では、設定に Admin の階層のチームと Administrator のロールを入れず、Admin のものは何もデプロイせず、base のスタックに `AdminIssuerHost` を渡しません。Standard の Worker は `LOGIN_DISABLED` を `"true"` にしてデプロイし、下の確認が通るまでそのままにします。

- 初回のデプロイと Custom Domain の変更は、ゾーンの権限を持つ自分の短命のトークンで明示の経路を使い、終わったらトークンを捨てます（[Worker のデプロイの経路](../README_ja.md#worker-のデプロイの経路既定と明示)）。捨てる前に、そのトークンで 4 つのホストに当たる Route が 0 本であることを 1 回確かめます。やり方は [issuer の外からの確認](../README_ja.md#コンソールログインの-issuer-の外からの確認毎日) と同じです（全ページ、ワイルドカードも数える。一覧が取れなければ 0 本とみなさない）。
- Standard の Worker の日常のデプロイには「Standard の Worker だけの Individual Workers Editor・ゾーン権限なし」のトークンを使います。Admin の Worker のトークンは段 4 で別に作ります。

### 最初の発行の前

`LOGIN_DISABLED` が `"true"` のままで:

- [ ] `mise run console:standard-key:check`: `[NG]` が無い（バインディングが `secret_key`、discovery と JWKS が vars と合う、鍵を取り出せない、`exportKey` が失敗する、自己検証が通る）。`secret_key` でない、または `exportKey` が通るなら、止めて技術の判断者に上げます。
- [ ] `mise run console:access:inspect`: 誤り 0（入口のアプリとすべてのチームのアプリで Cookie Path が有効。[Access アプリ](../README_ja.md#コンソールログインの-access-アプリcookie-path)）。
- [ ] **workers.dev と Preview の URL が応答しない。** Worker の workers.dev の URL も Preview の URL も、Worker の応答（ポータルの画面・JSON・issuer の文書）を返さない。404 か Cloudflare のエラーの画面が期待値です。応答すれば Access を通らない入口になります。`workers_dev` / `preview_urls` を直して明示の経路でデプロイし、確かめ直します。
- [ ] **日常のトークンが Standard の Worker に限られている。** そのトークンで、4 つのホスト（Standard と Admin の、ポータルと issuer。Admin のホストがまだ無くても）それぞれに Worker の Route を足すことを 1 回ずつ試します（例: ゾーンの Workers Routes の API `/zones/{zone_id}/workers/routes` への `POST`）。期待値: すべて 403。Admin の Worker がすでにあるなら、このトークンで Admin の Worker への書き込みも 1 回試します（例: Admin の wrangler の設定での `wrangler versions upload`）: 403。どれかが通ったら、作られたものをすぐ消し、トークンの範囲の誤りとして扱い（消して作り直す）、確かめ直します。
- [ ] **既定の経路で設定が変わらない。** 意味のある変更なしに（例: デプロイのメッセージだけ）既定の経路で 1 回デプロイし、前後を比べます: vars・`secret_key` のバインディング・Custom Domain・Workers Logs（observability）の設定・`workers_dev` と `preview_urls`（どちらも `false` のまま）・`LOGIN_DISABLED` がどれも同じ。そのあと `mise run console:standard-key:check` をもう一度: `[NG]` が無い。Standard の鍵が既定の経路のあとも残ることを確かめるのはここが初めてです。上流では Admin の Worker でしか測っていません。
- [ ] `AWSBRIDGE_CONSOLE_LOGS_WORKERS` に、下流の wrangler の設定での名前で、コンソールの Worker を 2 つとも書いている（既定は上流の名前で、自分の名前ではありません）。Admin の Worker ができる前に Admin の名前を書いても害は無い見込みです（照会は Worker の名前で絞り込む）が、確かめていません。下の最初の `--logs-api` での `console:reconcile` で、記録の読み込みが成功すること（`source: api`、終了コード 2 でない）を期待値にします。
- [ ] `mise run console:exposure-check`: 終了コード 0、Standard の境界がすべて `[OK]`。Admin を飛ばした旨が出ます（`worker.admin.json` が無い）。それが期待値なのはこの段だけです。
- [ ] base のスタックとロールのスタックのあと: `mise run console:inspect -- --profile=<p>` が誤り 0、MCP のスタックとプロバイダーが変わっていない。

### 最初の発行の当日

`LOGIN_DISABLED` を `"false"` にしてデプロイし、時刻（T0）を記録します。ポータルから Viewer の発行を行い（使うなら `aws login` でも）、発行の回数を記録します。CloudTrail にイベントが出るまで待ちます。30 分は目安です。道具は反映の遅れ（既定 300 秒、`--lag-seconds`）より新しい記録を `pending` として残すので、片付いていなければ待ってから回し直します。そのうえで同じ日に:

- [ ] **workers.dev と Preview の URL が応答しないことを取り直す。** `LOGIN_DISABLED` を `"false"` にしたデプロイのあとも、最初の発行の前と同じ確認で応答しない。

- [ ] `console:reconcile`（下のコマンド）: 終了コード 0、`errors: 0`。`regions: read <n>/<n>` の 2 つの数が同じ。`unverifiable: 0, truncated lines: 0, unreadable lines: 0, pending: 0`（`pending` が 0 より多いと `matched` が発行の回数に届かない）。`matched` がコンソールの引き受けの数と発行の回数に等しい（`jti` が 1 対 1 で対になる）。`identity: compared <n>, not compared 0 (admin 0)`。`excluded assumes (not console)` が期待値（同じアカウントで MCP を使わないなら 0。使うなら MCP のロールだけであることを README のとおりに確かめる）。`coverage: first run`。警告はすべて読みます。
- [ ] **要求ごとに `aud` が 1 つ。** 入口からも各チームのパスからもログインできる（Worker は `aud` が 1 つだけの Access の JWT を受け付ける）。入口のアプリのトークンで `/t/<team>/key-check` に送った要求は `403 unknown_audience`、ほかのチームのアプリのトークンで送った要求は `403 team_mismatch` で断られる（Access が先に断らなければ）。期待値: どちらも断られ、key-check の 200 の JSON を返さない。
- [ ] `mise run console:exposure-check`: 終了コード 0。

```bash
mise run console:reconcile -- --profile <p> --logs-api --since <T0 の 5 分前>
mise run console:exposure-check
```

## 段 3: 毎日の確認が誤りなしの日を 1 日以上

最初の発行の翌日から、[日々の運用](../README_ja.md#日々の運用) の 2 つの毎日の確認を回します。

- [ ] 最初の発行の日よりあとに、`console:reconcile` が終了コード 0・`errors: 0`・`excluded assumes (not console)` が期待値で、`console:exposure-check` が終了コード 0 の日が 1 日以上ある。
- 誤りが出たら、止める決まりと [コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail) の扱いに従います。除外の件数が期待値でなければ、そこに書いたとおりに調べます。誤りなしの日に数えるのは、原因が片付いてからです。

## 段 4: Admin の Worker とプロバイダーを、Administrator のロールなしで入れる

[コンソールログインの Admin の署名鍵](../README_ja.md#コンソールログインの-admin-の署名鍵) の初回のデプロイの順の 1〜5 と、6 のうちプロバイダーだけ（base のスタックに `AdminIssuerHost` を渡す）を行います。**この段では Administrator のロールを作りません。**

- 設定に Admin の階層のチームと Administrator のロールを足し、種類でそのチームに Administrator を割り当てて（`assign`）生成し直します（`worker.admin.json` ができます）。その `assign` のため、生成した `stacksets.json` では、種類の `AdministratorTeams` が空でなくなります。**それを Viewer のスタックに渡しません**。そちらの `AdministratorTeams` は空のままにし、そのスタックを更新するたびに change set を見て、`AdministratorRole` が出たら実行しません。
- Standard の Worker の一覧に Admin の行が出るようになるので、既定の経路でデプロイし直し、`mise run console:standard-key:check` をもう一度回します。
- 鍵の操作をする人が、Admin のデプロイのトークン（「Admin の Worker だけの Individual Workers Editor・ゾーン権限なし」。Standard のトークンとは別）を作って持ち、自分の端末から Admin の Worker をデプロイします。

確認:

- [ ] `mise run console:admin-key:check`: `[NG]` が無い。`secret_key` でない、または `exportKey` が通るなら、止めて技術の判断者に上げます。
- [ ] Admin の Worker の workers.dev と Preview の URL が応答しない（段 2 と同じ）。Admin の issuer が discovery と JWKS を出している（Access がそのホストを覆うなら、その 2 つのパスに Access の Bypass）。
- [ ] `mise run console:access:inspect`: 誤り 0。Admin のアプリも含めて。
- [ ] **階層の間の `aud`。** Standard のチームのアプリのトークンで Admin のチームの `/t/<team>/key-check` が開かず、Admin のチームのアプリのトークンで Standard のチームのものが開かない。断るのは Access か Worker（`403 unknown_audience`）で、どちらの向きも 200 の JSON が返らない。
- [ ] **日常のトークンが 2 つとも限られている。** Admin のトークンで、Standard の Worker への書き込み 1 回と、4 つのホストそれぞれへの Route の追加が 403。Standard のトークンで、Admin の Worker への書き込み 1 回が 403（今はある）。通ったときの扱いは段 2 と同じです。
- [ ] **既定の経路で Admin の設定が変わらない。** 段 2 と同じ前後の比較を Admin の Worker で行い、`mise run console:admin-key:check` をもう一度: `[NG]` が無い。
- [ ] `AWSBRIDGE_CONSOLE_LOGS_WORKERS` に Admin の Worker が入っていて、`mise run console:exposure-check` が終了コード 0、Admin の issuer が `[OK]`（もう飛ばされない）。
- [ ] `mise run console:inspect -- --profile=<p>`: Admin のプロバイダーがある（`provider_missing` が無い）。期待する誤りは Administrator のロールの `role_missing` だけです（ロールは段 5 で作ります）。道具が守りの部品を見るのは存在するロールについてだけなので、Administrator のロールに付く Admin の守りの部品はここではなく段 5 で確かめます。
- [ ] 毎日の確認が誤りなしのまま、`admin issues` に自分のしていない発行が無い。MCP のスタックとプロバイダーが変わっていない。

## 停止の訓練（段 5 の前）

段 5 の判断の前に 1 回行います。どの停止も、固定の時間を待って完了にせず、要求が断られたことを確かめて完了にします（[発行を止める](../README_ja.md#発行を止めるコンソールログイン)）。

- [ ] **Viewer。** 停止スイッチ: Standard の Worker の `LOGIN_DISABLED` を `true` にすると発行が `503 login_disabled` になる。そのあと戻す。1 人停止: 自分の SourceIdentity で `mise run console:stop:apply` を行うと、自分の Viewer のセッションの要求が通らなくなる（[1 人停止](../README_ja.md#コンソールログインの-1-人停止)）。書き込むには `--stops`・`--reason`・`--yes` が要り、コンソールのロールのセッションからではなく別の入口（IAM Identity Center など）から流します。Viewer のロールの revoke（L3）で、それより前に発行したセッションが断られる。1 人停止の解除は解除の条件（少なくともロールの `MaxSessionDuration`）を待つので、訓練は 2 日にまたがる前提で組みます。
- [ ] **Administrator の棚卸し。** [Administrator の残った権限の棚卸し](../README_ja.md#コンソールログインの-administrator-の残った権限の棚卸し) の 2〜4（プロバイダー・CloudTrail・IAM の一覧）を 1 回行います。Administrator のロールはまだ無いので、その節の 1 は飛ばします。一覧は、Administrator を使ったあとに比べる前の状態として残します（アカウント ID を含むので公開リポジトリに入れません）。自分の Viewer のセッションで行った操作のイベントに `sourceIdentity` が出るかを確かめます。出なければ、README のとおり、イベントの拾い方を変える必要があります。

## 段 5: Administrator を入れる前の判断

**ここで止まります。** 本番のアカウントに Administrator のロールを入れるには、記録をもとにした人の承認が要ります。技術の判断者のレビューはその代わりになりません。

### 判断に要るもの

- [ ] 段 0〜4 と訓練の結果。それぞれの期待値と、外れたものをどう片付けたか。
- [ ] アカウントと Organization の関係: アカウントがどの Organization に属するか、管理アカウントでないこと、Organization を管理するのは誰か、そのアカウントに効く統制（SCP など）。
- [ ] 署名の鍵の置き場所: Admin の Worker とその `secret_key` を持つ Cloudflare のアカウント、Admin の Worker（コード・vars・secrets）を変えられる人、issuer のホストのゾーン（DNS・Route・Custom Domain）を変えられるトークンを持つ人。この一覧の誰でも、Administrator の JWT に署名するか issuer を差し替えられます。
- [ ] 受容した限界を、承認する人が読んで受容していること: 発行記録は Admin の Worker 自身が書くので、Admin の Worker に書ける者に対しては照合は独立の検知ではない（[コンソールログインの突き合わせ](../README_ja.md#コンソールログインの突き合わせ発行記録--cloudtrail)）。ゾーンの設定の見張りはゾーンの持ち主の運用で、外からの比較は検知であって予防ではない（[issuer の外からの確認](../README_ja.md#コンソールログインの-issuer-の外からの確認毎日)）。
- [ ] 承認そのもの。日付と、段 0 のコミットを添えて。

### 承認のあと: Administrator のスタック

[コンソールログインの Admin の署名鍵](../README_ja.md#コンソールログインの-admin-の署名鍵) の 6 のとおりに、Administrator のロールを作ります:

- [ ] **別スタック**で、名前が `awsbridge-console-kind-<kind>` の型に当たらない（例 `awsbridge-console-admin-default`）。`AdministratorTeams` だけを設定する。
- [ ] 作成の change set が **`AdministratorRole` の `Add` だけ**。そうでなければ実行しません。
- [ ] 作成の直後、最初の発行の前に: `aws iam get-role` の信頼ポリシーが Admin のプロバイダーだけを名指し、`aws iam list-attached-role-policies` に Admin の守りの部品が付いている。そうでなければ中断します（下）。
- [ ] Viewer のスタック（例 `awsbridge-console-kind-default`）の `AdministratorTeams` は空のまま。更新の前に毎回 change set を見て、`AdministratorRole` が出たら実行しません。
- [ ] `mise run console:inspect -- --profile=<p>`: 誤り 0（`role_missing` も消える）。
- [ ] 最初の Administrator の発行のあと、同じ日に: `console:reconcile` が `errors: 0`、`admin issues: 1` が自分の発行の時刻、identity の行が `admin 0`。`console:exposure-check` が終了コード 0。
- 中断するとき: **Administrator のスタックを消し、かつ設定から Administrator を外して生成し直します**（生成物とポータルの一覧に Administrator を残さないため）。
- Cloudflare に頼らずに Administrator の引き受けを止めるには: [Admin のプロバイダーだけを止める（L2）](../README_ja.md#admin-のプロバイダーだけを止めるl2) と [ロールの信頼ポリシーでの拒否](../README_ja.md#ロールの信頼ポリシーでの拒否)。信頼ポリシーの Deny を入れている間はスタックを更新しません。信頼ポリシーが変わる更新で Deny が消えるかは、測っていません。
