// コンソールログイン（Standard の Worker）: Host での振り分け・issuer の文書・ポータルの経路・発行（9 段）。
// 設計: docs/specs/console-login-portal.md §3・§9・§10・§11。エントリ（index.ts）は生成物を渡してこの工場を呼ぶだけ。
// 経路・画面・発行の振り分けは階層に共通の工場（portal/worker.ts）に任せ、ここは Standard だけのもの
// （境界ごとの secret_key の鍵での署名・issuer の文書・デプロイ後の確認）を渡す。
//
//   issuer のホスト   境界の issuer の /<path>/.well-known/openid-configuration と jwks.json だけ。それ以外は 404
//   ポータルのホスト  ポータルの経路（portal/routes.ts。パス方式 R-P が既定、設定でホスト方式 R-H）
//   それ以外のホスト  404
//
// 署名鍵（cto の決裁「Standard も secret_key に揃える」）: 境界ごとの Workers の secret_key 型のバインディング（取り出せない CryptoKey）。
//   vars STANDARD_CURRENT_KEYS（境界 → 今の鍵 {binding, kid}）と STANDARD_PUBLIC_JWKS（境界 → 公開鍵。新旧 2 つまで）が指す（standard/key.ts）。
//   vars が無い・壊れている → どの経路も 500 server_misconfigured（従来の「署名鍵の secret が無い・壊れている」と同じ）。
//   その境界の今の鍵が無い・バインディングが無い・使えない（取り出せる・用途が違う）・vars の公開鍵で自己検証が通らない → 503 signing_unavailable。
//   JWKS はその境界の vars の公開鍵だけ（無ければ 500）。文字列の秘密鍵の secret は読まない。
//   デプロイ後の確認（GET <team-base>/key-check）: Access の検証の後ろで、そのチームの行がある境界ごとの鍵の性質
//   （取り出せない・exportKey が失敗する・自己検証）と kid だけを返す。
//
// 生成物と env は最初の要求で検査し、壊れていればどの経路も 500 server_misconfigured（ログは種別だけ）。
// 試験用の差し替え（StandardOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import { createEntryHandler } from "../display/entry";
import type { IdentityGroupsSource } from "../display/groups";
import { createStandardSigner, type StandardBoundaryKey } from "../issue/sign-standard";
import {
  createPortalWorker,
  EnvError,
  type IssuerHandler,
  methodNotAllowed,
  misconfigured,
  type PortalEnv,
  type PortalOverrides,
} from "../portal/worker";
import type { PublicJwk } from "../signing/key";
import type { WorkerConfig } from "../types";
import { discoveryDocument, jwksDocument, matchIssuerDoc } from "./issuer";
import { parseStandardKeys, type StandardKeys } from "./key";

export { DEFAULT_STS_REGION, isLoginDisabled } from "../portal/worker";

/** Standard の Worker の変数・secret・binding（wrangler.console-standard.jsonc）。 */
export type StandardEnv = PortalEnv & {
  /** vars: 境界の名前 → 今の署名鍵（{"binding": "STANDARD_KEY_…", "kid": "…"}）の JSON。 */
  STANDARD_CURRENT_KEYS?: string;
  /** vars: 境界の名前 → 公開鍵 JWK の配列（新旧 2 つまで）の JSON。 */
  STANDARD_PUBLIC_JWKS?: string;
};

export type StandardOverrides = PortalOverrides & {
  /**
   * 入口の一覧（S0。U2）の身元の Entra グループの取り方。取り方（Access の get-identity など）は未確定で、
   * 本番のエントリは渡さない（そのときは「分からない」→ 全チームの S1 へのリンクに落とす）。
   */
  identityGroups?: IdentityGroupsSource | undefined;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

/** issuer の文書（URL のホストとパスの完全一致だけ）。JWKS はその境界の vars の公開鍵だけ。 */
function issuerHandler(
  config: WorkerConfig,
  publicJwks: Record<string, PublicJwk[]>,
): IssuerHandler {
  return async (url, { isRead, requestId }) => {
    const doc = matchIssuerDoc(url, config);
    if (!doc || doc.kind === "not_found") return undefined;
    if (!isRead) return methodNotAllowed("GET, HEAD", requestId);
    if (doc.kind === "discovery") return json(discoveryDocument(doc.issuer));
    const keys = Object.hasOwn(publicJwks, doc.boundary) ? publicJwks[doc.boundary] : undefined;
    if (!keys) {
      console.error("config: invalid console env: signing_key_missing");
      return misconfigured(requestId);
    }
    return json(jwksDocument(keys));
  };
}

/** 生成物の境界ごとの署名の材料（今の鍵が vars にある境界だけ）。 */
function boundaryKeys(
  env: Record<string, unknown>,
  config: WorkerConfig,
  keys: StandardKeys,
): Record<string, StandardBoundaryKey> {
  const out: Record<string, StandardBoundaryKey> = {};
  for (const b of config.boundaries) {
    const current = Object.hasOwn(keys.current, b.name) ? keys.current[b.name] : undefined;
    if (!current) continue;
    const publicJwk = keys.publicJwks[b.name]?.find((k) => k.kid === current.kid);
    if (!publicJwk) throw new EnvError("signing_keys");
    out[b.name] = { issuer: b.issuer, current, publicJwk, key: env[current.binding] };
  }
  return out;
}

/**
 * @param rawConfig 発行用の生成物（worker.standard.json）
 * @param rawDisplay 表示用の生成物（display.standard.json）。入口（S0）の画面だけが読む。壊れていれば入口だけが 500
 */
export function createStandardWorker(
  rawConfig: unknown,
  o: StandardOverrides = {},
  rawDisplay?: unknown,
) {
  const { identityGroups, ...portalOverrides } = o;
  return createPortalWorker<StandardEnv>(
    rawConfig,
    {
      tier: "standard",
      serveEntry: createEntryHandler(rawDisplay, { identityGroups }),
      async buildTier(env, config) {
        let keys: StandardKeys;
        try {
          keys = await parseStandardKeys(env.STANDARD_CURRENT_KEYS, env.STANDARD_PUBLIC_JWKS);
        } catch {
          throw new EnvError("signing_keys");
        }
        const boundaries = boundaryKeys(env as Record<string, unknown>, config, keys);
        const signer = createStandardSigner({ boundaries, log: (line) => console.log(line) });
        return {
          signer,
          serveIssuer: issuerHandler(config, keys.publicJwks),
          keyCheck: async ({ team }) => {
            // そのチームの行がある境界だけ（ほかの境界の名前と kid を出さない）
            const mine = new Set(
              config.accounts
                .filter((a) => a.roles.some((r) => r.teams.includes(team)))
                .map((a) => a.boundary),
            );
            const status = await signer.status();
            const out: Record<string, unknown> = {};
            for (const b of config.boundaries) {
              if (!mine.has(b.name)) continue;
              const publicKids = (keys.publicJwks[b.name] ?? []).map((k) => k.kid);
              const st = status[b.name];
              out[b.name] = st
                ? { configured: true, ...st, publicKids }
                : { configured: false, publicKids };
            }
            return { boundaries: out };
          },
        };
      },
    },
    portalOverrides,
  );
}
