// PoC N6 の Worker の処理（handler.ts）。KMS・STS・Federation は差し替えた fetch で返す（実 AWS は呼ばない）。
import { generateKeyPairSync, type KeyObject, sign as nodeSign } from "node:crypto";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AdminKmsEnv,
  handleAdminKmsRequest,
  MAX_SIGN_COUNT,
} from "../../scripts/poc/admin-kms/handler";
import { issuerJwks, jwkFromSpki } from "../../scripts/poc/admin-kms/lib";
import { buildDiscovery } from "../../src/oidc";

const ISSUER = "https://awsbridge-admin-kms-poc.example.workers.dev";
const RSA_ARN = "arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111";
const EC_ARN = "arn:aws:kms:ap-northeast-1:123456789012:key/22222222-2222-4222-8222-222222222222";
const ROLE_ARN = "arn:aws:iam::123456789012:role/AwsbridgeAdminKmsPoc";
const TOKEN = "caller-token-0123456789";
const KMS_REQ_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const SECRET_SESSION_TOKEN = "SESSION-TOKEN-SECRET";
const SIGNIN_TOKEN = "SIGNIN-TOKEN-SECRET";

let rsa: { privateKey: KeyObject; kid: string };
let ec: { privateKey: KeyObject; kid: string };
let docs: { discovery: unknown; jwks: { keys: Record<string, unknown>[] } };

beforeAll(async () => {
  const r = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const e = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rj = await jwkFromSpki(
    new Uint8Array(r.publicKey.export({ format: "der", type: "spki" })),
    "RS256",
  );
  const ej = await jwkFromSpki(
    new Uint8Array(e.publicKey.export({ format: "der", type: "spki" })),
    "ES256",
  );
  rsa = { privateKey: r.privateKey, kid: rj.kid as string };
  ec = { privateKey: e.privateKey, kid: ej.kid as string };
  docs = {
    discovery: buildDiscovery(ISSUER),
    jwks: issuerJwks([rj, ej]) as { keys: Record<string, unknown>[] },
  };
});

function env(over: Partial<AdminKmsEnv> = {}): AdminKmsEnv {
  return {
    ISSUER,
    ROLE_ARN,
    KMS_KEYS: JSON.stringify([
      { label: "rsa", keyId: RSA_ARN, alg: "RS256", kid: rsa.kid },
      { label: "ec", keyId: EC_ARN, alg: "ES256", kid: ec.kid },
    ]),
    CALLER_TOKEN: TOKEN,
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE",
    AWS_SECRET_ACCESS_KEY: "fake-secret",
    AWS_REGION: "ap-northeast-1",
    ...over,
  };
}

interface Seen {
  kms: { url: string; target: string | null; auth: string | null; body: Record<string, string> }[];
  sts: { url: string; params: URLSearchParams }[];
  fed: { url: string }[];
}

type Mode = { kms?: "ok" | "disabled"; sts?: "ok" | "denied"; fed?: "ok" | "error" };

function fakeFetch(mode: Mode = {}): { fetch: typeof fetch; seen: Seen } {
  const seen: Seen = { kms: [], sts: [], fed: [] };
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.startsWith("kms.") || url.pathname.startsWith("/kms")) {
      const body = (await req.json()) as Record<string, string>;
      seen.kms.push({
        url: req.url,
        target: req.headers.get("x-amz-target"),
        auth: req.headers.get("authorization"),
        body,
      });
      if (mode.kms === "disabled")
        return new Response(JSON.stringify({ __type: "DisabledException", message: "disabled" }), {
          status: 400,
          headers: { "x-amzn-requestid": KMS_REQ_ID },
        });
      const msg = Buffer.from(body.Message as string, "base64");
      const key = body.KeyId === RSA_ARN ? rsa.privateKey : ec.privateKey;
      const sig =
        body.SigningAlgorithm === "ECDSA_SHA_256"
          ? nodeSign("sha256", msg, { key, dsaEncoding: "der" })
          : nodeSign("sha256", msg, key);
      return new Response(
        JSON.stringify({ KeyId: body.KeyId, Signature: Buffer.from(sig).toString("base64") }),
        {
          headers: { "x-amzn-requestid": KMS_REQ_ID },
        },
      );
    }
    if (url.hostname.startsWith("sts.") || url.pathname.startsWith("/sts")) {
      const params = new URLSearchParams(await req.text());
      seen.sts.push({ url: req.url, params });
      if (mode.sts === "denied")
        return new Response(
          "<ErrorResponse><Error><Code>InvalidIdentityToken</Code><Message>no</Message></Error></ErrorResponse>",
          { status: 400, headers: { "x-amzn-requestid": "sts-req-err" } },
        );
      return new Response(
        `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><SourceIdentity>awsbridge-kms-check</SourceIdentity><Credentials><AccessKeyId>ASIAX</AccessKeyId><SecretAccessKey>S</SecretAccessKey><SessionToken>${SECRET_SESSION_TOKEN}</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/AwsbridgeAdminKmsPoc/x</Arn><AssumedRoleId>AROAX:x</AssumedRoleId></AssumedRoleUser></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
        { headers: { "x-amzn-requestid": "sts-req-1" } },
      );
    }
    if (url.hostname === "signin.aws.amazon.com" || url.pathname.startsWith("/federation")) {
      seen.fed.push({ url: req.url });
      if (mode.fed === "error") return new Response("bad", { status: 400 });
      return new Response(JSON.stringify({ SigninToken: SIGNIN_TOKEN }));
    }
    return new Response("unexpected", { status: 599 });
  };
  return { fetch: f as typeof fetch, seen };
}

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`${ISSUER}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("issuer の文書", () => {
  it("discovery と JWKS を静的に返す（KMS は呼ばない）", async () => {
    const { fetch, seen } = fakeFetch();
    const d = await handleAdminKmsRequest(
      new Request(`${ISSUER}/.well-known/openid-configuration`),
      env(),
      docs,
      { fetch },
    );
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual(docs.discovery);
    const j = await handleAdminKmsRequest(
      new Request(`${ISSUER}/.well-known/jwks.json`),
      env(),
      docs,
      {
        fetch,
      },
    );
    expect(await j.json()).toEqual(docs.jwks);
    expect(seen.kms).toEqual([]);
  });
  it("ほかのパスは 404", async () => {
    const r = await handleAdminKmsRequest(new Request(`${ISSUER}/x`), env(), docs, fakeFetch());
    expect(r.status).toBe(404);
  });
});

describe("呼び出し側の確認（bearer）", () => {
  it.each([
    ["無し", null],
    ["違う", "wrong"],
  ])("Authorization が%sなら 401 で KMS を呼ばない", async (_, token) => {
    const { fetch, seen } = fakeFetch();
    for (const path of ["/poc/login", "/poc/sign"]) {
      const r = await handleAdminKmsRequest(post(path, { key: "rsa" }, token), env(), docs, {
        fetch,
      });
      expect(r.status).toBe(401);
    }
    expect(seen.kms).toEqual([]);
  });
  it("CALLER_TOKEN が空なら常に 401", async () => {
    const { fetch, seen } = fakeFetch();
    const r = await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa" }, ""),
      env({ CALLER_TOKEN: "" }),
      docs,
      {
        fetch,
      },
    );
    expect(r.status).toBe(401);
    expect(seen.kms).toEqual([]);
  });
  it("GET は 405", async () => {
    const r = await handleAdminKmsRequest(
      new Request(`${ISSUER}/poc/login`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      env(),
      docs,
      fakeFetch(),
    );
    expect(r.status).toBe(405);
  });
});

describe("POST /poc/login（KMS で署名 → STS → getSigninToken）", () => {
  it.each([
    ["rsa", "RS256", RSA_ARN, "RSASSA_PKCS1_V1_5_SHA_256"],
    ["ec", "ES256", EC_ARN, "ECDSA_SHA_256"],
  ])(
    "%s: KMS の Sign（RAW）で作った JWT が JWKS で検証でき、STS と Federation が通る",
    async (label, alg, arn, kmsAlg) => {
      const { fetch, seen } = fakeFetch();
      const r = await handleAdminKmsRequest(post("/poc/login", { key: label }), env(), docs, {
        fetch,
      });
      expect(r.status).toBe(200);
      const out = (await r.json()) as Record<string, unknown>;
      expect(out).toMatchObject({
        ok: true,
        key: label,
        alg,
        kmsRequestId: KMS_REQ_ID,
        stsRequestId: "sts-req-1",
        roleSessionName: `kms-${KMS_REQ_ID}`,
        sourceIdentity: "awsbridge-kms-check",
        signinTokenLength: SIGNIN_TOKEN.length,
      });
      for (const k of ["signMs", "stsMs", "federationMs", "totalMs"])
        expect(typeof out[k]).toBe("number");
      // KMS への要求
      expect(seen.kms).toHaveLength(1);
      expect(seen.kms[0]?.url).toBe("https://kms.ap-northeast-1.amazonaws.com/");
      expect(seen.kms[0]?.target).toBe("TrentService.Sign");
      expect(seen.kms[0]?.auth).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKE\/\d{8}\/ap-northeast-1\/kms\/aws4_request/,
      );
      expect(seen.kms[0]?.body).toMatchObject({
        KeyId: arn,
        MessageType: "RAW",
        SigningAlgorithm: kmsAlg,
      });
      // STS に渡った JWT
      const p = seen.sts[0]?.params as URLSearchParams;
      expect(seen.sts[0]?.url).toBe("https://sts.ap-northeast-1.amazonaws.com/");
      expect(p.get("RoleArn")).toBe(ROLE_ARN);
      expect(p.get("RoleSessionName")).toBe(`kms-${KMS_REQ_ID}`);
      const jwt = p.get("WebIdentityToken") as string;
      const { payload, protectedHeader } = await jwtVerify(
        jwt,
        createLocalJWKSet(docs.jwks as never),
        {
          issuer: ISSUER,
          audience: "awsbridge-admin-kms-poc",
        },
      );
      expect(protectedHeader).toMatchObject({
        alg,
        kid: label === "rsa" ? rsa.kid : ec.kid,
        typ: "JWT",
      });
      expect(payload).toMatchObject({
        sub: "awsbridge-kms-check",
        "https://aws.amazon.com/tags": { principal_tags: { access_profile: ["poc-admin"] } },
        "https://aws.amazon.com/source_identity": "awsbridge-kms-check",
      });
      expect((payload.exp as number) - (payload.iat as number)).toBe(300);
      expect(typeof payload.jti).toBe("string");
      // 応答に JWT・認証情報・SigninToken を入れない
      const text = JSON.stringify(out);
      for (const secret of [jwt, SECRET_SESSION_TOKEN, SIGNIN_TOKEN, "ASIAX"])
        expect(text).not.toContain(secret);
      expect(seen.fed[0]?.url).toMatch(
        /^https:\/\/signin\.aws\.amazon\.com\/federation\?Action=getSigninToken/,
      );
    },
  );
  it("federation: false なら getSigninToken を呼ばない", async () => {
    const { fetch, seen } = fakeFetch();
    const r = await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa", federation: false }),
      env(),
      docs,
      {
        fetch,
      },
    );
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect(seen.fed).toEqual([]);
  });
  it("KMS がエラー（DisabledException）なら stage kms のエラーを返し、STS を呼ばない", async () => {
    const { fetch, seen } = fakeFetch({ kms: "disabled" });
    const r = await handleAdminKmsRequest(post("/poc/login", { key: "rsa" }), env(), docs, {
      fetch,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: false,
      stage: "kms",
      code: "DisabledException",
      kmsRequestId: KMS_REQ_ID,
    });
    expect(seen.sts).toEqual([]);
  });
  it("STS が拒否したら stage sts のエラーコードを返す", async () => {
    const { fetch } = fakeFetch({ sts: "denied" });
    const r = await handleAdminKmsRequest(post("/poc/login", { key: "ec" }), env(), docs, {
      fetch,
    });
    expect(await r.json()).toMatchObject({
      ok: false,
      stage: "sts",
      code: "InvalidIdentityToken",
      stsRequestId: "sts-req-err",
    });
  });
  it("Federation が失敗したら stage federation", async () => {
    const { fetch } = fakeFetch({ fed: "error" });
    const r = await handleAdminKmsRequest(post("/poc/login", { key: "rsa" }), env(), docs, {
      fetch,
    });
    expect(await r.json()).toMatchObject({ ok: false, stage: "federation", code: "HTTP400" });
  });
  it("知らない key は 400 で KMS を呼ばない", async () => {
    const { fetch, seen } = fakeFetch();
    const r = await handleAdminKmsRequest(post("/poc/login", { key: "nope" }), env(), docs, {
      fetch,
    });
    expect(r.status).toBe(400);
    expect(seen.kms).toEqual([]);
  });
  it("呼び出し側は claim を変えられない（本文の sub・aud などは無視する）", async () => {
    const { fetch, seen } = fakeFetch();
    await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa", sub: "evil", aud: "x", claims: { sub: "evil" } }),
      env(),
      docs,
      { fetch },
    );
    const jwt = seen.sts[0]?.params.get("WebIdentityToken") as string;
    expect(decodeJwt(jwt)).toMatchObject({
      sub: "awsbridge-kms-check",
      aud: "awsbridge-admin-kms-poc",
    });
  });
  it("SUBJECT・AUDIENCE・ACCESS_PROFILE を env で変えられる", async () => {
    const { fetch, seen } = fakeFetch();
    await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa" }),
      env({ SUBJECT: "other-check", AUDIENCE: "aud-x", ACCESS_PROFILE: "poc-viewer" }),
      docs,
      { fetch },
    );
    const jwt = seen.sts[0]?.params.get("WebIdentityToken") as string;
    expect(decodeJwt(jwt)).toMatchObject({
      sub: "other-check",
      aud: "aud-x",
      "https://aws.amazon.com/tags": { principal_tags: { access_profile: ["poc-viewer"] } },
    });
  });
});

describe("ROLE_ARN が無いとき（鍵だけのスタックで Worker を先に出した段階）", () => {
  it("/poc/login は 500 no_role で KMS を呼ばず、/poc/sign は動く", async () => {
    const { fetch, seen } = fakeFetch();
    const r = await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa" }),
      env({ ROLE_ARN: "" }),
      docs,
      {
        fetch,
      },
    );
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "no_role" });
    expect(seen.kms).toEqual([]);
    const s = await handleAdminKmsRequest(
      post("/poc/sign", { key: "rsa" }),
      env({ ROLE_ARN: "" }),
      docs,
      {
        fetch,
      },
    );
    expect(s.status).toBe(200);
  });
});

describe("POST /poc/sign（KMS の Sign の往復だけ）", () => {
  it("count 回 Sign を呼び、各回の所要時間と RequestId を返す", async () => {
    const { fetch, seen } = fakeFetch();
    const r = await handleAdminKmsRequest(post("/poc/sign", { key: "ec", count: 3 }), env(), docs, {
      fetch,
    });
    const out = (await r.json()) as { results: Record<string, unknown>[]; alg: string };
    expect(out.alg).toBe("ES256");
    expect(out.results).toHaveLength(3);
    for (const x of out.results) expect(x).toMatchObject({ ok: true, kmsRequestId: KMS_REQ_ID });
    expect(seen.kms).toHaveLength(3);
    expect(seen.sts).toEqual([]);
  });
  it(`count は 1〜${MAX_SIGN_COUNT}（範囲外は 400）`, async () => {
    for (const count of [0, MAX_SIGN_COUNT + 1, 1.5]) {
      const r = await handleAdminKmsRequest(
        post("/poc/sign", { key: "rsa", count }),
        env(),
        docs,
        fakeFetch(),
      );
      expect(r.status, String(count)).toBe(400);
    }
  });
  it("variant digest / pss は鍵ポリシーの確認用に MessageType DIGEST・RSASSA_PSS_SHA_256 で呼ぶ（既定は RAW と JWS の方式）", async () => {
    const { fetch, seen } = fakeFetch();
    await handleAdminKmsRequest(post("/poc/sign", { key: "rsa", variant: "digest" }), env(), docs, {
      fetch,
    });
    expect(seen.kms[0]?.body).toMatchObject({
      MessageType: "DIGEST",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    expect(Buffer.from(seen.kms[0]?.body.Message as string, "base64").length).toBe(32);
    await handleAdminKmsRequest(post("/poc/sign", { key: "rsa", variant: "pss" }), env(), docs, {
      fetch,
    });
    expect(seen.kms[1]?.body).toMatchObject({
      MessageType: "RAW",
      SigningAlgorithm: "RSASSA_PSS_SHA_256",
    });
    const bad = await handleAdminKmsRequest(
      post("/poc/sign", { key: "ec", variant: "pss" }),
      env(),
      docs,
      { fetch },
    );
    expect(bad.status).toBe(400);
    const bad2 = await handleAdminKmsRequest(
      post("/poc/sign", { key: "rsa", variant: "x" }),
      env(),
      docs,
      { fetch },
    );
    expect(bad2.status).toBe(400);
  });
  it("エラーはコードを返す", async () => {
    const r = await handleAdminKmsRequest(
      post("/poc/sign", { key: "rsa" }),
      env(),
      docs,
      fakeFetch({ kms: "disabled" }),
    );
    const out = (await r.json()) as { results: Record<string, unknown>[] };
    expect(out.results[0]).toMatchObject({ ok: false, code: "DisabledException" });
  });
});

describe("エンドポイントの差し替え（E2E 用）", () => {
  it("localhost の KMS_ENDPOINT・STS_ENDPOINT・FEDERATION_ENDPOINT だけ使う", async () => {
    const { fetch, seen } = fakeFetch();
    await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa" }),
      env({
        KMS_ENDPOINT: "http://127.0.0.1:9999/kms",
        STS_ENDPOINT: "http://127.0.0.1:9999/sts",
        FEDERATION_ENDPOINT: "http://127.0.0.1:9999/federation",
      }),
      docs,
      { fetch },
    );
    expect(seen.kms[0]?.url).toBe("http://127.0.0.1:9999/kms");
    expect(seen.sts[0]?.url).toBe("http://127.0.0.1:9999/sts");
    expect(seen.fed[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:9999\/federation\?/);
  });
  it("localhost でない差し替えは無視して AWS の既定のエンドポイントを使う", async () => {
    const { fetch, seen } = fakeFetch();
    await handleAdminKmsRequest(
      post("/poc/login", { key: "rsa" }),
      env({ KMS_ENDPOINT: "https://evil.example/kms", STS_ENDPOINT: "https://evil.example/sts" }),
      docs,
      { fetch },
    );
    expect(seen.kms[0]?.url).toBe("https://kms.ap-northeast-1.amazonaws.com/");
    expect(seen.sts[0]?.url).toBe("https://sts.ap-northeast-1.amazonaws.com/");
  });
});
