// PoC N6 の手順（scripts/poc/admin-kms/*.ts）の純粋関数。I/O は呼び出し側で行う。
// 設定は AWSBRIDGE_ADMIN_KMS_POC_* だけを読む（MCP 用の AWSBRIDGE_*・既存の PoC の AWSBRIDGE_HUMAN_POC_* は読まない）。
import { join } from "node:path";
import { ADMIN_KMS_DEFAULTS, type JwsAlg, kmsSigningAlgorithm } from "./lib";

export interface AdminKmsSettings {
  /** https://awsbridge-admin-kms-poc.<subdomain>.workers.dev */
  issuer: string | undefined;
  stackName: string;
  workerName: string;
  audience: string;
  subject: string;
  awsProfile: string;
  region: string;
  outDir: string;
  documentsFile: string;
  deployConfigFile: string;
  callerTokenFile: string;
}

const ISSUER_RE = /^https:\/\/awsbridge-admin-kms-poc\.[a-z0-9-]+\.workers\.dev$/;

export function adminKmsSettings(
  env: Record<string, string | undefined>,
  repoRoot: string,
): AdminKmsSettings {
  const get = (k: string) => env[`AWSBRIDGE_ADMIN_KMS_POC_${k}`] || undefined;
  const issuerRaw = get("ISSUER")?.replace(/\/+$/, "");
  if (issuerRaw !== undefined && !ISSUER_RE.test(issuerRaw))
    throw new Error(
      "AWSBRIDGE_ADMIN_KMS_POC_ISSUER は https://awsbridge-admin-kms-poc.<subdomain>.workers.dev の形",
    );
  const stackName = get("STACK_NAME") ?? ADMIN_KMS_DEFAULTS.stackName;
  if (!stackName.startsWith(ADMIN_KMS_DEFAULTS.stackName))
    throw new Error(
      "AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME は awsbridge-admin-kms-poc で始まる名前だけ",
    );
  const outDir = get("OUT_DIR") ?? join(repoRoot, ".secrets/poc-admin-kms");
  return {
    issuer: issuerRaw,
    stackName,
    workerName: ADMIN_KMS_DEFAULTS.workerName,
    audience: get("AUDIENCE") ?? ADMIN_KMS_DEFAULTS.audience,
    subject: get("SUBJECT") ?? ADMIN_KMS_DEFAULTS.subject,
    awsProfile: env.AWS_PROFILE || ADMIN_KMS_DEFAULTS.awsProfile,
    region: env.AWS_REGION || ADMIN_KMS_DEFAULTS.region,
    outDir,
    documentsFile: join(outDir, "issuer-documents.json"),
    deployConfigFile: join(outDir, "wrangler.deploy.json"),
    callerTokenFile: join(outDir, "caller-token.txt"),
  };
}

export interface StackKey {
  label: string;
  keyId: string;
  alg: JwsAlg;
}

const KEY_ARN_RE = /^arn:aws[a-z-]*:kms:[a-z]{2}(-[a-z]+)+-\d:\d{12}:key\/[0-9a-f-]{36}$/;

/** スタックの Outputs から鍵の一覧を作る（rsa = 今の鍵、ec = ES256、rsa-next = K5 の次の鍵）。 */
export function keysFromOutputs(outputs: Record<string, string>): StackKey[] {
  const spec: [string, string, JwsAlg][] = [
    ["rsa", "RsaKeyArn", "RS256"],
    ["ec", "EcKeyArn", "ES256"],
    ["rsa-next", "RsaNextKeyArn", "RS256"],
  ];
  return spec.map(([label, key, alg]) => {
    const arn = outputs[key];
    if (arn === undefined || !KEY_ARN_RE.test(arn))
      throw new Error(`スタックの Output ${key} が KMS の鍵 ARN でない（deploy-aws をやり直す）`);
    return { label, keyId: arn, alg };
  });
}

/** aws kms get-public-key の JSON から PublicKey（SPKI の DER）を取り出す。鍵の種類・用途・アルゴリズムが alg と合わなければ例外。 */
export function publicKeyFromGetPublicKey(json: string, alg: JwsAlg): Uint8Array {
  const v = JSON.parse(json) as Record<string, unknown>;
  const spec = alg === "RS256" ? "RSA_2048" : "ECC_NIST_P256";
  if (v.KeySpec !== spec) throw new Error(`KeySpec が ${spec} でない`);
  if (v.KeyUsage !== "SIGN_VERIFY") throw new Error("KeyUsage が SIGN_VERIFY でない");
  if (
    !Array.isArray(v.SigningAlgorithms) ||
    !v.SigningAlgorithms.includes(kmsSigningAlgorithm(alg))
  )
    throw new Error(`${kmsSigningAlgorithm(alg)} で署名できない鍵`);
  if (typeof v.PublicKey !== "string" || v.PublicKey === "") throw new Error("PublicKey が無い");
  return new Uint8Array(Buffer.from(v.PublicKey, "base64"));
}

/** "rsa,ec" を label の一覧にする。重複は 1 つに、知らない label・空は例外。 */
export function parseLabels(raw: string, available: string[]): string[] {
  const out: string[] = [];
  for (const item of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!available.includes(item))
      throw new Error(`知らない鍵: ${item}（${available.join(", ")}）`);
    if (!out.includes(item)) out.push(item);
  }
  if (out.length === 0) throw new Error("鍵を 1 つ以上指定する");
  return out;
}

/** wrangler.jsonc をデプロイ用の設定にする（main・alias を絶対パス、vars を入れる）。PoC の Worker 名・preview_urls 無効を検査する。 */
export function deployWranglerConfig(
  cfg: Record<string, unknown>,
  p: { dir: string; documentsFile: string; vars: Record<string, string> },
): Record<string, unknown> {
  if (cfg.name !== ADMIN_KMS_DEFAULTS.workerName)
    throw new Error(`Worker 名が ${ADMIN_KMS_DEFAULTS.workerName} でない`);
  if (cfg.preview_urls !== false) throw new Error("preview_urls は false にする");
  const { $schema: _schema, ...rest } = cfg;
  return {
    ...rest,
    main: join(p.dir, String(cfg.main)),
    alias: { "awsbridge-admin-kms-poc-documents": p.documentsFile },
    vars: p.vars,
  };
}

// ---- K4: DisableKey から止まるまで ----

export interface WatchEvent {
  at: string;
  ok: boolean;
  code?: string;
}

export interface StopSummary {
  lastOkBeforeDisable?: string;
  lastOkAfterDisable?: string;
  firstFailure?: string;
  failureCodes: string[];
  /** DisableKey の完了から最初の失敗まで（秒） */
  secondsToStop?: number;
  firstOkAfterEnable?: string;
  /** EnableKey の完了から最初の成功まで（秒） */
  secondsToResume?: number;
  /** DisableKey の完了後に成功した回数 */
  okAfterDisableCount: number;
}

const ms = (s: string) => new Date(s).getTime();
const secs = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 100) / 10;

export function stopSummary(
  events: WatchEvent[],
  disabledAt: string,
  enabledAt: string | undefined,
): StopSummary {
  const sorted = [...events].sort((a, b) => ms(a.at) - ms(b.at));
  const before = sorted.filter((e) => ms(e.at) < ms(disabledAt));
  const after = sorted.filter(
    (e) => ms(e.at) >= ms(disabledAt) && (enabledAt === undefined || ms(e.at) < ms(enabledAt)),
  );
  const afterEnable = enabledAt ? sorted.filter((e) => ms(e.at) >= ms(enabledAt)) : [];
  const okAfter = after.filter((e) => e.ok);
  const firstFailure = after.find((e) => !e.ok);
  const firstOkAfterEnable = afterEnable.find((e) => e.ok);
  const out: StopSummary = {
    failureCodes: [...new Set(after.filter((e) => !e.ok).map((e) => e.code ?? "unknown"))],
    okAfterDisableCount: okAfter.length,
  };
  const lastBefore = before.filter((e) => e.ok).pop();
  if (lastBefore) out.lastOkBeforeDisable = lastBefore.at;
  const lastOkAfter = okAfter.pop();
  if (lastOkAfter) out.lastOkAfterDisable = lastOkAfter.at;
  if (firstFailure) {
    out.firstFailure = firstFailure.at;
    out.secondsToStop = secs(disabledAt, firstFailure.at);
  }
  if (firstOkAfterEnable && enabledAt) {
    out.firstOkAfterEnable = firstOkAfterEnable.at;
    out.secondsToResume = secs(enabledAt, firstOkAfterEnable.at);
  }
  return out;
}

// ---- K4: CloudTrail ----

export interface TrailEvent {
  eventName: string;
  eventSource: string;
  eventTime: string;
  requestID?: string;
  sourceIPAddress?: string;
  userAgent?: string;
  requestParameters?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface Correlation {
  kmsRequestId: string;
  signTime: string | undefined;
  assumeTime: string;
  secondsBetween: number | undefined;
  sameSourceIp: boolean | undefined;
  signingAlgorithm: unknown;
  keyId: unknown;
}

/** AssumeRoleWithWebIdentity の RoleSessionName（kms-<KMS の RequestId>）と Sign の requestID で対にする。 */
export function correlateTrail(signs: TrailEvent[], assumes: TrailEvent[]): Correlation[] {
  const byId = new Map(signs.map((s) => [s.requestID, s]));
  const out: Correlation[] = [];
  for (const a of assumes) {
    const name = a.requestParameters?.roleSessionName;
    if (typeof name !== "string" || !name.startsWith("kms-")) continue;
    const id = name.slice(4);
    const s = byId.get(id);
    out.push({
      kmsRequestId: id,
      signTime: s?.eventTime,
      assumeTime: a.eventTime,
      secondsBetween: s ? secs(s.eventTime, a.eventTime) : undefined,
      sameSourceIp: s ? s.sourceIPAddress === a.sourceIPAddress : undefined,
      signingAlgorithm: s?.requestParameters?.signingAlgorithm,
      keyId: s?.requestParameters?.keyId,
    });
  }
  return out;
}

/** 記録・画面に出す前に伏せる: アカウント ID・KMS の鍵 ID・アクセスキー ID・email・workers.dev のサブドメイン。 */
export function maskIds(s: string): string {
  return s
    .replace(/key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "key/<key-id>")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1<redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, "<email>")
    .replace(/\.[a-z0-9-]+\.workers\.dev/g, ".<sub>.workers.dev")
    .replace(/\b\d{12}\b/g, "<acct>");
}

/**
 * Worker の記録（runs.jsonl の jti と kmsRequestId）と CloudTrail の AssumeRoleWithWebIdentity を、
 * RoleSessionName（kms-<RequestId>）で対にし、JWT の jti と requestParameters.webIdentityTokenId が一致するかを数える。
 * 記録が無い（別の回のイベントなど）ものは unknown。
 */
export function matchJti(
  runs: Record<string, unknown>[],
  assumes: TrailEvent[],
): { matched: number; mismatched: number; unknown: number } {
  const byKms = new Map(runs.map((r) => [r.kmsRequestId, r]));
  const out = { matched: 0, mismatched: 0, unknown: 0 };
  for (const a of assumes) {
    const name = a.requestParameters?.roleSessionName;
    const run = typeof name === "string" ? byKms.get(name.replace(/^kms-/, "")) : undefined;
    if (!run) out.unknown++;
    else if (run.jti === a.requestParameters?.webIdentityTokenId) out.matched++;
    else out.mismatched++;
  }
  return out;
}
