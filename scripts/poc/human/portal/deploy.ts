// PoC のポータル Worker（awsbridge-human-poc-portal）を workers.dev へデプロイする。
// 1. スタック（deploy-aws）の Outputs からロール、Access の Terraform の出力から AUD → チームを読む（無ければ空でデプロイ）
// 2. 署名鍵（std・admin）を --secrets-file（権限 600）で、そのほかを --var で渡して wrangler deploy
// 3. 公開された std / admin の discovery と JWKS が手元の鍵と一致するか確かめる
// 何度でもやり直してよい（deploy-aws のあと・Access の apply のあとにやり直す）。AWS は読むだけ（describe-stacks）。
// オプション: --dry-run（バンドルだけ。デプロイと 3 をしない）、--check-only（3 だけ）
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { publicJwkOf } from "../../../../src/keys";
import { buildDiscovery } from "../../../../src/oidc";
import { fail, readKey, required, writeSecret } from "../io";
import { audFromTerraformOutput, deployVars, rolesFromOutputs, workerSecrets } from "./deploy-lib";
import { loadSettings, portalDir, repoRoot, terraformOutputJson, tryStackOutputs } from "./io";
import { issuerFor, TIERS } from "./lib";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "check-only": { type: "boolean", default: false },
  },
});
const s = loadSettings();
const base = required(s.base, "AWSBRIDGE_HUMAN_POC_PORTAL_URL");
const teamDomain = required(s.teamDomain, "AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN");
const keys = { std: readKey(s.stdKeyFile), admin: readKey(s.adminKeyFile) };

if (!values["check-only"]) {
  const outputs = tryStackOutputs(s);
  if (!outputs)
    console.warn(
      `スタック ${s.stackName} を読めないため、ROLES は空でデプロイします（deploy-aws のあとにやり直す）`,
    );
  let roles: ReturnType<typeof rolesFromOutputs>;
  let aud: ReturnType<typeof audFromTerraformOutput>;
  try {
    roles = rolesFromOutputs(outputs ?? {});
    aud = audFromTerraformOutput(terraformOutputJson(s), base);
  } catch (e) {
    fail((e as Error).message);
  }
  if (!aud)
    console.warn(
      "Access の Terraform の出力が無いため、AUD の対応は空でデプロイします（apply のあとにやり直す）",
    );
  writeSecret(s.secretsFile, JSON.stringify(workerSecrets(keys.std, keys.admin)));
  const vars = deployVars({
    base,
    teamDomain,
    audMap: aud?.audMap ?? {},
    entryAud: aud?.entryAud,
    roles,
    sessionDuration: s.sessionDuration,
    audience: s.audience,
    region: s.region,
  });
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    join(portalDir, "wrangler.jsonc"),
    "--secrets-file",
    s.secretsFile,
    ...vars.flatMap((v) => ["--var", v]),
  ];
  if (values["dry-run"]) args.push("--dry-run", "--outdir", join(s.outDir, "dist"));
  console.log(
    `デプロイ: ROLES=${roles.map((r) => r.label).join(",") || "(なし)"} チーム=${Object.values(aud?.audMap ?? {}).join(",") || "(なし)"}`,
  );
  // Workers は wrangler login の OAuth を使う。CLOUDFLARE_API_TOKEN は Access 用（Workers の権限なし）なので wrangler には渡さない
  const { CLOUDFLARE_API_TOKEN: _omit, ...wranglerEnv } = process.env;
  const r = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit", env: wranglerEnv });
  if (r.status !== 0) fail(`wrangler deploy が失敗しました（終了コード ${r.status}）`);
  if (values["dry-run"]) {
    console.log("--dry-run のためデプロイしていません");
    process.exit(0);
  }
}

// 公開内容の確認（反映待ちのため数回リトライ）。Access を掛けたあとは Bypass のアプリ越しに見える
let ok = true;
for (const tier of TIERS) {
  const issuer = issuerFor(base, tier);
  const targets = [
    { url: `${issuer}/.well-known/openid-configuration`, expected: buildDiscovery(issuer) },
    { url: `${issuer}/.well-known/jwks.json`, expected: { keys: [await publicJwkOf(keys[tier])] } },
  ];
  for (const t of targets) {
    let status = 0;
    let pass = false;
    for (let i = 0; i < 10 && !pass; i++) {
      try {
        const res = await fetch(t.url, {
          headers: { "cache-control": "no-cache" },
          redirect: "manual",
        });
        status = res.status;
        const text = await res.text();
        pass = status === 200 && isDeepStrictEqual(JSON.parse(text), t.expected);
      } catch {}
      if (!pass) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!pass) ok = false;
    console.log(`[${pass ? "OK" : "NG"}] ${tier} ${t.url} HTTP ${status}`);
  }
}
process.exit(ok ? 0 : 1);
