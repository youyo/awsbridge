// コンソールログイン（Admin の Worker）: 画面と発行の 9 段、Admin の issuer の文書。
// 設計: docs/specs/console-login-portal.md §3・§8・§9、G-6、X1 の決裁（Administrator の発行を Cloudflare で完結）:
//   Admin は Standard と別の Worker・別の issuer・別の鍵・別のホスト（D3）。署名鍵は Workers の secret_key 型（取り出せない CryptoKey）。
//   Admin の issuer の discovery と JWKS は、Admin の issuer のホスト（Cloudflare の別のホスト + /admin。A-3 = I-B）でこの Worker が出す。
// 経路・画面・発行の振り分けは階層に共通の工場（portal/worker.ts）に任せ、ここは Admin だけのものを渡す。
//
//   チームのパス（パス方式 /t/<team>/...、ホスト方式 <team>.<host>/...）と Admin の issuer の 2 つの文書のパス以外は、
//   処理の最初（env も Access JWT も見ない前）に 404。Standard の鍵・署名の実装・OIDC の部品は読み込まない。
//   署名の部品（admin/sign-admin.ts）:
//     vars ADMIN_CURRENT_KEY（今の署名鍵: バインディングの名前と kid）が無ければ unavailableSigner（503 signing_unavailable。STS を呼ばない）。
//     あれば env[<名前>]（secret_key のバインディング）を使う。バインディングが無い・使えない・vars の公開鍵で自己検証が通らなければ 503。
//     vars の形の誤り（名前が kid の規則と違う・kid が公開鍵に無い・公開鍵に秘密の成分など）は 500。
//   Access JWT の iat からの経過時間の上限（vars ACCESS_MAX_AGE_SECONDS。既定 900 秒 = Admin の Access のセッションの長さ）。
//   デプロイ後の確認（GET <team-base>/key-check）: Access の検証の後ろで、鍵の性質（取り出せない・exportKey が失敗する・自己検証）と kid だけを返す。
//   署名鍵の secret（CONSOLE_SIGNING_KEYS）は持たない。入口の AUD は発行に受けない（AUD → チームの表に載せない）。
// 試験用の差し替え（AdminOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import { unavailableSigner } from "../issue/signer";
import { errorPage, htmlResponse } from "../portal/pages";
import {
  createPortalWorker,
  EnvError,
  type IssuerHandler,
  methodNotAllowed,
  type PortalEnv,
  type PortalOverrides,
} from "../portal/worker";
import {
  adminDiscovery,
  adminIssuerOf,
  adminJwks,
  isAdminIssuerHost,
  matchAdminIssuerDoc,
} from "./issuer";
import { type PublicJwk, parseCurrentKey, parsePublicJwks } from "./key";
import { type AdminSigner, createAdminSigner } from "./sign-admin";

/**
 * Admin の Worker の変数・secret・binding（wrangler.console-admin.jsonc）。署名鍵の secret（文字列）は持たない。
 * 署名鍵は secret_key 型のバインディング（ADMIN_KEY_<16 進>。Cloudflare API で入れる）で、名前は ADMIN_CURRENT_KEY が指す。
 */
export type AdminEnv = PortalEnv & {
  /** vars: 今の署名鍵（{"binding": "ADMIN_KEY_…", "kid": "…"}）。無ければ署名の部品は未接続（503）。 */
  ADMIN_CURRENT_KEY?: string;
  /** vars: 公開鍵 JWK の配列（新旧 2 つまで）。Admin の issuer の JWKS と自己検証に使う。 */
  ADMIN_PUBLIC_JWKS?: string;
  /** vars: Access JWT の iat からの経過時間の上限（秒。60〜86400。既定 900）。 */
  ACCESS_MAX_AGE_SECONDS?: string;
};

export type AdminOverrides = PortalOverrides;

/** Access JWT の iat からの経過時間の上限の既定（秒）。Admin の Access のセッションの長さ（15 分）に合わせる。 */
export const DEFAULT_ACCESS_MAX_AGE_SECONDS = 900;
const MAX_AGE_MIN = 60;
const MAX_AGE_MAX = 86_400;

function readMaxAge(v: unknown): number {
  if (v === undefined || v === "") return DEFAULT_ACCESS_MAX_AGE_SECONDS;
  if (typeof v !== "string" || !/^\d{1,6}$/.test(v)) throw new EnvError("access_max_age");
  const n = Number(v);
  if (n < MAX_AGE_MIN || n > MAX_AGE_MAX) throw new EnvError("access_max_age");
  return n;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function issuerHandler(issuer: string, keys: PublicJwk[] | undefined): IssuerHandler {
  return async (url, { isRead, requestId }) => {
    if (!isAdminIssuerHost(url, issuer)) return undefined;
    const doc = matchAdminIssuerDoc(url, issuer);
    // 文書のパス以外は処理の最初（工場）で 404 にしているが、念のためここでも返す
    if (!doc || !keys) return htmlResponse(errorPage("not_found", { requestId }), 404);
    if (!isRead) return methodNotAllowed("GET, HEAD", requestId);
    return json(doc === "discovery" ? adminDiscovery(issuer) : adminJwks(keys));
  };
}

export function createAdminWorker(rawConfig: unknown, o: AdminOverrides = {}) {
  return createPortalWorker<AdminEnv>(
    rawConfig,
    {
      tier: "admin",
      teamPathOnly: true,
      isIssuerDoc(url, config) {
        const issuer = adminIssuerOf(config);
        return issuer !== undefined && matchAdminIssuerDoc(url, issuer) !== undefined;
      },
      async buildTier(env, config) {
        const issuer = adminIssuerOf(config);
        if (!issuer) throw new EnvError("admin_issuer");
        let keys: PublicJwk[] | undefined;
        try {
          keys = await parsePublicJwks(env.ADMIN_PUBLIC_JWKS);
        } catch {
          throw new EnvError("admin_public_jwks");
        }
        let current: ReturnType<typeof parseCurrentKey>;
        try {
          current = parseCurrentKey(env.ADMIN_CURRENT_KEY);
        } catch {
          throw new EnvError("admin_current_key");
        }
        const accessMaxAgeSeconds = readMaxAge(env.ACCESS_MAX_AGE_SECONDS);
        let signer: AdminSigner | undefined;
        if (current) {
          const kid = current.kid;
          const publicJwk = keys?.find((k) => k.kid === kid);
          if (!publicJwk) throw new EnvError("admin_current_key_not_in_jwks");
          signer = createAdminSigner({
            issuer,
            current,
            publicJwk,
            key: (env as Record<string, unknown>)[current.binding],
            log: (line) => console.log(line),
          });
        }
        const publicKids = (keys ?? []).map((k) => k.kid);
        return {
          signer: signer ?? unavailableSigner,
          serveIssuer: issuerHandler(issuer, keys),
          accessMaxAgeSeconds,
          keyCheck: async () =>
            signer
              ? { configured: true, ...(await signer.status()), publicKids }
              : { configured: false, publicKids },
        };
      },
    },
    o,
  );
}
