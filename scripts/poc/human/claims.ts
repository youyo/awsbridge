// PoC（人間のログイン）の純粋関数のうち、Node の API に依存しないもの（JWT の claim・STS・Federation）。
// 手元のスクリプト（lib.ts が再エクスポートする）と PoC のポータル Worker（portal/）の両方が使う。
// Worker に入るので node:* を import しない。
import { buildSessionName } from "../../../src/oidc";

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
export function loginUrl(p: {
  signinToken: string;
  issuer: string;
  destination: string;
  /** 既定は FEDERATION_ENDPOINT（E2E で擬似のエンドポイントを指すときだけ変える） */
  endpoint?: string;
}): string {
  const params = new URLSearchParams({
    Action: "login",
    Issuer: p.issuer,
    Destination: p.destination,
    SigninToken: p.signinToken,
  });
  return `${p.endpoint ?? FEDERATION_ENDPOINT}?${params}`;
}

export function consoleDestination(region: string): string {
  return `https://${region}.console.aws.amazon.com/console/home?region=${region}`;
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
