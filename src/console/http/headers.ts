// コンソールログイン: ポータルの応答ヘッダー（docs/specs/console-login-portal.md §9.5・§9.6）。
// ポータル自身の Cookie は持たない。静的なファイル（CSS・JS）以外の応答は no-store にする。
// 副作用のない関数だけを置く（node の API を使わない）。

/** 画面（HTML・302・エラー）か、静的なファイル（CSS・JS。秘密を含まない）か。 */
export type ResponseKind = "page" | "static";

/**
 * フォームの送信先。form-action はフォーム送信のあとのリダイレクトの連鎖すべてに当たるため、
 * サインインからコンソールへのリダイレクト先まで許す（PoC の N10: signin だけではコンソールへの遷移が止まった）。
 */
const FORM_ACTIONS = [
  "'self'",
  "https://signin.aws.amazon.com",
  "https://*.signin.aws.amazon.com",
  "https://console.aws.amazon.com",
  "https://*.console.aws.amazon.com",
];

/** スクリプトは自前（'self'）だけ。inline・eval・外部のスクリプトを許さない。 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  `form-action ${FORM_ACTIONS.join(" ")}`,
].join("; ");

/** 応答に付けるセキュリティのヘッダー。呼ぶたびに新しいオブジェクトを返す。 */
export function securityHeaders(kind: ResponseKind = "page"): Record<string, string> {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    // AWS への遷移（別のオリジン）では Referer を送らない。no-referrer にすると自分の POST の Origin が null になる（§9.6）
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    ...(kind === "page" ? { "Cache-Control": "no-store" } : {}),
  };
}

/**
 * 応答にセキュリティのヘッダーを付けた新しい Response を返す（Response.redirect のようにヘッダーを変えられない応答にも使える）。
 * 画面の応答では、元の Cache-Control を no-store で上書きする。
 */
export function withSecurityHeaders(res: Response, kind: ResponseKind = "page"): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(securityHeaders(kind))) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
