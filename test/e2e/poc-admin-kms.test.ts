// PoC N6 の Worker（scripts/poc/admin-kms/wrangler.jsonc）を wrangler dev で起動し、
// 偽の KMS（手元の RSA・EC 鍵で署名。ECDSA は KMS と同じく DER で返す）・STS・Federation に向けて
// /poc/login と /poc/sign を通しで確かめる。STS に届いた JWT が Worker の配る JWKS で検証できることを見る。
// 設定はリポジトリの wrangler.jsonc を deploy と同じ関数（deployWranglerConfig）で組み、宛先の差し替えは vars で渡す（localhost だけ有効）。
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign as nodeSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issuerJwks, jwkFromSpki } from "../../scripts/poc/admin-kms/lib";
import { deployWranglerConfig } from "../../scripts/poc/admin-kms/ops";
import { parseJsonc } from "../../scripts/poc/human/portal/bypass-lib";
import { buildDiscovery } from "../../src/oidc";

const ISSUER = "https://awsbridge-admin-kms-poc.example.workers.dev";
const RSA_ARN = "arn:aws:kms:ap-northeast-1:123456789012:key/11111111-1111-4111-8111-111111111111";
const EC_ARN = "arn:aws:kms:ap-northeast-1:123456789012:key/22222222-2222-4222-8222-222222222222";
const TOKEN = "e2e-caller-token";

let proc: ChildProcess | undefined;
let fake: Server | undefined;
let tmp = "";
let base = "";
let logs = "";
const keys: Record<string, KeyObject> = {};
const seen: { kmsAuth: (string | undefined)[]; stsTokens: string[]; fed: number } = {
  kmsAuth: [],
  stsTokens: [],
  fed: 0,
};

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

function startFakeAws(port: number): Promise<Server> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/kms") {
        seen.kmsAuth.push(req.headers.authorization);
        const b = JSON.parse(body) as Record<string, string>;
        const key = keys[b.KeyId as string];
        if (!key || b.MessageType !== "RAW") {
          res.writeHead(400, { "x-amzn-requestid": "kms-err" });
          res.end(JSON.stringify({ __type: "NotFoundException" }));
          return;
        }
        const msg = Buffer.from(b.Message as string, "base64");
        const sig =
          b.SigningAlgorithm === "ECDSA_SHA_256"
            ? nodeSign("sha256", msg, { key, dsaEncoding: "der" })
            : nodeSign("sha256", msg, key);
        res.writeHead(200, { "x-amzn-requestid": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
        res.end(JSON.stringify({ KeyId: b.KeyId, Signature: Buffer.from(sig).toString("base64") }));
        return;
      }
      if (url.pathname === "/sts") {
        const p = new URLSearchParams(body);
        seen.stsTokens.push(p.get("WebIdentityToken") ?? "");
        res.writeHead(200, { "x-amzn-requestid": "sts-e2e" });
        res.end(
          "<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><SourceIdentity>awsbridge-kms-check</SourceIdentity><Credentials><AccessKeyId>ASIAE2E</AccessKeyId><SecretAccessKey>S</SecretAccessKey><SessionToken>T</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/AwsbridgeAdminKmsPoc/x</Arn><AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>",
        );
        return;
      }
      if (url.pathname === "/federation") {
        seen.fed++;
        res.writeHead(200);
        res.end(JSON.stringify({ SigninToken: "e2e-signin-token" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

beforeAll(async () => {
  const r = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const e = generateKeyPairSync("ec", { namedCurve: "P-256" });
  keys[RSA_ARN] = r.privateKey;
  keys[EC_ARN] = e.privateKey;
  const rj = await jwkFromSpki(
    new Uint8Array(r.publicKey.export({ format: "der", type: "spki" })),
    "RS256",
  );
  const ej = await jwkFromSpki(
    new Uint8Array(e.publicKey.export({ format: "der", type: "spki" })),
    "ES256",
  );
  const docs = { discovery: buildDiscovery(ISSUER), jwks: issuerJwks([rj, ej]) };
  tmp = mkdtempSync(join(tmpdir(), "awsbridge-admin-kms-e2e-"));
  const docsFile = join(tmp, "issuer-documents.json");
  writeFileSync(docsFile, JSON.stringify(docs));
  const fakePort = await freePort();
  fake = await startFakeAws(fakePort);
  const fakeBase = `http://127.0.0.1:${fakePort}`;
  const dir = join(process.cwd(), "scripts/poc/admin-kms");
  const config = deployWranglerConfig(
    parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")),
    {
      dir,
      documentsFile: docsFile,
      vars: {
        ISSUER,
        ROLE_ARN: "arn:aws:iam::123456789012:role/AwsbridgeAdminKmsPoc",
        KMS_KEYS: JSON.stringify([
          { label: "rsa", keyId: RSA_ARN, alg: "RS256", kid: rj.kid },
          { label: "ec", keyId: EC_ARN, alg: "ES256", kid: ej.kid },
        ]),
        AWS_REGION: "ap-northeast-1",
        // 本番では secret（access-key.ts が入れる）。E2E では vars で渡す
        AWS_ACCESS_KEY_ID: "AKIAE2EFAKEFAKEFAKE0",
        AWS_SECRET_ACCESS_KEY: "e2e-secret",
        CALLER_TOKEN: TOKEN,
        KMS_ENDPOINT: `${fakeBase}/kms`,
        STS_ENDPOINT: `${fakeBase}/sts`,
        FEDERATION_ENDPOINT: `${fakeBase}/federation`,
      },
    },
  );
  const wranglerConfig = join(tmp, "wrangler.e2e.json");
  writeFileSync(wranglerConfig, JSON.stringify(config));
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
  fake?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

describe("PoC N6 の Worker（wrangler dev + 偽の KMS・STS・Federation）", () => {
  it("bearer が無ければ 401 で KMS を呼ばない", async () => {
    const before = seen.kmsAuth.length;
    const r = await post("/poc/login", { key: "rsa" }, null);
    expect(r.status).toBe(401);
    expect(seen.kmsAuth.length).toBe(before);
  });

  it.each([
    ["rsa", "RS256"],
    ["ec", "ES256"],
  ])(
    "%s: /poc/login が通り、STS に届いた JWT が Worker の JWKS で検証できる（SigV4 で KMS を呼ぶ）",
    async (key, alg) => {
      const r = await post("/poc/login", { key });
      expect(r.status).toBe(200);
      const out = (await r.json()) as Record<string, unknown>;
      expect(out).toMatchObject({ ok: true, key, alg, sourceIdentity: "awsbridge-kms-check" });
      expect(seen.kmsAuth.at(-1)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAE2EFAKEFAKEFAKE0\//);
      const jwt = seen.stsTokens.at(-1) as string;
      const jwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
      const { payload, protectedHeader } = await jwtVerify(jwt, jwks, {
        issuer: ISSUER,
        audience: "awsbridge-admin-kms-poc",
      });
      expect(protectedHeader.alg).toBe(alg);
      expect(payload.sub).toBe("awsbridge-kms-check");
      expect(JSON.stringify(out)).not.toContain(jwt);
      expect(JSON.stringify(out)).not.toContain("e2e-signin-token");
    },
  );

  it("/poc/sign は count 回の Sign の結果を返す", async () => {
    const r = await post("/poc/sign", { key: "ec", count: 3 });
    const out = (await r.json()) as { results: { ok: boolean }[] };
    expect(out.results.map((x) => x.ok)).toEqual([true, true, true]);
  });
});
