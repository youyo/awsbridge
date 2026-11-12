// PoC X1-(h)（cto の決裁「Standard も secret_key に揃える」の条件 (h)）の純粋関数。
// secret_key のバインディングを持つ Worker で、別の secret（secret_text）を wrangler secret put / secret bulk などで更新したあとも
// secret_key が残るかを測る。Worker（worker.ts）と手元の手順（run.ts）の両方が使う。Worker に入るので node:* を import しない。
// 道具は PoC X1-(b)（ブランチ poc/x1-secret-key の scripts/poc/x1/）の最小の写し。MCP 用・コンソールの Worker とは別の Worker を使う。

import { importVerifyKey, signJws, verifyJws } from "../../../src/console/signing/jws";
import {
  inspectSigningKey,
  type KeyProperties,
  RS256_ALGORITHM,
} from "../../../src/console/signing/key";

export const X1H_WORKER = "awsbridge-x1h-poc";
/** secret_key のバインディングの名前（1 つだけ）。 */
export const X1H_KEY_BINDING = "SIGNING_KEY_H";

const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"] as const;

export type X1hSettings = { accountId: string; workerName: string; outDir: string };

/** 設定（AWSBRIDGE_X1H_POC_* だけを読む）。outDir は repoRoot からの相対で返す。 */
export function x1hSettings(env: Record<string, string | undefined>): X1hSettings {
  const accountId = env.AWSBRIDGE_X1H_POC_CF_ACCOUNT_ID || undefined;
  if (accountId === undefined)
    throw new Error(
      "AWSBRIDGE_X1H_POC_CF_ACCOUNT_ID（Cloudflare のアカウント ID）を mise.local.toml に設定する",
    );
  if (!ACCOUNT_RE.test(accountId))
    throw new Error("AWSBRIDGE_X1H_POC_CF_ACCOUNT_ID は 32 桁の 16 進");
  return { accountId, workerName: X1H_WORKER, outDir: ".secrets/poc-x1h" };
}

/** vars SECRET_NAMES（カンマ区切り）を読む。 */
export function parseSecretNames(raw: string | undefined): string[] {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const n of names) if (!SECRET_NAME_RE.test(n)) throw new Error("invalid secret name");
  return names;
}

/** 値の SHA-256 の先頭 12 桁（16 進）。更新が反映されたかを値を出さずに比べる。 */
export async function hashPrefix(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ProbeResult = {
  key: KeyProperties;
  /** vars PUBLIC_JWK で、鍵の署名を確かめられたか（同じ鍵のまま残ったか） */
  selfVerify: boolean;
  /** SECRET_NAMES の各 secret_text の値のハッシュの先頭（無ければ null） */
  secrets: Record<string, string | null>;
};

/** Worker の中で、鍵の性質・自己検証・別の secret の状態を観る。値（鍵・secret）は返さない。 */
export async function probeWorker(env: Record<string, unknown>): Promise<ProbeResult> {
  const v = env[X1H_KEY_BINDING];
  const key = await inspectSigningKey(v);
  let selfVerify = false;
  if (key.usable && typeof env.PUBLIC_JWK === "string") {
    try {
      const pub = JSON.parse(env.PUBLIC_JWK);
      const jwt = await signJws(v as CryptoKey, String(pub.kid), { probe: true });
      selfVerify = await verifyJws(jwt, await importVerifyKey(pub));
    } catch {
      selfVerify = false;
    }
  }
  const secrets: Record<string, string | null> = {};
  for (const n of parseSecretNames(typeof env.SECRET_NAMES === "string" ? env.SECRET_NAMES : "")) {
    const s = env[n];
    secrets[n] = typeof s === "string" ? await hashPrefix(s) : null;
  }
  return { key, selfVerify, secrets };
}

/** Authorization: Bearer <token> が expected と一致するか（長さに依らず全バイトを比べる）。 */
export function bearerMatches(header: string | null, expected: string): boolean {
  if (!header || expected === "") return false;
  const m = /^Bearer (.+)$/i.exec(header);
  if (!m) return false;
  const a = new TextEncoder().encode(m[1]);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** PUT .../secrets の本文（secret_key・format jwk・RS256・usages sign）。JWK は kty と RSA の成分だけ。 */
export function secretKeyBody(name: string, jwk: JsonWebKey) {
  if (!SECRET_NAME_RE.test(name)) throw new Error("invalid binding name");
  const key_jwk: Record<string, string> = { kty: "RSA" };
  for (const m of ["n", "e", ...PRIVATE_MEMBERS]) {
    const v = (jwk as unknown as Record<string, unknown>)[m];
    if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v))
      throw new Error("RSA private JWK required");
    key_jwk[m] = v;
  }
  return {
    name,
    type: "secret_key" as const,
    format: "jwk" as const,
    algorithm: RS256_ALGORITHM,
    usages: ["sign"] as ["sign"],
    key_jwk,
  };
}
