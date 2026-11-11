// PoC P2〜P4（セッションタグ・SourceIdentity・緊急停止）の道具が共有する純粋関数。I/O は呼び出し側で行う。
import type { TemporaryCredentials } from "./lib";

// ---- P4 (a) ロールの Revoke Sessions ----
// 出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html
// コンソールの「Revoke active sessions」は AWSRevokeOlderSessions という名前のインラインポリシーを付け、
// aws:TokenIssueTime が「押した時刻の約 30 秒後」より前の一時認証情報の全操作を Deny する。

export const REVOKE_POLICY_NAME = "AWSRevokeOlderSessions";

/** 基準時刻（now + futureSeconds）。futureSeconds は 0〜3600。 */
export function revokeCutoff(now: Date, futureSeconds: number): Date {
  if (!Number.isInteger(futureSeconds) || futureSeconds < 0 || futureSeconds > 3600)
    throw new Error("futureSeconds must be an integer between 0 and 3600");
  return new Date(now.getTime() + futureSeconds * 1000);
}

/** AWSRevokeOlderSessions 相当のポリシー文書（JSON 文字列）。時刻は秒単位の UTC。 */
export function revokePolicyDocument(cutoff: Date): string {
  const t = `${cutoff.toISOString().slice(0, 19)}Z`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Action: ["*"],
        Resource: ["*"],
        Condition: { DateLessThan: { "aws:TokenIssueTime": t } },
      },
    ],
  });
}

// ---- (4-b) SourceIdentity で 1 人だけ止める ----
// ロールの権限ポリシーに、aws:SourceIdentity が一致するセッションの全操作を Deny する文を足す。
// SourceIdentity は引き受けのときに付き、そのセッションから派生した認証情報（コンソール・aws login）にも引き継がれる。
// 出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-sourceidentity
// 信頼ポリシーではないので、新しい引き受け自体は止まらない（引き受けたあとの API が拒否される）。

export const DENY_SOURCE_IDENTITY_POLICY_NAME = "AwsbridgeDenySourceIdentity";

/** SourceIdentity（2〜64 文字の [A-Za-z0-9_+=,.@-]。ワイルドカードは使えない）の一覧で Deny する文書（JSON 文字列）。 */
export function denySourceIdentityPolicyDocument(sourceIdentities: string[]): string {
  if (sourceIdentities.length === 0) throw new Error("止める SourceIdentity がありません");
  for (const v of sourceIdentities)
    if (!/^[\w+=,.@-]{2,64}$/.test(v))
      throw new Error(`SourceIdentity に使えない値です: '${v}'（2〜64 文字の [A-Za-z0-9_+=,.@-]）`);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyBySourceIdentity",
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: { StringEquals: { "aws:SourceIdentity": [...new Set(sourceIdentities)] } },
      },
    ],
  });
}

// ---- PoC 用リソースのガード（destroy.sh の awsbridge-human-poc* と同じ考え方） ----

export const POC_ROLE_PREFIX = "AwsbridgeHumanPoc";
export const POC_STACK_PREFIX = "awsbridge-human-poc";
export const POC_ISSUER_HOST_PREFIX = "awsbridge-human-poc.";

/** PoC 用のロール（パスなし、名前が AwsbridgeHumanPoc で始まる）の ARN だけを受け付け、ロール名を返す。 */
export function assertPocRoleArn(arn: string): string {
  const m = /^arn:aws[a-z-]*:iam::\d{12}:role\/([\w+=,.@-]+)$/.exec(arn);
  const name = m?.[1];
  if (!name?.startsWith(POC_ROLE_PREFIX))
    throw new Error(`PoC 用のロール（${POC_ROLE_PREFIX}*）ではない: '${arn}'`);
  return name;
}

/** PoC の issuer（ホストが awsbridge-human-poc. で始まり、host と一致）の OIDC プロバイダー ARN だけを受け付ける。 */
export function assertPocProviderArn(arn: string, host: string): string {
  const m = /^arn:aws[a-z-]*:iam::\d{12}:oidc-provider\/([A-Za-z0-9.-]+)$/.exec(arn);
  if (!m || m[1] !== host || !host.startsWith(POC_ISSUER_HOST_PREFIX))
    throw new Error(
      `PoC の issuer（${POC_ISSUER_HOST_PREFIX}*、AWSBRIDGE_HUMAN_POC_ISSUER と一致）の OIDC プロバイダーではない: '${arn}'`,
    );
  return arn;
}

export function assertPocStackName(stack: string): void {
  if (!stack.startsWith(POC_STACK_PREFIX))
    throw new Error(
      `PoC 用でないスタック名は扱わない: ${stack}（${POC_STACK_PREFIX} で始まる名前だけ）`,
    );
}

// ---- 出力の伏せ字 ----

/** email（u***@***.com。セッション名の human- は残す）と ARN の中のアカウント ID（<account>）を伏せる。結果を README に貼れるようにするため。 */
export function maskSensitive(s: string): string {
  return s
    .replace(
      /(?<![A-Za-z0-9._%+-])(human-)?([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})/g,
      "$1$2***@***.$3",
    )
    .replace(/(arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:)\d{12}(:)/g, "$1<account>$2");
}

// ---- AWS CLI ----

/** AWS CLI の stderr からエラーコードを取り出す。分からなければ NoCredentials / Unknown。 */
export function parseCliErrorCode(stderr: string): string {
  const m = /An error occurred \(([\w.]+)\)/.exec(stderr);
  if (m?.[1]) return m[1];
  if (/Unable to locate credentials/.test(stderr)) return "NoCredentials";
  return "Unknown";
}

/**
 * 一時認証情報で AWS CLI を呼ぶための環境変数。認証情報は引数に載せず環境変数で渡す。
 * プロファイル指定（AWS_PROFILE / AWS_DEFAULT_PROFILE）は外す（プロファイル側の認証情報に化けないように）。
 */
export function credentialsEnv(
  base: Record<string, string | undefined>,
  creds: TemporaryCredentials,
  region: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && k !== "AWS_PROFILE" && k !== "AWS_DEFAULT_PROFILE") env[k] = v;
  env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
  env.AWS_SESSION_TOKEN = creds.sessionToken;
  env.AWS_REGION = region;
  return env;
}
