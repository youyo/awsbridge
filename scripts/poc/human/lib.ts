// PoC（awsbridge 方式を人間の AWS ログインに使えるか）の純粋関数。I/O は呼び出し側（*.ts のスクリプト）で行う。
// MCP 経路（src/、infra/aws/awsbridge.yaml）とは別の issuer・署名鍵・ロール・audience を使う。
// 設定は AWSBRIDGE_HUMAN_POC_* だけを読み、MCP 用の AWSBRIDGE_ISSUER / AWSBRIDGE_STACK_NAME などは読まない。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importJWK, type JWK, SignJWT } from "jose";
import { publicJwkOf, thumbprintOf } from "../../../src/keys";
import { buildDiscovery, buildSessionName } from "../../../src/oidc";

export const HUMAN_POC_DEFAULTS = {
  audience: "awsbridge-human-poc",
  stackName: "awsbridge-human-poc",
  awsProfile: "awsbridge",
  region: "ap-northeast-1",
} as const;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** issuer（https://<host>）を正規化する。末尾スラッシュは落とす。パス・クエリ・http は例外。 */
export function normalizeIssuer(input: string): string {
  const s = input.replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s))
    throw new Error("issuer must be https://<host> (no path, query or port)");
  return s;
}

/** issuer からホスト名（IAM の条件キーや CloudFormation の IssuerHost）を取り出す。 */
export function issuerHost(issuer: string): string {
  return normalizeIssuer(issuer).slice("https://".length);
}

export interface HumanPocSettings {
  issuer: string | undefined;
  subject: string | undefined;
  audience: string;
  stackName: string;
  awsProfile: string;
  region: string;
  outDir: string;
  keyFile: string;
  documentsFile: string;
}

/** 環境変数（引数で渡す）から設定を作る。空文字は未設定扱い。既定値はここで補う（mise.toml の [env] には置かない）。 */
export function humanPocSettings(env: Record<string, string | undefined>): HumanPocSettings {
  const get = (k: string) => env[k] || undefined;
  const outDir = get("AWSBRIDGE_HUMAN_POC_OUT_DIR") ?? join(repoRoot, ".secrets/poc-human");
  const issuer = get("AWSBRIDGE_HUMAN_POC_ISSUER");
  return {
    issuer: issuer === undefined ? undefined : normalizeIssuer(issuer),
    subject: get("AWSBRIDGE_HUMAN_POC_SUBJECT")?.toLowerCase(),
    audience: get("AWSBRIDGE_HUMAN_POC_AUDIENCE") ?? HUMAN_POC_DEFAULTS.audience,
    stackName: get("AWSBRIDGE_HUMAN_POC_STACK_NAME") ?? HUMAN_POC_DEFAULTS.stackName,
    awsProfile: get("AWS_PROFILE") ?? HUMAN_POC_DEFAULTS.awsProfile,
    region: get("AWS_REGION") ?? HUMAN_POC_DEFAULTS.region,
    outDir,
    keyFile: get("AWSBRIDGE_HUMAN_POC_KEY_FILE") ?? join(outDir, "signing-key.json"),
    documentsFile: join(outDir, "issuer-documents.json"),
  };
}

export interface HumanTokenParams {
  issuer: string;
  audience: string;
  subject: string;
  /** epoch seconds */
  now: number;
  ttlSeconds?: number;
  /** セッションタグ・SourceIdentity などの追加 claim（iss・aud・sub・iat・exp は上書きできない） */
  extraClaims?: Record<string, unknown>;
}

const RESERVED_CLAIMS = ["iss", "aud", "sub", "iat", "exp"];

/** STS に渡す JWT の claim。iss は正規化した issuer とバイト単位で一致させる。 */
export function humanTokenClaims(p: HumanTokenParams) {
  const extra = p.extraClaims ?? {};
  for (const k of RESERVED_CLAIMS)
    if (k in extra) throw new Error(`extraClaims で ${k} は上書きできない`);
  return {
    ...extra,
    iss: normalizeIssuer(p.issuer),
    aud: p.audience,
    sub: p.subject,
    iat: p.now,
    exp: p.now + (p.ttlSeconds ?? 300),
  };
}

// ---- P2 セッションタグ・P3 SourceIdentity（JWT の claim） ----
// 出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html（入れ子形式・平坦形式）
//       https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html（source_identity）

export const AWS_TAGS_CLAIM = "https://aws.amazon.com/tags";
export const AWS_SOURCE_IDENTITY_CLAIM = "https://aws.amazon.com/source_identity";

export type TagFormat = "nested" | "flat";

/**
 * セッションタグの claim。
 * - nested: {"https://aws.amazon.com/tags": {"principal_tags": {"k": ["v"]}}}（値は 1 要素の配列）
 * - flat:   {"https://aws.amazon.com/tags/principal_tags/k": "v"}（値は文字列）
 * タグが空なら何も足さない。キーの大文字・小文字はそのまま渡す。
 */
export function sessionTagClaims(
  tags: Record<string, string>,
  format: TagFormat,
): Record<string, unknown> {
  const entries = Object.entries(tags);
  if (entries.length === 0) return {};
  if (format === "flat")
    return Object.fromEntries(
      entries.map(([k, v]) => [`${AWS_TAGS_CLAIM}/principal_tags/${k}`, v]),
    );
  return {
    [AWS_TAGS_CLAIM]: { principal_tags: Object.fromEntries(entries.map(([k, v]) => [k, [v]])) },
  };
}

/** SourceIdentity の claim。STS の制約（2〜64 文字、[\w+=,.@-]）に合わなければ例外。 */
export function sourceIdentityClaim(sourceIdentity: string): Record<string, string> {
  if (!/^[\w+=,.@-]{2,64}$/.test(sourceIdentity))
    throw new Error("SourceIdentity must be 2-64 characters of [A-Za-z0-9_+=,.@-]");
  return { [AWS_SOURCE_IDENTITY_CLAIM]: sourceIdentity };
}

/** タグの値（空でも可）。IAM のタグ値で使える文字のうち空白を除いたもの・256 文字まで。 */
export function isValidTagValue(v: string): boolean {
  return /^[\p{L}\p{N}_.:/=+\-@]{0,256}$/u.test(v);
}

export interface StsExtras {
  sourceIdentity: string | undefined;
  packedPolicySize: number | undefined;
  sessionTokenSize: number | undefined;
  sessionTokenUtilization: number | undefined;
}

/** AssumeRoleWithWebIdentity の成功応答から、認証情報以外の確認用の値を取り出す（無い要素は undefined）。 */
export function parseStsExtras(xml: string): StsExtras {
  const text = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();
  const num = (name: string) => {
    const v = text(name);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  return {
    sourceIdentity: text("SourceIdentity"),
    packedPolicySize: num("PackedPolicySize"),
    sessionTokenSize: num("SessionTokenSize"),
    sessionTokenUtilization: num("SessionTokenUtilization"),
  };
}

// ---- ロールの選択（スタックの Output） ----

export const ROLE_KEYS = ["base", "tagged", "notag"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export function isRoleKey(v: string): v is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(v);
}

/** base = 既存の AwsbridgeHumanPoc、tagged = AwsbridgeHumanPocTagged、notag = AwsbridgeHumanPocNoTag の Output 名。 */
export function roleOutputKey(role: RoleKey): string {
  return { base: "RoleArn", tagged: "TaggedRoleArn", notag: "NoTagRoleArn" }[role];
}

/** describe-stacks --query Stacks[0].Outputs --output json の出力を OutputKey → OutputValue にする。 */
export function outputsMap(json: string): Record<string, string> {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const o of v as { OutputKey?: unknown; OutputValue?: unknown }[])
    if (typeof o?.OutputKey === "string" && typeof o.OutputValue === "string")
      out[o.OutputKey] = o.OutputValue;
  return out;
}

/** 認証情報のファイル名。base は従来どおり credentials.json。destroy.sh は credentials*.json を消す。 */
export function credentialsFileName(role: RoleKey): string {
  return role === "base" ? "credentials.json" : `credentials-${role}.json`;
}

/** 手元の秘密鍵で JWT に署名する（header: alg RS256、kid = JWK thumbprint）。 */
export async function signHumanToken(
  p: Omit<HumanTokenParams, "now"> & { privateJwk: JWK; now?: number },
): Promise<string> {
  const key = await importJWK({ ...p.privateJwk, alg: "RS256" }, "RS256");
  const kid = await thumbprintOf(p.privateJwk);
  const claims = humanTokenClaims({ ...p, now: p.now ?? Math.floor(Date.now() / 1000) });
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).sign(key);
}

export interface IssuerDocuments {
  discovery: ReturnType<typeof buildDiscovery>;
  jwks: { keys: JWK[] };
}

/** PoC Worker が静的に返す discovery と JWKS（公開鍵だけ）。discovery は MCP 経路（src/oidc.ts）と同じ項目。 */
export async function issuerDocuments(issuer: string, privateJwk: JWK): Promise<IssuerDocuments> {
  const discovery = buildDiscovery(normalizeIssuer(issuer));
  // 秘密成分まで含めて鍵として使えることを確かめてから、公開成分だけを出す
  await importJWK({ ...privateJwk, alg: "RS256" }, "RS256");
  return { discovery, jwks: { keys: [await publicJwkOf(privateJwk)] } };
}

export function stsEndpoint(region: string): string {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`invalid region: ${region}`);
  return `https://sts.${region}.amazonaws.com/`;
}

/** RoleSessionName（CloudTrail で人間のセッションと分かるよう human- を付ける）。 */
export function humanSessionName(subject: string): string {
  return buildSessionName("human-", subject, "");
}

export function assumeRoleWithWebIdentityParams(p: {
  roleArn: string;
  roleSessionName: string;
  webIdentityToken: string;
  durationSeconds?: number | undefined;
}): URLSearchParams {
  const params = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: p.roleArn,
    RoleSessionName: p.roleSessionName,
    WebIdentityToken: p.webIdentityToken,
  });
  if (p.durationSeconds !== undefined) params.set("DurationSeconds", String(p.durationSeconds));
  return params;
}

export const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";

export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** getSigninToken のパラメーター（POST のフォーム本文に使う）。SessionDuration は指定したときだけ付ける。 */
export function getSigninTokenParams(
  creds: TemporaryCredentials,
  sessionDuration?: number,
): URLSearchParams {
  const params = new URLSearchParams({ Action: "getSigninToken" });
  if (sessionDuration !== undefined) params.set("SessionDuration", String(sessionDuration));
  params.set(
    "Session",
    JSON.stringify({
      sessionId: creds.accessKeyId,
      sessionKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    }),
  );
  return params;
}

/** getSigninToken の応答（{"SigninToken":"..."}）から token を取り出す。取り出せなければ undefined。 */
export function parseSigninTokenResponse(body: string): string | undefined {
  try {
    const v: unknown = JSON.parse(body);
    if (typeof v !== "object" || v === null) return undefined;
    const t = (v as { SigninToken?: unknown }).SigninToken;
    return typeof t === "string" && t !== "" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** コンソールのログイン URL（15 分有効。機密として扱う）。 */
export function loginUrl(p: { signinToken: string; issuer: string; destination: string }): string {
  const params = new URLSearchParams({
    Action: "login",
    Issuer: p.issuer,
    Destination: p.destination,
    SigninToken: p.signinToken,
  });
  return `${FEDERATION_ENDPOINT}?${params}`;
}

export function consoleDestination(region: string): string {
  return `https://${region}.console.aws.amazon.com/console/home?region=${region}`;
}

/**
 * "none,43200,43199" のような SessionDuration の一覧を読む。none は指定なし。
 * 値は 900〜43200 の整数。重複は 1 つにまとめる（先に出た順）。
 */
export function parseSessionDurations(raw: string): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  for (const item of raw.split(",").map((s) => s.trim())) {
    let v: number | undefined;
    if (item === "none") v = undefined;
    else if (/^\d+$/.test(item) && Number(item) >= 900 && Number(item) <= 43200) v = Number(item);
    else throw new Error(`invalid SessionDuration: '${item}' (none or 900-43200)`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function sessionDurationLabel(d: number | undefined): string {
  return d === undefined ? "none" : String(d);
}

/**
 * ログイン URL のファイル名。STS の DurationSeconds（未指定は default）と SessionDuration（未指定は none）の両方を入れ、
 * 別の回（--duration-seconds の有無）の URL と取り違えないようにする。destroy.sh は console-url-*.txt を消す。
 */
export function consoleUrlFileName(
  durationSeconds: number | undefined,
  sessionDuration: number | undefined,
  role: RoleKey = "base",
): string {
  const dur = durationSeconds === undefined ? "default" : String(durationSeconds);
  const prefix = role === "base" ? "console-url" : `console-url-${role}`;
  return `${prefix}-dur-${dur}-sd-${sessionDurationLabel(sessionDuration)}.txt`;
}

/** エラー応答の要約（タグ除去・空白を詰める・200 文字まで）。機密値（URL エンコード形も）は [REDACTED] に置き換える。 */
export function summarizeBody(body: string, secrets: string[], max = 200): string {
  let s = body;
  for (const secret of secrets.filter((x) => x !== "")) {
    for (const form of new Set([
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ x: secret }).toString().slice(2),
    ]))
      s = s.split(form).join("[REDACTED]");
  }
  s = s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
