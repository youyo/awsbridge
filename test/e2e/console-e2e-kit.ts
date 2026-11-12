// コンソールログインの Worker（Standard・Admin）を wrangler dev で起動して試すための共通の道具（負の試験 console-negative.test.ts が使う）。
// Host ヘッダーを指定した送信、wrangler dev の起動と停止、擬似の Access（certs）・STS・getSigninToken のサーバー（受信数を数える）。
// 実 AWS・Cloudflare は呼ばない。値はすべてダミー。
import { type ChildProcess, spawn } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import type { JWK } from "jose";

export const root = new URL("../../", import.meta.url).pathname;

export type Instance = { proc: ChildProcess; base: string; logs: string[] };

export type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** Host ヘッダーを指定して送る（Node の fetch は Host を差し替えられないので node:http を使う）。 */
export function send(
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
        // 要求ごとに新しい接続にする。本文を読まずに断った応答のあとで接続を使い回すと、残った本文が次の要求の先頭と解釈される（501）
        agent: false,
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

/** wrangler dev を起動し、ready() が真になるまで待つ。state は name ごとに分ける。 */
export async function startWrangler(o: {
  name: string;
  configPath: string;
  stateDir: string;
  vars?: Record<string, string>;
  ready: (inst: Instance) => Promise<boolean>;
}): Promise<Instance> {
  const port = await freePort();
  // 複数を同時に起動するので、inspector のポート（既定 9230）も空いているものを渡す
  const inspectorPort = await freePort();
  const logs: string[] = [];
  const proc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      o.configPath,
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
      join(o.stateDir, `state-${o.name}`),
      ...Object.entries(o.vars ?? {}).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if (await o.ready(inst)) return inst;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev (${o.name}) did not become ready\n${logs.join("")}`);
}

export function stopWrangler(inst: Instance | undefined) {
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

export type FakeServer = {
  base: string;
  /** STS と getSigninToken の受信（発行の経路が実際に呼んだもの）。 */
  seen: { sts: URLSearchParams[]; signin: URLSearchParams[] };
  /** Access の certs を取りにきた回数（Worker が検証まで進んだ印）。 */
  certsHits: () => number;
  reset(): void;
  close(): void;
};

/** 擬似の Access の certs・STS・getSigninToken。E2E 用のエントリ（fixtures/）が外向きの通信をここへ向ける。 */
export async function startFakeServer(o: {
  accessJwk: JWK;
  stsBody: string;
  signinToken: string;
}): Promise<FakeServer> {
  const seen = { sts: [] as URLSearchParams[], signin: [] as URLSearchParams[] };
  let certs = 0;
  const server: Server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/certs") {
        certs++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [o.accessJwk] }));
        return;
      }
      if (url.pathname === "/sts") {
        seen.sts.push(new URLSearchParams(body));
        res.setHeader("x-amzn-RequestId", "e2e-request-id-0001");
        res.end(o.stsBody);
        return;
      }
      if (url.pathname === "/federation") {
        seen.signin.push(new URLSearchParams(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ SigninToken: o.signinToken }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    certsHits: () => certs,
    reset() {
      seen.sts.length = 0;
      seen.signin.length = 0;
    },
    close: () => server.close(),
  };
}
