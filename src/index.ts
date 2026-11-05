import type { JWK } from "jose";
import { buildDiscovery, publicJwks } from "./oidc";

export interface Env {
  ISSUER?: string;
  SIGNING_JWK?: string;
}

const headers = { "content-type": "application/json", "cache-control": "public, max-age=300" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: status === 200 ? headers : { "content-type": "application/json" },
  });

const notFound = () => new Response("Not Found", { status: 404 });
const serverError = () => json({ error: "server_misconfigured" }, 500);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") return notFound();
    const { pathname } = new URL(request.url);
    if (pathname !== "/.well-known/openid-configuration" && pathname !== "/.well-known/jwks.json") {
      return notFound();
    }
    if (!env.ISSUER) return serverError();
    if (pathname === "/.well-known/openid-configuration") return json(buildDiscovery(env.ISSUER));
    try {
      const jwk = JSON.parse(env.SIGNING_JWK ?? "") as JWK;
      return json(await publicJwks(jwk));
    } catch {
      return serverError();
    }
  },
} satisfies ExportedHandler<Env>;
