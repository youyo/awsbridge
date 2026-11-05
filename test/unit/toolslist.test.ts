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
  it("tools 省略なら全ツールの inputSchema.properties.aws_profile に enum（設定順）を注入し、required には加えない", async () => {
    const schema = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", schema), tool("b", { type: "object", properties: {} })])),
      config(),
      1,
    );
    const tools = await toolsOf(res);
    for (const t of tools) {
      expect(t.inputSchema.properties.aws_profile.type).toBe("string");
      expect(t.inputSchema.properties.aws_profile.enum).toEqual(["dev", "prod", "stg"]);
    }
    expect(tools[0].inputSchema.required).toEqual(["x"]);
    expect(tools[0].inputSchema.properties.x).toEqual({ type: "string" });
  });

  it("enum は default を先頭にし、残りを設定の順にする", async () => {
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", {})])),
      config({
        default: "stg",
        profiles: {
          prod: { roleArn: ROLE },
          dev: { roleArn: ROLE },
          stg: { roleArn: ROLE, description: "検証" },
        },
      }),
      1,
    );
    const p = (await toolsOf(res))[0].inputSchema.properties.aws_profile;
    expect(p.enum).toEqual(["stg", "prod", "dev"]);
    expect(p.description.indexOf("stg")).toBeLessThan(p.description.indexOf("prod"));
    expect(p.description.indexOf("prod")).toBeLessThan(p.description.indexOf("dev"));
  });

  it("description に default と各プロファイルの説明（無ければ名前だけ）を入れる", async () => {
    const res = await rewriteToolsListResponse(jsonRes(listBody([tool("a", {})])), config(), 1);
    const d: string = (await toolsOf(res))[0].inputSchema.properties.aws_profile.description;
    expect(d).toContain("省略すると dev");
    expect(d).toContain("dev: 開発");
    expect(d).toContain("stg: 検証");
    expect(d).toContain("prod");
    expect(d).not.toContain("prod:");
  });

  it("プロファイルが多くても description は数百文字程度に収まる", async () => {
    const profiles: ProfilesConfig["profiles"] = {};
    for (let i = 0; i < 30; i++)
      profiles[`p${i}`] = { roleArn: ROLE, description: "あ".repeat(200) };
    const res = await rewriteToolsListResponse(
      jsonRes(listBody([tool("a", {})])),
      { default: "p0", profiles },
      1,
    );
    const d: string = (await toolsOf(res))[0].inputSchema.properties.aws_profile.description;
    expect(d.length).toBeLessThanOrEqual(800);
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
    expect(tools[0].inputSchema.properties.aws_profile.enum).toHaveLength(3);
    expect(tools[1].inputSchema.properties.aws_profile.enum).toHaveLength(3);
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
    expect(tools[1].inputSchema.properties.aws_profile.enum).toBeDefined();
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
    expect(data.result.tools[0].inputSchema.properties.aws_profile.enum).toEqual([
      "dev",
      "prod",
      "stg",
    ]);
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
