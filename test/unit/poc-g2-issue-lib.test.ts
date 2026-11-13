// G2 の発行の見張り（poc:g2:issue-watch）の純粋関数: CSRF の取り出し・応答の分類・Cookie のファイルの置き場所。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCookieFile,
  assertWatchRole,
  classifyAccountPage,
  classifyLogin,
  loginBody,
  parseIssueTarget,
  portalHostPrefixes,
} from "../../scripts/poc/g2/issue-lib";
import { loginFormPage, errorPage as realErrorPage } from "../../src/console/portal/pages";
import { standardConfig } from "./console-standard-harness";

// CSRF の形の文字列は実行時に組む
const CSRF = ["v1", "1800000000", "A".repeat(43)].join(".");
const page = (csrf: string) =>
  `<form method="post" action="/t/g2std/login"><input type="radio" name="entry" value="123456789012:viewer"><input type="hidden" name="csrf" value="${csrf}"></form>`;
const errorPage = (code: string) =>
  `<h1>x</h1>\n<p>問い合わせるときに貼る情報: code <code>${code}</code> 要求 ID <code>abc</code></p>`;

describe("parseIssueTarget", () => {
  it("ポータルのオリジン・チーム・アカウント・ロールを確かめる", () => {
    expect(
      parseIssueTarget({
        portal: "https://awsbridge-console.dev.example.com",
        team: "g2std",
        account: "123456789012",
        role: "viewer",
      }),
    ).toEqual({
      origin: "https://awsbridge-console.dev.example.com",
      team: "g2std",
      account: "123456789012",
      role: "viewer",
      accountPath: "/t/g2std/a/123456789012?role=viewer",
      loginPath: "/t/g2std/login",
    });
    // 試験の擬似サーバー（127.0.0.1）も受け付ける
    expect(
      parseIssueTarget({
        portal: "http://127.0.0.1:8080",
        team: "t",
        account: "123456789012",
        role: "r",
      }).origin,
    ).toBe("http://127.0.0.1:8080");
  });

  it("Admin のポータルも受け付ける。接頭辞は引数（環境変数 AWSBRIDGE_G2_PORTAL_HOST_PREFIXES）で変えられる", () => {
    const t = { team: "g2adm", account: "123456789012", role: "admin-probe" };
    expect(
      parseIssueTarget({ ...t, portal: "https://awsbridge-admin-console.dev.example.com" }).origin,
    ).toBe("https://awsbridge-admin-console.dev.example.com");
    expect(
      parseIssueTarget(
        { ...t, portal: "https://g2dev-portal.dev.example.com" },
        portalHostPrefixes({ AWSBRIDGE_G2_PORTAL_HOST_PREFIXES: "g2dev-portal., x." }),
      ).origin,
    ).toBe("https://g2dev-portal.dev.example.com");
    expect(() =>
      parseIssueTarget(
        { ...t, portal: "https://awsbridge-console.dev.example.com" },
        portalHostPrefixes({ AWSBRIDGE_G2_PORTAL_HOST_PREFIXES: "g2dev-portal." }),
      ),
    ).toThrow();
    expect(portalHostPrefixes({})).toEqual(["awsbridge-console.", "awsbridge-admin-console."]);
  });

  it("形の違う値は断る", () => {
    const ok = {
      portal: "https://awsbridge-console.dev.example.com",
      team: "g2std",
      account: "123456789012",
      role: "viewer",
    };
    for (const bad of [
      { portal: "https://awsbridge-console.dev.example.com/" },
      { portal: "http://awsbridge-console.dev.example.com" },
      { portal: "https://x.example.com/t/g2std" },
      // ポータルでないホスト（接頭辞が違う・最初のラベルが違う）
      { portal: "https://x.example.com" },
      { portal: "https://awsbridge-console-evil.example.com" },
      { portal: "https://evil.awsbridge-console.example.com" },
      { portal: "https://awsbridge-console.dev.example.com." },
      { team: "G2STD" },
      { team: "a/b" },
      { account: "12345" },
      { role: "Viewer" },
    ])
      expect(() => parseIssueTarget({ ...ok, ...bad }), JSON.stringify(bad)).toThrow();
  });
});

describe("assertWatchRole（Adm 枠では回さない: 本物の Administrator は断る）", () => {
  it("administrator は断る。ほかは通す", () => {
    expect(() => assertWatchRole("administrator")).toThrow(/Administrator/);
    expect(assertWatchRole("viewer")).toBe("viewer");
    expect(assertWatchRole("admin-probe")).toBe("admin-probe");
  });
});

describe("assertCookieFile（Cookie は <g2 dir>/cookies/ の下のファイルだけ。消すのもこの下だけ）", () => {
  // 実際のファイルで確かめる（シンボリックリンクを解決するため）
  const base = mkdtempSync(join(tmpdir(), "awsbridge-g2-cookie-"));
  const cookies = join(base, "cookies");
  const outside = join(base, "outside");
  mkdirSync(join(cookies, "a"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(cookies, "g2std.txt"), "x");
  writeFileSync(join(cookies, "a", "b.txt"), "x");
  writeFileSync(join(outside, "secret.txt"), "x");
  writeFileSync(join(base, "other.txt"), "x");
  symlinkSync(join(outside, "secret.txt"), join(cookies, "link.txt"));
  symlinkSync(outside, join(cookies, "linkdir"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("cookies の直下・下のファイルを受け付け、絶対パスを返す", () => {
    const real = realpathSync(cookies);
    expect(assertCookieFile(join(cookies, "g2std.txt"), cookies)).toBe(join(real, "g2std.txt"));
    expect(assertCookieFile(join(cookies, "a", "b.txt"), cookies)).toBe(join(real, "a", "b.txt"));
  });

  it("外のファイル・cookies 自身・.. で外に出るもの・無いファイルは断る", () => {
    for (const f of [
      join(base, "other.txt"),
      cookies,
      join(cookies, "..", "other.txt"),
      join(`${cookies}x`, "a.txt"),
      join(cookies, "none.txt"),
    ])
      expect(() => assertCookieFile(f, cookies), f).toThrow();
  });

  it("シンボリックリンクのファイルは断る（リンク先が cookies の外でも中でも）", () => {
    expect(() => assertCookieFile(join(cookies, "link.txt"), cookies)).toThrow(/リンク/);
  });

  it("リンクのディレクトリを経由して cookies の外に出るファイルは断る", () => {
    expect(() => assertCookieFile(join(cookies, "linkdir", "secret.txt"), cookies)).toThrow();
  });
});

describe("classifyAccountPage（GET <team>/a/<account>?role=）", () => {
  it("200 でフォームの csrf を取り出す", () => {
    expect(classifyAccountPage({ status: 200, location: null, body: page(CSRF) })).toEqual({
      ok: true,
      csrf: CSRF,
    });
  });

  it("csrf が無い 200 は no_csrf、Access のログインへの 302 は access_login_redirect、エラーの画面はその code", () => {
    expect(classifyAccountPage({ status: 200, location: null, body: "<p>x</p>" })).toEqual({
      ok: false,
      code: "no_csrf",
    });
    expect(
      classifyAccountPage({
        status: 302,
        location: "https://example-team.cloudflareaccess.com/cdn-cgi/access/login/x",
        body: "",
      }),
    ).toEqual({ ok: false, code: "access_login_redirect" });
    expect(
      classifyAccountPage({ status: 403, location: null, body: errorPage("access_forbidden") }),
    ).toEqual({ ok: false, code: "access_forbidden" });
    expect(classifyAccountPage({ status: 403, location: null, body: "Forbidden" })).toEqual({
      ok: false,
      code: "http_403",
    });
  });
});

describe("classifyLogin（POST <team>/login）", () => {
  it("AWS のサインインへの 302 は発行の成功（Location は返さない）", () => {
    const r = classifyLogin({
      status: 302,
      location: "https://signin.aws.amazon.com/federation?Action=login&SigninToken=secret",
      body: "",
    });
    expect(r).toEqual({ ok: true, code: "issued" });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(
      classifyLogin({
        status: 302,
        location: "https://us-east-1.signin.aws.amazon.com/federation?SigninToken=x",
        body: "",
      }),
    ).toEqual({ ok: true, code: "issued" });
  });

  it("Access のログインへの 302 と、ほかの 302 を分ける", () => {
    expect(
      classifyLogin({
        status: 302,
        location: "https://awsbridge-console.dev.example.com/cdn-cgi/access/login/x",
        body: "",
      }),
    ).toEqual({ ok: false, code: "access_login_redirect" });
    expect(
      classifyLogin({
        status: 302,
        location: "https://signin.aws.amazon.com.evil.example/x",
        body: "",
      }),
    ).toEqual({ ok: false, code: "http_302" });
    expect(classifyLogin({ status: 302, location: null, body: "" })).toEqual({
      ok: false,
      code: "http_302",
    });
  });

  it("エラーの画面の code を取り出す", () => {
    expect(classifyLogin({ status: 403, location: null, body: errorPage("csrf_failed") })).toEqual({
      ok: false,
      code: "csrf_failed",
    });
    expect(
      classifyLogin({ status: 503, location: null, body: errorPage("signing_unavailable") }),
    ).toEqual({
      ok: false,
      code: "signing_unavailable",
    });
  });
});

describe("loginBody", () => {
  it("entry=<account>:<role>、csrf、リージョン（指定したときだけ）", () => {
    expect(
      Object.fromEntries(new URLSearchParams(loginBody("123456789012", "viewer", CSRF, undefined))),
    ).toEqual({ entry: "123456789012:viewer", csrf: CSRF });
    expect(
      new URLSearchParams(loginBody("123456789012", "viewer", CSRF, "us-east-1")).get("region"),
    ).toBe("us-east-1");
  });
});

describe("本物の画面（src/console/portal/pages.ts）の出力で取り出せる", () => {
  it("loginFormPage の hidden の csrf を取り出す", () => {
    const config = standardConfig();
    const account = config.accounts.find((a) => a.roles.some((r) => r.teams.length > 0));
    if (!account) throw new Error("fixture: no account");
    const team = account.roles.find((r) => r.teams.length > 0)?.teams[0] as string;
    const roles = account.roles.flatMap((r) => {
      const role = config.roles.find((x) => x.name === r.role);
      return role ? [{ role, sessionSeconds: r.sessionSeconds }] : [];
    });
    const html = loginFormPage({
      config,
      team,
      teamBase: `/t/${team}`,
      account,
      roles,
      csrf: CSRF,
      loginDisabled: false,
    });
    expect(classifyAccountPage({ status: 200, location: null, body: html })).toEqual({
      ok: true,
      csrf: CSRF,
    });
  });

  it("errorPage の code を取り出す（要求 ID・戻るリンクつきでも）", () => {
    for (const code of [
      "csrf_failed",
      "not_listed",
      "login_disabled",
      "signing_unavailable",
    ] as const) {
      const html = realErrorPage(code, { requestId: "req-1", teamBase: "/t/g2std" });
      expect(classifyLogin({ status: 403, location: null, body: html }), code).toEqual({
        ok: false,
        code,
      });
      expect(classifyAccountPage({ status: 403, location: null, body: html }), code).toEqual({
        ok: false,
        code,
      });
    }
  });
});
