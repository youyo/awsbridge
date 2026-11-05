import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateSigningJwk } from "../../src/keys";
import { keyFile } from "./env";

const file = keyFile();
if (existsSync(file)) {
  console.log(`既存の鍵があるため上書きしません: ${file}`);
  process.exit(0);
}
const jwk = await generateSigningJwk();
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`鍵を生成しました: ${file} (kid=${jwk.kid})`);
