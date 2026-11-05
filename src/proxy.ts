import { AwsClient } from "aws4fetch";
import type { ProfilesConfig } from "./profiles";
import { rewriteToolsListResponse } from "./toolslist";

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
  /** 呼び出し側が先に読んだ POST 本文（Request の本文は 2 回読めない）。省略時は request から読む。 */
  body?: string;
  /** `body` を JSON パースしたもの（呼び出し側が加工済みでもよい）。あれば再パースせずこれに注入して 1 回だけ直列化する。 */
  rpc?: unknown;
  /** 指定すると、単一の tools/list リクエストの応答に aws_profile を注入する（accept も JSON にする）。 */
  profiles?: ProfilesConfig;
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
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  return (contentType.split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

/**
 * パース済みの JSON-RPC リクエストに params._meta.AWS_REGION を注入した新しいオブジェクトを返す。
 * 注入できない形状（jsonrpc 無し・params/_meta が object 以外・配列）は undefined。既存の AWS_REGION は尊重する。
 */
export function withMetaAwsRegion(rpc: unknown, region: string): unknown | undefined {
  if (!isPlainObject(rpc) || !("jsonrpc" in rpc) || rpc.jsonrpc === undefined) return undefined;

  let params: Record<string, unknown> = {};
  if ("params" in rpc) {
    if (!isPlainObject(rpc.params)) return undefined; // null・配列・プリミティブは対象外
    params = rpc.params;
  }

  let meta: Record<string, unknown> = {};
  if ("_meta" in params && params._meta !== null) {
    if (!isPlainObject(params._meta)) return undefined;
    meta = params._meta;
  }

  if (!("AWS_REGION" in meta)) meta = { ...meta, AWS_REGION: region };
  return { ...rpc, params: { ...params, _meta: meta } };
}

/**
 * JSON-RPC リクエスト本文の params._meta.AWS_REGION に region を注入する。
 * 不正な形状・非 JSON は原文をそのまま返す（fail-safe）。
 */
export function injectMetaAwsRegion(
  body: string,
  contentType: string | null,
  region: string,
): string {
  if (!isJsonContentType(contentType)) return body;
  let rpc: unknown;
  try {
    rpc = JSON.parse(body);
  } catch {
    return body;
  }
  const out = withMetaAwsRegion(rpc, region);
  return out === undefined ? body : JSON.stringify(out);
}

function isToolsList(rpc: unknown): rpc is Record<string, unknown> {
  return isPlainObject(rpc) && rpc.method === "tools/list";
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
  // tools/list は応答を加工するため、JSON 応答を求める（SSE は扱えるが加工が単純な JSON を優先する）
  const listRpc = isToolsList(opts.rpc) ? opts.rpc : undefined;
  const rewrite = method === "POST" && opts.profiles !== undefined && listRpc !== undefined;
  headers.set("accept", rewrite ? "application/json" : "application/json, text/event-stream");

  let body: string | null = null;
  if (method === "POST") {
    if (opts.rpc !== undefined) {
      body = JSON.stringify(withMetaAwsRegion(opts.rpc, opts.targetRegion) ?? opts.rpc);
    } else {
      const text = opts.body ?? (await request.text());
      body = injectMetaAwsRegion(text, request.headers.get("content-type"), opts.targetRegion);
    }
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
    if (rewrite && opts.profiles && listRpc) {
      const res = await rewriteToolsListResponse(upstream, opts.profiles, listRpc.id);
      const h = new Headers(res.headers);
      for (const name of DROP_RESPONSE_HEADERS) h.delete(name);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
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
