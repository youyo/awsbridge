// 署名鍵（RSA）まわりの共通処理。Worker（JWKS の組み立て）と鍵ローテーション用スクリプト（scripts/key-rotate.ts）が使う。
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

/** RFC 7638 thumbprint。RSA の公開成分（n, e）が無ければ例外。 */
export function thumbprintOf(jwk: JWK): Promise<string> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("RSA JWK required");
  return calculateJwkThumbprint({ kty: "RSA", n: jwk.n, e: jwk.e });
}

/**
 * 公開成分（kty, n, e）だけを取り出し、kid（thumbprint）・use・alg を付けた公開鍵 JWK を返す。
 * 秘密成分が入っていても出さない。鍵として使えない値は例外。
 */
export async function publicJwkOf(jwk: JWK): Promise<JWK> {
  if (typeof jwk !== "object" || jwk === null) throw new Error("JWK must be an object");
  const b64u = /^[A-Za-z0-9_-]+$/;
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string")
    throw new Error("RSA JWK required");
  // WebCrypto は短すぎる・壊れた n を黙って受け付けることがあるので、ここで確かめる（RSA 2048 bit 以上）
  // 256 byte = base64url 342 文字
  if (!b64u.test(jwk.n) || !b64u.test(jwk.e) || jwk.n.length < 342)
    throw new Error("invalid RSA public key");
  const kid = await thumbprintOf(jwk);
  const pub: JWK = { kty: "RSA", n: jwk.n as string, e: jwk.e as string };
  await importJWK({ ...pub, alg: "RS256" }, "RS256");
  return { ...pub, kid, use: "sig", alg: "RS256" };
}

/** 署名鍵（RSA 2048、秘密鍵 JWK。kid は thumbprint）を新しく生成する。 */
export async function generateSigningJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.alg = "RS256";
  jwk.kid = await thumbprintOf(jwk);
  return jwk;
}
