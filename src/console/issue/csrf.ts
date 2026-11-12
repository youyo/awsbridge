// コンソールログイン: 状態を持たない CSRF トークン（docs/specs/console-login-portal.md §9.5）。
// トークン = `<version>.<iat>.<base64url(HMAC-SHA256(csrf_key, version|AUD|sub|iat))>`。
// AUD に束縛するので、R-P で同じオリジンにある別のチームのページのトークンは使えない。期限は 10 分（司令塔の決定）。
// AUD と sub は検証済みの Access JWT から渡す（フォームやパスの値を使わない）。
// csrf_key は署名鍵と別の Worker secret。Web Crypto だけを使う（node の API を使わない）。

export const CSRF_TOKEN_VERSION = "v1";
/** トークンの有効期限（秒）。 */
export const CSRF_TTL_SECONDS = 600;
/** 未来の発行時刻に許す時計ずれ（秒）。 */
const CLOCK_SKEW_SECONDS = 30;
/** csrf_key の最小の長さ（UTF-8 のバイト数）。HMAC-SHA256 の出力と同じ 32 バイト。 */
const MIN_KEY_BYTES = 32;
/** `v1.<iat>.<MAC>`。MAC は HMAC-SHA256 の出力（32 バイト）の base64url（パディングなし、43 文字）。 */
const TOKEN_RE = /^v1\.(0|[1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;

export type CsrfBinding = {
  /** 検証済みの Access JWT のただ 1 つの aud */
  aud: string;
  /** 検証済みの Access JWT の sub */
  sub: string;
};

export type CsrfFailureReason = "missing" | "malformed" | "expired" | "not_yet_valid" | "mismatch";

export type CsrfResult =
  | { ok: true }
  | { ok: false; status: 403; code: "csrf_failed"; reason: CsrfFailureReason };

const fail = (reason: CsrfFailureReason): CsrfResult => ({
  ok: false,
  status: 403,
  code: "csrf_failed",
  reason,
});

const enc = new TextEncoder();

/** Worker secret の csrf_key（文字列）から HMAC-SHA256 の鍵を作る。短い・空なら投げる（呼び出し側は server_misconfigured にする）。 */
export async function importCsrfKey(secret: string): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? enc.encode(secret) : new Uint8Array();
  if (raw.byteLength < MIN_KEY_BYTES) {
    // 鍵の文面は出さない
    throw new Error(`csrf_key は ${MIN_KEY_BYTES} バイト以上にしてください`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

const validPart = (s: unknown): s is string =>
  typeof s === "string" && s !== "" && !s.includes("|");

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array | undefined {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    // 正規の形（パディングの余りのビットが 0）だけを受け付ける
    return base64url(out) === s ? out : undefined;
  } catch {
    return undefined;
  }
}

async function mac(key: CryptoKey, b: CsrfBinding, iat: number): Promise<Uint8Array> {
  const input = `${CSRF_TOKEN_VERSION}|${b.aud}|${b.sub}|${iat}`;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(input)));
}

/** 長さが同じなら、内容によらず同じ回数だけ比べる（定数時間比較）。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** S2・S3 の hidden に入れるトークンを作る。aud・sub が空か区切り（|）を含めば投げる。 */
export async function createCsrfToken(
  key: CryptoKey,
  binding: CsrfBinding,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!validPart(binding?.aud) || !validPart(binding?.sub))
    throw new Error("CSRF トークンを束縛する aud・sub が不正です");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("発行時刻が不正です");
  return `${CSRF_TOKEN_VERSION}.${now}.${base64url(await mac(key, binding, now))}`;
}

/** POST の `csrf` を検証する。失敗は 403 csrf_failed（reason はログ用。画面には出さない）。 */
export async function verifyCsrfToken(
  key: CryptoKey,
  token: string | null | undefined,
  binding: CsrfBinding,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CsrfResult> {
  if (typeof token !== "string" || token === "") return fail("missing");
  const m = TOKEN_RE.exec(token);
  const given = m?.[2] !== undefined ? fromBase64url(m[2]) : undefined;
  if (!m || given === undefined) return fail("malformed");
  const iat = Number(m[1]);
  if (!validPart(binding?.aud) || !validPart(binding?.sub)) return fail("mismatch");

  // 発行時刻を書き換えた延命を先に MAC で弾く（期限の判定は改ざんされていない iat で行う）
  if (!timingSafeEqual(given, await mac(key, binding, iat))) return fail("mismatch");
  if (iat > now + CLOCK_SKEW_SECONDS) return fail("not_yet_valid");
  if (now - iat > CSRF_TTL_SECONDS) return fail("expired");
  return { ok: true };
}
