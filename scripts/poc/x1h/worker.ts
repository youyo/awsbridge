// PoC X1-(h) の Worker（awsbridge-x1h-poc）。GET /probe（bearer 必須）で、secret_key の鍵の性質・自己検証・
// 別の secret の値のハッシュの先頭を返す（鍵・secret の値は返さない）。ほかは 404。
// vars: PUBLIC_JWK（投入した鍵の公開鍵）・SECRET_NAMES（観る secret_text の名前）。secret: CALLER_TOKEN（bearer）・SIGNING_KEY_H（secret_key）。
import { bearerMatches, probeWorker } from "./lib";

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/probe")
      return new Response("not found", { status: 404 });
    const token = typeof env.CALLER_TOKEN === "string" ? env.CALLER_TOKEN : "";
    if (!bearerMatches(request.headers.get("authorization"), token))
      return new Response("unauthorized", { status: 401 });
    return Response.json(await probeWorker(env), { headers: { "cache-control": "no-store" } });
  },
};
