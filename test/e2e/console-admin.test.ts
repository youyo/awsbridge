// コンソールログインの Admin の Worker を wrangler dev で起動し、擬似の Access（certs）・STS・getSigninToken を相手に、
// 画面（S2）→ POST /t/<team>/login → Admin の鍵で署名 → 擬似 STS → getSigninToken → 302 までを確かめる（X1 の決裁）。
// STS に渡った JWT は、同じ Worker が Admin の issuer のホスト（/admin）で出す JWKS で検証する。
// 鍵は Workers の secret_key 型（取り出せない CryptoKey）の代わりに、E2E 用のエントリ（fixtures/console-admin-key-entry.ts）が
// Worker の中で取り出せない鍵を作って渡す（手元の wrangler dev は secret_key を作れない）。鍵が無いときの 503 は console-negative.test.ts。
// 負の試験（断るケース）は console-negative.test.ts に集めてある（重複を持たない）。
// 設定はリポジトリの wrangler.console-admin.jsonc を読み、main を E2E 用のエントリ（外向きの通信だけを擬似に向ける）にし、
// routes を外し（手元では Host ヘッダーで振り分ける）、alias を試験用の生成物に、vars に鍵と擬似の宛先を足した一時ファイルで起動する。
// 実 AWS・Cloudflare は呼ばない。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  jwtVerify,
  SignJWT,
} from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIENCE } from "../../src/console/constants";
import { buildDiscovery } from "../../src/oidc";
import {
  ADMIN_HOST,
  ADMIN_PORTAL,
  AUDS,
  adminConfig,
  stsXml,
} from "../unit/console-standard-harness";
import { readJsonc } from "./jsonc";

const root = new URL("../../", import.meta.url).pathname;
const TEAM_DOMAIN = "https://e2e-team.cloudflareaccess.com";
const EMAIL = "user@example.com";
const SUB = "e2e00000-0000-4000-8000-000000000002";
const TEAM = "infra-elevated";
const ADMIN_AUD = AUDS.teams[TEAM] as string;
const ENTRY = "333333333333:admin";
const ADMIN_ISSUER = "https://admin-id.example.com/admin";
const ADMIN_ISSUER_HOST = "admin-id.example.com";
// 鍵・トークンの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const CSRF_SECRET = ["e2e", "csrf", "a".repeat(40)].join("-");
const ACCESS_KEY_ID = ["ASIA", "A".repeat(16)].join("");
const SIGNIN_TOKEN = ["signin", "a".repeat(24)].join("-");

type Instance = { proc: ChildProcess; base: string; logs: string[] };
let normal: Instance;
let fake: Server | undefined;
let fakeBase = "";
let tmp = "";
let accessKeys: Awaited<ReturnType<typeof generateKeyPair>>;
const seen = { sts: [] as URLSearchParams[], signin: [] as URLSearchParams[] };

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

type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** Host ヘッダーを指定して送る（Node の fetch は Host を差し替えられないので node:http を使う）。 */
function send(
  inst: Instance,
  p: {
    method?: string;
    host: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<HttpResult> {
  const u = new URL(inst.base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        method: p.method ?? "GET",
        path: p.path,
        headers: { Host: p.host, ...(p.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (p.body !== undefined) req.write(p.body);
    req.end();
  });
}

async function waitReady(inst: Instance): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      // Access の JWT が無いチームのパスは 401（Worker が応答している印）
      const r = await send(inst, { host: ADMIN_HOST, path: `/t/${TEAM}/` });
      if (r.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready\n${inst.logs.join("")}`);
}

async function start(configPath: string): Promise<Instance> {
  const port = await freePort();
  const inspectorPort = await freePort();
  const logs: string[] = [];
  const proc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      // 本番と同じ https の URL として Worker に渡す（http のままだと wrangler dev が Origin を http:// に書き換える）
      "--upstream-protocol",
      "https",
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      join(tmp, "state-admin"),
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  proc.stdout?.on("data", (d) => logs.push(String(d)));
  proc.stderr?.on("data", (d) => logs.push(String(d)));
  const inst = { proc, base: `http://127.0.0.1:${port}`, logs };
  await waitReady(inst);
  return inst;
}

function stop(inst: Instance | undefined) {
  const pid = inst?.proc.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 3000).unref();
}

beforeAll(async () => {
  accessKeys = await generateKeyPair("RS256", { extractable: true });
  const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "e2e-access", alg: "RS256" };

  fake = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/certs") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [accessJwk] }));
        return;
      }
      if (url.pathname === "/sts") {
        seen.sts.push(new URLSearchParams(body));
        res.end(stsXml(ACCESS_KEY_ID));
        return;
      }
      if (url.pathname === "/federation") {
        seen.signin.push(new URLSearchParams(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ SigninToken: SIGNIN_TOKEN }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const fakePort = await freePort();
  await new Promise<void>((r) => fake?.listen(fakePort, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${fakePort}`;

  tmp = mkdtempSync(join(tmpdir(), "awsbridge-console-admin-e2e-"));
  const generated = join(tmp, "worker.admin.json");
  writeFileSync(generated, JSON.stringify(adminConfig()));
  const config = readJsonc(join(root, "wrangler.console-admin.jsonc"));
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  delete config.routes; // 手元では Host ヘッダーで振り分ける（routes があると wrangler dev が Host を書き換える）
  const ratelimits = (config.ratelimits as { simple: { limit: number } }[]).map((r) => ({
    ...r,
    simple: { ...r.simple, limit: 1000 },
  }));
  const wranglerConfig = join(tmp, "wrangler.e2e.json");
  writeFileSync(
    wranglerConfig,
    JSON.stringify({
      ...config,
      $schema: undefined,
      main: join(root, "test/e2e/fixtures/console-admin-key-entry.ts"),
      alias: { "awsbridge:console-worker-admin": generated },
      ratelimits,
      // 署名鍵の secret（文字列）は渡さない（Admin の Worker は持たない）。鍵は E2E 用のエントリが Worker の中で作る
      vars: {
        ...(config.vars as Record<string, string>),
        ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
        CONSOLE_CSRF_KEY: CSRF_SECRET,
        E2E_FAKE_BASE: fakeBase,
      },
    }),
  );
  normal = await start(wranglerConfig);
}, 90_000);

afterAll(() => {
  stop(normal);
  fake?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  seen.sts.length = 0;
  seen.signin.length = 0;
});

async function accessJwt(aud: string | string[]): Promise<string> {
  return new SignJWT({ email: EMAIL, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "e2e-access" })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(aud)
    .setSubject(SUB)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(accessKeys.privateKey);
}

/** S2 を開いて CSRF トークンを取り出す。 */
async function csrfFrom(aud: string): Promise<string> {
  const r = await send(normal, {
    host: ADMIN_HOST,
    path: `/t/${TEAM}/a/333333333333`,
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt(aud) },
  });
  expect(r.status, r.body).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1];
  expect(csrf).toBeDefined();
  return csrf as string;
}

async function postLogin(p: {
  jwt: string;
  form: Record<string, string>;
  origin?: string | null;
  host?: string;
  path?: string;
}): Promise<HttpResult> {
  return send(normal, {
    method: "POST",
    host: p.host ?? ADMIN_HOST,
    path: p.path ?? `/t/${TEAM}/login`,
    headers: {
      "Cf-Access-Jwt-Assertion": p.jwt,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(p.origin === null ? {} : { Origin: p.origin ?? ADMIN_PORTAL }),
    },
    body: new URLSearchParams(p.form).toString(),
  });
}

async function issuerJwks(): Promise<JSONWebKeySet> {
  const r = await send(normal, { host: ADMIN_ISSUER_HOST, path: "/admin/.well-known/jwks.json" });
  expect(r.status, r.body).toBe(200);
  return JSON.parse(r.body) as JSONWebKeySet;
}

async function login(): Promise<HttpResult> {
  const csrf = await csrfFrom(ADMIN_AUD);
  return postLogin({
    jwt: await accessJwt(ADMIN_AUD),
    form: { entry: ENTRY, region: "ap-northeast-1", csrf },
  });
}

describe("Admin の Worker（wrangler dev）: 通しの経路（鍵あり）", () => {
  it("S2（[ADMIN] の印）のフォーム → POST /t/infra-elevated/login → 302（getSigninToken のログイン URL）。STS と getSigninToken を 1 回ずつ呼ぶ", async () => {
    const s2 = await send(normal, {
      host: ADMIN_HOST,
      path: `/t/${TEAM}/a/333333333333`,
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(ADMIN_AUD) },
    });
    expect(s2.status).toBe(200);
    expect(s2.body).toContain("[ADMIN]");
    expect(s2.body).toContain(`value="${ENTRY}"`);
    const r = await login();
    expect(r.status, r.body).toBe(302);
    expect(String(r.headers.location)).toMatch(/^https:\/\/signin\.aws\.amazon\.com\/federation\?/);
    expect(String(r.headers.location)).toContain(SIGNIN_TOKEN);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(seen.sts).toHaveLength(1);
    expect(seen.signin).toHaveLength(1);
    expect(seen.sts[0]?.get("RoleArn")).toBe(
      "arn:aws:iam::333333333333:role/awsbridge-console/admin/FederatedAdministrator",
    );
  });

  it("STS に渡した JWT は Admin の issuer のホストの JWKS で検証でき、iss・aud・kid・exp=iat+300 を持つ。jti は発行ごとに違う", async () => {
    expect((await login()).status).toBe(302);
    expect((await login()).status).toBe(302);
    const tokens = seen.sts.map((p) => p.get("WebIdentityToken") as string);
    expect(tokens).toHaveLength(2);
    const jwks = await issuerJwks();
    expect(jwks.keys).toHaveLength(1);
    for (const t of tokens) {
      const { payload } = await jwtVerify(t, createLocalJWKSet(jwks), {
        issuer: ADMIN_ISSUER,
        audience: AUDIENCE,
        algorithms: ["RS256"],
      });
      expect(decodeProtectedHeader(t).kid).toBe(jwks.keys[0]?.kid);
      expect((payload.exp as number) - (payload.iat as number)).toBe(300);
      expect(payload.sub).toBe(EMAIL);
    }
    expect(decodeJwt(tokens[0] as string).jti).not.toBe(decodeJwt(tokens[1] as string).jti);
  });

  it("Admin の issuer の discovery は Standard と同じ形（issuer・jwks_uri は Admin の issuer）。JWKS は公開の成分だけ", async () => {
    const r = await send(normal, {
      host: ADMIN_ISSUER_HOST,
      path: "/admin/.well-known/openid-configuration",
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(buildDiscovery(ADMIN_ISSUER));
    const jwks = await issuerJwks();
    for (const k of jwks.keys)
      expect(Object.keys(k).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  it("デプロイ後の確認（key-check）: 鍵は取り出せず（extractable false）、Worker の中の exportKey は失敗し、自己検証が通る", async () => {
    const r = await send(normal, {
      host: ADMIN_HOST,
      path: `/t/${TEAM}/key-check`,
      headers: { "Cf-Access-Jwt-Assertion": await accessJwt(ADMIN_AUD) },
    });
    expect(r.status, r.body).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      configured: true,
      present: true,
      usable: true,
      extractable: false,
      usages: ["sign"],
      exportKey: "rejected",
      selfVerify: "ok",
    });
    expect((await send(normal, { host: ADMIN_HOST, path: `/t/${TEAM}/key-check` })).status).toBe(
      401,
    );
  });

  it("発行記録は tier admin・result ok の構造化ログ（伏せ字）で、email・CSRF の鍵・JWT・認証情報を出さない", async () => {
    expect((await login()).status).toBe(302);
    const token = seen.sts[0]?.get("WebIdentityToken") as string;
    await new Promise((r) => setTimeout(r, 500));
    const logs = normal.logs.join("");
    expect(logs).toContain('"console_issue"');
    expect(logs).toMatch(/"tier":"admin"[^\n]*"result":"ok"|"result":"ok"[^\n]*"tier":"admin"/);
    for (const s of [SIGNIN_TOKEN, ACCESS_KEY_ID, EMAIL, CSRF_SECRET, token])
      expect(logs).not.toContain(s);
  });
});
