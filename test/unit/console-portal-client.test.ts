// コンソールログインの画面の JS（src/console/portal/assets.ts の PORTAL_JS）: 検索・お気に入り・最近使ったものの純粋な部分。
// 設計: docs/specs/console-login-portal.md §4.2（検索）・§5.6（email を localStorage に置かない）・§9.6（CSP・localStorage）。
// ブラウザの DOM は使わず、node の vm で読み込んで関数だけを呼ぶ（document が無ければ main は動かない作り）。
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PORTAL_CSS, PORTAL_JS, STORAGE_KEYS } from "../../src/console/portal/assets";

type Entry = { team: string; accountId: string; role: string; name: string; t: number };
type Client = {
  matches(row: unknown, q: string): boolean;
  recordRecent(list: Entry[], entry: unknown, now: number): Entry[];
  toggleFavorite(list: Entry[], entry: unknown): Entry[];
  parseList(text: string | null, max: number): Entry[];
  STORAGE_KEYS: typeof STORAGE_KEYS;
};

function load(): Client {
  const ctx: Record<string, unknown> = {};
  runInNewContext(PORTAL_JS, ctx);
  return ctx as unknown as Client;
}

const row = {
  accountId: "333333333333",
  name: "svc-a-prod",
  email: "aws+svc-a-prod@example.com",
  org: "本体",
  kind: "A",
  roles: [{ role: "readonly", displayName: "Viewer", sessionSeconds: 43200 }],
};

describe("画面の JS: 読み込み", () => {
  it("DOM の無い環境で読み込んでも例外を出さず、関数を公開する", () => {
    const c = load();
    expect(typeof c.matches).toBe("function");
    expect(c.STORAGE_KEYS).toEqual(STORAGE_KEYS);
  });

  it("外部への送信・動的な評価・innerHTML を使わない（自前の静的な JS だけ）", () => {
    for (const banned of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "eval(",
      "new Function",
      "fetch(",
      "XMLHttpRequest",
      "sendBeacon",
      "http://",
      "https://",
      "import(",
    ])
      expect(PORTAL_JS, banned).not.toContain(banned);
    expect(PORTAL_CSS).not.toMatch(/@import|url\(/);
  });
});

describe("画面の JS: 検索", () => {
  const c = load();
  it("名前・ID（ハイフンの有無を問わない）・email（大文字と小文字を区別しない）・Organization・種類・ロールに部分一致", () => {
    for (const q of ["SVC-A", "3333-3333", "333333333333", "AWS+SVC-A-PROD@", "本体", "viewer", ""])
      expect(c.matches(row, q), q).toBe(true);
    for (const q of ["svc-b", "4444", "example.org", "admin"])
      expect(c.matches(row, q), q).toBe(false);
  });

  it("email の無い行も扱える", () => {
    expect(c.matches({ ...row, email: undefined }, "svc-a")).toBe(true);
    expect(c.matches({ ...row, email: undefined }, "@example.com")).toBe(false);
  });
});

describe("画面の JS: 最近使ったもの・お気に入り（localStorage に置く形）", () => {
  const c = load();
  const e = (accountId: string, extra: Record<string, unknown> = {}) => ({
    team: "infra",
    accountId,
    role: "readonly",
    name: `acct-${accountId}`,
    ...extra,
  });

  it("email・URL・トークンは記録しない（チーム・アカウント ID・名前・ロール・時刻だけ）", () => {
    const list = c.recordRecent(
      [],
      e("333333333333", { email: "aws+x@example.com", href: "https://x", token: "t" }),
      1000,
    );
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0] as object).sort()).toEqual([
      "accountId",
      "name",
      "role",
      "t",
      "team",
    ]);
    expect(list[0]?.t).toBe(1000);
  });

  it("同じ行は先頭に移し、10 件までにする。形の崩れた記録は捨てる", () => {
    let list: Entry[] = [];
    for (let i = 0; i < 12; i++) list = c.recordRecent(list, e(String(100000000000 + i)), i);
    expect(list).toHaveLength(10);
    expect(list[0]?.accountId).toBe("100000000011");
    list = c.recordRecent(list, e("100000000005"), 99);
    expect(list[0]?.accountId).toBe("100000000005");
    expect(list.filter((x) => x.accountId === "100000000005")).toHaveLength(1);
    for (const bad of [
      null,
      e("12345"),
      e("333333333333", { team: "../x" }),
      e("333333333333", { role: "<b>" }),
    ])
      expect(c.recordRecent([], bad, 1)).toEqual([]);
  });

  it("お気に入りは押すたびに付け外しする", () => {
    let list: Entry[] = [];
    list = c.toggleFavorite(list, e("333333333333"));
    expect(list).toHaveLength(1);
    list = c.toggleFavorite(list, e("444444444444"));
    list = c.toggleFavorite(list, e("333333333333"));
    expect(list.map((x) => x.accountId)).toEqual(["444444444444"]);
  });

  it("壊れた localStorage の値は空として読み、崩れた要素は捨てる", () => {
    expect(c.parseList("{not json", 10)).toEqual([]);
    expect(c.parseList('{"a":1}', 10)).toEqual([]);
    expect(c.parseList(null, 10)).toEqual([]);
    const text = JSON.stringify([
      e("333333333333", { email: "x@example.com" }),
      { team: 1 },
      e("4"),
    ]);
    const list = c.parseList(text, 10);
    expect(list.map((x) => x.accountId)).toEqual(["333333333333"]);
    expect(list[0]).not.toHaveProperty("email");
  });
});

// ---- DOM の最小の偽物で main() を動かす（描画・検索・最近使ったもの・お気に入り・消去） ----

type Listener = (ev: Record<string, unknown>) => void;

class FakeEl {
  tag: string;
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | undefined;
  listeners: Record<string, Listener[]> = {};
  hidden = false;
  className = "";
  href = "";
  type = "";
  value = "";
  form: FakeEl | undefined;
  private text = "";
  constructor(tag: string, init: Partial<FakeEl> & { id?: string } = {}) {
    this.tag = tag;
    const { id, ...rest } = init;
    Object.assign(this, rest);
    if (id) this.attrs.set("id", id);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text = String(v);
    this.children = [];
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  appendChild(c: FakeEl) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl) {
    this.children = this.children.filter((x) => x !== c);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, f: Listener) {
    this.listeners[t] ??= [];
    this.listeners[t].push(f);
  }
  matches(sel: string) {
    const [tag, cls] = sel.split(".");
    return this.tag === tag && (cls === undefined || this.className.split(" ").includes(cls));
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): FakeEl[] {
    const parts = sel.split(" ");
    let scope: FakeEl[] = [this];
    for (const p of parts) scope = scope.flatMap((s) => s.all().filter((e) => e.matches(p)));
    return scope;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): FakeEl | null {
    let n: FakeEl | undefined = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n.parent;
    }
    return null;
  }
}

function fakePage(data: unknown, seed: Record<string, string> = {}) {
  const body = new FakeEl("body");
  const form = body.appendChild(new FakeEl("form"));
  const q = form.appendChild(new FakeEl("input", { id: "q", form }));
  const hint = body.appendChild(new FakeEl("p", { id: "q-hint" }));
  const fav = body.appendChild(new FakeEl("section", { id: "favorites", hidden: true }));
  fav.appendChild(new FakeEl("ul"));
  const recent = body.appendChild(new FakeEl("section", { id: "recent", hidden: true }));
  recent.appendChild(new FakeEl("ul"));
  const clear = body.appendChild(new FakeEl("button", { id: "clear-local", hidden: true }));
  const count = body.appendChild(new FakeEl("p", { id: "count" }));
  const table = body.appendChild(new FakeEl("table", { className: "list" }));
  const tbody = table.appendChild(new FakeEl("tbody"));
  const dataEl = body.appendChild(new FakeEl("div", { id: "portal-data" }));
  dataEl.setAttribute("data-json", JSON.stringify(data));
  const docListeners: Record<string, Listener[]> = {};
  const document = {
    readyState: "complete",
    activeElement: null,
    getElementById: (id: string) => body.all().find((e) => e.getAttribute("id") === id) ?? null,
    querySelector: (sel: string) => body.querySelector(sel),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => {
      const n = new FakeEl("#text");
      n.textContent = t;
      return n;
    },
    addEventListener: (t: string, f: Listener) => {
      docListeners[t] ??= [];
      docListeners[t].push(f);
    },
  };
  const store = new Map<string, string>(Object.entries(seed));
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  runInNewContext(PORTAL_JS, { document, window: { localStorage }, Date });
  const click = (target: FakeEl) => {
    for (const f of docListeners.click ?? []) f({ target });
    for (const f of target.listeners.click ?? []) f({ target });
  };
  const type = (v: string) => {
    q.value = v;
    for (const f of q.listeners.input ?? []) f({ target: q });
  };
  return { tbody, q, hint, fav, recent, clear, count, store, click, type };
}

const s1Data = {
  team: "infra",
  teamBase: "/t/infra",
  rows: [
    { ...row },
    {
      accountId: "444444444444",
      name: "svc-c-dev",
      email: "aws+svc-c-dev@example.com",
      org: "本体",
      kind: "C",
      roles: [{ role: "readonly", displayName: "Viewer", sessionSeconds: 43200 }],
    },
  ],
};

describe("画面の JS: main()（DOM の偽物で動かす）", () => {
  it("埋め込みのデータから行を描き、入力で絞り込む（email も対象）。JS なしの案内は隠す", () => {
    const p = fakePage(s1Data);
    expect(p.tbody.children).toHaveLength(2);
    expect(p.count.textContent).toBe("2 件");
    expect(p.hint.hidden).toBe(true);
    expect(p.clear.hidden).toBe(false);
    p.type("svc-a");
    expect(p.tbody.children).toHaveLength(1);
    p.type("AWS+SVC-C-DEV@");
    expect(p.tbody.children).toHaveLength(1);
    expect(p.tbody.textContent).toContain("svc-c-dev");
    p.type("");
    expect(p.tbody.children).toHaveLength(2);
  });

  it("ロールのリンクを押すと最近使ったものに email なしで残し、星でお気に入りを付け、消去で消す", () => {
    const p = fakePage(s1Data);
    const link = p.tbody.querySelector("a.role") as FakeEl;
    expect(link.href).toBe("/t/infra/a/333333333333?role=readonly");
    p.click(link);
    const recent = JSON.parse(p.store.get(STORAGE_KEYS.recent) as string);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ team: "infra", accountId: "333333333333", role: "readonly" });
    expect(JSON.stringify(recent)).not.toContain("@");

    const star = p.tbody.querySelector("button.star") as FakeEl;
    p.click(star);
    expect(JSON.parse(p.store.get(STORAGE_KEYS.favorites) as string)).toHaveLength(1);
    expect(p.fav.hidden).toBe(false);
    expect(p.fav.textContent).toContain("svc-a-prod");
    expect(p.recent.hidden).toBe(false);

    p.click(p.clear);
    expect(p.store.size).toBe(0);
    expect(p.fav.hidden).toBe(true);
    expect(p.recent.hidden).toBe(true);
  });

  it("入口（S0）: 最近使ったものはチームの起点から作り、Admin のチームには [ADMIN] を付ける。知らないチームは出さない", () => {
    const seed = JSON.stringify([
      {
        team: "infra-elevated",
        accountId: "333333333333",
        role: "admin",
        name: "svc-a-prod",
        t: 3,
      },
      { team: "infra", accountId: "333333333333", role: "readonly", name: "svc-a-prod", t: 2 },
      { team: "dev", accountId: "444444444444", role: "developer", name: "svc-c-dev", t: 1 },
    ]);
    const p = fakePage(
      {
        teams: {
          infra: "/t/infra",
          "infra-elevated": "https://admin-portal.example.com/t/infra-elevated",
        },
        adminTeams: ["infra-elevated"],
      },
      { [STORAGE_KEYS.recent]: seed },
    );
    expect(p.recent.hidden).toBe(false);
    const links = p.recent.querySelectorAll("a.role");
    expect(links.map((a) => a.href)).toEqual([
      "https://admin-portal.example.com/t/infra-elevated/a/333333333333?role=admin",
      "/t/infra/a/333333333333?role=readonly",
    ]);
    expect(links[0]?.textContent).toContain("[ADMIN]");
    expect(links[1]?.textContent).not.toContain("[ADMIN]");
    // サーバーが描いた入口の行（表）は描き直さない
    expect(p.tbody.children).toHaveLength(0);
  });
});
