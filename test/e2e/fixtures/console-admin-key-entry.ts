// E2E 専用のエントリ（Admin・鍵あり）: 手元の wrangler dev（miniflare）には Workers の secret_key 型のバインディングを作る手段が無いため、
// Worker の中で取り出せない RSA の鍵（extractable false・usages sign）を作り、本番の secret_key と同じ形（CryptoKey）で
// バインディングの名前（ADMIN_KEY_<kid の 16 進>）に渡す。vars の ADMIN_CURRENT_KEY・ADMIN_PUBLIC_JWKS もここで作る。
// 処理そのものは本物のエントリ（src/console/admin/index.ts）で、外向きの通信だけを手元の擬似サーバーへ向ける（console-admin-entry.ts と同じ）。
// 鍵はモジュールで 1 つだけ作る（JWKS と署名の鍵が要求ごとに変わらないように）。env は受け取った env ごとに 1 回だけ組む
// （Worker は env ごとに部品を作って使い回すため）。
// 変数 E2E_KEY_MODE: "ok"（既定）/ "mismatch"（バインディングに別の鍵を入れる = 鍵だけ替えて公開鍵を替え忘れた）。
// 本番のバンドルには入らない（wrangler.console-admin.jsonc の main は src/console/admin/index.ts。console-isolation.test.ts で確かめる）。
import worker, { type AdminEnv } from "../../../src/console/admin/index";
import { bindingNameForKid, jwkThumbprint } from "../../../src/console/admin/key";

type E2EEnv = AdminEnv & { E2E_FAKE_BASE: string; E2E_KEY_MODE?: string };

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

let keys: Promise<{ current: Key; other: Key }> | undefined;
const envs = new WeakMap<object, AdminEnv>();

async function keyedEnv(env: E2EEnv): Promise<AdminEnv> {
  const cached = envs.get(env);
  if (cached) return cached;
  keys ??= Promise.all([makeKey(), makeKey()]).then(([current, other]) => ({ current, other }));
  const { current, other } = await keys;
  const binding = bindingNameForKid(current.kid);
  const out = {
    ...env,
    ADMIN_CURRENT_KEY: JSON.stringify({ binding, kid: current.kid }),
    ADMIN_PUBLIC_JWKS: JSON.stringify([current.publicJwk]),
    [binding]: env.E2E_KEY_MODE === "mismatch" ? other.privateKey : current.privateKey,
  } as AdminEnv;
  envs.set(env, out);
  return out;
}

export default {
  async fetch(request: Request, env: E2EEnv): Promise<Response> {
    fakeBase = env.E2E_FAKE_BASE;
    return worker.fetch(request, await keyedEnv(env));
  },
} satisfies ExportedHandler<E2EEnv>;
