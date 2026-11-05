import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AccessJwtError,
  type AccessJwtErrorReason,
  type AccessVerifyConfig,
  accessTokenFromRequest,
  verifyAccessJwt,
} from "../../src/access";

const TEAM = "https://team.example.cloudflareaccess.com";
const AUD = "aud-tag-0123456789abcdef";
const NOW = 1_800_000_000;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let good: KeyPair;
let other: KeyPair;

beforeAll(async () => {
  good = await generateKeyPair("RS256", { extractable: true });
  other = await generateKeyPair("RS256", { extractable: true });
});

const cfg = (over: Partial<AccessVerifyConfig> = {}): AccessVerifyConfig => ({
  teamDomain: TEAM,
  audience: AUD,
  ...over,
});
const opts = () => ({ getKey: async () => good.publicKey, now: NOW });

async function sign(
  claims: JWTPayload,
  o: {
    key?: KeyPair;
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    iat?: number;
  } = {},
) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? TEAM)
    .setAudience(o.aud ?? [AUD])
    .setSubject("11111111-2222-3333-4444-555555555555")
    .setIssuedAt(o.iat ?? NOW - 60)
    .setExpirationTime(o.exp ?? NOW + 3600);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign((o.key ?? good).privateKey);
}

const google = { email: "user@example.com", type: "app" };
const entra = {
  email: "user@example.com",
  type: "app",
  custom: { oid: "00000000-aaaa-bbbb-cccc-000000000000", groups: ["g1", "g2"] },
};

async function reasonOf(p: Promise<unknown>): Promise<AccessJwtErrorReason> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AccessJwtError);
    return (e as AccessJwtError).reason;
  }
  throw new Error("拒否されるはずが成功した");
}

const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("verifyAccessJwt 成功", () => {
  it("既定は email（Google 形）", async () => {
    const r = await verifyAccessJwt(await sign(google), cfg(), opts());
    expect(r.identity).toBe("user@example.com");
    expect(r.email).toBe("user@example.com");
    expect(r.sub).toBe("11111111-2222-3333-4444-555555555555");
    expect(r.claims.type).toBe("app");
  });
  it("identityClaim=email は小文字に正規化する（email 自体は原文のまま）", async () => {
    const r = await verifyAccessJwt(await sign({ email: "User@Example.COM" }), cfg(), opts());
    expect(r.identity).toBe("user@example.com");
    expect(r.email).toBe("User@Example.COM");
  });
  it("identityClaim=custom.* は正規化しない", async () => {
    const t = await sign({ custom: { oid: "AbC-DeF" } });
    const r = await verifyAccessJwt(t, cfg({ identityClaim: "custom.oid" }), opts());
    expect(r.identity).toBe("AbC-DeF");
  });
  it("identityClaim=sub", async () => {
    const r = await verifyAccessJwt(await sign(google), cfg({ identityClaim: "sub" }), opts());
    expect(r.identity).toBe("11111111-2222-3333-4444-555555555555");
  });
  it("identityClaim=custom.oid（Entra 形）", async () => {
    const r = await verifyAccessJwt(
      await sign(entra),
      cfg({ identityClaim: "custom.oid" }),
      opts(),
    );
    expect(r.identity).toBe("00000000-aaaa-bbbb-cccc-000000000000");
    expect(r.email).toBe("user@example.com");
  });
  it("aud が文字列でも通る", async () => {
    const r = await verifyAccessJwt(await sign(google, { aud: AUD }), cfg(), opts());
    expect(r.identity).toBe("user@example.com");
  });
  it("aud に複数あっても cfg.audience を含めば通る", async () => {
    const t = await sign(google, { aud: ["other", AUD] });
    expect((await verifyAccessJwt(t, cfg(), opts())).identity).toBe("user@example.com");
  });
  it("teamDomain の末尾スラッシュは正規化される", async () => {
    const r = await verifyAccessJwt(await sign(google), cfg({ teamDomain: `${TEAM}/` }), opts());
    expect(r.identity).toBe("user@example.com");
  });
  it("maxTokenAgeSeconds 以内なら通る", async () => {
    const r = await verifyAccessJwt(await sign(google), cfg({ maxTokenAgeSeconds: 3600 }), opts());
    expect(r.identity).toBe("user@example.com");
  });
  it("clock tolerance 内の nbf 未来は通る", async () => {
    const t = await sign(google, { nbf: NOW + 5 });
    expect((await verifyAccessJwt(t, cfg(), opts())).identity).toBe("user@example.com");
  });
});

describe("verifyAccessJwt 失敗", () => {
  it("署名鍵違い → invalid", async () => {
    const t = await sign(google, { key: other });
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("invalid");
  });
  it("iss 違い → invalid", async () => {
    const t = await sign(google, { iss: "https://evil.cloudflareaccess.com" });
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("invalid");
  });
  it("aud 不一致（配列・文字列とも） → invalid", async () => {
    expect(await reasonOf(verifyAccessJwt(await sign(google, { aud: ["x"] }), cfg(), opts()))).toBe(
      "invalid",
    );
    expect(await reasonOf(verifyAccessJwt(await sign(google, { aud: "x" }), cfg(), opts()))).toBe(
      "invalid",
    );
  });
  it("期限切れ → expired", async () => {
    const t = await sign(google, { exp: NOW - 3600 });
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("expired");
  });
  it("nbf が未来（tolerance 超） → invalid", async () => {
    const t = await sign(google, { nbf: NOW + 3600 });
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("invalid");
  });
  it("custom 欠落（Google 形で custom.oid 指定） → identity_missing", async () => {
    const t = await sign(google);
    expect(await reasonOf(verifyAccessJwt(t, cfg({ identityClaim: "custom.oid" }), opts()))).toBe(
      "identity_missing",
    );
  });
  it("custom 値が文字列でない／空 → identity_missing", async () => {
    for (const oid of [123, "", null, ["a"]]) {
      const t = await sign({ ...google, custom: { oid } });
      expect(await reasonOf(verifyAccessJwt(t, cfg({ identityClaim: "custom.oid" }), opts()))).toBe(
        "identity_missing",
      );
    }
  });
  it("email が無い → identity_missing", async () => {
    const t = await sign({ type: "app" });
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("identity_missing");
  });
  it("iat が maxTokenAgeSeconds より古い → too_old", async () => {
    const t = await sign(google, { iat: NOW - 7200 });
    expect(await reasonOf(verifyAccessJwt(t, cfg({ maxTokenAgeSeconds: 3600 }), opts()))).toBe(
      "too_old",
    );
  });
  it("maxTokenAgeSeconds 指定時に iat が無い → too_old", async () => {
    const jwt = await new SignJWT(google)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(TEAM)
      .setAudience([AUD])
      .setExpirationTime(NOW + 3600)
      .sign(good.privateKey);
    expect(await reasonOf(verifyAccessJwt(jwt, cfg({ maxTokenAgeSeconds: 3600 }), opts()))).toBe(
      "too_old",
    );
  });
  it("maxTokenAgeSeconds 未指定なら古い iat も通る", async () => {
    const t = await sign(google, { iat: NOW - 30 * 86400, exp: NOW + 60 });
    expect((await verifyAccessJwt(t, cfg(), opts())).identity).toBe("user@example.com");
  });
  it("空文字・形式不正 → missing / invalid", async () => {
    expect(await reasonOf(verifyAccessJwt("", cfg(), opts()))).toBe("missing");
    expect(await reasonOf(verifyAccessJwt("not-a-jwt", cfg(), opts()))).toBe("invalid");
  });
  it("alg=none の偽造トークン → invalid", async () => {
    const t = `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ ...google, iss: TEAM, aud: [AUD], exp: NOW + 3600 })}.`;
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("invalid");
  });
  it("HS256 の偽造トークン（公開鍵 JWK を HMAC 鍵に流用） → invalid", async () => {
    const jwk = await exportJWK(good.publicKey);
    const secret = new TextEncoder().encode(JSON.stringify(jwk));
    const t = await new SignJWT(google)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(TEAM)
      .setAudience([AUD])
      .setExpirationTime(NOW + 3600)
      .sign(secret);
    expect(await reasonOf(verifyAccessJwt(t, cfg(), opts()))).toBe("invalid");
  });
});

describe("accessTokenFromRequest", () => {
  it("Cf-Access-Jwt-Assertion ヘッダーを返す", () => {
    const req = new Request("https://x.example/", {
      headers: { "Cf-Access-Jwt-Assertion": "tok" },
    });
    expect(accessTokenFromRequest(req)).toBe("tok");
  });
  it("ヘッダーが無ければ missing（Cookie CF_Authorization は信頼しない）", () => {
    const req = new Request("https://x.example/", { headers: { Cookie: "CF_Authorization=tok" } });
    try {
      accessTokenFromRequest(req);
      throw new Error("投げられるはず");
    } catch (e) {
      expect(e).toBeInstanceOf(AccessJwtError);
      expect((e as AccessJwtError).reason).toBe("missing");
    }
  });
});
