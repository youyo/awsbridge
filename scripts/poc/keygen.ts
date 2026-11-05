import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { requireEnv } from "./env";

const file = requireEnv("AWSBRIDGE_KEY_FILE");
if (existsSync(file)) {
  console.log(`既存の鍵があるため上書きしません: ${file}`);
  process.exit(0);
}
const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
const jwk = await exportJWK(privateKey);
jwk.alg = "RS256";
jwk.kid = await calculateJwkThumbprint({ kty: "RSA", n: jwk.n as string, e: jwk.e as string });
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`鍵を生成しました: ${file} (kid=${jwk.kid})`);
