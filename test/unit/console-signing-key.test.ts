// コンソールログインの署名鍵の、階層に共通の部品（src/console/signing/）。Admin の部品（admin/key.ts）と Standard の部品が同じ規則を使う。
import { describe, expect, it } from "vitest";
import { bindingNameForKid } from "../../src/console/admin/key";
import {
  bindingNameFor,
  bindingPattern,
  jwkThumbprint,
  RS256_ALGORITHM,
  readCurrentKey,
  readPublicJwks,
} from "../../src/console/signing/key";

async function publicJwk() {
  const p = (await crypto.subtle.generateKey(
    { ...RS256_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const j = (await crypto.subtle.exportKey("jwk", p.publicKey)) as JsonWebKey;
  const n = j.n as string;
  return { kty: "RSA", n, e: "AQAB", kid: await jwkThumbprint({ n, e: "AQAB" }) };
}

describe("bindingNameFor（接頭辞は階層ごと）", () => {
  it("kid の先頭 8 バイトの大文字の 16 進を接頭辞に付ける。Admin の名前と同じ規則", async () => {
    const k = await publicJwk();
    const std = bindingNameFor("STANDARD_KEY_", k.kid);
    expect(std).toMatch(/^STANDARD_KEY_[0-9A-F]{16}$/);
    expect(std.slice("STANDARD_KEY_".length)).toBe(
      bindingNameForKid(k.kid).slice("ADMIN_KEY_".length),
    );
    expect(bindingPattern("STANDARD_KEY_").test(std)).toBe(true);
    expect(bindingPattern("ADMIN_KEY_").test(std)).toBe(false);
  });
  it("接頭辞の形・kid の形が違えば例外", async () => {
    const k = await publicJwk();
    expect(() => bindingNameFor("standard_", k.kid)).toThrow();
    expect(() => bindingNameFor("STANDARD_KEY_", "short")).toThrow();
  });
});

describe("readCurrentKey", () => {
  it("名前が kid から作った名前と一致するときだけ通る。違う接頭辞は断る", async () => {
    const k = await publicJwk();
    const binding = bindingNameFor("STANDARD_KEY_", k.kid);
    expect(readCurrentKey({ binding, kid: k.kid }, "STANDARD_KEY_", "X")).toEqual({
      binding,
      kid: k.kid,
    });
    expect(() =>
      readCurrentKey({ binding: bindingNameForKid(k.kid), kid: k.kid }, "STANDARD_KEY_", "X"),
    ).toThrow(/X: binding/);
    expect(() => readCurrentKey({ binding, kid: k.kid, x: 1 }, "STANDARD_KEY_", "X")).toThrow();
  });
});

describe("readPublicJwks", () => {
  it("1〜2 個・秘密の成分なし・kid は thumbprint。例外の文は label を持ち、値を持たない", async () => {
    const a = await publicJwk();
    const b = await publicJwk();
    expect((await readPublicJwks([a, b], "L")).map((x) => x.kid)).toEqual([a.kid, b.kid]);
    await expect(readPublicJwks([], "L")).rejects.toThrow(/^L /);
    await expect(readPublicJwks([a, b, a], "L")).rejects.toThrow();
    await expect(readPublicJwks([{ ...a, d: "x" }], "L")).rejects.toThrow(/private/);
    await expect(readPublicJwks([{ ...a, kid: b.kid }], "L")).rejects.toThrow(/thumbprint/);
    try {
      await readPublicJwks([{ ...a, e: "AQAD" }], "L");
    } catch (e) {
      expect(String(e)).not.toContain(a.n);
    }
  });
});
