// tools/list 応答への aws_profile 注入。設計: docs/specs/architecture.md「マルチアカウント（aws_profile）」。
// 注入は UX 補助（aws_profile の引数と、一覧を返す list_aws_profiles ツールを見せる）。スキーマはプロファイル設定に依存させない。認可は tools/call 側で行うので、
// 加工できない応答は常に原文のまま返す（fail-safe）。
import type { ProfilesConfig } from "./profiles";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const LIST_PROFILES_TOOL = "list_aws_profiles";

// 固定文字列。default もプロファイル名も入れない（プロファイルを追加してもスキーマが変わらないようにする）
const AWS_PROFILE_SCHEMA = {
  type: "string",
  description:
    "使う AWS アカウント / ロールのプロファイル名。使えるプロファイルは list_aws_profiles ツールで取得する。省略すると既定のプロファイルを使う。",
};

const LIST_PROFILES_DEFINITION = {
  name: LIST_PROFILES_TOOL,
  description:
    "aws_profile に指定できるプロファイルの一覧（名前と説明）と、省略時に使われる既定のプロファイル名を返す。",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

/** result.tools[] の対象ツールへ aws_profile を注入する。注入したら true。形状が違えば何もせず false。 */
function injectIntoResponse(config: ProfilesConfig, msg: unknown, addListTool: boolean): boolean {
  if (!isObj(msg) || !isObj(msg.result) || !Array.isArray(msg.result.tools)) return false;
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
    props.aws_profile = { ...AWS_PROFILE_SCHEMA };
    inputSchema.properties = props;
    if (inputSchema.type === undefined) inputSchema.type = "object";
    t.inputSchema = inputSchema;
    changed = true;
  }
  if (addListTool) {
    if (msg.result.tools.some((t) => isObj(t) && t.name === LIST_PROFILES_TOOL)) {
      console.warn(`tools_list: ${LIST_PROFILES_TOOL} conflict`);
    } else {
      msg.result.tools.push(structuredClone(LIST_PROFILES_DEFINITION));
      changed = true;
    }
  }
  return changed;
}

function sseRewrite(
  config: ProfilesConfig,
  text: string,
  id: unknown,
  addListTool: boolean,
): string | undefined {
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
  if (!injectIntoResponse(config, msg, addListTool)) return undefined;
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
  /** false なら list_aws_profiles を追加しない（tools/list の 2 ページ目以降）。 */
  addListTool = true,
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
      if (injectIntoResponse(config, msg, addListTool)) out = JSON.stringify(msg);
    } catch {
      console.warn("tools_list: response is not valid JSON; passing through");
    }
  } else {
    out = sseRewrite(config, text, id, addListTool);
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
