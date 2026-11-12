// PoC N6 の Worker（awsbridge-admin-kms-poc）の処理。
// - GET /.well-known/openid-configuration・/.well-known/jwks.json: deploy.ts が KMS の GetPublicKey から作った文書を静的に返す
//   （JWKS を KMS に依存させない。Worker の認証情報は kms:Sign だけで足りる）
// - POST /poc/sign: KMS の Sign の往復だけを count 回測る（K3・K4）
// - POST /poc/login: KMS で JWT に署名 → STS AssumeRoleWithWebIdentity → getSigninToken を測る（K1・K3）
// /poc/* は Worker secret CALLER_TOKEN の bearer が必須。claim は Worker が固定し、呼び出し側の payload には署名しない。
// 応答は所要時間・kid・成否・RequestId だけ。JWT・認証情報・SigninToken は返さない。
import { AwsClient } from "aws4fetch";
import { parseAssumeRoleResponse, parseStsError } from "../../../src/sts-xml";
import {
  assumeRoleWithWebIdentityParams,
  FEDERATION_ENDPOINT,
  getSigninTokenParams,
  parseSigninTokenResponse,
  parseStsExtras,
  stsEndpoint,
} from "../human/claims";
import { handleIssuerRequest, type StaticIssuerDocuments } from "../human/worker-handler";
import {
  ADMIN_KMS_DEFAULTS,
  adminKmsClaims,
  assembleJws,
  bearerMatches,
  jwsSigningInput,
  type KmsKeyConfig,
  kmsErrorCode,
  kmsSessionName,
  kmsSignRequest,
  parseKeysConfig,
  parseKmsSignResponse,
} from "./lib";

export interface AdminKmsEnv {
  ISSUER: string;
  ROLE_ARN: string;
  /** [{label, keyId, alg, kid}] の JSON */
  KMS_KEYS: string;
  /** /poc/* の bearer（secret） */
  CALLER_TOKEN: string;
  /** KMS を呼ぶ IAM ユーザーのアクセスキー（secret） */
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  AUDIENCE?: string;
  SUBJECT?: string;
  ACCESS_PROFILE?: string;
  /** E2E 用の差し替え（localhost だけ有効） */
  KMS_ENDPOINT?: string;
  STS_ENDPOINT?: string;
  FEDERATION_ENDPOINT?: string;
}

export interface AdminKmsDeps {
  fetch?: typeof fetch;
  /** ミリ秒 */
  now?: () => number;
  /** request.cf.colo（応答に入れる） */
  colo?: string;
}

export const MAX_SIGN_COUNT = 50;

const isLocalUrl = (s: string | undefined): s is string =>
  s !== undefined && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(s);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface Ctx {
  env: AdminKmsEnv;
  fetch: typeof fetch;
  now: () => number;
}

type SignResult =
  | { ok: true; ms: number; kmsRequestId: string | undefined; signature: Uint8Array }
  | { ok: false; ms: number; kmsRequestId: string | undefined; code: string };

type Variant = { messageType?: "RAW" | "DIGEST"; signingAlgorithm?: string };

async function kmsSign(
  ctx: Ctx,
  key: KmsKeyConfig,
  message: Uint8Array,
  variant: Variant = {},
): Promise<SignResult> {
  const { env } = ctx;
  const url = isLocalUrl(env.KMS_ENDPOINT)
    ? env.KMS_ENDPOINT
    : `https://kms.${env.AWS_REGION}.amazonaws.com/`;
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "kms",
    region: env.AWS_REGION,
  });
  const req = kmsSignRequest({ keyId: key.keyId, message, alg: key.alg, ...variant });
  const start = ctx.now();
  let res: Response;
  try {
    const signed = await client.sign(url, { method: "POST", headers: req.headers, body: req.body });
    res = await ctx.fetch(signed);
  } catch {
    return { ok: false, ms: ctx.now() - start, kmsRequestId: undefined, code: "NetworkError" };
  }
  const body = await res.text();
  const ms = ctx.now() - start;
  const kmsRequestId = res.headers.get("x-amzn-requestid") ?? undefined;
  if (!res.ok) return { ok: false, ms, kmsRequestId, code: kmsErrorCode(res.status, body) };
  try {
    return { ok: true, ms, kmsRequestId, signature: parseKmsSignResponse(body) };
  } catch {
    return { ok: false, ms, kmsRequestId, code: "BadResponse" };
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await request.json();
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function handleSign(ctx: Ctx, key: KmsKeyConfig, body: Record<string, unknown>) {
  const count = body.count ?? 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_SIGN_COUNT)
    return json({ error: "invalid_count" }, 400);
  // 署名対象は固定の短い文字列（JWT ではない。往復の時間だけを測る）
  let message: Uint8Array = new TextEncoder().encode(
    `awsbridge-admin-kms-poc sign probe ${ctx.now()}`,
  );
  // variant: 鍵ポリシー（MessageType RAW・方式の固定）が Worker の IAM ユーザーにも効くかの確認用。署名結果は使わない
  let variant: Variant = {};
  if (body.variant === "digest") {
    message = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
    variant = { messageType: "DIGEST" };
  } else if (body.variant === "pss") {
    if (key.alg !== "RS256") return json({ error: "invalid_variant" }, 400);
    variant = { signingAlgorithm: "RSASSA_PSS_SHA_256" };
  } else if (body.variant !== undefined) return json({ error: "invalid_variant" }, 400);
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const r = await kmsSign(ctx, key, message, variant);
    const at = new Date(ctx.now()).toISOString();
    results.push(
      r.ok
        ? { ok: true, ms: r.ms, kmsRequestId: r.kmsRequestId, at }
        : { ok: false, ms: r.ms, kmsRequestId: r.kmsRequestId, code: r.code, at },
    );
  }
  return results;
}

async function handleLogin(
  ctx: Ctx,
  label: string,
  key: KmsKeyConfig,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { env } = ctx;
  const t0 = ctx.now();
  const subject = env.SUBJECT || ADMIN_KMS_DEFAULTS.subject;
  const claims = adminKmsClaims({
    issuer: env.ISSUER,
    audience: env.AUDIENCE || ADMIN_KMS_DEFAULTS.audience,
    subject,
    accessProfile: env.ACCESS_PROFILE || ADMIN_KMS_DEFAULTS.accessProfile,
    now: Math.floor(t0 / 1000),
    jti: crypto.randomUUID(),
  });
  // header と payload は JSON の組み立てだけ。KMS の Sign の往復を signMs とする
  const signingInput = jwsSigningInput({ alg: key.alg, kid: key.kid }, claims);
  const base = {
    key: label,
    alg: key.alg,
    kid: key.kid,
    jti: claims.jti,
    startedAt: new Date(t0).toISOString(),
  };
  const signed = await kmsSign(ctx, key, new TextEncoder().encode(signingInput));
  if (!signed.ok)
    return {
      ...base,
      ok: false,
      stage: "kms",
      code: signed.code,
      kmsRequestId: signed.kmsRequestId,
      signMs: signed.ms,
      totalMs: ctx.now() - t0,
    };
  let jwt: string;
  try {
    jwt = assembleJws(signingInput, signed.signature, key.alg);
  } catch {
    return {
      ...base,
      ok: false,
      stage: "kms",
      code: "BadSignature",
      kmsRequestId: signed.kmsRequestId,
    };
  }
  const roleSessionName = kmsSessionName(signed.kmsRequestId);
  const after = {
    ...base,
    kmsRequestId: signed.kmsRequestId,
    roleSessionName,
    signMs: signed.ms,
    jwtLength: jwt.length,
  };

  // STS（署名なし）
  const sts = isLocalUrl(env.STS_ENDPOINT) ? env.STS_ENDPOINT : stsEndpoint(env.AWS_REGION);
  const t1 = ctx.now();
  let status = 0;
  let xml = "";
  let stsRequestId: string | undefined;
  try {
    const res = await ctx.fetch(sts, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: assumeRoleWithWebIdentityParams({
        roleArn: env.ROLE_ARN,
        roleSessionName,
        webIdentityToken: jwt,
      }).toString(),
    });
    status = res.status;
    stsRequestId = res.headers.get("x-amzn-requestid") ?? undefined;
    xml = await res.text();
  } catch {
    return { ...after, ok: false, stage: "sts", code: "NetworkError", stsMs: ctx.now() - t1 };
  }
  const stsMs = ctx.now() - t1;
  const creds = status === 200 ? parseAssumeRoleResponse(xml) : undefined;
  if (!creds) {
    const err = parseStsError(xml);
    return {
      ...after,
      ok: false,
      stage: "sts",
      code: err?.code ?? `HTTP${status}`,
      stsRequestId,
      stsMs,
      totalMs: ctx.now() - t0,
    };
  }
  const extras = parseStsExtras(xml);
  const afterSts = {
    ...after,
    stsRequestId,
    stsMs,
    sourceIdentity: extras.sourceIdentity,
    credentialsExpiration: creds.expiration.toISOString(),
  };
  if (body.federation === false) return { ...afterSts, ok: true, totalMs: ctx.now() - t0 };

  // getSigninToken（SessionDuration は付けない。ロールの最大 1 時間に従う）
  const fed = isLocalUrl(env.FEDERATION_ENDPOINT) ? env.FEDERATION_ENDPOINT : FEDERATION_ENDPOINT;
  const t2 = ctx.now();
  let fedStatus = 0;
  let fedBody = "";
  try {
    const res = await ctx.fetch(`${fed}?${getSigninTokenParams(creds)}`, { method: "GET" });
    fedStatus = res.status;
    fedBody = await res.text();
  } catch {
    return { ...afterSts, ok: false, stage: "federation", code: "NetworkError" };
  }
  const federationMs = ctx.now() - t2;
  const token = fedStatus === 200 ? parseSigninTokenResponse(fedBody) : undefined;
  if (!token)
    return {
      ...afterSts,
      ok: false,
      stage: "federation",
      code: `HTTP${fedStatus}`,
      federationMs,
      totalMs: ctx.now() - t0,
    };
  return {
    ...afterSts,
    ok: true,
    federationMs,
    signinTokenLength: token.length,
    totalMs: ctx.now() - t0,
  };
}

export async function handleAdminKmsRequest(
  request: Request,
  env: AdminKmsEnv,
  docs: StaticIssuerDocuments,
  deps: AdminKmsDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/poc/")) return handleIssuerRequest(request, docs);
  if (!bearerMatches(request.headers.get("authorization"), env.CALLER_TOKEN ?? ""))
    return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let keys: Record<string, KmsKeyConfig>;
  try {
    keys = parseKeysConfig(env.KMS_KEYS);
  } catch {
    return json({ error: "bad_config" }, 500);
  }
  const body = await readBody(request);
  const label = typeof body.key === "string" ? body.key : "";
  const key = Object.hasOwn(keys, label) ? keys[label] : undefined;
  if (!key) return json({ error: "unknown_key" }, 400);
  const ctx: Ctx = {
    env,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? (() => Date.now()),
  };
  const colo = deps.colo;
  if (url.pathname === "/poc/sign") {
    const results = await handleSign(ctx, key, body);
    if (results instanceof Response) return results;
    return json({ colo, key: label, alg: key.alg, kid: key.kid, results });
  }
  if (url.pathname === "/poc/login") {
    if (!env.ROLE_ARN) return json({ error: "no_role" }, 500);
    const out = await handleLogin(ctx, label, key, body);
    return json({ colo, ...out });
  }
  return json({ error: "not_found" }, 404);
}
