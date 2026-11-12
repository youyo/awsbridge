// コンソールログインの発行: Standard の署名。境界ごとの手元の秘密鍵（RS256）で JWT に署名する（signer.ts の TokenSigner の実装）。
// 鍵は境界の名前 → 秘密鍵 JWK の JSON を 1 つの secret に入れて渡す（parseSigningKeys）。
// Admin の署名（admin/sign-admin.ts。secret_key の CryptoKey）はこのファイルを使わない（Admin の Worker のバンドルに文字列の鍵の扱いを入れないため）。
// Worker に入るので node:* を import しない。
import { calculateJwkThumbprint, importJWK, type JWK, SignJWT } from "jose";
import { buildClaims } from "./claims";
import type { SignedToken, SigningRequest, SigningResult, TokenSigner } from "./signer";

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
// RSA 2048 bit 以上（n は 256 byte = base64url 342 文字以上）
const MIN_MODULUS_CHARS = 342;
// 公開指数は 65537（base64url で AQAB）に固定する。極端に小さい指数や壊れた値を起動時に断る。
const PUBLIC_EXPONENT_65537 = "AQAB";
const CRT_PARAMS = ["p", "q", "dp", "dq", "qi"] as const;

/**
 * 境界の名前 → 秘密鍵 JWK の JSON を読む。形が崩れていたら例外（起動時・最初の使用時に止め、server_misconfigured にする）。
 * 例外の文に鍵の内容は入れない。
 */
export function parseSigningKeys(raw: string): Record<string, JWK> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("signing keys must be JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("signing keys must be an object of boundary -> private JWK");
  const out: Record<string, JWK> = {};
  const entries = Object.entries(v);
  if (entries.length === 0) throw new Error("signing keys is empty");
  for (const [boundary, jwk] of entries) {
    if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk))
      throw new Error(`signing key for boundary ${JSON.stringify(boundary)} must be an object`);
    const k = jwk as Record<string, unknown>;
    const ok =
      k.kty === "RSA" &&
      (k.alg === undefined || k.alg === "RS256") &&
      k.e === PUBLIC_EXPONENT_65537 &&
      [k.n, k.d, ...CRT_PARAMS.map((c) => k[c])].every(
        (x) => typeof x === "string" && B64URL_RE.test(x),
      ) &&
      (k.n as string).length >= MIN_MODULUS_CHARS;
    if (!ok)
      throw new Error(
        `signing key for boundary ${JSON.stringify(boundary)} must be an RS256 RSA private JWK (2048 bit or more, e=65537, with p q dp dq qi)`,
      );
    out[boundary] = jwk as JWK;
  }
  return out;
}

type Prepared = { key: CryptoKey | Uint8Array; kid: string };

export function createStandardSigner(opts: { keys: Record<string, JWK> }): TokenSigner {
  const prepared = new Map<string, Promise<Prepared>>();
  const prepare = (boundary: string): Promise<Prepared> | undefined => {
    if (!Object.hasOwn(opts.keys, boundary)) return undefined;
    let p = prepared.get(boundary);
    if (!p) {
      const jwk = opts.keys[boundary] as JWK;
      p = (async () => ({
        key: await importJWK({ ...jwk, alg: "RS256" }, "RS256"),
        kid: await calculateJwkThumbprint({ kty: "RSA", n: jwk.n as string, e: jwk.e as string }),
      }))();
      prepared.set(boundary, p);
      p.catch(() => prepared.delete(boundary));
    }
    return p;
  };

  return {
    async sign(req: SigningRequest): Promise<SigningResult> {
      try {
        const p = prepare(req.row.boundary);
        if (!p) return { ok: false, code: "signing_unavailable" };
        const { key, kid } = await p;
        const claims = buildClaims({
          issuer: req.row.issuer,
          sub: req.resolved.email,
          team: req.row.team,
          sourceIdentity: req.resolved.sourceIdentity,
          now: req.now ?? Math.floor(Date.now() / 1000),
        });
        const jwt = await new SignJWT({ ...claims })
          .setProtectedHeader({ alg: "RS256", kid })
          .sign(key);
        const token: SignedToken = {
          jwt,
          jti: claims.jti,
          iat: claims.iat,
          exp: claims.exp,
          issuer: claims.iss,
        };
        return { ok: true, token };
      } catch {
        // 鍵の不正・claim の不正のどちらも、詳細（鍵の内容を含みうる）を返さず署名できないことにする
        return { ok: false, code: "signing_unavailable" };
      }
    },
  };
}
