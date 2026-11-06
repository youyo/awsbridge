import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfilesConfig } from "../../src/profiles";
import { rewriteToolsListResponse } from "../../src/toolslist";

const ROLE = "arn:aws:iam::111111111111:role/r";
const config = (over: Partial<ProfilesConfig> = {}): ProfilesConfig => ({
  default: "dev",
  profiles: {
    dev: { roleArn: ROLE, description: "開発" },
    prod: { roleArn: ROLE },
    stg: { roleArn: ROLE, description: "検証" },
  },
  ...over,
});

const tool = (name: string, inputSchema?: unknown) => ({
  name,
  description: "d",
  ...(inputSchema === undefined ? {} : { inputSchema }),
});
const listBody = (tools: unknown[], id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  result: { tools },
});
const jsonRes = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as object) },
  });
// biome-ignore lint/suspicious/noExplicitAny: テスト用
const toolsOf = async (res: Response): Promise<any[]> =>
  ((await res.json()) as { result: { tools: any[] } }).result.tools;

afterEach(() => vi.restoreAllMocks());

describe("rewriteToolsListResponse: JSON 応答", () => {
  it("tools 省略なら全ツールの inputSchema.properties.aws_profile に（enum なしの）string を注入し、required には加えない", async () => {
    const schema = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", schema), tool("b", { type: "object", properties: {} })])),
      config(),
      1,
    );
    const tools = (await toolsOf(res)).filter((t) => t.name !== "list_aws_profiles");
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t.inputSchema.properties.aws_profile.type).toBe("string");
      expect(t.inputSchema.properties.aws_profile.enum).toBeUndefined();
    }
    expect(tools[0].inputSchema.required).toEqual(["x"]);
    expect(tools[0].inputSchema.properties.x).toEqual({ type: "string" });
  });

  it("description は固定文字列で、default にもプロファイル名にも依存しない（設定を変えてもスキーマが変わらない）", async () => {
    const schemaOf = async (c: ProfilesConfig) =>
      (await toolsOf(await rewriteToolsListResponse(jsonRes(listBody([tool("a", {})])), c, 1)))[0]
        .inputSchema.properties.aws_profile;
    const x = await schemaOf(config());
    const y = await schemaOf(
      config({
        default: "stg",
        profiles: { stg: { roleArn: ROLE, description: "別" }, other: { roleArn: ROLE } },
      }),
    );
    expect(x).toEqual(y);
    expect(x.type).toBe("string");
    expect(x.enum).toBeUndefined();
    expect(x.description).toContain("list_aws_profiles");
    for (const n of ["dev", "prod", "stg", "開発", "検証"]) expect(x.description).not.toContain(n);
  });

  it("tools 設定があれば対象ツールだけに注入する", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("call_aws", {}), tool("other", {})])),
      config({ tools: ["call_aws"] }),
      1,
    );
    const tools = await toolsOf(res);
    expect(tools[0].inputSchema.properties.aws_profile).toBeDefined();
    expect(tools[1].inputSchema.properties?.aws_profile).toBeUndefined();
  });

  it("inputSchema / properties が無ければ type: object で補う", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a"), tool("b", { type: "object" })])),
      config(),
      1,
    );
    const tools = await toolsOf(res);
    expect(tools[0].inputSchema.type).toBe("object");
    expect(tools[0].inputSchema.properties.aws_profile.type).toBe("string");
    expect(tools[1].inputSchema.properties.aws_profile.type).toBe("string");
  });

  it("既に aws_profile を持つツールは注入せず warn する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const own = { type: "object", properties: { aws_profile: { type: "number" } } };
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", own), tool("b", {})])),
      config(),
      1,
    );
    const tools = await toolsOf(res);
    expect(tools[0].inputSchema.properties.aws_profile).toEqual({ type: "number" });
    expect(tools[1].inputSchema.properties.aws_profile.type).toBe("string");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tools_list: aws_profile conflict"));
  });

  it("加工時は content-encoding と content-length を外す", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", {})]), {
        headers: { "content-encoding": "gzip", "content-length": "5" },
      }),
      config(),
      1,
    );
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.status).toBe(200);
  });
});

describe("rewriteToolsListResponse: fail-safe", () => {
  it("200 以外は加工しない", async () => {
    const body = JSON.stringify(listBody([tool("a", {})]));
    const res = await rewriteToolsListResponse(jsonRes(body, { status: 500 }), config(), 1);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(body);
  });

  it("JSON でも SSE でもない content-type は原文のまま", async () => {
    const res = await rewriteToolsListResponse(
      new Response("plain", { status: 200, headers: { "content-type": "text/plain" } }),
      config(),
      1,
    );
    expect(await res.text()).toBe("plain");
  });

  it("壊れた JSON は原文のまま", async () => {
    const res = await rewriteToolsListResponse(jsonRes("{not json"), config(), 1);
    expect(await res.text()).toBe("{not json");
  });

  it("result.tools が無い応答（エラー等）は原文のまま", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } });
    const res = await rewriteToolsListResponse(jsonRes(body), config(), 1);
    expect(await res.text()).toBe(body);
  });
});

describe("rewriteToolsListResponse: SSE 応答", () => {
  const sse = (data: string, extra = "") =>
    new Response(`event: message\n${extra}data: ${data}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  it("data の JSON-RPC 応答に注入して再シリアライズする（event 行は保つ）", async () => {
    const res = await rewriteToolsListResponse(
      sse(JSON.stringify(listBody([tool("a", {})], 5))),
      config(),
      5,
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text.startsWith("event: message\ndata: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    const data = JSON.parse(text.split("data: ")[1] as string);
    expect(data.result.tools[0].inputSchema.properties.aws_profile.type).toBe("string");
    expect(data.result.tools[0].inputSchema.properties.aws_profile.enum).toBeUndefined();
    expect(data.result.tools.map((t: { name: string }) => t.name)).toContain("list_aws_profiles");
  });

  it("id が一致しない応答は原文のまま", async () => {
    const body = JSON.stringify(listBody([tool("a", {})], 9));
    const res = await rewriteToolsListResponse(sse(body), config(), 5);
    expect(await res.text()).toBe(`event: message\ndata: ${body}\n\n`);
  });

  it("複数イベントは扱えないので原文のまま流し warn する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify(listBody([tool("a", {})], 5));
    const raw = `data: ${body}\n\ndata: ${body}\n\n`;
    const res = await rewriteToolsListResponse(
      new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
      config(),
      5,
    );
    expect(await res.text()).toBe(raw);
    expect(warn).toHaveBeenCalled();
  });

  it("data が JSON でなければ原文のまま", async () => {
    const res = await rewriteToolsListResponse(sse("not json"), config(), 5);
    expect(await res.text()).toBe("event: message\ndata: not json\n\n");
  });
});

describe("rewriteToolsListResponse: list_aws_profiles の追加", () => {
  const find = (tools: { name: string; [k: string]: unknown }[]) =>
    tools.find((t) => t.name === "list_aws_profiles");

  it("tools 設定に関係なく list_aws_profiles を追加する（aws_profile は付けない）", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("call_aws", {}), tool("other", {})])),
      config({ tools: ["call_aws"] }),
      1,
    );
    const t = find(await toolsOf(res));
    expect(t).toBeDefined();
    expect(t?.description).toEqual(expect.any(String));
    expect(t?.inputSchema).toEqual({ type: "object", properties: {} });
    expect(t?.annotations).toEqual({ readOnlyHint: true });
  });

  it("対象ツールが 0 件でも追加して変更扱いにする", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("other", {})])),
      config({ tools: ["call_aws"] }),
      1,
    );
    expect(find(await toolsOf(res))).toBeDefined();
  });

  it("上流に同名ツールがあれば追加せず warn する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const own = tool("list_aws_profiles", { type: "object" });
    const res = await rewriteToolsListResponse(jsonRes(listBody([own])), config(), 1);
    const tools = await toolsOf(res);
    expect(tools.filter((t) => t.name === "list_aws_profiles")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("list_aws_profiles conflict"));
  });

  it("2 ページ目以降（firstPage=false）は追加しないが aws_profile は注入する", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", {})])),
      config(),
      1,
      false,
    );
    const tools = await toolsOf(res);
    expect(find(tools)).toBeUndefined();
    expect(tools[0].inputSchema.properties.aws_profile.type).toBe("string");
  });

  it("roleArn もアカウント ID も tools/list 応答に含めない", async () => {
    const res = await rewriteToolsListResponse(jsonRes(listBody([tool("a", {})])), config(), 1);
    const text = await res.text();
    expect(text).not.toContain("111111111111");
    expect(text).not.toContain("arn:aws");
  });
});
