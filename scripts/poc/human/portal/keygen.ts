// PoC のポータル用の署名鍵（std と admin。RSA 2048、秘密鍵 JWK）を生成する。MCP 用・既存の PoC の鍵とは別。
// 置き場所: AWSBRIDGE_HUMAN_POC_PORTAL_OUT_DIR（既定 .secrets/poc-human/portal）。既存なら上書きしない。
import { existsSync } from "node:fs";
import { generateSigningJwk } from "../../../../src/keys";
import { writeSecret } from "../io";
import { loadSettings } from "./io";

const s = loadSettings();
for (const [tier, file] of [
  ["std", s.stdKeyFile],
  ["admin", s.adminKeyFile],
] as const) {
  if (existsSync(file)) {
    console.log(`既存の鍵があるため上書きしません（${tier}）: ${file}`);
    continue;
  }
  const jwk = await generateSigningJwk();
  writeSecret(file, JSON.stringify(jwk));
  console.log(`鍵を生成しました（${tier}）: ${file} (kid=${jwk.kid})`);
}
