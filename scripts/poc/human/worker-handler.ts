// PoC 用 issuer Worker の処理。discovery と JWKS を静的に返すだけで、署名はしない（署名は手元の scripts/poc/human/*.ts）。
export interface StaticIssuerDocuments {
  discovery: unknown;
  jwks: unknown;
}

const PATHS: Record<string, keyof StaticIssuerDocuments> = {
  "/.well-known/openid-configuration": "discovery",
  "/.well-known/jwks.json": "jwks",
};

export function handleIssuerRequest(request: Request, docs: StaticIssuerDocuments): Response {
  const key = PATHS[new URL(request.url).pathname];
  if (key === undefined) return new Response("not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const body = request.method === "HEAD" ? null : JSON.stringify(docs[key]);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "max-age=300" },
  });
}
