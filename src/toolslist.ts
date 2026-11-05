// tools/list 応答への aws_profile 注入。設計: docs/specs/architecture.md「マルチアカウント（aws_profile）」。
// 注入は UX 補助（Claude などにプロファイルの選択肢を見せる）。認可は tools/call 側で行うので、
// 加工できない応答は常に原文のまま返す（fail-safe）。
import type { ProfilesConfig } from "./profiles";

const MAX_DESC_PER_PROFILE = 60;
const MAX_DESC_TOTAL = 400;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function describeProfiles(config: ProfilesConfig): string {
  // 数百文字に収める: 説明の合計が上限を超えたら、以降のプロファイルは名前だけにする
  let used = 0;
  const parts = Object.entries(config.profiles).map(([name, e]) => {
    const d = e.description?.trim();
    if (!d || used >= MAX_DESC_TOTAL) return name;
    const short = d.length > MAX_DESC_PER_PROFILE ? `${d.slice(0, MAX_DESC_PER_PROFILE)}…` : d;
    used += short.length;
    return `${name}: ${short}`;
  });
  return `使う AWS アカウント / ロールのプロファイル。省略すると ${config.default}。${parts.join(" / ")}`;
}

/** result.tools[] の対象ツールへ aws_profile を注入する。注入したら true。形状が違えば何もせず false。 */
function injectIntoResponse(config: ProfilesConfig, msg: unknown): boolean {
  if (!isObj(msg) || !isObj(msg.result) || !Array.isArray(msg.result.tools)) return false;
  const schema = {
    type: "string",
    enum: Object.keys(config.profiles),
    description: describeProfiles(config),
  };
  let changed = false;
  for (const t of msg.result.tools) {
    if (!isObj(t) || typeof t.name !== "string") continue;
    if (config.tools !== undefined && !config.tools.includes(t.name)) continue;
    if (t.inputSchema !== undefined && !isObj(t.inputSchema)) continue;
    const inputSchema: Record<string, unknown> = isObj(t.inputSchema) ? t.inputSchema : {};
    if (inputSchema.properties !== undefined && !isObj(inputSchema.properties)) continue;
    const props: Record<string, unknown> = isObj(inputSchema.properties)
      ? inputSchema.properties
      : {};
    if (Object.hasOwn(props, "aws_profile")) {
      console.warn(`tools_list: aws_profile conflict (tool=${t.name})`);
      continue;
    }
    props.aws_profile = schema;
    inputSchema.properties = props;
    if (inputSchema.type === undefined) inputSchema.type = "object";
    t.inputSchema = inputSchema;
    changed = true;
  }
  return changed;
}

function sseRewrite(config: ProfilesConfig, text: string, id: unknown): string | undefined {
  const events = text.split(/\r?\n\r?\n/).filter((e) => e.trim() !== "");
  if (events.length !== 1) return undefined;
  const lines = (events[0] as string).split(/\r?\n/);
  const dataLines = lines.filter((l) => l.startsWith("data:"));
  if (dataLines.length === 0) return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n"));
  } catch {
    return undefined;
  }
  if (!isObj(msg) || msg.id !== id) return undefined;
  if (!injectIntoResponse(config, msg)) return undefined;
  const out: string[] = [];
  let placed = false;
  for (const l of lines) {
    if (!l.startsWith("data:")) out.push(l);
    else if (!placed) {
      out.push(`data: ${JSON.stringify(msg)}`);
      placed = true;
    }
  }
  return `${out.join("\n")}\n\n`;
}

/**
 * 上流の tools/list 応答に aws_profile を注入した Response を返す。
 * 加工しない場合は本文を保ったまま返す。本文を読んだ場合は content-encoding / content-length を外す
 * （Workers の fetch は gzip を展開済みで、長さも変わるため）。
 */
export async function rewriteToolsListResponse(
  upstream: Response,
  config: ProfilesConfig,
  id: unknown,
): Promise<Response> {
  if (upstream.status !== 200) return upstream;
  const ct = (upstream.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const isJson = ct === "application/json";
  const isSse = ct === "text/event-stream";
  if (!isJson && !isSse) return upstream;

  const text = await upstream.text();
  let out: string | undefined;
  if (isJson) {
    try {
      const msg: unknown = JSON.parse(text);
      if (injectIntoResponse(config, msg)) out = JSON.stringify(msg);
    } catch {
      console.warn("tools_list: response is not valid JSON; passing through");
    }
  } else {
    out = sseRewrite(config, text, id);
    if (out === undefined) console.warn("tools_list: cannot rewrite SSE response; passing through");
  }

  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(out ?? text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
