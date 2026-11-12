// コンソールログイン: 応答ヘッダー（docs/specs/console-login-portal.md §9.5・§9.6）。
import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  securityHeaders,
  withSecurityHeaders,
} from "../../src/console/http/headers";

/** CSP を { ディレクティブ: [値...] } にする。 */
function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    expect(out[name], `${name} が重複`).toBeUndefined();
    out[name] = values;
  }
  return out;
}

const AWS_FORM_ACTIONS = [
  "https://signin.aws.amazon.com",
  "https://*.signin.aws.amazon.com",
  "https://console.aws.amazon.com",
  "https://*.console.aws.amazon.com",
];

describe("Content-Security-Policy", () => {
  const d = directives(CONTENT_SECURITY_POLICY);

  it("スクリプトは自前（'self'）だけ。inline・eval・外部を許さない", () => {
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*\s*;/);
  });

  it("default-src は 'self'", () => {
    expect(d["default-src"]).toEqual(["'self'"]);
  });

  it("frame-ancestors 'none'（クリックジャッキングの防止）", () => {
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("form-action は自分と AWS のサインイン・コンソールだけ（リダイレクトの連鎖まで許す。PoC の N10）", () => {
    expect(d["form-action"]).toEqual(["'self'", ...AWS_FORM_ACTIONS]);
  });

  it("object-src と base-uri は 'none'", () => {
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
  });
});

describe("securityHeaders", () => {
  it("画面（既定）: CSP・no-store・Referrer-Policy same-origin・nosniff", () => {
    const h = securityHeaders();
    expect(h["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["Referrer-Policy"]).toBe("same-origin");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("静的なファイルには no-store を付けない（ほかは同じ）", () => {
    const h = securityHeaders("static");
    expect(h["Cache-Control"]).toBeUndefined();
    expect(h["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(h["Referrer-Policy"]).toBe("same-origin");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("呼ぶたびに別のオブジェクトを返す（呼び出し側の変更が次の応答に漏れない）", () => {
    const a = securityHeaders();
    a["Cache-Control"] = "public";
    expect(securityHeaders()["Cache-Control"]).toBe("no-store");
  });
});

describe("withSecurityHeaders", () => {
  it("状態・本文・ほかのヘッダーを保ち、セキュリティのヘッダーを付ける", async () => {
    const res = withSecurityHeaders(
      new Response("<p>x</p>", {
        status: 403,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("<p>x</p>");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // 画面の応答では、元の Cache-Control を no-store で上書きする
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("302（ヘッダーを変えられない Response.redirect）にも付けられ、Location を保つ", () => {
    const res = withSecurityHeaders(
      Response.redirect("https://signin.aws.amazon.com/federation", 302),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://signin.aws.amazon.com/federation");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("静的なファイルでは元の Cache-Control を保つ", () => {
    const res = withSecurityHeaders(
      new Response("body{}", { headers: { "Cache-Control": "public, max-age=300" } }),
      "static",
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
