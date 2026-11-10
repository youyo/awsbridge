// PoC（人間のログイン）: issuer Worker awsbridge-human-poc を workers.dev へデプロイする。AWS は呼ばない。
// 1. 手元の署名鍵から discovery と JWKS（公開鍵だけ）を作り、AWSBRIDGE_HUMAN_POC_OUT_DIR/issuer-documents.json に書く
// 2. wrangler deploy（scripts/poc/human/wrangler.jsonc。--alias で 1 の文書を Worker に差し込む。scripts/wrangler.sh は使わない）
// 3. 公開された discovery / JWKS を取得し、1 と一致するか確かめる
// オプション: --dry-run（バンドルだけ。デプロイしない）、--check-only（3 だけ）
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fail, readKey, required, writeSecret } from "./io";
import { humanPocSettings, issuerDocuments } from "./lib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "check-only": { type: "boolean", default: false },
  },
});

let settings: ReturnType<typeof humanPocSettings>;
try {
  settings = humanPocSettings(process.env);
} catch (e) {
  fail(`AWSBRIDGE_HUMAN_POC_ISSUER が不正です: ${(e as Error).message}`);
}
const issuer = required(settings.issuer, "AWSBRIDGE_HUMAN_POC_ISSUER");
const docs = await issuerDocuments(issuer, readKey(settings.keyFile));

if (!values["check-only"]) {
  writeSecret(settings.documentsFile, JSON.stringify(docs));
  console.log(
    `issuer の文書を書きました: ${settings.documentsFile} (kid=${docs.jwks.keys[0]?.kid})`,
  );
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    join(here, "wrangler.jsonc"),
    "--alias",
    `awsbridge-human-poc-documents:${settings.documentsFile}`,
  ];
  if (values["dry-run"]) args.push("--dry-run", "--outdir", join(settings.outDir, "dist"));
  const r = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`wrangler deploy が失敗しました（終了コード ${r.status}）`);
  if (values["dry-run"]) {
    console.log("--dry-run のためデプロイしていません");
    process.exit(0);
  }
}

// 公開内容の確認（反映待ちのため数回リトライ）
async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: undefined };
  }
}

const targets = [
  {
    name: "discovery",
    url: `${issuer}/.well-known/openid-configuration`,
    expected: docs.discovery,
  },
  { name: "JWKS", url: `${issuer}/.well-known/jwks.json`, expected: docs.jwks },
];
let ok = true;
for (const t of targets) {
  let last = { status: 0, body: undefined as unknown };
  for (let i = 0; i < 10; i++) {
    try {
      last = await fetchJson(t.url);
      if (last.status === 200 && isDeepStrictEqual(last.body, t.expected)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  const pass = last.status === 200 && isDeepStrictEqual(last.body, t.expected);
  if (!pass) ok = false;
  console.log(
    `[${pass ? "OK" : "NG"}] ${t.name} ${t.url} HTTP ${last.status}${pass ? "" : "（手元の文書と一致しません。Worker の URL と AWSBRIDGE_HUMAN_POC_ISSUER が同じか確認してください）"}`,
  );
}
process.exit(ok ? 0 : 1);
