// ルーティングと /mcp の通し処理（Access JWT 検証 → Worker JWT 発行 → STS → SigV4 中継）。
// 依存（fetch・Access の鍵解決・認証情報キャッシュ）は注入できる。設計: docs/specs/architecture.md。
import type { JWK, JWTVerifyGetKey } from "jose";
import { AccessJwtError, accessTokenFromRequest, verifyAccessJwt } from "./access";
import { buildDiscovery, buildSessionName, publicJwks, signStsToken } from "./oidc";
import { proxyToAwsMcp } from "./proxy";
import {
  type AssumedCredentials,
  assumeRoleWithWebIdentity,
  type CredentialCache,
  StsError,
} from "./sts";

export interface Env {
  // secret
  SIGNING_JWK?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  FEDERATED_ROLE_ARN?: string;
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
  try {
    const jwk = JSON.parse(env.SIGNING_JWK ?? "") as JWK;
    return json(await publicJwks(jwk));
  } catch {
    return misconfigured();
  }
}

function parseMaxAge(v: string | undefined): number | undefined | "invalid" {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

async function handleMcp(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const { ISSUER, SIGNING_JWK, ACCESS_TEAM_DOMAIN, ACCESS_AUD, FEDERATED_ROLE_ARN } = env;
  if (!ISSUER || !SIGNING_JWK || !ACCESS_TEAM_DOMAIN || !ACCESS_AUD || !FEDERATED_ROLE_ARN) {
    console.error("config: required setting missing");
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

  const cacheKey = { identity: who.identity, roleArn: FEDERATED_ROLE_ARN };
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
        roleArn: FEDERATED_ROLE_ARN,
        sessionName: buildSessionName("gw-", who.identity, ""),
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
