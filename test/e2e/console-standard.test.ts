// コンソールログインの Standard の Worker を wrangler dev で起動し、擬似の Access（certs）・STS・getSigninToken を相手に、
// 入口の一覧（S0）→ S2 のリンク → POST /t/<team>/login → 302 までの通しと、S1・S3・静的なファイルを確かめる。
// 負の試験（断るケース）は console-negative.test.ts に集めてある（重複を持たない）。
// 入口の身元のグループの取り方は未確定なので、本物のエントリ（normal）は全チームの S1 へのリンクに落ちる経路を通り、
// 試験用のエントリの変数 E2E_IDENTITY_GROUPS を渡したもの（grouped）が所属するチームの行の経路を通る。
// 設定はリポジトリの wrangler.console-standard.jsonc を読み、main を E2E 用のエントリ（外向きの通信だけを擬似に向ける）にし、
// routes を外し（手元では Host ヘッダーで振り分ける）、alias を試験用の生成物に、vars に擬似の宛先を足した一時ファイルで起動する。
// 署名鍵は E2E 用のエントリが Worker の中で境界ごとに取り出せない鍵を作る（本番の secret_key と同じ CryptoKey の形）。
// 実 AWS・Cloudflare は呼ばない。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIENCE } from "../../src/console/constants";
import { AUDS, displayConfig, standardConfig, stsXml } from "../unit/console-standard-harness";
import { readJsonc } from "./jsonc";

const root = new URL("../../", import.meta.url).pathname;
const TEAM_DOMAIN = "https://e2e-team.cloudflareaccess.com";
const PORTAL = "https://portal.example.com";
const PORTAL_HOST = "portal.example.com";
const ISSUER_HOST = "id.example.com";
const STD_ISSUER = "https://id.example.com/standard";
const EMAIL = "user@example.com";
const SUB = "e2e00000-0000-4000-8000-000000000001";
const INFRA = AUDS.teams.infra as string;
const DEV = AUDS.teams.dev as string;
const ENTRY_AUD = AUDS.entry.standard;
const GROUP_INFRA = "00000000-0000-4000-8000-000000000001";
const GROUP_INFRA_ELEVATED = "00000000-0000-4000-8000-000000000004";
// 鍵・トークンの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const CSRF_SECRET = ["e2e", "csrf", "c".repeat(40)].join("-");
const ACCESS_KEY_ID = ["ASIA", "E".repeat(16)].join("");
const SIGNIN_TOKEN = ["signin", "e".repeat(24)].join("-");

type Instance = { proc: ChildProcess; base: string; logs: string[] };
let normal: Instance;
let grouped: Instance;
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
      const r = await send(inst, { host: ISSUER_HOST, path: "/standard/.well-known/jwks.json" });
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready\n${inst.logs.join("")}`);
}

async function start(
  name: string,
  vars: Record<string, string>,
  configPath: string,
): Promise<Instance> {
  const port = await freePort();
  // 2 つを同時に起動するので、inspector のポート（既定 9230）も空いているものを渡す
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
      join(tmp, `state-${name}`),
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
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
        res.setHeader("x-amzn-RequestId", "e2e-request-id-0001");
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

  tmp = mkdtempSync(join(tmpdir(), "awsbridge-console-std-e2e-"));
  const generated = join(tmp, "worker.standard.json");
  writeFileSync(generated, JSON.stringify(standardConfig()));
  const generatedDisplay = join(tmp, "display.standard.json");
  writeFileSync(generatedDisplay, JSON.stringify(displayConfig()));
  const config = readJsonc(join(root, "wrangler.console-standard.jsonc"));
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
      main: join(root, "test/e2e/fixtures/console-standard-entry.ts"),
      alias: {
        "awsbridge:console-worker": generated,
        "awsbridge:console-display": generatedDisplay,
      },
      ratelimits,
      vars: {
        ...(config.vars as Record<string, string>),
        ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
        CONSOLE_CSRF_KEY: CSRF_SECRET,
        E2E_FAKE_BASE: fakeBase,
      },
    }),
  );
  [normal, grouped] = await Promise.all([
    start("normal", {}, wranglerConfig),
    // infra（Standard）と infra-elevated（Admin）のグループ（試験の fixture の Object ID）
    start(
      "grouped",
      { E2E_IDENTITY_GROUPS: `${GROUP_INFRA},${GROUP_INFRA_ELEVATED}` },
      wranglerConfig,
    ),
  ]);
}, 90_000);

afterAll(() => {
  stop(normal);
  stop(grouped);
  fake?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  seen.sts.length = 0;
  seen.signin.length = 0;
});

async function accessJwt(aud: string | string[], sub = SUB): Promise<string> {
  return new SignJWT({ email: EMAIL, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "e2e-access" })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(accessKeys.privateKey);
}

/** S2 を開いて CSRF トークンを取り出す。 */
async function csrfFrom(
  inst: Instance,
  team: string,
  accountId: string,
  aud: string,
): Promise<string> {
  const r = await send(inst, {
    host: PORTAL_HOST,
    path: `/t/${team}/a/${accountId}`,
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt(aud) },
  });
  expect(r.status, r.body).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1];
  expect(csrf).toBeDefined();
  return csrf as string;
}

async function postLogin(
  inst: Instance,
  p: {
    jwt: string;
    form: Record<string, string>;
    origin?: string | null;
    host?: string;
    path?: string;
  },
): Promise<HttpResult> {
  return send(inst, {
    method: "POST",
    host: p.host ?? PORTAL_HOST,
    path: p.path ?? "/t/infra/login",
    headers: {
      "Cf-Access-Jwt-Assertion": p.jwt,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(p.origin === null ? {} : { Origin: p.origin ?? PORTAL }),
    },
    body: new URLSearchParams(p.form).toString(),
  });
}

const noIssue = () => {
  expect(seen.sts).toHaveLength(0);
  expect(seen.signin).toHaveLength(0);
};

describe("Standard の Worker（wrangler dev）: 通しの経路", () => {
  it("S2 のフォーム → POST /t/infra/login → 302（ログイン URL）。STS には行の ARN と行のセッションの長さが届く", async () => {
    const csrf = await csrfFrom(normal, "infra", "333333333333", INFRA);
    const r = await postLogin(normal, {
      jwt: await accessJwt(INFRA),
      form: { entry: "333333333333:readonly", region: "ap-northeast-1", csrf },
    });
    expect(r.status, r.body).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(`${loc.origin}${loc.pathname}`).toBe("https://signin.aws.amazon.com/federation");
    expect(loc.searchParams.get("Action")).toBe("login");
    expect(loc.searchParams.get("SigninToken")).toBe(SIGNIN_TOKEN);
    expect(loc.searchParams.get("Issuer")).toBe(`${PORTAL}/t/infra/expired`);
    expect(loc.searchParams.get("Destination")).toContain("region=ap-northeast-1");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");

    expect(seen.sts).toHaveLength(1);
    const sts = seen.sts[0] as URLSearchParams;
    expect(sts.get("RoleArn")).toBe(
      "arn:aws:iam::333333333333:role/awsbridge-console/std/FederatedViewer",
    );
    expect(sts.get("RoleSessionName")).toBe(`console-${EMAIL}`);
    expect(sts.get("DurationSeconds")).toBe("43200");
    expect(seen.signin[0]?.get("SessionDuration")).toBe("43200");

    // STS に渡した JWT は、Worker の issuer のホストが出す JWKS で検証できる
    const jwks = await send(normal, { host: ISSUER_HOST, path: "/standard/.well-known/jwks.json" });
    expect(jwks.status).toBe(200);
    const { payload } = await jwtVerify(
      sts.get("WebIdentityToken") ?? "",
      createLocalJWKSet(JSON.parse(jwks.body)),
      { issuer: STD_ISSUER, audience: AUDIENCE },
    );
    expect(payload.sub).toBe(EMAIL);
  });

  it("issuer のホストは discovery と JWKS を返す（ポータルの経路に届かないことは console-negative.test.ts）", async () => {
    const d = await send(normal, {
      host: ISSUER_HOST,
      path: "/standard/.well-known/openid-configuration",
    });
    expect(d.status).toBe(200);
    expect(JSON.parse(d.body).issuer).toBe(STD_ISSUER);
    const j = await send(normal, { host: ISSUER_HOST, path: "/standard/.well-known/jwks.json" });
    expect(j.status).toBe(200);
  });

  it("発行記録は構造化ログ（伏せ字）で、SigninToken・認証情報・email・CSRF の鍵を出さない", async () => {
    const csrf = await csrfFrom(normal, "infra", "333333333333", INFRA);
    await postLogin(normal, {
      jwt: await accessJwt(INFRA),
      form: { entry: "333333333333:readonly", csrf },
    });
    await new Promise((r) => setTimeout(r, 500));
    const logs = normal.logs.join("");
    expect(logs).toContain('"console_issue"');
    // 発行記録に kid と Worker の版 ID（version_metadata の binding）が入る（cto の決裁 2026-11-13）
    expect(logs).toMatch(/"kid":"[^"]+"/);
    expect(logs).toMatch(/"worker":\{"versionId":"[^"]+"\}/);
    for (const s of [SIGNIN_TOKEN, ACCESS_KEY_ID, EMAIL, CSRF_SECRET])
      expect(logs).not.toContain(s);
  });
});

/** 画面を GET する（Access のアプリの JWT を付ける）。 */
async function page(inst: Instance, path: string, aud: string | null): Promise<HttpResult> {
  return send(inst, {
    host: PORTAL_HOST,
    path,
    headers: aud === null ? {} : { "Cf-Access-Jwt-Assertion": await accessJwt(aud) },
  });
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] as string);

describe("Standard の Worker（wrangler dev）: 入口の一覧（S0）から発行までの通し", () => {
  it("所属するチームの行（grouped）: S0 の行のリンク → S2 → POST → 302。Administrator の行は Admin のオリジンへ [ADMIN]", async () => {
    const s0 = await page(grouped, "/", ENTRY_AUD);
    expect(s0.status, s0.body).toBe(200);
    expect(s0.headers["cache-control"]).toBe("no-store");
    expect(String(s0.headers["content-security-policy"])).toContain("script-src 'self'");
    expect(s0.body).toContain("あなたが入れるもの");
    expect(s0.body).toContain(
      'href="https://admin-portal.example.com/t/infra-elevated/a/333333333333?role=admin"',
    );
    expect(s0.body).toContain("[ADMIN]");
    // 所属しないチームの割り当て・アカウントの email・AUD は出さない
    expect(s0.body).not.toContain("/t/dev/");
    expect(s0.body).not.toMatch(/aws\+[a-z-]+@example\.(com|org)/);
    for (const aud of Object.values(AUDS.teams)) expect(s0.body).not.toContain(aud as string);

    const link = hrefs(s0.body).find((h) => h.startsWith("/t/infra/a/333333333333?role=readonly"));
    expect(link).toBeDefined();
    const s2 = await page(grouped, link as string, INFRA);
    expect(s2.status, s2.body).toBe(200);
    expect(s2.body).toContain('value="333333333333:readonly" required checked');
    const csrf = /name="csrf" value="([^"]+)"/.exec(s2.body)?.[1] as string;
    const r = await postLogin(grouped, {
      jwt: await accessJwt(INFRA),
      form: { entry: "333333333333:readonly", region: "ap-northeast-1", csrf },
    });
    expect(r.status, r.body).toBe(302);
    expect(String(r.headers.location)).toContain("https://signin.aws.amazon.com/federation");
    expect(seen.sts).toHaveLength(1);
  });

  it("所属が分からない（本物のエントリ。取り方は未設定）: S0 は全チームの S1 へのリンク → S1 → S2 → POST → 302", async () => {
    const s0 = await page(normal, "/", ENTRY_AUD);
    expect(s0.status, s0.body).toBe(200);
    expect(s0.body).toContain("所属を確かめられませんでした");
    expect(s0.body).not.toContain("svc-a-prod");
    expect(hrefs(s0.body)).toContain("/t/infra/");
    expect(hrefs(s0.body)).toContain("https://admin-portal.example.com/t/infra-elevated/");

    const s1 = await page(normal, "/t/infra/", INFRA);
    expect(s1.status, s1.body).toBe(200);
    expect(s1.body).toContain("aws+svc-a-prod@example.com");
    const link = hrefs(s1.body).find((h) => h === "/t/infra/a/333333333333?role=readonly");
    expect(link).toBeDefined();
    const s2 = await page(normal, link as string, INFRA);
    const csrf = /name="csrf" value="([^"]+)"/.exec(s2.body)?.[1] as string;
    const r = await postLogin(normal, {
      jwt: await accessJwt(INFRA),
      form: { entry: "333333333333:readonly", csrf },
    });
    expect(r.status, r.body).toBe(302);
  });

  it("U2 の条件: 入口のアプリの JWT は、身元のグループに infra が入っていても POST で 403 unknown_audience", async () => {
    const csrf = await csrfFrom(grouped, "infra", "333333333333", INFRA);
    const r = await postLogin(grouped, {
      jwt: await accessJwt(ENTRY_AUD),
      form: { entry: "333333333333:readonly", csrf },
    });
    expect(r.status).toBe(403);
    expect(r.body).toContain("unknown_audience");
    noIssue();
  });
});

describe("Standard の Worker（wrangler dev）: S1・S3・静的なファイル", () => {
  it("S1 は他のチームの行・AUD を出さず、inline の script・style を使わない。?q= はサーバー側で絞る", async () => {
    const dev = await page(normal, "/t/dev/", DEV);
    expect(dev.status).toBe(200);
    expect(dev.body).toContain("svc-c-dev");
    expect(dev.body).not.toContain("333333333333");
    for (const aud of Object.values(AUDS.teams)) expect(dev.body).not.toContain(aud as string);
    for (const tag of dev.body.match(/<script\b[^>]*>/g) ?? [])
      expect(tag).toMatch(/\ssrc="[^"]+"/);
    expect(dev.body).not.toMatch(/<style\b|\sstyle=/);

    const q = await page(normal, "/t/infra/?q=partner", INFRA);
    expect(q.body).toContain('href="/t/infra/a/222222222222?role=readonly"');
    expect(q.body).not.toContain('href="/t/infra/a/333333333333?role=readonly"');
  });

  it("S3 は aws login の手順（Viewer は --remote も）と、CSRF つきの「コンソールを開く」", async () => {
    const r = await page(normal, "/t/infra/a/333333333333/cli?role=readonly", INFRA);
    expect(r.status, r.body).toBe(200);
    expect(r.body).toContain("aws login --profile svc-a-prod-readonly");
    expect(r.body).toContain("aws login --remote");
    expect(r.body).toContain("共有の端末では aws logout");
    expect(r.body).toMatch(/name="csrf" value="[^"]+"/);
    expect(r.body).not.toContain("aws+svc-a-prod@example.com");
  });

  it("静的なファイルは /assets（入口の JWT）と /t/<team>/assets（チームの JWT）から返し、no-store にしない", async () => {
    const js = await page(normal, "/assets/portal.js", ENTRY_AUD);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).not.toBe("no-store");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    const css = await page(normal, "/t/infra/assets/portal.css", INFRA);
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await page(normal, "/t/infra/assets/portal.css", null)).status).toBe(401);
    expect((await page(normal, "/assets/other.js", ENTRY_AUD)).status).toBe(404);
    expect((await send(normal, { host: ISSUER_HOST, path: "/assets/portal.js" })).status).toBe(404);
  });
});
