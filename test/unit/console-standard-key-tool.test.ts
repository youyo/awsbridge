// コンソールログインの Standard の署名鍵の運用の道具（scripts/console/standard-key-lib.ts）。cto の決裁「Standard も secret_key に揃える」の
// (d)・(e)・(g)。Admin の道具（admin-key-lib.ts）と同じ形で、境界ごとに鍵を持つ:
//   put     --boundary の鍵を道具の中でメモリ上に作り、Cloudflare API で secret_key（STANDARD_KEY_<16 進>）として入れる（ファイルに書かない）。
//           --yes が無ければ表示だけで、API を呼ばない。同じ名前への PUT は断る
//   retire  旧い鍵のバインディングを消す。今の鍵・公開鍵の vars・デプロイ済みのどの境界の JWKS に残っている鍵も断る。STANDARD_KEY_ の形以外は断る
//   check   デプロイ後の確認: 境界ごとのバインディングの型、境界ごとの issuer の discovery と JWKS、key-check
// トークンは Standard 用の変数（AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN）だけを読み、Admin 用を読まない。トークン・鍵の値は出力しない。
import { calculateJwkThumbprint } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Deps,
  runCheck,
  runPut,
  runRetire,
  type Settings,
  standardApiBaseFrom,
  standardKeySettings,
  standardToken,
} from "../../scripts/console/standard-key-lib";
import type { PublicJwk } from "../../src/console/signing/key";
import { standardBindingName } from "../../src/console/standard/key";
import { standardConfig } from "./console-standard-harness";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "awsbridge-console-standard";
const TOKEN = ["cf", "token", "s".repeat(32)].join("-");
const ACCESS_TOKEN = ["access", "token", "a".repeat(32)].join("-");
const ISSUER = "https://id.example.com/standard";
const P_ISSUER = "https://id.example.com/partner-x";
const PORTAL = "https://portal.example.com";
const PARTNER = "partner:partner-x";

type Key = { pair: CryptoKeyPair; publicJwk: PublicJwk; kid: string; binding: string };
async function makeKey(): Promise<Key> {
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
  return {
    pair,
    publicJwk: { kty: "RSA", n: pub.n as string, e: "AQAB", kid, alg: "RS256", use: "sig" },
    kid,
    binding: standardBindingName(kid),
  };
}

let a: Key;
let b: Key;
let c: Key;
let p: Key;
beforeAll(async () => {
  [a, b, c, p] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
});

function wranglerText(vars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return `{
  // コメント
  "name": "${SCRIPT}",
  "main": "src/console/standard/index.ts",
  ${Object.entries(extra)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)},`)
    .join("\n")}
  "vars": ${JSON.stringify({ STANDARD_CURRENT_KEYS: "", STANDARD_PUBLIC_JWKS: "", ...vars })}
}`;
}

async function settings(
  vars: Record<string, string> = {},
  env: Record<string, string> = {},
): Promise<Settings> {
  return standardKeySettings({ AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID: ACCOUNT, ...env }, (f) => {
    if (f.endsWith(".jsonc")) return wranglerText(vars);
    if (f.endsWith("worker.standard.json")) return JSON.stringify(standardConfig());
    throw new Error(`unexpected read ${f}`);
  });
}

/** managed の今の鍵と公開鍵、partner の今の鍵 p。 */
const keyed = (current: Key, jwks: Key[], partner: Key | undefined = p) => ({
  STANDARD_CURRENT_KEYS: JSON.stringify({
    managed: { binding: current.binding, kid: current.kid },
    ...(partner ? { [PARTNER]: { binding: partner.binding, kid: partner.kid } } : {}),
  }),
  STANDARD_PUBLIC_JWKS: JSON.stringify({
    managed: jwks.map((k) => k.publicJwk),
    ...(partner ? { [PARTNER]: [partner.publicJwk] } : {}),
  }),
});

type Call = { method: string; url: string; headers: Headers; body: string };

function fakeDeps(
  handler: (c: Call) => Response | Promise<Response>,
  o: { generate?: Key } = {},
): Deps & { calls: Call[]; out: string[]; tokenCalls: number } {
  const calls: Call[] = [];
  const out: string[] = [];
  const d = {
    calls,
    out,
    tokenCalls: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/client/v4/")) expect(init?.redirect).toBe("manual");
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      return handler(call);
    }) as typeof fetch,
    token: async () => {
      d.tokenCalls++;
      return TOKEN;
    },
    print: (line: string) => out.push(line),
    ...(o.generate ? { generateKeyPair: async () => (o.generate as Key).pair } : {}),
  };
  return d;
}

const cfJson = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`;

describe("設定", () => {
  it("Cloudflare API の宛先の上書きは手元（127.0.0.1）の http だけ。Standard 用の変数だけを読む", () => {
    expect(standardApiBaseFrom({})).toBe("https://api.cloudflare.com/client/v4");
    expect(
      standardApiBaseFrom({ AWSBRIDGE_CONSOLE_STANDARD_CF_API_BASE: "http://127.0.0.1:8787" }),
    ).toBe("http://127.0.0.1:8787");
    expect(() =>
      standardApiBaseFrom({ AWSBRIDGE_CONSOLE_STANDARD_CF_API_BASE: "https://evil.example.com" }),
    ).toThrow();
    // Admin 用の宛先は見ない
    expect(standardApiBaseFrom({ AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE: "http://127.0.0.1:1" })).toBe(
      "https://api.cloudflare.com/client/v4",
    );
  });

  it("トークンは AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN だけを読み、Admin 用のトークンは使わない（無ければ wrangler の OAuth）", () => {
    expect(standardToken({ AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN: "std" })).toBe("std");
    expect(standardToken({ AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN: "admin" })).toBeUndefined();
    expect(standardToken({ CLOUDFLARE_API_TOKEN: "other" })).toBeUndefined();
  });

  it("wrangler の設定の name・vars と、環境変数のアカウント ID・生成物の境界を読む", async () => {
    const s = await settings(keyed(a, [a]));
    expect(s.scriptName).toBe(SCRIPT);
    expect(s.accountId).toBe(ACCOUNT);
    expect(s.keys?.current.managed).toEqual({ binding: a.binding, kid: a.kid });
    expect(s.stdConfig?.boundaries.map((x) => x.name)).toEqual(["managed", PARTNER]);
  });

  it("アカウント ID が無い・Admin 用のアカウント ID しか無いなら例外。wrangler の設定の account_id も使える", async () => {
    await expect(
      standardKeySettings({ AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID: ACCOUNT }, (f) =>
        f.endsWith(".jsonc") ? wranglerText() : "{}",
      ),
    ).rejects.toThrow(/AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID/);
    const s = await standardKeySettings({}, (f) =>
      f.endsWith(".jsonc") ? wranglerText({}, { account_id: ACCOUNT }) : "{}",
    );
    expect(s.accountId).toBe(ACCOUNT);
  });

  it("vars が空なら鍵なし。片方だけ・壊れていれば例外", async () => {
    expect((await settings()).keys).toBeUndefined();
    await expect(
      settings({ STANDARD_CURRENT_KEYS: keyed(a, [a]).STANDARD_CURRENT_KEYS }),
    ).rejects.toThrow();
    await expect(
      settings({
        ...keyed(a, [a]),
        STANDARD_CURRENT_KEYS: JSON.stringify({ managed: { binding: b.binding, kid: a.kid } }),
      }),
    ).rejects.toThrow();
  });
});

describe("put: 境界の鍵をメモリの中で作り、Cloudflare API で secret_key として入れる", () => {
  it("--yes が無ければ、何をするかの表示だけ（API・トークン・鍵の生成を使わない）", async () => {
    const d = fakeDeps(() => cfJson({}));
    expect(await runPut(await settings(), d, { yes: false, boundary: "managed" })).toBe(0);
    expect(d.calls).toHaveLength(0);
    expect(d.tokenCalls).toBe(0);
    const text = d.out.join("\n");
    expect(text).toContain(SCRIPT);
    expect(text).toContain("secret_key");
    expect(text).toContain("STANDARD_KEY_");
    expect(text).toContain("managed");
    expect(text).toContain("--yes");
    expect(text).toContain("AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN");
  });

  it("--yes: 同じ名前が無いことを確かめてから PUT。出力は名前・kid・公開鍵と、その境界を入れ替えた vars（秘密の成分・トークンは出さない）", async () => {
    let putBody: Record<string, unknown> = {};
    const d = fakeDeps(
      (call) => {
        expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        if (call.method === "GET")
          return cfJson({ success: true, result: [{ name: a.binding, type: "secret_key" }] });
        putBody = JSON.parse(call.body);
        return cfJson({ success: true, result: { name: c.binding, type: "secret_key" } });
      },
      { generate: c },
    );
    expect(await runPut(await settings(keyed(a, [a])), d, { yes: true, boundary: "managed" })).toBe(
      0,
    );
    expect(d.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${API}/secrets`,
      `PUT ${API}/secrets`,
    ]);
    expect(putBody).toMatchObject({
      name: c.binding,
      type: "secret_key",
      format: "jwk",
      algorithm: { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      usages: ["sign"],
    });
    const jwk = putBody.key_jwk as Record<string, string>;
    expect(Object.keys(jwk).sort()).toEqual(["d", "dp", "dq", "e", "kty", "n", "p", "q", "qi"]);
    const text = d.out.join("\n");
    expect(text).toContain(c.binding);
    expect(text).toContain(c.kid);
    // 公開鍵の vars はその境界だけに新旧を並べ、ほかの境界はそのまま
    expect(text).toContain(
      JSON.stringify({ managed: [a.publicJwk, c.publicJwk], [PARTNER]: [p.publicJwk] }),
    );
    expect(text).toContain(
      JSON.stringify({
        managed: { binding: c.binding, kid: c.kid },
        [PARTNER]: { binding: p.binding, kid: p.kid },
      }),
    );
    for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(text).not.toContain(jwk[m] as string);
    expect(text).not.toContain(TOKEN);
  });

  it("鍵が 1 つも無いとき（最初の投入）も、その境界の vars を作って出す", async () => {
    const d = fakeDeps(
      (call) =>
        call.method === "GET"
          ? cfJson({ success: true, result: [] })
          : cfJson({ success: true, result: { name: c.binding, type: "secret_key" } }),
      { generate: c },
    );
    expect(await runPut(await settings(), d, { yes: true, boundary: PARTNER })).toBe(0);
    expect(d.out.join("\n")).toContain(JSON.stringify({ [PARTNER]: [c.publicJwk] }));
  });

  it("生成物に無い境界は断る（API を呼ばない）", async () => {
    const d = fakeDeps(() => cfJson({}), { generate: c });
    expect(await runPut(await settings(), d, { yes: true, boundary: "partner:nosuch" })).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("生成物（worker.standard.json）が無ければ、境界の名前を確かめられないので断る（API・トークンを使わない）", async () => {
    const noConfig = await standardKeySettings(
      { AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID: ACCOUNT },
      (f) => {
        if (f.endsWith(".jsonc")) return wranglerText();
        throw new Error("no file");
      },
    );
    const d = fakeDeps(() => cfJson({}), { generate: c });
    expect(await runPut(noConfig, d, { yes: true, boundary: "managed" })).toBe(1);
    expect(d.calls).toHaveLength(0);
    expect(d.tokenCalls).toBe(0);
    expect(d.out.join("\n")).toContain("worker.standard.json");
  });

  it("同じ名前のバインディングが既にあれば PUT しない", async () => {
    const d = fakeDeps(
      () => cfJson({ success: true, result: [{ name: c.binding, type: "secret_key" }] }),
      { generate: c },
    );
    expect(await runPut(await settings(), d, { yes: true, boundary: "managed" })).toBe(1);
    expect(d.calls.map((x) => x.method)).toEqual(["GET"]);
    expect(d.out.join("\n")).toContain("既に");
  });

  it("その境界の公開鍵の vars に既に 2 つあれば入れない", async () => {
    const d = fakeDeps(() => cfJson({}), { generate: c });
    expect(
      await runPut(await settings(keyed(b, [a, b])), d, { yes: true, boundary: "managed" }),
    ).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("応答に想定外の項目（鍵の中身など）があれば失敗にし、本文を出さない", async () => {
    let jwk: Record<string, string> = {};
    const d = fakeDeps(
      (call) => {
        if (call.method === "GET") return cfJson({ success: true, result: [] });
        jwk = JSON.parse(call.body).key_jwk;
        return cfJson({
          success: true,
          result: { name: c.binding, type: "secret_key", key_jwk: jwk },
        });
      },
      { generate: c },
    );
    expect(await runPut(await settings(), d, { yes: true, boundary: "managed" })).toBe(1);
    expect(d.out.join("\n")).not.toContain(jwk.d as string);
  });

  it("名前の有無を確かめられない（secret の一覧を読めない）なら PUT しない", async () => {
    const d = fakeDeps(() => cfJson({ success: false }, 500), { generate: c });
    expect(await runPut(await settings(), d, { yes: true, boundary: "managed" })).toBe(1);
    expect(d.calls.map((x) => x.method)).toEqual(["GET"]);
  });
});

describe("retire: 旧い鍵のバインディングを消す（どの境界の JWKS からも外してデプロイしたあと）", () => {
  const jwksOk = (call: Call) =>
    call.url === `${ISSUER}/.well-known/jwks.json`
      ? cfJson({ keys: [b.publicJwk] })
      : call.url === `${P_ISSUER}/.well-known/jwks.json`
        ? cfJson({ keys: [p.publicJwk] })
        : cfJson({ success: true, result: null });

  it("--yes が無ければ表示だけ。--yes なら境界ごとの JWKS を確かめてから DELETE を 1 回", async () => {
    const s = await settings(keyed(b, [b]));
    const plan = fakeDeps(() => cfJson({ success: true }));
    expect(await runRetire(s, plan, { yes: false, binding: a.binding })).toBe(0);
    expect(plan.calls).toHaveLength(0);
    const d = fakeDeps(jwksOk);
    expect(await runRetire(s, d, { yes: true, binding: a.binding })).toBe(0);
    expect(d.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${ISSUER}/.well-known/jwks.json`,
      `GET ${P_ISSUER}/.well-known/jwks.json`,
      `DELETE ${API}/secrets/${a.binding}`,
    ]);
    expect(d.calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("デプロイ済みのどれかの境界の JWKS にまだ消す鍵の kid があれば断る", async () => {
    const d = fakeDeps((call) =>
      call.url === `${P_ISSUER}/.well-known/jwks.json`
        ? cfJson({ keys: [p.publicJwk, a.publicJwk] })
        : jwksOk(call),
    );
    expect(
      await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: a.binding }),
    ).toBe(1);
    expect(d.calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("デプロイ済みの JWKS が取れない（リダイレクト）なら断る", async () => {
    const d = fakeDeps((call) =>
      call.url.endsWith("jwks.json")
        ? new Response(null, { status: 302, headers: { location: "https://x.example.com/" } })
        : cfJson({ success: true }),
    );
    expect(
      await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: a.binding }),
    ).toBe(1);
    expect(d.calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("生成物（worker.standard.json）が無ければ断る", async () => {
    const s = await standardKeySettings(
      { AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID: ACCOUNT },
      (f) => {
        if (f.endsWith(".jsonc")) return wranglerText(keyed(b, [b]));
        throw new Error("no file");
      },
    );
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(await runRetire(s, d, { yes: true, binding: a.binding })).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("どれかの境界の今の署名鍵は消さない", async () => {
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(
      await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: p.binding }),
    ).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("公開鍵の vars に残っている鍵は消さない", async () => {
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(
      await runRetire(await settings(keyed(b, [a, b])), d, { yes: true, binding: a.binding }),
    ).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it.each([
    "",
    "CONSOLE_CSRF_KEY",
    "STANDARD_KEY_xyz",
    "STANDARD_CURRENT_KEYS",
    "ADMIN_KEY_0123456789ABCDEF",
  ])("STANDARD_KEY_<16 進> の形でない名前（%s）は断る", async (name) => {
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: name })).toBe(1);
    expect(d.calls).toHaveLength(0);
  });
});

describe("check: デプロイ後の確認（境界ごと）", () => {
  type Opts = {
    secrets?: { name: string; type: string }[];
    jwksKids?: string[];
    keyCheck?: Record<string, unknown>;
  };
  const status = (k: Key, publicKids: string[]) => ({
    configured: true,
    binding: k.binding,
    kid: k.kid,
    present: true,
    usable: true,
    extractable: false,
    usages: ["sign"],
    exportKey: "rejected",
    selfVerify: "ok",
    publicKids,
  });
  const goodCheck = () => ({
    boundaries: { managed: status(b, [a.kid, b.kid]), [PARTNER]: status(p, [p.kid]) },
  });
  function checkDeps(o: Opts = {}) {
    return fakeDeps((call) => {
      if (call.url === `${API}/secrets`)
        return cfJson({
          success: true,
          result: o.secrets ?? [
            { name: b.binding, type: "secret_key" },
            { name: p.binding, type: "secret_key" },
            { name: "CONSOLE_CSRF_KEY", type: "secret_text" },
          ],
        });
      for (const iss of [ISSUER, P_ISSUER]) {
        if (call.url === `${iss}/.well-known/openid-configuration`)
          return cfJson({ issuer: iss, jwks_uri: `${iss}/.well-known/jwks.json` });
      }
      if (call.url === `${ISSUER}/.well-known/jwks.json`)
        return cfJson({
          keys: (o.jwksKids ?? [a.kid, b.kid]).map(
            (kid) => [a, b, c].find((k) => k.kid === kid)?.publicJwk,
          ),
        });
      if (call.url === `${P_ISSUER}/.well-known/jwks.json`) return cfJson({ keys: [p.publicJwk] });
      if (call.url === `${PORTAL}/t/infra/key-check`) {
        expect(call.headers.get("cf-access-token")).toBe(ACCESS_TOKEN);
        expect(call.headers.get("authorization")).toBeNull();
        return cfJson(o.keyCheck ?? goodCheck());
      }
      return new Response("unexpected", { status: 599 });
    });
  }
  const s = () => settings(keyed(b, [a, b]));

  it("境界ごとのバインディング（secret_key）・discovery・JWKS・key-check がそろえば 0。トークンは出力しない", async () => {
    const d = checkDeps();
    expect(await runCheck(await s(), d, { accessToken: ACCESS_TOKEN })).toBe(0);
    const text = d.out.join("\n");
    expect(text).toContain("exportKey");
    expect(text).toContain(PARTNER);
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(TOKEN);
    for (const call of d.calls.filter((x) => !x.url.includes("/client/v4/")))
      expect(call.headers.get("authorization")).toBeNull();
  });

  it("Access のトークンが無ければ key-check はブラウザで開く URL を出して飛ばす", async () => {
    const d = checkDeps();
    expect(await runCheck(await s(), d, {})).toBe(0);
    expect(d.out.join("\n")).toContain(`${PORTAL}/t/infra/key-check`);
    expect(d.calls.some((x) => x.url.endsWith("/key-check"))).toBe(false);
  });

  it.each<[string, () => Opts]>([
    [
      "partner の今の鍵のバインディングが無い",
      () => ({ secrets: [{ name: b.binding, type: "secret_key" }] }),
    ],
    [
      "managed の今の鍵のバインディングが secret_text",
      () => ({
        secrets: [
          { name: b.binding, type: "secret_text" },
          { name: p.binding, type: "secret_key" },
        ],
      }),
    ],
    ["managed の JWKS が vars と違う", () => ({ jwksKids: [a.kid] })],
    [
      "key-check で partner の exportKey が成功した",
      () => ({
        keyCheck: {
          boundaries: {
            ...goodCheck().boundaries,
            [PARTNER]: { ...status(p, [p.kid]), usable: false, exportKey: "allowed" },
          },
        },
      }),
    ],
    [
      "key-check で managed の自己検証が合わない",
      () => ({
        keyCheck: {
          boundaries: {
            ...goodCheck().boundaries,
            managed: { ...status(b, [a.kid, b.kid]), selfVerify: "failed" },
          },
        },
      }),
    ],
    [
      "key-check の kid が今の鍵と違う",
      () => ({
        keyCheck: {
          boundaries: { ...goodCheck().boundaries, managed: status(a, [a.kid, b.kid]) },
        },
      }),
    ],
    [
      "key-check で境界が設定されていない",
      () => ({
        keyCheck: {
          boundaries: {
            ...goodCheck().boundaries,
            [PARTNER]: { configured: false, publicKids: [] },
          },
        },
      }),
    ],
  ])("%s なら 1", async (_n, o) => {
    expect(await runCheck(await s(), checkDeps(o()), { accessToken: ACCESS_TOKEN })).toBe(1);
  });

  it("今の鍵の vars が無ければ 1", async () => {
    expect(await runCheck(await settings(), checkDeps(), {})).toBe(1);
  });

  it("使われていない STANDARD_KEY_ のバインディングがあれば知らせる（失敗にはしない）", async () => {
    const d = checkDeps({
      secrets: [
        { name: b.binding, type: "secret_key" },
        { name: p.binding, type: "secret_key" },
        { name: c.binding, type: "secret_key" },
      ],
    });
    expect(await runCheck(await s(), d, {})).toBe(0);
    expect(d.out.join("\n")).toContain(c.binding);
  });
});
