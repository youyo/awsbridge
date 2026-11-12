// PoC（awsbridge 方式を人間の AWS ログインに使えるか）の純粋関数。I/O は呼び出し側（*.ts のスクリプト）で行う。
// MCP 経路（src/、infra/aws/awsbridge.yaml）とは別の issuer・署名鍵・ロール・audience を使う。
// 設定は AWSBRIDGE_HUMAN_POC_* だけを読み、MCP 用の AWSBRIDGE_ISSUER / AWSBRIDGE_STACK_NAME などは読まない。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importJWK, type JWK, SignJWT } from "jose";
import { publicJwkOf, thumbprintOf } from "../../../src/keys";
import { buildDiscovery } from "../../../src/oidc";

// Worker でも使う純粋関数（claim・STS・Federation）は claims.ts に置き、ここから再エクスポートする
import { sessionTagClaims, sourceIdentityClaim } from "./claims";

export * from "./claims";

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
  /** (4-b) 2 人目の利用者（別の SourceIdentity）。Tagged の信頼ポリシーに SecondSubject として足す */
  secondSubject: string | undefined;
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
    secondSubject: get("AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT")?.toLowerCase(),
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

// ---- ロールの選択（スタックの Output） ----

export const ROLE_KEYS = ["base", "tagged", "notag", "localonly", "viewer"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export function isRoleKey(v: string): v is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(v);
}

/**
 * base = 既存の AwsbridgeHumanPoc、tagged = AwsbridgeHumanPocTagged、notag = AwsbridgeHumanPocNoTag、
 * localonly = AwsbridgeHumanPocLocalOnly（aws login を localhost だけに絞ったロール）、
 * viewer = AwsbridgeHumanPocViewer（コンソールの Viewer と同じ形。aws login は localhost と remote、SourceIdentity 必須）の Output 名。
 */
export function roleOutputKey(role: RoleKey): string {
  return {
    base: "RoleArn",
    tagged: "TaggedRoleArn",
    notag: "NoTagRoleArn",
    localonly: "LocalOnlyRoleArn",
    viewer: "ViewerRoleArn",
  }[role];
}

/**
 * 引き受け直し（stop-watch の --assume）で JWT に足すクレーム。tagged はセッションタグ access_profile と SourceIdentity、
 * viewer は SourceIdentity だけ（信頼ポリシーが求める）。ほかのロールは何も足さない。SourceIdentity の値は subject。
 */
export function assumeClaimsFor(
  role: RoleKey,
  subject: string,
  accessProfile: string,
): Record<string, unknown> {
  if (role === "tagged")
    return {
      ...sessionTagClaims({ access_profile: accessProfile }, "nested"),
      ...sourceIdentityClaim(subject),
    };
  if (role === "viewer") return sourceIdentityClaim(subject);
  return {};
}

// ---- 利用者の選択（(4-b) 1 人だけ止める Deny の対照に 2 人目を使う） ----

export const WHO_KEYS = ["primary", "second"] as const;
export type Who = (typeof WHO_KEYS)[number];

export function isWho(v: string): v is Who {
  return (WHO_KEYS as readonly string[]).includes(v);
}

/** primary = AWSBRIDGE_HUMAN_POC_SUBJECT、second = AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT。未設定・同じ値は例外。 */
export function subjectFor(settings: HumanPocSettings, who: Who): string {
  if (!settings.subject) throw new Error("AWSBRIDGE_HUMAN_POC_SUBJECT が未設定です");
  if (who === "primary") return settings.subject;
  if (!settings.secondSubject) throw new Error("AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT が未設定です");
  if (settings.secondSubject === settings.subject)
    throw new Error(
      "AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT が AWSBRIDGE_HUMAN_POC_SUBJECT と同じです（別の利用者にする）",
    );
  return settings.secondSubject;
}

/** ファイル名の接頭辞の後ろに付ける部分（base・primary は従来どおり何も付けない）。 */
function fileTag(role: RoleKey, who: Who): string {
  return [role === "base" ? "" : `-${role}`, who === "primary" ? "" : `-${who}`].join("");
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

/** 認証情報のファイル名。base は従来どおり credentials.json、2 人目は -second を付ける。destroy.sh は credentials*.json を消す。 */
export function credentialsFileName(role: RoleKey, who: Who = "primary"): string {
  return `credentials${fileTag(role, who)}.json`;
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
  who: Who = "primary",
): string {
  const dur = durationSeconds === undefined ? "default" : String(durationSeconds);
  return `console-url${fileTag(role, who)}-dur-${dur}-sd-${sessionDurationLabel(sessionDuration)}.txt`;
}
