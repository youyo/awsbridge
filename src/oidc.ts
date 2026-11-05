import { calculateJwkThumbprint, importJWK, type JWK, SignJWT } from "jose";

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function buildDiscovery(issuerInput: string) {
  const issuer = trimSlash(issuerInput);
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: ["sub", "aud", "exp", "iat", "iss", "email"],
  };
}

async function thumbprintOf(jwk: JWK): Promise<string> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("RSA JWK required");
  return calculateJwkThumbprint({ kty: "RSA", n: jwk.n, e: jwk.e });
}

export async function publicJwks(privateJwk: JWK): Promise<{ keys: JWK[] }> {
  // 鍵として使えない JWK（欠落・不正値）はここで例外にする
  await importJWK({ ...privateJwk, alg: "RS256" }, "RS256");
  return {
    keys: [
      {
        kty: "RSA",
        n: privateJwk.n as string,
        e: privateJwk.e as string,
        kid: await thumbprintOf(privateJwk),
        use: "sig",
        alg: "RS256",
      },
    ],
  };
}

export interface SignStsTokenParams {
  privateJwk: JWK;
  issuer: string;
  audience: string;
  subject: string;
  email?: string;
  ttlSeconds?: number;
  /** epoch seconds（テスト用に注入可能） */
  now?: number;
}

export async function signStsToken(p: SignStsTokenParams): Promise<string> {
  const key = await importJWK({ ...p.privateJwk, alg: "RS256" }, "RS256");
  const kid = await thumbprintOf(p.privateJwk);
  const iat = p.now ?? Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(p.email ? { email: p.email } : {})
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(p.issuer)
    .setAudience(p.audience)
    .setSubject(p.subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (p.ttlSeconds ?? 300));
  return jwt.sign(key);
}

/** STS RoleSessionName の許可文字 [\w+=,.@-] 以外を除去する（Go 版 sanitizeSessionName と同等）。 */
export function sanitizeSessionName(s: string): string {
  return s.replace(/[^A-Za-z0-9=,.@_+-]/g, "");
}

/** prefix + sanitize(id) + suffix を 64 文字以内に収める。suffix は保持し id 側を切り詰める。 */
export function buildSessionName(prefix: string, id: string, suffix: string): string {
  const maxIdLen = Math.max(0, 64 - prefix.length - suffix.length);
  return prefix + sanitizeSessionName(id).slice(0, maxIdLen) + suffix;
}
