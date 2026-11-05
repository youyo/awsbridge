import { AwsClient } from "aws4fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectMetaAwsRegion, proxyToAwsMcp } from "../../src/proxy";

const JSON_CT = "application/json";
const parse = (s: string) => JSON.parse(s);

describe("injectMetaAwsRegion", () => {
  it("非 JSON の Content-Type は原文を返す", () => {
    const body = '{"jsonrpc":"2.0","method":"x"}';
    expect(injectMetaAwsRegion(body, "text/plain", "ap-northeast-1")).toBe(body);
  });

  it("Content-Type が空(null)でも JSON-RPC なら注入を試みる", () => {
    const out = injectMetaAwsRegion(
      '{"jsonrpc":"2.0","method":"x","params":{}}',
      null,
      "us-west-2",
    );
    expect(parse(out).params._meta.AWS_REGION).toBe("us-west-2");
  });

  it("charset 付きの application/json は JSON として扱う", () => {
    const out = injectMetaAwsRegion(
      '{"jsonrpc":"2.0","method":"x","params":{}}',
      "application/json; charset=utf-8",
      "us-west-2",
    );
    expect(parse(out).params._meta.AWS_REGION).toBe("us-west-2");
  });

  it("JSON でない本文は原文を返す", () => {
    expect(injectMetaAwsRegion("not json", JSON_CT, "r")).toBe("not json");
    expect(injectMetaAwsRegion("", JSON_CT, "r")).toBe("");
  });

  it("JSON-RPC でない(jsonrpc が無い)object は原文を返す", () => {
    const body = '{"method":"x","params":{}}';
    expect(injectMetaAwsRegion(body, JSON_CT, "r")).toBe(body);
  });

  it("params が無ければ params を作って注入する", () => {
    const out = parse(
      injectMetaAwsRegion('{"jsonrpc":"2.0","method":"ping"}', JSON_CT, "ap-northeast-1"),
    );
    expect(out.params._meta.AWS_REGION).toBe("ap-northeast-1");
    expect(out.method).toBe("ping");
  });

  it("params が null なら原文を返す", () => {
    const body = '{"jsonrpc":"2.0","method":"x","params":null}';
    expect(injectMetaAwsRegion(body, JSON_CT, "r")).toBe(body);
  });

  it("params が object でなければ原文を返す", () => {
    for (const p of ['"s"', "1", "[1]", "true"]) {
      const body = `{"jsonrpc":"2.0","method":"x","params":${p}}`;
      expect(injectMetaAwsRegion(body, JSON_CT, "r")).toBe(body);
    }
  });

  it("_meta が null なら空 object 扱いで注入する", () => {
    const out = parse(
      injectMetaAwsRegion('{"jsonrpc":"2.0","method":"x","params":{"_meta":null}}', JSON_CT, "r1"),
    );
    expect(out.params._meta).toEqual({ AWS_REGION: "r1" });
  });

  it("_meta が object でなければ原文を返す", () => {
    for (const m of ["1", '"s"', "[1]"]) {
      const body = `{"jsonrpc":"2.0","method":"x","params":{"_meta":${m}}}`;
      expect(injectMetaAwsRegion(body, JSON_CT, "r")).toBe(body);
    }
  });

  it("既存の AWS_REGION を尊重する", () => {
    const body = '{"jsonrpc":"2.0","method":"x","params":{"_meta":{"AWS_REGION":"eu-west-1"}}}';
    const out = parse(injectMetaAwsRegion(body, JSON_CT, "ap-northeast-1"));
    expect(out.params._meta.AWS_REGION).toBe("eu-west-1");
  });

  it("他の _meta・params フィールドを保ったまま注入する", () => {
    const out = parse(
      injectMetaAwsRegion(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","_meta":{"progressToken":"p"}}}',
        JSON_CT,
        "ap-northeast-1",
      ),
    );
    expect(out.id).toBe(1);
    expect(out.params.name).toBe("t");
    expect(out.params._meta).toEqual({ progressToken: "p", AWS_REGION: "ap-northeast-1" });
  });

  it("バッチ(配列)は原文のまま", () => {
    const body = '[{"jsonrpc":"2.0","method":"x","params":{}}]';
    expect(injectMetaAwsRegion(body, JSON_CT, "r")).toBe(body);
  });
});

const credentials = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretExampleKey123456789012345678901234",
  sessionToken: "session-token-example",
};
const upstreamUrl = "https://aws-mcp.us-east-1.api.aws/mcp";

type Captured = { url: string; method: string; headers: Headers; body: string };

function fakeFetch(respond?: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    return respond
      ? respond()
      : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn: fn as typeof fetch, calls };
}

function opts(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  return {
    credentials,
    upstreamUrl,
    signingRegion: "us-east-1",
    targetRegion: "ap-northeast-1",
    fetch: fetchFn,
    ...extra,
  };
}

const rpc = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}';

describe("proxyToAwsMcp", () => {
  it("固定の上流 URL へ SigV4 署名つきで POST し、AWS_REGION を注入する", async () => {
    const { fn, calls } = fakeFetch();
    const req = new Request("https://bridge.example.com/some/path?q=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc,
    });
    const res = await proxyToAwsMcp(req, opts(fn));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const c = calls[0] as Captured;
    expect(c.url).toBe(upstreamUrl);
    expect(c.method).toBe("POST");
    expect(c.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/aws-mcp\/aws4_request, /,
    );
    expect(c.headers.get("x-amz-security-token")).toBe("session-token-example");
    expect(parse(c.body).params._meta.AWS_REGION).toBe("ap-northeast-1");
    expect(c.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(c.headers.get("content-type")).toBe("application/json");
  });

  it("署名は aws4fetch で同じ時刻・本文から再計算した値と一致する", async () => {
    const { fn, calls } = fakeFetch();
    await proxyToAwsMcp(
      new Request("https://bridge.example.com/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc,
      }),
      opts(fn),
    );
    const c = calls[0] as Captured;
    const amzDate = c.headers.get("x-amz-date") as string;
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    const signedHeaders =
      /SignedHeaders=([^,]+)/.exec(c.headers.get("authorization") ?? "")?.[1]?.split(";") ?? [];
    // 署名対象ヘッダーのうち、署名時に aws4fetch が加えない値だけを再現する
    const inHeaders: Record<string, string> = {};
    for (const h of signedHeaders) {
      if (["host", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"].includes(h))
        continue;
      inHeaders[h] = c.headers.get(h) as string;
    }
    const client = new AwsClient({ ...credentials, service: "aws-mcp", region: "us-east-1" });
    const signed = await client.sign(upstreamUrl, {
      method: "POST",
      headers: { ...inHeaders, "x-amz-date": amzDate },
      body: c.body,
    });
    expect(signed.headers.get("authorization")).toBe(c.headers.get("authorization"));
  });

  it("許可リスト外のヘッダーは転送せず、元の authorization も送らない", async () => {
    const { fn, calls } = fakeFetch();
    const req = new Request("https://bridge.example.com/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=secret",
        authorization: "Bearer client-token",
        "cf-access-jwt-assertion": "eyJ.jwt",
        "cf-connecting-ip": "203.0.113.1",
        "x-forwarded-for": "203.0.113.1",
        "x-custom": "v",
        "mcp-session-id": "sess-1",
        "mcp-protocol-version": "2025-06-18",
        "last-event-id": "42",
      },
      body: rpc,
    });
    await proxyToAwsMcp(req, opts(fn));
    const h = (calls[0] as Captured).headers;
    for (const name of [
      "cookie",
      "cf-access-jwt-assertion",
      "cf-connecting-ip",
      "x-forwarded-for",
      "x-custom",
    ]) {
      expect(h.get(name), name).toBeNull();
    }
    expect(h.get("authorization")).not.toContain("client-token");
    expect(h.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(h.get("mcp-session-id")).toBe("sess-1");
    expect(h.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(h.get("last-event-id")).toBe("42");
  });

  it("GET を中継する(本文なし、accept は SSE を含む)", async () => {
    const { fn, calls } = fakeFetch();
    await proxyToAwsMcp(
      new Request("https://bridge.example.com/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-session-id": "s" },
      }),
      opts(fn),
    );
    const c = calls[0] as Captured;
    expect(c.method).toBe("GET");
    expect(c.url).toBe(upstreamUrl);
    expect(c.body).toBe("");
    expect(c.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(c.headers.get("mcp-session-id")).toBe("s");
    expect(c.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
  });

  it("DELETE を中継する", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const res = await proxyToAwsMcp(
      new Request("https://bridge.example.com/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "s" },
      }),
      opts(fn),
    );
    expect(res.status).toBe(204);
    expect((calls[0] as Captured).method).toBe("DELETE");
  });

  it("PUT などは 405 で上流を呼ばない", async () => {
    const { fn, calls } = fakeFetch();
    for (const method of ["PUT", "PATCH"]) {
      const res = await proxyToAwsMcp(
        new Request("https://bridge.example.com/", { method, body: "x" }),
        opts(fn),
      );
      expect(res.status).toBe(405);
    }
    expect(calls).toHaveLength(0);
  });

  it("上流の fetch が例外なら 502 で詳細を返さない", async () => {
    const fn = (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1 secret-detail");
    }) as typeof fetch;
    const res = await proxyToAwsMcp(
      new Request("https://bridge.example.com/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc,
      }),
      opts(fn),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("secret-detail");
  });

  it("SSE 応答をバッファせずストリームのまま返し、set-cookie と hop-by-hop は落とす", async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode("data: one\n\n"));
        await gate;
        controller.enqueue(enc.encode("data: two\n\n"));
        controller.close();
      },
    });
    const { fn } = fakeFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "a=b",
            connection: "keep-alive",
            "keep-alive": "timeout=5",
            "transfer-encoding": "chunked",
            "mcp-session-id": "sess-9",
          },
        }),
    );
    const res = await proxyToAwsMcp(
      new Request("https://bridge.example.com/", { method: "GET" }),
      opts(fn),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBe("sess-9");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("keep-alive")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // gate を開く前に最初のチャンクが読める = バッファされていない
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("data: two\n\n");
  });

  it("上流のエラーステータスも中継する", async () => {
    const { fn } = fakeFetch(() => new Response("denied", { status: 403 }));
    const res = await proxyToAwsMcp(
      new Request("https://bridge.example.com/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc,
      }),
      opts(fn),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("denied");
  });
});

describe("proxyToAwsMcp の堅牢化", () => {
  afterEach(() => vi.restoreAllMocks());

  const post = () =>
    new Request("https://bridge.example.com/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc,
    });

  it("上流 fetch は redirect: manual で呼ぶ", async () => {
    let redirect: string | undefined;
    const fn = (async (input: RequestInfo | URL) => {
      redirect = (input as Request).redirect;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await proxyToAwsMcp(post(), opts(fn));
    expect(redirect).toBe("manual");
  });

  it("fetch 失敗は proxy: fetch_failed だけをログし、詳細・URL・認証情報は出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = (async () => {
      throw new Error("connect ECONNREFUSED secret-detail");
    }) as typeof fetch;
    const res = await proxyToAwsMcp(post(), opts(fn));
    expect(res.status).toBe(502);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("proxy: fetch_failed");
  });

  it("署名失敗は proxy: sign_failed をログし 502（fetch は呼ばない）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fn, calls } = fakeFetch();
    const res = await proxyToAwsMcp(
      post(),
      opts(fn, { credentials: { ...credentials, accessKeyId: undefined } }),
    );
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("proxy: sign_failed");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(credentials.secretAccessKey);
  });
});
