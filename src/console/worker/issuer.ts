// コンソールログイン: 境界ごとの OIDC issuer の公開文書（discovery と JWKS。Standard と Admin の階層で同じ issuer）。
// issuer のホストでは、生成物の境界の issuer の URL（ホストとパス）に完全一致する 2 つのパスだけを返し、それ以外は 404。
// JWKS はその境界の vars CONSOLE_PUBLIC_JWKS の公開鍵だけ（秘密鍵のバインディングには触れない。cto の決裁 (a)）。
// MCP 用の OIDC の部品（src/oidc.ts・src/keys.ts。文字列の秘密鍵の読み込みを含む）は import しない。
import { issuerDiscovery, issuerJwks } from "../signing/issuer-doc";
import type { PublicJwk } from "../signing/key";
import type { WorkerConfig } from "../types";

export type IssuerDocMatch =
  | { kind: "discovery" | "jwks"; boundary: string; issuer: string }
  | { kind: "not_found" };

/** issuer のホストなら文書の経路を返す。issuer のホストでなければ undefined。 */
export function matchIssuerDoc(url: URL, config: WorkerConfig): IssuerDocMatch | undefined {
  let onIssuerHost = false;
  for (const b of config.boundaries) {
    const u = new URL(b.issuer);
    if (u.host !== url.host) continue;
    onIssuerHost = true;
    const base = u.pathname === "/" ? "" : u.pathname;
    if (url.pathname === `${base}/.well-known/openid-configuration`)
      return { kind: "discovery", boundary: b.name, issuer: b.issuer };
    if (url.pathname === `${base}/.well-known/jwks.json`)
      return { kind: "jwks", boundary: b.name, issuer: b.issuer };
  }
  return onIssuerHost ? { kind: "not_found" } : undefined;
}

export function discoveryDocument(issuer: string) {
  return issuerDiscovery(issuer);
}

/** その境界の公開鍵（vars）だけの JWKS。 */
export function jwksDocument(keys: readonly PublicJwk[]): { keys: PublicJwk[] } {
  return issuerJwks(keys);
}
