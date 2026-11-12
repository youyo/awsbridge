// コンソールログイン（Admin の Worker）: 画面と発行の 1〜8 段。9 段目（署名）はまだ接続せず 503 signing_unavailable。
// 設計: docs/specs/console-login-portal.md §3・§8・§9、G1 の決裁（Admin の issuer の文書は AWS 側に置き、この Worker は出さない）、G-6。
// 経路・画面・発行の振り分けは階層に共通の工場（portal/worker.ts）に任せ、ここは Admin だけのものを渡す。
//
//   チームのパス（パス方式 /t/<team>/...、ホスト方式 <team>.<host>/...）以外は、処理の最初（env も Access JWT も見ない前）に 404。
//   issuer の文書は出さない。Standard の鍵・署名の実装・OIDC の部品は読み込まない。
//   署名の部品は unavailableSigner: STS・getSigninToken を呼ばない。KMS・署名役の呼び出し・Admin のプロバイダーの URL は G1-b まで実装しない。
//   署名鍵の secret（CONSOLE_SIGNING_KEYS）は持たない。入口の AUD は発行に受けない（AUD → チームの表に載せない）。
// 試験用の差し替え（AdminOverrides）は E2E・unit のためのもので、本番のエントリは何も渡さない。
import { unavailableSigner } from "../issue/signer";
import { createPortalWorker, type PortalEnv, type PortalOverrides } from "../portal/worker";

/** Admin の Worker の変数・secret・binding（wrangler.console-admin.jsonc）。署名鍵の secret は持たない。 */
export type AdminEnv = PortalEnv;

export type AdminOverrides = PortalOverrides;

export function createAdminWorker(rawConfig: unknown, o: AdminOverrides = {}) {
  return createPortalWorker<AdminEnv>(
    rawConfig,
    { tier: "admin", teamPathOnly: true, buildTier: () => ({ signer: unavailableSigner }) },
    o,
  );
}
