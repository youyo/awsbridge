import { calculateJwkThumbprint, createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import handler from "../../src/index";
import { signStsToken } from "../../src/oidc";
import { newPrivateJwk } from "./helpers";

const ISSUER = "https://awsbridge.example.workers.dev";

async function env() {
  const jwk = await newPrivateJwk();
  return { jwk, env: { ISSUER, SIGNING_JWK: JSON.stringify(jwk) } };
}
const get = (path: string, init?: RequestInit) => new Request(`${ISSUER}${path}`, init);

describe("handler", () => {
  it("discovery は 200 JSON", async () => {
    const { env: e } = await env();
    const res = await handler.fetch(get("/.well-known/openid-configuration"), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("jwks は 200 で秘密成分を含まず、発行トークンを検証できる", async () => {
    const { jwk, env: e } = await env();
    const res = await handler.fetch(get("/.well-known/jwks.json"), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    for (const f of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"']) expect(text).not.toContain(f);
    const token = await signStsToken({
      privateJwk: jwk,
      issuer: ISSUER,
      audience: "a",
      subject: "s",
    });
    await jwtVerify(token, createLocalJWKSet(JSON.parse(text)), { issuer: ISSUER });
  });

  it("未知パス・他メソッドは 404、リダイレクトしない", async () => {
    const { env: e } = await env();
    for (const [p, m] of [
      ["/", "GET"],
      ["/oauth/token", "GET"],
      ["/.well-known/jwks.json/", "GET"],
      ["/.well-known/jwks.json", "POST"],
      ["/.well-known/openid-configuration", "DELETE"],
    ] as const) {
      const res = await handler.fetch(get(p, { method: m }), e);
      expect(res.status, `${m} ${p}`).toBe(404);
    }
  });

  it("SIGNING_JWK 未設定・不正は 500 で秘密を出さない", async () => {
    for (const bad of [
      undefined,
      "not-json",
      JSON.stringify({ kty: "RSA", n: "x", e: "AQAB", d: "SECRETVALUE" }),
    ]) {
      const res = await handler.fetch(get("/.well-known/jwks.json"), {
        ISSUER,
        SIGNING_JWK: bad,
      } as never);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("SECRETVALUE");
    }
  });

  describe("ADDITIONAL_PUBLIC_JWKS（署名鍵のローテーション）", () => {
    const jwksOf = async (e: object) => {
      const res = await handler.fetch(get("/.well-known/jwks.json"), e as never);
      return { res, text: await res.text() };
    };
    const kidOf = (k: { n?: string; e?: string }) =>
      calculateJwkThumbprint({ kty: "RSA", n: k.n as string, e: k.e as string });

    it("署名鍵の公開鍵を先頭に、追加の公開鍵を並べる。秘密成分は出さない", async () => {
      const { jwk, env: e } = await env();
      const next = await newPrivateJwk();
      const prev = await newPrivateJwk();
      const { res, text } = await jwksOf({
        ...e,
        // next は秘密成分つき、prev は公開成分のみ
        ADDITIONAL_PUBLIC_JWKS: JSON.stringify([next, { kty: "RSA", n: prev.n, e: prev.e }]),
      });
      expect(res.status).toBe(200);
      const keys = (JSON.parse(text) as { keys: { kid: string }[] }).keys;
      expect(keys.map((k) => k.kid)).toEqual([
        await kidOf(jwk),
        await kidOf(next),
        await kidOf(prev),
      ]);
      for (const f of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"']) expect(text).not.toContain(f);
    });

    it("未設定・空・空配列なら署名鍵の 1 本だけ", async () => {
      const { env: e } = await env();
      for (const v of [undefined, "", "[]"]) {
        const { res, text } = await jwksOf({ ...e, ADDITIONAL_PUBLIC_JWKS: v });
        expect(res.status).toBe(200);
        expect(JSON.parse(text).keys).toHaveLength(1);
      }
    });

    it("kid の重複は除く", async () => {
      const { jwk, env: e } = await env();
      const { text } = await jwksOf({
        ...e,
        ADDITIONAL_PUBLIC_JWKS: JSON.stringify([jwk, jwk]),
      });
      expect(JSON.parse(text).keys).toHaveLength(1);
    });

    it("個々の追加鍵が不正なら、その要素だけ捨てて warn（値は出さない）。署名鍵と正しい追加鍵は残る", async () => {
      const { jwk, env: e } = await env();
      const good = await newPrivateJwk();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const longBad = "!".repeat(342);
      const bads: unknown[] = [
        { kty: "RSA", n: "SECRETVALUE", e: "AQAB" },
        { kty: "RSA", n: longBad, e: "AQAB", d: "SECRETVALUE" },
        { kty: "oct", k: "SECRETVALUE" },
        { kty: "RSA", e: "AQAB" },
        1,
        null,
        [],
      ];
      for (const bad of bads) {
        warn.mockClear();
        const { res, text } = await jwksOf({
          ...e,
          ADDITIONAL_PUBLIC_JWKS: JSON.stringify([bad, good]),
        });
        const label = JSON.stringify(bad);
        expect(res.status, label).toBe(200);
        const keys = (JSON.parse(text) as { keys: { kid: string }[] }).keys;
        expect(
          keys.map((k) => k.kid),
          label,
        ).toEqual([await kidOf(jwk), await kidOf(good)]);
        expect(warn.mock.calls, label).toEqual([
          ["jwks: invalid additional key skipped (index=0)"],
        ]);
        expect(text).not.toContain("SECRETVALUE");
      }
      // 添字は元の配列での位置
      warn.mockClear();
      await jwksOf({ ...e, ADDITIONAL_PUBLIC_JWKS: JSON.stringify([good, bads[0], bads[2]]) });
      expect(warn.mock.calls).toEqual([
        ["jwks: invalid additional key skipped (index=1)"],
        ["jwks: invalid additional key skipped (index=2)"],
      ]);
      warn.mockRestore();
    });

    it("JSON として壊れている・配列でない追加鍵設定は無視し、署名鍵だけで 200 を返して warn する", async () => {
      const { jwk, env: e } = await env();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const bad of ["{not json SECRETVALUE", '{"kty":"RSA","d":"SECRETVALUE"}', '"x"', "1"]) {
        warn.mockClear();
        const { res, text } = await jwksOf({ ...e, ADDITIONAL_PUBLIC_JWKS: bad });
        expect(res.status, bad).toBe(200);
        const keys = (JSON.parse(text) as { keys: { kid: string }[] }).keys;
        expect(
          keys.map((k) => k.kid),
          bad,
        ).toEqual([await kidOf(jwk)]);
        expect(warn, bad).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRETVALUE");
      }
      warn.mockRestore();
    });

    it("SIGNING_JWK が不正なら追加鍵が正しくても 500", async () => {
      const good = await newPrivateJwk();
      const res = await handler.fetch(get("/.well-known/jwks.json"), {
        ISSUER,
        SIGNING_JWK: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB", d: "SECRETVALUE" }),
        ADDITIONAL_PUBLIC_JWKS: JSON.stringify([good]),
      } as never);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("SECRETVALUE");
    });
  });
});
