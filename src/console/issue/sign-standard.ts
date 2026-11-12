// コンソールログインの発行: Standard の署名（signer.ts の TokenSigner の実装。cto の決裁「Standard も secret_key に揃える」）。
// 境界ごとに Workers の secret_key 型のバインディング（取り出せない CryptoKey）で署名する。1 つの境界は 1 つの鍵と 1 つの issuer を受け持ち、
// 処理（鍵の検査・claim・自己検証・JWT の形の照合）は Admin と共通の signing/signer.ts。ログはイベント console_standard_signer、種別 standard_*。
// その境界の今の鍵が設定に無い行は署名しない（ほかの境界の鍵で代用しない。503 signing_unavailable）。
// 秘密鍵の文字列（JWK）を読み込む経路は持たない。Admin の署名（admin/sign-admin.ts）とは鍵も vars も共有しない。node:* を import しない。
import type { CurrentKey, PublicJwk } from "../signing/key";
import { createKeySigner, type KeySigner, type KeyStatus } from "../signing/signer";
import type { SigningRequest, SigningResult, TokenSigner } from "./signer";

/** 境界ごとの署名の材料。 */
export type StandardBoundaryKey = {
  /** その境界の issuer（JWT の iss）。 */
  issuer: string;
  /** 今の署名鍵（バインディングの名前と kid）。 */
  current: CurrentKey;
  /** 今の kid の公開鍵（vars STANDARD_PUBLIC_JWKS から選んだもの）。 */
  publicJwk: PublicJwk;
  /** env[current.binding] の値（そのまま渡す。検査は署名のたびに行う）。 */
  key: unknown;
};

export type StandardSigner = TokenSigner & {
  /** デプロイ後の確認（key-check）に返す、境界ごとの鍵の状態。値は持たない。 */
  status(): Promise<Record<string, KeyStatus>>;
};

export function createStandardSigner(o: {
  boundaries: Record<string, StandardBoundaryKey>;
  log: (line: string) => void;
}): StandardSigner {
  const signers = new Map<string, KeySigner>();
  for (const [name, b] of Object.entries(o.boundaries))
    signers.set(
      name,
      createKeySigner({ ...b, log: o.log, event: "console_standard_signer", kind: "standard" }),
    );

  return {
    async sign(req: SigningRequest): Promise<SigningResult> {
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
