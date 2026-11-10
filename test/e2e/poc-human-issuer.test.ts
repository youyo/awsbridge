// PoC（人間のログイン）の issuer Worker（scripts/poc/human/wrangler.jsonc）を wrangler dev で起動し、
// alias で差し込んだ文書（discovery / JWKS）が返ること、手元で署名した JWT が公開された JWKS で検証できることを確かめる。
// 設定はリポジトリの wrangler.jsonc を読み、main を絶対パスに、alias を一時ファイルに差し替えて使う
// （wrangler dev は CLI の --alias を反映しないため。deploy は反映する）。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, exportJWK, generateKeyPair, type JWK, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type IssuerDocuments, issuerDocuments, signHumanToken } from "../../scripts/poc/human/lib";

const ISSUER = "https://awsbridge-human-poc.example.workers.dev";
let proc: ChildProcess | undefined;
let tmp = "";
let base = "";
let logs = "";
let privateJwk: JWK;
let docs: IssuerDocuments;

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
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateJwk = await exportJWK(privateKey);
  docs = await issuerDocuments(ISSUER, privateJwk);
  tmp = mkdtempSync(join(tmpdir(), "awsbridge-human-e2e-"));
  const docsFile = join(tmp, "issuer-documents.json");
  writeFileSync(docsFile, JSON.stringify(docs));
  const configDir = join(process.cwd(), "scripts/poc/human");
  // JSONC のコメント行（// で始まる行）を除いて JSON として読む（行末コメントは書かない前提）
  const jsonc = readFileSync(join(configDir, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const config = JSON.parse(jsonc) as Record<string, unknown>;
  expect(config.name).toBe("awsbridge-human-poc");
  const wranglerConfig = join(tmp, "wrangler.e2e.jsonc");
  writeFileSync(
    wranglerConfig,
    JSON.stringify({
      ...config,
      $schema: undefined,
      main: join(configDir, config.main as string),
      alias: { "awsbridge-human-poc-documents": docsFile },
    }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      wranglerConfig,
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      join(tmp, "state"),
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

describe("PoC issuer Worker（wrangler dev）", () => {
  it("discovery を JSON で返す（IAM が受理した項目と同じ）", async () => {
    const r = await fetch(`${base}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    const body = (await r.json()) as { issuer: string; jwks_uri: string };
    expect(body).toEqual(docs.discovery);
    expect(body.issuer).toBe(ISSUER);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("JWKS は公開鍵だけを返す", async () => {
    const r = await fetch(`${base}/.well-known/jwks.json`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual(docs.jwks);
    expect(text).not.toContain(privateJwk.d as string);
  });

  it("手元で署名した JWT は公開された JWKS で検証できる", async () => {
    const token = await signHumanToken({
      privateJwk,
      issuer: ISSUER,
      audience: "awsbridge-human-poc",
      subject: "user@example.com",
    });
    const jwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: "awsbridge-human-poc",
    });
    expect(payload.sub).toBe("user@example.com");
  });

  it("他のパスは 404（署名などの機能は持たない）", async () => {
    for (const p of ["/", "/oauth/token", "/mcp"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
    }
  });
});
