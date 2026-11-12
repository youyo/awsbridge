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
    var mark = adminTeams.indexOf(e.team) >= 0 ? " [ADMIN]" : "";
    li.appendChild(roleLink(base, e, e.name + " (" + e.accountId + ") " + e.role + " · " + e.team + mark));
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

export const PORTAL_CSS = `body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 0 1rem 2rem; color: #1f2328; background: #ffffff; }
header { border-bottom: 1px solid #d0d7de; margin-bottom: 1rem; }
table.list { border-collapse: collapse; width: 100%; }
table.list th, table.list td { border-bottom: 1px solid #d0d7de; padding: 0.4rem; text-align: left; vertical-align: top; }
small.email { color: #57606a; }
a.role { display: inline-block; margin: 0.1rem 0.3rem 0.1rem 0; }
button.star { background: none; border: none; cursor: pointer; font-size: 1rem; padding: 0 0.2rem; }
pre { background: #f6f8fa; padding: 0.6rem; overflow-x: auto; }
.note, .hint { color: #57606a; font-size: 0.9rem; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  header, table.list th, table.list td { border-color: #30363d; }
  small.email, .note, .hint { color: #8b949e; }
  pre { background: #161b22; }
  a { color: #58a6ff; }
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
