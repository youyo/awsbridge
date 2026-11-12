// コンソールログインの Admin の署名の部品（X1 の決裁）。処理は Standard と共通の src/console/signing/signer.ts で、
// ここは Admin のログの名前（イベント console_admin_signer、種別 admin_*）だけを決める。
// Standard の署名（standard/sign-standard.ts）とは鍵も vars も共有しない。node:* を import しない。
import {
  createKeySigner,
  type KeySigner,
  type KeySignerOptions,
  type KeyStatus,
} from "../signing/signer";

/** デプロイ後の確認（key-check）に返す鍵の状態。値（鍵の中身・署名）は持たない。 */
export type AdminKeyStatus = KeyStatus;
export type AdminSigner = KeySigner;
export type AdminSignerOptions = Omit<KeySignerOptions, "event" | "kind">;

export function createAdminSigner(o: AdminSignerOptions): AdminSigner {
  return createKeySigner({ ...o, event: "console_admin_signer", kind: "admin" });
}
