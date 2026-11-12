// コンソールログインの Standard の署名鍵（cto の決裁「Standard も secret_key に揃える」）: 境界ごとの Workers の secret_key 型の
// バインディング（取り出せない CryptoKey）と、それを指す vars の約束。Worker と手元の道具（scripts/console/standard-key.ts）の両方が使う。
// 規則（名前・検査）は Admin と共通の src/console/signing/key.ts にあり、ここは Standard の名前（接頭辞・vars の名前）と境界の対応だけを持つ。
//
//   バインディングの名前    STANDARD_KEY_<kid の先頭 8 バイトの大文字の 16 進>。境界の名前（: や - を含む）は名前に入れず、kid から決める
//   STANDARD_CURRENT_KEYS   vars。境界の名前 → 今の署名鍵 {binding, kid} の JSON
//   STANDARD_PUBLIC_JWKS    vars。境界の名前 → 公開鍵 JWK の配列（新旧 2 つまで）の JSON。その境界の issuer の JWKS と自己検証に使う
//
// どちらも無い・空・壊れている、今の kid がその境界の公開鍵に無い、同じ kid が 2 つの境界にある、は例外（Worker は 500）。
// 秘密鍵の文字列（JWK など）を読み込む経路はここに置かない。Worker に入るので node:* を import しない。
import {
  bindingNameFor,
  type CurrentKey,
  isBlank,
  isObj,
  type PublicJwk,
  parseJsonVar,
  readCurrentKey,
  readPublicJwks,
} from "../signing/key";

/** バインディングの名前の接頭辞。 */
export const STANDARD_KEY_BINDING_PREFIX = "STANDARD_KEY_";

export type StandardKeys = {
  /** 境界 → 今の署名鍵。 */
  current: Record<string, CurrentKey>;
  /** 境界 → 公開鍵（1〜2 個）。 */
  publicJwks: Record<string, PublicJwk[]>;
};

/** kid から Standard のバインディングの名前を作る。形が違えば例外。 */
export function standardBindingName(kid: string): string {
  return bindingNameFor(STANDARD_KEY_BINDING_PREFIX, kid);
}

function readObject(raw: unknown, label: string): Record<string, unknown> {
  if (isBlank(raw)) throw new Error(`${label} is required`);
  const v = parseJsonVar(raw, label);
  if (!isObj(v) || Object.keys(v).length === 0)
    throw new Error(`${label} must be an object of boundary -> value`);
  for (const b of Object.keys(v))
    if (b.trim() === "" || b.length > 128) throw new Error(`${label}: invalid boundary name`);
  return v;
}

/** vars STANDARD_CURRENT_KEYS と STANDARD_PUBLIC_JWKS を読む。形の誤りは例外（文に値を入れない）。 */
export async function parseStandardKeys(
  currentRaw: unknown,
  publicRaw: unknown,
): Promise<StandardKeys> {
  const curLabel = "STANDARD_CURRENT_KEYS";
  const pubLabel = "STANDARD_PUBLIC_JWKS";
  const curObj = readObject(currentRaw, curLabel);
  const pubObj = readObject(publicRaw, pubLabel);
  const publicJwks: Record<string, PublicJwk[]> = {};
  const owner = new Map<string, string>();
  for (const [b, v] of Object.entries(pubObj)) {
    const keys = await readPublicJwks(v, pubLabel);
    for (const k of keys) {
      if (owner.has(k.kid)) throw new Error(`${pubLabel}: a key is shared by two boundaries`);
      owner.set(k.kid, b);
    }
    publicJwks[b] = keys;
  }
  const current: Record<string, CurrentKey> = {};
  for (const [b, v] of Object.entries(curObj)) {
    const c = readCurrentKey(v, STANDARD_KEY_BINDING_PREFIX, curLabel);
    if (owner.get(c.kid) !== b)
      throw new Error(`${curLabel}: the current kid is not in ${pubLabel} of the same boundary`);
    current[b] = c;
  }
  return { current, publicJwks };
}
