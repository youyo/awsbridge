// コンソールログインの発行: 検証済みの Access の身元から、SourceIdentity と RoleSessionName に使う値を決める。
// 制約に合わなければ identity_unsupported にする（切り詰めない。切り詰めると別の人が同じ値になりうる）。
// 設計: docs/specs/console-login.md §3.4（SourceIdentity は 64 文字、RoleSessionName は console-<email> で email 56 文字まで）、
//       console-login-portal.md §9.3 の 8 段目。Worker に入るので node:* を import しない。
import type { SourceIdentitySource } from "../constants";

/** 検証済みの Access JWT から取り出した身元（Access JWT の検証は別の部品。ここでは検証済みとして受け取る）。 */
export type AccessIdentity = {
  /** Access の `sub`（利用者を一意に表す ID。発行記録に残す）。 */
  sub: string;
  email: string;
  /** Entra の `oid`（取れれば。発行記録に残す）。 */
  oid?: string;
  /** Access のカスタムクレーム（identity.sourceIdentity が `custom.<名前>` のときの出どころ）。 */
  custom?: Record<string, unknown>;
};

/** RoleSessionName の接頭辞。 */
export const SESSION_NAME_PREFIX = "console-";
/** RoleSessionName の上限（STS の制約）。 */
export const SESSION_NAME_MAX = 64;
/** email の上限（上限 64 − 接頭辞 8）。 */
export const EMAIL_MAX = SESSION_NAME_MAX - SESSION_NAME_PREFIX.length;
/** SourceIdentity の上限。AWS の文書は 256 文字だが、資料の食い違いがあるので短い方に合わせる（console-login.md §3.4）。 */
export const SOURCE_IDENTITY_MAX = 64;

// STS の SourceIdentity・RoleSessionName が受け付ける文字（英数字と _+=,.@-）。
const STS_CHARS_RE = /^[\w+=,.@-]+$/;
const EMAIL_SHAPE_RE = /^[^@]+@[^@]+$/;

export type ResolvedIdentity = {
  /** 小文字にした email（JWT の sub・RoleSessionName・発行記録に使う）。 */
  email: string;
  /** JWT の SourceIdentity の claim に入れる値。 */
  sourceIdentity: string;
  /** `console-<email>`。 */
  sessionName: string;
};

export type ResolveIdentityResult =
  | { ok: true; value: ResolvedIdentity }
  | { ok: false; code: "identity_unsupported" };

const UNSUPPORTED = { ok: false, code: "identity_unsupported" } as const;

/** SourceIdentity の値として使えるか（2〜64 文字、STS が受け付ける文字だけ）。 */
export const isValidSourceIdentity = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 2 && v.length <= SOURCE_IDENTITY_MAX && STS_CHARS_RE.test(v);

/** 出どころ（`email` か `custom.<名前>`）に従って SourceIdentity の候補を取り出す。取れなければ undefined。 */
function sourceIdentityOf(
  identity: AccessIdentity,
  email: string,
  source: SourceIdentitySource,
): unknown {
  if (source === "email") return email;
  const name = source.slice("custom.".length);
  const custom = identity.custom;
  if (typeof custom !== "object" || custom === null) return undefined;
  return Object.hasOwn(custom, name) ? custom[name] : undefined;
}

export function resolveIdentity(
  identity: AccessIdentity,
  source: SourceIdentitySource,
): ResolveIdentityResult {
  if (typeof identity.email !== "string") return UNSUPPORTED;
  // 小文字化の前に、生の値を ASCII の許容文字で検査する。先に小文字化すると、Kelvin 記号（U+212A）などが
  // ASCII の文字に化けて検査をすり抜け、別の人の email と同じ SourceIdentity・RoleSessionName になりうる。
  if (identity.email.length > EMAIL_MAX || !STS_CHARS_RE.test(identity.email)) return UNSUPPORTED;
  const email = identity.email.toLowerCase(); // ここまでで ASCII だけなので、小文字化も ASCII だけ
  if (!EMAIL_SHAPE_RE.test(email)) return UNSUPPORTED;
  const sourceIdentity = sourceIdentityOf(identity, email, source);
  if (!isValidSourceIdentity(sourceIdentity)) return UNSUPPORTED;
  return {
    ok: true,
    value: { email, sourceIdentity, sessionName: `${SESSION_NAME_PREFIX}${email}` },
  };
}
