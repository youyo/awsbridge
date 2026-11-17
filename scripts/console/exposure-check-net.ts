// issuer の「外からの比較」の取得（本体は exposure-check-lib.ts、CLI は exposure-check.ts）。
// 手元の DNS（否定のキャッシュを含む）に左右されないよう、名前は公開の DoH（既定 https://cloudflare-dns.com/dns-query、dns-json）で
// A と AAAA を引き、その IP に TLS で接続して GET する。接続は IP でも、SNI・証明書の検査・Host はもとのホスト名のまま
// （https.request の lookup で、解決の結果だけを差し替える）。リダイレクトは追わない。本文は上限つき。タイムアウトあり。
// 取れない・タイムアウト・DNS の失敗は error（一致にしない）。Cloudflare・AWS のトークンは使わない。
// 試験用の上書き（手元だけ）: AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL（http://127.0.0.1:<port>/…）と、それを上書きしたときだけ
// 効く AWSBRIDGE_CONSOLE_EXPOSURE_CONNECT_PORT（接続先のポート）。証明書の検査は止めない（試験は NODE_EXTRA_CA_CERTS で信頼させる）。
import { request } from "node:https";
import { isIP } from "node:net";
import type { DocResponse } from "../../src/console/exposure";
import type { FetchDoc } from "./exposure-check-lib";

export const DEFAULT_DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_OVERRIDE = "AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL";
const PORT_OVERRIDE = "AWSBRIDGE_CONSOLE_EXPOSURE_CONNECT_PORT";
const LOOPBACK_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[\w./-]*)?$/;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;

/** DoH の宛先。上書きは手元（http://127.0.0.1:<port>/…）の試験用だけ。 */
export function dohUrlFrom(env: Record<string, string | undefined>): string {
  const v = env[DOH_OVERRIDE];
  if (v === undefined || v === "") return DEFAULT_DOH_URL;
  if (!LOOPBACK_URL_RE.test(v))
    throw new Error(`${DOH_OVERRIDE} は試験用で、http://127.0.0.1:<port>/… だけ`);
  return v;
}

/** 接続先のポート（既定 443）。上書きは DoH も上書きしているとき（試験）だけ効く。 */
export function connectPortFrom(env: Record<string, string | undefined>): number {
  const v = env[PORT_OVERRIDE];
  if (v === undefined || v === "" || !env[DOH_OVERRIDE]) return 443;
  const n = Number(v);
  if (!/^\d{1,5}$/.test(v) || n < 1 || n > 65535)
    throw new Error(`${PORT_OVERRIDE} は 1〜65535 の数字`);
  return n;
}

type DohAnswer = { type?: unknown; data?: unknown };

/** 本文を上限（MAX_BYTES）まで読む。超えたら例外（読み切らずに止める）。 */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("doh too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function dohQuery(
  host: string,
  type: "A" | "AAAA",
  fetchFn: typeof fetch,
  dohUrl: string,
): Promise<string[]> {
  const u = new URL(dohUrl);
  u.searchParams.set("name", host);
  u.searchParams.set("type", type);
  const res = await fetchFn(u, {
    headers: { accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error("doh status");
  const body = JSON.parse(await readCapped(res)) as { Status?: unknown; Answer?: unknown };
  if (body.Status !== 0 || !Array.isArray(body.Answer)) throw new Error("doh answer");
  const want = type === "A" ? 1 : 28;
  return (body.Answer as DohAnswer[])
    .filter((a) => a?.type === want && typeof a.data === "string" && isIP(a.data) !== 0)
    .map((a) => a.data as string);
}

/** 公開の DNS（DoH）で A と AAAA を引く。片方が失敗してももう片方で取れればよい。1 つも取れなければ例外。 */
export async function resolveViaDoh(
  host: string,
  fetchFn: typeof fetch,
  dohUrl: string,
): Promise<string[]> {
  const rs = await Promise.allSettled([
    dohQuery(host, "A", fetchFn, dohUrl),
    dohQuery(host, "AAAA", fetchFn, dohUrl),
  ]);
  const ips = rs.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (ips.length === 0) throw new Error("dns");
  return [...new Set(ips)];
}

export type GetOptions = { ip: string; host: string; port: number; path: string };

function reasonOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code !== "string") return "error";
  if (code === "ABORT_ERR" || code === "ETIMEDOUT") return "timeout";
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || code.startsWith("ERR_SSL"))
    return "tls";
  if (code.startsWith("E")) return "connect";
  return "error";
}

/** ip に接続して https://<host><path> を GET する（SNI・証明書の検査・Host はホスト名）。リダイレクトは追わない。 */
export function getPinned(o: GetOptions): Promise<DocResponse> {
  return new Promise((resolve) => {
    const family = isIP(o.ip);
    const done = (r: DocResponse) => resolve(r);
    const req = request(
      {
        host: o.host,
        port: o.port,
        path: o.path,
        method: "GET",
        headers: {
          host: o.host,
          accept: "application/json",
          "user-agent": "awsbridge-exposure-check",
        },
        // 解決の結果だけ差し替える（servername・Host・証明書の検査はもとのホスト名のまま）
        lookup: (_h, opts, cb) => {
          const all = (opts as { all?: boolean }).all === true;
          // biome-ignore lint/suspicious/noExplicitAny: lookup のコールバックは all の有無で形が変わる
          (cb as any)(null, all ? [{ address: o.ip, family }] : o.ip, family);
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            done({ kind: "error", reason: "too_large" });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            json = undefined;
          }
          const loc = res.headers.location;
          done({
            kind: "response",
            status: res.statusCode ?? 0,
            ...(typeof loc === "string" ? { location: loc } : {}),
            json,
          });
        });
        res.on("error", (e) => done({ kind: "error", reason: reasonOf(e) }));
      },
    );
    req.on("error", (e) => done({ kind: "error", reason: reasonOf(e) }));
    req.end();
  });
}

export type FetchDocOptions = {
  resolve: (host: string) => Promise<string[]>;
  get: (o: GetOptions) => Promise<DocResponse>;
  port: number;
};

/**
 * 文書の URL（https）を取る関数を作る。ホストごとに 1 回だけ引く。IP は順に試し、応答が返った時点で止める
 * （接続できなければ次の IP）。名前を引けない・https でない・どの IP にも接続できないときは error。
 */
export function makeFetchDoc(o: FetchDocOptions): FetchDoc {
  const cache = new Map<string, Promise<string[]>>();
  return async (url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { kind: "error", reason: "url" };
    }
    if (u.protocol !== "https:") return { kind: "error", reason: "scheme" };
    let ips = cache.get(u.hostname);
    if (!ips) {
      ips = o.resolve(u.hostname);
      cache.set(u.hostname, ips);
    }
    let list: string[];
    try {
      list = await ips;
    } catch {
      return { kind: "error", reason: "dns" };
    }
    // 比べるのは、最初に応答した IP の 1 つだけ（限界: 名前が複数の IP を返すとき、ほかの IP が別の応答を返しても見ない。
    // Cloudflare の anycast では、Route などのゾーンの設定はどの IP でも同じに効くので 1 つで足りる、という前提）。
    // 次の IP へ進むのは接続できない（connect）・タイムアウトのときだけ。tls（証明書の不正）などは、
    // 別の IP で成功させて誤りを隠さないよう、その場で誤りにする。
    let last: DocResponse = { kind: "error", reason: "connect" };
    for (const ip of list) {
      const r = await o.get({
        ip,
        host: u.hostname,
        port: o.port,
        path: `${u.pathname}${u.search}`,
      });
      if (r.kind === "response") return r;
      last = r;
      if (r.reason !== "connect" && r.reason !== "timeout") return r;
    }
    return last;
  };
}

/** 実環境の取得（DoH + 固定した IP への TLS 接続）。 */
export function realFetchDoc(env: Record<string, string | undefined>): FetchDoc {
  const dohUrl = dohUrlFrom(env);
  return makeFetchDoc({
    resolve: (host) => resolveViaDoh(host, (i, init) => fetch(i, init), dohUrl),
    get: getPinned,
    port: connectPortFrom(env),
  });
}
