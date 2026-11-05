import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signStsToken } from "../../src/oidc";

let proc: ChildProcess | undefined;
let tmp = "";
let base = "";
let privateJwk: Awaited<ReturnType<typeof exportJWK>>;
let logs = "";

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
  tmp = mkdtempSync(join(tmpdir(), "awsbridge-e2e-"));
  const varsFile = join(tmp, "dev.vars");
  writeFileSync(varsFile, `SIGNING_JWK='${JSON.stringify(privateJwk)}'\n`);
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
});
