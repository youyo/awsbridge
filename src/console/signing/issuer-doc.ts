// コンソールログインの issuer の公開文書の形（Admin と Standard に共通）。AWS の OIDC プロバイダーが読むのは issuer と jwks_uri。
// MCP 用の src/oidc.ts の buildDiscovery と同じ形（鍵の読み込みを含む src/oidc.ts・src/keys.ts をコンソールのバンドルに入れないため、ここに置く）。
// issuer は生成物の値（末尾のスラッシュなし）をそのまま使う。秘密鍵には触れない。
import type { PublicJwk } from "./key";

export function issuerDiscovery(issuer: string) {
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

/** vars の公開鍵（検査済み）だけの JWKS。 */
export function issuerJwks(keys: readonly PublicJwk[]): { keys: PublicJwk[] } {
  return { keys: keys.map((k) => ({ ...k })) };
}
