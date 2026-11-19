// 外からの比較の道具（scripts/console/exposure-check-lib.ts）。設定の読み方と、取得の差し替えでの全体の流れ。
// 設定: 生成物（worker.json）の境界の issuer と、wrangler の設定の vars の公開鍵（CONSOLE_PUBLIC_JWKS）。
// P2（B）の設計メモ §9.3: 外から取る対象は境界ごとの issuer だけ（Admin の issuer と ADMIN_PUBLIC_JWKS の読み取りは無い）。
// 期待する鍵を得られないときは SettingsError（終了コード 2）。取得は fetchDoc を差し替える（ネットワークを使わない）。
import { calculateJwkThumbprint } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  exposureSettings,
  runExposureCheck,
  SettingsError,
} from "../../scripts/console/exposure-check-lib";
import type { DocResponse } from "../../src/console/exposure";
import type { PublicJwk } from "../../src/console/signing/key";
import { workerConfig } from "./console-worker-harness";

async function makeJwk(): Promise<PublicJwk> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = await calculateJwkThumbprint({ kty: "RSA", n: pub.n as string, e: "AQAB" });
  return { kty: "RSA", n: pub.n as string, e: "AQAB", kid, alg: "RS256", use: "sig" };
}

let s1: PublicJwk;
let s2: PublicJwk;
let s3: PublicJwk;
let a1: PublicJwk;
beforeAll(async () => {
  [s1, s2, s3, a1] = await Promise.all([makeJwk(), makeJwk(), makeJwk(), makeJwk()]);
});

const std = workerConfig();
// 生成物の境界は 2 つ（managed と partner:partner-x。どちらも同じ issuer のホスト）。鍵は境界ごとに別
const boundary = std.boundaries[0] as { name: string; issuer: string };
const partner = std.boundaries[1] as { name: string; issuer: string };

/** 境界の名前 → 公開鍵。undefined なら vars を空にする。 */
const stdWrangler = (byBoundary: Record<string, PublicJwk[]> | undefined) => {
  const vars: Record<string, string> = { CONSOLE_CURRENT_KEYS: "", CONSOLE_PUBLIC_JWKS: "" };
  if (byBoundary) {
    vars.CONSOLE_CURRENT_KEYS = JSON.stringify(
      Object.fromEntries(
        Object.entries(byBoundary).map(([b, ks]) => {
          const cur = ks[0] as PublicJwk;
          return [b, { binding: bindingOf(cur.kid), kid: cur.kid }];
        }),
      ),
    );
    vars.CONSOLE_PUBLIC_JWKS = JSON.stringify(byBoundary);
  }
  return `{\n  // 試験用\n  "name": "std",\n  "vars": ${JSON.stringify(vars)}\n}`;
};
function bindingOf(kid: string): string {
  const t = kid.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
  return `CONSOLE_KEY_${[...bytes.slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

type Files = Record<string, string>;
function reader(files: Files) {
  return {
    readFile: (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    exists: (p: string) => files[p] !== undefined,
  };
}
const baseFiles = (): Files => ({
  ".generated/console/worker.json": JSON.stringify(std),
  "wrangler.console.jsonc": stdWrangler({
    [boundary.name]: [s1, s2],
    [partner.name]: [s3],
  }),
});
const load = (files: Files, env: Record<string, string> = {}) => {
  const r = reader(files);
  return exposureSettings(env, r.readFile, r.exists);
};

describe("exposureSettings", () => {
  it("境界ごとの issuer と公開鍵を読む（Admin の issuer は無い）", async () => {
    const s = await load(baseFiles());
    expect(s.boundaries.map((b) => [b.name, b.issuer])).toEqual([
      [boundary.name, boundary.issuer],
      [partner.name, partner.issuer],
    ]);
    expect(s.boundaries[0]?.jwks.map((k) => k.kid)).toEqual([s1.kid, s2.kid]);
    expect(s.boundaries[1]?.jwks.map((k) => k.kid)).toEqual([s3.kid]);
    expect(s).not.toHaveProperty("admin");
  });

  it("P2 より前の生成物（worker.standard.json・worker.admin.json）・Admin の wrangler の設定は読まない", async () => {
    const files = baseFiles();
    files[".generated/console/worker.admin.json"] = "{ broken";
    files["wrangler.console-admin.jsonc"] = "{ broken";
    await expect(load(files)).resolves.toBeDefined();
    const old: Files = {
      ".generated/console/worker.standard.json": files[".generated/console/worker.json"] as string,
      "wrangler.console.jsonc": files["wrangler.console.jsonc"] as string,
    };
    await expect(load(old)).rejects.toBeInstanceOf(SettingsError);
  });

  it("環境変数で出力先と wrangler の設定を変えられる", async () => {
    const files = baseFiles();
    const moved: Files = {
      "out/worker.json": files[".generated/console/worker.json"] as string,
      "s.jsonc": files["wrangler.console.jsonc"] as string,
    };
    const s = await load(moved, {
      AWSBRIDGE_CONSOLE_OUT_DIR: "out",
      AWSBRIDGE_CONSOLE_WRANGLER_CONFIG: "s.jsonc",
    });
    expect(s.boundaries).toHaveLength(2);
  });

  it("期待する鍵を得られなければ SettingsError（生成物なし・vars が空・境界の鍵なし・壊れた JSON・P2 より前の生成物）", async () => {
    const cases: Files[] = [];
    let f = baseFiles();
    delete f[".generated/console/worker.json"];
    cases.push(f);
    f = baseFiles();
    f["wrangler.console.jsonc"] = stdWrangler(undefined);
    cases.push(f);
    f = baseFiles();
    f["wrangler.console.jsonc"] = "{ not json";
    cases.push(f);
    f = baseFiles();
    f[".generated/console/worker.json"] = JSON.stringify({ ...std, schemaVersion: 1 });
    cases.push(f);
    // 境界（partner）の鍵が vars に無い
    f = baseFiles();
    f["wrangler.console.jsonc"] = stdWrangler({ [boundary.name]: [s1, s2] });
    cases.push(f);
    for (const c of cases) await expect(load(c)).rejects.toBeInstanceOf(SettingsError);
  });

  it("issuer の URL にポートがあれば SettingsError（接続は常に 443 なので、設定が読めない扱い）", async () => {
    const f = baseFiles();
    const withPort = JSON.parse(f[".generated/console/worker.json"] as string);
    withPort.boundaries[0].issuer = withPort.boundaries[0].issuer.replace(
      "https://id.example.com",
      "https://id.example.com:8443",
    );
    f[".generated/console/worker.json"] = JSON.stringify(withPort);
    await expect(load(f)).rejects.toBeInstanceOf(SettingsError);
  });

  it("誤りの文に vars の値や JSON の断片を入れない", async () => {
    const f = baseFiles();
    f["wrangler.console.jsonc"] = '{ "name": "SECRET-FRAGMENT" oops';
    const e = await load(f).catch((x: unknown) => x as Error);
    expect((e as Error).message).not.toContain("SECRET-FRAGMENT");
  });
});

describe("runExposureCheck", () => {
  const docs = (files: Record<string, unknown>) => async (url: string) =>
    ({
      kind: "response",
      status: files[url] === undefined ? 404 : 200,
      json: files[url],
    }) as DocResponse;
  const served = (issuer: string, keys: PublicJwk[]) => ({
    [`${issuer}/.well-known/openid-configuration`]: {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
    },
    [`${issuer}/.well-known/jwks.json`]: { keys },
  });

  // 同じホストの 2 つの境界（パスが違う）。文書は URL で引くので取り違えない
  const stdServed = () => ({
    ...served(boundary.issuer, [s1, s2]),
    ...served(partner.issuer, [s3]),
  });

  it("別の境界の JWKS が差し替えられていれば 1", async () => {
    const s = await load(baseFiles());
    const code = await runExposureCheck(
      s,
      docs({
        ...served(boundary.issuer, [s1, s2]),
        ...served(partner.issuer, [s3, a1]),
      }),
      () => {},
    );
    expect(code).toBe(1);
  });

  it("どの境界も一致すれば 0。取得は文書ごとに 1 回で、境界の issuer の文書だけ（Admin の issuer を取りにいかない）", async () => {
    const s = await load(baseFiles());
    const out: string[] = [];
    const urls: string[] = [];
    const base = docs(stdServed());
    const code = await runExposureCheck(
      s,
      async (u) => {
        urls.push(u);
        return base(u);
      },
      (l) => out.push(l),
    );
    expect(code).toBe(0);
    expect(urls).toHaveLength(4);
    expect(new Set(urls).size).toBe(4);
    for (const u of urls)
      expect([boundary.issuer, partner.issuer].some((i) => u.startsWith(i))).toBe(true);
    const text = out.join("\n");
    expect(text).toContain(boundary.name);
    expect(text).not.toContain("Admin");
    expect(text).not.toContain("[NG]");
  });

  it("取得の失敗は一致にしない", async () => {
    const s = await load(baseFiles());
    const code = await runExposureCheck(
      s,
      async () => ({ kind: "error", reason: "timeout" }),
      () => {},
    );
    expect(code).toBe(1);
  });
});
