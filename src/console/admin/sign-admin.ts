// コンソールログインの Admin の署名の部品（signer.ts の TokenSigner の実装。X1 の決裁）。
// Workers の secret_key 型のバインディング（取り出せない CryptoKey）で、STS に渡す JWT を WebCrypto だけで組む。
//   - 使う前にバインディングを検査する（CryptoKey・private・extractable false・usages sign だけ・RS256・exportKey が失敗する）。
//     合わなければ署名しない（503 signing_unavailable）
//   - claim は共通の buildClaims（iss は Admin の issuer に固定・aud 固定・iat 現在・exp = iat + 300・jti 一意）
//   - 署名のたびに vars の公開鍵（今の kid のもの）で自己検証する。鍵だけ替えて JWKS を替え忘れたら、ここで止まる（失敗は覚えない）
//   - 返す JWT の形を照合する（header は alg・kid・typ だけ、claim の項目は決まったものだけ）
// ログは種別だけ（鍵・JWT・email は出さない）。Standard の署名（sign-standard.ts）と鍵の扱いは共有しない。node:* を import しない。
import { AUDIENCE, TEAM_TAG_KEY } from "../constants";
import {
  AWS_SOURCE_IDENTITY_CLAIM,
  AWS_TAGS_CLAIM,
  buildClaims,
  TOKEN_TTL_SECONDS,
} from "../issue/claims";
import type { SigningRequest, SigningResult, TokenSigner } from "../issue/signer";
import { decodeJws, importVerifyKey, signJws, verifyJws } from "./jws";
import { type CurrentKey, inspectSigningKey, type PublicJwk, RS256_ALGORITHM } from "./key";

const UNAVAILABLE: SigningResult = { ok: false, code: "signing_unavailable" };
const CLAIM_KEYS = [
  "aud",
  "exp",
  "iat",
  "iss",
  "jti",
  "sub",
  AWS_SOURCE_IDENTITY_CLAIM,
  AWS_TAGS_CLAIM,
].sort();

/** デプロイ後の確認（key-check）に返す鍵の状態。値（鍵の中身・署名）は持たない。 */
export type AdminKeyStatus = {
  binding: string;
  kid: string;
  present: boolean;
  usable: boolean;
  extractable?: boolean | undefined;
  usages?: string[] | undefined;
  exportKey?: "rejected" | "allowed" | undefined;
  selfVerify: "ok" | "failed" | "skipped";
};

export type AdminSigner = TokenSigner & { status(): Promise<AdminKeyStatus> };

export type AdminSignerOptions = {
  /** Admin の issuer（JWT の iss。1 つに固定）。 */
  issuer: string;
  /** 今の署名鍵（バインディングの名前と kid）。 */
  current: CurrentKey;
  /** 今の kid の公開鍵（vars ADMIN_PUBLIC_JWKS から選んだもの）。 */
  publicJwk: PublicJwk;
  /** env[current.binding] の値（そのまま渡す。検査はここで行う）。 */
  key: unknown;
  /** 種別だけを 1 行で出す。 */
  log: (line: string) => void;
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 組んだ JWT が決まった形かを確かめる。違えば項目の名前（値は入れない）。 */
function mismatch(jwt: string, req: SigningRequest, o: AdminSignerOptions): string | undefined {
  const d = decodeJws(jwt);
  if (!d) return "token";
  const h = d.header;
  if (!sameJson(Object.keys(h).sort(), ["alg", "kid", "typ"])) return "header";
  if (h.alg !== "RS256" || h.kid !== o.current.kid || h.typ !== "JWT") return "header";
  const p = d.payload;
  if (!sameJson(Object.keys(p).sort(), CLAIM_KEYS)) return "claims";
  if (p.iss !== o.issuer) return "iss";
  if (p.aud !== AUDIENCE) return "aud";
  if (p.sub !== req.resolved.email) return "sub";
  if (!sameJson(p[AWS_TAGS_CLAIM], { principal_tags: { [TEAM_TAG_KEY]: [req.row.team] } }))
    return "tags";
  if (p[AWS_SOURCE_IDENTITY_CLAIM] !== req.resolved.sourceIdentity) return "source_identity";
  if (typeof p.jti !== "string" || p.jti === "") return "jti";
  if (typeof p.iat !== "number" || typeof p.exp !== "number") return "time";
  if (p.exp - p.iat !== TOKEN_TTL_SECONDS) return "ttl";
  return undefined;
}

export function createAdminSigner(o: AdminSignerOptions): AdminSigner {
  const log = (kind: string, extra: Record<string, unknown> = {}) =>
    o.log(JSON.stringify({ event: "console_admin_signer", result: kind, ...extra }));
  let verifyKey: Promise<CryptoKey> | undefined;
  const getVerifyKey = () => {
    if (!verifyKey) {
      verifyKey = importVerifyKey(o.publicJwk);
      verifyKey.catch(() => {
        verifyKey = undefined;
      });
    }
    return verifyKey;
  };

  return {
    async sign(req: SigningRequest): Promise<SigningResult> {
      try {
        if (req.row.issuer !== o.issuer) {
          log("admin_issuer_mismatch");
          return UNAVAILABLE;
        }
        const props = await inspectSigningKey(o.key);
        if (!props.usable) {
          log("admin_key_unusable", { present: props.present });
          return UNAVAILABLE;
        }
        const claims = buildClaims({
          issuer: o.issuer,
          sub: req.resolved.email,
          team: req.row.team,
          sourceIdentity: req.resolved.sourceIdentity,
          now: req.now ?? Math.floor(Date.now() / 1000),
        });
        const jwt = await signJws(o.key as CryptoKey, o.current.kid, { ...claims });
        if (!(await verifyJws(jwt, await getVerifyKey()))) {
          log("admin_key_self_verify_failed");
          return UNAVAILABLE;
        }
        const bad = mismatch(jwt, req, o);
        if (bad !== undefined) {
          log("admin_token_mismatch", { field: bad });
          return UNAVAILABLE;
        }
        return {
          ok: true,
          token: { jwt, jti: claims.jti, iat: claims.iat, exp: claims.exp, issuer: claims.iss },
        };
      } catch {
        // 詳細（鍵の情報を含みうる）は出さない
        log("admin_signer_error");
        return UNAVAILABLE;
      }
    },

    async status(): Promise<AdminKeyStatus> {
      const props = await inspectSigningKey(o.key);
      let selfVerify: AdminKeyStatus["selfVerify"] = "skipped";
      if (props.usable) {
        try {
          // JWS の形ではない確認用のバイト列に署名し、公開鍵で確かめる（署名は返さない・STS には使えない形）
          const probe = new TextEncoder().encode(
            `awsbridge-admin-key-check:${crypto.randomUUID()}`,
          );
          const sig = await crypto.subtle.sign(RS256_ALGORITHM, o.key as CryptoKey, probe);
          const ok = await crypto.subtle.verify(RS256_ALGORITHM, await getVerifyKey(), sig, probe);
          selfVerify = ok ? "ok" : "failed";
        } catch {
          selfVerify = "failed";
        }
      }
      return {
        binding: o.current.binding,
        kid: o.current.kid,
        present: props.present,
        usable: props.usable,
        ...(props.extractable !== undefined ? { extractable: props.extractable } : {}),
        ...(props.usages !== undefined ? { usages: props.usages } : {}),
        ...(props.exportKey !== undefined ? { exportKey: props.exportKey } : {}),
        selfVerify,
      };
    },
  };
}
