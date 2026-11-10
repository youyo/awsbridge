import { describe, expect, it } from "vitest";
import { handleIssuerRequest } from "../../scripts/poc/human/worker-handler";

const docs = {
  discovery: { issuer: "https://awsbridge-human-poc.example.workers.dev" },
  jwks: { keys: [{ kty: "RSA", n: "n", e: "AQAB", kid: "k1", use: "sig", alg: "RS256" }] },
};
const base = "https://awsbridge-human-poc.example.workers.dev";

describe("handleIssuerRequest（PoC 用 issuer Worker。署名はしない）", () => {
  it("discovery を JSON で返す", async () => {
    const r = handleIssuerRequest(new Request(`${base}/.well-known/openid-configuration`), docs);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await r.json()).toEqual(docs.discovery);
  });
  it("JWKS を JSON で返す", async () => {
    const r = handleIssuerRequest(new Request(`${base}/.well-known/jwks.json`), docs);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await r.json()).toEqual(docs.jwks);
  });
  it("HEAD も 200（本文なし）", async () => {
    const r = handleIssuerRequest(
      new Request(`${base}/.well-known/jwks.json`, { method: "HEAD" }),
      docs,
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
  it("それ以外のパスは 404", () => {
    for (const p of ["/", "/oauth/authorize", "/oauth/token", "/.well-known/jwks.json/x"])
      expect(handleIssuerRequest(new Request(`${base}${p}`), docs).status, p).toBe(404);
  });
  it("GET / HEAD 以外は 405", () => {
    const r = handleIssuerRequest(
      new Request(`${base}/.well-known/jwks.json`, { method: "POST", body: "x" }),
      docs,
    );
    expect(r.status).toBe(405);
  });
});
