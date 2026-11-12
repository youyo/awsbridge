// PoC N6（Admin の階層の署名鍵を AWS KMS に置く）の純粋関数。
// KMS の応答（RSA はそのまま、ECDSA は DER）を JWS の形に直す・SPKI から JWKS を作る・claim・KMS の要求と応答・計測の集計。
import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  randomBytes,
} from "node:crypto";
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";
import { describe, expect, it } from "vitest";
import {
  ADMIN_KMS_DEFAULTS,
  adminKmsClaims,
  assembleJws,
  base64url,
  bearerMatches,
  derToJoseEcdsa,
  issuerJwks,
  jwkFromSpki,
  jwsSigningInput,
  KMS_RAW_MESSAGE_LIMIT,
  kmsErrorCode,
  kmsSessionName,
  kmsSigningAlgorithm,
  kmsSignRequest,
  parseKeysConfig,
  parseKmsSignResponse,
  timingStats,
} from "../../scripts/poc/admin-kms/lib";

const ISSUER = "https://awsbridge-admin-kms-poc.example.workers.dev";

function der(r: Uint8Array, s: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => [0x02, v.length, ...v];
  const body = [...int(r), ...int(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe("derToJoseEcdsa（KMS の ECDSA_SHA_256 の DER 署名 → JWS の r||s 64 バイト）", () => {
  it("r・s が 32 バイトならそのまま連結する", () => {
    const r = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const s = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
    expect([...derToJoseEcdsa(der(r, s))]).toEqual([...r, ...s]);
  });
  it("先頭ビットが立つ値に付く 0x00（33 バイト）を外す", () => {
    const r = Uint8Array.from({ length: 32 }, () => 0xff);
    const s = Uint8Array.from({ length: 32 }, () => 0x80);
    const out = derToJoseEcdsa(der(Uint8Array.from([0, ...r]), Uint8Array.from([0, ...s])));
    expect(out.length).toBe(64);
    expect([...out]).toEqual([...r, ...s]);
  });
  it("32 バイトより短い値は左を 0 で埋める", () => {
    const r = Uint8Array.from({ length: 31 }, () => 0x11);
    const s = Uint8Array.from([0x01]);
    const out = derToJoseEcdsa(der(r, s));
    expect([...out.slice(0, 32)]).toEqual([0, ...r]);
    expect([...out.slice(32)]).toEqual([...new Array(31).fill(0), 1]);
  });
  it.each([
    ["空", new Uint8Array()],
    ["SEQUENCE でない", Uint8Array.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])],
    ["長さが合わない", Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])],
    ["INTEGER でない", Uint8Array.from([0x30, 0x06, 0x04, 0x01, 0x01, 0x02, 0x01, 0x01])],
    [
      "値が 32 バイトを超える",
      der(
        Uint8Array.from({ length: 33 }, () => 1),
        Uint8Array.from([1]),
      ),
    ],
  ])("壊れた DER（%s）は例外", (_, bad) => {
    expect(() => derToJoseEcdsa(bad)).toThrow();
  });
  it("Node の ECDSA P-256（DER）で署名した 100 個が、変換後に ieee-p1363 として検証できる", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    for (let i = 0; i < 100; i++) {
      const msg = randomBytes(40);
      const sig = nodeSign("sha256", msg, { key: privateKey, dsaEncoding: "der" });
      const raw = derToJoseEcdsa(new Uint8Array(sig));
      expect(raw.length).toBe(64);
      const ok = nodeVerify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, raw);
      expect(ok).toBe(true);
    }
  });
});

describe("kmsSigningAlgorithm", () => {
  it("RS256 → RSASSA_PKCS1_V1_5_SHA_256、ES256 → ECDSA_SHA_256", () => {
    expect(kmsSigningAlgorithm("RS256")).toBe("RSASSA_PKCS1_V1_5_SHA_256");
    expect(kmsSigningAlgorithm("ES256")).toBe("ECDSA_SHA_256");
  });
});

describe("jwsSigningInput と assembleJws", () => {
  const claims = { iss: ISSUER, sub: "x", aud: "a", iat: 1, exp: 9999999999 };
  it("header は alg・kid・typ。base64url（パディングなし）を . でつなぐ", () => {
    const input = jwsSigningInput({ alg: "RS256", kid: "k1" }, claims);
    const [h, p] = input.split(".");
    expect(JSON.parse(Buffer.from(h as string, "base64url").toString())).toEqual({
      alg: "RS256",
      kid: "k1",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p as string, "base64url").toString())).toEqual(claims);
    expect(input).not.toMatch(/[=+/]/);
  });
  it("RS256: KMS の署名（PKCS#1 v1.5）をそのまま付けた JWT が公開鍵 JWK で検証できる", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = jwsSigningInput({ alg: "RS256", kid: "rsa-kid" }, claims);
    const sig = nodeSign("sha256", Buffer.from(input), privateKey);
    const jwt = assembleJws(input, new Uint8Array(sig), "RS256");
    const key = await importJWK(publicKey.export({ format: "jwk" }), "RS256");
    const { payload, protectedHeader } = await jwtVerify(jwt, key);
    expect(payload).toMatchObject(claims);
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "rsa-kid" });
  });
  it("ES256: KMS の DER 署名を r||s に直した JWT が公開鍵 JWK で検証できる", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const input = jwsSigningInput({ alg: "ES256", kid: "ec-kid" }, claims);
    const sig = nodeSign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "der" });
    const jwt = assembleJws(input, new Uint8Array(sig), "ES256");
    const key = await importJWK(publicKey.export({ format: "jwk" }), "ES256");
    await expect(jwtVerify(jwt, key)).resolves.toBeTruthy();
  });
  it("ES256 で 64 バイトでない・DER でない署名は例外", () => {
    expect(() => assembleJws("a.b", new Uint8Array(64), "ES256")).toThrow();
  });
});

describe("jwkFromSpki（KMS の GetPublicKey の DER → 公開鍵 JWK）", () => {
  it("RSA: n・e と kid（RFC 7638 thumbprint）・use・alg を付け、秘密成分は無い", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    const jwk = await jwkFromSpki(spki, "RS256");
    const ref = publicKey.export({ format: "jwk" });
    expect(jwk).toEqual({
      kty: "RSA",
      n: ref.n,
      e: ref.e,
      kid: await calculateJwkThumbprint({ kty: "RSA", n: ref.n as string, e: ref.e as string }),
      use: "sig",
      alg: "RS256",
    });
  });
  it("EC P-256: crv・x・y と kid を付ける", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    const jwk = await jwkFromSpki(spki, "ES256");
    const ref = publicKey.export({ format: "jwk" });
    expect(jwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: ref.x,
      y: ref.y,
      kid: await calculateJwkThumbprint({
        kty: "EC",
        crv: "P-256",
        x: ref.x as string,
        y: ref.y as string,
      }),
      use: "sig",
      alg: "ES256",
    });
  });
  it("鍵の種類と alg が合わなければ例外（RSA の SPKI を ES256 として読まない）", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    await expect(jwkFromSpki(spki, "ES256")).rejects.toThrow();
  });
  it("RSA 2048 bit 未満は例外", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    await expect(jwkFromSpki(spki, "RS256")).rejects.toThrow();
  });
});

describe("issuerJwks", () => {
  it("並べた順の keys。kid の重複は例外", () => {
    const a = { kty: "RSA", n: "n", e: "AQAB", kid: "a", use: "sig", alg: "RS256" };
    const b = { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "b", use: "sig", alg: "ES256" };
    expect(issuerJwks([a, b])).toEqual({ keys: [a, b] });
    expect(() => issuerJwks([a, a])).toThrow();
    expect(() => issuerJwks([])).toThrow();
  });
});

describe("adminKmsClaims（Worker が固定する claim）", () => {
  it("iss・aud・sub・iat・exp・jti と、入れ子形式のセッションタグ access_profile・SourceIdentity", () => {
    const c = adminKmsClaims({
      issuer: `${ISSUER}/`,
      audience: "awsbridge-admin-kms-poc",
      subject: "awsbridge-kms-check",
      accessProfile: "poc-admin",
      now: 1000,
      jti: "j-1",
    });
    expect(c).toEqual({
      iss: ISSUER,
      aud: "awsbridge-admin-kms-poc",
      sub: "awsbridge-kms-check",
      iat: 1000,
      exp: 1300,
      jti: "j-1",
      "https://aws.amazon.com/tags": { principal_tags: { access_profile: ["poc-admin"] } },
      "https://aws.amazon.com/source_identity": "awsbridge-kms-check",
    });
  });
  it("ttl を変えられる（既定 300 秒）", () => {
    const c = adminKmsClaims({
      issuer: ISSUER,
      audience: "a",
      subject: "ab",
      accessProfile: "poc-admin",
      now: 0,
      jti: "j",
      ttlSeconds: 60,
    });
    expect(c.exp).toBe(60);
  });
  it("SourceIdentity に使えない sub は例外", () => {
    expect(() =>
      adminKmsClaims({
        issuer: ISSUER,
        audience: "a",
        subject: "a b",
        accessProfile: "poc-admin",
        now: 0,
        jti: "j",
      }),
    ).toThrow();
  });
});

describe("kmsSignRequest / parseKmsSignResponse / kmsErrorCode", () => {
  it("Sign の要求: X-Amz-Target は TrentService.Sign、本文は KeyId・Message（base64）・MessageType RAW・SigningAlgorithm", () => {
    const msg = new TextEncoder().encode("h.p");
    const r = kmsSignRequest({ keyId: "arn:k", message: msg, alg: "ES256" });
    expect(r.headers).toEqual({
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "TrentService.Sign",
    });
    expect(JSON.parse(r.body)).toEqual({
      KeyId: "arn:k",
      Message: Buffer.from("h.p").toString("base64"),
      MessageType: "RAW",
      SigningAlgorithm: "ECDSA_SHA_256",
    });
  });
  it("messageType・signingAlgorithm を上書きできる（鍵ポリシーの確認用）", () => {
    const r = kmsSignRequest({
      keyId: "k",
      message: new Uint8Array(32),
      alg: "RS256",
      messageType: "DIGEST",
      signingAlgorithm: "RSASSA_PSS_SHA_256",
    });
    expect(JSON.parse(r.body)).toMatchObject({
      MessageType: "DIGEST",
      SigningAlgorithm: "RSASSA_PSS_SHA_256",
    });
  });
  it(`RAW の上限（${KMS_RAW_MESSAGE_LIMIT} バイト）を超える署名対象は例外`, () => {
    expect(() =>
      kmsSignRequest({
        keyId: "k",
        message: new Uint8Array(KMS_RAW_MESSAGE_LIMIT + 1),
        alg: "RS256",
      }),
    ).toThrow();
  });
  it("応答の Signature（base64）をバイト列にする。無ければ例外", () => {
    const sig = randomBytes(8);
    expect([
      ...parseKmsSignResponse(
        JSON.stringify({ Signature: Buffer.from(sig).toString("base64"), KeyId: "k" }),
      ),
    ]).toEqual([...sig]);
    expect(() => parseKmsSignResponse("{}")).toThrow();
    expect(() => parseKmsSignResponse("not json")).toThrow();
  });
  it("エラーの __type から名前空間を外したコード。読めなければ HTTP<status>", () => {
    expect(kmsErrorCode(400, JSON.stringify({ __type: "DisabledException", message: "x" }))).toBe(
      "DisabledException",
    );
    expect(
      kmsErrorCode(400, JSON.stringify({ __type: "com.amazonaws.kms#AccessDeniedException" })),
    ).toBe("AccessDeniedException");
    expect(kmsErrorCode(503, "<html>")).toBe("HTTP503");
  });
});

describe("parseKeysConfig（Worker の KMS_KEYS）", () => {
  const arn = "arn:aws:kms:ap-northeast-1:123456789012:key/0123abcd-0123-4567-89ab-0123456789ab";
  it("label → keyId・alg・kid", () => {
    expect(
      parseKeysConfig(JSON.stringify([{ label: "rsa", keyId: arn, alg: "RS256", kid: "k1" }])),
    ).toEqual({ rsa: { keyId: arn, alg: "RS256", kid: "k1" } });
  });
  it.each([
    ["JSON でない", "x"],
    ["配列でない", "{}"],
    ["label が不正", JSON.stringify([{ label: "A B", keyId: arn, alg: "RS256", kid: "k" }])],
    [
      "keyId が KMS の鍵 ARN でない",
      JSON.stringify([{ label: "a", keyId: "alias/x", alg: "RS256", kid: "k" }]),
    ],
    ["alg が不正", JSON.stringify([{ label: "a", keyId: arn, alg: "HS256", kid: "k" }])],
    ["kid が空", JSON.stringify([{ label: "a", keyId: arn, alg: "RS256", kid: "" }])],
    [
      "label の重複",
      JSON.stringify([
        { label: "a", keyId: arn, alg: "RS256", kid: "k" },
        { label: "a", keyId: arn, alg: "RS256", kid: "k2" },
      ]),
    ],
  ])("%s は例外", (_, raw) => {
    expect(() => parseKeysConfig(raw)).toThrow();
  });
});

describe("kmsSessionName", () => {
  it("kms- + KMS の RequestId（UUID）。RoleSessionName の制約（2〜64 文字）に収まる", () => {
    const id = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    expect(kmsSessionName(id)).toBe(`kms-${id}`);
    expect(kmsSessionName(id)).toMatch(/^[\w+=,.@-]{2,64}$/);
  });
  it("RequestId が無い・形が違えば kms-unknown", () => {
    expect(kmsSessionName(undefined)).toBe("kms-unknown");
    expect(kmsSessionName("a b/c")).toBe("kms-unknown");
  });
});

describe("timingStats", () => {
  it("件数・最小・中央値・p90・最大・平均（ミリ秒、小数第 1 位）", () => {
    expect(timingStats([5, 1, 3, 2, 4])).toEqual({
      n: 5,
      min: 1,
      median: 3,
      p90: 5,
      max: 5,
      mean: 3,
    });
    expect(timingStats([1, 2, 3, 4])).toMatchObject({ median: 2.5 });
  });
  it("空なら n 0 で値は undefined", () => {
    expect(timingStats([])).toEqual({ n: 0 });
  });
});

describe("bearerMatches", () => {
  it("Bearer <token> が一致するときだけ true。空の期待値は常に false", () => {
    expect(bearerMatches("Bearer abc123", "abc123")).toBe(true);
    expect(bearerMatches("Bearer abc124", "abc123")).toBe(false);
    expect(bearerMatches("bearer abc123", "abc123")).toBe(true);
    expect(bearerMatches("abc123", "abc123")).toBe(false);
    expect(bearerMatches(null, "abc123")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});

describe("base64url と既定値", () => {
  it("パディングなし", () => {
    expect(base64url(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
  });
  it("既定値（Worker 名・スタック名・audience・sub）は PoC 用で個人の値を含まない", () => {
    expect(ADMIN_KMS_DEFAULTS).toMatchObject({
      workerName: "awsbridge-admin-kms-poc",
      stackName: "awsbridge-admin-kms-poc",
      audience: "awsbridge-admin-kms-poc",
      subject: "awsbridge-kms-check",
    });
  });
  it("decodeJwt / decodeProtectedHeader で読める（jose と互換）", () => {
    const input = jwsSigningInput({ alg: "RS256", kid: "k" }, { sub: "x" });
    const jwt = assembleJws(input, new Uint8Array(256), "RS256");
    expect(decodeProtectedHeader(jwt).kid).toBe("k");
    expect(decodeJwt(jwt).sub).toBe("x");
  });
});
