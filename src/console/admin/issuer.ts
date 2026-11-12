// コンソールログイン（Admin）: Admin の issuer の公開文書（discovery と JWKS）。X1 の決裁で A-3 = I-B（Cloudflare の別のホスト + /admin）。
// Admin の issuer のホスト（Standard の issuer・ポータルのホストと別。設定の検査 admin_issuer_host_shared・issuer_host_overlaps_portal）で、
// <issuer>/.well-known/openid-configuration と <issuer>/.well-known/jwks.json の 2 つのパスだけを返す。それ以外は 404。
// JWKS は vars ADMIN_PUBLIC_JWKS の公開鍵（新旧 2 つまで）だけ。秘密鍵（バインディング）には触れない。
// MCP 用の OIDC の部品（src/oidc.ts。鍵の読み込みを含む）は import しない。discovery の形は Standard と共通（signing/issuer-doc.ts）。

import { issuerDiscovery, issuerJwks } from "../signing/issuer-doc";
import type { WorkerConfig } from "../types";
import type { PublicJwk } from "./key";

/** Admin の生成物の境界の issuer（ちょうど 1 つ・パスは /admin）。そうでなければ undefined。 */
export function adminIssuerOf(config: WorkerConfig): string | undefined {
  if (config.boundaries.length !== 1) return undefined;
  const issuer = (config.boundaries[0] as { issuer: string }).issuer;
  try {
    const u = new URL(issuer);
    return u.protocol === "https:" && u.pathname === "/admin" && issuer === `${u.origin}/admin`
      ? issuer
      : undefined;
  } catch {
    return undefined;
  }
}

export type AdminIssuerDoc = "discovery" | "jwks";

/** Admin の issuer のホストの文書の経路（ホストとパスの完全一致）。それ以外は undefined。 */
export function matchAdminIssuerDoc(url: URL, issuer: string): AdminIssuerDoc | undefined {
  const u = new URL(issuer);
  if (url.host !== u.host) return undefined;
  if (url.pathname === `${u.pathname}/.well-known/openid-configuration`) return "discovery";
  if (url.pathname === `${u.pathname}/.well-known/jwks.json`) return "jwks";
  return undefined;
}

/** Admin の issuer のホストか。 */
export const isAdminIssuerHost = (url: URL, issuer: string): boolean =>
  url.host === new URL(issuer).host;

/** discovery（Standard の issuer と同じ形。AWS の OIDC プロバイダーが読むのは issuer と jwks_uri）。 */
export function adminDiscovery(issuer: string) {
  return issuerDiscovery(issuer);
}

export function adminJwks(keys: readonly PublicJwk[]): { keys: PublicJwk[] } {
  return issuerJwks(keys);
}
