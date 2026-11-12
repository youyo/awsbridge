// PoC X1-(h): secret_key のバインディングを持つ Worker で、別の secret（secret_text）を更新する経路のあとも secret_key が残るかを測る。
// 手順（1 回で通す。途中で止まっても destroy.sh で片付く）:
//   0. 鍵（RSA 2048、RS256）をメモリの中で作る（秘密鍵はファイルに書かない）。公開鍵を vars PUBLIC_JWK に入れて Worker をデプロイ
//   1. bearer（CALLER_TOKEN）を wrangler secret put で入れ、鍵を Cloudflare API の PUT .../secrets で secret_key として入れる
//   2. 次の経路を 1 つずつ実行し、そのたびに Worker の /probe（鍵の性質・自己検証・別の secret のハッシュ）と API の secret の一覧を見る
//      secret put（新規・更新）/ secret bulk（新規と更新・null で削除）/ secret delete / versions secret put・bulk → versions deploy / deploy
// 出力は真偽・種類・件数だけ（鍵・トークン・secret の値は出さない）。記録は .secrets/poc-x1h/runs.jsonl（gitignore）。
// トークンは wrangler login の OAuth（wrangler auth token）をメモリの中で使う。
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { base64url, jwkThumbprint, RS256_ALGORITHM } from "../../../src/console/signing/key";
import { hashPrefix, type ProbeResult, secretKeyBody, X1H_KEY_BINDING, x1hSettings } from "./lib";

const repoRoot = resolve(import.meta.dirname, "../../..");
const s = x1hSettings(process.env);
const outDir = join(repoRoot, s.outDir);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const deployConfig = join(outDir, "wrangler.deploy.json");
const runsFile = join(outDir, "runs.jsonl");
const OTHERS = ["OTHER_A", "OTHER_B", "OTHER_C", "OTHER_D"] as const;

function wranglerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  delete env.CLOUDFLARE_API_TOKEN;
  return env;
}

function wrangler(args: string[], input?: string): { status: number | null; out: string } {
  const r = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repoRoot,
    env: wranglerEnv(),
    encoding: "utf8",
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function oauthToken(): string {
  const r = wrangler(["auth", "token", "--json"]);
  const t = (() => {
    try {
      return (JSON.parse(r.out.slice(r.out.indexOf("{"))) as { token?: unknown }).token;
    } catch {
      return undefined;
    }
  })();
  if (r.status !== 0 || typeof t !== "string" || t === "")
    throw new Error("wrangler auth token が失敗した（pnpm exec wrangler login を確かめる）");
  return t;
}

const API = "https://api.cloudflare.com/client/v4";
async function cf(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = undefined;
  }
  return { status: res.status, json: json as { success?: boolean; result?: unknown } | undefined };
}

const rand = () => base64url(crypto.getRandomValues(new Uint8Array(24)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 0. 鍵と Worker ----
const token = oauthToken();
const sub = await cf(token, "GET", `/accounts/${s.accountId}/workers/subdomain`);
const subdomain = (sub.json?.result as { subdomain?: unknown } | undefined)?.subdomain;
if (typeof subdomain !== "string")
  throw new Error(`workers.dev のサブドメインを取れない（HTTP ${sub.status}）`);
const base = `https://${s.workerName}.${subdomain}.workers.dev`;

const pair = (await crypto.subtle.generateKey(
  { ...RS256_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
let privJwk: JsonWebKey | undefined = (await crypto.subtle.exportKey(
  "jwk",
  pair.privateKey,
)) as JsonWebKey;
const n = privJwk.n as string;
const e = privJwk.e as string;
const kid = await jwkThumbprint({ n, e });
const publicJwk = { kty: "RSA", n, e, kid, alg: "RS256", use: "sig" };

writeFileSync(
  deployConfig,
  `${JSON.stringify(
    {
      name: s.workerName,
      main: join(repoRoot, "scripts/poc/x1h/worker.ts"),
      compatibility_date: "2026-07-21",
      workers_dev: true,
      preview_urls: false,
      vars: { PUBLIC_JWK: JSON.stringify(publicJwk), SECRET_NAMES: OTHERS.join(",") },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
const cfgArgs = ["--config", deployConfig];

function must(label: string, r: { status: number | null; out: string }): void {
  if (r.status !== 0) {
    console.error(r.out.split("\n").slice(-8).join("\n"));
    throw new Error(`${label} が失敗した（終了コード ${r.status}）`);
  }
}

must("wrangler deploy", wrangler(["deploy", ...cfgArgs]));
const bearer = rand();
must("secret put CALLER_TOKEN", wrangler(["secret", "put", "CALLER_TOKEN", ...cfgArgs], bearer));
const put = await cf(
  token,
  "PUT",
  `/accounts/${s.accountId}/workers/scripts/${s.workerName}/secrets`,
  secretKeyBody(X1H_KEY_BINDING, privJwk),
);
privJwk = undefined; // 秘密成分の参照を外す（手元に写しは残さない）
console.log(
  `PUT secret_key ${X1H_KEY_BINDING}: HTTP ${put.status} success=${put.json?.success === true}`,
);
if (put.json?.success !== true) throw new Error("secret_key を入れられなかった");

// ---- 観察 ----
const expected: Record<string, string | null> = Object.fromEntries(OTHERS.map((k) => [k, null]));

async function probeOnce(): Promise<ProbeResult | { http: number }> {
  try {
    const res = await fetch(`${base}/probe?t=${Date.now()}`, {
      headers: { authorization: `Bearer ${bearer}`, "cache-control": "no-cache" },
    });
    if (res.status !== 200) return { http: res.status };
    return (await res.json()) as ProbeResult;
  } catch {
    return { http: 0 };
  }
}

async function expectedHashes(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(expected)) out[k] = v === null ? null : await hashPrefix(v);
  return out;
}

async function observe(step: string): Promise<boolean> {
  const want = await expectedHashes();
  let last: ProbeResult | { http: number } = { http: 0 };
  let converged = false;
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) {
    last = await probeOnce();
    if ("key" in last && JSON.stringify(last.secrets) === JSON.stringify(want)) {
      converged = true;
      break;
    }
    await sleep(3000);
  }
  const list = await cf(
    token,
    "GET",
    `/accounts/${s.accountId}/workers/scripts/${s.workerName}/secrets`,
  );
  const items = Array.isArray(list.json?.result)
    ? (list.json?.result as { name?: string; type?: string }[])
    : [];
  const keyInApi = items.find((x) => x.name === X1H_KEY_BINDING)?.type ?? null;
  const row = {
    at: new Date().toISOString(),
    step,
    probeHttp: "http" in last ? last.http : 200,
    secretsConverged: converged,
    waitedMs: Date.now() - t0,
    keyPresent: "key" in last ? last.key.present : null,
    keyUsable: "key" in last ? last.key.usable : null,
    exportKey: "key" in last ? (last.key.exportKey ?? null) : null,
    selfVerify: "key" in last ? last.selfVerify : null,
    apiKeyType: keyInApi,
    apiSecrets: items.map((x) => `${x.name}(${x.type})`).sort(),
  };
  appendFileSync(runsFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const ok =
    converged && row.keyUsable === true && row.selfVerify === true && keyInApi === "secret_key";
  console.log(
    `[${ok ? "残る" : "NG"}] ${step}: probe=${row.probeHttp} 反映=${converged}(${row.waitedMs}ms) key.present=${row.keyPresent} usable=${row.keyUsable} exportKey=${row.exportKey} selfVerify=${row.selfVerify} API=${keyInApi} 一覧=${row.apiSecrets.join(",")}`,
  );
  return ok;
}

function versionId(out: string): string {
  const id = /Created version ([0-9a-f-]{36})/.exec(out)?.[1];
  if (!id) throw new Error("versions secret の出力に version の ID が無い");
  return id;
}

const steps: [string, () => void][] = [
  ["基準（投入直後）", () => {}],
  [
    "wrangler secret put OTHER_A（新規の secret_text）",
    () => {
      expected.OTHER_A = rand();
      must("secret put", wrangler(["secret", "put", "OTHER_A", ...cfgArgs], expected.OTHER_A));
    },
  ],
  [
    "wrangler secret put OTHER_A（既存の secret_text の更新）",
    () => {
      expected.OTHER_A = rand();
      must("secret put", wrangler(["secret", "put", "OTHER_A", ...cfgArgs], expected.OTHER_A));
    },
  ],
  [
    "wrangler secret bulk（OTHER_A の更新と OTHER_B の新規）",
    () => {
      expected.OTHER_A = rand();
      expected.OTHER_B = rand();
      must(
        "secret bulk",
        wrangler(
          ["secret", "bulk", ...cfgArgs],
          JSON.stringify({ OTHER_A: expected.OTHER_A, OTHER_B: expected.OTHER_B }),
        ),
      );
    },
  ],
  [
    "wrangler secret bulk（OTHER_B を null で削除）",
    () => {
      expected.OTHER_B = null;
      must(
        "secret bulk",
        wrangler(["secret", "bulk", ...cfgArgs], JSON.stringify({ OTHER_B: null })),
      );
    },
  ],
  [
    "wrangler secret delete OTHER_A",
    () => {
      expected.OTHER_A = null;
      must("secret delete", wrangler(["secret", "delete", "OTHER_A", ...cfgArgs]));
    },
  ],
  [
    "wrangler versions secret put OTHER_C → versions deploy",
    () => {
      expected.OTHER_C = rand();
      const r = wrangler(["versions", "secret", "put", "OTHER_C", ...cfgArgs], expected.OTHER_C);
      must("versions secret put", r);
      must(
        "versions deploy",
        wrangler(["versions", "deploy", `${versionId(r.out)}@100%`, "--yes", ...cfgArgs]),
      );
    },
  ],
  [
    "wrangler versions secret bulk（OTHER_C の更新と OTHER_D の新規）→ versions deploy",
    () => {
      expected.OTHER_C = rand();
      expected.OTHER_D = rand();
      const r = wrangler(
        ["versions", "secret", "bulk", ...cfgArgs],
        JSON.stringify({ OTHER_C: expected.OTHER_C, OTHER_D: expected.OTHER_D }),
      );
      must("versions secret bulk", r);
      must(
        "versions deploy",
        wrangler(["versions", "deploy", `${versionId(r.out)}@100%`, "--yes", ...cfgArgs]),
      );
    },
  ],
  [
    "wrangler secret put OTHER_D（versions の後の通常の更新）",
    () => {
      expected.OTHER_D = rand();
      must("secret put", wrangler(["secret", "put", "OTHER_D", ...cfgArgs], expected.OTHER_D));
    },
  ],
  [
    "wrangler deploy（コードの更新。比較用）",
    () => must("wrangler deploy", wrangler(["deploy", ...cfgArgs])),
  ],
];

let allOk = true;
appendFileSync(
  runsFile,
  `${JSON.stringify({ at: new Date().toISOString(), start: true, kidPrefix: kid.slice(0, 8) })}\n`,
);
for (const [label, act] of steps) {
  act();
  if (!(await observe(label))) allOk = false;
}
console.log(
  allOk
    ? "結果: どの経路のあとも secret_key は残った"
    : "結果: secret_key が残らない経路がある（上の NG）",
);
console.log("片付け: mise run poc:x1h:destroy → mise run poc:x1h:clean-check");
process.exitCode = allOk ? 0 : 1;
