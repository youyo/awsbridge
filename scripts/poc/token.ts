import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { signStsToken } from "../../src/oidc";
import { envOr, keyFile, requireEnv } from "./env";

export interface MintOptions {
  aud?: string | undefined;
  expOffset?: number | undefined;
  otherKey?: boolean | undefined;
  sub?: string | undefined;
}

export async function mintToken(opts: MintOptions = {}): Promise<string> {
  const issuer = requireEnv("AWSBRIDGE_ISSUER");
  const subject = opts.sub ?? requireEnv("AWSBRIDGE_POC_SUBJECT");
  const audience = opts.aud ?? envOr("AWSBRIDGE_AUDIENCE", "awsbridge");
  let privateJwk: JWK;
  if (opts.otherKey) {
    const { privateKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });
    privateJwk = await exportJWK(privateKey);
  } else {
    privateJwk = JSON.parse(readFileSync(keyFile(), "utf8")) as JWK;
  }
  const now = Math.floor(Date.now() / 1000);
  // ttl 300 のトークンを now + expOffset で期限切れにするため、iat を expOffset 分ずらす
  const offset = opts.expOffset ?? 0;
  return signStsToken({ privateJwk, issuer, audience, subject, now: now + offset });
}
