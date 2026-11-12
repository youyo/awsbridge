// コンソールログイン: ポータルの画面（docs/specs/console-login-portal.md §4）。階層（Standard / Admin）に共通。
// S1（チームの一覧）・S2（ロールの選択と POST のフォーム）・S3（aws login の手順）・S4（エラー）・S5（セッション切れ）・GET /login の案内。
// 入口（S0）は表示用の生成物を読むので、ここではなく src/console/display/ に置く（Admin のバンドルに入れない）。
// CSP が script-src 'self'・style-src 'self' なので、inline の script・style を書かない（JS と CSS は /assets から読む）。
// 一覧の JSON は script の要素に入れず、エスケープした data-json の属性（dataElement）で渡す。
// 設定由来の値はすべてエスケープする。発行の経路（login.ts）からは import しない。node の API を使わない。
import type { Tier } from "../constants";
import type { IssueErrorCode } from "../issue/errors";
import { resolveRegion } from "../issue/federation";
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

/** Admin の画面の印（見出しとタブのタイトルの先頭に付ける）。区別を残すかは人の確認待ち（§12.1）で、既定は残す案。 */
export const ADMIN_MARK = "[ADMIN]";

/** 階層の画面の印。Standard は付けない。 */
export const tierMark = (tier: Tier): string | undefined =>
  tier === "admin" ? ADMIN_MARK : undefined;

/**
 * @param assetBase 静的なファイルを読む起点（入口は ""、チームのページは <team-base>）。渡したときだけ CSS と JS を読む
 */
export function layout(title: string, body: string, mark?: string, assetBase?: string): string {
  const prefix = mark !== undefined ? `${mark} ` : "";
  const assets =
    assetBase !== undefined
      ? `\n<link rel="stylesheet" href="${esc(assetBase)}/assets/portal.css">\n<script src="${esc(
          assetBase,
        )}/assets/portal.js" defer></script>`
      : "";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(prefix)}${esc(title)} - awsbridge</title>${assets}
</head>
<body>
<header><p>${esc(prefix)}awsbridge AWS ログイン</p></header>
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
  /** 階層の印（Admin は `[ADMIN]`）。 */
  mark?: string | undefined;
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
    o.mark,
  );
}

/** GET <team-base>/login（Access の再認証のあとに戻る先）。発行しない。 */
export function loginGetPage(teamBase: string, mark?: string): string {
  return layout(
    "もう一度選んでください",
    `<h1>もう一度選んでください</h1>
<p>ログインはアカウントの画面のボタンからだけ行えます。一覧からアカウントとロールを選び直してください。</p>
<p><a href="${esc(teamBase)}/">一覧へ</a></p>`,
    mark,
  );
}

/** S5 コンソールのセッション切れ（フェデレーションの Issuer の戻り先）。 */
export function expiredPage(teamBase: string, mark?: string): string {
  return layout(
    "コンソールのセッションが切れました",
    `<h1>コンソールのセッションが切れました</h1>
<p>もう一度アカウントとロールを選んでください。</p>
<p><a href="${esc(teamBase)}/">一覧へ</a></p>`,
    mark,
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
  /** 階層の印（Admin は `[ADMIN]`）。 */
  mark?: string | undefined;
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
    o.mark,
  );
}

/**
 * 画面の JS に渡すデータ（JSON）を、エスケープした data-json の属性に入れた要素にする。
 * script の要素を使わない（CSP の script-src 'self' と「inline の script を使わない」に合わせる）。JS は getAttribute で読む。
 */
export function dataElement(value: unknown): string {
  return `<div id="portal-data" data-json="${esc(JSON.stringify(value))}" hidden></div>`;
}

/** 入口の一覧（S0）へのリンク。Standard のパス方式は /、ホスト方式は設定のオリジン、Admin は Standard のオリジン。 */
export function entryHref(config: WorkerConfig, tier: Tier): string | undefined {
  if (tier === "admin")
    return config.portal.peerOrigin !== undefined ? `${config.portal.peerOrigin}/` : undefined;
  return config.portal.routing === "host" ? `${config.portal.origin}/` : "/";
}

/** S1 の 1 行（埋め込みの JSON と画面の表）。ARN・チームの一覧・AUD を持たない表示用の射影。 */
export type ListRow = {
  accountId: string;
  name: string;
  email?: string;
  org: string;
  kind: string;
  roles: { role: string; displayName: string; sessionSeconds: number }[];
};

/** このチームの行だけを、表示用の射影にする（他のチームの割り当て・ARN は落とす）。 */
export function teamRows(config: WorkerConfig, team: string): ListRow[] {
  const roleByName = new Map(config.roles.map((r) => [r.name, r]));
  const orgName = new Map(config.organizations.map((o) => [o.name, o.displayName]));
  const rows: ListRow[] = [];
  for (const a of config.accounts) {
    const roles = a.roles.flatMap((r) => {
      const role = roleByName.get(r.role);
      return role && r.teams.includes(team)
        ? [{ role: role.name, displayName: role.displayName, sessionSeconds: r.sessionSeconds }]
        : [];
    });
    if (roles.length === 0) continue;
    rows.push({
      accountId: a.accountId,
      name: a.name,
      ...(a.email !== undefined ? { email: a.email } : {}),
      org: orgName.get(a.orgLabel) || a.orgLabel,
      kind: a.kind,
      roles,
    });
  }
  return rows.sort(
    (x, y) => x.name.localeCompare(y.name) || x.accountId.localeCompare(y.accountId),
  );
}

/** ?q= の上限（長い値は切り詰める）。 */
export const QUERY_MAX = 128;

/**
 * JS なしの検索（サーバー側の絞り込み）。名前・ID（ハイフンの有無を問わない）・Organization・種類・ロールの部分一致。
 * email は対象にしない（?q= は要求の URL に入り、ログに残りうるため。§5.6）。
 */
export function matchesServerQuery(row: ListRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  const digits = needle.replace(/-/g, "");
  if (/^\d+$/.test(digits) && row.accountId.includes(digits)) return true;
  return [
    row.name,
    row.accountId,
    row.org,
    row.kind,
    ...row.roles.flatMap((r) => [r.displayName, r.role]),
  ].some((s) => s.toLowerCase().includes(needle));
}

export type ListPageOptions = {
  config: WorkerConfig;
  tier: Tier;
  team: string;
  teamBase: string;
  /** ?q= の値（切り詰め済み）。 */
  q: string;
  mark?: string | undefined;
};

/** S1 チームの一覧。行はサーバー側で描き（JS なしでも使える）、JS は埋め込みの JSON から描き直して絞り込む。 */
export function listPage(o: ListPageOptions): string {
  const team = o.config.teams.find((t) => t.name === o.team);
  const teamLabel = `${team?.displayName || o.team} (${o.team})`;
  const all = teamRows(o.config, o.team);
  const shown = all.filter((r) => matchesServerQuery(r, o.q));
  const entry = entryHref(o.config, o.tier);
  const tr = shown
    .map((r) => {
      const links = r.roles
        .map(
          (x) =>
            `<a class="role" href="${esc(`${o.teamBase}/a/${r.accountId}?role=${encodeURIComponent(x.role)}`)}" data-team="${esc(
              o.team,
            )}" data-account="${esc(r.accountId)}" data-role="${esc(x.role)}" data-name="${esc(r.name)}">${esc(
              x.displayName,
            )}</a>`,
        )
        .join(" ");
      return `<tr>
<td><span>${esc(r.name)}</span>${r.email !== undefined ? `<br><small class="email">${esc(r.email)}</small>` : ""}</td>
<td>${esc(r.accountId)}</td><td>${esc(r.org)}</td><td>${esc(r.kind)}</td>
<td>${links}</td>
</tr>`;
    })
    .join("\n");
  const data = { team: o.team, teamBase: o.teamBase, rows: all };
  const list =
    all.length === 0
      ? `<p>このチームで入れるアカウントは一覧にありません。${
          entry !== undefined ? ` <a href="${esc(entry)}">入口の一覧へ</a>` : ""
        }</p>`
      : `<p id="count">${shown.length} 件</p>
<table class="list">
<thead><tr><th>アカウント</th><th>ID</th><th>Organization</th><th>種類</th><th>ロール</th></tr></thead>
<tbody>
${tr}
</tbody>
</table>`;
  const supportUrl = o.config.portal.supportUrl;
  return layout(
    `一覧: ${teamLabel}`,
    `<h1>一覧: ${esc(teamLabel)}</h1>
${entry !== undefined ? `<p><a href="${esc(entry)}">入口の一覧へ</a></p>` : ""}
<form method="get" action="${esc(o.teamBase)}/" role="search">
<label>検索 <input type="search" id="q" name="q" value="${esc(o.q)}" maxlength="${QUERY_MAX}" placeholder="アカウント名・ID・email・Organization"></label>
<button type="submit">絞り込む</button>
</form>
${o.q !== "" ? `<p class="hint" id="q-hint">email で探すには JavaScript が要ります（JavaScript なしの検索は名前・ID・Organization・種類・ロールが対象）。</p>\n` : ""}<section id="favorites" hidden><h2>お気に入り</h2><ul></ul></section>
<section id="recent" hidden><h2>最近使ったもの（このブラウザ）</h2><ul></ul></section>
<p><button type="button" id="clear-local" hidden>このブラウザのお気に入りと最近使ったものを消す</button></p>
${list}
${dataElement(data)}
<p class="note">一覧の更新: ${esc(o.config.generatedAt)}。一覧は目安です。実際に入れるかは各アカウントの設定で決まります。</p>${
      supportUrl !== undefined ? `\n<p><a href="${esc(supportUrl)}">問い合わせ先</a></p>` : ""
    }`,
    o.mark,
    o.teamBase,
  );
}

/** プロファイル名（<アカウント名>-<ロール> を小文字にし、使えない文字は - にする）。 */
export function profileName(accountName: string, role: string): string {
  const s = `${accountName}-${role}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s === "" ? role : s;
}

export type CliPageOptions = {
  config: WorkerConfig;
  tier: Tier;
  team: string;
  teamBase: string;
  account: WorkerAccount;
  /** このチームで入れるロール（行の順）。 */
  roles: { role: WorkerRole; sessionSeconds: number }[];
  /** 選んだロール（無ければ選ぶリンクを出す）。 */
  selected?: { role: WorkerRole; sessionSeconds: number } | undefined;
  /** 「コンソールを開く」の CSRF トークン（selected があるときだけ）。 */
  csrf?: string | undefined;
  mark?: string | undefined;
};

/** S3 aws login の手順（§4.4・§6.5）。表示するのは行の情報から作った文字列だけで、認証情報・URL・トークン・email を含まない。 */
export function cliPage(o: CliPageOptions): string {
  const a = o.account;
  const back = `<p><a href="${esc(o.teamBase)}/a/${esc(a.accountId)}">← 戻る</a></p>`;
  if (!o.selected) {
    const items = o.roles
      .map(
        ({ role }) =>
          `<li><a href="${esc(`${o.teamBase}/a/${a.accountId}/cli?role=${encodeURIComponent(role.name)}`)}">${esc(
            role.displayName,
          )}（${esc(role.roleName)}）</a></li>`,
      )
      .join("\n");
    return layout(
      `CLI で使う: ${a.name}`,
      `${back}
<h1>CLI で使う: ${esc(a.name)}（${esc(a.accountId)}）</h1>
<p>ロールを選んでください。</p>
<ul>
${items}
</ul>`,
      o.mark,
      o.teamBase,
    );
  }
  const { role, sessionSeconds } = o.selected;
  const profile = profileName(a.name, role.name);
  const region = resolveRegion(undefined, o.config.portal.regions);
  const remote =
    o.tier === "admin"
      ? `<p>aws login は同じ端末だけです（--remote は使えません）。</p>`
      : `<p>ブラウザのない端末では <code>aws login --remote</code> も使えます（Viewer だけ）。</p>`;
  return layout(
    `CLI で使う: ${a.name} / ${role.displayName}`,
    `${back}
<h1>CLI で使う: ${esc(a.name)} / ${esc(role.displayName)}</h1>
<p>前提: AWS CLI 2.32.0 以降。このロールのコンソールを、既定のブラウザで開いてあること。</p>
<ol>
<li>コンソールを開く（まだなら）
<form method="post" action="${esc(o.teamBase)}/login" target="_blank" rel="noopener noreferrer">
<input type="hidden" name="entry" value="${esc(`${a.accountId}:${role.name}`)}">
<input type="hidden" name="region" value="${esc(region)}">
<input type="hidden" name="csrf" value="${esc(o.csrf ?? "")}">
<button type="submit">コンソールを開く（新しいタブ）</button>
</form></li>
<li>~/.aws/config に追記する（プロファイル名は変えてよい）
<pre><code>[profile ${esc(profile)}]
region = ${esc(region)}</code></pre></li>
<li>端末で実行する
<pre><code>aws login --profile ${esc(profile)}</code></pre></li>
<li>開いたブラウザで、次のセッションを選ぶ: アカウント ${esc(a.accountId)} / ${esc(role.roleName)} / console-&lt;あなたのメールアドレス&gt;。
既定のブラウザが別なら、表示された URL を、コンソールを開いたブラウザに貼る。</li>
<li>確かめる: <code>aws sts get-caller-identity --profile ${esc(profile)}</code></li>
</ol>
<p>認証情報は 15 分ごとに自動で更新され、最長でセッションの長さ（${esc(hours(sessionSeconds))}）まで使えます。</p>
<p>終わったら: <code>aws logout --profile ${esc(profile)}</code></p>
${remote}
<ul class="note">
<li>自分で始めた URL だけ開く。</li>
<li>表示されたコードを人に渡さない。</li>
<li>一覧で選ぶセッション（アカウントとロール）を確かめる。</li>
<li>共有の端末では aws logout する。</li>
</ul>`,
    o.mark,
    o.teamBase,
  );
}
