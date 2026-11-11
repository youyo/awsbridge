// PoC のポータル Worker（scripts/poc/human/portal/wrangler.jsonc）を wrangler dev で起動し、
// 擬似の Access（JWKS）・STS・Federation を相手に、N9 の issuer の文書と N10 の通し経路を確かめる。
// 設定はリポジトリの wrangler.jsonc を読み、main を絶対パスにし、vars（宛先の差し替えと鍵）を足した一時ファイルで起動する。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, exportJWK, generateKeyPair, type JWK, jwtVerify, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signPortalToken } from "../../scripts/poc/human/portal/lib";

const BASE = "https://awsbridge-human-poc-portal.example.workers.dev";
const AUD_INFRA = "a".repeat(64);
const AUD_DEV = "b".repeat(64);
const AUD_ENTRY = "c".repeat(64);
const ROLE_SHARED = "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalShared";
const EMAIL = "user@example.com";

let proc: ChildProcess | undefined;
let fake: Server | undefined;
let tmp = "";
let base = "";
let fakeBase = "";
let logs = "";
let accessKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let stdJwk: JWK;
let adminJwk: JWK;
const stsSeen: URLSearchParams[] = [];
const fedSeen: URL[] = [];

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
      if ((await fetch(url)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready\n${logs}`);
}

const stsXml = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
<Credentials><AccessKeyId>ASIAE2EPORTAL</AccessKeyId><SecretAccessKey>e2e-portal-secret</SecretAccessKey><SessionToken>e2e-portal-token</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials>
<AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocPortalShared/human-user@example.com</Arn><AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;

beforeAll(async () => {
  accessKeys = await generateKeyPair("RS256", { extractable: true });
  const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "e2e-access", alg: "RS256" };
  stdJwk = await exportJWK(
    (await generateKeyPair("RS256", { modulusLength: 2048, extractable: true })).privateKey,
  );
  adminJwk = await exportJWK(
    (await generateKeyPair("RS256", { modulusLength: 2048, extractable: true })).privateKey,
  );

  fake = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (url.pathname === "/cdn-cgi/access/certs") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [accessJwk] }));
        return;
      }
      if (url.pathname === "/sts") {
        stsSeen.push(new URLSearchParams(body));
        res.end(stsXml);
        return;
      }
      if (url.pathname === "/federation") {
        fedSeen.push(url);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ SigninToken: "E2E-SIGNIN-TOKEN" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const fakePort = await freePort();
  await new Promise<void>((r) => fake?.listen(fakePort, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${fakePort}`;

  tmp = mkdtempSync(join(tmpdir(), "awsbridge-portal-e2e-"));
  const configDir = join(process.cwd(), "scripts/poc/human/portal");
  const jsonc = readFileSync(join(configDir, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const config = JSON.parse(jsonc) as Record<string, unknown>;
  expect(config.name).toBe("awsbridge-human-poc-portal");
  // 入口は Custom Domain だけ（workers.dev・Preview URL は無効）。手元の起動では使わないので routes は外す
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  delete config.routes;
  const wranglerConfig = join(tmp, "wrangler.e2e.jsonc");
  writeFileSync(
    wranglerConfig,
    JSON.stringify({
      ...config,
      $schema: undefined,
      main: join(configDir, config.main as string),
      vars: {
        PORTAL_BASE: BASE,
        ACCESS_TEAM_DOMAIN: fakeBase,
        ACCESS_AUD_MAP: JSON.stringify({ [AUD_INFRA]: "infra", [AUD_DEV]: "dev" }),
        ACCESS_ENTRY_AUD: AUD_ENTRY,
        ROLES: JSON.stringify([{ label: "shared", arn: ROLE_SHARED }]),
        SESSION_DURATION: "3600",
        SIGNING_JWK_STD: JSON.stringify(stdJwk),
        SIGNING_JWK_ADMIN: JSON.stringify(adminJwk),
        STS_ENDPOINT: `${fakeBase}/sts`,
        FEDERATION_ENDPOINT: `${fakeBase}/federation`,
        // PoC 専用の poc-token（bypass-check の B4 の準備）。deploy.ts --poc-token と同じ値
        POC_TOKEN_ENDPOINT: "enabled",
      },
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
  await waitReady(`${base}/std/.well-known/jwks.json`);
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

async function accessJwt(aud: string): Promise<string> {
  return new SignJWT({ email: EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: "e2e-access" })
    .setIssuer(fakeBase)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(accessKeys.privateKey);
}

describe("PoC ポータル Worker（wrangler dev）: N9 パス付き issuer", () => {
  it("std / admin の discovery と JWKS を返し、それぞれの鍵で署名した JWT だけがその JWKS で検証できる", async () => {
    for (const [tier, jwk, other] of [
      ["std", () => stdJwk, () => adminJwk],
      ["admin", () => adminJwk, () => stdJwk],
    ] as const) {
      const d = (await (
        await fetch(`${base}/${tier}/.well-known/openid-configuration`)
      ).json()) as {
        issuer: string;
        jwks_uri: string;
      };
      expect(d.issuer).toBe(`${BASE}/${tier}`);
      expect(d.jwks_uri).toBe(`${BASE}/${tier}/.well-known/jwks.json`);
      const jwks = createRemoteJWKSet(new URL(`${base}/${tier}/.well-known/jwks.json`));
      const opts = { issuer: `${BASE}/${tier}`, audience: "awsbridge-human-poc-portal" };
      const good = await signPortalToken({
        privateJwk: jwk(),
        issuer: `${BASE}/${tier}`,
        audience: opts.audience,
        subject: EMAIL,
      });
      expect((await jwtVerify(good, jwks, opts)).payload.sub).toBe(EMAIL);
      const cross = await signPortalToken({
        privateJwk: other(),
        issuer: `${BASE}/${tier}`,
        audience: opts.audience,
        subject: EMAIL,
      });
      await expect(jwtVerify(cross, jwks, opts)).rejects.toThrow();
    }
  });
});

describe("PoC ポータル Worker（wrangler dev）: N1 / N10", () => {
  it("whoami は AUD からチームを決める", async () => {
    const r = await fetch(`${base}/t/infra/whoami`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(AUD_INFRA) },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ verified: true, aud_team: "infra", team_match: true });
  });

  it("POST /t/infra/login → 擬似 STS（タグ・SI つきの JWT）→ 擬似 Federation → 302", async () => {
    const r = await fetch(`${base}/t/infra/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Cf-Access-Jwt-Assertion": await accessJwt(AUD_INFRA),
        origin: BASE,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "role=shared",
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(`${fakeBase}/federation`);
    expect(loc.searchParams.get("Action")).toBe("login");
    expect(loc.searchParams.get("SigninToken")).toBe("E2E-SIGNIN-TOKEN");
    expect(loc.searchParams.get("Issuer")).toBe(`${BASE}/t/infra/expired`);

    const form = stsSeen.at(-1);
    expect(form?.get("RoleArn")).toBe(ROLE_SHARED);
    // STS に渡った JWT は、公開された std の JWKS で検証できる（= IAM が取りに来る文書と鍵が一致する）
    const jwks = createRemoteJWKSet(new URL(`${base}/std/.well-known/jwks.json`));
    const { payload } = await jwtVerify(form?.get("WebIdentityToken") ?? "", jwks, {
      issuer: `${BASE}/std`,
      audience: "awsbridge-human-poc-portal",
    });
    expect(payload["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: { awsbridge_team: ["infra"] },
    });
    expect(payload["https://aws.amazon.com/source_identity"]).toBe(EMAIL);
    expect(fedSeen.at(-1)?.searchParams.get("SessionDuration")).toBe("3600");
    // 認証情報は応答に出さない
    expect(await r.text()).not.toMatch(/e2e-portal-(secret|token)/);
  });

  it("入口の AUD・食い違い・Origin なしは発行しない", async () => {
    const before = stsSeen.length;
    const post = async (aud: string, path: string, origin?: string) =>
      (
        await fetch(`${base}${path}`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Cf-Access-Jwt-Assertion": await accessJwt(aud),
            ...(origin ? { origin } : {}),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "role=shared",
        })
      ).status;
    expect(await post(AUD_ENTRY, "/t/infra/login", BASE)).toBe(403);
    expect(await post(AUD_DEV, "/t/infra/login", BASE)).toBe(403);
    expect(await post(AUD_INFRA, "/t/infra/login")).toBe(403);
    expect(stsSeen.length).toBe(before);
  });
});

describe("PoC ポータル Worker（wrangler dev）: PoC 専用の poc-token（B4 の持ち込み用）", () => {
  it("検証できてチームが一致した Access JWT をそのまま添付ファイルで返す", async () => {
    const jwt = await accessJwt(AUD_INFRA);
    const r = await fetch(`${base}/t/infra/poc-token`, {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("awsbridge-poc-access-jwt.txt");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toBe(`${jwt}\n`);
  });
  it("チームが食い違う・JWT が無ければ返さない。トークンはログに出さない", async () => {
    const dev = await accessJwt(AUD_DEV);
    const r1 = await fetch(`${base}/t/infra/poc-token`, {
      headers: { "Cf-Access-Jwt-Assertion": dev },
    });
    expect(r1.status).toBe(403);
    expect(await r1.text()).not.toContain(dev);
    expect((await fetch(`${base}/t/infra/poc-token`)).status).toBe(401);
    expect(logs).not.toContain(dev);
  });
});
