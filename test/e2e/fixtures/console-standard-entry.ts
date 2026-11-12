// E2E 専用のエントリ: 本物のエントリ（src/console/standard/index.ts）をそのまま使い、外向きの通信だけを手元の擬似サーバーへ向ける。
// Access の certs（https://<チームドメイン>/cdn-cgi/access/certs）・STS の地域の endpoint・getSigninToken の 3 つだけを書き換え、
// それ以外の外向きの通信は 502 で止める（実 AWS・Cloudflare を呼ばない）。宛先は変数 E2E_FAKE_BASE（http://127.0.0.1:<port>）。
// 署名鍵: 手元の wrangler dev（miniflare）には Workers の secret_key 型のバインディングを作る手段が無いため、生成物の境界ごとに
// Worker の中で取り出せない RSA の鍵（extractable false・usages sign）を作り、本番の secret_key と同じ形（CryptoKey）で
// バインディングの名前（STANDARD_KEY_<kid の 16 進>）に渡す。vars の STANDARD_CURRENT_KEYS・STANDARD_PUBLIC_JWKS もここで作る。
// 鍵はモジュールで境界ごとに 1 つだけ作る（JWKS と署名の鍵が要求ごとに変わらないように）。env は受け取った env ごとに 1 回だけ組む。
// 変数 E2E_KEY_MODE: "ok"（既定）/ "mismatch"（managed のバインディングに別の鍵を入れる = 鍵だけ替えて公開鍵を替え忘れた）/
//   "none"（鍵の vars もバインディングも渡さない = 鍵の投入前）。
// 入口の一覧（S0。U2）の身元のグループの取り方は未確定で、本物のエントリは渡さない（全チームのリンクに落ちる）。
// 変数 E2E_IDENTITY_GROUPS（Object ID のカンマ区切り）があるときだけ、同じ生成物で工場を呼び、その値を返す差し込み口を渡す
// （試験用。要求から値を読まない）。本番のバンドルには入らない（wrangler.console-standard.jsonc の main は src/console/standard/index.ts。
// console-isolation.test.ts で確かめる）。
import display from "awsbridge:console-display";
import config from "awsbridge:console-worker";
import { jwkThumbprint } from "../../../src/console/signing/key";
import worker, { type StandardEnv } from "../../../src/console/standard/index";
import { standardBindingName } from "../../../src/console/standard/key";
import { createStandardWorker } from "../../../src/console/standard/worker";

type E2EEnv = StandardEnv & {
  E2E_FAKE_BASE: string;
  E2E_IDENTITY_GROUPS?: string;
  E2E_KEY_MODE?: string;
};

const REWRITES: Record<string, string> = {
  "https://e2e-team.cloudflareaccess.com/cdn-cgi/access/certs": "/certs",
  "https://sts.us-east-1.amazonaws.com/": "/sts",
  "https://signin.aws.amazon.com/federation": "/federation",
};

let fakeBase = "";
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const path = REWRITES[url];
  if (path !== undefined && fakeBase !== "") return realFetch(`${fakeBase}${path}`, init);
  return new Response("blocked by e2e entry", { status: 502 });
}) as typeof fetch;

type Key = { privateKey: CryptoKey; publicJwk: Record<string, string>; kid: string };

async function makeKey(): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const n = pub.n as string;
  const kid = await jwkThumbprint({ n, e: "AQAB" });
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: "RSA", n, e: "AQAB", kid, alg: "RS256", use: "sig" },
    kid,
  };
}

const boundaries = (config as { boundaries: { name: string }[] }).boundaries.map((b) => b.name);
let keys: Promise<Record<string, Key>> | undefined;
const envs = new WeakMap<object, StandardEnv>();

async function keyedEnv(env: E2EEnv): Promise<StandardEnv> {
  if (env.E2E_KEY_MODE === "none") return env;
  const cached = envs.get(env);
  if (cached) return cached;
  keys ??= Promise.all(boundaries.map(async (b) => [b, await makeKey()] as const)).then((e) =>
    Object.fromEntries(e),
  );
  const ks = await keys;
  const out: Record<string, unknown> = {
    ...env,
    STANDARD_CURRENT_KEYS: JSON.stringify(
      Object.fromEntries(
        Object.entries(ks).map(([b, k]) => [
          b,
          { binding: standardBindingName(k.kid), kid: k.kid },
        ]),
      ),
    ),
    STANDARD_PUBLIC_JWKS: JSON.stringify(
      Object.fromEntries(Object.entries(ks).map(([b, k]) => [b, [k.publicJwk]])),
    ),
  };
  const all = Object.values(ks);
  for (const [b, k] of Object.entries(ks)) {
    const other = all.find((x) => x !== k) ?? k;
    out[standardBindingName(k.kid)] =
      env.E2E_KEY_MODE === "mismatch" && b === "managed" ? other.privateKey : k.privateKey;
  }
  envs.set(env, out as StandardEnv);
  return out as StandardEnv;
}

let grouped: ReturnType<typeof createStandardWorker> | undefined;

export default {
  async fetch(request: Request, env: E2EEnv): Promise<Response> {
    fakeBase = env.E2E_FAKE_BASE;
    const e = await keyedEnv(env);
    if (env.E2E_IDENTITY_GROUPS) {
      const groups = env.E2E_IDENTITY_GROUPS.split(",");
      grouped ??= createStandardWorker(
        config,
        { identityGroups: async () => ({ ok: true, groups }) },
        display,
      );
      return grouped.fetch(request, e);
    }
    return worker.fetch(request, e);
  },
} satisfies ExportedHandler<E2EEnv>;
