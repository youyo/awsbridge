// ルーティングと /mcp の通し処理（Access JWT 検証 → Worker JWT 発行 → STS → SigV4 中継）。
// 依存（fetch・Access の鍵解決・認証情報キャッシュ）は注入できる。設計: docs/specs/architecture.md。
import type { JWK, JWTVerifyGetKey } from "jose";
import { AccessJwtError, accessTokenFromRequest, verifyAccessJwt } from "./access";
import { publicJwkOf } from "./keys";
import { buildDiscovery, buildSessionName, publicJwksTolerant, signStsToken } from "./oidc";
import {
  listProfiles,
  type ProfilesConfig,
  ProfilesConfigError,
  parseProfilesConfig,
  profileNames,
  selectProfile,
} from "./profiles";
import { isJsonContentType, proxyToAwsMcp } from "./proxy";
import {
  type AssumedCredentials,
  assumeRoleWithWebIdentity,
  type CredentialCache,
  StsError,
} from "./sts";
import { LIST_PROFILES_TOOL } from "./toolslist";

export interface Env {
  // secret
  SIGNING_JWK?: string;
  // 署名鍵のローテーション用。公開鍵 JWK の JSON 配列（任意）。JWKS に署名鍵の公開鍵と並べて出す。署名には使わない
  ADDITIONAL_PUBLIC_JWKS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // AWS_PROFILES は wrangler の vars（オブジェクト）でも secret（JSON 文字列）でもよい。必須
  AWS_PROFILES?: string | Record<string, unknown>;
  // var（ISSUER は deploy 時の --var、以降は任意の上書き用）
  ISSUER?: string;
  IDENTITY_CLAIM?: string;
  ACCESS_MAX_TOKEN_AGE_SECONDS?: string;
  STS_AUDIENCE?: string;
  STS_REGION?: string;
  STS_ENDPOINT?: string;
  AWS_MCP_REGION?: string;
  AWS_MCP_ENDPOINT?: string;
  TARGET_AWS_REGION?: string;
  // ブラウザ由来の /mcp リクエスト（Origin ヘッダー付き）を許可するオリジン。カンマ区切りの完全一致。未設定なら空（Origin 付きは全拒否）
  ALLOWED_ORIGINS?: string;
}

export interface HandlerDeps {
  /** STS・AWS MCP への外向き fetch。既定はグローバル fetch。 */
  fetch?: typeof fetch;
  /** Access JWT の署名鍵解決。既定はチームドメインの JWKS。 */
  getKey?: JWTVerifyGetKey;
  cache: CredentialCache;
}

const wellKnownHeaders = {
  "content-type": "application/json",
  "cache-control": "public, max-age=300",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: status === 200 ? wellKnownHeaders : { "content-type": "application/json" },
  });

const errorBody = (code: string, status: number) => json({ error: code }, status);
const notFound = () => new Response("Not Found", { status: 404 });
const misconfigured = () => errorBody("server_misconfigured", 500);

async function handleWellKnown(pathname: string, env: Env): Promise<Response> {
  if (!env.ISSUER) return misconfigured();
  if (pathname === "/.well-known/openid-configuration") return json(buildDiscovery(env.ISSUER));
  // 値はログに出さない。どちらの設定が不正かだけを出す
  let jwk: JWK;
  try {
    jwk = JSON.parse(env.SIGNING_JWK ?? "") as JWK;
    await publicJwkOf(jwk);
  } catch {
    console.error("config: invalid SIGNING_JWK");
    return misconfigured();
  }
  return json(await publicJwksTolerant(jwk, env.ADDITIONAL_PUBLIC_JWKS));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isToolsCallOf = (msg: unknown, name: string): msg is Record<string, unknown> =>
  isObj(msg) && msg.method === "tools/call" && isObj(msg.params) && msg.params.name === name;

/** 単一の tools/call なら JSON-RPC の id を持つ要求として返す（バッチは undefined）。 */
const singleToolsCall = (rpc: unknown): Record<string, unknown> | undefined =>
  isObj(rpc) && rpc.method === "tools/call" ? rpc : undefined;

const rpcResult = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function parseMaxAge(v: string | undefined): number | undefined | "invalid" {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

function isAllowedOrigin(origin: string, allowed: string | undefined): boolean {
  return (allowed ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "")
    .includes(origin);
}

async function handleMcp(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  // CSRF 対策。Access はブラウザの Cookie からも Cf-Access-Jwt-Assertion を差し込むため、
  // 認証だけでは防げない。Origin が付いている（ブラウザ由来）なら許可リストに無い限り拒否する。
  // Origin が無い MCP クライアント・Portal のサーバー間通信は通す。STS 呼び出し・本文読み取りより前に判定する。
  const origin = request.headers.get("origin");
  if (origin !== null && !isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
    console.error("csrf: forbidden_origin");
    return errorBody("forbidden_origin", 403);
  }
  // POST は application/json だけ受け付ける（Content-Type 無し・text/plain はプリフライト無しでブラウザから送れる）
  if (
    request.method.toUpperCase() === "POST" &&
    !isJsonContentType(request.headers.get("content-type"))
  ) {
    return errorBody("unsupported_media_type", 415);
  }
  const { ISSUER, SIGNING_JWK, ACCESS_TEAM_DOMAIN, ACCESS_AUD } = env;
  if (!ISSUER || !SIGNING_JWK || !ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    console.error("config: required setting missing");
    return misconfigured();
  }
  let profiles: ProfilesConfig;
  try {
    profiles = parseProfilesConfig(env.AWS_PROFILES);
  } catch (e) {
    console.error(
      `config: ${e instanceof ProfilesConfigError ? e.message : "invalid AWS_PROFILES"}`,
    );
    return misconfigured();
  }
  const maxAge = parseMaxAge(env.ACCESS_MAX_TOKEN_AGE_SECONDS);
  if (maxAge === "invalid") {
    console.error("config: invalid ACCESS_MAX_TOKEN_AGE_SECONDS");
    return misconfigured();
  }

  let who: Awaited<ReturnType<typeof verifyAccessJwt>>;
  try {
    who = await verifyAccessJwt(
      accessTokenFromRequest(request),
      {
        teamDomain: ACCESS_TEAM_DOMAIN,
        audience: ACCESS_AUD,
        identityClaim: env.IDENTITY_CLAIM ?? "email",
        ...(maxAge !== undefined ? { maxTokenAgeSeconds: maxAge } : {}),
      },
      deps.getKey ? { getKey: deps.getKey } : {},
    );
  } catch (e) {
    if (e instanceof AccessJwtError) {
      console.error(`access: ${e.reason}`);
      return e.reason === "identity_missing"
        ? errorBody("forbidden", 403)
        : errorBody("unauthorized", 401);
    }
    console.error("access: unexpected error");
    return errorBody("unauthorized", 401);
  }

  // POST 本文は 1 回だけ読み、プロファイル選択（aws_profile の除去を含む）と中継で使い回す
  let bodyText: string | undefined;
  let rpc: unknown;
  if (request.method.toUpperCase() === "POST") {
    bodyText = await request.text();
    try {
      rpc = JSON.parse(bodyText);
    } catch {
      rpc = undefined;
    }
  }
  // list_aws_profiles は Worker が応答する（認証後・プロファイル選択と STS の前）。バッチは非対応
  if (Array.isArray(rpc) && rpc.some((m) => isToolsCallOf(m, LIST_PROFILES_TOOL))) {
    return errorBody("batch_not_supported", 400);
  }
  if (isToolsCallOf(rpc, LIST_PROFILES_TOOL)) {
    const listing = listProfiles(profiles);
    return rpcResult(rpc.id, {
      content: [{ type: "text", text: JSON.stringify(listing) }],
      structuredContent: listing,
    });
  }
  const selection = selectProfile(profiles, rpc);
  if (selection.kind === "error") {
    const call = singleToolsCall(rpc);
    // 単一の tools/call の aws_profile 不正は、LLM が読めるツール結果で返す（使える一覧つき。roleArn は含めない）
    if (call && selection.code !== "batch_not_supported") {
      const text = `${selection.code}: aws_profile に指定できるプロファイル: ${profileNames(profiles).join(", ")}。省略すると既定の ${profiles.default} を使う。一覧は list_aws_profiles ツールでも取得できる。`;
      return rpcResult(call.id, { isError: true, content: [{ type: "text", text }] });
    }
    return errorBody(selection.code, 400);
  }
  const roleArn = selection.roleArn;

  const cacheKey = { identity: who.identity, roleArn };
  let credentials: AssumedCredentials | undefined = deps.cache.get(cacheKey);
  if (!credentials) {
    let token: string;
    try {
      token = await signStsToken({
        privateJwk: JSON.parse(SIGNING_JWK) as JWK,
        issuer: ISSUER,
        audience: env.STS_AUDIENCE ?? "awsbridge",
        subject: who.identity,
        ...(who.email ? { email: who.email } : {}),
      });
    } catch {
      console.error("config: cannot sign with SIGNING_JWK");
      return misconfigured();
    }
    try {
      credentials = await assumeRoleWithWebIdentity({
        token,
        roleArn,
        sessionName: buildSessionName("gw-", who.identity, `-${selection.name}`),
        region: env.STS_REGION ?? "us-east-1",
        ...(env.STS_ENDPOINT ? { endpoint: env.STS_ENDPOINT } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    } catch (e) {
      if (e instanceof StsError) {
        console.error(`sts: kind=${e.kind} code=${e.code ?? "-"} status=${e.status}`);
        if (e.kind === "forbidden") return errorBody("forbidden", 403);
        if (e.kind === "invalid_token") return errorBody("upstream_auth_failed", 502);
        return errorBody("temporarily_unavailable", 503);
      }
      console.error("sts: unexpected error");
      return errorBody("temporarily_unavailable", 503);
    }
    deps.cache.set(cacheKey, credentials);
  }

  const mcpRegion = env.AWS_MCP_REGION ?? "us-east-1";
  return proxyToAwsMcp(request, {
    credentials,
    upstreamUrl: env.AWS_MCP_ENDPOINT ?? `https://aws-mcp.${mcpRegion}.api.aws/mcp`,
    signingRegion: mcpRegion,
    targetRegion: env.TARGET_AWS_REGION ?? "ap-northeast-1",
    ...(bodyText !== undefined ? { body: bodyText } : {}),
    ...(rpc !== undefined ? { rpc } : {}),
    profiles,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export function createHandler(deps: HandlerDeps) {
  return async (request: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/.well-known/openid-configuration" || pathname === "/.well-known/jwks.json") {
      return request.method === "GET" ? handleWellKnown(pathname, env) : notFound();
    }
    if (pathname === "/mcp") return handleMcp(request, env, deps);
    return notFound();
  };
}
