// issuer の「外からの比較」の CLI（scripts/console/exposure-check.ts。mise タスク console:exposure-check）を実プロセスで動かす。
// 偽の DoH（127.0.0.1 の http。A は 127.0.0.1、AAAA は答えなし）と、偽の issuer の HTTPS サーバー（試験用の自己署名の証明書。
// 子プロセスには NODE_EXTRA_CA_CERTS で信頼させる。証明書の検査は止めない）を立てる。実 DNS・実 Cloudflare・実 AWS は使わない。
// 確かめること: 終了コード（0 一致 / 1 不一致 / 2 実行できない）、出力（[OK] / [NG]・結論）、
// 名前は DoH で引き、接続は IP でも SNI・Host はもとのホスト名、リダイレクトを追わない、証明書を信頼できなければ誤り、
// Admin の設定が無ければ Standard だけ、トークンの類（Authorization）を送らない。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateJwkThumbprint } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PublicJwk } from "../../src/console/signing/key";
import { adminConfig, workerConfig } from "../unit/console-worker-harness";
import { freePort, root } from "./console-e2e-kit";

type Doc = { status?: number; location?: string; body?: unknown; raw?: string };
type Seen = {
  host: string | undefined;
  sni: string | false | undefined;
  url: string;
  auth: string | undefined;
};

const std = workerConfig();
const adm = adminConfig();
const boundaries = std.boundaries as { name: string; issuer: string }[];
const adminIssuer = (adm.boundaries[0] as { issuer: string }).issuer;
const hostOf = (issuer: string) => new URL(issuer).host;
const HOSTS = [...new Set([...boundaries.map((b) => hostOf(b.issuer)), hostOf(adminIssuer)])];

let dir = "";
let certPath = "";
let https: HttpsServer;
let doh: Server;
let httpsPort = 0;
let dohBase = "";
const seen: Seen[] = [];
const dohSeen: string[] = [];
let dohBroken = false;
// issuer の URL → 文書（discovery・JWKS）の上書き。無ければ正しい文書を返す
let override: Record<string, Doc> = {};
const keys: Record<string, PublicJwk[]> = {};

async function makeJwk(): Promise<PublicJwk> {
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
  return { kty: "RSA", n: pub.n as string, e: "AQAB", kid, alg: "RS256", use: "sig" };
}

function bindingOf(kid: string): string {
  const t = kid.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
  return `CONSOLE_KEY_${[...bytes.slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** 正しい文書（設定の鍵どおり）。 */
function correct(issuer: string, path: string): Doc | undefined {
  if (path.endsWith("/.well-known/openid-configuration"))
    return { body: { issuer, jwks_uri: `${issuer}/.well-known/jwks.json` } };
  if (path.endsWith("/.well-known/jwks.json")) return { body: { keys: keys[issuer] } };
  return undefined;
}

const allIssuers = () => [...boundaries.map((b) => b.issuer), adminIssuer];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "awsbridge-exposure-cli-"));
  // 試験用の自己署名の証明書（SAN に偽の issuer のホスト）
  certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=awsbridge-exposure-e2e",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-addext",
      `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`openssl が失敗した: ${r.stderr}`);

  // 設定（生成物と wrangler の vars）
  const jwks = await Promise.all(allIssuers().flatMap(() => [makeJwk(), makeJwk()]));
  allIssuers().forEach((issuer, i) => {
    keys[issuer] =
      i === allIssuers().length - 1
        ? [jwks[i * 2] as PublicJwk]
        : [jwks[i * 2] as PublicJwk, jwks[i * 2 + 1] as PublicJwk];
  });
  const byBoundary = Object.fromEntries(
    boundaries.map((b) => [b.name, keys[b.issuer] as PublicJwk[]]),
  );
  writeFileSync(
    join(dir, "wrangler.console.jsonc"),
    `{\n  // 試験用\n  "name": "std",\n  "vars": ${JSON.stringify({
      CONSOLE_CURRENT_KEYS: JSON.stringify(
        Object.fromEntries(
          Object.entries(byBoundary).map(([b, ks]) => [
            b,
            { binding: bindingOf((ks[0] as PublicJwk).kid), kid: (ks[0] as PublicJwk).kid },
          ]),
        ),
      ),
      CONSOLE_PUBLIC_JWKS: JSON.stringify(byBoundary),
    })}\n}\n`,
  );
  writeFileSync(
    join(dir, "wrangler.console-admin.jsonc"),
    `{\n  "name": "adm",\n  "vars": ${JSON.stringify({ ADMIN_PUBLIC_JWKS: JSON.stringify(keys[adminIssuer]) })}\n}\n`,
  );
  mkdirSync(join(dir, ".generated/console"), { recursive: true });
  writeFileSync(join(dir, ".generated/console/worker.standard.json"), JSON.stringify(std));
  writeFileSync(join(dir, ".generated/console/worker.admin.json"), JSON.stringify(adm));

  // 偽の issuer（HTTPS）。Host ごとに、issuer のパスの文書を返す
  https = createHttpsServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req: IncomingMessage, res) => {
      seen.push({
        host: req.headers.host,
        sni: (req.socket as unknown as { servername?: string | false }).servername,
        url: req.url ?? "",
        auth: req.headers.authorization,
      });
      const host = req.headers.host ?? "";
      const path = req.url ?? "";
      const issuer = allIssuers().find(
        (i) => hostOf(i) === host && path.startsWith(`${new URL(i).pathname}/.well-known/`),
      );
      const doc = issuer
        ? (override[`${issuer}${path.slice(new URL(issuer).pathname.length)}`] ??
          correct(issuer, path))
        : undefined;
      if (!doc) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = doc.status ?? 200;
      if (doc.location) res.setHeader("location", doc.location);
      res.setHeader("content-type", "application/json");
      res.end(doc.raw ?? JSON.stringify(doc.body));
    },
  );
  httpsPort = await freePort();
  await new Promise<void>((r2) => https.listen(httpsPort, "127.0.0.1", r2));

  // 偽の DoH。A は 127.0.0.1、AAAA は答えなし（NODATA）
  doh = createHttpServer((req, res) => {
    const u = new URL(req.url ?? "", "http://x");
    dohSeen.push(`${u.searchParams.get("name")}/${u.searchParams.get("type")}`);
    res.setHeader("content-type", "application/dns-json");
    if (dohBroken) {
      res.statusCode = 500;
      res.end("broken");
      return;
    }
    res.end(
      JSON.stringify(
        u.searchParams.get("type") === "A"
          ? {
              Status: 0,
              Answer: [{ name: u.searchParams.get("name"), type: 1, TTL: 60, data: "127.0.0.1" }],
            }
          : { Status: 0 },
      ),
    );
  });
  const dohPort = await freePort();
  await new Promise<void>((r2) => doh.listen(dohPort, "127.0.0.1", r2));
  dohBase = `http://127.0.0.1:${dohPort}/dns-query`;
});

afterAll(() => {
  https?.close();
  doh?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  dohSeen.length = 0;
  dohBroken = false;
  override = {};
});

function exec(
  env: Record<string, string> = {},
  trustCert = true,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/console/exposure-check.ts")],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL: dohBase,
          AWSBRIDGE_CONSOLE_EXPOSURE_CONNECT_PORT: String(httpsPort),
          ...(trustCert ? { NODE_EXTRA_CA_CERTS: certPath } : {}),
          ...env,
        },
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

describe("console:exposure-check", () => {
  it("すべて一致なら 0。名前は DoH で引き、IP に接続しても SNI と Host はもとのホスト名。Authorization を送らない", async () => {
    const r = await exec();
    expect(r.out).not.toContain("[NG]");
    expect(r.out).toContain("[OK]");
    expect(r.out).toContain("結論: 外から取った issuer の文書は、設定の公開鍵と一致した");
    expect(r.status).toBe(0);
    // DoH で全ホストの A と AAAA を引いた（ホストごとに 1 回）
    for (const h of HOSTS) {
      expect(dohSeen.filter((x) => x === `${h}/A`)).toHaveLength(1);
      expect(dohSeen.filter((x) => x === `${h}/AAAA`)).toHaveLength(1);
    }
    // 文書ごとに 1 回（2 文書 × issuer の数）。SNI と Host が一致し、トークンを送らない
    expect(seen).toHaveLength(allIssuers().length * 2);
    for (const s of seen) {
      expect(HOSTS).toContain(s.host);
      expect(s.sni).toBe(s.host);
      expect(s.auth).toBeUndefined();
    }
  });

  it("Admin の JWKS に鍵が増えていれば 1（Standard は一致でも）", async () => {
    const extra = await makeJwk();
    override[`${adminIssuer}/.well-known/jwks.json`] = {
      body: { keys: [...(keys[adminIssuer] as PublicJwk[]), extra] },
    };
    const r = await exec();
    expect(r.status).toBe(1);
    expect(r.out).toContain("[NG] JWKS: 設定に無い鍵がある");
    expect(r.out).toContain("結論: 不一致あり");
    expect(r.out).not.toContain(extra.n);
  });

  it("Standard の鍵の中身（n）が違えば 1", async () => {
    const b = boundaries[1] as { issuer: string };
    const k = (keys[b.issuer] as PublicJwk[])[0] as PublicJwk;
    override[`${b.issuer}/.well-known/jwks.json`] = { body: { keys: [{ ...k, n: "AAAA" }] } };
    const r = await exec();
    expect(r.status).toBe(1);
    expect(r.out).toContain("中身が違う");
  });

  it("discovery が別の issuer を名乗れば 1", async () => {
    const b = boundaries[0] as { issuer: string };
    override[`${b.issuer}/.well-known/openid-configuration`] = {
      body: { issuer: "https://evil.example.com", jwks_uri: `${b.issuer}/.well-known/jwks.json` },
    };
    expect((await exec()).status).toBe(1);
  });

  it("リダイレクトは追わずに 1（行き先に要求を送らない）", async () => {
    override[`${adminIssuer}/.well-known/jwks.json`] = {
      status: 302,
      location: `${boundaries[0]?.issuer}/.well-known/jwks.json`,
      body: { keys: keys[adminIssuer] },
    };
    const r = await exec();
    expect(r.status).toBe(1);
    expect(r.out).toContain("リダイレクト");
    // Admin の JWKS を 1 回だけ取った（行き先を追って取り直していない）
    expect(
      seen.filter((s) => s.host === hostOf(adminIssuer) && s.url.endsWith("jwks.json")),
    ).toHaveLength(1);
  });

  it("JSON でない・404・DoH の失敗は 1（一致にしない）", async () => {
    override[`${adminIssuer}/.well-known/jwks.json`] = { raw: "<html>login</html>" };
    expect((await exec()).status).toBe(1);
    override = { [`${adminIssuer}/.well-known/openid-configuration`]: { status: 404, body: {} } };
    expect((await exec()).status).toBe(1);
    override = {};
    dohBroken = true;
    const r = await exec();
    expect(r.status).toBe(1);
    expect(r.out).toContain("[NG]");
  });

  it("証明書を信頼できなければ 1（検査を止めない）", async () => {
    const r = await exec({}, false);
    expect(r.status).toBe(1);
    expect(r.out).toContain("[NG]");
    expect(r.out).toContain("tls");
  });

  it("Admin の設定（worker.admin.json）が無ければ Standard だけ確かめて、その旨を出す", async () => {
    const saved = readFileSync(join(dir, ".generated/console/worker.admin.json"), "utf8");
    rmSync(join(dir, ".generated/console/worker.admin.json"));
    try {
      const r = await exec();
      expect(r.status).toBe(0);
      expect(r.out).toContain("Admin: 設定が無い");
      expect(seen.every((s) => s.host !== hostOf(adminIssuer))).toBe(true);
    } finally {
      writeFileSync(join(dir, ".generated/console/worker.admin.json"), saved);
    }
  });

  it("設定が読めなければ 2（wrangler の設定なし・vars が空）。要求は 1 つも送らない", async () => {
    const r = await exec({ AWSBRIDGE_CONSOLE_WRANGLER_CONFIG: "nope.jsonc" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("error:");
    expect(seen).toHaveLength(0);
    expect(dohSeen).toHaveLength(0);
    writeFileSync(join(dir, "empty.jsonc"), '{ "name": "x", "vars": {} }');
    expect((await exec({ AWSBRIDGE_CONSOLE_WRANGLER_CONFIG: "empty.jsonc" })).status).toBe(2);
  });

  it("DoH の宛先の上書きは手元（127.0.0.1）の http だけ。それ以外は 2", async () => {
    const r = await exec({
      AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL: "https://evil.example.com/dns-query",
    });
    expect(r.status).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
