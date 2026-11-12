// コンソールログインの署名鍵（Workers の secret_key 型）の運用の道具に共通の部品（Admin: admin-key-lib.ts、Standard: standard-key-lib.ts）。
// Cloudflare API の呼び出し・エラーの要約・secret_key の本文・鍵の生成・公開の文書の取得・key-check の URL。
// トークンと鍵の値は戻り値・例外の文に入れない。Cloudflare API の宛先の上書きは手元（127.0.0.1）の試験用だけ。
import { RS256_ALGORITHM } from "../../src/console/signing/key";
import type { WorkerConfig } from "../../src/console/types";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
export const ACCOUNT_RE = /^[0-9a-f]{32}$/;
export const SCRIPT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"] as const;

export type ToolDeps = {
  fetch: typeof fetch;
  /** Cloudflare API のトークン（環境変数か wrangler の OAuth。メモリの中だけで使う）。 */
  token: () => Promise<string>;
  print: (line: string) => void;
  /** 試験用。省略すると WebCrypto で RSA 2048 を作る。 */
  generateKeyPair?: () => Promise<CryptoKeyPair>;
};

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 行頭の // のコメントだけを外して JSON として読む（wrangler の設定の例は行の途中にコメントを書かない）。 */
export function readJsonc(text: string): Record<string, unknown> {
  return JSON.parse(
    text
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  ) as Record<string, unknown>;
}

/** Cloudflare API の宛先（envName の変数）。上書きは手元（http://127.0.0.1:<port>）の試験用だけ（トークンを外へ送らない）。 */
export function apiBaseFromVar(env: Record<string, string | undefined>, envName: string): string {
  const v = env[envName];
  if (v === undefined || v === "") return CF_API_BASE;
  if (!LOOPBACK_RE.test(v)) throw new Error(`${envName} は試験用で、http://127.0.0.1:<port> だけ`);
  return v;
}

export type ApiResult = { status: number; json: unknown };

export async function cfApi(
  d: Pick<ToolDeps, "fetch">,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<ApiResult> {
  const res = await d.fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** Cloudflare API のエラー（code と、短くした message）だけ。 */
export function cfErrors(json: unknown): string {
  const errs = (json as { errors?: unknown })?.errors;
  if (!Array.isArray(errs)) return "（エラーの本文なし）";
  return errs
    .map((e: { code?: unknown; message?: unknown }) => {
      const msg = typeof e?.message === "string" ? e.message.slice(0, 200) : "";
      return `${String(e?.code)} ${msg}`.trim();
    })
    .join("; ");
}

/** secret の一覧の名前（読めなければ undefined）。 */
export function secretNames(r: ApiResult): unknown[] | undefined {
  return r.status === 200 && isObj(r.json) && Array.isArray(r.json.result)
    ? r.json.result.map((x: unknown) => (isObj(x) ? x.name : undefined))
    : undefined;
}

/** PUT .../secrets の本文（secret_key・format jwk・RS256・usages sign）。JWK は kty と RSA の成分だけ。 */
export function secretKeyBody(name: string, jwk: JsonWebKey) {
  const key_jwk: Record<string, string> = { kty: "RSA" };
  for (const m of ["n", "e", ...PRIVATE_MEMBERS]) {
    const v = (jwk as unknown as Record<string, unknown>)[m];
    if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v))
      throw new Error("RSA の秘密鍵 JWK が要る");
    key_jwk[m] = v;
  }
  return {
    name,
    type: "secret_key",
    format: "jwk",
    algorithm: RS256_ALGORITHM,
    usages: ["sign"],
    key_jwk,
  };
}

/** PUT の応答が {name, type: secret_key} だけで成功しているか。 */
export function putSucceeded(r: ApiResult, name: string): boolean {
  const result = isObj(r.json) ? r.json.result : undefined;
  return (
    r.status >= 200 &&
    r.status < 300 &&
    isObj(r.json) &&
    r.json.success === true &&
    isObj(result) &&
    Object.keys(result).sort().join(",") === "name,type" &&
    result.name === name &&
    result.type === "secret_key"
  );
}

export function generateRsa(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { ...RS256_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

/** 秘密の成分の参照を外す（手元の写しを残さない）。 */
export function forgetPrivate(jwk: JsonWebKey | undefined, body?: { key_jwk: unknown }): void {
  if (jwk) for (const m of PRIVATE_MEMBERS) delete (jwk as unknown as Record<string, unknown>)[m];
  if (body) body.key_jwk = {};
}

/** 公開の文書・key-check を取る。リダイレクトは追わない（Access のログインへ飛ばされたら、その状態を失敗として出す）。 */
export async function getJson(
  d: Pick<ToolDeps, "fetch">,
  url: string,
  headers: Record<string, string> = {},
) {
  try {
    const res = await d.fetch(url, {
      headers: { accept: "application/json", ...headers },
      redirect: "manual",
    });
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: undefined };
  }
}

/** JWKS の kid の一覧（取れなければ undefined）。 */
export function jwksKids(r: { status: number; json: unknown }): unknown[] | undefined {
  return r.status === 200 && isObj(r.json) && Array.isArray(r.json.keys)
    ? r.json.keys.map((k: unknown) => (isObj(k) ? k.kid : undefined))
    : undefined;
}

/** key-check の URL（パス方式は <origin>/t/<team>/key-check、ホスト方式は https://<team>.<host>/key-check）。 */
export function keyCheckUrl(config: WorkerConfig, team: string): string {
  const origin = new URL(config.portal.origin);
  return config.portal.routing === "host"
    ? `${origin.protocol}//${team}.${origin.host}/key-check`
    : `${config.portal.origin}/t/${team}/key-check`;
}
