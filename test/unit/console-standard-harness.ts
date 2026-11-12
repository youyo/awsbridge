// コンソールログインの Standard の Worker（src/console/standard/worker.ts）の試験用の道具。
// 偽の Access（手元の鍵と JWKS）・STS・getSigninToken を用意し、Worker を直接呼ぶ。値はすべてダミー。
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { parseConsoleConfig } from "../../src/console/config";
import { generateConsoleArtifacts } from "../../src/console/generate";
import { createCsrfToken, importCsrfKey } from "../../src/console/issue/csrf";
import { bindingNameFor, jwkThumbprint, type PublicJwk } from "../../src/console/signing/key";
import { STANDARD_KEY_BINDING_PREFIX } from "../../src/console/standard/key";
import type { DisplayConfig, WorkerConfig } from "../../src/console/types";
import { companyAuds, companyConfig, companyInventory } from "./console-fixtures";

export const TEAM_DOMAIN = "https://unit-team.cloudflareaccess.com";
export const PORTAL = "https://portal.example.com";
export const PORTAL_HOST = "portal.example.com";
export const ISSUER_HOST = "id.example.com";
export const STD_ISSUER = "https://id.example.com/standard";
export const ADMIN_PORTAL = "https://admin-portal.example.com";
export const ADMIN_HOST = "admin-portal.example.com";
export const ADMIN_TEAM = "infra-elevated";
/** Admin の issuer（Standard の issuer・ポータルと別のホストの /admin。X1 の決裁で A-3 = I-B）。 */
export const ADMIN_ISSUER = "https://admin-id.example.com/admin";
export const ADMIN_ISSUER_HOST = "admin-id.example.com";
/** infra-elevated のチームが Administrator で入れる行（種類 A のアカウント）。 */
export const ADMIN_ENTRY = "333333333333:admin";
export const STS_URL = "https://sts.us-east-1.amazonaws.com/";
export const FEDERATION = "https://signin.aws.amazon.com/federation";
export const AUDS = companyAuds() as {
  teams: Record<string, string>;
  entry: { standard: string; admin: string };
};
/** infra のチームが Viewer で入れる行（種類 A のアカウント）。 */
export const ENTRY = "333333333333:readonly";
export const EMAIL = "user@example.com";
export const SUB = "11111111-2222-4333-8444-555555555555";
// 鍵の形の文字列は実行時に組む（gitleaks の誤検知を避ける）
export const CSRF_SECRET = ["unit", "csrf", "k".repeat(40)].join("-");
export const ACCESS_KEY_ID = ["ASIA", "U".repeat(16)].join("");
export const SIGNIN_TOKEN = ["signin", "u".repeat(24)].join("-");

/** 会社用の設定（試験の fixture）から作った Standard の発行用の生成物。 */
export function standardConfig(): WorkerConfig {
  const { config } = parseConsoleConfig(companyConfig());
  return generateConsoleArtifacts(config, {
    mode: "deploy",
    generatedAt: "2026-11-12T00:00:00.000Z",
    sourceRevision: "unit",
    auds: companyAuds(),
    inventory: companyInventory(),
  }).worker.standard;
}

/** 会社用の設定（試験の fixture）から作った表示用の生成物（display.standard.json）。 */
export function displayConfig(): DisplayConfig {
  const { config } = parseConsoleConfig(companyConfig());
  return generateConsoleArtifacts(config, {
    mode: "deploy",
    generatedAt: "2026-11-12T00:00:00.000Z",
    sourceRevision: "unit",
    auds: companyAuds(),
    inventory: companyInventory(),
  }).display;
}

export function adminConfig(): WorkerConfig {
  const { config } = parseConsoleConfig(companyConfig());
  const w = generateConsoleArtifacts(config, {
    mode: "deploy",
    generatedAt: "2026-11-12T00:00:00.000Z",
    auds: companyAuds(),
    inventory: companyInventory(),
  }).worker.admin;
  if (!w) throw new Error("admin config is missing");
  return w;
}

export const stsXml = (accessKeyId: string) => `<AssumeRoleWithWebIdentityResponse>
<AssumeRoleWithWebIdentityResult>
<Credentials><AccessKeyId>${accessKeyId}</AccessKeyId><SecretAccessKey>unit-secret-value</SecretAccessKey><SessionToken>unit-session-value</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials>
<AssumedRoleUser><Arn>arn:aws:sts::333333333333:assumed-role/FederatedViewer/console-user@example.com</Arn><AssumedRoleId>AROAUNITROLEID:console-user@example.com</AssumedRoleId></AssumedRoleUser>
</AssumeRoleWithWebIdentityResult>
<ResponseMetadata><RequestId>unit-request-id-0001</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`;

export const stsErrorXml = (code: string) =>
  `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>denied</Message></Error><RequestId>x</RequestId></ErrorResponse>`;

export type Seen = { sts: URLSearchParams[]; signin: URLSearchParams[]; other: string[] };

export type Harness = {
  seen: Seen;
  /** STS の応答を差し替える（既定は成功）。 */
  sts: { status: number; body: string };
  accessJwt(p?: {
    aud?: string | string[];
    sub?: string;
    email?: string;
    type?: string;
    iss?: string;
    /** epoch 秒。省略すると現在時刻。 */
    iat?: number;
  }): Promise<string>;
  csrf(aud: string, sub?: string): Promise<string>;
  /** Standard の境界ごとの署名鍵（取り出せない CryptoKey。本番の secret_key と同じ形）。 */
  stdKeys: Record<string, TestKey>;
  getAccessKey: ReturnType<typeof createLocalJWKSet>;
  fetch: typeof fetch;
};

export async function createHarness(): Promise<Harness> {
  const access = await generateKeyPair("RS256", { extractable: true });
  const accessPub = { ...(await exportJWK(access.publicKey)), kid: "unit-access", alg: "RS256" };
  const getAccessKey = createLocalJWKSet({ keys: [accessPub] });
  const stdKeys = await standardTestKeys();
  const csrfKey = await importCsrfKey(CSRF_SECRET);
  const seen: Seen = { sts: [], signin: [], other: [] };
  const h: Harness = {
    seen,
    sts: { status: 200, body: stsXml(ACCESS_KEY_ID) },
    stdKeys,
    getAccessKey,
    async accessJwt(p = {}) {
      return new SignJWT({ email: p.email ?? EMAIL, type: p.type ?? "app" })
        .setProtectedHeader({ alg: "RS256", kid: "unit-access" })
        .setIssuer(p.iss ?? TEAM_DOMAIN)
        .setAudience(p.aud ?? AUDS.teams.infra ?? "")
        .setSubject(p.sub ?? SUB)
        .setIssuedAt(p.iat)
        .setExpirationTime(p.iat === undefined ? "10m" : p.iat + 3600)
        .sign(access.privateKey);
    },
    csrf: (aud, sub = SUB) => createCsrfToken(csrfKey, { aud, sub }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : "";
      if (url === STS_URL) {
        seen.sts.push(new URLSearchParams(body));
        return new Response(h.sts.body, {
          status: h.sts.status,
          headers: { "x-amzn-RequestId": "unit-request-id-0001" },
        });
      }
      if (url === FEDERATION) {
        seen.signin.push(new URLSearchParams(body));
        return new Response(JSON.stringify({ SigninToken: SIGNIN_TOKEN }), {
          headers: { "content-type": "application/json" },
        });
      }
      seen.other.push(url);
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return h;
}

export type RateLimiterStub = { limit(o: { key: string }): Promise<{ success: boolean }> };

export const allowAll: RateLimiterStub = { limit: async () => ({ success: true }) };

/** 試験用の署名鍵（取り出せない CryptoKey と、vars に入れる公開鍵・名前）。 */
export type TestKey = { privateKey: CryptoKey; publicJwk: PublicJwk; kid: string; binding: string };

/** 取り出せない RSA 2048 の鍵（usages sign）を作る。extractable を true にすると、検査で断られる鍵になる。 */
export async function makeStandardKey(extractable = false): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    extractable,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const n = pub.n as string;
  const kid = await jwkThumbprint({ n, e: "AQAB" });
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: "RSA", n, e: "AQAB", kid, alg: "RS256", use: "sig" },
    kid,
    binding: bindingNameFor(STANDARD_KEY_BINDING_PREFIX, kid),
  };
}

// 鍵の生成は遅いので、境界ごとの鍵はモジュールで 1 回だけ作る（試験の間で値は変えない）
let sharedStdKeys: Promise<Record<string, TestKey>> | undefined;
function standardTestKeys(): Promise<Record<string, TestKey>> {
  sharedStdKeys ??= Promise.all([makeStandardKey(), makeStandardKey()]).then(([m, p]) => ({
    managed: m as TestKey,
    "partner:partner-x": p as TestKey,
  }));
  return sharedStdKeys;
}

/**
 * Standard の署名鍵の vars とバインディング。境界 → 今の鍵（STANDARD_CURRENT_KEYS）、境界 → 公開鍵（STANDARD_PUBLIC_JWKS。
 * 既定は今の鍵だけ）、バインディング（名前 → CryptoKey）。
 */
export function standardKeyEnv(
  current: Record<string, TestKey>,
  publicKeys: Record<string, TestKey[]> = Object.fromEntries(
    Object.entries(current).map(([b, k]) => [b, [k]]),
  ),
): Record<string, unknown> {
  const env: Record<string, unknown> = {
    STANDARD_CURRENT_KEYS: JSON.stringify(
      Object.fromEntries(
        Object.entries(current).map(([b, k]) => [b, { binding: k.binding, kid: k.kid }]),
      ),
    ),
    STANDARD_PUBLIC_JWKS: JSON.stringify(
      Object.fromEntries(
        Object.entries(publicKeys).map(([b, ks]) => [b, ks.map((k) => k.publicJwk)]),
      ),
    ),
  };
  for (const k of Object.values(current)) env[k.binding] = k.privateKey;
  return env;
}

export function baseEnv(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ...standardKeyEnv(h.stdKeys),
    CONSOLE_CSRF_KEY: CSRF_SECRET,
    LOGIN_RATE_LIMITER: allowAll,
    ...extra,
  };
}

/** Admin の Worker の env（署名鍵の secret は持たない）。 */
export function adminEnv(
  _h: Harness,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    CONSOLE_CSRF_KEY: CSRF_SECRET,
    LOGIN_RATE_LIMITER: allowAll,
    ...extra,
  };
}

/** POST <team-base>/login の要求を組む。既定は infra のチームの Viewer の行で、正しい Origin・Content-Type。 */
export function loginRequest(p: {
  jwt?: string | undefined;
  form: Record<string, string>;
  path?: string;
  host?: string;
  origin?: string | null;
  contentType?: string;
  secFetchSite?: string;
  method?: string;
}): Request {
  const headers = new Headers();
  if (p.jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", p.jwt);
  if (p.origin !== null) headers.set("Origin", p.origin ?? PORTAL);
  headers.set("Content-Type", p.contentType ?? "application/x-www-form-urlencoded");
  if (p.secFetchSite !== undefined) headers.set("Sec-Fetch-Site", p.secFetchSite);
  return new Request(`https://${p.host ?? PORTAL_HOST}${p.path ?? "/t/infra/login"}`, {
    method: p.method ?? "POST",
    headers,
    body: new URLSearchParams(p.form).toString(),
  });
}
