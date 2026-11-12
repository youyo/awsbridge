// PoC N6: issuer Worker awsbridge-admin-kms-poc を workers.dev へデプロイする。
// 1. スタック（deploy-aws）の Outputs から鍵とロールを読み、鍵ごとに KMS の GetPublicKey → 公開鍵 JWK（kid = RFC 7638 thumbprint）
// 2. --jwks で選んだ鍵だけを JWKS に並べ、discovery と一緒に <OUT_DIR>/issuer-documents.json に書く
// 3. wrangler.jsonc に vars（ISSUER・ROLE_ARN・KMS_KEYS・AWS_REGION・AUDIENCE・SUBJECT）を入れた設定を
//    <OUT_DIR>/wrangler.deploy.json に書いて wrangler deploy（secret は access-key.ts が入れる。deploy は既存の secret を残す）
// 4. 公開された discovery と JWKS が手元と一致するか確かめる
// KMS_KEYS には JWKS に載せない鍵も入れる（K5 で「JWKS から外した鍵で署名する」ため）。
// オプション: --jwks rsa,ec（既定 rsa）、--dry-run（バンドルだけ）、--check-only（4 だけ）
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildDiscovery } from "../../../src/oidc";
import { fail, writeSecret } from "../human/io";
import { parseJsonc } from "../human/portal/bypass-lib";
import { awsJson, loadSettings, pocDir, repoRoot, requireIssuer, stackOutputs } from "./io";
import { issuerJwks, jwkFromSpki } from "./lib";
import {
  deployWranglerConfig,
  keysFromOutputs,
  parseLabels,
  publicKeyFromGetPublicKey,
} from "./ops";

const { values } = parseArgs({
  options: {
    jwks: { type: "string", default: "rsa" },
    "dry-run": { type: "boolean", default: false },
    "check-only": { type: "boolean", default: false },
  },
});
const s = loadSettings();
const issuer = requireIssuer(s);

let docs: { discovery: unknown; jwks: unknown };
if (values["check-only"]) {
  docs = JSON.parse(readFileSync(s.documentsFile, "utf8"));
} else {
  const outputs = stackOutputs(s);
  let keys: ReturnType<typeof keysFromOutputs>;
  try {
    keys = keysFromOutputs(outputs);
  } catch (e) {
    fail((e as Error).message);
  }
  // 1 回目（deploy-aws -- --keys-only の後）はロールが無い。/poc/login は no_role を返す
  const roleArn = outputs.RoleArn ?? "";
  if (roleArn === "")
    console.warn("スタックにロールがまだ無い（--keys-only の段階）。ROLE_ARN は空でデプロイします");
  else if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/AwsbridgeAdminKmsPoc/.test(roleArn))
    fail("スタックの Output RoleArn が PoC のロールでない");
  const withKid = [];
  const jwkByLabel: Record<string, Awaited<ReturnType<typeof jwkFromSpki>>> = {};
  for (const k of keys) {
    const json = awsJson(s, ["kms", "get-public-key", "--key-id", k.keyId]);
    const jwk = await jwkFromSpki(publicKeyFromGetPublicKey(JSON.stringify(json), k.alg), k.alg);
    jwkByLabel[k.label] = jwk;
    withKid.push({ ...k, kid: jwk.kid as string });
  }
  let labels: string[];
  try {
    labels = parseLabels(
      values.jwks as string,
      keys.map((k) => k.label),
    );
  } catch (e) {
    fail((e as Error).message);
  }
  docs = {
    discovery: buildDiscovery(issuer),
    jwks: issuerJwks(labels.map((l) => jwkByLabel[l] as NonNullable<(typeof jwkByLabel)[string]>)),
  };
  writeSecret(s.documentsFile, JSON.stringify(docs));
  const cfg = parseJsonc(readFileSync(join(pocDir, "wrangler.jsonc"), "utf8"));
  const rendered = deployWranglerConfig(cfg, {
    dir: pocDir,
    documentsFile: s.documentsFile,
    vars: {
      ISSUER: issuer,
      ROLE_ARN: roleArn,
      KMS_KEYS: JSON.stringify(withKid),
      AWS_REGION: s.region,
      AUDIENCE: s.audience,
      SUBJECT: s.subject,
    },
  });
  writeSecret(s.deployConfigFile, `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(
    `JWKS に載せる鍵: ${labels.map((l) => `${l}(kid=${String(jwkByLabel[l]?.kid).slice(0, 8)}…)`).join(", ")}`,
  );
  console.log(
    `KMS_KEYS（署名に使える鍵）: ${withKid.map((k) => `${k.label}/${k.alg}(kid=${k.kid.slice(0, 8)}…)`).join(", ")}`,
  );
  const args = ["exec", "wrangler", "deploy", "--config", s.deployConfigFile];
  if (values["dry-run"]) args.push("--dry-run", "--outdir", join(s.outDir, "dist"));
  // wrangler は wrangler login の OAuth を使う（CLOUDFLARE_API_TOKEN は渡さない）
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const r = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit", env });
  if (r.status !== 0) fail(`wrangler deploy が失敗しました（終了コード ${r.status}）`);
  if (values["dry-run"]) {
    console.log("--dry-run のためデプロイしていません");
    process.exit(0);
  }
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: undefined };
  }
}

let ok = true;
for (const [name, path, expected] of [
  ["discovery", "/.well-known/openid-configuration", docs.discovery],
  ["JWKS", "/.well-known/jwks.json", docs.jwks],
] as const) {
  let last = { status: 0, body: undefined as unknown };
  for (let i = 0; i < 15; i++) {
    try {
      last = await fetchJson(`${issuer}${path}`);
      if (last.status === 200 && isDeepStrictEqual(last.body, expected)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  const pass = last.status === 200 && isDeepStrictEqual(last.body, expected);
  if (!pass) ok = false;
  console.log(`[${pass ? "OK" : "NG"}] ${name} ${path} HTTP ${last.status}`);
}
process.exit(ok ? 0 : 1);
