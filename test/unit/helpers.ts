import { exportJWK, generateKeyPair, type JWK } from "jose";

export async function newPrivateJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return exportJWK(privateKey);
}
