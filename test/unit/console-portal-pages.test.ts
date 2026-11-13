// コンソールログインのチームの画面: S1（一覧。検索・お気に入り・最近使ったもの）・S3（aws login の手順）・静的なファイル。
// 設計: docs/specs/console-login-portal.md §4.2・§4.4・§5.4・§5.6・§6.5・§9.2・§9.6。
// 階層に共通の画面（Standard と Admin）。一覧は発行用の生成物のこのチームの行だけから作り、他のチームの行・AUD・ARN を出さない。
// CSP（script-src 'self'・style-src 'self'）に合わせ、inline の script・style を使わない（一覧の JSON は実行されないデータの要素）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminWorker } from "../../src/console/admin/worker";
import { createStandardWorker } from "../../src/console/standard/worker";
import type { WorkerConfig } from "../../src/console/types";
import {
  ADMIN_HOST,
  ADMIN_TEAM,
  AUDS,
  adminConfig,
  adminEnv,
  baseEnv,
  createHarness,
  displayConfig,
  type Harness,
  ISSUER_HOST,
  PORTAL_HOST,
  standardConfig,
} from "./console-standard-harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  for (const m of ["log", "error", "warn"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const INFRA = AUDS.teams.infra as string;
const DEV = AUDS.teams.dev as string;
const ADMIN_AUD = AUDS.teams[ADMIN_TEAM] as string;

function std(config: unknown = standardConfig()) {
  return createStandardWorker(
    config,
    { getAccessKey: h.getAccessKey, fetch: h.fetch },
    displayConfig(),
  );
}
function adm(config: unknown = adminConfig()) {
  return createAdminWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });
}

async function get(
  w: { fetch(r: Request, e: unknown): Promise<Response> },
  path: string,
  o: { aud?: string | null; host?: string; method?: string; env?: Record<string, unknown> } = {},
) {
  const headers = new Headers();
  if (o.aud !== null)
    headers.set("Cf-Access-Jwt-Assertion", await h.accessJwt({ aud: o.aud ?? INFRA }));
  return w.fetch(
    new Request(`https://${o.host ?? PORTAL_HOST}${path}`, { method: o.method ?? "GET", headers }),
    o.env ?? baseEnv(h),
  );
}

/** HTML の属性値のエスケープを戻す（esc の逆）。 */
const unescapeAttr = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** HTML に埋め込んだ一覧の JSON（script の要素ではなく、エスケープした data-json の属性）を取り出す。 */
function embedded(html: string): {
  team: string;
  teamBase: string;
  rows: Record<string, unknown>[];
} {
  const m = /<div id="portal-data" data-json="([^"]*)" hidden><\/div>/.exec(html);
  expect(m, "portal-data").not.toBeNull();
  return JSON.parse(unescapeAttr(m?.[1] as string));
}

/** inline の script・style が無いこと（script はすべて src つき）。 */
function noInline(html: string) {
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) expect(tag).toMatch(/\ssrc="[^"]+"/);
  expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
  expect(html).not.toMatch(/<style\b/);
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/\son[a-z]+=/);
}

describe("S1 チームの一覧（Standard）", () => {
  it("このチームの行だけを出し、ロールは S2 へのリンク。email は 2 行目に出す", async () => {
    const res = await get(std(), "/t/infra/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("svc-a-prod");
    expect(html).toContain('href="/t/infra/a/333333333333?role=readonly"');
    expect(html).toContain('href="/t/infra/a/222222222222?role=readonly"');
    expect(html).toContain("aws+svc-a-prod@example.com");
    // 他のチームの割り当て（developer は dev だけ）は出さない
    expect(html).not.toContain("role=developer");
    expect(html).not.toContain("/t/dev/");
    noInline(html);
  });

  it("他のチームの行・email は HTML にも JSON にも出さない（dev のページに infra だけの行が無い）", async () => {
    const html = await (await get(std(), "/t/dev/", { aud: DEV })).text();
    expect(html).toContain("svc-c-dev");
    expect(html).toContain('href="/t/dev/a/444444444444?role=developer"');
    expect(html).not.toContain("333333333333");
    expect(html).not.toContain("svc-a-prod");
    expect(html).not.toContain("role=readonly");
  });

  it("埋め込みの JSON は表示用の射影だけ（ARN・チームの一覧・AUD を持たない）", async () => {
    const html = await (await get(std(), "/t/infra/")).text();
    const data = embedded(html);
    expect(data.team).toBe("infra");
    expect(data.teamBase).toBe("/t/infra");
    expect(data.rows.map((r) => r.accountId).sort()).toEqual([
      "222222222222",
      "333333333333",
      "444444444444",
    ]);
    const row = data.rows.find((r) => r.accountId === "333333333333") as Record<string, unknown>;
    expect(row.email).toBe("aws+svc-a-prod@example.com");
    expect(row.roles).toEqual([
      { role: "readonly", displayName: "readonly", sessionSeconds: 43200 },
    ]);
    expect(html).not.toContain("arn:aws:iam::");
    expect(html).not.toContain('"teams"');
    for (const aud of [...Object.values(AUDS.teams), AUDS.entry.standard, AUDS.entry.admin])
      expect(html).not.toContain(aud);
  });

  it("設定の値が </script> を含んでも、埋め込みの JSON と HTML を壊さない", async () => {
    const config = standardConfig();
    const a = config.accounts.find(
      (x) => x.accountId === "333333333333",
    ) as WorkerConfig["accounts"][number];
    a.name = '</script><script>alert(1)</script>"&<b>';
    const html = await (await get(std(config), "/t/infra/")).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<b>");
    const data = embedded(html);
    expect(data.rows.find((r) => r.accountId === "333333333333")?.name).toBe(a.name);
    noInline(html);
  });

  it("検索・お気に入り・最近使ったものの欄と、自前の静的なファイル（チームのパスの下）を読む", async () => {
    const html = await (await get(std(), "/t/infra/")).text();
    expect(html).toContain('<script src="/t/infra/assets/portal.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/t/infra/assets/portal.css">');
    expect(html).toMatch(/<form[^>]*method="get"[^>]*>/);
    expect(html).toMatch(/<input[^>]*name="q"/);
    expect(html).toContain('id="favorites"');
    expect(html).toContain('id="recent"');
    // 入口の一覧へのリンク
    expect(html).toContain('href="/"');
  });

  it("JS なしの ?q= はサーバー側で絞る（名前・ID はハイフンの有無を問わない・Organization）。email は対象にしない", async () => {
    const w = std();
    const byName = await (await get(w, "/t/infra/?q=SVC-A")).text();
    expect(byName).toContain('href="/t/infra/a/333333333333?role=readonly"');
    expect(byName).not.toContain('href="/t/infra/a/444444444444?role=readonly"');
    expect(byName).toContain('value="SVC-A"');

    const byId = await (await get(w, "/t/infra/?q=4444-4444-4444")).text();
    expect(byId).toContain('href="/t/infra/a/444444444444?role=readonly"');
    expect(byId).not.toContain('href="/t/infra/a/333333333333?role=readonly"');

    const byOrg = await (await get(w, `/t/infra/?q=${encodeURIComponent("先方")}`)).text();
    expect(byOrg).toContain('href="/t/infra/a/222222222222?role=readonly"');
    expect(byOrg).not.toContain('href="/t/infra/a/333333333333?role=readonly"');

    const byEmail = await (
      await get(w, `/t/infra/?q=${encodeURIComponent("aws+svc-a-prod")}`)
    ).text();
    expect(byEmail).not.toContain('href="/t/infra/a/333333333333?role=readonly"');
    expect(byEmail).toContain("email で探すには JavaScript が要ります");
  });

  it("?q= の値はエスケープし、長すぎる値は切り詰める", async () => {
    const html = await (
      await get(std(), `/t/infra/?q=${encodeURIComponent('"><img src=x>')}`)
    ).text();
    expect(html).not.toContain("<img src=x>");
    const long = await get(std(), `/t/infra/?q=${"a".repeat(1000)}`);
    expect(long.status).toBe(200);
    expect(await long.text()).not.toContain("a".repeat(129));
  });

  it("このチームの行が無ければ、空であることと入口の一覧へのリンクを出す", async () => {
    const config = standardConfig();
    for (const a of config.accounts)
      for (const r of a.roles)
        r.teams =
          r.teams.filter((t) => t !== "sa").length > 0
            ? r.teams.filter((t) => t !== "sa")
            : r.teams;
    const html = await (await get(std(config), "/t/sa/", { aud: AUDS.teams.sa as string })).text();
    expect(html).toContain("このチームで入れるアカウントは一覧にありません");
    expect(html).toContain('href="/"');
  });

  it("Access JWT が無い・チームが違えば断る（401・403）", async () => {
    expect((await get(std(), "/t/infra/", { aud: null })).status).toBe(401);
    expect((await get(std(), "/t/infra/", { aud: DEV })).status).toBe(403);
  });
});

describe("S1 チームの一覧（Admin）", () => {
  it("[ADMIN] の印、静的なファイルはチームのパスの下、入口の一覧は Standard のオリジン", async () => {
    const res = await get(adm(), `/t/${ADMIN_TEAM}/`, {
      aud: ADMIN_AUD,
      host: ADMIN_HOST,
      env: adminEnv(h),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>[ADMIN]");
    expect(html).toContain(`href="/t/${ADMIN_TEAM}/a/333333333333?role=admin"`);
    expect(html).toContain(`<script src="/t/${ADMIN_TEAM}/assets/portal.js" defer></script>`);
    expect(html).toContain('href="https://portal.example.com/"');
    noInline(html);
  });
});

describe("S3 aws login の手順", () => {
  it("Viewer（Standard）: config の断片・aws login・確かめる・aws logout・--remote・案内。email と ARN を出さない", async () => {
    const res = await get(std(), "/t/infra/a/333333333333/cli?role=readonly");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("[profile svc-a-prod-readonly]");
    expect(html).toContain("region = ap-northeast-1");
    expect(html).toContain("aws login --profile svc-a-prod-readonly");
    expect(html).toContain("aws sts get-caller-identity --profile svc-a-prod-readonly");
    expect(html).toContain("aws logout --profile svc-a-prod-readonly");
    expect(html).toContain("aws login --remote");
    expect(html).toContain("333333333333");
    expect(html).toContain("FederatedViewer");
    for (const s of [
      "自分で始めた URL だけ開く",
      "コードを人に渡さない",
      "一覧で選ぶセッション",
      "共有の端末では aws logout",
    ])
      expect(html).toContain(s);
    expect(html).not.toContain("aws+svc-a-prod@example.com");
    expect(html).not.toContain("arn:aws:iam::");
    // 「コンソールを開く」は S2 と同じ POST（CSRF つき）
    expect(html).toContain('action="/t/infra/login"');
    expect(html).toMatch(/name="csrf" value="[^"]+"/);
    expect(html).toContain('value="333333333333:readonly"');
    noInline(html);
  });

  it("Administrator（Admin）: 同じ端末だけ（--remote は使えない）", async () => {
    const html = await (
      await get(adm(), `/t/${ADMIN_TEAM}/a/333333333333/cli?role=admin`, {
        aud: ADMIN_AUD,
        host: ADMIN_HOST,
        env: adminEnv(h),
      })
    ).text();
    expect(html).toContain("aws login --profile svc-a-prod-admin");
    expect(html).toContain("同じ端末だけ");
    expect(html).toContain("--remote は使えません");
    expect(html).not.toContain("aws login --remote も使えます");
  });

  it("ロールの指定が無くロールが 1 つならそれを使い、このチームのロールでなければ 404 not_listed", async () => {
    const w = std();
    const one = await (await get(w, "/t/infra/a/333333333333/cli")).text();
    expect(one).toContain("aws login --profile svc-a-prod-readonly");
    const other = await get(w, "/t/infra/a/444444444444/cli?role=developer");
    expect(other.status).toBe(404);
    expect(await other.text()).toContain("not_listed");
    expect((await get(w, "/t/infra/a/333333333333/cli?role=admin")).status).toBe(404);
  });

  it("ロールが複数で指定が無ければ、ロールを選ぶリンクを出す", async () => {
    const config = standardConfig();
    const a = config.accounts.find(
      (x) => x.accountId === "444444444444",
    ) as WorkerConfig["accounts"][number];
    for (const r of a.roles) if (!r.teams.includes("infra")) r.teams.push("infra");
    const html = await (await get(std(config), "/t/infra/a/444444444444/cli")).text();
    expect(html).toContain('href="/t/infra/a/444444444444/cli?role=readonly"');
    expect(html).toContain('href="/t/infra/a/444444444444/cli?role=developer"');
    expect(html).not.toContain("aws login --profile");
  });

  it("プロファイル名は アカウント名-ロール を小文字にし、使えない文字は - にする", async () => {
    const config = standardConfig();
    const a = config.accounts.find(
      (x) => x.accountId === "333333333333",
    ) as WorkerConfig["accounts"][number];
    a.name = "Svc A/Prod (main)";
    const html = await (await get(std(config), "/t/infra/a/333333333333/cli?role=readonly")).text();
    expect(html).toContain("[profile svc-a-prod-main-readonly]");
  });
});

describe("静的なファイル（/assets と /t/<team>/assets）", () => {
  it("Standard: /assets/portal.js・portal.css を返す（キャッシュしてよい。CSP・nosniff は付ける）", async () => {
    const w = std();
    const js = await get(w, "/assets/portal.js", { aud: AUDS.entry.standard });
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("Cache-Control")).not.toBe("no-store");
    expect(js.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(js.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(await js.text()).toContain("portal-data");
    const css = await get(w, "/assets/portal.css", { aud: AUDS.entry.standard });
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  });

  it("Standard: /t/<team>/assets はチームの Access JWT で返す（中身は同じ）", async () => {
    const w = std();
    const a = await (await get(w, "/assets/portal.js", { aud: AUDS.entry.standard })).text();
    const t = await get(w, "/t/infra/assets/portal.js");
    expect(t.status).toBe(200);
    expect(await t.text()).toBe(a);
  });

  it("Access JWT が無い・別のアプリの JWT なら断る（チームのパスは G-6、入口は入口の AUD だけ）", async () => {
    const w = std();
    expect((await get(w, "/t/infra/assets/portal.js", { aud: null })).status).toBe(401);
    expect((await get(w, "/t/infra/assets/portal.js", { aud: DEV })).status).toBe(403);
    expect((await get(w, "/assets/portal.js", { aud: null })).status).toBe(401);
    expect((await get(w, "/assets/portal.js", { aud: INFRA })).status).toBe(403);
  });

  it("許可リストにない名前・知らないチーム・issuer のホストは 404、POST は 405", async () => {
    const w = std();
    expect((await get(w, "/assets/other.js", { aud: AUDS.entry.standard })).status).toBe(404);
    expect((await get(w, "/assets/../worker.js", { aud: AUDS.entry.standard })).status).toBe(404);
    expect((await get(w, "/t/infra/assets/x.css")).status).toBe(404);
    expect((await get(w, "/t/nope/assets/portal.js")).status).toBe(404);
    expect((await get(w, "/assets/portal.js", { host: ISSUER_HOST })).status).toBe(404);
    expect((await get(w, "/t/infra/assets/portal.js", { method: "POST" })).status).toBe(405);
  });

  it("Admin: /assets は 404（チームのパスだけ）、/t/<team>/assets はチームの JWT で返す", async () => {
    const w = adm();
    const env = adminEnv(h);
    expect(
      (await get(w, "/assets/portal.js", { aud: ADMIN_AUD, host: ADMIN_HOST, env })).status,
    ).toBe(404);
    const t = await get(w, `/t/${ADMIN_TEAM}/assets/portal.js`, {
      aud: ADMIN_AUD,
      host: ADMIN_HOST,
      env,
    });
    expect(t.status).toBe(200);
    expect(t.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(
      (await get(w, `/t/${ADMIN_TEAM}/assets/portal.js`, { aud: null, host: ADMIN_HOST, env }))
        .status,
    ).toBe(401);
  });
});

/** HTML の中の `<form ...>` の開始タグを全部取り出す。 */
const formTags = (html: string) => html.match(/<form\b[^>]*>/g) ?? [];

describe("POST のフォームに noreferrer を付けない（Origin: null で自分の POST が 403 forbidden_origin になる）", () => {
  // HTML の仕様では、form の rel に noreferrer があると送信の referrer policy が no-referrer になり、
  // Chrome は POST の Origin を "null" で送る。Origin の完全一致を求める検査（§9.3 の 3）で拒否される。
  // 既存の e2e は Origin を明示して送るため、この経路を捕まえられない。
  const expectNoReferrerFree = (html: string, expectedPostForms: number) => {
    const posts = formTags(html).filter((t) => /\smethod="post"/i.test(t));
    expect(posts.length).toBe(expectedPostForms);
    for (const tag of posts) {
      expect(tag).toContain('action="');
      expect(tag).not.toMatch(/noreferrer/i);
      // 別タブで開くので opener は切る
      expect(tag).toMatch(/\srel="[^"]*\bnoopener\b[^"]*"/);
    }
  };

  it("S2 アカウントの詳細（Standard）の POST の form", async () => {
    const html = await (await get(std(), "/t/infra/a/333333333333?role=readonly")).text();
    expectNoReferrerFree(html, 1);
  });

  it("S2 アカウントの詳細（Admin）の POST の form", async () => {
    const html = await (
      await get(adm(), `/t/${ADMIN_TEAM}/a/333333333333?role=admin`, {
        aud: ADMIN_AUD,
        host: ADMIN_HOST,
        env: adminEnv(h),
      })
    ).text();
    expectNoReferrerFree(html, 1);
  });

  it("S3 aws login の手順（Standard）の POST の form", async () => {
    const html = await (await get(std(), "/t/infra/a/333333333333/cli?role=readonly")).text();
    expectNoReferrerFree(html, 1);
  });

  it("S3 aws login の手順（Admin）の POST の form", async () => {
    const html = await (
      await get(adm(), `/t/${ADMIN_TEAM}/a/333333333333/cli?role=admin`, {
        aud: ADMIN_AUD,
        host: ADMIN_HOST,
        env: adminEnv(h),
      })
    ).text();
    expectNoReferrerFree(html, 1);
  });

  it("pages.ts のどの method=post の form も noreferrer を持たない（今後足される form も捕まえる）", () => {
    const src = readFileSync(
      join(new URL("../../", import.meta.url).pathname, "src/console/portal/pages.ts"),
      "utf8",
    );
    const posts = formTags(src).filter((t) => /\smethod="post"/i.test(t));
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const tag of posts) expect(tag).not.toMatch(/noreferrer/i);
  });
});
