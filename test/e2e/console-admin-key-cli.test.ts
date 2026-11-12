// コンソールログインの Admin の署名鍵の運用の CLI（scripts/console/admin-key.ts。mise タスク console:admin-key:*）を実プロセスで動かす。
// Cloudflare API は手元（127.0.0.1）の擬似サーバー（AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE は 127.0.0.1 だけ受け付ける）。実 API は呼ばない。
// 確かめること: --yes が無ければ API を呼ばない、put は secret_key の本文で PUT し、鍵の値とトークンを出力にもファイルにも残さない、
// 同じ名前があれば PUT しない、retire は今の鍵を消さない。
// CSRF の鍵の投入（scripts/console/secrets-admin.ts。console:secrets:admin）も動かす: secret_text で Admin の Worker に入れ、値を残さない。
// Standard 用のトークン・アカウント ID・宛先の変数を読まない。
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateJwkThumbprint } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bindingNameForKid } from "../../src/console/admin/key";
import { freePort, root } from "./console-e2e-kit";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "awsbridge-console-admin";
// トークンの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const TOKEN = ["e2e", "cf", "token", "x".repeat(32)].join("-");

type Req = { method: string; url: string; auth: string | undefined; body: string };
let server: Server;
let base = "";
const reqs: Req[] = [];
let broken = false;
let dir = "";
let current = { binding: "", kid: "", publicJwk: {} as Record<string, string> };

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
        auth: req.headers.authorization,
        body,
      });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        // secret の一覧。broken のときは読めない（500）
        res.statusCode = broken ? 500 : 200;
        res.end(JSON.stringify(broken ? { success: false } : { success: true, result: [] }));
        return;
      }
      if (req.method === "PUT") {
        // 受け取った名前と型をそのまま返す（署名鍵は secret_key、CSRF の鍵は secret_text）
        const { name, type } = JSON.parse(body) as { name: string; type: string };
        res.end(JSON.stringify({ success: true, result: { name, type } }));
        return;
      }
      res.end(JSON.stringify({ success: true, result: null }));
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;

  // 今の鍵（公開鍵だけ。秘密鍵はこの試験に要らない）
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = await calculateJwkThumbprint({ kty: "RSA", n: pub.n as string, e: "AQAB" });
  current = {
    binding: bindingNameForKid(kid),
    kid,
    publicJwk: { kty: "RSA", n: pub.n as string, e: "AQAB", kid, alg: "RS256", use: "sig" },
  };
  dir = mkdtempSync(join(tmpdir(), "awsbridge-admin-key-cli-"));
  writeFileSync(
    join(dir, "wrangler.admin.jsonc"),
    `{\n  // 試験用\n  "name": "${SCRIPT}",\n  "vars": ${JSON.stringify({
      ADMIN_CURRENT_KEY: JSON.stringify({ binding: current.binding, kid }),
      ADMIN_PUBLIC_JWKS: JSON.stringify([current.publicJwk]),
    })}\n}\n`,
  );
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  reqs.length = 0;
  broken = false;
});

/** 実プロセスで動かす（同じプロセスの擬似サーバーが応答できるよう、spawnSync ではなく非同期で待つ）。 */
function exec(
  args: string[],
  env: Record<string, string>,
  script = "admin-key.ts",
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console", script), ...args],
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

const adminEnv = () => ({
  AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID: ACCOUNT,
  AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN: TOKEN,
  AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE: base,
  AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG: join(dir, "wrangler.admin.jsonc"),
  AWSBRIDGE_CONSOLE_OUT_DIR: join(dir, "out"),
});

function run(args: string[], script = "admin-key.ts") {
  return exec(args, adminEnv(), script);
}

function filesUnder(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("console:admin-key:put", () => {
  it("--yes が無ければ、何をするかを表示して終了コード 0。Cloudflare API を呼ばない", async () => {
    const r = await run(["put"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("--yes");
    expect(reqs).toHaveLength(0);
  });

  it("--yes: GET（同じ名前が無いこと）→ PUT（secret_key）。鍵の値とトークンは出力にもファイルにも残らない", async () => {
    const before = filesUnder(dir);
    const r = await run(["put", "--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(reqs.map((x) => x.method)).toEqual(["GET", "PUT"]);
    for (const x of reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
    const put = JSON.parse((reqs[1] as Req).body) as {
      name: string;
      type: string;
      format: string;
      usages: string[];
      key_jwk: Record<string, string>;
    };
    expect(reqs[1]?.url).toBe(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`);
    expect(reqs[0]?.url).toBe(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`);
    expect(put).toMatchObject({ type: "secret_key", format: "jwk", usages: ["sign"] });
    expect(put.name).toMatch(/^ADMIN_KEY_[0-9A-F]{16}$/);
    expect(put.name).not.toBe(current.binding);
    expect(r.out).toContain(put.name);
    // 次に入れる vars（旧い公開鍵と新しい公開鍵を並べたもの）
    expect(r.out).toContain(current.kid);
    const secrets = ["d", "p", "q", "dp", "dq", "qi"].map((m) => put.key_jwk[m] as string);
    for (const v of secrets) expect(v.length).toBeGreaterThan(40);
    for (const v of [...secrets, TOKEN]) expect(r.out).not.toContain(v);
    // 作業ディレクトリに新しいファイルを作らず、どのファイルにも鍵の値が無い
    expect(filesUnder(dir)).toEqual(before);
    for (const f of filesUnder(dir)) {
      const text = readFileSync(f, "utf8");
      for (const v of secrets) expect(text).not.toContain(v);
    }
  });

  it("--yes でも、secret の一覧を読めなければ（同じ名前が無いと確かめられなければ）PUT しない（終了コード 1）", async () => {
    broken = true;
    const r = await run(["put", "--yes"]);
    expect(r.status).toBe(1);
    expect(reqs.map((x) => x.method)).toEqual(["GET"]);
  });
});

describe("console:admin-key:retire", () => {
  it("今の署名鍵は --yes でも消さない（終了コード 1・API を呼ばない）", async () => {
    const r = await run(["retire", "--binding", current.binding, "--yes"]);
    expect(r.status).toBe(1);
    expect(reqs).toHaveLength(0);
  });

  it("JWKS に無い旧い鍵: --yes が無ければ表示だけ。--yes でも、デプロイ済みの Admin の issuer の JWKS を確かめられなければ消さない", async () => {
    const old = "ADMIN_KEY_0123456789ABCDEF";
    expect((await run(["retire", "--binding", old])).status).toBe(0);
    expect(reqs).toHaveLength(0);
    // 試験の作業ディレクトリには生成物（worker.admin.json）が無いので、Admin の issuer が分からない
    const r = await run(["retire", "--binding", old, "--yes"]);
    expect(r.status, r.out).toBe(1);
    expect(reqs).toHaveLength(0);
  });
});

describe("console:secrets:admin（Admin の CSRF の鍵。G2 の論点 5）", () => {
  it("--yes が無ければ表示だけ（API を呼ばない）。--yes で Admin の Worker に secret_text の CONSOLE_CSRF_KEY を入れ、値を出力にもファイルにも残さない", async () => {
    const plan = await run([], "secrets-admin.ts");
    expect(plan.status, plan.out).toBe(0);
    expect(plan.out).toContain("console:secrets:admin");
    expect(reqs).toHaveLength(0);
    const before = filesUnder(dir);
    const r = await run(["--yes"], "secrets-admin.ts");
    expect(r.status, r.out).toBe(0);
    expect(reqs.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET /accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`,
      `PUT /accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`,
    ]);
    for (const x of reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
    const put = JSON.parse((reqs[1] as Req).body) as { name: string; type: string; text: string };
    expect(put).toMatchObject({ name: "CONSOLE_CSRF_KEY", type: "secret_text" });
    expect(put.text).toMatch(/^[0-9a-f]{64}$/);
    expect(r.out).not.toContain(put.text);
    expect(r.out).not.toContain(TOKEN);
    expect(filesUnder(dir)).toEqual(before);
    for (const f of filesUnder(dir)) expect(readFileSync(f, "utf8")).not.toContain(put.text);
  });

  it("初回（vars の鍵が空。鍵を入れる前）でも入れられる", async () => {
    const cfg = join(dir, "wrangler.admin-empty.jsonc");
    writeFileSync(
      cfg,
      `{\n  // 試験用（初回）\n  "name": "${SCRIPT}",\n  "vars": { "ADMIN_CURRENT_KEY": "", "ADMIN_PUBLIC_JWKS": "" }\n}\n`,
    );
    const r = await exec(
      ["--yes"],
      { ...adminEnv(), AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG: cfg },
      "secrets-admin.ts",
    );
    expect(r.status, r.out).toBe(0);
    expect(reqs.map((x) => x.method)).toEqual(["GET", "PUT"]);
  });

  it("Standard 用の変数（アカウント ID・トークン・宛先・wrangler の設定）は読まない", async () => {
    const STD_TOKEN = ["e2e", "std", "token", "s".repeat(32)].join("-");
    const r = await exec(
      ["--yes"],
      {
        AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID: ACCOUNT,
        AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN: STD_TOKEN,
        AWSBRIDGE_CONSOLE_STANDARD_CF_API_BASE: base,
        AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG: join(dir, "wrangler.admin.jsonc"),
      },
      "secrets-admin.ts",
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID");
    expect(r.out).not.toContain(STD_TOKEN);
    expect(reqs).toHaveLength(0);
    // Admin の変数がそろっていれば、Standard のトークンがあっても Admin のトークンを使う
    const ok = await exec(
      ["--yes"],
      { ...adminEnv(), AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN: STD_TOKEN },
      "secrets-admin.ts",
    );
    expect(ok.status, ok.out).toBe(0);
    for (const x of reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("Cloudflare API の宛先を 127.0.0.1 以外に向けられない（トークンを外へ送らない）", async () => {
    const r = await exec(
      ["--yes"],
      { ...adminEnv(), AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE: "https://evil.example.com" },
      "secrets-admin.ts",
    );
    expect(r.status).toBe(1);
    expect(r.out).not.toContain(TOKEN);
    expect(reqs).toHaveLength(0);
  });
});

describe("宛先の上書き", () => {
  it("Cloudflare API の宛先を 127.0.0.1 以外に向けられない（トークンを外へ送らない）", async () => {
    const r = await exec(["put", "--yes"], {
      AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID: ACCOUNT,
      AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN: TOKEN,
      AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE: "https://evil.example.com",
      AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG: join(dir, "wrangler.admin.jsonc"),
    });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain(TOKEN);
    expect(reqs).toHaveLength(0);
  });
});
