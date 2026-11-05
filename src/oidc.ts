import { importJWK, type JWK, SignJWT } from "jose";
import { publicJwkOf, thumbprintOf } from "./keys";

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

/**
 * 追加の公開鍵（secret ADDITIONAL_PUBLIC_JWKS、JSON 配列の文字列）を読む。未設定・空文字は []。
 * ここでは JSON 配列であること（要素がオブジェクト）だけ確かめる。鍵としての検証は publicJwks が行う。
 * 例外のメッセージに値は含めない。
 */
export function parseAdditionalPublicJwks(raw: string | undefined): JWK[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ADDITIONAL_PUBLIC_JWKS: not JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("ADDITIONAL_PUBLIC_JWKS: not an array");
  for (const k of parsed) {
    if (typeof k !== "object" || k === null || Array.isArray(k))
      throw new Error("ADDITIONAL_PUBLIC_JWKS: item is not an object");
  }
  return parsed as JWK[];
}

/**
 * JWKS を組み立てる: 署名鍵の公開鍵（先頭）+ 追加の公開鍵（署名鍵のローテーション用）。
 * 追加分は公開成分だけを取り出して kid・use・alg を付け直す。kid が重複する鍵は除く。
 * 鍵として使えない JWK（署名鍵・追加鍵とも）は例外。
 */
export async function publicJwks(
  privateJwk: JWK,
  additional: JWK[] = [],
): Promise<{ keys: JWK[] }> {
  // 署名鍵は秘密成分まで含めて鍵として使えることを確かめる（欠落・不正値はここで例外）
  await importJWK({ ...privateJwk, alg: "RS256" }, "RS256");
  const keys: JWK[] = [];
  const seen = new Set<string>();
  for (const jwk of [privateJwk, ...additional]) {
    const pub = await publicJwkOf(jwk);
    if (seen.has(pub.kid as string)) continue;
    seen.add(pub.kid as string);
    keys.push(pub);
  }
  return { keys };
}

/**
 * handler 用の JWKS 組み立て。署名鍵が不正なら例外（呼び出し側が 500 にする）。
 * ADDITIONAL_PUBLIC_JWKS は寛容に扱う: JSON でない・配列でないなら追加鍵なし、不正な要素はその要素だけ捨てる。
 * 捨てるたびに warn を 1 行出す（値は出さない）。署名鍵の公開鍵と正しい追加鍵は必ず出す。
 */
export async function publicJwksTolerant(
  privateJwk: JWK,
  rawAdditional: string | undefined,
): Promise<{ keys: JWK[] }> {
  const base = await publicJwks(privateJwk);
  if (rawAdditional === undefined || rawAdditional.trim() === "") return base;
  let items: unknown[];
  try {
    const parsed: unknown = JSON.parse(rawAdditional);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    items = parsed;
  } catch {
    console.warn("jwks: ADDITIONAL_PUBLIC_JWKS ignored (not a JSON array)");
    return base;
  }
  const keys = [...base.keys];
  const seen = new Set(keys.map((k) => k.kid as string));
  for (const [i, item] of items.entries()) {
    try {
      const pub = await publicJwkOf(item as JWK);
      if (seen.has(pub.kid as string)) continue;
      seen.add(pub.kid as string);
      keys.push(pub);
    } catch {
      console.warn(`jwks: invalid additional key skipped (index=${i})`);
    }
  }
  return { keys };
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
