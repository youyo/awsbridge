// コンソールログインの issuer の「外からの比較」の CLI: pnpm tsx scripts/console/exposure-check.ts
// mise タスク console:exposure-check から呼ぶ。外から取った issuer の discovery と JWKS が、設定の公開鍵（vars）と一致するかを確かめる
// （境界ごと。P2: Standard と Admin の階層で同じ issuer）。毎日の確認の 1 つ（もう 1 つは console:reconcile）。
// 公開の HTTP の GET だけ（Cloudflare・AWS のトークンを使わない・書き込まない）。名前は公開の DNS（DoH）で引き、その IP に TLS で接続する。
// 判定は src/console/exposure.ts、設定の読み方は exposure-check-lib.ts、取得は exposure-check-net.ts。
// 検知であって予防ではない（README の「issuer の外からの比較」）。
//
// 入力（鍵の道具と同じ。mise.toml の [env] に置かず mise.local.toml などで与える）:
//   AWSBRIDGE_CONSOLE_OUT_DIR                   生成物の置き場所（既定 .generated/console）
//   AWSBRIDGE_CONSOLE_WRANGLER_CONFIG           コンソールの Worker の wrangler の設定（既定 wrangler.console.jsonc。vars の公開鍵を読む）
// 出力は伏せ字（アカウント ID・email）。終了コード: 0 一致 / 1 不一致あり / 2 実行できない（設定が読めない・期待する鍵を得られない等）。
import { existsSync, readFileSync } from "node:fs";
import { redactExposure } from "../../src/console/exposure";
import { exposureSettings, runExposureCheck, SettingsError } from "./exposure-check-lib";
import { realFetchDoc } from "./exposure-check-net";

async function main(): Promise<number> {
  const env = process.env;
  const settings = await exposureSettings(
    env,
    (p) => readFileSync(p, "utf8"),
    (p) => existsSync(p),
  );
  return runExposureCheck(settings, realFetchDoc(env), (line) => console.log(line));
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // 例外の文に vars の値・JSON の断片は入れていない
    const msg = e instanceof SettingsError || e instanceof Error ? e.message : "実行できない";
    console.error(redactExposure(`error: ${msg}`));
    process.exitCode = 2;
  },
);
