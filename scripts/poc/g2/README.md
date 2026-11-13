# G2 の開発環境の実測 (ii) の道具

手順書（`.claude/handover/g2-dev-measure-plan.md`）の §2.6 にある【新】の道具。`src/` と本番のバンドルには入れない。
この道具は実測に使う。道具を作っただけでは測っていない。

## 共通

- 記録・鍵・Cookie は `AWSBRIDGE_G2_DEV_DIR`（既定 `.secrets/g2-dev/`。gitignore）に置く。記録は `records/` に入る
- JWT・Cookie・認証情報・秘密鍵の値は、標準出力・記録に出さない。出すのは時刻・HTTP の状態・エラーコード・件数・kid と jti の先頭 8 文字だけ
- 間隔と期間は秒数か `<n>s`・`<n>m`・`<n>h`。どの見張りも Ctrl-C で止めると要約（最後の成功・最初の失敗）を出す
- 実 AWS・Cloudflare を呼ぶので、明示的に実行したときだけ使う。全体の終わりに `mise run secrets:scan` を回す

## 試験用の issuer（`poc:g2:probe:*`。ii-1b・追 2・ii-3 の対照）

issuer は `https://awsbridge-g2-probe-<label>.<zone>/p`（label は `n5`・`kid`・`ctrl` など）。issuer ごとに Worker（`awsbridge-g2-probe-<label>`）・ホスト・鍵が分かれる。

```sh
# mise.local.toml: AWSBRIDGE_G2_PROBE_ZONE="dev.example.com"、AWSBRIDGE_G2_PROBE_CF_API_TOKEN（T-PROBE）
mise run poc:g2:probe:keygen -- --issuer kid --name A        # 鍵 A を作る（B も同じ）
mise run poc:g2:probe:deploy -- --issuer kid --keys A,B      # JWKS = [A, B] でデプロイし、公開内容を確かめる
mise run poc:g2:probe:deploy -- --issuer kid --keys B        # A を外す（要求・完了の時刻を出す）
mise run poc:g2:probe:watch -- --issuer kid --role-arn arn:aws:iam::123456789012:role/awsbridge-g2-probe/<名前> \
  --keys A,B --interval 60 --duration 60m --extend-interval 5m --max-duration 24h --until-refused A   # 追 2
mise run poc:g2:probe:check -- --issuer kid                  # 公開内容と応答ヘッダー
mise run poc:g2:probe:forget -- --issuer kid                 # 測定のあと、手元の鍵を消す（記録は残す）
```

- 隔離の条件（§2.6.1）はコードで守る。aud が `awsbridge-console`（と MCP の `awsbridge`）なら断る。ホストが `awsbridge-g2-probe-<label>.<zone>`（`AWSBRIDGE_G2_PROBE_ZONE` の内の 1 段。末尾のドットは不可）でないとき、または本物の issuer・ポータルのホストの一覧（`AWSBRIDGE_ISSUER`、`config/console.json` のポータルと issuer、`AWSBRIDGE_G2_PROBE_REAL_HOSTS`）にあるときも断る。ロールのパスが `/awsbridge-console/` の下なら断り、`/awsbridge-g2-probe/` 以外も断る
- JWT は `aud` が `awsbridge-g2-probe`、`exp = iat + 300` で、回ごと・鍵ごとに作り直す。延長（`--extend-interval` と `--max-duration`）を付けると、`--duration` のあとは広げた間隔で続ける。`--until-refused` の鍵が `--stop-after-refused`（既定 30 分）続けて断られたら止める
- 応答ヘッダーは本物の issuer と同じにする（`application/json` と `securityHeaders("page")`。`Cache-Control: no-store` を含む）
- OIDC プロバイダーとロールは、この道具では作らない（P-OP が作る）。合わせる値は次のとおり
  - プロバイダーの URL は issuer と同じ `https://awsbridge-g2-probe-<label>.<zone>/p`。client ID は `awsbridge-g2-probe` だけにする
  - ロールのパスは `/awsbridge-g2-probe/`。権限は持たせず、インラインは全 Deny の 1 つだけにする
  - 信頼ポリシーはそのプロバイダー 1 つを信頼し、`<host>/p:aud` = `awsbridge-g2-probe`、`<host>/p:sub` = `g2-probe`（`AWSBRIDGE_G2_PROBE_SUBJECT` で変えられる）を条件にする

## 発行の見張り（`poc:g2:issue-watch`。追 1・ii-1d。Adm 枠では使わない）

```sh
# ブラウザの開発者ツールから CF_Authorization の値を .secrets/g2-dev/cookies/g2std.txt に 1 行で置く（権限 600）
mise run poc:g2:issue-watch -- --portal https://awsbridge-console.dev.example.com --team g2std \
  --account 123456789012 --role viewer --interval 30 --duration 15m
```

- 回ごとに `GET /t/<team>/a/<account>?role=<role>` で CSRF を取り、`POST /t/<team>/login` を送る。成功は AWS のサインインへの 302（`issued`）。リダイレクトは追わない
- Cookie のファイルは `cookies/` の下だけを受け付ける。終わったら（正常・失敗・Ctrl-C・SIGTERM・端末を閉じたときのどれでも）消して、ファイル名と時刻を出す。SIGKILL では消せないので、そのときは手で消す。残すときは `--keep-cookie`
- Cookie は始めに 1 回だけ読む。Access のセッションが切れたら（Admin は 15 分）、Cookie を置き直して起動し直す
- `--portal` のホストは `awsbridge-console.`・`awsbridge-admin-console.` で始まるものだけ（Cookie をほかのホストに送らない）。名前が違うときは `AWSBRIDGE_G2_PORTAL_HOST_PREFIXES`（カンマ区切り。例 `g2dev-awsbridge-console.`）で変える
- Cookie のファイルはシンボリックリンクにしない（断る）。リンクのディレクトリを経由して `cookies/` の外に出るものも断る
- `--role administrator`（本物の Administrator）は断る。POST のたびに本当に発行するので、間隔を短くしすぎない

## セッションの見張り（`poc:g2:session-watch`。ii-1c・ii-5・追 1）

```sh
mise run poc:g2:session-watch -- --profile g2-viewer --profile g2-viewer-remote --profile g2-admin-probe --interval 10
```

- 既定の操作は `s3api list-buckets`。変えるときは `--operation "<サービス> <操作>"` で指定する（読み取りの操作だけ）。秘密を返す操作（`sts get-session-token`・`secretsmanager`・`ssm get-parameter*`・`kms` など）は断るが、一覧は網羅ではない。**操作は読み取りを選ぶ。出力は捨てるが、どの操作を呼ぶかの責任は利用者にある**。`sts get-caller-identity` は明示の Deny で止まらないので、停止の確認には使わない（指定すると警告を出す）

## 時間差の集計（`poc:g2:time-gap`。ii-2 の 6）

```sh
mise run poc:g2:time-gap -- --records .secrets/g2-dev/records/issue-records.ndjson --profile g2-ro
mise run poc:g2:time-gap -- --records <file|dir> --trail <lookup-events の出力の JSON>
```

- 発行記録（`console:reconcile` の `--records` と同じ形）と CloudTrail の `AssumeRoleWithWebIdentity` を jti で結び、差（`eventTime − iat`。秒）の件数・最小・中央値・p90・最大を、全体と階層ごとに出す
- 中央値は、件数が偶数なら真ん中の 2 つの平均にする。p90 は最近順位法で求める（小さい順で ⌈0.9n⌉ 番目）。負の差も残す。同じ jti の引き受けが 2 つ以上あれば、最初の 1 つで測る

## 片付けの確認（`poc:g2:clean-check`。§4.2）

```sh
mise run poc:g2:clean-check -- --profile g2-ro --stack <base のスタック> --stack <ロールのスタック> --baseline .secrets/g2-dev/baseline-providers.json
```

- AWS は照会だけで、ロール・OIDC プロバイダー・管理ポリシー・スタックを見る。Cloudflare は GET だけで、Worker・Custom Domain・Access アプリを見る。Cloudflare を見るには `AWSBRIDGE_G2_CF_ACCOUNT_ID` と `AWSBRIDGE_G2_CF_READ_TOKEN` が要り、無ければ SKIP にする
- 残っていない（SKIP を含む）なら終了コード 0、残っている・読めないなら 1。IAM の全体の比較・DNS・Access のポリシー・API トークン・`secrets:scan` は手で見る
