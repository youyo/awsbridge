import {
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Env } from "../../src/handler";
import { publicJwks } from "../../src/oidc";
import { createCredentialCache } from "../../src/sts";
import { newPrivateJwk } from "./helpers";

const ISSUER = "https://awsbridge.example.workers.dev";
const TEAM = "https://team.example.cloudflareaccess.com";
const AUD = "aud-tag-example";
const ROLE = "arn:aws:iam::111111111111:role/awsbridge";
const ROLE_PROD = "arn:aws:iam::222222222222:role/awsbridge";
const PROFILES = {
  default: "dev",
  profiles: { dev: { roleArn: ROLE }, prod: { roleArn: ROLE_PROD } },
  tools: ["call_aws"],
};
const STS = "https://sts.test.example/";
const MCP = "https://mcp.test.example/mcp";

const creds = (
  exp = new Date(Date.now() + 3600_000),
) => `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
<Credentials><AccessKeyId>ASIAEXAMPLE</AccessKeyId><SecretAccessKey>SECRETKEY</SecretAccessKey><SessionToken>SESSIONTOKEN</SessionToken><Expiration>${exp.toISOString()}</Expiration></Credentials>
<AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/awsbridge/gw-x</Arn><AssumedRoleId>AROA:gw-x</AssumedRoleId></AssumedRoleUser>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
const stsError = (code: string) =>
  `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>SECRET-AWS-DETAIL</Message></Error></ErrorResponse>`;

let signingJwk: JWK;
let accessKey: CryptoKey;
let accessJwks: ReturnType<typeof createLocalJWKSet>;

async function accessJwt(
  claims: Record<string, unknown> = { email: "user@example.com" },
  key: CryptoKey = accessKey,
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM)
    .setAudience([AUD])
    .setSubject("access-sub")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

beforeEach(async () => {
  signingJwk = await newPrivateJwk();
  const kp = await generateKeyPair("RS256", { extractable: true });
  accessKey = kp.privateKey;
  accessJwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" }],
  });
});

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    ISSUER,
    SIGNING_JWK: JSON.stringify(signingJwk),
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    AWS_PROFILES: PROFILES,
    STS_ENDPOINT: STS,
    AWS_MCP_ENDPOINT: MCP,
    ...over,
  };
}

type Call = { url: string; init: RequestInit | undefined; request?: Request };

function makeDeps(stsResponse: () => Response = () => new Response(creds())) {
  const calls: Call[] = [];
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    calls.push({ url, init, ...(request ? { request } : {}) });
    if (url.startsWith(STS)) return stsResponse();
    if (url === MCP) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  const handler = createHandler({
    fetch: fakeFetch,
    getKey: accessJwks,
    cache: createCredentialCache(),
  });
  return { handler, calls };
}

async function mcpRequest(path = "/mcp", init: RequestInit = {}, token?: string | null) {
  const t = token === undefined ? await accessJwt() : token;
  const headers = new Headers(init.headers);
  if (t) headers.set("Cf-Access-Jwt-Assertion", t);
  if (!headers.has("content-type") && init.method !== "GET")
    headers.set("content-type", "application/json");
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ...init,
    headers,
  });
}

const roleOf = (c: Call | undefined) => new URLSearchParams(String(c?.init?.body)).get("RoleArn");
const stsCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith(STS));
const mcpCalls = (calls: Call[]) => calls.filter((c) => c.url === MCP);

describe("/mcp 成功経路", () => {
  it("大文字混じりの email は小文字化して STS 向け JWT の sub とセッション名に使う", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(
      await mcpRequest("/mcp", {}, await accessJwt({ email: "User@Example.COM" })),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const form = new URLSearchParams(String(stsCalls(calls)[0]?.init?.body));
    expect(form.get("RoleSessionName")).toBe("gw-user@example.com-dev");
    expect(decodeJwt(form.get("WebIdentityToken") as string).sub).toBe("user@example.com");
  });

  it("ADDITIONAL_PUBLIC_JWKS があっても、STS 向け JWT の署名は SIGNING_JWK のまま", async () => {
    const extra = await newPrivateJwk();
    const { handler, calls } = makeDeps();
    const res = await handler(
      await mcpRequest(),
      makeEnv({ ADDITIONAL_PUBLIC_JWKS: JSON.stringify([extra]) }),
    );
    expect(res.status).toBe(200);
    const form = new URLSearchParams(String(stsCalls(calls)[0]?.init?.body));
    const token = form.get("WebIdentityToken") as string;
    const header = JSON.parse(Buffer.from(token.split(".")[0] as string, "base64url").toString());
    expect(header.kid).toBe((await publicJwks(signingJwk)).keys[0]?.kid);
    // 現行鍵だけの JWKS で検証できる（追加鍵では署名していない）
    await jwtVerify(token, createLocalJWKSet(await publicJwks(signingJwk)), { issuer: ISSUER });
  });

  it("Access JWT 検証 → Worker JWT 発行 → STS → SigV4 中継", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await mcpRequest(), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    const sts = stsCalls(calls);
    expect(sts).toHaveLength(1);
    const form = new URLSearchParams(String(sts[0]?.init?.body));
    expect(form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(form.get("RoleArn")).toBe(ROLE);
    expect(form.get("RoleSessionName")).toBe("gw-user@example.com-dev");
    const token = form.get("WebIdentityToken") as string;
    const { payload } = await jwtVerify(token, createLocalJWKSet(await publicJwks(signingJwk)), {
      issuer: ISSUER,
      audience: "awsbridge",
    });
    expect(payload.sub).toBe("user@example.com");
    expect(decodeJwt(token).email).toBe("user@example.com");

    const up = mcpCalls(calls);
    expect(up).toHaveLength(1);
    const sent = up[0]?.request as Request;
    expect(sent.headers.get("authorization")).toContain("Credential=ASIAEXAMPLE/");
    expect(sent.headers.get("authorization")).toContain("/us-east-1/aws-mcp/aws4_request");
    expect(sent.headers.get("x-amz-security-token")).toBe("SESSIONTOKEN");
    expect(sent.headers.get("cf-access-jwt-assertion")).toBeNull();
    const body = JSON.parse(await sent.text());
    expect(body.params._meta.AWS_REGION).toBe("ap-northeast-1");
  });

  it("設定で STS_AUDIENCE / STS_REGION / リージョンを上書きできる", async () => {
    const { handler, calls } = makeDeps();
    const env = makeEnv({
      STS_AUDIENCE: "custom-aud",
      AWS_MCP_REGION: "eu-west-1",
      TARGET_AWS_REGION: "us-west-2",
    });
    delete env.AWS_MCP_ENDPOINT;
    // 既定エンドポイントの導出は URL で確認する
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init, ...(input instanceof Request ? { request: input } : {}) });
      if (url.startsWith(STS)) return new Response(creds());
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const h = createHandler({
      fetch: fetchSpy,
      getKey: accessJwks,
      cache: createCredentialCache(),
    });
    const res = await h(await mcpRequest(), env);
    expect(res.status).toBe(200);
    void handler;
    const form = new URLSearchParams(String(stsCalls(calls)[0]?.init?.body));
    expect(decodeJwt(form.get("WebIdentityToken") as string).aud).toBe("custom-aud");
    const up = calls.find((c) => c.url === "https://aws-mcp.eu-west-1.api.aws/mcp");
    expect(up).toBeDefined();
    expect(up?.request?.headers.get("authorization")).toContain("/eu-west-1/aws-mcp/");
    expect(JSON.parse((await up?.request?.text()) as string).params._meta.AWS_REGION).toBe(
      "us-west-2",
    );
  });

  it("IDENTITY_CLAIM=sub を使える", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await mcpRequest(), makeEnv({ IDENTITY_CLAIM: "sub" }));
    expect(res.status).toBe(200);
    const form = new URLSearchParams(String(stsCalls(calls)[0]?.init?.body));
    expect(decodeJwt(form.get("WebIdentityToken") as string).sub).toBe("access-sub");
  });

  it("GET / DELETE も中継される", async () => {
    const { handler, calls } = makeDeps();
    for (const method of ["GET", "DELETE"]) {
      const res = await handler(await mcpRequest("/mcp", { method, body: null }), makeEnv());
      expect(res.status, method).toBe(200);
    }
    expect(mcpCalls(calls).map((c) => c.request?.method)).toEqual(["GET", "DELETE"]);
  });

  it("その他メソッドは 405", async () => {
    const { handler } = makeDeps();
    const res = await handler(await mcpRequest("/mcp", { method: "PUT" }), makeEnv());
    expect(res.status).toBe(405);
  });
});

describe("認証情報キャッシュ", () => {
  it("同じ利用者の 2 回目は STS を呼ばない", async () => {
    const { handler, calls } = makeDeps();
    await handler(await mcpRequest(), makeEnv());
    await handler(await mcpRequest(), makeEnv());
    expect(stsCalls(calls)).toHaveLength(1);
    expect(mcpCalls(calls)).toHaveLength(2);
  });

  it("別の利用者は別に STS を呼ぶ", async () => {
    const { handler, calls } = makeDeps();
    await handler(await mcpRequest(), makeEnv());
    await handler(
      await mcpRequest("/mcp", {}, await accessJwt({ email: "other@example.com" })),
      makeEnv(),
    );
    expect(stsCalls(calls)).toHaveLength(2);
  });
});

describe("エラー応答", () => {
  const SECRETS = ["SECRET-AWS-DETAIL", "SIGNING", "SESSIONTOKEN", "SECRETKEY"];

  async function expectError(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: code });
    for (const s of SECRETS) expect(text).not.toContain(s);
  }

  it("Access ヘッダー無しは 401 unauthorized", async () => {
    const { handler, calls } = makeDeps();
    await expectError(
      await handler(await mcpRequest("/mcp", {}, null), makeEnv()),
      401,
      "unauthorized",
    );
    expect(calls).toHaveLength(0);
  });

  it("別鍵で署名された Access JWT は 401", async () => {
    const { handler, calls } = makeDeps();
    const other = await generateKeyPair("RS256");
    const tok = await accessJwt({ email: "user@example.com" }, other.privateKey);
    await expectError(
      await handler(await mcpRequest("/mcp", {}, tok), makeEnv()),
      401,
      "unauthorized",
    );
    expect(calls).toHaveLength(0);
  });

  it("期限切れは 401", async () => {
    const { handler } = makeDeps();
    const tok = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM)
      .setAudience([AUD])
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(accessKey);
    await expectError(
      await handler(await mcpRequest("/mcp", {}, tok), makeEnv()),
      401,
      "unauthorized",
    );
  });

  it("ACCESS_MAX_TOKEN_AGE_SECONDS を超えた古いトークンは 401", async () => {
    const { handler } = makeDeps();
    const tok = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM)
      .setAudience([AUD])
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime("1h")
      .sign(accessKey);
    const env = makeEnv({ ACCESS_MAX_TOKEN_AGE_SECONDS: "60" });
    await expectError(await handler(await mcpRequest("/mcp", {}, tok), env), 401, "unauthorized");
  });

  it("利用者識別子 claim が無ければ 403 forbidden", async () => {
    const { handler } = makeDeps();
    const tok = await accessJwt({ name: "no email" });
    await expectError(
      await handler(await mcpRequest("/mcp", {}, tok), makeEnv()),
      403,
      "forbidden",
    );
  });

  it("STS AccessDenied は 403 forbidden", async () => {
    const { handler } = makeDeps(() => new Response(stsError("AccessDenied"), { status: 403 }));
    await expectError(await handler(await mcpRequest(), makeEnv()), 403, "forbidden");
  });

  it("STS InvalidIdentityToken は 502 upstream_auth_failed", async () => {
    const { handler } = makeDeps(
      () => new Response(stsError("InvalidIdentityToken"), { status: 400 }),
    );
    await expectError(await handler(await mcpRequest(), makeEnv()), 502, "upstream_auth_failed");
  });

  it("STS 5xx は 503 temporarily_unavailable", async () => {
    const { handler } = makeDeps(
      () => new Response(stsError("ServiceUnavailable"), { status: 503 }),
    );
    await expectError(await handler(await mcpRequest(), makeEnv()), 503, "temporarily_unavailable");
  });

  it("エラー時は失敗をキャッシュしない", async () => {
    let deny = true;
    const { handler, calls } = makeDeps(() =>
      deny ? new Response(stsError("AccessDenied"), { status: 403 }) : new Response(creds()),
    );
    expect((await handler(await mcpRequest(), makeEnv())).status).toBe(403);
    deny = false;
    expect((await handler(await mcpRequest(), makeEnv())).status).toBe(200);
    expect(stsCalls(calls)).toHaveLength(2);
  });

  for (const missing of [
    "ISSUER",
    "SIGNING_JWK",
    "ACCESS_TEAM_DOMAIN",
    "ACCESS_AUD",
    "AWS_PROFILES",
  ] as const) {
    it(`${missing} 欠落は 500 server_misconfigured（どれかは返さない）`, async () => {
      const { handler, calls } = makeDeps();
      const env = makeEnv();
      delete env[missing];
      const res = await handler(await mcpRequest(), env);
      await expectError(res, 500, "server_misconfigured");
      expect(calls).toHaveLength(0);
    });
  }

  it("ログに トークン・認証情報・STS 本文を出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = makeDeps(() => new Response(stsError("AccessDenied"), { status: 403 }));
    const tok = await accessJwt();
    await handler(await mcpRequest("/mcp", {}, tok), makeEnv());
    await handler(await mcpRequest("/mcp", {}, "garbage.token.value"), makeEnv());
    const logged = JSON.stringify(spy.mock.calls);
    expect(spy).toHaveBeenCalled();
    expect(logged).not.toContain(tok);
    expect(logged).not.toContain("garbage.token.value");
    expect(logged).not.toContain("SECRET-AWS-DETAIL");
    expect(logged).not.toContain("SECRETKEY");
    spy.mockRestore();
  });
});

describe("ルーティング", () => {
  it("未知パスは 404", async () => {
    const { handler } = makeDeps();
    for (const p of ["/", "/mcp/", "/mcp/x", "/oauth/token"]) {
      const res = await handler(await mcpRequest(p), makeEnv());
      expect(res.status, p).toBe(404);
    }
  });

  it("/.well-known/* は Access ヘッダー無し・他設定無しでも 200", async () => {
    const { handler, calls } = makeDeps();
    const env = { ISSUER, SIGNING_JWK: JSON.stringify(signingJwk) } as Env;
    for (const p of ["/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
      const res = await handler(new Request(`${ISSUER}${p}`), env);
      expect(res.status, p).toBe(200);
    }
    expect(calls).toHaveLength(0);
  });
});

// ---- マルチアカウント（aws_profile） ----

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error: code });
}

const toolCall = (args?: Record<string, unknown>, name = "call_aws", method = "tools/call") => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: { name, ...(args ? { arguments: args } : {}) },
});

const post = async (body: unknown, token?: string | null) =>
  mcpRequest("/mcp", { body: typeof body === "string" ? body : JSON.stringify(body) }, token);

const sentBody = async (calls: Call[]) =>
  JSON.parse((await mcpCalls(calls)[0]?.request?.text()) ?? "null");

describe("aws_profile によるアカウント切り替え", () => {
  it("aws_profile 指定なしは default のロールで、sessionName に -<profile> が付く", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await post(toolCall({ cli_command: "x" })), makeEnv());
    expect(res.status).toBe(200);
    expect(roleOf(stsCalls(calls)[0])).toBe(ROLE);
    const form = new URLSearchParams(String(stsCalls(calls)[0]?.init?.body));
    expect(form.get("RoleSessionName")).toBe("gw-user@example.com-dev");
  });

  it("aws_profile で選んだロールを直接 AssumeRoleWithWebIdentity し、上流本文から消える", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(
      await post(toolCall({ cli_command: "x", aws_profile: "prod" })),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(roleOf(stsCalls(calls)[0])).toBe(ROLE_PROD);
    expect(new URLSearchParams(String(stsCalls(calls)[0]?.init?.body)).get("RoleSessionName")).toBe(
      "gw-user@example.com-prod",
    );
    const sent = await sentBody(calls);
    expect(JSON.stringify(sent)).not.toContain("aws_profile");
    expect(sent.params.arguments).toEqual({ cli_command: "x" });
    expect(sent.params._meta.AWS_REGION).toBe("ap-northeast-1");
  });

  it("_meta.AWS_REGION の注入と併用できる（TARGET_AWS_REGION・既存 _meta を尊重）", async () => {
    const { handler, calls } = makeDeps();
    const body = toolCall({ aws_profile: "prod" });
    (body.params as Record<string, unknown>)._meta = { other: 1 };
    await handler(await post(body), makeEnv({ TARGET_AWS_REGION: "us-west-2" }));
    const sent = await sentBody(calls);
    expect(sent.params._meta).toEqual({ other: 1, AWS_REGION: "us-west-2" });
  });

  it("未知の aws_profile は 200 + isError の JSON-RPC 結果で、コード・使える一覧・既定を含む（STS・上流を呼ばない）", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await post(toolCall({ aws_profile: "nope" })), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      jsonrpc: string;
      id: unknown;
      result: { isError: boolean; content: { type: string; text: string }[] };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0]?.text ?? "";
    expect(body.result.content[0]?.type).toBe("text");
    expect(text).toContain("unknown_aws_profile");
    expect(text).toContain("dev");
    expect(text).toContain("prod");
    expect(text).not.toContain("111111111111");
    expect(text).not.toContain("arn:aws");
    expect(calls).toHaveLength(0);
  });

  it("文字列以外は 200 + isError（invalid_aws_profile）", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await post(toolCall({ aws_profile: 1 })), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("invalid_aws_profile");
    expect(body.result.content[0]?.text).toContain("prod");
    expect(calls).toHaveLength(0);
  });

  it("バッチ中の未知の aws_profile は従来どおり 400 {error}", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(
      await post([toolCall({ aws_profile: "nope" }), toolCall({ aws_profile: "dev" })]),
      makeEnv(),
    );
    await expectError(res, 400, "unknown_aws_profile");
    expect(calls).toHaveLength(0);
  });

  it("対象外ツールは default。aws_profile は検証せず取り除く", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(
      await post(toolCall({ aws_profile: "nope" }, "other_tool")),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(roleOf(stsCalls(calls)[0])).toBe(ROLE);
    expect(JSON.stringify(await sentBody(calls))).not.toContain("aws_profile");
  });

  it("tools/call 以外（tools/list・initialize・ping・notifications）は default", async () => {
    for (const method of ["tools/list", "initialize", "ping", "notifications/initialized"]) {
      const { handler, calls } = makeDeps();
      const res = await handler(await post({ jsonrpc: "2.0", id: 1, method }), makeEnv());
      expect(res.status, method).toBe(200);
      expect(roleOf(stsCalls(calls)[0]), method).toBe(ROLE);
    }
  });

  it("GET / DELETE は default", async () => {
    for (const method of ["GET", "DELETE"]) {
      const { handler, calls } = makeDeps();
      const res = await handler(await mcpRequest("/mcp", { method, body: null }), makeEnv());
      expect(res.status, method).toBe(200);
      expect(roleOf(stsCalls(calls)[0]), method).toBe(ROLE);
    }
  });

  it("バッチ: プロファイルがそろっていればそのロール、混在は 400 batch_not_supported", async () => {
    const ok = makeDeps();
    const res = await ok.handler(
      await post([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        toolCall({ aws_profile: "prod" }),
        toolCall({ aws_profile: "prod" }),
      ]),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(roleOf(stsCalls(ok.calls)[0])).toBe(ROLE_PROD);
    const sent = await sentBody(ok.calls);
    expect(Array.isArray(sent)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("aws_profile");

    const ng = makeDeps();
    const res2 = await ng.handler(
      await post([toolCall({ aws_profile: "prod" }), toolCall({})]),
      makeEnv(),
    );
    await expectError(res2, 400, "batch_not_supported");
    expect(ng.calls).toHaveLength(0);
  });

  it("本文が JSON でなくても Content-Type が JSON なら default で原文を中継（パース不能は fail-safe）", async () => {
    const a = makeDeps();
    expect((await a.handler(await post("not json"), makeEnv())).status).toBe(200);
    expect(roleOf(stsCalls(a.calls)[0])).toBe(ROLE);
    expect(await mcpCalls(a.calls)[0]?.request?.text()).toBe("not json");
  });

  it("認証情報キャッシュはプロファイルのロールごとに分かれる", async () => {
    const { handler, calls } = makeDeps();
    const env = makeEnv();
    await handler(await post(toolCall({ aws_profile: "dev" })), env);
    await handler(await post(toolCall({ aws_profile: "prod" })), env);
    expect(stsCalls(calls)).toHaveLength(2);
    await handler(await post(toolCall({ aws_profile: "prod" })), env);
    await handler(await post(toolCall({})), env);
    expect(stsCalls(calls)).toHaveLength(2);
  });

  it("STS が AccessDenied なら 403 forbidden（許可の判定は AWS 側）", async () => {
    const { handler } = makeDeps(() => new Response(stsError("AccessDenied"), { status: 403 }));
    const res = await handler(await post(toolCall({ aws_profile: "prod" })), makeEnv());
    await expectError(res, 403, "forbidden");
  });

  it("AWS_PROFILES を JSON 文字列（secret）で渡しても動く", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(
      await post(toolCall({ aws_profile: "prod" })),
      makeEnv({ AWS_PROFILES: JSON.stringify(PROFILES) }),
    );
    expect(res.status).toBe(200);
    expect(roleOf(stsCalls(calls)[0])).toBe(ROLE_PROD);
  });

  it("profiles を配列形式で渡しても aws_profile で選べる", async () => {
    const { handler, calls } = makeDeps();
    const env = makeEnv({
      AWS_PROFILES: {
        default: "dev",
        profiles: [
          { name: "dev", roleArn: ROLE },
          { name: "prod", roleArn: ROLE_PROD },
        ],
      } as never,
    });
    const res = await handler(await post(toolCall({ aws_profile: "prod" })), env);
    expect(res.status).toBe(200);
    expect(roleOf(stsCalls(calls)[0])).toBe(ROLE_PROD);
  });

  it("32 文字のプロファイル名でも sessionName は 64 文字以内で -<name> で終わる", async () => {
    const name = "n".repeat(32);
    const { handler, calls } = makeDeps();
    const env = makeEnv({
      AWS_PROFILES: { default: name, profiles: { [name]: { roleArn: ROLE } } } as never,
    });
    const res = await handler(await post(toolCall({ cli_command: "x" })), env);
    expect(res.status).toBe(200);
    const sn = new URLSearchParams(String(stsCalls(calls)[0]?.init?.body)).get("RoleSessionName");
    expect(sn?.length).toBeLessThanOrEqual(64);
    expect(sn?.endsWith(`-${name}`)).toBe(true);
  });

  it("tools/call の name が文字列でなくても aws_profile は上流へ送らない（default 扱い）", async () => {
    const bodies = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: 123, arguments: { aws_profile: "prod" } },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: { aws_profile: "prod" } },
      },
    ];
    for (const b of bodies) {
      const { handler, calls } = makeDeps();
      const res = await handler(await post(b), makeEnv());
      expect(res.status).toBe(200);
      expect(roleOf(stsCalls(calls)[0])).toBe(ROLE);
      expect(JSON.stringify(await sentBody(calls))).not.toContain("aws_profile");
    }
  });

  it("不正な AWS_PROFILES は 500 server_misconfigured（設定値をログに出さない）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad: unknown[] = [
      "{not json",
      { default: "dev", profiles: {} },
      { default: "x", profiles: { dev: { roleArn: ROLE } } },
      { default: "dev", profiles: { dev: { roleArn: "SECRET-ARN" } } },
      { default: "dev", profiles: { dev: { roleArn: ROLE } }, tools: [] },
      {
        default: "dev",
        profiles: [
          { name: "dev", roleArn: ROLE },
          { name: "dev", roleArn: ROLE },
        ],
      },
      { default: "n".repeat(33), profiles: { ["n".repeat(33)]: { roleArn: ROLE } } },
    ];
    for (const v of bad) {
      const { handler, calls } = makeDeps();
      const res = await handler(await post(toolCall()), makeEnv({ AWS_PROFILES: v as never }));
      await expectError(res, 500, "server_misconfigured");
      expect(calls).toHaveLength(0);
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-ARN");
    expect(JSON.stringify(spy.mock.calls)).toContain("invalid AWS_PROFILES");
    spy.mockRestore();
  });
});

describe("/mcp tools/list への aws_profile 注入", () => {
  it("Worker 経由の tools/list 応答に enum なしの aws_profile と list_aws_profiles が入り、上流へは accept: application/json", async () => {
    const calls: Request[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.startsWith(STS)) return new Response(creds());
      calls.push(request);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [{ name: "call_aws", inputSchema: { type: "object" } }, { name: "other" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const handler = createHandler({
      fetch: fakeFetch,
      getKey: accessJwks,
      cache: createCredentialCache(),
    });
    const res = await handler(await mcpRequest(), makeEnv());
    expect(res.status).toBe(200);
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
    const body = (await res.json()) as { result: { tools: { inputSchema?: any }[] } };
    expect(body.result.tools[0]?.inputSchema.properties.aws_profile.type).toBe("string");
    expect(body.result.tools[0]?.inputSchema.properties.aws_profile.enum).toBeUndefined();
    // PROFILES.tools = ["call_aws"] なので other には入らない
    expect(body.result.tools[1]?.inputSchema).toBeUndefined();
    expect((body.result.tools as { name: string }[]).map((t) => t.name)).toContain(
      "list_aws_profiles",
    );
  });
});

describe("/mcp list_aws_profiles（Worker が応答）", () => {
  const listCall = (id: unknown = 7, args?: unknown) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "list_aws_profiles", ...(args !== undefined ? { arguments: args } : {}) },
  });
  const env = () =>
    makeEnv({
      AWS_PROFILES: {
        default: "dev-readonly",
        profiles: [
          { name: "prod-readonly", roleArn: ROLE_PROD, description: "本番" },
          { name: "dev-readonly", roleArn: ROLE },
          { name: "dev-debug", roleArn: ROLE, description: "デバッグ" },
        ],
      } as never,
    });

  it("認証後に Worker が応答する。default 先頭・description 付き・roleArn なし・STS/上流は呼ばない", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await post(listCall(7, {})), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.text();
    expect(raw).not.toContain("arn:aws");
    expect(raw).not.toContain("111111111111");
    expect(raw).not.toContain("222222222222");
    const body = JSON.parse(raw);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(7);
    const payload = {
      default: "dev-readonly",
      profiles: [
        { name: "dev-readonly" },
        { name: "prod-readonly", description: "本番" },
        { name: "dev-debug", description: "デバッグ" },
      ],
    };
    expect(body.result.structuredContent).toEqual(payload);
    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0]?.type).toBe("text");
    expect(JSON.parse(body.result.content[0]?.text)).toEqual(payload);
    expect(calls).toHaveLength(0);
  });

  it("未認証なら 401（列挙させない）", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await post(listCall(), null), env());
    await expectError(res, 401, "unauthorized");
    expect(calls).toHaveLength(0);
  });

  it("list_aws_profiles を含むバッチは 400 batch_not_supported", async () => {
    const { handler, calls } = makeDeps();
    const res = await handler(await post([listCall(1), toolCall({})]), env());
    await expectError(res, 400, "batch_not_supported");
    expect(calls).toHaveLength(0);
  });
});

describe("/mcp の CSRF 対策（Origin 検査と Content-Type 制限）", () => {
  const body = JSON.stringify(toolCall({ aws_profile: "prod" }));
  const noUpstream = (calls: Call[]) => expect(calls).toHaveLength(0);

  it("許可リストに無い Origin は全メソッドで 403 forbidden_origin（STS も呼ばない）", async () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      const { handler, calls } = makeDeps();
      const init: RequestInit = { method, headers: { origin: "https://evil.example" } };
      init.body = method === "POST" ? body : null;
      const res = await handler(await mcpRequest("/mcp", init), makeEnv());
      await expectError(res, 403, "forbidden_origin");
      noUpstream(calls);
    }
  });

  it("ALLOWED_ORIGINS に完全一致する Origin は通る（カンマ区切り・前後の空白は無視）", async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    for (const origin of ["https://a.example", "https://b.example"]) {
      const { handler } = makeDeps();
      const req = await mcpRequest("/mcp", { body, headers: { origin } });
      expect((await handler(req, env)).status).toBe(200);
    }
  });

  it("Origin の部分一致・大文字違い・末尾スラッシュ違いは拒否する", async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "https://a.example" });
    for (const origin of [
      "https://a.example/",
      "https://a.example.evil.example",
      "http://a.example",
      "https://A.example",
      "null",
    ]) {
      const { handler, calls } = makeDeps();
      const req = await mcpRequest("/mcp", { body, headers: { origin } });
      await expectError(await handler(req, env), 403, "forbidden_origin");
      noUpstream(calls);
    }
  });

  it("Origin が無ければ通る（MCP クライアント・Portal のサーバー間通信）", async () => {
    const { handler } = makeDeps();
    expect((await handler(await mcpRequest("/mcp", { body }), makeEnv())).status).toBe(200);
  });

  it("Origin 検査は Access JWT の検証より前（不正な Origin はトークン無しでも 403）", async () => {
    const { handler } = makeDeps();
    const req = await mcpRequest("/mcp", { headers: { origin: "https://evil.example" } }, null);
    await expectError(await handler(req, makeEnv()), 403, "forbidden_origin");
  });

  it("POST の Content-Type が無い・application/json 以外は 415（STS も呼ばない）", async () => {
    for (const ct of [
      null,
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/jsonx",
    ]) {
      const { handler, calls } = makeDeps();
      const req = await mcpRequest("/mcp", { body });
      if (ct === null) req.headers.delete("content-type");
      else req.headers.set("content-type", ct);
      const res = await handler(req, makeEnv());
      await expectError(res, 415, "unsupported_media_type");
      noUpstream(calls);
    }
  });

  it("application/json はパラメータ付き・大文字小文字違いでも通る", async () => {
    for (const ct of [
      "application/json; charset=utf-8",
      "Application/JSON",
      "application/json;charset=UTF-8",
    ]) {
      const { handler } = makeDeps();
      const req = await mcpRequest("/mcp", { body, headers: { "content-type": ct } });
      expect((await handler(req, makeEnv())).status).toBe(200);
    }
  });

  it("GET / DELETE は Content-Type が無くても通る", async () => {
    for (const method of ["GET", "DELETE"]) {
      const { handler } = makeDeps();
      const res = await handler(await mcpRequest("/mcp", { method, body: null }), makeEnv());
      expect(res.status).toBe(200);
    }
  });
});
