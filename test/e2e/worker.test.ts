import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signStsToken } from "../../src/oidc";

let proc: ChildProcess | undefined;
let tmp = "";
let base = "";
let privateJwk: Awaited<ReturnType<typeof exportJWK>>;
let logs = "";

const ALLOWED_SUB = "user@example.com";
// プロファイルのテスト用（isolate 内キャッシュに当たらないよう、テストごとに別の利用者を使う）
const PROFILE_SUBS = ["p1@example.com", "p2@example.com", "p3@example.com"];
const DENIED_SUB = "denied@example.com";
const ROLE_A = "arn:aws:iam::111111111111:role/awsbridge";
const ROLE_B = "arn:aws:iam::222222222222:role/awsbridge";
const AWS_PROFILES = JSON.stringify({
  default: "a",
  profiles: { a: { roleArn: ROLE_A }, b: { roleArn: ROLE_B, description: "second" } },
  tools: ["call_aws"],
});
const FAKE_CREDS = {
  accessKeyId: "ASIAE2EEXAMPLE",
  secretAccessKey: "e2e-secret-access-key",
  sessionToken: "e2e-session-token",
};
const FAKE_AUD = "e2e-access-aud";

let fake: Server | undefined;
let fakeBase = "";
let accessKeys: Awaited<ReturnType<typeof generateKeyPair>>;
// 擬似 AWS MCP が受け取ったリクエストの記録
type McpSeen = {
  sigv4Ok: boolean;
  sigv4Detail: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};
let mcpSeen: McpSeen[] = [];
let stsCount = 0;
// 擬似 STS が受けた RoleArn の記録
let stsRoles: string[] = [];

const stsXml =
  () => `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult>
<Credentials><AccessKeyId>${FAKE_CREDS.accessKeyId}</AccessKeyId><SecretAccessKey>${FAKE_CREDS.secretAccessKey}</SecretAccessKey><SessionToken>${FAKE_CREDS.sessionToken}</SessionToken><Expiration>${new Date(Date.now() + 3600_000).toISOString()}</Expiration></Credentials>
<AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/awsbridge/e2e</Arn><AssumedRoleId>AROAE2E:e2e</AssumedRoleId></AssumedRoleUser>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;

function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 受け取ったリクエストを、擬似 STS が払い出した認証情報で再署名し authorization が一致するか確認する。
async function verifySigV4(
  req: import("node:http").IncomingMessage,
  body: Buffer,
): Promise<{ ok: boolean; detail: string }> {
  const auth = String(req.headers.authorization ?? "");
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
      auth,
    );
  if (!m) return { ok: false, detail: "bad authorization header" };
  const [, scope, signedHeaders] = m;
  if (scope?.split("/").slice(0, 1)[0] !== FAKE_CREDS.accessKeyId)
    return { ok: false, detail: `access key mismatch: ${scope}` };
  if (!scope?.endsWith("/us-east-1/aws-mcp/aws4_request"))
    return { ok: false, detail: `scope mismatch: ${scope}` };
  if (req.headers["x-amz-security-token"] !== FAKE_CREDS.sessionToken)
    return { ok: false, detail: "security token mismatch" };
  const amzDate = String(req.headers["x-amz-date"]);
  const headers = new Headers();
  for (const h of (signedHeaders ?? "").split(";")) {
    if (["host", "x-amz-date", "x-amz-security-token"].includes(h)) continue;
    const v = req.headers[h];
    if (v !== undefined) headers.set(h, Array.isArray(v) ? v.join(",") : v);
  }
  const client = new AwsClient({ ...FAKE_CREDS, service: "aws-mcp", region: "us-east-1" });
  const again = await client.sign(`http://${req.headers.host}${req.url}`, {
    method: req.method ?? "POST",
    headers,
    body: req.method === "POST" ? new Uint8Array(body) : null,
    aws: { datetime: amzDate },
  });
  const expected = again.headers.get("authorization");
  return expected === auth
    ? { ok: true, detail: "ok" }
    : { ok: false, detail: "signature mismatch" };
}

async function startFake(): Promise<void> {
  accessKeys = await generateKeyPair("RS256", { extractable: true });
  const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "e2e-k1", alg: "RS256" };
  fake = createHttpServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/cdn-cgi/access/certs") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [accessJwk] }));
        return;
      }
      const body = await readBody(req);
      if (path === "/sts") {
        stsCount++;
        const form = new URLSearchParams(body.toString());
        stsRoles.push(form.get("RoleArn") ?? "");
        try {
          const { payload } = await jwtVerify(
            form.get("WebIdentityToken") ?? "",
            createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`)),
            { issuer: base, audience: "awsbridge" },
          );
          if (payload.sub !== ALLOWED_SUB && !PROFILE_SUBS.includes(String(payload.sub)))
            throw new Error("denied");
          res.setHeader("content-type", "text/xml");
          res.end(stsXml());
        } catch (e) {
          const denied = e instanceof Error && e.message === "denied";
          res.statusCode = denied ? 403 : 400;
          res.setHeader("content-type", "text/xml");
          res.end(
            `<ErrorResponse><Error><Type>Sender</Type><Code>${denied ? "AccessDenied" : "InvalidIdentityToken"}</Code><Message>fake</Message></Error></ErrorResponse>`,
          );
        }
        return;
      }
      if (path === "/aws-mcp") {
        const v = await verifySigV4(req, body);
        mcpSeen.push({
          sigv4Ok: v.ok,
          sigv4Detail: v.detail,
          headers: req.headers,
          body: body.toString(),
        });
        if (!v.ok) {
          res.statusCode = 403;
          res.end(v.detail);
          return;
        }
        res.setHeader("set-cookie", "upstream=must-not-leak; Path=/");
        const rpc = JSON.parse(body.toString() || "{}");
        if (rpc.method === "tools/stream") {
          res.setHeader("content-type", "text/event-stream");
          res.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { sse: true } })}\n\n`,
          );
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { echo: rpc.method, params: rpc.params },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((r) => fake?.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${(fake?.address() as { port: number }).port}`;
}

async function accessJwt(
  sub: string,
  key: CryptoKey | undefined = accessKeys.privateKey,
): Promise<string> {
  return new SignJWT({ email: sub })
    .setProtectedHeader({ alg: "RS256", kid: "e2e-k1" })
    .setIssuer(fakeBase)
    .setAudience([FAKE_AUD, "other-aud"])
    .setSubject("access-user-id")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

// claims / iss / aud / exp を差し替えられる Access JWT（異常系用）
async function customAccessJwt(
  opts: {
    claims?: Record<string, unknown>;
    iss?: string;
    aud?: string;
    exp?: number | string;
  } = {},
): Promise<string> {
  return new SignJWT(opts.claims ?? { email: ALLOWED_SUB })
    .setProtectedHeader({ alg: "RS256", kid: "e2e-k1" })
    .setIssuer(opts.iss ?? fakeBase)
    .setAudience(opts.aud ?? FAKE_AUD)
    .setSubject("access-user-id")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(accessKeys.privateKey);
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function rpc(method: string, token: string | null, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie: "CF_Authorization=cookie-token-must-not-leak",
    ...extra,
  };
  if (token) headers["cf-access-jwt-assertion"] = token;
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: { name: "x" } }),
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready\n${logs}`);
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  privateJwk = await exportJWK(privateKey);
  await startFake();
  tmp = mkdtempSync(join(tmpdir(), "awsbridge-e2e-"));
  const varsFile = join(tmp, "dev.vars");
  writeFileSync(
    varsFile,
    [
      `SIGNING_JWK='${JSON.stringify(privateJwk)}'`,
      `ACCESS_TEAM_DOMAIN='${fakeBase}'`,
      `ACCESS_AUD='${FAKE_AUD}'`,
      `AWS_PROFILES='${AWS_PROFILES}'`,
      "",
    ].join("\n"),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(
    "pnpm",
    [
      "wrangler",
      "dev",
      "--env",
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--var",
      `ISSUER:${base}`,
      "--var",
      `STS_ENDPOINT:${fakeBase}/sts`,
      "--var",
      `AWS_MCP_ENDPOINT:${fakeBase}/aws-mcp`,
      "--env-file",
      varsFile,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  proc.stdout?.on("data", (d) => {
    logs += d;
  });
  proc.stderr?.on("data", (d) => {
    logs += d;
  });
  await waitReady(`${base}/.well-known/jwks.json`);
});

afterAll(() => {
  fake?.closeAllConnections();
  fake?.close();
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        if (proc?.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }, 3000).unref();
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("wrangler dev e2e", () => {
  it("discovery の jwks_uri を辿り、Worker 公開鍵で発行トークンを検証できる", async () => {
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const disc = (await res.json()) as Record<string, unknown>;
    expect(disc.issuer).toBe(base);
    expect(disc.response_types_supported).toEqual(["id_token"]);
    const jwksUri = disc.jwks_uri as string;
    expect(jwksUri).toBe(`${base}/.well-known/jwks.json`);

    const token = await signStsToken({
      privateJwk,
      issuer: base,
      audience: "awsbridge",
      subject: "user@example.com",
    });
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(jwksUri)), {
      issuer: base,
      audience: "awsbridge",
    });
    expect(payload.sub).toBe("user@example.com");
  });

  it("JWKS に秘密成分が含まれない", async () => {
    const text = await (await fetch(`${base}/.well-known/jwks.json`)).text();
    for (const f of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"']) expect(text).not.toContain(f);
  });

  it("未知パスは 404", async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/oauth/token`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/jwks.json`, { method: "POST" })).status).toBe(404);
  });

  it("未知パス・/mcp 以外は 404", async () => {
    expect((await fetch(`${base}/mcp/x`)).status).toBe(404);
  });
});

describe("/mcp 通し（擬似 Access / STS / AWS MCP）", () => {
  it("正常: Worker JWT で STS を通り、SigV4 署名された中継リクエストの応答が返る", async () => {
    mcpSeen = [];
    const res = await rpc("tools/list", await accessJwt(ALLOWED_SUB));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { id: number; result: { echo: string; params: unknown } };
    expect(body.id).toBe(7);
    expect(body.result.echo).toBe("tools/list");

    expect(mcpSeen).toHaveLength(1);
    const seen = mcpSeen[0] as McpSeen;
    expect(seen.sigv4Detail).toBe("ok");
    expect(seen.sigv4Ok).toBe(true);
    expect(seen.headers["cf-access-jwt-assertion"]).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain("cookie-token-must-not-leak");
    expect(
      (JSON.parse(seen.body) as { params: { _meta: { AWS_REGION: string } } }).params._meta
        .AWS_REGION,
    ).toBe("ap-northeast-1");
  });

  it("同じ利用者の 2 回目は STS を呼ばない（isolate 内キャッシュ）", async () => {
    await rpc("tools/list", await accessJwt(ALLOWED_SUB));
    const before = stsCount;
    const res = await rpc("tools/list", await accessJwt(ALLOWED_SUB));
    expect(res.status).toBe(200);
    expect(stsCount).toBe(before);
  });

  it("SSE 応答もそのまま返る", async () => {
    const res = await rpc("tools/stream", await accessJwt(ALLOWED_SUB));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: ");
    expect(JSON.parse(text.split("data: ")[1]?.split("\n")[0] ?? "{}").result.sse).toBe(true);
  });

  it("Access ヘッダー無しは 401", async () => {
    const res = await rpc("tools/list", null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("別鍵で署名された偽造 Access JWT は 401", async () => {
    const other = await generateKeyPair("RS256");
    const res = await rpc("tools/list", await accessJwt(ALLOWED_SUB, other.privateKey));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("許可外の利用者は 403（STS AccessDenied）で、STS の本文を返さない", async () => {
    const res = await rpc("tools/list", await accessJwt(DENIED_SUB));
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "forbidden" });
    expect(text).not.toContain("AccessDenied");
  });

  describe("Access JWT の異常系", () => {
    const expectUnauthorized = async (res: Response) => {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    };

    it("aud 不一致は 401", async () => {
      await expectUnauthorized(await rpc("tools/list", await customAccessJwt({ aud: "wrong" })));
    });

    it("iss 不一致は 401", async () => {
      await expectUnauthorized(
        await rpc("tools/list", await customAccessJwt({ iss: "https://evil.example.com" })),
      );
    });

    it("exp 切れは 401", async () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      await expectUnauthorized(await rpc("tools/list", await customAccessJwt({ exp: past })));
    });

    it("alg: none の偽造は 401", async () => {
      const now = Math.floor(Date.now() / 1000);
      const forged = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
        iss: fakeBase,
        aud: FAKE_AUD,
        email: ALLOWED_SUB,
        iat: now,
        exp: now + 3600,
      })}.`;
      await expectUnauthorized(await rpc("tools/list", forged));
    });

    it("Cookie CF_Authorization だけ（ヘッダー無し）は 401", async () => {
      const valid = await accessJwt(ALLOWED_SUB);
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `CF_Authorization=${valid}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      await expectUnauthorized(res);
    });

    it("email claim が無い（既定の identityClaim=email）は 403", async () => {
      const res = await rpc("tools/list", await customAccessJwt({ claims: { name: "no email" } }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    });
  });

  describe("中継の細部", () => {
    it("GET（SSE 受信）と DELETE が中継され、本文なしで SigV4 検証が通る", async () => {
      for (const method of ["GET", "DELETE"]) {
        mcpSeen = [];
        const res = await fetch(`${base}/mcp`, {
          method,
          headers: {
            "cf-access-jwt-assertion": await accessJwt(ALLOWED_SUB),
            "mcp-session-id": "sess-1",
          },
        });
        expect(res.status).toBe(200);
        await res.text();
        expect(mcpSeen).toHaveLength(1);
        const seen = mcpSeen[0] as McpSeen;
        expect(seen.sigv4Detail).toBe("ok");
        expect(seen.sigv4Ok).toBe(true);
        expect(seen.body).toBe("");
        expect(seen.headers["mcp-session-id"]).toBe("sess-1");
      }
    });

    it("クライアントの Authorization ヘッダーは上流に届かない（SigV4 の Authorization に置換）", async () => {
      mcpSeen = [];
      const res = await rpc("tools/list", await accessJwt(ALLOWED_SUB), {
        authorization: "Bearer client-secret-must-not-leak",
      });
      expect(res.status).toBe(200);
      const seen = mcpSeen[0] as McpSeen;
      expect(seen.sigv4Ok).toBe(true);
      expect(String(seen.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(JSON.stringify(seen.headers)).not.toContain("client-secret-must-not-leak");
    });

    it("上流の set-cookie は Worker 応答に含まれない", async () => {
      const res = await rpc("tools/list", await accessJwt(ALLOWED_SUB));
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(JSON.stringify([...res.headers])).not.toContain("must-not-leak");
    });
  });

  describe("email の正規化", () => {
    it("大文字混じりの email でも、小文字の許可利用者として通る", async () => {
      const res = await rpc("tools/list", await accessJwt("User@Example.COM"));
      expect(res.status).toBe(200);
    });
  });
});

describe("マルチアカウント（aws_profile）", () => {
  const callTool = (token: string, args: Record<string, unknown>, name = "call_aws") =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

  it("引数なしは default（a）のロールで、aws_profile 無しの本文が上流へ届く", async () => {
    stsRoles = [];
    mcpSeen = [];
    const res = await callTool(await accessJwt(ALLOWED_SUB), {
      cli_command: "aws sts get-caller-identity",
    });
    expect(res.status).toBe(200);
    expect(stsRoles.every((r) => r === ROLE_A)).toBe(true);
    const seen = mcpSeen[0] as McpSeen;
    expect(seen.sigv4Ok).toBe(true);
    expect(JSON.parse(seen.body).params.arguments).toEqual({
      cli_command: "aws sts get-caller-identity",
    });
  });

  it("aws_profile: b は b のロールを直接引き受け、a に戻すと a のロール。上流本文に aws_profile は無い", async () => {
    stsRoles = [];
    mcpSeen = [];
    const token = await accessJwt(PROFILE_SUBS[1] as string);
    expect((await callTool(token, { aws_profile: "b", x: 1 })).status).toBe(200);
    expect((await callTool(token, { aws_profile: "a", x: 2 })).status).toBe(200);
    expect(stsRoles).toEqual([ROLE_B, ROLE_A]);
    expect(mcpSeen).toHaveLength(2);
    for (const m of mcpSeen) {
      expect(m.sigv4Ok).toBe(true);
      expect(m.body).not.toContain("aws_profile");
    }
    expect(JSON.parse((mcpSeen[0] as McpSeen).body).params.arguments).toEqual({ x: 1 });
    expect(JSON.parse((mcpSeen[0] as McpSeen).body).params._meta.AWS_REGION).toBe("ap-northeast-1");
  });

  it("未知の aws_profile は 400 unknown_aws_profile で、STS にも上流にも行かない", async () => {
    stsRoles = [];
    mcpSeen = [];
    const res = await callTool(await accessJwt(ALLOWED_SUB), { aws_profile: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_aws_profile" });
    expect(stsRoles).toHaveLength(0);
    expect(mcpSeen).toHaveLength(0);
  });

  it("文字列以外は 400 invalid_aws_profile", async () => {
    const res = await callTool(await accessJwt(ALLOWED_SUB), { aws_profile: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_aws_profile" });
  });

  it("tools/list は default のロール", async () => {
    stsRoles = [];
    mcpSeen = [];
    const res = await rpc("tools/list", await accessJwt(PROFILE_SUBS[2] as string));
    expect(res.status).toBe(200);
    expect(stsRoles).toEqual([ROLE_A]);
  });

  it("バッチで aws_profile が混在すれば 400 batch_not_supported", async () => {
    const mk = (p: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "call_aws", arguments: { aws_profile: p } },
    });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await accessJwt(ALLOWED_SUB),
      },
      body: JSON.stringify([mk("a"), mk("b")]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "batch_not_supported" });
  });
});
