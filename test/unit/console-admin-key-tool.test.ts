// コンソールログインの Admin の署名鍵の運用の道具（scripts/console/admin-key-lib.ts）。X1 の決裁 (c)・(e) と追加の条件:
//   put     鍵は道具の中でメモリ上に作り、Cloudflare API で secret_key として入れる（ファイルに書かない）。確認のオプション（--yes）が無ければ
//           何をするかの表示だけで、API を呼ばない。同じ名前への PUT は断る（名前は kid から決まる。既にあれば止める）
//   retire  旧い鍵のバインディングを消す。今の署名鍵・公開鍵の vars に残っている鍵は断る
//   check   デプロイ後の確認: バインディングの型、Admin の issuer の discovery と JWKS、key-check（取り出せない・exportKey が失敗する・自己検証）
// トークン・鍵の値は出力しない。Cloudflare API は fetch を差し替えて試す（実 API は呼ばない）。
import { calculateJwkThumbprint } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminKeySettings,
  apiBaseFrom,
  type Deps,
  readJsonc,
  runCheck,
  runPut,
  runRetire,
  type Settings,
} from "../../scripts/console/admin-key-lib";
import { bindingNameForKid, type PublicJwk } from "../../src/console/admin/key";
import { adminConfig } from "./console-standard-harness";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "awsbridge-console-admin";
const TOKEN = ["cf", "token", "t".repeat(32)].join("-");
const ACCESS_TOKEN = ["access", "token", "a".repeat(32)].join("-");
const ISSUER = "https://admin-id.example.com/admin";
const PORTAL = "https://admin-portal.example.com";

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
    binding: bindingNameForKid(kid),
  };
}

let a: Key;
let b: Key;
let c: Key;
beforeAll(async () => {
  [a, b, c] = await Promise.all([makeKey(), makeKey(), makeKey()]);
});

function wranglerText(vars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return `{
  // コメント
  "name": "${SCRIPT}",
  "main": "src/console/admin/index.ts",
  ${Object.entries(extra)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)},`)
    .join("\n")}
  "vars": ${JSON.stringify({ ADMIN_CURRENT_KEY: "", ADMIN_PUBLIC_JWKS: "", ...vars })}
}`;
}

async function settings(
  vars: Record<string, string> = {},
  env: Record<string, string> = {},
): Promise<Settings> {
  return adminKeySettings({ AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID: ACCOUNT, ...env }, (p) => {
    if (p.endsWith(".jsonc")) return wranglerText(vars);
    if (p.endsWith("worker.admin.json")) return JSON.stringify(adminConfig());
    throw new Error(`unexpected read ${p}`);
  });
}

const keyed = (current: Key, jwks: Key[]) => ({
  ADMIN_CURRENT_KEY: JSON.stringify({ binding: current.binding, kid: current.kid }),
  ADMIN_PUBLIC_JWKS: JSON.stringify(jwks.map((k) => k.publicJwk)),
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
      // Cloudflare API 以外（issuer の文書・key-check）はリダイレクトを追わない（Access のログインへ飛ばされたら失敗にする）
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

describe("設定", () => {
  it("Cloudflare API の宛先は既定の api.cloudflare.com。上書きは手元（127.0.0.1）の http だけ（トークンを外へ送らない）", () => {
    expect(apiBaseFrom({})).toBe("https://api.cloudflare.com/client/v4");
    expect(apiBaseFrom({ AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE: "http://127.0.0.1:8787" })).toBe(
      "http://127.0.0.1:8787",
    );
    for (const v of [
      "https://evil.example.com",
      "http://localhost.evil.com:1",
      "http://10.0.0.1:80",
    ])
      expect(() => apiBaseFrom({ AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE: v })).toThrow();
  });

  it("wrangler の設定（JSONC）の name・vars と、環境変数のアカウント ID を読む", async () => {
    const s = await settings(keyed(a, [a]));
    expect(s.scriptName).toBe(SCRIPT);
    expect(s.accountId).toBe(ACCOUNT);
    expect(s.current).toEqual({ binding: a.binding, kid: a.kid });
    expect(s.publicJwks?.map((k) => k.kid)).toEqual([a.kid]);
    expect(readJsonc('{\n  // x\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it("アカウント ID が無い・形が違えば例外。wrangler の設定の account_id も使える", async () => {
    await expect(
      adminKeySettings({}, (p) => (p.endsWith(".jsonc") ? wranglerText() : "{}")),
    ).rejects.toThrow(/AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID/);
    await expect(settings({}, { AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID: "nope" })).rejects.toThrow();
    const s = await adminKeySettings({}, (p) =>
      p.endsWith(".jsonc") ? wranglerText({}, { account_id: ACCOUNT }) : "{}",
    );
    expect(s.accountId).toBe(ACCOUNT);
  });

  it("vars が壊れていれば例外（今の鍵の名前が kid の規則と違うなど）", async () => {
    await expect(
      settings({ ADMIN_CURRENT_KEY: JSON.stringify({ binding: b.binding, kid: a.kid }) }),
    ).rejects.toThrow();
  });
});

describe("put: 鍵をメモリの中で作り、Cloudflare API で secret_key として入れる", () => {
  it("--yes が無ければ、何をするかの表示だけ（API・トークン・鍵の生成を使わない）", async () => {
    const d = fakeDeps(() => cfJson({}));
    const code = await runPut(await settings(), d, { yes: false });
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(0);
    expect(d.tokenCalls).toBe(0);
    const text = d.out.join("\n");
    expect(text).toContain(SCRIPT);
    expect(text).toContain("secret_key");
    expect(text).toContain("ADMIN_KEY_");
    expect(text).toContain("--yes");
  });

  it("--yes: 同じ名前が無いことを確かめてから PUT（secret_key・jwk・RS256・usages sign）。応答は name と type だけ", async () => {
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
    const code = await runPut(await settings(keyed(a, [a])), d, { yes: true });
    expect(code).toBe(0);
    expect(d.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`,
      `PUT https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`,
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
    expect(jwk.n).toBe(c.publicJwk.n);
    // 出力: 名前・kid・公開鍵と、次に入れる vars（新旧を並べた公開鍵）。秘密の成分とトークンは出さない
    const text = d.out.join("\n");
    expect(text).toContain(c.binding);
    expect(text).toContain(c.kid);
    expect(text).toContain(JSON.stringify([a.publicJwk, c.publicJwk]));
    for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(text).not.toContain(jwk[m] as string);
    expect(text).not.toContain(TOKEN);
  });

  it("同じ名前のバインディングが既にあれば PUT しない（同じ名前への PUT は即座に置き換わるため）", async () => {
    const d = fakeDeps(
      () => cfJson({ success: true, result: [{ name: c.binding, type: "secret_key" }] }),
      { generate: c },
    );
    expect(await runPut(await settings(), d, { yes: true })).toBe(1);
    expect(d.calls.map((x) => x.method)).toEqual(["GET"]);
    expect(d.out.join("\n")).toContain("既に");
  });

  it("公開鍵の vars に既に 2 つあれば入れない（先に旧い鍵を外す）", async () => {
    const d = fakeDeps(() => cfJson({}), { generate: c });
    expect(await runPut(await settings(keyed(b, [a, b])), d, { yes: true })).toBe(1);
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
    expect(await runPut(await settings(), d, { yes: true })).toBe(1);
    expect(d.out.join("\n")).not.toContain(jwk.d as string);
  });

  it("API のエラーは code と message だけを出して失敗", async () => {
    const d = fakeDeps(
      (call) =>
        call.method === "GET"
          ? cfJson({ success: true, result: [] })
          : cfJson(
              { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
              403,
            ),
      { generate: c },
    );
    expect(await runPut(await settings(), d, { yes: true })).toBe(1);
    expect(d.out.join("\n")).toContain("10000");
  });

  it("名前の有無を確かめられない（secret の一覧を読めない）なら PUT しない", async () => {
    const d = fakeDeps(() => cfJson({ success: false }, 500), { generate: c });
    expect(await runPut(await settings(), d, { yes: true })).toBe(1);
    expect(d.calls.map((x) => x.method)).toEqual(["GET"]);
  });
});

describe("retire: 旧い鍵のバインディングを消す（JWKS から外してデプロイしたあと）", () => {
  it("--yes が無ければ表示だけ。--yes なら DELETE を 1 回", async () => {
    const s = await settings(keyed(b, [b]));
    const plan = fakeDeps(() => cfJson({ success: true }));
    expect(await runRetire(s, plan, { yes: false, binding: a.binding })).toBe(0);
    expect(plan.calls).toHaveLength(0);
    const d = fakeDeps((call) =>
      call.url === `${ISSUER}/.well-known/jwks.json`
        ? cfJson({ keys: [b.publicJwk] })
        : cfJson({ success: true, result: null }),
    );
    expect(await runRetire(s, d, { yes: true, binding: a.binding })).toBe(0);
    expect(d.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${ISSUER}/.well-known/jwks.json`,
      `DELETE https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets/${a.binding}`,
    ]);
    // デプロイ済みの JWKS（公開）にはトークンを送らない
    expect(d.calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("デプロイ済みの Admin の issuer の JWKS にまだ消す鍵の kid があれば断る（vars を外してもデプロイ前）", async () => {
    const d = fakeDeps((call) =>
      call.url.endsWith("jwks.json")
        ? cfJson({ keys: [a.publicJwk, b.publicJwk] })
        : cfJson({ success: true }),
    );
    expect(
      await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: a.binding }),
    ).toBe(1);
    expect(d.calls.map((x) => x.method)).toEqual(["GET"]);
    expect(d.out.join("\n")).toContain("JWKS");
  });

  it.each<[string, () => Response]>([
    ["HTTP 500", () => cfJson({}, 500)],
    [
      "Access のログインへのリダイレクト",
      () => new Response(null, { status: 302, headers: { location: "https://x.example.com/" } }),
    ],
    ["JSON でない", () => new Response("<html>", { status: 200 })],
    ["keys が無い", () => cfJson({ nope: [] })],
  ])("デプロイ済みの JWKS が取れない（%s）なら断る", async (_n, res) => {
    const d = fakeDeps((call) =>
      call.url.endsWith("jwks.json") ? res() : cfJson({ success: true }),
    );
    expect(
      await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: a.binding }),
    ).toBe(1);
    expect(d.calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("生成物（worker.admin.json）が無く Admin の issuer が分からなければ断る", async () => {
    const s = await adminKeySettings({ AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID: ACCOUNT }, (p) => {
      if (p.endsWith(".jsonc")) return wranglerText(keyed(b, [b]));
      throw new Error("no file");
    });
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(await runRetire(s, d, { yes: true, binding: a.binding })).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("今の署名鍵は消さない", async () => {
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(
      await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: b.binding }),
    ).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("公開鍵の vars に残っている鍵は消さない（先に JWKS から外してデプロイする）", async () => {
    const d = fakeDeps(() => cfJson({ success: true }));
    expect(
      await runRetire(await settings(keyed(b, [a, b])), d, { yes: true, binding: a.binding }),
    ).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it.each(["", "CONSOLE_CSRF_KEY", "ADMIN_KEY_xyz", "ADMIN_CURRENT_KEY"])(
    "ADMIN_KEY_<16 進> の形でない名前（%s）は断る",
    async (name) => {
      const d = fakeDeps(() => cfJson({ success: true }));
      expect(await runRetire(await settings(keyed(b, [b])), d, { yes: true, binding: name })).toBe(
        1,
      );
      expect(d.calls).toHaveLength(0);
    },
  );
});

describe("check: デプロイ後の確認", () => {
  type Opts = {
    secrets?: { name: string; type: string }[];
    jwksKids?: string[];
    keyCheck?: Record<string, unknown>;
  };
  function checkDeps(o: Opts = {}) {
    return fakeDeps((call) => {
      if (call.url.endsWith(`/workers/scripts/${SCRIPT}/secrets`))
        return cfJson({
          success: true,
          result: o.secrets ?? [
            { name: b.binding, type: "secret_key" },
            { name: "CONSOLE_CSRF_KEY", type: "secret_text" },
          ],
        });
      if (call.url === `${ISSUER}/.well-known/openid-configuration`)
        return cfJson({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
      if (call.url === `${ISSUER}/.well-known/jwks.json`)
        return cfJson({
          keys: (o.jwksKids ?? [a.kid, b.kid]).map(
            (kid) => [a, b, c].find((k) => k.kid === kid)?.publicJwk,
          ),
        });
      if (call.url === `${PORTAL}/t/infra-elevated/key-check`) {
        expect(call.headers.get("cf-access-token")).toBe(ACCESS_TOKEN);
        expect(call.headers.get("authorization")).toBeNull();
        return cfJson(o.keyCheck ?? goodCheck());
      }
      return new Response("unexpected", { status: 599 });
    });
  }
  const s = () => settings(keyed(b, [a, b]));
  const goodCheck = () => ({
    configured: true,
    binding: b.binding,
    kid: b.kid,
    present: true,
    usable: true,
    extractable: false,
    usages: ["sign"],
    exportKey: "rejected",
    selfVerify: "ok",
    publicKids: [a.kid, b.kid],
  });

  it("バインディング（secret_key）・discovery・JWKS・key-check がそろえば 0。Access のトークンは cf-access-token で送り、出力しない", async () => {
    const d = checkDeps();
    expect(await runCheck(await s(), d, { accessToken: ACCESS_TOKEN })).toBe(0);
    const text = d.out.join("\n");
    expect(text).toContain("exportKey");
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(TOKEN);
    // Cloudflare API のトークンは Access の確認には送らない
    for (const call of d.calls.filter((x) => !x.url.includes("/client/v4/")))
      expect(call.headers.get("authorization")).toBeNull();
  });

  it("Access のトークンが無ければ key-check はブラウザで開く URL を出して飛ばす（ほかが通れば 0）", async () => {
    const d = checkDeps();
    expect(await runCheck(await s(), d, {})).toBe(0);
    expect(d.out.join("\n")).toContain(`${PORTAL}/t/infra-elevated/key-check`);
    expect(d.calls.some((x) => x.url.endsWith("/key-check"))).toBe(false);
  });

  it.each<[string, () => Opts]>([
    [
      "今の鍵のバインディングが無い",
      () => ({ secrets: [{ name: a.binding, type: "secret_key" }] }),
    ],
    [
      "今の鍵のバインディングが secret_text",
      () => ({ secrets: [{ name: b.binding, type: "secret_text" }] }),
    ],
    ["JWKS が vars と違う（新しい鍵が無い）", () => ({ jwksKids: [a.kid] })],
    [
      "key-check で exportKey が成功した",
      () => ({ keyCheck: { ...goodCheck(), usable: false, exportKey: "allowed" } }),
    ],
    [
      "key-check で取り出せる鍵",
      () => ({ keyCheck: { ...goodCheck(), usable: false, extractable: true } }),
    ],
    [
      "key-check で自己検証が合わない",
      () => ({ keyCheck: { ...goodCheck(), selfVerify: "failed" } }),
    ],
    ["key-check の kid が今の鍵と違う", () => ({ keyCheck: { ...goodCheck(), kid: a.kid } })],
    [
      "key-check で鍵が設定されていない",
      () => ({ keyCheck: { configured: false, publicKids: [] } }),
    ],
  ])("%s なら 1", async (_n, o) => {
    expect(await runCheck(await s(), checkDeps(o()), { accessToken: ACCESS_TOKEN })).toBe(1);
  });

  it("Access のログインへのリダイレクト（トークン切れ・Bypass の漏れ）は追わずに 1", async () => {
    const ok = checkDeps();
    const d = fakeDeps((call) => {
      if (call.url.endsWith("/key-check") || call.url.endsWith("jwks.json"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
        });
      return ok.fetch(call.url, { method: call.method, headers: call.headers, redirect: "manual" });
    });
    expect(await runCheck(await s(), d, { accessToken: ACCESS_TOKEN })).toBe(1);
    const text = d.out.join("\n");
    expect(text).toContain("302");
    expect(text).not.toContain(ACCESS_TOKEN);
  });

  it("今の鍵の vars が無ければ 1（何を確かめるか決まらない）", async () => {
    expect(await runCheck(await settings(), checkDeps(), {})).toBe(1);
  });

  it("使われていない ADMIN_KEY_ のバインディング（JWKS に無い旧い鍵）があれば知らせる（失敗にはしない）", async () => {
    const d = checkDeps({
      secrets: [
        { name: b.binding, type: "secret_key" },
        { name: c.binding, type: "secret_key" },
      ],
    });
    expect(await runCheck(await s(), d, {})).toBe(0);
    expect(d.out.join("\n")).toContain(c.binding);
  });
});
