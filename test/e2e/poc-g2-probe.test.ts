// G2 の試験用の issuer の道具（scripts/poc/g2/probe.ts。mise タスク poc:g2:probe:*）を実プロセスで通す。
// 鍵の生成 → wrangler deploy --dry-run（実際の wrangler でバンドルだけ）→ 書いた設定で wrangler dev を起動 → 公開内容の確認 →
// 127.0.0.1 の擬似の STS（wrangler dev の JWKS で JWT を検証する）に向けて見張り。隔離の条件で断る場合は STS・wrangler を呼ばない。
// 実 AWS・Cloudflare には接続しない。記録・鍵は一時ディレクトリ（AWSBRIDGE_G2_DEV_DIR）に置き、リポジトリの .secrets/ を触らない。
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findLeaks } from "../../scripts/poc/g2/common";
import { freePort, root } from "./console-e2e-kit";

const ZONE = "dev.example.com";
const HOST = `awsbridge-g2-probe-kid.${ZONE}`;
const ISSUER = `https://${HOST}/p`;
const ROLE = "arn:aws:iam::123456789012:role/awsbridge-g2-probe/AwsbridgeG2ProbeKid";
// 擬似の STS が返す認証情報（出力に出ないことを確かめる。形は実行時に組む）
const LEAK_KEY = ["ASIA", "LEAKLEAKLEAKLEAK"].join("");
const LEAK_SECRET = ["leak", "secret", "x".repeat(20)].join("-");
const LEAK_SESSION = ["leak", "session", "y".repeat(40)].join("-");

const dir = mkdtempSync(join(tmpdir(), "awsbridge-g2-probe-"));
const g2dir = join(dir, "g2");
let wrangler: ChildProcess | undefined;
let wranglerLogs = "";
let docsBase = "";

// ---- 擬似の STS（127.0.0.1）----
let sts: Server;
let stsBase = "";
type StsReq = { role: string; token: string };
const stsReqs: StsReq[] = [];

function okXml() {
  return `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${LEAK_KEY}</AccessKeyId><SecretAccessKey>${LEAK_SECRET}</SecretAccessKey><SessionToken>${LEAK_SESSION}</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/AwsbridgeG2ProbeKid/s</Arn><AssumedRoleId>AROAEXAMPLE:s</AssumedRoleId></AssumedRoleUser></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
}
// エラーの文面にトークンを入れて返す（道具が伏せることを確かめる）
const errXml = (token: string) =>
  `<ErrorResponse><Error><Type>Sender</Type><Code>InvalidIdentityToken</Code><Message>no key for ${token} in arn:aws:iam::123456789012:oidc-provider/${HOST}/p</Message></Error></ErrorResponse>`;

beforeAll(async () => {
  sts = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", async () => {
      const f = new URLSearchParams(body);
      const token = f.get("WebIdentityToken") ?? "";
      stsReqs.push({ role: f.get("RoleArn") ?? "", token });
      try {
        // 本物の STS と同じく、issuer の JWKS（wrangler dev）で検証する
        const jwks = createRemoteJWKSet(new URL(`${docsBase}/p/.well-known/jwks.json`));
        await jwtVerify(token, jwks, { issuer: ISSUER, audience: "awsbridge-g2-probe" });
        res.end(okXml());
      } catch {
        res.statusCode = 400;
        res.end(errXml(token));
      }
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => sts.listen(port, "127.0.0.1", r));
  stsBase = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  sts?.close();
  if (wrangler?.pid) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  stsReqs.length = 0;
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  for (const k of Object.keys(e))
    if (k.startsWith("AWSBRIDGE_") || k.startsWith("CLOUDFLARE_") || k.startsWith("AWS_"))
      delete e[k];
  return {
    ...e,
    AWSBRIDGE_G2_DEV_DIR: g2dir,
    AWSBRIDGE_G2_PROBE_ZONE: ZONE,
    AWSBRIDGE_G2_PROBE_STS_ENDPOINT: stsBase,
    // リポジトリの config/console.json を読まない
    AWSBRIDGE_CONSOLE_CONFIG: join(dir, "no-console.json"),
    WRANGLER_SEND_METRICS: "false",
    ...extra,
  };
}

function run(
  args: string[],
  e: Record<string, string> = env(),
  o: { killAfterMs?: number } = {},
): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      join(root, "node_modules/.bin/tsx"),
      [join(root, "scripts/poc/g2/probe.ts"), ...args],
      {
        cwd: root,
        env: e,
      },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      err += c;
    });
    if (o.killAfterMs !== undefined) setTimeout(() => p.kill("SIGINT"), o.killAfterMs);
    p.on("close", (status) => resolve({ status, out, err }));
  });
}

/** 出力と記録のファイルに JWT・認証情報・秘密鍵が無い。 */
function noLeaks(text: string) {
  expect(findLeaks(text, [LEAK_SECRET, LEAK_SESSION])).toEqual([]);
  expect(text).not.toMatch(/"d"\s*:/);
}

function recordFiles(): string {
  // 記録は鍵と別の場所（<dir>/records/）。鍵を消しても記録は残す（手順書 §4.1）
  const d = join(g2dir, "records");
  return readdirSync(d)
    .filter((f) => f.startsWith("probe-kid-") && f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(d, f), "utf8"))
    .join("\n");
}

describe("poc:g2:probe（実プロセス）", () => {
  it("keygen: 鍵を <dir>/probe/<issuer>/ に権限 600 で作り、出すのは kid の先頭 8 文字だけ。既存は上書きしない", async () => {
    for (const name of ["A", "B", "C"]) {
      const r = await run(["keygen", "--issuer", "kid", "--name", name]);
      expect(r.status, r.out + r.err).toBe(0);
      expect(r.out).toMatch(new RegExp(`name=${name} kid=[A-Za-z0-9_-]{8}…`));
      noLeaks(r.out + r.err);
      const file = join(g2dir, "probe", "kid", `key-${name}.json`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const jwk = JSON.parse(readFileSync(file, "utf8")) as { kid: string; d?: string };
      expect(jwk.d).toBeDefined();
      expect(r.out).not.toContain(jwk.kid);
    }
    const again = await run(["keygen", "--issuer", "kid", "--name", "A"]);
    expect(again.status).not.toBe(0);
    expect(again.err).toMatch(/上書きしません/);
  });

  it("deploy --dry-run: 実際の wrangler でバンドルし、Worker 名・Custom Domain は issuer ごと、workers.dev は無効", async () => {
    const r = await run(["deploy", "--issuer", "kid", "--keys", "A,B", "--dry-run"]);
    expect(r.status, r.out + r.err).toBe(0);
    noLeaks(r.out + r.err);
    const cfg = JSON.parse(
      readFileSync(join(g2dir, "probe", "kid", "wrangler.deploy.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(cfg.name).toBe("awsbridge-g2-probe-kid");
    expect(cfg.routes).toEqual([{ pattern: HOST, custom_domain: true }]);
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    const docs = JSON.parse(
      readFileSync(join(g2dir, "probe", "kid", "issuer-documents.json"), "utf8"),
    ) as { discovery: { issuer: string }; jwks: { keys: { kid: string; d?: string }[] } };
    expect(docs.discovery.issuer).toBe(ISSUER);
    expect(docs.jwks.keys).toHaveLength(2);
    expect(docs.jwks.keys.every((k) => k.d === undefined)).toBe(true);
  });

  it("書いた設定で wrangler dev を起動し、check で公開内容とヘッダー（no-store）を確かめる", async () => {
    const cfgFile = join(g2dir, "probe", "kid", "wrangler.deploy.json");
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
    // 手元の起動では Custom Domain を外す（wrangler dev が Cloudflare に問い合わせないように）
    const { routes: _r, ...devCfg } = cfg;
    const devFile = join(dir, "wrangler.dev.json");
    writeFileSync(devFile, JSON.stringify(devCfg));
    const port = await freePort();
    docsBase = `http://127.0.0.1:${port}`;
    wrangler = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        devFile,
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        join(dir, "state"),
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true, env: env() },
    );
    wrangler.stdout?.on("data", (d) => {
      wranglerLogs += d;
    });
    wrangler.stderr?.on("data", (d) => {
      wranglerLogs += d;
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`${docsBase}/p/.well-known/jwks.json`)).status === 200) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`wrangler dev did not start\n${wranglerLogs}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await run(
      ["check", "--issuer", "kid"],
      env({ AWSBRIDGE_G2_PROBE_DOCS_BASE: docsBase }),
    );
    expect(r.status, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/\[OK\] discovery/);
    expect(r.out).toMatch(/\[OK\] JWKS/);
    expect(r.out).toMatch(/cache-control: no-store/i);
    noLeaks(r.out + r.err);
  });

  it("watch: 指定の kid ごとに新しい JWT で STS を呼び、時刻・成否・エラーコードを 1 行ずつ出す（JWT・認証情報は出さない）", async () => {
    const r = await run([
      "watch",
      "--issuer",
      "kid",
      "--role-arn",
      ROLE,
      "--keys",
      "A,C",
      "--interval",
      "1",
      "--duration",
      "1",
    ]);
    expect(r.status, r.out + r.err).toBe(0);
    const lines = r.out.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines)
      expect(l).toMatch(/A\[[A-Za-z0-9_-]{8}\]=OK .*C\[[A-Za-z0-9_-]{8}\]=InvalidIdentityToken/);
    // 回ごと・鍵ごとに新しい JWT（jti が違う）。aud・exp を確かめる
    expect(stsReqs.length).toBe(lines.length * 2);
    const jtis = new Set(stsReqs.map((q) => decodeJwt(q.token).jti));
    expect(jtis.size).toBe(stsReqs.length);
    for (const q of stsReqs) {
      const c = decodeJwt(q.token);
      expect(c.aud).toBe("awsbridge-g2-probe");
      expect((c.exp as number) - (c.iat as number)).toBe(300);
      expect(q.role).toBe(ROLE);
    }
    noLeaks(r.out + r.err);
    const records = recordFiles();
    expect(records).toContain('"code":"InvalidIdentityToken"');
    noLeaks(records);
    for (const q of stsReqs) expect(r.out + r.err + records).not.toContain(q.token);
  });

  it("watch の延長: 最初の区間のあと間隔を広げ、見張る kid が断られ続けたら止める", async () => {
    const r = await run([
      "watch",
      "--issuer",
      "kid",
      "--role-arn",
      ROLE,
      "--keys",
      "C,B",
      "--interval",
      "1",
      "--duration",
      "1",
      "--extend-interval",
      "1",
      "--max-duration",
      "30",
      "--until-refused",
      "C",
      "--stop-after-refused",
      "2",
    ]);
    expect(r.status, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/止めた理由: refused/);
  });

  it("Ctrl-C（SIGINT）でも要約を出して終わる", async () => {
    const r = await run(
      [
        "watch",
        "--issuer",
        "kid",
        "--role-arn",
        ROLE,
        "--keys",
        "A",
        "--interval",
        "1",
        "--duration",
        "60",
      ],
      env(),
      { killAfterMs: 3500 },
    );
    expect(r.out).toMatch(/止めた理由: interrupted/);
    expect(r.out).toContain("| A |");
  });

  describe("隔離の条件で断る（STS を呼ばない）", () => {
    it("コンソールのロール（/awsbridge-console/ の下）", async () => {
      const r = await run([
        "watch",
        "--issuer",
        "kid",
        "--role-arn",
        "arn:aws:iam::123456789012:role/awsbridge-console/admin/FederatedAwsBridgeAdministrator",
        "--keys",
        "A",
        "--duration",
        "0",
      ]);
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/awsbridge-console/);
      expect(stsReqs).toEqual([]);
    });

    it("aud が awsbridge-console", async () => {
      const r = await run(
        ["watch", "--issuer", "kid", "--role-arn", ROLE, "--keys", "A", "--duration", "0"],
        env({ AWSBRIDGE_G2_PROBE_AUDIENCE: "awsbridge-console" }),
      );
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/aud/);
      expect(stsReqs).toEqual([]);
    });

    it("issuer のホストが本物の issuer のホストの一覧にある（watch と deploy）", async () => {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const log = join(dir, "pnpm.log");
      writeFileSync(log, "");
      writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$@" >> ${log}\n`);
      chmodSync(join(bin, "pnpm"), 0o755);
      const e = env({
        AWSBRIDGE_G2_PROBE_REAL_HOSTS: HOST,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      const w = await run(
        ["watch", "--issuer", "kid", "--role-arn", ROLE, "--keys", "A", "--duration", "0"],
        e,
      );
      expect(w.status).not.toBe(0);
      expect(w.err).toMatch(/本物/);
      const d = await run(["deploy", "--issuer", "kid", "--keys", "A"], e);
      expect(d.status).not.toBe(0);
      expect(d.err).toMatch(/本物/);
      expect(stsReqs).toEqual([]);
      expect(readFileSync(log, "utf8")).toBe("");
    });
  });

  it("forget: 試験用の issuer の手元の鍵・文書・設定を消す（記録は残す）", async () => {
    const r = await run(["forget", "--issuer", "kid"]);
    expect(r.status, r.out + r.err).toBe(0);
    expect(() => statSync(join(g2dir, "probe", "kid"))).toThrow();
    expect(recordFiles()).toContain('"ok":true');
  });
});
