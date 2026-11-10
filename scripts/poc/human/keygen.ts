// PoC（人間のログイン）専用の署名鍵（RSA 2048、秘密鍵 JWK）を生成する。MCP 用の鍵（.secrets/dev-signing-key.json）とは別。
// 置き場所: AWSBRIDGE_HUMAN_POC_KEY_FILE（既定 .secrets/poc-human/signing-key.json）。既存なら上書きしない。
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateSigningJwk } from "../../../src/keys";
import { humanPocSettings } from "./lib";

const { keyFile } = humanPocSettings(process.env);
if (existsSync(keyFile)) {
  console.log(`既存の鍵があるため上書きしません: ${keyFile}`);
  process.exit(0);
}
const jwk = await generateSigningJwk();
mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
writeFileSync(keyFile, JSON.stringify(jwk), { mode: 0o600 });
chmodSync(keyFile, 0o600);
console.log(`鍵を生成しました: ${keyFile} (kid=${jwk.kid})`);
