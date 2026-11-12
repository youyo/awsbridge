// コンソールログイン PR2: Standard の署名（境界ごとの手元の鍵）と署名の差し込み口。
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  jwtVerify,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIENCE, UUID_RE } from "../../src/console/constants";
import { resolveIdentity } from "../../src/console/issue/identity";
import { createStandardSigner, parseSigningKeys } from "../../src/console/issue/sign-standard";
import {
  type IssueRow,
  type SigningRequest,
  type TokenSigner,
  unavailableSigner,
} from "../../src/console/issue/signer";
import { generateSigningJwk, publicJwkOf } from "../../src/keys";

const NOW = 1_700_000_000;
let managed: JWK;
let partner: JWK;

beforeAll(async () => {
  managed = await generateSigningJwk();
  partner = await generateSigningJwk();
});

const identity = { sub: "access-sub-1", email: "Alice@Example.com", oid: "oid-1" };
const row = (over: Partial<IssueRow> = {}): IssueRow => ({
  team: "infra",
  boundary: "managed",
  issuer: "https://idp.example.test/std",
  accountId: "123456789012",
  role: "viewer",
  roleArn: "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
  sessionSeconds: 3600,
  ...over,
});
const request = (over: Partial<SigningRequest> = {}): SigningRequest => {
  const r = resolveIdentity(identity, "email");
  if (!r.ok) throw new Error("fixture");
  return { identity, resolved: r.value, row: row(), now: NOW, ...over };
};

describe("createStandardSigner", () => {
  it("境界の鍵で RS256 の JWT に署名し、公開鍵で検証できる（kid は thumbprint）", async () => {
    const signer = createStandardSigner({ keys: { managed } });
    const r = await signer.sign(request());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pub = await importJWK(await publicJwkOf(managed), "RS256");
    const { payload, protectedHeader } = await jwtVerify(r.token.jwt, pub, {
      issuer: "https://idp.example.test/std",
      audience: AUDIENCE,
      currentDate: new Date((NOW + 10) * 1000),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe(
      await calculateJwkThumbprint({ kty: "RSA", n: managed.n as string, e: managed.e as string }),
    );
    expect(payload).toMatchObject({
      sub: "alice@example.com",
      iat: NOW,
      exp: NOW + 300,
      "https://aws.amazon.com/source_identity": "alice@example.com",
      "https://aws.amazon.com/tags": { principal_tags: { awsbridge_team: ["infra"] } },
    });
    expect("azp" in payload).toBe(false);
    expect(payload.jti).toMatch(UUID_RE);
    expect(r.token).toMatchObject({
      jti: payload.jti,
      iat: NOW,
      exp: NOW + 300,
      issuer: "https://idp.example.test/std",
    });
  });

  it("境界ごとに別の鍵で署名する（別の境界の鍵では検証できない）", async () => {
    const signer = createStandardSigner({ keys: { managed, "partner:acme": partner } });
    const r = await signer.sign(
      request({ row: row({ boundary: "partner:acme", issuer: "https://idp.example.test/p" }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(decodeProtectedHeader(r.token.jwt).kid).toBe(
      await calculateJwkThumbprint({ kty: "RSA", n: partner.n as string, e: partner.e as string }),
    );
    const wrong = await importJWK(await publicJwkOf(managed), "RS256");
    await expect(
      jwtVerify(r.token.jwt, wrong, { currentDate: new Date(NOW * 1000) }),
    ).rejects.toThrow();
  });

  it("その境界の鍵がなければ signing_unavailable（ほかの境界の鍵で代用しない）", async () => {
    const signer = createStandardSigner({ keys: { managed } });
    expect(await signer.sign(request({ row: row({ boundary: "partner:acme" }) }))).toEqual({
      ok: false,
      code: "signing_unavailable",
    });
  });

  it("鍵が壊れていて署名に失敗したら signing_unavailable（例外を出さず、鍵の内容を含めない）", async () => {
    // 秘密成分のない鍵（署名には使えない）が渡されても、例外を出さず署名できないことにする
    const broken = await publicJwkOf(managed);
    const signer = createStandardSigner({ keys: { managed: broken } });
    const r = await signer.sign(request());
    expect(r).toEqual({ ok: false, code: "signing_unavailable" });
  });

  it("入力が JWT の claim として不正（チーム名が規則に合わない）なら signing_unavailable に倒す", async () => {
    const signer = createStandardSigner({ keys: { managed } });
    expect(await signer.sign(request({ row: row({ team: "Bad Team" }) }))).toEqual({
      ok: false,
      code: "signing_unavailable",
    });
  });

  it("now を省略すると現在時刻を使う", async () => {
    const signer = createStandardSigner({ keys: { managed } });
    const before = Math.floor(Date.now() / 1000);
    const { now: _omit, ...withoutNow } = request();
    const r = await signer.sign(withoutNow);
    expect(r.ok && r.token.iat).toBeGreaterThanOrEqual(before);
  });

  it("TokenSigner として差し込める（unavailableSigner と同じ型）", async () => {
    const signers: TokenSigner[] = [createStandardSigner({ keys: { managed } }), unavailableSigner];
    expect(await signers[1]?.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
  });
});

describe("parseSigningKeys（境界ごとの鍵の JSON。1 つの secret）", () => {
  it("境界の名前 → 秘密鍵 JWK の JSON を読む", () => {
    const keys = parseSigningKeys(JSON.stringify({ managed, "partner:acme": partner }));
    expect(Object.keys(keys).sort()).toEqual(["managed", "partner:acme"]);
  });

  it.each([
    ["JSON でない", "not json"],
    ["配列", "[]"],
    ["空のオブジェクト", "{}"],
    ["値がオブジェクトでない", '{"managed":"x"}'],
  ])("%s は例外（server_misconfigured にできるよう、起動時に止める）", (_n, raw) => {
    expect(() => parseSigningKeys(raw)).toThrow();
  });

  it("公開鍵だけ（秘密成分 d がない）・RSA でない鍵は例外", async () => {
    const pub = await publicJwkOf(managed);
    expect(() => parseSigningKeys(JSON.stringify({ managed: pub }))).toThrow();
    expect(() =>
      parseSigningKeys(JSON.stringify({ managed: { kty: "oct", k: "AAAA" } })),
    ).toThrow();
  });

  it("alg があって RS256 でない鍵は例外（なければ通る）", () => {
    expect(() =>
      parseSigningKeys(JSON.stringify({ managed: { ...managed, alg: "RS512" } })),
    ).toThrow();
    expect(() =>
      parseSigningKeys(JSON.stringify({ managed: { ...managed, alg: "RS256" } })),
    ).not.toThrow();
    const { alg: _alg, ...noAlg } = managed;
    expect(() => parseSigningKeys(JSON.stringify({ managed: noAlg }))).not.toThrow();
  });

  it.each(["p", "q", "dp", "dq", "qi"])("CRT 成分 %s が無い鍵は例外", (k) => {
    const broken = { ...managed } as Record<string, unknown>;
    delete broken[k];
    expect(() => parseSigningKeys(JSON.stringify({ managed: broken }))).toThrow();
  });

  it.each(["AQ", "Aw", "AAAB", "AQAD"])("公開指数 e が 65537（AQAB）以外（%s）の鍵は例外", (e) => {
    expect(() => parseSigningKeys(JSON.stringify({ managed: { ...managed, e } }))).toThrow();
  });

  it("例外の文に鍵の内容（秘密成分）を含めない", () => {
    try {
      parseSigningKeys(JSON.stringify({ managed: { ...managed, n: "short" } }));
      throw new Error("resolved unexpectedly");
    } catch (e) {
      expect(String(e)).not.toContain(managed.d as string);
    }
  });
});
