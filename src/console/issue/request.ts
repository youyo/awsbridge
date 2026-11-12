// コンソールログイン: `POST <team-base>/login` の要求の検査（docs/specs/console-login-portal.md §9.3 の 3、§9.4）。
// 本文を読む前に判定する。順序: 設定のオリジン（500）→ メソッド（405）→ Origin・Sec-Fetch-Site（403）→ Content-Type（415）。
// MCP 用の handler は Origin がなければ通すが、ポータルは**なければ拒否**する。比べる相手は設定のオリジンで、Host ヘッダーは使わない。
// 副作用のない関数だけを置く（node の API を使わない）。

export type LoginRequestFailure =
  | { status: 405; code: "method_not_allowed" }
  | { status: 403; code: "forbidden_origin" }
  | { status: 415; code: "unsupported_media_type" }
  | { status: 500; code: "server_misconfigured" };

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** 設定のオリジンが正規の形か（https、または手元の開発用の http://localhost・127.0.0.1。パス・クエリ・末尾のスラッシュなし）。 */
function isPortalOrigin(origin: string): boolean {
  if (typeof origin !== "string" || origin === "") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

/**
 * ログインの要求の形を検査する。通れば undefined。
 * @param portalOrigin このデプロイのポータルのオリジン（設定の portal.standardOrigin または adminOrigin）
 */
export function checkLoginRequest(
  req: Request,
  portalOrigin: string,
): LoginRequestFailure | undefined {
  if (!isPortalOrigin(portalOrigin)) return { status: 500, code: "server_misconfigured" };
  if (req.method !== "POST") return { status: 405, code: "method_not_allowed" };

  // Origin は必須で、設定のオリジンと完全一致（"null" や末尾のスラッシュつきも拒否）
  if (req.headers.get("Origin") !== portalOrigin) return { status: 403, code: "forbidden_origin" };
  // Sec-Fetch-Site は送られていれば same-origin だけ（送らないブラウザは Origin だけで判定する）
  const site = req.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") return { status: 403, code: "forbidden_origin" };

  const mediaType = (req.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) return { status: 415, code: "unsupported_media_type" };
  return undefined;
}
