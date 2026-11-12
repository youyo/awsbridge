// コンソールログインの Admin の署名（X1 の決裁: Workers の secret_key 型の取り出せない CryptoKey で RS256 の JWS を組む）。
//   鍵の部品（admin/key.ts）: バインディングの名前の規則（kid から作る）、今の署名鍵（名前と kid の組）、公開鍵の vars、
//                             バインディングの検査（CryptoKey・private・extractable false・usages sign だけ・RS256・exportKey が失敗する）
//   JWS（admin/jws.ts）:     WebCrypto だけで組む。jose で検証できる形
//   署名の部品（admin/sign-admin.ts）: STS 用の claim、kid、vars の公開鍵での自己検証、返す JWT の照合
// 試験の鍵は手元の WebCrypto で取り出せない形に作る（本番の secret_key と同じ CryptoKey の形）。
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { signJws } from "../../src/console/admin/jws";
import {
  ADMIN_KEY_BINDING_PREFIX,
  bindingNameForKid,
  isUsableSigningKey,
  jwkThumbprint,
  type PublicJwk,
  parseCurrentKey,
  parsePublicJwks,
  RS256_ALGORITHM,
} from "../../src/console/admin/key";
import { createAdminSigner } from "../../src/console/admin/sign-admin";
import { AUDIENCE, TEAM_TAG_KEY, UUID_RE } from "../../src/console/constants";
import { AWS_SOURCE_IDENTITY_CLAIM, AWS_TAGS_CLAIM } from "../../src/console/issue/claims";
import type { IssueRow, SigningRequest } from "../../src/console/issue/signer";

const NOW = 1_700_000_000;
const ISSUER = "https://admin-id.example.com/admin";

type TestKey = { privateKey: CryptoKey; publicJwk: PublicJwk; kid: string };

async function makeKey(
  o: { extractable?: boolean; modulusLength?: number; hash?: string } = {},
): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: o.hash ?? "SHA-256" },
      modulusLength: o.modulusLength ?? 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    o.extractable ?? false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = await calculateJwkThumbprint({ kty: "RSA", n: pub.n as string, e: pub.e as string });
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      kty: "RSA",
      n: pub.n as string,
      e: pub.e as string,
      kid,
      alg: "RS256",
      use: "sig",
    },
    kid,
  };
}

let a: TestKey;
let b: TestKey;
beforeAll(async () => {
  a = await makeKey();
  b = await makeKey();
});

const row = (over: Partial<IssueRow> = {}): IssueRow => ({
  team: "infra-elevated",
  boundary: "managed",
  issuer: ISSUER,
  accountId: "333333333333",
  role: "admin",
  roleArn: "arn:aws:iam::333333333333:role/awsbridge-console/admin/FederatedAdministrator",
  sessionSeconds: 3600,
  ...over,
});

const request = (over: Partial<SigningRequest> = {}): SigningRequest => ({
  identity: { sub: "access-sub-1", email: "Alice@Example.com" },
  resolved: {
    email: "alice@example.com",
    sourceIdentity: "alice@example.com",
    sessionName: "console-alice@example.com",
  },
  row: row(),
  now: NOW,
  ...over,
});

function signer(o: { key?: unknown; publicJwk?: PublicJwk; log?: (l: string) => void } = {}) {
  return createAdminSigner({
    issuer: ISSUER,
    current: { binding: bindingNameForKid(a.kid), kid: a.kid },
    publicJwk: o.publicJwk ?? a.publicJwk,
    key: "key" in o ? o.key : a.privateKey,
    log: o.log ?? (() => {}),
  });
}

describe("admin/key: バインディングの名前の規則（kid から作る。差し替えは必ず別の名前）", () => {
  it("ADMIN_KEY_ と kid（SHA-256 の thumbprint）の先頭 8 バイトの大文字の 16 進。同じ kid なら同じ名前", () => {
    const name = bindingNameForKid(a.kid);
    expect(ADMIN_KEY_BINDING_PREFIX).toBe("ADMIN_KEY_");
    expect(name).toMatch(/^ADMIN_KEY_[0-9A-F]{16}$/);
    expect(bindingNameForKid(a.kid)).toBe(name);
    const bytes = Uint8Array.from(atob(`${a.kid.replace(/-/g, "+").replace(/_/g, "/")}=`), (c) =>
      c.charCodeAt(0),
    );
    const hex = [...bytes.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(name).toBe(`ADMIN_KEY_${hex.toUpperCase()}`);
  });

  it("別の鍵（別の kid）は別の名前", () => {
    expect(bindingNameForKid(b.kid)).not.toBe(bindingNameForKid(a.kid));
  });

  it.each([
    ["空", ""],
    ["短い", "abc"],
    ["長い", `${"A".repeat(44)}`],
    ["base64url 以外の文字", `${"A".repeat(42)}+`],
  ])("kid が SHA-256 の thumbprint の形でない（%s）なら例外", (_n, kid) => {
    expect(() => bindingNameForKid(kid)).toThrow();
  });

  it("jwkThumbprint は RFC 7638 の thumbprint（jose と同じ値）", async () => {
    expect(await jwkThumbprint(a.publicJwk)).toBe(a.kid);
  });
});

describe("admin/key: 今の署名鍵（vars ADMIN_CURRENT_KEY: 名前と kid の組）", () => {
  it("未設定・空は undefined（署名の部品は未接続 = 503 signing_unavailable）", () => {
    expect(parseCurrentKey(undefined)).toBeUndefined();
    expect(parseCurrentKey("")).toBeUndefined();
    expect(parseCurrentKey("  ")).toBeUndefined();
  });

  it("名前が kid から作った名前と一致すれば受け付ける", () => {
    const raw = JSON.stringify({ binding: bindingNameForKid(a.kid), kid: a.kid });
    expect(parseCurrentKey(raw)).toEqual({ binding: bindingNameForKid(a.kid), kid: a.kid });
  });

  it.each([
    ["JSON でない", "not json"],
    ["配列", "[]"],
    [
      "名前が規則と違う",
      () => JSON.stringify({ binding: "ADMIN_KEY_0000000000000000", kid: a.kid }),
    ],
    ["別の鍵の名前", () => JSON.stringify({ binding: bindingNameForKid(b.kid), kid: a.kid })],
    ["余計な項目", () => JSON.stringify({ binding: bindingNameForKid(a.kid), kid: a.kid, x: 1 })],
    ["kid の欠落", () => JSON.stringify({ binding: bindingNameForKid(a.kid) })],
    ["文字列でない", 42],
  ])("%s は例外（文に値を入れない）", (_n, v) => {
    const raw = typeof v === "function" ? v() : v;
    try {
      parseCurrentKey(raw);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(a.kid);
    }
  });
});

describe("admin/key: 公開鍵の vars（ADMIN_PUBLIC_JWKS。新旧 2 つまで）", () => {
  it("未設定・空は undefined", async () => {
    expect(await parsePublicJwks(undefined)).toBeUndefined();
    expect(await parsePublicJwks("")).toBeUndefined();
  });

  it("1 つ・2 つ（新旧）を受け付け、公開の成分と kid・alg・use だけに揃える", async () => {
    const one = await parsePublicJwks(JSON.stringify([{ ...a.publicJwk, key_ops: ["verify"] }]));
    expect(one).toEqual([
      { kty: "RSA", n: a.publicJwk.n, e: "AQAB", kid: a.kid, alg: "RS256", use: "sig" },
    ]);
    const two = await parsePublicJwks(JSON.stringify([a.publicJwk, b.publicJwk]));
    expect(two?.map((k) => k.kid)).toEqual([a.kid, b.kid]);
  });

  it.each([
    ["JSON でない", () => "{"],
    ["配列でない", () => JSON.stringify(a.publicJwk)],
    ["空の配列", () => "[]"],
    ["3 つ以上", () => JSON.stringify([a.publicJwk, b.publicJwk, { ...a.publicJwk }])],
    ["秘密の成分（d）", () => JSON.stringify([{ ...a.publicJwk, d: "AAAA" }])],
    ["秘密の成分（p）", () => JSON.stringify([{ ...a.publicJwk, p: "AAAA" }])],
    ["kid の欠落", () => JSON.stringify([{ ...a.publicJwk, kid: undefined }])],
    ["kid が thumbprint と違う", () => JSON.stringify([{ ...a.publicJwk, kid: b.kid }])],
    ["kid の重複", () => JSON.stringify([a.publicJwk, a.publicJwk])],
    ["RSA でない", () => JSON.stringify([{ ...a.publicJwk, kty: "EC" }])],
    ["alg が RS256 でない", () => JSON.stringify([{ ...a.publicJwk, alg: "RS512" }])],
    ["use が sig でない", () => JSON.stringify([{ ...a.publicJwk, use: "enc" }])],
    ["e が 65537 でない", () => JSON.stringify([{ ...a.publicJwk, e: "Aw" }])],
    ["n が短い（2048 bit 未満）", () => JSON.stringify([{ ...a.publicJwk, n: "AQAB".repeat(10) }])],
  ])("%s は例外", async (_n, raw) => {
    await expect(parsePublicJwks(raw())).rejects.toThrow();
  });
});

describe("admin/key: バインディングの検査（使う前に。合わなければ署名しない）", () => {
  it("取り出せない RS256 の秘密鍵（usages sign だけ）は使える", async () => {
    expect(a.privateKey.extractable).toBe(false);
    expect(a.privateKey.usages).toEqual(["sign"]);
    expect(await isUsableSigningKey(a.privateKey)).toBe(true);
  });

  it.each([
    ["未設定", async () => undefined],
    ["文字列（secret_text の JWK）", async () => JSON.stringify(a.publicJwk)],
    ["JWK のオブジェクト", async () => ({ ...a.publicJwk, d: "AAAA" })],
    [
      "取り出せる秘密鍵（extractable true）",
      async () => (await makeKey({ extractable: true })).privateKey,
    ],
    [
      "公開鍵",
      async () =>
        crypto.subtle.importKey("jwk", a.publicJwk as JsonWebKey, RS256_ALGORITHM, true, [
          "verify",
        ]),
    ],
    ["SHA-384 の RSA", async () => (await makeKey({ hash: "SHA-384" })).privateKey],
    ["1024 bit の RSA", async () => (await makeKey({ modulusLength: 1024 })).privateKey],
    [
      "RSA-PSS の鍵",
      async () =>
        (
          (await crypto.subtle.generateKey(
            {
              name: "RSA-PSS",
              hash: "SHA-256",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
            },
            false,
            ["sign", "verify"],
          )) as CryptoKeyPair
        ).privateKey,
    ],
    [
      "HMAC の鍵",
      async () =>
        crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
    ],
  ])("%s は使えない", async (_n, make) => {
    expect(await isUsableSigningKey(await make())).toBe(false);
  });
});

describe("admin/jws: WebCrypto だけで RS256 の JWS を組む", () => {
  it("header は alg・kid・typ だけで、jose で検証できる", async () => {
    const jwt = await signJws(a.privateKey, a.kid, {
      iss: ISSUER,
      sub: "x",
      iat: NOW,
      exp: NOW + 1,
    });
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", kid: a.kid, typ: "JWT" });
    const { payload } = await jwtVerify(jwt, createLocalJWKSet({ keys: [a.publicJwk] }), {
      algorithms: ["RS256"],
      currentDate: new Date(NOW * 1000),
    });
    expect(payload.iss).toBe(ISSUER);
  });
});

describe("admin/sign-admin: Admin の署名の部品（TokenSigner）", () => {
  it("STS 用の claim（iss・aud 固定、iat 現在、exp = iat + 300、jti、タグ、SourceIdentity）を kid 付きで署名し、vars の公開鍵で検証できる", async () => {
    const r = await signer().sign(request());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(decodeProtectedHeader(r.token.jwt)).toEqual({ alg: "RS256", kid: a.kid, typ: "JWT" });
    const { payload } = await jwtVerify(r.token.jwt, createLocalJWKSet({ keys: [a.publicJwk] }), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
      currentDate: new Date(NOW * 1000),
    });
    expect(Object.keys(payload).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "jti", "sub", AWS_SOURCE_IDENTITY_CLAIM, AWS_TAGS_CLAIM].sort(),
    );
    expect(payload.sub).toBe("alice@example.com");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 300);
    expect(payload.jti).toMatch(UUID_RE);
    expect(payload[AWS_TAGS_CLAIM]).toEqual({
      principal_tags: { [TEAM_TAG_KEY]: ["infra-elevated"] },
    });
    expect(payload[AWS_SOURCE_IDENTITY_CLAIM]).toBe("alice@example.com");
    expect(r.token).toMatchObject({ iat: NOW, exp: NOW + 300, issuer: ISSUER, jti: payload.jti });
  });

  it("jti は署名ごとに一意", async () => {
    const s = signer();
    const r1 = await s.sign(request());
    const r2 = await s.sign(request());
    if (!r1.ok || !r2.ok) throw new Error("not signed");
    expect(decodeJwt(r1.token.jwt).jti).not.toBe(decodeJwt(r2.token.jwt).jti);
  });

  it("行の issuer が Admin の issuer（固定）と違えば署名しない", async () => {
    const r = await signer().sign(
      request({ row: row({ issuer: "https://id.example.com/standard" }) }),
    );
    expect(r).toEqual({ ok: false, code: "signing_unavailable" });
  });

  it.each([
    ["バインディングが無い", undefined],
    ["バインディングが文字列（secret_text）", '{"kty":"RSA"}'],
    ["JWK のオブジェクト", { kty: "RSA", n: "x", e: "AQAB", d: "y" }],
  ])("%s は signing_unavailable（ログは種別だけ）", async (_n, key) => {
    const logs: string[] = [];
    const r = await signer({ key, log: (l) => logs.push(l) }).sign(request());
    expect(r).toEqual({ ok: false, code: "signing_unavailable" });
    expect(logs.join("\n")).toContain("admin_key_unusable");
  });

  it("取り出せる秘密鍵は signing_unavailable", async () => {
    const k = await makeKey({ extractable: true });
    const r = await signer({ key: k.privateKey, publicJwk: k.publicJwk }).sign(request());
    expect(r).toEqual({ ok: false, code: "signing_unavailable" });
  });

  it("鍵と vars の公開鍵が合わない（鍵だけ替えて JWKS を替え忘れた）なら自己検証で止め、署名した JWT を返さない", async () => {
    const logs: string[] = [];
    const s = signer({ key: b.privateKey, log: (l) => logs.push(l) });
    expect(await s.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
    expect(logs.join("\n")).toContain("admin_key_self_verify_failed");
    // 失敗は覚えない（毎回検証する）。2 回目も止まる
    expect(await s.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
    for (const l of logs) expect(l).not.toMatch(/[A-Za-z0-9_-]{100,}/);
  });

  it("status(): 鍵の性質（取り出せない・exportKey が失敗する・自己検証）と kid だけを返す", async () => {
    expect(await signer().status()).toEqual({
      binding: bindingNameForKid(a.kid),
      kid: a.kid,
      present: true,
      usable: true,
      extractable: false,
      usages: ["sign"],
      exportKey: "rejected",
      selfVerify: "ok",
    });
    expect(await signer({ key: undefined }).status()).toMatchObject({
      present: false,
      usable: false,
      selfVerify: "skipped",
    });
    expect(await signer({ key: b.privateKey }).status()).toMatchObject({
      usable: true,
      selfVerify: "failed",
    });
  });
});
