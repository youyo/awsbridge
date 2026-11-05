import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
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
});
