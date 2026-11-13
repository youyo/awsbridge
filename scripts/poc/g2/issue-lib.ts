// G2 の発行の見張り（poc:g2:issue-watch）の純粋関数。I/O は scripts/poc/g2/issue-watch.ts。
// 手順書 §2.6・§3.6（追 1）・ii-1d。ポータルの流れ（src/console/portal/）に合わせる:
//   GET  <portal>/t/<team>/a/<account>?role=<role>   アカウントの画面。フォームの hidden の csrf（10 分有効）を取り出す
//   POST <portal>/t/<team>/login                       entry=<account>:<role>&csrf=...。Origin はポータルのオリジン（必須）
//   成功は AWS のサインイン（signin.aws.amazon.com）への 302。Location はサインインのトークンを含むので返さない・出さない。
import { isAbsolute, relative, resolve } from "node:path";

export interface IssueTarget {
  origin: string;
  team: string;
  account: string;
  role: string;
  accountPath: string;
  loginPath: string;
}

const ORIGIN_RE = /^(https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?|http:\/\/127\.0\.0\.1:\d{1,5})$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** ポータルのオリジン（https。試験は http://127.0.0.1:<port>）・チーム・アカウント・ロール（設定の名前）を確かめる。 */
export function parseIssueTarget(p: {
  portal: string;
  team: string;
  account: string;
  role: string;
}): IssueTarget {
  if (!ORIGIN_RE.test(p.portal))
    throw new Error(
      `--portal はポータルのオリジン（https://<host>。パス・末尾のスラッシュなし）: '${p.portal}'`,
    );
  if (!NAME_RE.test(p.team)) throw new Error(`--team の形が違う: '${p.team}'`);
  if (!/^\d{12}$/.test(p.account)) throw new Error("--account は 12 桁のアカウント ID");
  if (!NAME_RE.test(p.role))
    throw new Error(`--role は設定のロールの名前（例 viewer）: '${p.role}'`);
  return {
    origin: p.portal,
    team: p.team,
    account: p.account,
    role: p.role,
    accountPath: `/t/${p.team}/a/${p.account}?role=${encodeURIComponent(p.role)}`,
    loginPath: `/t/${p.team}/login`,
  };
}

/** 本物の Administrator のロール（設定の名前 administrator）は断る（cto の決裁: issue-watch は Adm 枠で回さない）。 */
export function assertWatchRole(role: string): string {
  if (role === "administrator")
    throw new Error(
      "本物の Administrator（administrator）には使わない（issue-watch は Adm 枠で回さない）",
    );
  return role;
}

/** Cookie のファイルは <g2 dir>/cookies/ の下だけ（終わったら消すので、外のファイルを消さないように）。絶対パスを返す。 */
export function assertCookieFile(file: string, cookiesDir: string): string {
  const abs = resolve(file);
  const rel = relative(resolve(cookiesDir), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Cookie のファイルは ${cookiesDir} の下に置く`);
  return abs;
}

export interface HttpReply {
  status: number;
  location: string | null;
  body: string;
}

export type PageResult = { ok: true; csrf: string } | { ok: false; code: string };
export type LoginResult = { ok: true; code: "issued" } | { ok: false; code: string };

const isAccessRedirect = (loc: string): boolean => {
  try {
    const u = new URL(loc);
    return (
      u.hostname.endsWith(".cloudflareaccess.com") || u.pathname.startsWith("/cdn-cgi/access/")
    );
  } catch {
    return false;
  }
};

const isAwsSignin = (loc: string): boolean => {
  try {
    const u = new URL(loc);
    return (
      u.protocol === "https:" &&
      (u.hostname === "signin.aws.amazon.com" || u.hostname.endsWith(".signin.aws.amazon.com"))
    );
  } catch {
    return false;
  }
};

/** エラーの画面（src/console/portal/pages.ts の errorPage）の code。無ければ http_<status>。 */
function errorCode(r: HttpReply): string {
  return /code <code>([a-z_]{1,64})<\/code>/.exec(r.body)?.[1] ?? `http_${r.status}`;
}

function redirectCode(r: HttpReply): string {
  return r.location !== null && isAccessRedirect(r.location)
    ? "access_login_redirect"
    : `http_${r.status}`;
}

/** アカウントの画面の応答。200 ならフォームの csrf を取り出す。 */
export function classifyAccountPage(r: HttpReply): PageResult {
  if (r.status >= 300 && r.status < 400) return { ok: false, code: redirectCode(r) };
  if (r.status !== 200) return { ok: false, code: errorCode(r) };
  const csrf = /<input type="hidden" name="csrf" value="([A-Za-z0-9._-]{1,200})">/.exec(
    r.body,
  )?.[1];
  return csrf === undefined ? { ok: false, code: "no_csrf" } : { ok: true, csrf };
}

/** ログインの応答。AWS のサインインへの 302 だけが発行の成功。 */
export function classifyLogin(r: HttpReply): LoginResult {
  if (r.status >= 300 && r.status < 400) {
    if (r.location !== null && isAwsSignin(r.location)) return { ok: true, code: "issued" };
    return { ok: false, code: redirectCode(r) };
  }
  return { ok: false, code: errorCode(r) };
}

export function loginBody(
  account: string,
  role: string,
  csrf: string,
  region: string | undefined,
): string {
  const p = new URLSearchParams({ entry: `${account}:${role}`, csrf });
  if (region !== undefined) p.set("region", region);
  return p.toString();
}
