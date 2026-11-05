import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/** Cloudflare Access の application token を運ぶヘッダー。 */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** exp / nbf に許す時計ずれ（秒）。 */
const CLOCK_TOLERANCE_SECONDS = 30;

export type AccessJwtErrorReason =
  | "missing"
  | "invalid"
  | "expired"
  | "identity_missing"
  | "too_old";

export class AccessJwtError extends Error {
  readonly reason: AccessJwtErrorReason;
  constructor(reason: AccessJwtErrorReason, message?: string) {
    super(message ?? `Access JWT を受け付けられません: ${reason}`);
    this.name = "AccessJwtError";
    this.reason = reason;
  }
}

export interface AccessVerifyConfig {
  /** `https://<team>.cloudflareaccess.com`（末尾スラッシュは無視） */
  teamDomain: string;
  /** このアプリケーションの AUD タグ */
  audience: string;
  /** 利用者識別子にする claim。既定 "email"。"sub" または "custom.<name>"（例: custom.oid） */
  identityClaim?: string;
  /** iat がこれより古いトークンを too_old で拒否する。未指定なら検査しない */
  maxTokenAgeSeconds?: number;
}

export interface AccessVerifyOptions {
  /** 署名鍵の解決。テストでは固定鍵を返す関数を注入する。省略時はチームドメインの JWKS を取得する */
  getKey?: JWTVerifyGetKey;
  /** 現在時刻（epoch 秒。テスト用） */
  now?: number;
}

export interface AccessIdentity {
  identity: string;
  email?: string | undefined;
  sub: string;
  claims: JWTPayload;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

// チームドメインごとに JWKS（と jose 内部の鍵キャッシュ）を使い回す
const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * リクエストから Access JWT を取り出す。
 *
 * `Cf-Access-Jwt-Assertion` ヘッダーだけを信頼し、Cookie `CF_Authorization` は直接は読まない。
 * ただし self_hosted の Access は、ブラウザの Cookie を検証したうえでこのヘッダーを Worker に差し込む。
 * つまり Cookie 由来のブラウザ通信でもヘッダーは付くので、「ヘッダーだけ見る」ことは CSRF 対策にならない。
 * CSRF は handler 側の Origin 検査（ALLOWED_ORIGINS）と POST の Content-Type 制限（application/json のみ）で防ぐ。
 */
export function accessTokenFromRequest(req: Request): string {
  const token = req.headers.get(ACCESS_JWT_HEADER);
  if (!token) throw new AccessJwtError("missing", `${ACCESS_JWT_HEADER} ヘッダーがありません`);
  return token;
}

function pickIdentity(claims: JWTPayload, identityClaim: string): string | undefined {
  let value: unknown;
  if (identityClaim.startsWith("custom.")) {
    const custom = claims.custom;
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      value = (custom as Record<string, unknown>)[identityClaim.slice("custom.".length)];
    }
  } else {
    value = claims[identityClaim];
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function verifyAccessJwt(
  token: string,
  cfg: AccessVerifyConfig,
  opts: AccessVerifyOptions = {},
): Promise<AccessIdentity> {
  if (!token) throw new AccessJwtError("missing", "トークンが空です");
  const teamDomain = trimSlash(cfg.teamDomain);
  const getKey = opts.getKey ?? remoteJwks(teamDomain);
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);

  let payload: JWTPayload;
  try {
    // alg を RS256 に固定し、none / HS256 などへのすり替えを防ぐ。
    // aud は jose が「文字列 or 配列に含まれる」で判定する。
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: teamDomain,
      audience: cfg.audience,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(nowSec * 1000),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired)
      throw new AccessJwtError("expired", "トークンの期限が切れています");
    // 検証失敗・JWKS 取得失敗はすべて fail closed
    throw new AccessJwtError("invalid", e instanceof Error ? e.message : "検証に失敗しました");
  }

  if (cfg.maxTokenAgeSeconds !== undefined) {
    if (typeof payload.iat !== "number" || nowSec - payload.iat > cfg.maxTokenAgeSeconds) {
      throw new AccessJwtError("too_old", "トークンの発行から時間が経ちすぎています");
    }
  }

  const identityClaim = cfg.identityClaim ?? "email";
  const picked = pickIdentity(payload, identityClaim);
  if (!picked) {
    throw new AccessJwtError("identity_missing", `利用者識別子 ${identityClaim} を取り出せません`);
  }
  // email は大文字小文字を区別しない値なので小文字に正規化して照合する（sub / custom.* はそのまま）
  const identity = identityClaim === "email" ? picked.toLowerCase() : picked;
  return {
    identity,
    email: typeof payload.email === "string" ? payload.email : undefined,
    sub: typeof payload.sub === "string" ? payload.sub : "",
    claims: payload,
  };
}
