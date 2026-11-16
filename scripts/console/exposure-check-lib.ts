// issuer の「外からの比較」の道具の本体。CLI は scripts/console/exposure-check.ts、判定は src/console/exposure.ts（純粋な関数）。
// 外から取った issuer の discovery と JWKS が、設定の公開鍵と一致するかを確かめる（Standard の境界ごと・Admin）。
// 期待する側は、生成物（worker.standard.json・worker.admin.json）の issuer と、wrangler の設定の vars の公開鍵
// （STANDARD_PUBLIC_JWKS・ADMIN_PUBLIC_JWKS。鍵の道具 console:*-key:check と同じ設定）。Admin の生成物が無ければ Standard だけ。
// Cloudflare・AWS のトークンは使わない。公開の HTTP の GET だけ（取得は exposure-check-net.ts）。
// 例外の文に vars の値・JSON の断片を入れない。
import { adminIssuerOf } from "../../src/console/admin/issuer";
import { parsePublicJwks } from "../../src/console/admin/key";
import {
  type Check,
  type DocResponse,
  exposureExitCode,
  formatExposure,
  judgeDiscovery,
  judgeJwks,
  type TargetResult,
} from "../../src/console/exposure";
import { readWorkerConfig } from "../../src/console/portal/worker-config";
import type { PublicJwk } from "../../src/console/signing/key";
import { parseStandardKeys } from "../../src/console/standard/key";
import type { WorkerConfig } from "../../src/console/types";
import { isObj, readJsonc } from "./key-tool-common";

/** 設定が読めない・期待する鍵を一意に得られない（終了コード 2）。 */
export class SettingsError extends Error {}

export type ExposureSettings = {
  standard: { name: string; issuer: string; jwks: PublicJwk[] }[];
  /** Admin の生成物が無ければ undefined。 */
  admin?: { issuer: string; jwks: PublicJwk[] } | undefined;
};

/** https で、ポート・クエリ・フラグメントが無く、末尾が / でない issuer の URL か。 */
const isHttpsIssuer = (v: string): boolean => {
  try {
    const u = new URL(v);
    // ポートつきは断る（接続は常に 443。別のポートの issuer は、この道具では確かめられない）
    return (
      u.protocol === "https:" &&
      u.port === "" &&
      u.search === "" &&
      u.hash === "" &&
      !v.endsWith("/")
    );
  } catch {
    return false;
  }
};

function readVars(
  path: string,
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
): Record<string, unknown> {
  if (!exists(path)) throw new SettingsError(`wrangler の設定がありません: ${path}`);
  try {
    const cfg = readJsonc(readFile(path));
    return isObj(cfg.vars) ? cfg.vars : {};
  } catch {
    throw new SettingsError(`wrangler の設定を JSONC として読めない: ${path}`);
  }
}

function readGenerated(
  path: string,
  tier: "standard" | "admin",
  readFile: (p: string) => string,
): WorkerConfig {
  try {
    return readWorkerConfig(JSON.parse(readFile(path)), tier);
  } catch {
    throw new SettingsError(`生成物を読めない: ${path}（mise run console:config:generate）`);
  }
}

/**
 * 設定を読む。環境変数（鍵の道具と同じ）: AWSBRIDGE_CONSOLE_OUT_DIR（既定 .generated/console）、
 * AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG（既定 wrangler.console-standard.jsonc）、
 * AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG（既定 wrangler.console-admin.jsonc。Admin の生成物があるときだけ読む）。
 */
export async function exposureSettings(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
  exists: (path: string) => boolean,
): Promise<ExposureSettings> {
  const outDir = env.AWSBRIDGE_CONSOLE_OUT_DIR || ".generated/console";

  const stdPath = `${outDir}/worker.standard.json`;
  const stdConfig = readGenerated(stdPath, "standard", readFile);
  const stdWrangler =
    env.AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG || "wrangler.console-standard.jsonc";
  const stdVars = readVars(stdWrangler, readFile, exists);
  let keys: Awaited<ReturnType<typeof parseStandardKeys>>;
  try {
    keys = await parseStandardKeys(stdVars.STANDARD_CURRENT_KEYS, stdVars.STANDARD_PUBLIC_JWKS);
  } catch (e) {
    throw new SettingsError(`${stdWrangler} の vars: ${(e as Error).message}`);
  }
  if (stdConfig.boundaries.length === 0)
    throw new SettingsError(`${stdPath} に境界（issuer）が無い`);
  const standard = stdConfig.boundaries.map((b) => {
    const jwks = keys.publicJwks[b.name];
    if (!jwks)
      throw new SettingsError(
        `${stdWrangler} の vars STANDARD_PUBLIC_JWKS に境界 ${b.name} の公開鍵が無い`,
      );
    if (!isHttpsIssuer(b.issuer))
      throw new SettingsError(
        `境界 ${b.name} の issuer が https の URL でない（ポートつきは確かめられない）`,
      );
    return { name: b.name, issuer: b.issuer, jwks };
  });

  const admPath = `${outDir}/worker.admin.json`;
  if (!exists(admPath)) return { standard };
  const admConfig = readGenerated(admPath, "admin", readFile);
  const issuer = adminIssuerOf(admConfig);
  if (!issuer) throw new SettingsError(`${admPath} に Admin の issuer が（ちょうど 1 つ）無い`);
  if (!isHttpsIssuer(issuer))
    throw new SettingsError("Admin の issuer が https の URL でない（ポートつきは確かめられない）");
  const admWrangler = env.AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG || "wrangler.console-admin.jsonc";
  const admVars = readVars(admWrangler, readFile, exists);
  let jwks: PublicJwk[] | undefined;
  try {
    jwks = await parsePublicJwks(admVars.ADMIN_PUBLIC_JWKS);
  } catch (e) {
    throw new SettingsError(`${admWrangler} の vars: ${(e as Error).message}`);
  }
  if (!jwks) throw new SettingsError(`${admWrangler} の vars ADMIN_PUBLIC_JWKS が空`);
  return { standard, admin: { issuer, jwks } };
}

/** 取る（1 文書 1 回。失敗しても繰り返さない）。 */
export type FetchDoc = (url: string) => Promise<DocResponse>;

async function checkTarget(
  fetchDoc: FetchDoc,
  label: string,
  issuer: string,
  jwks: PublicJwk[],
): Promise<TargetResult> {
  const disc = await fetchDoc(`${issuer}/.well-known/openid-configuration`);
  const set = await fetchDoc(`${issuer}/.well-known/jwks.json`);
  const checks: Check[] = [...judgeDiscovery(issuer, disc), ...judgeJwks(jwks, set)];
  return { label, issuer, checks };
}

/** Standard（境界ごと）と Admin を順に確かめて表示する。0 一致 / 1 不一致あり。 */
export async function runExposureCheck(
  s: ExposureSettings,
  fetchDoc: FetchDoc,
  print: (line: string) => void,
): Promise<0 | 1> {
  const results: TargetResult[] = [];
  for (const b of s.standard)
    results.push(await checkTarget(fetchDoc, `Standard 境界 ${b.name}`, b.issuer, b.jwks));
  if (s.admin) results.push(await checkTarget(fetchDoc, "Admin", s.admin.issuer, s.admin.jwks));
  else print("Admin: 設定が無い（worker.admin.json が無い）。Standard だけ確かめる");
  print(formatExposure(results));
  return exposureExitCode(results);
}
