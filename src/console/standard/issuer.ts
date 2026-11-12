// コンソールログイン（Standard）: 境界ごとの OIDC issuer の公開文書（discovery と JWKS）。
// issuer のホストでは、生成物の境界の issuer の URL（ホストとパス）に完全一致する 2 つのパスだけを返し、それ以外は 404。
// Admin の issuer の文書は出さない（Standard の生成物に Admin の issuer は入らない）。秘密成分（d など）は出さない。
import type { JWK } from "jose";
import { buildDiscovery, publicJwks } from "../../oidc";
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
  return buildDiscovery(issuer);
}

/** その境界の公開鍵だけの JWKS。鍵が使えなければ例外（呼び出し側が 500 にする）。 */
export function jwksDocument(privateJwk: JWK): Promise<{ keys: JWK[] }> {
  return publicJwks(privateJwk);
}
