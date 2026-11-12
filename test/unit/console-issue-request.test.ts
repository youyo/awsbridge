// コンソールログイン: POST <team-base>/login の要求の検査（docs/specs/console-login-portal.md §9.3 の 3、§9.4）。
// POST だけ・Origin 必須（このデプロイのオリジンと完全一致）・Sec-Fetch-Site は same-origin・Content-Type はフォーム。
import { describe, expect, it } from "vitest";
import { checkLoginRequest } from "../../src/console/issue/request";

const ORIGIN = "https://portal.example.com";
const FORM = "application/x-www-form-urlencoded";

function req(h: { origin?: string; site?: string; ct?: string } = {}, method = "POST"): Request {
  const headers = new Headers();
  if (h.origin !== undefined) headers.set("Origin", h.origin);
  if (h.site !== undefined) headers.set("Sec-Fetch-Site", h.site);
  if (h.ct !== undefined) headers.set("Content-Type", h.ct);
  return new Request(`${ORIGIN}/t/dev/login`, { method, headers });
}

const ok = { origin: ORIGIN, site: "same-origin", ct: FORM };

describe("通るもの（陽性の対照）", () => {
  it("POST・同じオリジン・same-origin・フォーム", () => {
    expect(checkLoginRequest(req(ok), ORIGIN)).toBeUndefined();
  });

  it("Content-Type の charset のパラメーターと大文字小文字は問わない", () => {
    expect(
      checkLoginRequest(
        req({ ...ok, ct: "application/x-www-form-urlencoded; charset=UTF-8" }),
        ORIGIN,
      ),
    ).toBeUndefined();
    expect(
      checkLoginRequest(req({ ...ok, ct: "Application/X-WWW-Form-Urlencoded" }), ORIGIN),
    ).toBeUndefined();
  });

  it("Sec-Fetch-Site がない（送らないブラウザ）なら Origin だけで判定する", () => {
    expect(checkLoginRequest(req({ origin: ORIGIN, ct: FORM }), ORIGIN)).toBeUndefined();
  });

  it("手元の開発用に http://localhost のオリジンは設定として受け付ける", () => {
    const local = "http://localhost:8787";
    expect(checkLoginRequest(req({ ...ok, origin: local }), local)).toBeUndefined();
  });
});

describe("メソッド", () => {
  it.each(["GET", "HEAD", "PUT", "DELETE", "PATCH"])("%s は 405", (m) => {
    expect(checkLoginRequest(req(ok, m), ORIGIN)).toEqual({
      status: 405,
      code: "method_not_allowed",
    });
  });

  it("メソッドの判定を Origin より先にする", () => {
    expect(checkLoginRequest(req({}, "GET"), ORIGIN)?.code).toBe("method_not_allowed");
  });
});

describe("Origin（必須・完全一致）", () => {
  const forbidden = { status: 403, code: "forbidden_origin" };

  it("Origin がなければ拒否する（MCP 用と違い、ないものを通さない）", () => {
    expect(checkLoginRequest(req({ site: "same-origin", ct: FORM }), ORIGIN)).toEqual(forbidden);
  });

  it.each([
    "null",
    "",
    "https://evil.example.com",
    "https://portal.example.com.evil.example.com",
    "http://portal.example.com",
    "https://portal.example.com:8443",
    "https://portal.example.com/",
    "https://PORTAL.example.com",
    "https://admin-portal.example.com",
  ])("Origin %j は拒否する", (origin) => {
    expect(checkLoginRequest(req({ ...ok, origin }), ORIGIN)).toEqual(forbidden);
  });

  it.each(["cross-site", "same-site", "none", "SAME-ORIGIN"])(
    "Sec-Fetch-Site %s は拒否する",
    (site) => {
      expect(checkLoginRequest(req({ ...ok, site }), ORIGIN)).toEqual(forbidden);
    },
  );

  it("Origin の判定を Content-Type より先にする（403 が 415 より先）", () => {
    expect(checkLoginRequest(req({ ct: "application/json" }), ORIGIN)).toEqual(forbidden);
  });
});

describe("Content-Type", () => {
  it.each([
    undefined,
    "",
    "application/json",
    "multipart/form-data; boundary=x",
    "text/plain",
    "application/x-www-form-urlencoded-x",
  ])("Content-Type %j は 415", (ct) => {
    const h = ct === undefined ? { origin: ORIGIN, site: "same-origin" } : { ...ok, ct };
    expect(checkLoginRequest(req(h), ORIGIN)).toEqual({
      status: 415,
      code: "unsupported_media_type",
    });
  });
});

describe("設定のオリジンが壊れていれば通さない（fail closed）", () => {
  it.each([
    "",
    "portal.example.com",
    "http://portal.example.com",
    "https://portal.example.com/",
    "https://portal.example.com/t/dev",
    "https://portal.example.com?x=1",
    "null",
  ])("設定 %j は 500 server_misconfigured", (cfg) => {
    expect(checkLoginRequest(req({ ...ok, origin: cfg }), cfg)).toEqual({
      status: 500,
      code: "server_misconfigured",
    });
  });
});
