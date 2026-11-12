// コンソールログイン（Standard の Worker）: Host での振り分け・issuer の文書・ポータルの経路・発行（9 段）。
// 設計: docs/specs/console-login-portal.md §3・§9・§10・§11。エントリ（index.ts）は生成物を渡してこの工場を呼ぶだけ。
// 経路・画面・発行の振り分けは階層に共通の工場（portal/worker.ts）に任せ、ここは Standard だけのもの
// （境界ごとの手元の鍵での署名・issuer の文書・CONSOLE_SIGNING_KEYS）を渡す。
//
//   issuer のホスト   境界の issuer の /<path>/.well-known/openid-configuration と jwks.json だけ。それ以外は 404
//   ポータルのホスト  ポータルの経路（portal/routes.ts。パス方式 R-P が既定、設定でホスト方式 R-H）
//   それ以外のホスト  404
//
// 生成物と secret は最初の要求で検査し、壊れていればどの経路も 500 server_misconfigured（ログは種別だけ）。
// 試験用の差し替え（StandardOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import type { JWK } from "jose";
import { createStandardSigner, parseSigningKeys } from "../issue/sign-standard";
import {
  createPortalWorker,
  EnvError,
  type IssuerHandler,
  methodNotAllowed,
  misconfigured,
  type PortalEnv,
  type PortalOverrides,
} from "../portal/worker";
import type { WorkerConfig } from "../types";
import { discoveryDocument, jwksDocument, matchIssuerDoc } from "./issuer";

export { DEFAULT_STS_REGION, isLoginDisabled } from "../portal/worker";

/** Standard の Worker の変数・secret・binding（wrangler.console-standard.jsonc）。 */
export type StandardEnv = PortalEnv & {
  /** secret: 境界の名前 → 秘密鍵 JWK の JSON。 */
  CONSOLE_SIGNING_KEYS?: string;
};

export type StandardOverrides = PortalOverrides;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

/** issuer の文書（URL のホストとパスの完全一致だけ）。鍵と JWKS は env ごとに使い回す。 */
function issuerHandler(config: WorkerConfig, keys: Record<string, JWK>): IssuerHandler {
  const jwks = new Map<string, Promise<{ keys: JWK[] }>>();
  return async (url, { isRead, requestId }) => {
    const doc = matchIssuerDoc(url, config);
    if (!doc || doc.kind === "not_found") return undefined;
    if (!isRead) return methodNotAllowed("GET, HEAD", requestId);
    if (doc.kind === "discovery") return json(discoveryDocument(doc.issuer));
    const jwk = Object.hasOwn(keys, doc.boundary) ? keys[doc.boundary] : undefined;
    if (!jwk) {
      console.error("config: invalid console env: signing_key_missing");
      return misconfigured(requestId);
    }
    let p = jwks.get(doc.boundary);
    if (!p) {
      p = jwksDocument(jwk);
      jwks.set(doc.boundary, p);
      p.catch(() => jwks.delete(doc.boundary));
    }
    try {
      return json(await p);
    } catch {
      console.error("config: invalid console env: signing_key");
      return misconfigured(requestId);
    }
  };
}

export function createStandardWorker(rawConfig: unknown, o: StandardOverrides = {}) {
  return createPortalWorker<StandardEnv>(
    rawConfig,
    {
      tier: "standard",
      buildTier(env, config) {
        let keys: Record<string, JWK>;
        try {
          keys = parseSigningKeys(env.CONSOLE_SIGNING_KEYS ?? "");
        } catch {
          throw new EnvError("signing_keys");
        }
        return { signer: createStandardSigner({ keys }), serveIssuer: issuerHandler(config, keys) };
      },
    },
    o,
  );
}
