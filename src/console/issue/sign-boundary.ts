// コンソールログインの発行: 境界ごとの署名（signer.ts の TokenSigner の実装）。
// 境界ごとに Workers の secret_key 型のバインディング（取り出せない CryptoKey）で署名する。1 つの境界は 1 つの鍵と 1 つの issuer を受け持ち、
// Standard と Admin の階層で同じ鍵を使う（P2（B）。受容 a・d）。処理（鍵の検査・claim・自己検証・JWT の形の照合）は signing/signer.ts。
// ログはイベント console_signer、種別 console_*。
// その境界の今の鍵が設定に無い行は署名しない（ほかの境界の鍵で代用しない。503 signing_unavailable）。
// 多重の防御（P2 の設計メモ §7.1）: 署名の直前に、タグに入れるチームの階層（生成物の teams[].tier）と、ロールの ARN のパスの
// 階層（/awsbridge-console/std/・/admin/）が同じことを確かめ、違えば署名しない（行の検査 findRow と別の層）。
// 秘密鍵の文字列（JWK）を読み込む経路は持たない。node:* を import しない。
import { ROLE_PATH_PREFIX, rolePath, TIERS, type Tier } from "../constants";
import type { CurrentKey, PublicJwk } from "../signing/key";
import { createKeySigner, type KeySigner, type KeyStatus } from "../signing/signer";
import type { SigningRequest, SigningResult, TokenSigner } from "./signer";

/** 境界ごとの署名の材料。 */
export type BoundaryKey = {
  /** その境界の issuer（JWT の iss）。 */
  issuer: string;
  /** 今の署名鍵（バインディングの名前と kid）。 */
  current: CurrentKey;
  /** 今の kid の公開鍵（vars CONSOLE_PUBLIC_JWKS から選んだもの）。 */
  publicJwk: PublicJwk;
  /** env[current.binding] の値（そのまま渡す。検査は署名のたびに行う）。 */
  key: unknown;
};

export type BoundarySigner = TokenSigner & {
  /** デプロイ後の確認（key-check）に返す、境界ごとの鍵の状態。値は持たない。 */
  status(): Promise<Record<string, KeyStatus>>;
};

/** ロールの ARN のパスの階層（/awsbridge-console/std/<名前> → standard）。コンソールのパスでなければ undefined。 */
export function arnTier(roleArn: string): Tier | undefined {
  const m = /^arn:aws(-[a-z]+)*:iam::\d{12}:role(\/.*\/)[^/]+$/.exec(roleArn);
  if (!m?.[2]?.startsWith(ROLE_PATH_PREFIX)) return undefined;
  return TIERS.find((t) => rolePath(t) === m[2]);
}

export function createBoundarySigner(o: {
  boundaries: Record<string, BoundaryKey>;
  /** チーム → 階層（生成物の teams[].tier）。 */
  teamTiers: Readonly<Record<string, Tier>>;
  log: (line: string) => void;
}): BoundarySigner {
  const signers = new Map<string, KeySigner>();
  for (const [name, b] of Object.entries(o.boundaries))
    signers.set(
      name,
      createKeySigner({ ...b, log: o.log, event: "console_signer", kind: "console" }),
    );

  return {
    async sign(req: SigningRequest): Promise<SigningResult> {
      // タグのチームの階層 = ARN のパスの階層（違えば署名しない。値はログに出さない）
      const teamTier = Object.hasOwn(o.teamTiers, req.row.team)
        ? o.teamTiers[req.row.team]
        : undefined;
      const roleTier = arnTier(req.row.roleArn);
      if (teamTier === undefined || roleTier === undefined || teamTier !== roleTier) {
        o.log(JSON.stringify({ event: "console_signer", result: "console_tier_mismatch" }));
        return { ok: false, code: "signing_unavailable" };
      }
      const s = signers.get(req.row.boundary);
      if (!s) return { ok: false, code: "signing_unavailable" };
      return s.sign(req);
    },
    async status() {
      const out: Record<string, KeyStatus> = {};
      for (const [name, s] of signers) out[name] = await s.status();
      return out;
    },
  };
}
