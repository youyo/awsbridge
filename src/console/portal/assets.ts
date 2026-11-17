// コンソールログイン: ポータルの静的なファイル（docs/specs/console-login-portal.md §9.2・§9.6）。
// /assets/<name>（入口）と /t/<team>/assets/<name>（チーム）から返す。中身は同じで、秘密を含まない。
// Workers の静的アセットは Worker より先に返す（Admin の「チームのパス以外は 404」・issuer のホストの 404 を飛ばす）ので使わず、
// バンドルに埋め込んで Worker から返す。CSP（script-src 'self'・style-src 'self'）に合わせ、外部の script・CDN を使わない。
//
// 画面の JS（PORTAL_JS）がすること（JS が無くても画面は使える。検索は ?q= のサーバー側の絞り込みに落ちる）:
//   - 一覧（S1）: 画面に埋め込んだ JSON（<div id="portal-data" data-json="...">。script の要素は使わない）から行を描き直し、
//     名前・ID（ハイフンの有無を問わない）・email（大文字と小文字を区別しない）・Organization・種類・ロールで絞り込む
//   - お気に入り・最近使ったもの: localStorage（チーム・アカウント ID・アカウント名・ロール・時刻だけ。email・URL・トークンは置かない）
//   - 消去のボタン
// DOM は createElement と textContent だけで組む（innerHTML を使わない）。
// node の API を使わない。Admin の Worker も使う（チームのパスの下だけ）。

/** 静的なファイルの応答（no-store にしない）を見分ける印。 */
const STATIC_RESPONSES = new WeakSet<Response>();

export const isStaticResponse = (res: Response): boolean => STATIC_RESPONSES.has(res);

/** localStorage のキー（ブラウザの中だけ。サーバーには送らない）。 */
export const STORAGE_KEYS = {
  favorites: "awsbridge.console.favorites",
  recent: "awsbridge.console.recent",
} as const;

export const PORTAL_JS = String.raw`"use strict";
var STORAGE_KEYS = { favorites: "awsbridge.console.favorites", recent: "awsbridge.console.recent" };
var RECENT_MAX = 10;
var FAVORITES_MAX = 50;
var NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
var ACCOUNT_RE = /^\d{12}$/;

function norm(s) {
  return String(s == null ? "" : s).toLowerCase();
}

// 検索: 名前・ID（ハイフンの有無を問わない）・email・Organization・種類・ロールの部分一致（大文字と小文字を区別しない）
function matches(row, q) {
  var needle = norm(q).trim();
  if (needle === "") return true;
  var digits = needle.replace(/-/g, "");
  if (/^\d+$/.test(digits) && String(row.accountId).indexOf(digits) >= 0) return true;
  var hay = [row.name, row.accountId, row.email, row.org, row.kind];
  var roles = Array.isArray(row.roles) ? row.roles : [];
  for (var i = 0; i < roles.length; i++) hay.push(roles[i].displayName, roles[i].role);
  for (var j = 0; j < hay.length; j++) {
    if (hay[j] != null && norm(hay[j]).indexOf(needle) >= 0) return true;
  }
  return false;
}

// localStorage の 1 件（email・URL を持たない形にそろえる。崩れたものは捨てる）
function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.team !== "string" || !NAME_RE.test(e.team)) return null;
  if (typeof e.accountId !== "string" || !ACCOUNT_RE.test(e.accountId)) return null;
  if (typeof e.role !== "string" || !NAME_RE.test(e.role)) return null;
  var out = { team: e.team, accountId: e.accountId, role: e.role, name: "", t: 0 };
  if (typeof e.name === "string") out.name = e.name.slice(0, 128);
  if (typeof e.t === "number" && isFinite(e.t)) out.t = e.t;
  return out;
}

function parseList(text, max) {
  var v;
  try {
    v = JSON.parse(text || "[]");
  } catch (err) {
    return [];
  }
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < max; i++) {
    var c = cleanEntry(v[i]);
    if (c) out.push(c);
  }
  return out;
}

function sameEntry(a, b) {
  return a.team === b.team && a.accountId === b.accountId && a.role === b.role;
}

function recordRecent(list, entry, now) {
  var c = cleanEntry(entry);
  if (!c) return list;
  c.t = now;
  var rest = list.filter(function (x) {
    return !sameEntry(x, c);
  });
  return [c].concat(rest).slice(0, RECENT_MAX);
}

function toggleFavorite(list, entry) {
  var c = cleanEntry(entry);
  if (!c) return list;
  var has = list.some(function (x) {
    return sameEntry(x, c);
  });
  if (has)
    return list.filter(function (x) {
      return !sameEntry(x, c);
    });
  return list.concat([c]).slice(0, FAVORITES_MAX);
}

function storageGet(key, max) {
  try {
    return parseList(window.localStorage.getItem(key), max);
  } catch (err) {
    return [];
  }
}

function storageSet(key, list) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch (err) {}
}

function el(tag, text, cls) {
  var n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function roleLink(base, entry, label) {
  var a = el("a", label, "role");
  a.href = base + "/a/" + entry.accountId + "?role=" + encodeURIComponent(entry.role);
  a.setAttribute("data-team", entry.team);
  a.setAttribute("data-account", entry.accountId);
  a.setAttribute("data-role", entry.role);
  a.setAttribute("data-name", entry.name);
  return a;
}

function renderEntries(section, entries, bases, adminTeams) {
  if (!section) return;
  var ul = section.querySelector("ul");
  if (!ul) return;
  while (ul.firstChild) ul.removeChild(ul.firstChild);
  var shown = 0;
  entries.forEach(function (e) {
    var base = bases[e.team];
    if (typeof base !== "string") return;
    var li = el("li");
    var admin = adminTeams.indexOf(e.team) >= 0;
    var link = roleLink(base, e, e.name + " (" + e.accountId + ") " + e.role + " · " + e.team + (admin ? " [ADMIN]" : ""));
    if (admin) link.className = "role role-admin";
    li.appendChild(link);
    ul.appendChild(li);
    shown++;
  });
  section.hidden = shown === 0;
}

function main() {
  var dataEl = document.getElementById("portal-data");
  var data = {};
  if (dataEl) {
    try {
      data = JSON.parse(dataEl.getAttribute("data-json") || "{}");
    } catch (err) {
      data = {};
    }
  }
  var adminTeams = Array.isArray(data.adminTeams) ? data.adminTeams : [];
  var bases = data.teams && typeof data.teams === "object" ? data.teams : {};
  if (typeof data.team === "string" && typeof data.teamBase === "string") {
    bases = {};
    bases[data.team] = data.teamBase;
  }
  var favSection = document.getElementById("favorites");
  var recentSection = document.getElementById("recent");
  var clear = document.getElementById("clear-local");

  function refresh() {
    renderEntries(favSection, storageGet(STORAGE_KEYS.favorites, FAVORITES_MAX), bases, adminTeams);
    renderEntries(recentSection, storageGet(STORAGE_KEYS.recent, RECENT_MAX), bases, adminTeams);
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var a = t && t.closest ? t.closest("a.role") : null;
    if (a) {
      var entry = {
        team: a.getAttribute("data-team"),
        accountId: a.getAttribute("data-account"),
        role: a.getAttribute("data-role"),
        name: a.getAttribute("data-name"),
      };
      storageSet(STORAGE_KEYS.recent, recordRecent(storageGet(STORAGE_KEYS.recent, RECENT_MAX), entry, Date.now()));
      return;
    }
    var star = t && t.closest ? t.closest("button.star") : null;
    if (star) {
      var fav = {
        team: star.getAttribute("data-team"),
        accountId: star.getAttribute("data-account"),
        role: star.getAttribute("data-role"),
        name: star.getAttribute("data-name"),
      };
      storageSet(STORAGE_KEYS.favorites, toggleFavorite(storageGet(STORAGE_KEYS.favorites, FAVORITES_MAX), fav));
      refresh();
      renderStars();
    }
  });

  if (clear) {
    clear.hidden = false;
    clear.addEventListener("click", function () {
      try {
        window.localStorage.removeItem(STORAGE_KEYS.favorites);
        window.localStorage.removeItem(STORAGE_KEYS.recent);
      } catch (err) {}
      refresh();
      renderStars();
    });
  }

  var tbody = document.querySelector("table.list tbody");
  var rows = Array.isArray(data.rows) ? data.rows : null;
  var input = document.getElementById("q");
  var hint = document.getElementById("q-hint");
  var count = document.getElementById("count");

  function renderStars() {
    if (!tbody) return;
    var favs = storageGet(STORAGE_KEYS.favorites, FAVORITES_MAX);
    var stars = tbody.querySelectorAll("button.star");
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var on = favs.some(function (f) {
        return (
          f.team === s.getAttribute("data-team") &&
          f.accountId === s.getAttribute("data-account") &&
          f.role === s.getAttribute("data-role")
        );
      });
      s.textContent = on ? "★" : "☆";
      s.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function renderRows() {
    if (!tbody || !rows) return;
    var q = input ? input.value : "";
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    var n = 0;
    rows.forEach(function (row) {
      if (!matches(row, q)) return;
      n++;
      var tr = el("tr");
      var nameTd = el("td");
      nameTd.appendChild(el("span", row.name));
      if (typeof row.email === "string") {
        nameTd.appendChild(el("br"));
        nameTd.appendChild(el("small", row.email, "email"));
      }
      tr.appendChild(nameTd);
      tr.appendChild(el("td", row.accountId));
      tr.appendChild(el("td", row.org));
      tr.appendChild(el("td", row.kind));
      var rolesTd = el("td");
      (row.roles || []).forEach(function (r) {
        var entry = { team: data.team, accountId: row.accountId, role: r.role, name: row.name };
        var star = el("button", "☆", "star");
        star.type = "button";
        star.setAttribute("aria-label", "お気に入り");
        star.setAttribute("data-team", entry.team);
        star.setAttribute("data-account", entry.accountId);
        star.setAttribute("data-role", entry.role);
        star.setAttribute("data-name", entry.name);
        rolesTd.appendChild(star);
        rolesTd.appendChild(roleLink(data.teamBase, entry, r.displayName));
        rolesTd.appendChild(document.createTextNode(" "));
      });
      tr.appendChild(rolesTd);
      tbody.appendChild(tr);
    });
    if (count) count.textContent = n + " 件";
    renderStars();
  }

  if (input) {
    var form = input.form;
    if (form)
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        renderRows();
      });
    input.addEventListener("input", renderRows);
    if (hint) hint.hidden = true;
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "/" && document.activeElement !== input) {
        ev.preventDefault();
        input.focus();
      }
    });
  }
  renderRows();
  refresh();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
}
`;

// 画面の CSS（デザイン案 A「通行証」）。色は変数で持ち、Admin の画面（body.tier-admin）は差し色を朱（--admin）に替える。
// 書体は Web フォントを同梱せず、スタックで指定する（外部の URL・@import・@font-face を使わない。CSP の style-src 'self'・img-src 'self'）。
// 表（table.list）は、どの幅でもカードとして並べる（行は PORTAL_JS が描き直すので、クラスではなく要素の位置で当てる）。
export const PORTAL_CSS = `:root {
  --bg: #ECEFF2; --surface: #FFFFFF; --text: #1B2430; --muted: #556070; --line: #CBD3DC; --line-strong: #A9B4C0;
  --accent: #2C5C8F; --accent-strong: #1E4470; --accent-soft: #F2F6FA; --on-accent: #FFFFFF;
  --admin: #B5471A; --admin-strong: #9A3B12; --on-admin: #FFFFFF; --danger: #9A3B12; --code-bg: #F2F4F7;
  --radius: 10px;
  --mono: "BIZ UDGothic", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
.tier-admin { --bg: #F4ECE8; --line: #E2C9BE; --accent: var(--admin); --accent-strong: var(--admin-strong); --accent-soft: #FBF1EC; --on-accent: var(--on-admin); --radius: 4px; }
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: "BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif; font-size: 15px; line-height: 1.6; overflow-wrap: anywhere; }
a { color: var(--accent); }
a:hover { color: var(--accent-strong); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
header { background: var(--surface); border-bottom: 1px solid var(--line); }
header p { max-width: 48rem; min-height: 60px; margin: 0 auto; padding: 8px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-weight: 700; }
header .logo { flex: none; color: var(--accent); }
header .brand { font-size: 16px; }
header .sub { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--muted); }
.tier-admin header { background: var(--accent); color: var(--on-accent); border-bottom: 0; }
.tier-admin header p { letter-spacing: 0.06em; }
.tier-admin header .sub { color: inherit; }
main { display: block; max-width: 48rem; margin: 0 auto; padding: 20px 16px 40px; }
h1 { margin: 0; font-size: 22px; line-height: 1.4; letter-spacing: 0.02em; }
h2 { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: var(--muted); }
p { margin: 0; }
main > * { margin-top: 0; margin-bottom: 0; }
main > * + * { margin-top: 16px; }
main > h1 + h2, main > .back + * { margin-top: 4px; }
code, pre, .mono { font-family: var(--mono); }
.back a, .links a { display: inline-flex; align-items: center; min-height: 44px; font-size: 14px; font-weight: 700; text-decoration: none; }
.card { padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.card p + p { margin-top: 8px; }
.note, .hint { color: var(--muted); font-size: 12px; }
ul.note { padding-left: 1.2em; }
p[role="alert"] { padding: 12px 14px; border: 1.5px solid var(--danger); border-radius: 8px; background: var(--surface); color: var(--danger); font-weight: 700; }
p[role="status"] { color: var(--muted); }
button, select, input { font: inherit; color: inherit; }
button { min-height: 44px; padding: 0 14px; border: 1.5px solid var(--accent); border-radius: 8px; background: var(--surface); color: var(--accent); font-weight: 700; cursor: pointer; }
button:hover { background: var(--accent-soft); }
.button { display: flex; align-items: center; justify-content: center; min-height: 52px; padding: 0 16px; border: 1.5px solid var(--accent); border-radius: var(--radius); font-size: 16px; font-weight: 700; text-decoration: none; text-align: center; }
.button.primary, .submit button { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.button.primary:hover, .submit button:hover { background: var(--accent-strong); color: var(--on-accent); }
.actions { display: flex; flex-direction: column; gap: 8px; }
.submit button { width: 100%; min-height: 56px; border-radius: var(--radius); font-size: 17px; }
label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 700; color: var(--muted); }
select, input[type="search"] { width: 100%; min-height: 48px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 16px; font-weight: 400; }
dl.facts { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 13px; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; }
dd.mono { letter-spacing: 0.04em; }
/* S2 発行の確認（通行証） */
.submit { margin-top: 16px; }
.pass { overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.pass-head { min-height: 44px; padding: 8px 18px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; background: var(--accent); color: var(--on-accent); font-size: 12px; }
.pass-tier { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; }
.pass-body { padding: 18px; }
.pass-body > * + * { margin-top: 14px; }
.pass h1 { font-size: 26px; letter-spacing: 0.01em; }
.pass dl.facts { padding-bottom: 14px; border-bottom: 1.5px dashed var(--line); }
.tier-admin .pass { border: 2px solid var(--accent); border-radius: 4px; }
.tier-admin .pass-head { min-height: 52px; background: repeating-linear-gradient(135deg, var(--accent) 0 14px, var(--accent-strong) 14px 28px); }
.tier-admin .pass-tier { font-size: 16px; }
ul.admin-notes { margin: 0; padding: 12px 14px 12px 2em; border-left: 4px solid var(--accent); background: var(--accent-soft); font-size: 14px; }
ul.admin-notes li + li { margin-top: 6px; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: 8px; padding: 0; font-size: 13px; font-weight: 700; color: var(--muted); }
ul.roles { margin: 0; padding: 0; list-style: none; }
ul.roles li + li { margin-top: 8px; }
ul.roles label { min-height: 56px; padding: 8px 14px; display: flex; align-items: center; gap: 12px; border: 1.5px solid var(--line-strong); border-radius: 8px; background: var(--surface); cursor: pointer; }
ul.roles label:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
ul.roles input { flex: none; width: 20px; height: 20px; margin: 0; accent-color: var(--accent); }
.role-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.role-name { font-size: 16px; font-weight: 700; }
.role-iam { font-size: 12px; color: var(--muted); }
.session { flex: none; font-size: 13px; font-weight: 700; }
/* S4 エラー */
.error-head { display: flex; align-items: center; gap: 8px; color: var(--danger); font-size: 13px; font-weight: 700; }
main > .error-head + h1 { margin-top: 8px; }
.error-what { font-size: 14px; line-height: 1.7; }
ul.causes { margin: 0; padding-left: 1.2em; font-size: 13px; line-height: 1.7; }
ul.causes + .note { margin-top: 6px; }
.error-next { font-size: 14px; }
.paste { font-size: 13px; }
.paste code { display: inline-block; margin-right: 8px; font-weight: 700; }
/* S0・S1 の一覧（表をカードにする） */
table.list, table.list tbody, table.list tr, table.list td { display: block; }
table.list { width: 100%; border-collapse: collapse; }
table.list thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
table.list tr { padding: 14px 16px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
table.list tr + tr { margin-top: 10px; }
table.list td { padding: 0; font-size: 13px; color: var(--muted); }
table.list td:first-child { flex: 1 0 100%; font-size: 17px; font-weight: 700; color: var(--text); }
table.list td:nth-child(2) { font-family: var(--mono); letter-spacing: 0.04em; }
table.list td:last-child { flex: 1 0 100%; margin-top: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
table.list td:first-child br { display: none; }
small.email { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
a.role { display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; border: 1.5px solid var(--accent); border-radius: 8px; background: var(--surface); color: var(--accent); font-size: 14px; font-weight: 700; text-decoration: none; }
a.role:hover { background: var(--accent-soft); }
.tier-admin a.role, a.role.role-admin { border-color: var(--admin); border-radius: 2px; background: var(--admin); color: var(--on-admin); }
.tier-admin a.role:hover, a.role.role-admin:hover { background: var(--admin-strong); color: var(--on-admin); }
#clear-local { min-height: 36px; border-color: var(--line-strong); color: var(--muted); font-size: 12px; font-weight: 400; }
button.star { min-height: 44px; min-width: 32px; padding: 0 4px; border: 0; background: none; color: var(--accent); font-size: 18px; }
#count { font-size: 13px; font-weight: 700; color: var(--muted); }
#favorites ul, #recent ul, ul.teams, ul.choices { margin: 0; padding: 0; list-style: none; }
#favorites li + li, #recent li + li, ul.teams li + li, ul.choices li + li { margin-top: 8px; }
#favorites a.role, #recent a.role { width: 100%; min-height: 52px; }
ul.teams a, ul.choices a { display: flex; align-items: center; min-height: 52px; padding: 0 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); font-weight: 700; text-decoration: none; }
form[role="search"] { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
form[role="search"] label { flex: 1 1 14rem; }
form[role="search"] button { min-height: 48px; }
details summary { min-height: 44px; display: flex; align-items: center; font-weight: 700; cursor: pointer; }
/* S3 aws login の手順 */
ol.steps { padding: 14px 16px 14px 2.2em; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
ol.steps > li + li { margin-top: 14px; }
ol.steps form { margin-top: 8px; }
pre { margin: 8px 0 0; padding: 10px 12px; overflow-x: auto; overflow-wrap: normal; background: var(--code-bg); border-radius: 8px; font-size: 13px; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #11161C; --surface: #1A2129; --text: #E6EBF0; --muted: #9DA9B5; --line: #2F3944; --line-strong: #4A5662; --accent: #8DB4DC; --accent-strong: #B5CFEA; --accent-soft: #1F2B38; --on-accent: #0E1620; --admin: #E2865E; --admin-strong: #EFA584; --on-admin: #1A0F0A; --danger: #F0A27E; --code-bg: #10161D; }
  .tier-admin { --bg: #1B1411; --surface: #241B17; --line: #4A3329; --accent-soft: #33221B; }
}
`;

const ASSETS: Record<string, { body: string; type: string }> = {
  "portal.js": { body: PORTAL_JS, type: "text/javascript; charset=utf-8" },
  "portal.css": { body: PORTAL_CSS, type: "text/css; charset=utf-8" },
};

export const isAssetName = (name: string): boolean => Object.hasOwn(ASSETS, name);

/** 静的なファイルの応答。許可リストにない名前なら undefined。HEAD の本文は外側で落とす。 */
export function assetResponse(name: string): Response | undefined {
  if (!isAssetName(name)) return undefined;
  const a = ASSETS[name] as { body: string; type: string };
  const res = new Response(a.body, {
    headers: { "Content-Type": a.type, "Cache-Control": "private, max-age=300" },
  });
  STATIC_RESPONSES.add(res);
  return res;
}
