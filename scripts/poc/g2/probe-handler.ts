// G2 の試験用の issuer の Worker の処理: <issuer のパス>/.well-known/openid-configuration と jwks.json を静的に返すだけ。
// 署名はしない（署名は手元の scripts/poc/g2/probe.ts）。Worker に入るので node:* を import しない。
// 応答ヘッダーは本物の issuer（src/console/admin/worker.ts・portal/worker.ts）に合わせる:
//   Content-Type: application/json と securityHeaders("page")（Cache-Control: no-store を含む）。404 と 405 にも同じヘッダーを付ける。
import { securityHeaders } from "../../../src/console/http/headers";

export interface ProbeDocuments {
  discovery: { issuer: string; jwks_uri: string } & Record<string, unknown>;
  jwks: { keys: unknown[] };
}

function respond(body: string | null, status: number, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...securityHeaders("page"), ...extra },
  });
}

export function handleProbeRequest(request: Request, docs: ProbeDocuments): Response {
  const base = new URL(docs.discovery.issuer).pathname;
  const path = new URL(request.url).pathname;
  const doc =
    path === `${base}/.well-known/openid-configuration`
      ? docs.discovery
      : path === `${base}/.well-known/jwks.json`
        ? docs.jwks
        : undefined;
  if (doc === undefined) return respond(JSON.stringify({ error: "not_found" }), 404);
  if (request.method !== "GET" && request.method !== "HEAD")
    return respond(JSON.stringify({ error: "method_not_allowed" }), 405, { Allow: "GET, HEAD" });
  return respond(request.method === "HEAD" ? null : JSON.stringify(doc), 200);
}
