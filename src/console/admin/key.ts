// コンソールログインの Admin の署名鍵（X1 の決裁）: Workers の secret_key 型のバインディング（取り出せない CryptoKey）と、
// それを指す vars（今の署名鍵・公開鍵）の約束。Worker と手元の道具（scripts/console/admin-key.ts）の両方が使う。
// 規則（名前・検査）は Standard と共通の src/console/signing/key.ts にあり、ここは Admin の名前（接頭辞・vars の名前）だけを持つ。
//
//   バインディングの名前  ADMIN_KEY_<kid の先頭 8 バイトの大文字の 16 進>。kid（RFC 7638 の thumbprint）から決まるので、
//                         新しい鍵は必ず別の名前になる（同じ名前への PUT は即座に置き換わり、新旧を並べる期間が取れないため）
//   ADMIN_CURRENT_KEY     vars。今の署名鍵（名前と kid の組）の JSON。未設定なら署名の部品は未接続（503 signing_unavailable）
//   ADMIN_PUBLIC_JWKS     vars。公開鍵 JWK の配列（新旧 2 つまで）。Admin の issuer の JWKS と、署名の自己検証に使う
//
// 秘密鍵の文字列（JWK など）を読み込む経路はここに置かない。署名に使えるのは、取り出せない CryptoKey のバインディングだけ。
// 公開鍵は vars で渡す（webcrypto_modern_algorithms の getPublicKey は使わない）。Worker に入るので node:* を import しない。
import {
  bindingNameFor,
  type CurrentKey,
  isBlank,
  type PublicJwk,
  parseJsonVar,
  readCurrentKey,
  readPublicJwks,
} from "../signing/key";

export {
  base64url,
  type CurrentKey,
  inspectSigningKey,
  isUsableSigningKey,
  jwkThumbprint,
  type KeyProperties,
  MAX_PUBLIC_KEYS,
  type PublicJwk,
  RS256_ALGORITHM,
} from "../signing/key";

/** バインディングの名前の接頭辞。 */
export const ADMIN_KEY_BINDING_PREFIX = "ADMIN_KEY_";

/** kid（SHA-256 の thumbprint の base64url）から、バインディングの名前を作る。形が違えば例外。 */
export function bindingNameForKid(kid: string): string {
  return bindingNameFor(ADMIN_KEY_BINDING_PREFIX, kid);
}

/**
 * vars ADMIN_CURRENT_KEY（{"binding": "ADMIN_KEY_…", "kid": "…"}）を読む。未設定・空は undefined。
 * 名前は kid から作った名前と一致すること。形の誤りは例外（文に値を入れない）。
 */
export function parseCurrentKey(raw: unknown): CurrentKey | undefined {
  if (isBlank(raw)) return undefined;
  const label = "ADMIN_CURRENT_KEY";
  return readCurrentKey(parseJsonVar(raw, label), ADMIN_KEY_BINDING_PREFIX, label);
}

/**
 * vars ADMIN_PUBLIC_JWKS（公開鍵 JWK の配列。1〜2 個）を読む。未設定・空は undefined。
 * RSA 2048 bit 以上・e=65537・alg RS256・use sig（あれば）・kid は thumbprint と一致・重複なし。秘密の成分があれば断る。
 * 返すのは公開の成分と kid・alg・use だけ。形の誤りは例外。
 */
export async function parsePublicJwks(raw: unknown): Promise<PublicJwk[] | undefined> {
  if (isBlank(raw)) return undefined;
  const label = "ADMIN_PUBLIC_JWKS";
  return readPublicJwks(parseJsonVar(raw, label), label);
}
