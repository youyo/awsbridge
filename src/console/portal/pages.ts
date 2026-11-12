// コンソールログイン: ポータルの最小限の画面（docs/specs/console-login-portal.md §4）。
// S2（ロールの選択と POST のフォーム）・S4（エラー）・S5（セッション切れ）・GET /login の案内と、PR5 で中身を作る画面の枠。
// CSP が script-src 'self'・style-src 'self' なので、inline の script・style を書かない。設定由来の値はすべてエスケープする。
// 発行の経路（login.ts）からは import しない。node の API を使わない。
import type { IssueErrorCode } from "../issue/errors";
import type { WorkerAccount, WorkerConfig, WorkerRole } from "../types";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

/** 画面の見出し（§4.6 の表）。code は画面にもそのまま出す（問い合わせのため）。 */
const ERROR_TITLES: Record<
  IssueErrorCode | "method_not_allowed" | "not_found" | "payload_too_large",
  string
> = {
  unauthorized: "もう一度ログインしてください",
  unknown_audience: "このページからはログインできません",
  team_mismatch: "このチームのページではありません",
  forbidden_origin: "もう一度選んでください",
  unsupported_media_type: "もう一度選んでください",
  csrf_failed: "もう一度選んでください",
  login_disabled: "ログインを一時停止しています",
  rate_limited: "少し待ってから、もう一度お試しください",
  not_listed: "このチームの一覧にないロールです",
  identity_unsupported: "このアカウントの利用者名では発行できません",
  sts_denied: "このロールに入れませんでした",
  upstream_auth_failed: "このアカウントは現在ログインを受け付けていません",
  temporarily_unavailable: "AWS に接続できませんでした",
  signin_failed: "AWS に接続できませんでした",
  server_misconfigured: "ポータルの設定に問題があります",
  signing_unavailable: "いまはログインできません",
  method_not_allowed: "この操作は受け付けていません",
  not_found: "ページが見つかりません",
  payload_too_large: "もう一度選んでください",
};

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(title)} - awsbridge</title>
</head>
<body>
<header><p>awsbridge AWS ログイン</p></header>
<main>
${body}
</main>
</body>
</html>
`;
}

export function htmlResponse(
  html: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

export type ErrorPageOptions = {
  requestId?: string | undefined;
  /** 一覧（S1）へのリンク。チームが分かるときだけ。 */
  teamBase?: string | undefined;
  supportUrl?: string | undefined;
};

/** S4 エラー。内部の詳細（STS の本文・例外の文）は出さない。 */
export function errorPage(code: keyof typeof ERROR_TITLES, o: ErrorPageOptions = {}): string {
  const title = ERROR_TITLES[code];
  const links = [
    ...(o.teamBase !== undefined ? [`<a href="${esc(o.teamBase)}/">一覧へ戻る</a>`] : []),
    ...(o.supportUrl !== undefined ? [`<a href="${esc(o.supportUrl)}">問い合わせ先</a>`] : []),
  ];
  return layout(
    title,
    `<h1>${esc(title)}</h1>
<p>問い合わせるときに貼る情報: code <code>${esc(code)}</code>${
      o.requestId ? ` 要求 ID <code>${esc(o.requestId)}</code>` : ""
    }</p>
${links.length > 0 ? `<p>${links.join(" ")}</p>` : ""}`,
  );
}

/** GET <team-base>/login（Access の再認証のあとに戻る先）。発行しない。 */
export function loginGetPage(teamBase: string): string {
  return layout(
    "もう一度選んでください",
    `<h1>もう一度選んでください</h1>
<p>ログインはアカウントの画面のボタンからだけ行えます。一覧からアカウントとロールを選び直してください。</p>
<p><a href="${esc(teamBase)}/">一覧へ</a></p>`,
  );
}

/** S5 コンソールのセッション切れ（フェデレーションの Issuer の戻り先）。 */
export function expiredPage(teamBase: string): string {
  return layout(
    "コンソールのセッションが切れました",
    `<h1>コンソールのセッションが切れました</h1>
<p>もう一度アカウントとロールを選んでください。</p>
<p><a href="${esc(teamBase)}/">一覧へ</a></p>`,
  );
}

/** PR5 で中身を作る画面（S0・S1・S3）の枠。 */
export function placeholderPage(title: string, back?: string): string {
  return layout(
    title,
    `<h1>${esc(title)}</h1>
<p>この画面は準備中です。</p>
${back !== undefined ? `<p><a href="${esc(back)}">戻る</a></p>` : ""}`,
  );
}

const hours = (s: number) => (s % 3600 === 0 ? `${s / 3600} 時間` : `${Math.round(s / 60)} 分`);

export type LoginFormOptions = {
  config: WorkerConfig;
  team: string;
  teamBase: string;
  account: WorkerAccount;
  /** このチームで入れるロール（行の順）。 */
  roles: { role: WorkerRole; sessionSeconds: number }[];
  selectedRole?: string | undefined;
  csrf: string;
  loginDisabled: boolean;
};

/** S2 アカウントの詳細とログイン（POST <team-base>/login のフォーム。hidden に csrf）。 */
export function loginFormPage(o: LoginFormOptions): string {
  const team = o.config.teams.find((t) => t.name === o.team);
  const selected =
    o.roles.find((r) => r.role.name === o.selectedRole)?.role.name ??
    (o.roles.length === 1 ? o.roles[0]?.role.name : undefined);
  const roleItems = o.roles
    .map(({ role, sessionSeconds }) => {
      const value = `${o.account.accountId}:${role.name}`;
      const checked = role.name === selected ? " checked" : "";
      return `<li><label><input type="radio" name="entry" value="${esc(value)}" required${checked}> ${esc(
        role.displayName,
      )}（${esc(role.roleName)}）セッション: ${esc(hours(sessionSeconds))}</label></li>`;
    })
    .join("\n");
  const regions = o.config.portal.regions;
  const regionField = regions
    ? `<p><label>リージョン: <select name="region">${regions.allowed
        .map(
          (r) =>
            `<option value="${esc(r)}"${r === regions.default ? " selected" : ""}>${esc(r)}</option>`,
        )
        .join("")}</select></label></p>`
    : "";
  const notice = o.loginDisabled
    ? `<p role="alert">ログインを一時停止しています。案内に従ってください。</p>\n`
    : "";
  const title = `${o.account.name}（${o.account.accountId}）`;
  return layout(
    title,
    `${notice}<p><a href="${esc(o.teamBase)}/">← 一覧へ</a></p>
<h1>${esc(title)}</h1>
<p>チーム: ${esc(team?.displayName ?? o.team)}</p>
<form method="post" action="${esc(o.teamBase)}/login" target="_blank" rel="noopener noreferrer">
<fieldset>
<legend>ロール（このチームで入れるもの）</legend>
<ul>
${roleItems}
</ul>
</fieldset>
${regionField}
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
<p><button type="submit">コンソールを開く（新しいタブ）</button></p>
</form>
<p>開いたコンソールが別のアカウント・ロールのままのとき（または Credentials invalid になるとき）は、開いているコンソールでサインアウトしてから、もう一度「コンソールを開く」を押してください。</p>`,
  );
}
