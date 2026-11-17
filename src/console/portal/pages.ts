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

/** 再び選び直す操作の案内（CSRF・送信の形の誤りなど、選び直せば通るもの）。 */
const RESELECT =
  "一覧からアカウントとロールを選び直し、もう一度「コンソールを開く」を押してください。";
const RETRY_LATER =
  "しばらく待ってから、もう一度お試しください。続くときは、下の情報を貼って問い合わせ先へ連絡してください。";
const CONTACT = "下の情報を貼って、問い合わせ先へ連絡してください。";

/**
 * S4 の本文（§4.6 の「本文の要点」と「利用者の次の操作」）。what は何が起きたか、next はどうすればよいか。
 * 見出し（ERROR_TITLES）と code の意味は変えない。内部の詳細（STS の本文など）は書かない。
 */
const ERROR_GUIDE: Record<
  keyof typeof ERROR_TITLES,
  { what: string; next: string; causes?: string[] }
> = {
  unauthorized: {
    what: "ログイン（Cloudflare Access）を確かめられませんでした。ログインの期限が切れた可能性があります。",
    next: "ページを読み込み直してログインし直し、一覧から選び直してください。",
  },
  unknown_audience: {
    what: "このページは、いまログインしているアプリからは開けません。",
    next: "入口の一覧から開き直してください。続くときは、下の情報を貼って問い合わせ先へ連絡してください。",
  },
  team_mismatch: {
    what: "ログインしているチームと、このページのチームが違います。",
    next: "一覧から、このチームのページを開き直してください。",
  },
  forbidden_origin: {
    what: "送られた操作が、このポータルの画面からのものと確かめられなかったため、受け付けませんでした。",
    next: RESELECT,
  },
  unsupported_media_type: {
    what: "送られた内容の形が、このポータルの画面から送るものと違ったため、受け付けませんでした。",
    next: RESELECT,
  },
  csrf_failed: {
    what: "画面を開いてから時間がたったか、別のタブで操作されたため、この操作を受け付けられませんでした。",
    next: RESELECT,
  },
  login_disabled: {
    what: "運用者がログインを一時的に止めています。",
    next: "運用者の案内に従ってください。急ぐときは問い合わせ先へ連絡してください。",
  },
  rate_limited: {
    what: "短い時間に送った回数が多すぎたため、受け付けませんでした。",
    next: "少し待ってから、もう一度お試しください。",
  },
  not_listed: {
    what: "このチームの一覧に、このアカウントとロールの組み合わせがありません。古いページやブックマークから開いた可能性があります。",
    next: "一覧を開き直して、アカウントとロールを選び直してください。",
  },
  identity_unsupported: {
    what: "あなたの利用者名が、AWS に渡せる形（長さと使える文字）に合いませんでした。",
    next: CONTACT,
  },
  sts_denied: {
    what: "一覧には出ていましたが、AWS がこのロールへの切り替えを断りました。",
    next: CONTACT,
    causes: [
      "一覧に、権限の変更がまだ反映されていない",
      "先方のアカウントの設定が、まだ更新されていない",
      "このチームの権限が外された",
    ],
  },
  upstream_auth_failed: {
    what: "AWS が、このポータルからのログインを受け付けませんでした。設定が合っていないか、緊急に止めている可能性があります。",
    next: CONTACT,
  },
  temporarily_unavailable: {
    what: "AWS などの接続先に一時的につながらず、処理を続けられませんでした。",
    next: RETRY_LATER,
  },
  signin_failed: {
    what: "AWS のサインインの準備に失敗しました。",
    next: RETRY_LATER,
  },
  server_misconfigured: {
    what: "ポータルの設定に問題があり、処理を続けられませんでした。利用者の側で直せることはありません。",
    next: CONTACT,
  },
  signing_unavailable: {
    what: "ログインに使う署名の仕組みが、いまは使えません。",
    next: RETRY_LATER,
  },
  method_not_allowed: {
    what: "このページは、この方法の操作を受け付けていません。",
    next: "一覧から開き直してください。",
  },
  not_found: {
    what: "指定されたページはありません。URL が古いか、間違っている可能性があります。",
    next: "一覧から開き直してください。",
  },
  payload_too_large: {
    what: "送られた内容が大きすぎたため、受け付けませんでした。",
    next: RESELECT,
  },
};

/** Admin の画面の印（見出しとタブのタイトルの先頭に付ける）。区別を残すかは人の確認待ち（§12.1）で、既定は残す案。 */
export const ADMIN_MARK = "[ADMIN]";

/** 階層の画面の印。Standard は付けない。 */
export const tierMark = (tier: Tier): string | undefined =>
  tier === "admin" ? ADMIN_MARK : undefined;

/** ヘッダーの印（Standard）。inline の SVG（style の属性を使わない。色は CSS の currentColor）。 */
const LOGO_SVG =
  '<svg class="logo" width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><rect x="4" y="2.5" width="18" height="21" rx="2.5"></rect><path d="M4 8.5h18"></path><circle cx="13" cy="14" r="2.6"></circle><path d="M8.5 20c1-2.2 2.6-3.2 4.5-3.2s3.5 1 4.5 3.2"></path></svg>';

/** エラーの印（S4）。 */
const ERROR_SVG =
  '<svg class="icon" width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="9"></circle><path d="M7.5 7.5l7 7M14.5 7.5l-7 7"></path></svg>';

export type LayoutOptions = {
  /** false なら CSS だけを読み、画面の JS は読まない（JS の要らない画面）。既定 true。 */
  js?: boolean;
};

/**
 * 画面の枠。Admin（mark あり）は body のクラス tier-admin とヘッダーの文字の印で区別する（CSS が読めなくても文字は残る）。
 * Standard は tier-standard で、Admin の印・語を出さない。
 * @param assetBase 静的なファイルを読む起点（入口は ""、チームのページは <team-base>）。渡したときだけ CSS（と JS）を読む
 */
export function layout(
  title: string,
  body: string,
  mark?: string,
  assetBase?: string,
  o: LayoutOptions = {},
): string {
  const prefix = mark !== undefined ? `${mark} ` : "";
  const css =
    assetBase !== undefined
      ? `\n<link rel="stylesheet" href="${esc(assetBase)}/assets/portal.css">`
      : "";
  const js =
    assetBase !== undefined && o.js !== false
      ? `\n<script src="${esc(assetBase)}/assets/portal.js" defer></script>`
      : "";
  const tier = mark !== undefined ? "tier-admin" : "tier-standard";
  const brand = mark !== undefined ? "AWS ログイン（管理者）" : "AWS ログイン";
  const lead = mark !== undefined ? esc(prefix) : LOGO_SVG;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(prefix)}${esc(title)} - awsbridge</title>${css}${js}
</head>
<body class="${tier}">
<header><p>${lead}<span class="brand">${brand}</span><span class="sub">awsbridge</span></p></header>
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
  /** CSS を読む起点。省けば teamBase（チームが分からなければ CSS を読まない）。入口は ""。 */
  assetBase?: string | undefined;
};

/**
 * S4 エラー。何が起きたか・どうすればよいか・問い合わせに貼る情報。内部の詳細（STS の本文・例外の文）は出さない。
 * 貼る情報の行（`code <code>…</code> 要求 ID <code>…</code>`）の形は G2 の測定の道具（poc の issue-lib）が読むので変えない。
 */
export function errorPage(code: keyof typeof ERROR_TITLES, o: ErrorPageOptions = {}): string {
  const title = ERROR_TITLES[code];
  const guide = ERROR_GUIDE[code];
  const causes =
    guide.causes !== undefined
      ? `\n<section class="card"><h2>考えられる原因</h2>
<ul class="causes">
${guide.causes.map((c) => `<li>${esc(c)}</li>`).join("\n")}
</ul>
<p class="note">どれに当たるかは、ポータルからは区別できません。</p></section>`
      : "";
  const support = o.supportUrl !== undefined;
  const actions = [
    ...(support
      ? [`<a class="button primary" href="${esc(o.supportUrl as string)}">問い合わせ先を開く</a>`]
      : []),
    ...(o.teamBase !== undefined
      ? [`<a class="button${support ? "" : " primary"}" href="${esc(o.teamBase)}/">一覧へ戻る</a>`]
      : []),
  ];
  return layout(
    title,
    `<p class="error-head">${ERROR_SVG}<span>エラー</span></p>
<h1>${esc(title)}</h1>
<p class="error-what">${esc(guide.what)}</p>${causes}
<section class="card"><h2>次にすること</h2>
<p class="error-next">${esc(guide.next)}</p></section>
<section class="card"><h2>問い合わせるときに貼る情報</h2>
<p class="paste">code <code>${esc(code)}</code>${
      o.requestId ? ` 要求 ID <code>${esc(o.requestId)}</code>` : ""
    }</p></section>
${actions.length > 0 ? `<p class="actions">${actions.join("\n")}</p>` : ""}`,
    o.mark,
    o.assetBase ?? o.teamBase,
    { js: false },
  );
}

/** GET <team-base>/login（Access の再認証のあとに戻る先）。発行しない。 */
export function loginGetPage(teamBase: string, mark?: string): string {
  return layout(
    "もう一度選んでください",
    `<h1>もう一度選んでください</h1>
<section class="card">
<p>ログインはアカウントの画面のボタンからだけ行えます。一覧からアカウントとロールを選び直してください。</p>
</section>
<p class="actions"><a class="button primary" href="${esc(teamBase)}/">一覧へ</a></p>`,
    mark,
    teamBase,
    { js: false },
  );
}

/** S5 コンソールのセッション切れ（フェデレーションの Issuer の戻り先）。 */
export function expiredPage(teamBase: string, mark?: string): string {
  return layout(
    "コンソールのセッションが切れました",
    `<h1>コンソールのセッションが切れました</h1>
<section class="card">
<p>もう一度アカウントとロールを選んでください。</p>
</section>
<p class="actions"><a class="button primary" href="${esc(teamBase)}/">一覧へ</a></p>`,
    mark,
    teamBase,
    { js: false },
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

/**
 * S2 アカウントの詳細とログイン（POST <team-base>/login のフォーム。hidden に csrf）。
 * form の rel に noreferrer を付けない。付けると送信の referrer policy が no-referrer になり、ブラウザは POST の Origin を
 * "null" で送って自分の検査（Origin の一致）で 403 になる。Referer を AWS へ送らないのは Referrer-Policy: same-origin と
 * <meta name="referrer"> で満たす（noopener だけ残す）。
 */
export function loginFormPage(o: LoginFormOptions): string {
  const team = o.config.teams.find((t) => t.name === o.team);
  const admin = o.mark !== undefined;
  const selected =
    o.roles.find((r) => r.role.name === o.selectedRole)?.role.name ??
    (o.roles.length === 1 ? o.roles[0]?.role.name : undefined);
  const roleItems = o.roles
    .map(({ role, sessionSeconds }) => {
      const value = `${o.account.accountId}:${role.name}`;
      const checked = role.name === selected ? " checked" : "";
      return `<li><label><input type="radio" name="entry" value="${esc(value)}" required${checked}> <span class="role-text"><span class="role-name">${esc(
        role.displayName,
      )}</span><span class="role-iam">（${esc(role.roleName)}）</span></span><span class="session">セッション: ${esc(
        hours(sessionSeconds),
      )}</span></label></li>`;
    })
    .join("\n");
  const regions = o.config.portal.regions;
  const regionField = regions
    ? `<p><label class="field">リージョン <select name="region">${regions.allowed
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
  const org =
    o.config.organizations.find((x) => x.name === o.account.orgLabel)?.displayName ||
    o.account.orgLabel;
  const teamLabel = `${team?.displayName || o.team} (${o.team})`;
  // Admin は帯・注意・ボタンの文で、管理者の権限で入ることを示す（U-18 の既定の案。Standard には出さない）
  const adminNotes = admin
    ? `\n<ul class="admin-notes">
<li>管理者の権限で入ります。開く先のアカウントを確かめてから開いてください。</li>
<li>入ったことは、チームの名前とともに記録されます（CloudTrail）。</li>
<li>aws login は同じ端末だけです（--remote は使えません）。</li>
</ul>`
    : "";
  const cliHref = `${o.teamBase}/a/${o.account.accountId}/cli${
    selected !== undefined ? `?role=${encodeURIComponent(selected)}` : ""
  }`;
  return layout(
    title,
    `${notice}<p class="back"><a href="${esc(o.teamBase)}/">← 一覧へ</a></p>
<form method="post" action="${esc(o.teamBase)}/login" target="_blank" rel="noopener">
<section class="pass" aria-label="開く先">
<div class="pass-head"><span class="pass-tier">${admin ? `${esc(o.mark as string)} 管理者` : "Standard"}</span><span>チーム: ${esc(teamLabel)}</span></div>
<div class="pass-body">
<h1>${esc(o.account.name)}</h1>
<dl class="facts"><dt>アカウント ID</dt><dd class="mono">${esc(o.account.accountId)}</dd><dt>Organization</dt><dd>${esc(org)}</dd></dl>${adminNotes}
<fieldset>
<legend>ロール（このチームで入れるもの）</legend>
<ul class="roles">
${roleItems}
</ul>
</fieldset>
${regionField}
</div>
</section>
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
<p class="submit"><button type="submit">${admin ? "管理者のロールで" : ""}コンソールを開く（新しいタブ）</button></p>
</form>
<p class="links"><a href="${esc(cliHref)}">CLI で使う（aws login）</a></p>
<section class="card"><h2>切り替わらないとき</h2>
<p>開いたコンソールが別のアカウント・ロールのままのとき（または Credentials invalid になるとき）は、開いているコンソールでサインアウトしてから、もう一度「コンソールを開く」を押してください。</p></section>`,
    o.mark,
    o.teamBase,
    { js: false },
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
${entry !== undefined ? `<p class="back"><a href="${esc(entry)}">← 入口の一覧へ</a></p>` : ""}
<form method="get" action="${esc(o.teamBase)}/" role="search">
<label class="field">検索 <input type="search" id="q" name="q" value="${esc(o.q)}" maxlength="${QUERY_MAX}" placeholder="アカウント名・ID・email・Organization"></label>
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
  const back = `<p class="back"><a href="${esc(o.teamBase)}/a/${esc(a.accountId)}">← 戻る</a></p>`;
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
<ul class="choices">
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
<ol class="steps">
<li>コンソールを開く（まだなら）
<form method="post" action="${esc(o.teamBase)}/login" target="_blank" rel="noopener">
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
