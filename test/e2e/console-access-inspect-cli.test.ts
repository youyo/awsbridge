// Access アプリの検査の CLI（scripts/console/access-inspect.ts。mise タスク console:access:inspect）を実プロセスで動かす。
// Cloudflare API は手元（127.0.0.1）の擬似サーバー（AWSBRIDGE_CONSOLE_ACCESS_CF_API_BASE は 127.0.0.1 だけ受け付ける）。実 API は呼ばない。
// 確かめること: GET だけを呼ぶ（書き込みの method を 1 つも送らない）、Authorization にトークンを載せる、AUD とトークンを出力に出さない、
// Cookie Path が無効なら終了コード 1（R-H では警告で 0）、トークン・入力が無ければ API を呼ばずに終了コード 2、API の失敗は 2。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccessAppSnapshot } from "../../src/console/access-inspect";
import { AUDS, accessSummary, goodApps } from "../unit/console-access-fixtures";
import { freePort, root } from "./console-e2e-kit";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
// トークンの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const TOKEN = ["e2e", "cf", "token", "z".repeat(32)].join("-");
const PER_PAGE = 2; // 擬似サーバーは 2 件ずつ返す（ページ送りも通す）

type Req = { method: string; url: string; auth: string | undefined };
let server: Server;
let base = "";
const reqs: Req[] = [];
let apps: AccessAppSnapshot[] = [];
let failStatus = 0;
let dir = "";

/** Cloudflare の応答の形（snake_case）にする。 */
const toApi = (a: AccessAppSnapshot) => ({
  id: `id-${a.aud.slice(0, 8)}`,
  name: "app",
  aud: a.aud,
  type: a.type,
  destinations: a.destinations.map((uri) => ({ type: "public", uri })),
  ...(a.pathCookie === undefined ? {} : { path_cookie_attribute: a.pathCookie }),
});

beforeAll(async () => {
  server = createServer((req, res) => {
    reqs.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (failStatus) {
      res.statusCode = failStatus;
      res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "forbidden" }] }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || u.pathname !== `/accounts/${ACCOUNT}/access/apps`) {
      res.statusCode = 405;
      res.end(JSON.stringify({ success: false }));
      return;
    }
    const page = Number(u.searchParams.get("page") ?? "1");
    const total = Math.max(1, Math.ceil(apps.length / PER_PAGE));
    res.end(
      JSON.stringify({
        success: true,
        result: apps.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(toApi),
        result_info: { page, per_page: PER_PAGE, total_pages: total },
      }),
    );
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), "awsbridge-access-inspect-cli-"));
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  reqs.length = 0;
  failStatus = 0;
  apps = goodApps();
  writeSummary(accessSummary());
});

function writeSummary(summary: unknown): void {
  writeFileSync(join(dir, "access.json"), JSON.stringify(summary));
}

/** 実プロセスで動かす（同じプロセスの擬似サーバーが応答できるよう、非同期で待つ）。 */
function exec(env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console/access-inspect.ts")],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      out += c;
    });
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, out }));
  });
}

const baseEnv = (): Record<string, string> => ({
  AWSBRIDGE_CONSOLE_OUT_DIR: dir,
  AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID: ACCOUNT,
  AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN: TOKEN,
  AWSBRIDGE_CONSOLE_ACCESS_CF_API_BASE: base,
});

/** 出力に出してはいけない値（AUD・トークン・アカウント ID）。 */
function expectNoSecrets(out: string): void {
  for (const v of [...Object.values(AUDS), TOKEN, ACCOUNT]) expect(out).not.toContain(v);
}

describe("console:access:inspect", () => {
  it("正しい形なら終了コード 0。呼ぶのは GET だけで、ページを最後まで読み、Authorization にトークンを載せる", async () => {
    const r = await exec(baseEnv());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("errors: 0, warnings: 0");
    // 5 件のアプリを 2 件ずつ → 3 ページ
    expect(reqs.map((x) => x.method)).toEqual(["GET", "GET", "GET"]);
    for (const x of reqs) {
      expect(x.url.startsWith(`/accounts/${ACCOUNT}/access/apps?`)).toBe(true);
      expect(x.auth).toBe(`Bearer ${TOKEN}`);
    }
    expectNoSecrets(r.out);
  });

  it("R-P で Cookie Path が無効なアプリ（チームと入口）があれば終了コード 1。AUD を出さずに、対象の名前を出す", async () => {
    apps = goodApps().map((a) =>
      a.aud === AUDS.dev || a.aud === AUDS.entryAdmin ? { ...a, pathCookie: false } : a,
    );
    const r = await exec(baseEnv());
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ERROR\s+path_cookie_disabled\s+team:dev/);
    expect(r.out).toMatch(/ERROR\s+path_cookie_disabled\s+entry:admin/);
    expect(r.out).toContain("errors: 2, warnings: 0");
    expect(reqs.every((x) => x.method === "GET")).toBe(true);
    expectNoSecrets(r.out);
  });

  it("Cookie Path の項目が無い（欠落）アプリも誤り", async () => {
    apps = goodApps().map((a) => (a.aud === AUDS.sec ? { ...a, pathCookie: undefined } : a));
    const r = await exec(baseEnv());
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ERROR\s+path_cookie_disabled\s+team:sec/);
  });

  it("AUD に当たるアプリが無い・対象が違うときは誤り", async () => {
    apps = goodApps()
      .filter((a) => a.aud !== AUDS.legacy)
      .map((a) =>
        a.aud === AUDS.dev ? { ...a, destinations: ["awsbridge-console.example.com/t/x"] } : a,
      );
    const r = await exec(baseEnv());
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ERROR\s+access_app_missing\s+team:legacy/);
    expect(r.out).toMatch(/ERROR\s+access_app_destination_mismatch\s+team:dev/);
    expectNoSecrets(r.out);
  });

  it("R-H（routing: host）では Cookie Path の無効は警告で、終了コード 0", async () => {
    writeSummary(accessSummary({ routing: "host" }));
    apps = [
      { ...goodApps()[0], pathCookie: false },
      goodApps()[1],
      { ...goodApps()[2], destinations: ["dev.awsbridge-console.example.com"], pathCookie: false },
      { ...goodApps()[3], destinations: ["legacy.awsbridge-console.example.com"] },
      { ...goodApps()[4], destinations: ["sec.awsbridge-admin-console.example.com"] },
    ] as AccessAppSnapshot[];
    const r = await exec(baseEnv());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARN\s+path_cookie_disabled\s+team:dev/);
    expect(r.out).toContain("errors: 0, warnings: 2");
  });

  it("トークンが無ければ API を呼ばずに終了コード 2（wrangler の OAuth には落とさない）", async () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN;
    const r = await exec(env);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN");
    expect(reqs).toHaveLength(0);
  });

  it("別の変数（Standard・Admin の道具のトークン）は使わない", async () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN;
    const r = await exec({
      ...env,
      AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN: TOKEN,
      AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN: TOKEN,
      CLOUDFLARE_API_TOKEN: TOKEN,
    });
    expect(r.status, r.out).toBe(2);
    expect(reqs).toHaveLength(0);
  });

  it("access.json が無ければ、生成を促して終了コード 2。API を呼ばない", async () => {
    const r = await exec({ ...baseEnv(), AWSBRIDGE_CONSOLE_OUT_DIR: join(dir, "nothing") });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("console:config:generate");
    expect(reqs).toHaveLength(0);
  });

  it("API が拒否したら（403）終了コード 2。トークンを出さない", async () => {
    failStatus = 403;
    const r = await exec(baseEnv());
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("403");
    expectNoSecrets(r.out);
    expect(reqs.every((x) => x.method === "GET")).toBe(true);
  });

  it("宛先の上書きは 127.0.0.1 だけ（トークンを外へ送らない）。API を呼ばない", async () => {
    const r = await exec({
      ...baseEnv(),
      AWSBRIDGE_CONSOLE_ACCESS_CF_API_BASE: "https://example.com",
    });
    expect(r.status, r.out).toBe(2);
    expect(reqs).toHaveLength(0);
    expectNoSecrets(r.out);
  });
});
