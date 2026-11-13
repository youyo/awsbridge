// G2 の発行の見張り（scripts/poc/g2/issue-watch.ts。mise タスク poc:g2:issue-watch）を実プロセスで通す。
// ポータルは 127.0.0.1 の擬似サーバー（Cookie・Origin・Content-Type・CSRF を確かめ、成功ならサインインのトークンつきの 302）。
// 確かめること: 出すのは時刻・HTTP の状態・エラーコードだけ（Cookie・CSRF・Location を出さない）、終わったら Cookie のファイルを消す。
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findLeaks } from "../../scripts/poc/g2/common";
import { freePort, root } from "./console-e2e-kit";

// 秘密の形の値は実行時に組む（gitleaks の誤検知を避ける）
const COOKIE = ["cookie", "value", "q".repeat(32)].join("-");
const SIGNIN_TOKEN = ["signin", "token", "w".repeat(32)].join("-");
const ACCOUNT = "123456789012";

const dir = mkdtempSync(join(tmpdir(), "awsbridge-g2-issue-"));
const g2dir = join(dir, "g2");
const cookies = join(g2dir, "cookies");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let server: Server;
let base = "";
type Req = {
  method: string;
  url: string;
  origin?: string | undefined;
  cookie?: string | undefined;
  body: string;
};
const reqs: Req[] = [];
const issuedCsrf: string[] = [];
let mode: "ok" | "deny" | "access" = "ok";
let seq = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      reqs.push({
        method: req.method ?? "",
        url: req.url ?? "",
        origin: req.headers.origin,
        cookie: req.headers.cookie,
        body,
      });
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.headers.cookie !== `CF_Authorization=${COOKIE}` || mode === "access") {
        res.statusCode = 302;
        res.setHeader(
          "location",
          "https://example-team.cloudflareaccess.com/cdn-cgi/access/login/x",
        );
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === `/t/g2std/a/${ACCOUNT}?role=viewer`) {
        const csrf = ["v1", String(1_800_000_000 + ++seq), "C".repeat(43)].join(".");
        issuedCsrf.push(csrf);
        res.end(
          `<form method="post" action="/t/g2std/login"><input type="hidden" name="csrf" value="${csrf}"></form>`,
        );
        return;
      }
      if (req.method === "POST" && req.url === "/t/g2std/login") {
        const f = new URLSearchParams(body);
        const fail = (status: number, code: string) => {
          res.statusCode = status;
          res.end(`<p>問い合わせるときに貼る情報: code <code>${code}</code></p>`);
        };
        // 本物の Worker と同じ順: Origin → Content-Type → CSRF → 行
        if (req.headers.origin !== base) return fail(403, "forbidden_origin");
        if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded"))
          return fail(415, "unsupported_media_type");
        if (f.get("csrf") !== issuedCsrf.at(-1)) return fail(403, "csrf_failed");
        if (mode === "deny") return fail(404, "not_listed");
        if (f.get("entry") !== `${ACCOUNT}:viewer`) return fail(404, "not_listed");
        res.statusCode = 302;
        res.setHeader(
          "location",
          `https://signin.aws.amazon.com/federation?Action=login&SigninToken=${SIGNIN_TOKEN}`,
        );
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end(`<p>code <code>not_found</code></p>`);
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  reqs.length = 0;
  issuedCsrf.length = 0;
  mode = "ok";
});

function cookieFile(name = "g2std.txt"): string {
  mkdirSync(cookies, { recursive: true });
  const f = join(cookies, name);
  writeFileSync(f, `${COOKIE}\n`, { mode: 0o600 });
  return f;
}

function env(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("AWSBRIDGE_")) e[k] = v;
  return { ...e, AWSBRIDGE_G2_DEV_DIR: g2dir };
}

function run(args: string[], o: { killAfterMs?: number } = {}) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/poc/g2/issue-watch.ts"), ...args],
      { cwd: root, env: env() },
    );
    let out = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      out += c;
    });
    if (o.killAfterMs !== undefined) setTimeout(() => p.kill("SIGINT"), o.killAfterMs);
    p.on("close", (status) => resolve({ status, out }));
  });
}

const target = () => [
  "--portal",
  base,
  "--team",
  "g2std",
  "--account",
  ACCOUNT,
  "--role",
  "viewer",
];

function records(): string {
  const d = join(g2dir, "records");
  if (!existsSync(d)) return "";
  return readdirSync(d)
    .filter((f) => f.startsWith("issue-watch-"))
    .map((f) => readFileSync(join(d, f), "utf8"))
    .join("\n");
}

function noLeaks(text: string) {
  expect(findLeaks(text, [COOKIE, SIGNIN_TOKEN, ...issuedCsrf])).toEqual([]);
  expect(text).not.toContain(ACCOUNT);
  expect(text).not.toContain("signin.aws.amazon.com");
}

describe("poc:g2:issue-watch（127.0.0.1 の擬似のポータル）", () => {
  it("GET で CSRF を取り、POST /t/<team>/login を N 秒おきに行う。出すのは時刻・HTTP の状態・コードだけ。終わったら Cookie を消す", async () => {
    const file = cookieFile();
    const r = await run([...target(), "--cookie-file", file, "--interval", "1", "--count", "2"]);
    expect(r.status, r.out).toBe(0);
    const lines = r.out.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/team=g2std get=200 post=302 issued$/);
    // 回ごとに GET してから POST（CSRF は毎回取り直す）。Origin はポータルのオリジン
    expect(reqs.map((q) => q.method)).toEqual(["GET", "POST", "GET", "POST"]);
    for (const q of reqs.filter((x) => x.method === "POST")) expect(q.origin).toBe(base);
    expect(existsSync(file)).toBe(false);
    expect(r.out).toMatch(/Cookie のファイルを消しました: g2std\.txt \d{4}-\d\d-\d\dT/);
    noLeaks(r.out);
    noLeaks(records());
    expect(records()).toContain('"code":"issued"');
  });

  it("--keep-cookie なら消さない", async () => {
    const file = cookieFile();
    const r = await run([
      ...target(),
      "--cookie-file",
      file,
      "--interval",
      "1",
      "--count",
      "1",
      "--keep-cookie",
    ]);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(r.out).toMatch(/Cookie のファイルを残しました/);
    rmSync(file);
  });

  it("断られたらエラーの画面の code、Access のログインへの 302 は access_login_redirect", async () => {
    mode = "deny";
    const deny = await run([
      ...target(),
      "--cookie-file",
      cookieFile(),
      "--interval",
      "1",
      "--count",
      "1",
    ]);
    expect(deny.out).toMatch(/get=200 post=404 not_listed$/m);
    mode = "access";
    const acc = await run([
      ...target(),
      "--cookie-file",
      cookieFile(),
      "--interval",
      "1",
      "--count",
      "1",
    ]);
    expect(acc.out).toMatch(/get=302 access_login_redirect$/m);
    // GET で断られたら POST しない
    expect(reqs.filter((q) => q.method === "POST")).toHaveLength(1);
    noLeaks(deny.out + acc.out);
  });

  it("Ctrl-C（SIGINT）でも要約を出し、Cookie を消す", async () => {
    const file = cookieFile();
    const r = await run(
      [...target(), "--cookie-file", file, "--interval", "1", "--duration", "60"],
      {
        killAfterMs: 2500,
      },
    );
    expect(existsSync(file)).toBe(false);
    expect(r.out).toMatch(/Cookie のファイルを消しました/);
    expect(r.out).toContain("| g2std |");
    noLeaks(r.out);
  });

  it("Cookie のファイルが <g2 dir>/cookies/ の外なら断り、何も呼ばず、そのファイルを消さない", async () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, COOKIE);
    const r = await run([...target(), "--cookie-file", outside, "--count", "1"]);
    expect(r.status).not.toBe(0);
    expect(existsSync(outside)).toBe(true);
    expect(reqs).toEqual([]);
    noLeaks(r.out);
  });

  it("本物の Administrator（--role administrator）には使わない（何も呼ばない。Cookie は消す）", async () => {
    const file = cookieFile();
    const r = await run([
      "--portal",
      base,
      "--team",
      "g2adm",
      "--account",
      ACCOUNT,
      "--role",
      "administrator",
      "--cookie-file",
      file,
      "--count",
      "1",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Administrator/);
    expect(reqs).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});
