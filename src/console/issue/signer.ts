// コンソールログインの発行: 署名の差し込み口。
// 9 段目の「署名」だけを切り出したインターフェース。入力は検証済みの Access の身元と、選んだ一覧の行。
// 出力は署名済みの JWT か signing_unavailable。
//   Standard: 境界ごとの手元の鍵で署名する実装（sign-standard.ts）。
//   Admin:    Workers の secret_key 型の取り出せない鍵で署名する実装（admin/sign-admin.ts）。今の鍵が設定に無ければ
//             unavailableSigner（503 signing_unavailable）。
// Admin の Worker に Standard の鍵の扱いが入らないよう、型はこのファイルに分けた。node:* を import しない。
import type { AccessIdentity, ResolvedIdentity } from "./identity";

/** 一覧から選んだ行（このチーム・この階層の行で、5 段目〜7 段目を通ったもの）。 */
export type IssueRow = {
  team: string;
  /** 境界の名前（`managed` か `partner:<id>`）。署名に使う鍵を選ぶ。 */
  boundary: string;
  /** その境界の OIDC issuer（JWT の iss）。 */
  issuer: string;
  accountId: string;
  /** 設定の roles[].name。 */
  role: string;
  roleArn: string;
  sessionSeconds: number;
};

export type SigningRequest = {
  /** 検証済みの Access の身元（Access の JWT の検証は別の部品）。 */
  identity: AccessIdentity;
  /** 8 段目で決めた email・SourceIdentity・RoleSessionName。 */
  resolved: ResolvedIdentity;
  row: IssueRow;
  /** epoch 秒。省略すると現在時刻。 */
  now?: number;
};

export type SignedToken = {
  jwt: string;
  jti: string;
  iat: number;
  exp: number;
  issuer: string;
};

export type SigningResult =
  | { ok: true; token: SignedToken }
  | { ok: false; code: "signing_unavailable" };

export interface TokenSigner {
  sign(req: SigningRequest): Promise<SigningResult>;
}

/** 署名の部品が未接続のデプロイ用（Admin の本番の配線など）。常に signing_unavailable を返す。 */
export const unavailableSigner: TokenSigner = {
  sign: async () => ({ ok: false, code: "signing_unavailable" }),
};
