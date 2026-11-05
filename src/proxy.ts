import { AwsClient } from "aws4fetch";

export interface ProxyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface ProxyOptions {
  credentials: ProxyCredentials;
  /** 固定の上流 URL（例: https://aws-mcp.us-east-1.api.aws/mcp）。クライアントのパス・クエリは使わない。 */
  upstreamUrl: string;
  /** SigV4 の署名リージョン（上流エンドポイントのリージョン）。 */
  signingRegion: string;
  /** SigV4 のサービス名。既定は aws-mcp。 */
  service?: string;
  /** `_meta.AWS_REGION` に注入する操作対象リージョン。 */
  targetRegion: string;
  fetch?: typeof fetch;
}

const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

const DROP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "set-cookie2",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * JSON-RPC リクエストの params._meta.AWS_REGION に region を注入する。
 * 不正な形状・非 JSON は原文をそのまま返す（fail-safe）。既存の AWS_REGION は尊重する。
 */
export function injectMetaAwsRegion(
  body: string,
  contentType: string | null,
  region: string,
): string {
  if (contentType) {
    const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    if (mediaType !== "application/json") return body;
  }

  let rpc: unknown;
  try {
    rpc = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isPlainObject(rpc) || !("jsonrpc" in rpc) || rpc.jsonrpc === undefined) return body;

  let params: Record<string, unknown> = {};
  if ("params" in rpc) {
    if (!isPlainObject(rpc.params)) return body; // null・配列・プリミティブは原文
    params = rpc.params;
  }

  let meta: Record<string, unknown> = {};
  if ("_meta" in params && params._meta !== null) {
    if (!isPlainObject(params._meta)) return body;
    meta = params._meta;
  }

  if (!("AWS_REGION" in meta)) meta = { ...meta, AWS_REGION: region };
  return JSON.stringify({ ...rpc, params: { ...params, _meta: meta } });
}

function badGateway(): Response {
  return new Response("Bad Gateway", { status: 502 });
}

export async function proxyToAwsMcp(request: Request, opts: ProxyOptions): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, POST, DELETE" },
    });
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  headers.set("accept", "application/json, text/event-stream");

  let body: string | null = null;
  if (method === "POST") {
    const text = await request.text();
    body = injectMetaAwsRegion(text, request.headers.get("content-type"), opts.targetRegion);
  }

  const doFetch = opts.fetch ?? fetch;
  // 失敗の原因種別だけをログする（メッセージ本文・URL・認証情報は出さない）
  let signed: Request;
  try {
    const client = new AwsClient({
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      sessionToken: opts.credentials.sessionToken,
      service: opts.service ?? "aws-mcp",
      region: opts.signingRegion,
    });
    signed = await client.sign(opts.upstreamUrl, { method, headers, body, redirect: "manual" });
  } catch {
    console.error("proxy: sign_failed");
    return badGateway();
  }

  try {
    const upstream = await doFetch(signed);
    const outHeaders = new Headers(upstream.headers);
    for (const name of DROP_RESPONSE_HEADERS) outHeaders.delete(name);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch {
    console.error("proxy: fetch_failed");
    return badGateway();
  }
}
