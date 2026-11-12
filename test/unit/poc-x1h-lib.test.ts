// PoC X1-(h)（secret_key が、別の secret の更新のあとも残るか）の純粋関数の試験。
import { describe, expect, it } from "vitest";
import {
  bearerMatches,
  hashPrefix,
  parseSecretNames,
  probeWorker,
  secretKeyBody,
  X1H_KEY_BINDING,
  x1hSettings,
} from "../../scripts/poc/x1h/lib";
import { jwkThumbprint, RS256_ALGORITHM } from "../../src/console/admin/key";

async function pair(): Promise<{ priv: CryptoKey; pubJwk: JsonWebKey; privJwk: JsonWebKey }> {
  const p = (await crypto.subtle.generateKey(
    { ...RS256_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privJwk = (await crypto.subtle.exportKey("jwk", p.privateKey)) as JsonWebKey;
  const priv = await crypto.subtle.importKey("jwk", privJwk, RS256_ALGORITHM, false, ["sign"]);
  const pubJwk = (await crypto.subtle.exportKey("jwk", p.publicKey)) as JsonWebKey;
  return { priv, pubJwk, privJwk };
}

async function publicVar(pubJwk: JsonWebKey): Promise<string> {
  const n = pubJwk.n as string;
  const e = pubJwk.e as string;
  return JSON.stringify({
    kty: "RSA",
    n,
    e,
    kid: await jwkThumbprint({ n, e }),
    alg: "RS256",
    use: "sig",
  });
}

describe("probeWorker（Worker の中の観察。値は返さない）", () => {
  it("取り出せない鍵があり、vars の公開鍵で自己検証が通る", async () => {
    const k = await pair();
    const r = await probeWorker({
      [X1H_KEY_BINDING]: k.priv,
      PUBLIC_JWK: await publicVar(k.pubJwk),
      SECRET_NAMES: "OTHER_A,OTHER_B",
      OTHER_A: "value-a",
    });
    expect(r.key.present).toBe(true);
    expect(r.key.usable).toBe(true);
    expect(r.key.exportKey).toBe("rejected");
    expect(r.selfVerify).toBe(true);
    expect(r.secrets).toEqual({ OTHER_A: await hashPrefix("value-a"), OTHER_B: null });
    expect(JSON.stringify(r)).not.toContain("value-a");
  });
  it("鍵が無ければ present false・selfVerify false", async () => {
    const k = await pair();
    const r = await probeWorker({ PUBLIC_JWK: await publicVar(k.pubJwk), SECRET_NAMES: "" });
    expect(r.key.present).toBe(false);
    expect(r.selfVerify).toBe(false);
    expect(r.secrets).toEqual({});
  });
  it("別の鍵の公開鍵では selfVerify false", async () => {
    const a = await pair();
    const b = await pair();
    const r = await probeWorker({
      [X1H_KEY_BINDING]: a.priv,
      PUBLIC_JWK: await publicVar(b.pubJwk),
      SECRET_NAMES: "",
    });
    expect(r.key.usable).toBe(true);
    expect(r.selfVerify).toBe(false);
  });
});

describe("parseSecretNames", () => {
  it("カンマ区切りの secret の名前。空は空配列。不正な名前は例外", () => {
    expect(parseSecretNames("OTHER_A, OTHER_B")).toEqual(["OTHER_A", "OTHER_B"]);
    expect(parseSecretNames("")).toEqual([]);
    expect(parseSecretNames(undefined)).toEqual([]);
    expect(() => parseSecretNames("a-b")).toThrow();
  });
});

describe("bearerMatches", () => {
  it("一致だけ true", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abd", "abc")).toBe(false);
    expect(bearerMatches(null, "abc")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});

describe("secretKeyBody（Cloudflare API の PUT .../secrets の本文）", () => {
  it("secret_key・format jwk・RS256・usages sign。JWK は kty と RSA の成分だけ", async () => {
    const k = await pair();
    const b = secretKeyBody(X1H_KEY_BINDING, k.privJwk);
    expect(b.type).toBe("secret_key");
    expect(b.format).toBe("jwk");
    expect(b.usages).toEqual(["sign"]);
    expect(b.algorithm).toEqual(RS256_ALGORITHM);
    expect(Object.keys(b.key_jwk).sort()).toEqual(
      ["d", "dp", "dq", "e", "kty", "n", "p", "q", "qi"].sort(),
    );
  });
  it("公開鍵だけでは例外", async () => {
    const k = await pair();
    expect(() => secretKeyBody(X1H_KEY_BINDING, k.pubJwk)).toThrow();
  });
});

describe("x1hSettings", () => {
  it("アカウント ID は 32 桁の 16 進。Worker の名前は PoC のものだけ", () => {
    expect(() => x1hSettings({})).toThrow(/AWSBRIDGE_X1H_POC_CF_ACCOUNT_ID/);
    expect(() => x1hSettings({ AWSBRIDGE_X1H_POC_CF_ACCOUNT_ID: "xyz" })).toThrow();
    const s = x1hSettings({ AWSBRIDGE_X1H_POC_CF_ACCOUNT_ID: "0".repeat(32) });
    expect(s.workerName).toBe("awsbridge-x1h-poc");
    expect(s.outDir).toMatch(/\.secrets\/poc-x1h$/);
  });
});
