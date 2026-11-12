// コンソールログイン（表示用）: 入口（S0）の 1 つの一覧の画面（docs/specs/console-login-portal.md §4.1・§5.4・§5.6・§7）。
// 所属するチーム（表示用の照合の結果）の行だけを出す。行のロールは、その行のチームのパスの S2 へのリンク（GET）。
// Administrator の行は Admin のオリジンの S2 へのリンクで、[ADMIN] の印を付ける。この画面では発行しない。
// アカウントの email は出さない（S0 には出さない。§5.6）。AUD・ロールの ARN は表示用の生成物に無い。
// 発行の経路（portal/login.ts・issue/*）はこのモジュールを import しない。
import type { Tier } from "../constants";
import { ADMIN_MARK, dataElement, esc, layout } from "../portal/pages";
import type { DisplayAccount, DisplayConfig } from "../types";
import type { Membership } from "./groups";

/** チームの起点（パス方式は /t/<team> か Admin のオリジンの /t/<team>、ホスト方式は https://<team>.<host>）。 */
export function teamBaseFor(display: DisplayConfig, team: string, tier: Tier): string | undefined {
  const origin = tier === "admin" ? display.portal.adminOrigin : display.portal.origin;
  if (origin === undefined) return undefined;
  if (display.portal.routing === "host") {
    const u = new URL(origin);
    return `${u.protocol}//${team}.${u.host}`;
  }
  return tier === "admin" ? `${origin}/t/${team}` : `/t/${team}`;
}

export type EntryRow = {
  tier: Tier;
  accountId: string;
  name: string;
  org: string;
  /** この行で入れるロール × チーム（所属するチームだけ）。 */
  links: { role: string; roleDisplayName: string; team: string; href: string }[];
};

/** 所属するチームの行を作る（他のチームの割り当ては出さない）。 */
export function entryRows(display: DisplayConfig, teams: ReadonlySet<string>): EntryRow[] {
  const teamTier = new Map(display.teams.map((t) => [t.name, t.tier]));
  const roleName = new Map(display.roles.map((r) => [r.name, r.displayName]));
  const orgName = new Map(display.organizations.map((o) => [o.name, o.displayName]));
  const rows: EntryRow[] = [];
  for (const a of display.accounts) {
    const links = a.roles.flatMap((r) =>
      r.teams.flatMap((team) => {
        if (!teams.has(team) || teamTier.get(team) !== a.tier) return [];
        const base = teamBaseFor(display, team, a.tier);
        if (base === undefined) return [];
        return [
          {
            role: r.role,
            roleDisplayName: roleName.get(r.role) ?? r.role,
            team,
            href: `${base}/a/${a.accountId}?role=${encodeURIComponent(r.role)}`,
          },
        ];
      }),
    );
    if (links.length > 0) rows.push(rowOf(a, orgName, links));
  }
  return rows.sort(
    (x, y) => x.name.localeCompare(y.name) || x.accountId.localeCompare(y.accountId),
  );
}

function rowOf(
  a: DisplayAccount,
  orgName: Map<string, string>,
  links: EntryRow["links"],
): EntryRow {
  return {
    tier: a.tier,
    accountId: a.accountId,
    name: a.name,
    org: orgName.get(a.orgLabel) ?? a.orgLabel,
    links,
  };
}

const markOf = (tier: Tier) => (tier === "admin" ? ` ${ADMIN_MARK}` : "");

function teamLinks(display: DisplayConfig, names?: ReadonlySet<string>): string {
  const items = display.teams.flatMap((t) => {
    if (names && !names.has(t.name)) return [];
    const base = teamBaseFor(display, t.name, t.tier);
    if (base === undefined) return [];
    const label = `${t.displayName || t.name} (${t.name})${markOf(t.tier)}`;
    return [`<li><a href="${esc(`${base}/`)}">${esc(label)}</a></li>`];
  });
  return `<ul class="teams">\n${items.join("\n")}\n</ul>`;
}

const footer = (display: DisplayConfig) =>
  `<p class="note">一覧は目安です。入れるかどうかは、選んだあとにチームのアプリと AWS で決まります。</p>${
    display.portal.supportUrl !== undefined
      ? `\n<p><a href="${esc(display.portal.supportUrl)}">問い合わせ先</a></p>`
      : ""
  }`;

/** 最近使ったもの（localStorage）のリンクを作るための、画面に出すチームの起点（他の値は入れない）。 */
function teamBases(display: DisplayConfig, names?: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of display.teams) {
    if (names && !names.has(t.name)) continue;
    const base = teamBaseFor(display, t.name, t.tier);
    if (base !== undefined) out[t.name] = base;
  }
  return out;
}

/** 起点を渡すチームのうち Admin の階層のもの（最近使ったもののリンクに [ADMIN] の印を付けるため）。 */
const adminTeams = (display: DisplayConfig, bases: Record<string, string>): string[] =>
  display.teams
    .filter((t) => t.tier === "admin" && Object.hasOwn(bases, t.name))
    .map((t) => t.name);

/** S0 入口の画面。 */
export function entryPage(display: DisplayConfig, membership: Membership): string {
  let body: string;
  if (membership.status === "unknown") {
    body = `<h1>AWS ログイン</h1>
<p role="status">所属を確かめられませんでした。チームを選んでください（所属していないチームは Access の画面で拒否されます）。</p>
${teamLinks(display)}`;
  } else if (membership.status === "none") {
    body = `<h1>AWS ログイン</h1>
<p role="status">所属しているチームがありません。所属が要るなら、申請先に依頼してください。</p>`;
  } else {
    const rows = entryRows(display, membership.teams);
    const teamNames = display.teams
      .filter((t) => membership.teams.has(t.name))
      .map((t) => `${t.displayName || t.name}${markOf(t.tier)}`);
    const tr = rows
      .map(
        (r) => `<tr data-account="${esc(r.accountId)}">
<td>${esc(r.name)}</td><td>${esc(r.accountId)}</td><td>${esc(r.org)}</td>
<td>${r.links
          .map(
            (l) =>
              `<a class="role" href="${esc(l.href)}" data-team="${esc(l.team)}" data-account="${esc(
                r.accountId,
              )}" data-role="${esc(l.role)}" data-name="${esc(r.name)}">${esc(
                `${l.roleDisplayName} · ${l.team}`,
              )}${esc(markOf(r.tier))}</a>`,
          )
          .join(" ")}</td>
</tr>`,
      )
      .join("\n");
    body = `<h1>AWS ログイン</h1>
<h2>あなたが入れるもの（所属: ${esc(teamNames.join("・"))}）</h2>
${
  rows.length > 0
    ? `<table class="list">
<thead><tr><th>アカウント</th><th>ID</th><th>Organization</th><th>ロール</th></tr></thead>
<tbody>
${tr}
</tbody>
</table>`
    : "<p>入れるアカウントは一覧にありません。</p>"
}
<details><summary>チームのページ</summary>
${teamLinks(display, membership.teams)}
</details>`;
  }
  const bases =
    membership.status === "member"
      ? teamBases(display, membership.teams)
      : membership.status === "unknown"
        ? teamBases(display)
        : {};
  const recent = `<section id="recent" hidden><h2>最近使ったもの（このブラウザ）</h2><ul></ul></section>
<p><button type="button" id="clear-local" hidden>このブラウザのお気に入りと最近使ったものを消す</button></p>
${dataElement({ teams: bases, adminTeams: adminTeams(display, bases) })}`;
  return layout("AWS ログイン", `${body}\n${recent}\n${footer(display)}`, undefined, "");
}
