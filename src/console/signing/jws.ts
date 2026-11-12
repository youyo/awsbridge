// コンソールログインの署名（Admin と Standard に共通）: RS256 の JWS（JWT）を WebCrypto だけで組む・確かめる（外部のライブラリに頼らない。X1 の決裁 (d)）。
// 鍵は取り出せない CryptoKey（Workers の secret_key 型のバインディング）。鍵の中身には触れない。
// 自己検証（verifyJws）に使う公開鍵は vars の公開鍵 JWK（signing/key.ts の readPublicJwks を通したもの）だけで、usages は verify だけ。
// Worker に入るので node:* を import しない。
import { base64url, type PublicJwk, RS256_ALGORITHM } from "./key";

const enc = new TextEncoder();
const base64urlJson = (v: unknown) => base64url(enc.encode(JSON.stringify(v)));

function base64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** header（alg・kid・typ だけ）と claim を RS256 で署名した JWT。 */
export async function signJws(
  key: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const input = `${base64urlJson({ alg: "RS256", kid, typ: "JWT" })}.${base64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(RS256_ALGORITHM, key, enc.encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

/** 公開鍵 JWK（vars の検査済みのもの）を、検証だけに使う CryptoKey にする。 */
export function importVerifyKey(pub: PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: pub.n, e: pub.e, alg: "RS256" },
    RS256_ALGORITHM,
    false,
    ["verify"],
  );
}

export type DecodedJws = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
};

/** JWT を分解する（検証はしない）。形が違えば undefined。 */
export function decodeJws(jwt: string): DecodedJws | undefined {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length !== 3) return undefined;
  const [h, p, s] = parts as [string, string, string];
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(base64urlDecode(h)));
    const payload = JSON.parse(dec.decode(base64urlDecode(p)));
    if (typeof header !== "object" || header === null || Array.isArray(header)) return undefined;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    return { header, payload, signingInput: `${h}.${p}`, signature: base64urlDecode(s) };
  } catch {
    return undefined;
  }
}

/** 署名を公開鍵で確かめる（自己検証）。 */
export async function verifyJws(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const d = decodeJws(jwt);
  if (!d) return false;
  try {
    return await crypto.subtle.verify(
      RS256_ALGORITHM,
      publicKey,
      d.signature,
      enc.encode(d.signingInput),
    );
  } catch {
    return false;
  }
}
