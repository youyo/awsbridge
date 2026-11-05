import { calculateJwkThumbprint, createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { buildDiscovery, publicJwks, signStsToken } from "../../src/oidc";
import { newPrivateJwk } from "./helpers";

describe("buildDiscovery", () => {
  it("必須キーを含む", () => {
    const d = buildDiscovery("https://example.com");
    expect(d.issuer).toBe("https://example.com");
    expect(d.jwks_uri).toBe("https://example.com/.well-known/jwks.json");
    expect(d.authorization_endpoint).toBe("https://example.com/oauth/authorize");
    expect(d.token_endpoint).toBe("https://example.com/oauth/token");
    expect(d.response_types_supported).toEqual(["id_token"]);
    expect(d.subject_types_supported).toEqual(["public"]);
    expect(d.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(d.claims_supported).toEqual(
      expect.arrayContaining(["sub", "aud", "exp", "iat", "iss", "email"]),
    );
  });

  it("issuer の末尾スラッシュを除去する", () => {
    const d = buildDiscovery("https://example.com//");
    expect(d.issuer).toBe("https://example.com");
    expect(d.jwks_uri).toBe("https://example.com/.well-known/jwks.json");
  });
});

describe("publicJwks", () => {
  it("公開成分のみで kid は thumbprint", async () => {
    const priv = await newPrivateJwk();
    const jwks = await publicJwks(priv);
    expect(jwks.keys).toHaveLength(1);
    const k = jwks.keys[0] as Record<string, unknown>;
    for (const f of ["d", "p", "q", "dp", "dq", "qi"]) expect(k).not.toHaveProperty(f);
    expect(Object.keys(k).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(k.use).toBe("sig");
    expect(k.alg).toBe("RS256");
    expect(k.kid).toBe(
      await calculateJwkThumbprint({ kty: "RSA", n: priv.n as string, e: priv.e as string }),
    );
  });
});

describe("signStsToken", () => {
  const base = { issuer: "https://iss.example", audience: "awsbridge", subject: "u@example.com" };

  it("公開 JWKS で検証でき claims が正しい", async () => {
    const priv = await newPrivateJwk();
    const token = await signStsToken({
      privateJwk: priv,
      ...base,
      email: "u@example.com",
      now: 1_700_000_000,
    });
    const jwks = createLocalJWKSet(await publicJwks(priv));
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: base.issuer,
      audience: base.audience,
      currentDate: new Date(1_700_000_100 * 1000),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe((await publicJwks(priv)).keys[0]?.kid);
    expect(payload.sub).toBe(base.subject);
    expect(payload.email).toBe("u@example.com");
    expect(payload.iat).toBe(1_700_000_000);
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
  });

  it("ttlSeconds を指定でき、email は任意", async () => {
    const priv = await newPrivateJwk();
    const token = await signStsToken({
      privateJwk: priv,
      ...base,
      ttlSeconds: 60,
      now: 1_700_000_000,
    });
    const { payload } = await jwtVerify(token, createLocalJWKSet(await publicJwks(priv)), {
      currentDate: new Date(1_700_000_010 * 1000),
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
    expect(payload).not.toHaveProperty("email");
  });

  it("別鍵の JWKS では検証に失敗する", async () => {
    const priv = await newPrivateJwk();
    const other = await newPrivateJwk();
    const token = await signStsToken({ privateJwk: priv, ...base });
    await expect(jwtVerify(token, createLocalJWKSet(await publicJwks(other)))).rejects.toThrow();
  });
});
