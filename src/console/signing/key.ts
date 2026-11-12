// コンソールログインの署名鍵（Workers の secret_key 型のバインディング = 取り出せない CryptoKey）の、階層に共通の部品。
// cto の決裁「Standard も secret_key に揃える」の条件 (a)〜(d) を Admin と Standard の両方に掛けるため、Admin の実装（PR13）から切り出した。
//
//   バインディングの名前  <接頭辞><kid の先頭 8 バイトの大文字の 16 進>。kid（RFC 7638 の thumbprint）から決まるので、新しい鍵は必ず別の名前になる
//                         （同じ名前への PUT は即座に置き換わり、新旧を並べる期間が取れないため）。接頭辞は階層ごと（Admin と Standard で別の接頭辞。
//                         名前は各階層の key.ts）で、この部品には持たない（各階層のバンドルに相手の名前を入れないため）
//   今の署名鍵            {binding, kid}。名前は kid から作った名前と一致すること
//   公開鍵                RS256・2048 bit 以上・e=65537 の公開鍵 JWK の配列（新旧 2 つまで）。kid は thumbprint と一致
//
// 秘密鍵の文字列（JWK など）を読み込む経路はここに置かない。署名に使えるのは、取り出せない CryptoKey のバインディングだけ。
// 公開鍵は vars で渡す（webcrypto_modern_algorithms の getPublicKey は使わない）。例外の文に値は入れず、vars の名前（label）だけを入れる。
// Worker に入るので node:* を import しない。

/** RS256 の WebCrypto の方式（secret_key の algorithm と同じ）。 */
export const RS256_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } } as const;
/** 公開鍵の vars に並べられる鍵の数（差し替えの間の新旧 2 つまで）。 */
export const MAX_PUBLIC_KEYS = 2;

export type PublicJwk = {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg: "RS256";
  use: "sig";
};

export type CurrentKey = { binding: string; kid: string };

/** RSA の秘密の成分（公開鍵の vars に入っていたら断る）。 */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;
// SHA-256 の thumbprint（32 バイト）の base64url（43 文字）
const KID_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
// RSA 2048 bit 以上（n は 256 バイト = base64url 342 文字以上）
const MIN_MODULUS_CHARS = 342;
const PREFIX_RE = /^[A-Z][A-Z0-9]*_KEY_$/;

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function base64urlDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** kid が SHA-256 の thumbprint の形か。 */
export const isKid = (kid: unknown): kid is string => typeof kid === "string" && KID_RE.test(kid);

/** バインディングの名前の形（<接頭辞><16 進 16 桁>）。 */
export function bindingPattern(prefix: string): RegExp {
  if (!PREFIX_RE.test(prefix)) throw new Error("invalid binding prefix");
  return new RegExp(`^${prefix}[0-9A-F]{16}$`);
}

/** kid（SHA-256 の thumbprint の base64url）から、バインディングの名前を作る。形が違えば例外。 */
export function bindingNameFor(prefix: string, kid: string): string {
  if (!PREFIX_RE.test(prefix)) throw new Error("invalid binding prefix");
  if (!isKid(kid)) throw new Error("kid must be a SHA-256 JWK thumbprint");
  const hex = [...base64urlDecode(kid).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex.toUpperCase()}`;
}

/** RSA の公開鍵の RFC 7638 の thumbprint（SHA-256、base64url）。 */
export async function jwkThumbprint(k: { n: string; e: string }): Promise<string> {
  const canonical = JSON.stringify({ e: k.e, kty: "RSA", n: k.n });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64url(new Uint8Array(digest));
}

export const isBlank = (raw: unknown) =>
  raw === undefined || (typeof raw === "string" && raw.trim() === "");

/** JSON の文字列の vars を読む（label は例外の文に入れる vars の名前）。 */
export function parseJsonVar(raw: unknown, label: string): unknown {
  if (typeof raw !== "string") throw new Error(`${label} must be a JSON string`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be JSON`);
  }
}

/**
 * 今の署名鍵（{"binding": "<接頭辞>…", "kid": "…"}）の値を確かめる。名前は kid から作った名前と一致すること。
 * 形の誤りは例外（文に値を入れない）。
 */
export function readCurrentKey(v: unknown, prefix: string, label: string): CurrentKey {
  if (!isObj(v) || Object.keys(v).sort().join(",") !== "binding,kid")
    throw new Error(`${label} must be {binding, kid}`);
  const { binding, kid } = v;
  if (!isKid(kid)) throw new Error(`${label}: invalid kid`);
  if (
    typeof binding !== "string" ||
    !bindingPattern(prefix).test(binding) ||
    binding !== bindingNameFor(prefix, kid)
  )
    throw new Error(`${label}: binding does not match the kid`);
  return { binding, kid };
}

/**
 * 公開鍵 JWK の配列（1〜2 個）の値を確かめる。RSA 2048 bit 以上・e=65537・alg RS256・use sig（あれば）・kid は thumbprint と一致・
 * 重複なし。秘密の成分があれば断る。返すのは公開の成分と kid・alg・use だけ。形の誤りは例外。
 */
export async function readPublicJwks(v: unknown, label: string): Promise<PublicJwk[]> {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PUBLIC_KEYS)
    throw new Error(`${label} must be an array of 1-${MAX_PUBLIC_KEYS} public JWKs`);
  const out: PublicJwk[] = [];
  for (const k of v) {
    if (!isObj(k)) throw new Error(`${label}: item is not an object`);
    if (PRIVATE_MEMBERS.some((m) => Object.hasOwn(k, m)))
      throw new Error(`${label}: private member found`);
    if (
      k.kty !== "RSA" ||
      typeof k.n !== "string" ||
      !B64URL_RE.test(k.n) ||
      k.n.length < MIN_MODULUS_CHARS ||
      k.e !== "AQAB" ||
      (k.alg !== undefined && k.alg !== "RS256") ||
      (k.use !== undefined && k.use !== "sig")
    )
      throw new Error(`${label}: RS256 RSA public key (2048 bit or more, e=65537) required`);
    if (typeof k.kid !== "string" || k.kid !== (await jwkThumbprint({ n: k.n, e: k.e })))
      throw new Error(`${label}: kid must be the JWK thumbprint`);
    if (out.some((x) => x.kid === k.kid)) throw new Error(`${label}: duplicate kid`);
    out.push({ kty: "RSA", n: k.n, e: k.e, kid: k.kid, alg: "RS256", use: "sig" });
  }
  return out;
}

/** 鍵の性質（検査の結果。値は持たない）。 */
export type KeyProperties = {
  present: boolean;
  usable: boolean;
  extractable?: boolean;
  usages?: string[];
  /** exportKey（jwk・pkcs8）が失敗したか。試していなければ undefined。 */
  exportKey?: "rejected" | "allowed";
};

/**
 * バインディングの値を検査する: CryptoKey・type private・extractable false・usages が sign だけ・RSASSA-PKCS1-v1_5/SHA-256・
 * 2048 bit 以上・e=65537、そして exportKey（jwk・pkcs8）が失敗すること。値（鍵の中身）は返さない。
 */
export async function inspectSigningKey(v: unknown): Promise<KeyProperties> {
  if (v === undefined || v === null) return { present: false, usable: false };
  if (typeof CryptoKey === "undefined" || !(v instanceof CryptoKey))
    return { present: true, usable: false };
  const alg = v.algorithm as {
    name?: string;
    hash?: { name?: string };
    modulusLength?: unknown;
    publicExponent?: unknown;
  };
  const usages = [...v.usages];
  const shapeOk =
    v.type === "private" &&
    v.extractable === false &&
    usages.length === 1 &&
    usages[0] === "sign" &&
    alg?.name === RS256_ALGORITHM.name &&
    alg.hash?.name === RS256_ALGORITHM.hash.name &&
    typeof alg.modulusLength === "number" &&
    alg.modulusLength >= 2048 &&
    alg.publicExponent instanceof Uint8Array &&
    base64url(alg.publicExponent) === "AQAB";
  let exportKey: "rejected" | "allowed" = "rejected";
  for (const format of ["jwk", "pkcs8"] as const) {
    try {
      await crypto.subtle.exportKey(format, v);
      exportKey = "allowed";
    } catch {}
  }
  return {
    present: true,
    usable: shapeOk && exportKey === "rejected",
    extractable: v.extractable,
    usages,
    exportKey,
  };
}

export async function isUsableSigningKey(v: unknown): Promise<boolean> {
  return (await inspectSigningKey(v)).usable;
}
