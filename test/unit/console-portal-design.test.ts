// コンソールログインの画面の見た目（デザイン案 A「通行証」）で検証できる振る舞い。
// 設計: docs/specs/console-login-portal.md §4（画面）・§9.6（CSP）。見た目そのものではなく、次を確かめる:
//   - Admin の画面だけに Admin の区別の印（body のクラス tier-admin と [ADMIN]）があり、Standard の画面には無い（U-18 の既定の案）
//   - S2（発行の確認）・S4（エラー）・S5・GET /login も自前の CSS を読み、JS は読まない（inline の style・script を使わない）
//   - S4 は「何が起きたか」と「どうすればよいか」を出す（見出しと code は変えない）
//   - CSS は外部のフォント・URL を読まず、書体はスタックで指定する
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminWorker } from "../../src/console/admin/worker";
import type { IdentityGroupsSource } from "../../src/console/display/groups";
import { ISSUE_ERRORS } from "../../src/console/issue/errors";
import { PORTAL_CSS } from "../../src/console/portal/assets";
import { errorPage } from "../../src/console/portal/pages";
import { createStandardWorker } from "../../src/console/standard/worker";
import type { WorkerConfig } from "../../src/console/types";
import { uuid } from "./console-fixtures";
import {
  ADMIN_ENTRY,
  ADMIN_HOST,
  ADMIN_PORTAL,
  ADMIN_TEAM,
  AUDS,
  adminConfig,
  adminEnv,
  baseEnv,
  createHarness,
  displayConfig,
  ENTRY,
  type Harness,
  loginRequest,
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
const ADMIN_AUD = AUDS.teams[ADMIN_TEAM] as string;
const TEAM_PATH = `/t/${ADMIN_TEAM}`;

const groupsOf =
  (...ids: string[]): IdentityGroupsSource =>
  async () => ({ ok: true, groups: ids });

function std(config: unknown = standardConfig(), identityGroups?: IdentityGroupsSource) {
  return createStandardWorker(
    config,
    { getAccessKey: h.getAccessKey, fetch: h.fetch, identityGroups },
    displayConfig(),
  );
}
function adm(config: unknown = adminConfig()) {
  return createAdminWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });
}

type W = { fetch(r: Request, e: unknown): Promise<Response> };

async function stdGet(path: string, aud: string | null = INFRA, w: W = std()) {
  const headers = new Headers();
  if (aud !== null) headers.set("Cf-Access-Jwt-Assertion", await h.accessJwt({ aud }));
  return w.fetch(new Request(`https://${PORTAL_HOST}${path}`, { headers }), baseEnv(h));
}
async function admGet(path: string, aud: string | null = ADMIN_AUD, w: W = adm()) {
  const headers = new Headers();
  if (aud !== null) headers.set("Cf-Access-Jwt-Assertion", await h.accessJwt({ aud }));
  return w.fetch(new Request(`https://${ADMIN_HOST}${path}`, { headers }), adminEnv(h));
}
async function stdPost(form: Record<string, string>) {
  return std().fetch(loginRequest({ jwt: await h.accessJwt({ aud: INFRA }), form }), baseEnv(h));
}
async function admPost(form?: Record<string, string>) {
  return adm().fetch(
    loginRequest({
      host: ADMIN_HOST,
      path: `${TEAM_PATH}/login`,
      origin: ADMIN_PORTAL,
      jwt: await h.accessJwt({ aud: ADMIN_AUD }),
      form: form ?? {
        entry: ADMIN_ENTRY,
        region: "ap-northeast-1",
        csrf: await h.csrf(ADMIN_AUD),
      },
    }),
    adminEnv(h),
  );
}

/** inline の script・style・イベント属性が無いこと（CSP の script-src 'self'・style-src 'self'）。 */
function noInlineCode(html: string) {
  expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
  expect(html).not.toMatch(/<style\b/);
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/\son[a-z]+=/);
}

/** JS は読まず、CSS だけを読む画面。 */
function cssOnly(html: string, base: string) {
  expect(html).toContain(`<link rel="stylesheet" href="${base}/assets/portal.css">`);
  expect(html).not.toMatch(/<script\b/);
  noInlineCode(html);
}

describe("階層の区別: Admin の画面だけ body に tier-admin（Standard は tier-standard）", () => {
  it("Admin: S1・S2・S3・S5・GET /login・404・401・503・403 のすべて", async () => {
    const pages = [
      await admGet(`${TEAM_PATH}/`),
      await admGet(`${TEAM_PATH}/a/333333333333`),
      await admGet(`${TEAM_PATH}/a/333333333333/cli`),
      await admGet(`${TEAM_PATH}/expired`),
      await admGet(`${TEAM_PATH}/login`),
      await admGet(`${TEAM_PATH}/a/555555555555`),
      await admGet(`${TEAM_PATH}/`, null),
      await admPost(),
      await admGet("/nope"),
    ];
    for (const res of pages) {
      const html = await res.text();
      expect(html, `${res.status}`).toContain('<body class="tier-admin">');
      expect(html, `${res.status}`).not.toContain("tier-standard");
      // 文字の印（CSS が読めない画面でも区別が残る）
      expect(html, `${res.status}`).toMatch(/<header><p>\[ADMIN\] /);
    }
  });

  it("Standard: S0・S1・S2・S3・S5・GET /login・S4 には Admin の印もクラスも無い", async () => {
    const pages = [
      await stdGet("/", AUDS.entry.standard, std(standardConfig(), groupsOf(uuid(1)))),
      await stdGet("/t/infra/"),
      await stdGet("/t/infra/a/333333333333"),
      await stdGet("/t/infra/a/333333333333/cli"),
      await stdGet("/t/infra/expired"),
      await stdGet("/t/infra/login"),
      await stdGet("/t/infra/a/555555555555"),
    ];
    for (const res of pages) {
      const html = await res.text();
      expect(html, `${res.status}`).toContain('<body class="tier-standard">');
      expect(html, `${res.status}`).not.toContain("ADMIN");
      expect(html, `${res.status}`).not.toContain("tier-admin");
      expect(html, `${res.status}`).not.toContain("role-admin");
      expect(html, `${res.status}`).not.toContain("管理者");
    }
  });
});

describe("S2・S4・S5・GET /login も自前の CSS を読む（JS は読まない）", () => {
  it("Standard: S2・S5・GET /login・S4（POST の csrf_failed・GET の not_listed）", async () => {
    for (const path of ["/t/infra/a/333333333333", "/t/infra/expired", "/t/infra/login"])
      cssOnly(await (await stdGet(path)).text(), "/t/infra");
    const csrf = await stdPost({ entry: ENTRY, region: "ap-northeast-1", csrf: "x" });
    expect(csrf.status).toBe(403);
    cssOnly(await csrf.text(), "/t/infra");
    const notListed = await stdGet("/t/infra/a/555555555555");
    expect(notListed.status).toBe(404);
    cssOnly(await notListed.text(), "/t/infra");
  });

  it("Admin: S2・S5・GET /login・S4（503 signing_unavailable）はチームのパスの CSS", async () => {
    for (const path of [
      `${TEAM_PATH}/a/333333333333`,
      `${TEAM_PATH}/expired`,
      `${TEAM_PATH}/login`,
    ])
      cssOnly(await (await admGet(path)).text(), TEAM_PATH);
    const res = await admPost();
    expect(res.status).toBe(503);
    cssOnly(await res.text(), TEAM_PATH);
  });

  it("入口（S0）のエラーは入口の CSS（/assets）を読む", async () => {
    const res = await stdGet("/", INFRA);
    expect(res.status).toBe(403);
    cssOnly(await res.text(), "");
  });

  it("チームが分からない Admin の 404 は CSS を読まない（読めない経路を指さない）", async () => {
    const html = await (await admGet("/nope")).text();
    expect(html).not.toContain("portal.css");
    expect(html).toContain("not_found");
  });
});

describe("S2 発行の確認（通行証）", () => {
  it("Standard: 階層・チーム・アカウント名・ID・Organization・ロール・CLI へのリンク・切り替わらないときの案内", async () => {
    const html = await (await stdGet("/t/infra/a/333333333333?role=readonly")).text();
    expect(html).toContain('<section class="pass" aria-label="開く先">');
    expect(html).toMatch(/<div class="pass-head"><span class="pass-tier">Standard<\/span>/);
    expect(html).toContain("チーム: ");
    expect(html).toContain("<h1>svc-a-prod</h1>");
    expect(html).toMatch(/<dt>アカウント ID<\/dt><dd class="mono">333333333333<\/dd>/);
    expect(html).toContain("<dt>Organization</dt>");
    expect(html).toContain('value="333333333333:readonly" required checked');
    expect(html).toContain('href="/t/infra/a/333333333333/cli?role=readonly"');
    // 発行の前の確認の文は残す（隠さない）
    expect(html).toContain("サインアウトしてから、もう一度「コンソールを開く」を押してください");
    expect(html).not.toMatch(/<details[^>]*>[\s\S]*サインアウトしてから/);
  });

  it("Admin: 管理者であることを、見出しの帯・注意の箇条書き・ボタンの文で示す", async () => {
    const html = await (await admGet(`${TEAM_PATH}/a/333333333333`)).text();
    expect(html).toMatch(/<div class="pass-head"><span class="pass-tier">\[ADMIN\] 管理者<\/span>/);
    expect(html).toContain('<ul class="admin-notes">');
    expect(html).toContain("管理者の権限で入ります");
    expect(html).toContain("--remote は使えません");
    expect(html).toContain("管理者のロールでコンソールを開く（新しいタブ）");
  });

  it("Standard の S2 には管理者の注意を出さない", async () => {
    const html = await (await stdGet("/t/infra/a/333333333333")).text();
    expect(html).not.toContain("admin-notes");
    expect(html).not.toContain("管理者");
    expect(html).toContain("コンソールを開く（新しいタブ）");
  });

  it("設定の値（アカウント名・Organization・ロールの表示名）はエスケープする", async () => {
    const config = standardConfig();
    const a = config.accounts.find(
      (x) => x.accountId === "333333333333",
    ) as WorkerConfig["accounts"][number];
    a.name = '<b>x</b>"&';
    const r = config.roles.find((x) => x.name === "readonly") as WorkerConfig["roles"][number];
    r.displayName = "<i>v</i>";
    const html = await (await stdGet("/t/infra/a/333333333333", INFRA, std(config))).text();
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>v</i>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;&quot;&amp;");
    noInlineCode(html);
  });
});

describe("S4 エラー: 何が起きたか・どうすればよいか", () => {
  const codes = [
    ...(Object.keys(ISSUE_ERRORS) as (keyof typeof ISSUE_ERRORS)[]),
    "method_not_allowed",
    "not_found",
    "payload_too_large",
  ] as const;

  it.each(codes)("%s: 起きたことと次の操作の文を出し、code を問い合わせの情報に入れる", (code) => {
    const html = errorPage(code, { requestId: "ray-1", teamBase: "/t/infra" });
    const what = /<p class="error-what">([^<]+)<\/p>/.exec(html)?.[1];
    const next = /<p class="error-next">([^<]+)<\/p>/.exec(html)?.[1];
    expect(what, "what").toBeDefined();
    expect(next, "next").toBeDefined();
    expect((what as string).length).toBeGreaterThan(8);
    expect((next as string).length).toBeGreaterThan(8);
    // 貼る情報の行の形は scripts/poc/g2/issue-lib.ts も読む
    expect(html).toContain(
      `<p class="paste">code <code>${code}</code> 要求 ID <code>ray-1</code></p>`,
    );
    expect(html).toContain('href="/t/infra/"');
    noInlineCode(html);
  });

  it("見出しは今のまま（sts_denied は「このロールに入れませんでした」）。原因は区別できないことを書く", () => {
    const html = errorPage("sts_denied", {});
    expect(html).toContain("<h1>このロールに入れませんでした</h1>");
    expect(html).toContain("ポータルからは区別できません");
  });

  it("問い合わせ先があれば主なボタンにし、要求 ID はエスケープする", () => {
    const html = errorPage("sts_denied", {
      requestId: '"><img src=x>',
      supportUrl: "https://support.example.com/?a=1&b=2",
    });
    expect(html).toContain(
      '<a class="button primary" href="https://support.example.com/?a=1&amp;b=2">',
    );
    expect(html).not.toContain("<img src=x>");
  });
});

describe("S0 入口: Admin の行のロールのリンクに role-admin", () => {
  it("Admin の行だけ role-admin のクラスを付ける", async () => {
    const html = await (
      await stdGet("/", AUDS.entry.standard, std(standardConfig(), groupsOf(uuid(1), uuid(4))))
    ).text();
    expect(html).toMatch(
      /<a class="role role-admin" href="https:\/\/admin-portal\.example\.com\/t\/infra-elevated\/a\/333333333333\?role=admin"/,
    );
    expect(html).toMatch(/<a class="role" href="\/t\/infra\/a\/333333333333\?role=readonly"/);
  });
});

describe("CSS（portal.css）", () => {
  it("書体は BIZ UDPGothic から始まるスタックで指定し、Web フォントや外部の URL を読まない", () => {
    expect(PORTAL_CSS).toMatch(
      /font-family: "BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif;/,
    );
    expect(PORTAL_CSS).not.toMatch(/@import|@font-face|url\(|https?:/);
  });

  it("Admin の差し色（朱 #B5471A）は 1 か所で定義し、Admin の画面（tier-admin）と Admin の行のリンク（role-admin）だけで使う", () => {
    expect(PORTAL_CSS.match(/#B5471A/gi)).toHaveLength(1);
    expect(PORTAL_CSS).toMatch(/:root\s*\{[^}]*--admin: #B5471A;/);
    expect(PORTAL_CSS).toMatch(/\.tier-admin\s*\{[^}]*--accent: var\(--admin\);/);
    expect(PORTAL_CSS).toMatch(/a\.role\.role-admin[^{]*\{[^}]*background: var\(--admin\);/);
    for (const line of PORTAL_CSS.split("\n").filter((l) => l.includes("var(--admin)")))
      expect(line).toMatch(/tier-admin|role-admin/);
  });

  it("スマホ幅でも横にはみ出さない（表はカードにし、長い値は折り返す）", () => {
    expect(PORTAL_CSS).toContain("overflow-wrap: anywhere;");
    expect(PORTAL_CSS).toMatch(
      /table\.list,\s*table\.list tbody,\s*table\.list tr,\s*table\.list td \{ display: block;/,
    );
  });
});
