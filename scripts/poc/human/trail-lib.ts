// PoC P2・P3 の CloudTrail 確認（trail.ts）の純粋関数。
// 形は https://docs.aws.amazon.com/IAM/latest/UserGuide/cloudtrail-integration.html の
// 「Example OIDC AWS STS API event in CloudTrail log file」に合わせる。項目が欠けていても落ちないように読む。
import { markdownTable } from "./cases";
import { maskSensitive, POC_ROLE_PREFIX } from "./ops";

// biome-ignore lint/suspicious/noExplicitAny: CloudTrail のイベントは任意の形をとる
type Json = any;

/** aws cloudtrail lookup-events --output json の出力から、CloudTrailEvent（JSON 文字列）を読んだものを返す。壊れたものは飛ばす。 */
export function parseLookupEvents(json: string): Json[] {
  const v: Json = JSON.parse(json);
  const events: Json[] = Array.isArray(v?.Events) ? v.Events : [];
  const out: Json[] = [];
  for (const e of events) {
    try {
      const parsed: Json = JSON.parse(String(e?.CloudTrailEvent));
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // 壊れたイベントは飛ばす
    }
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface AssumeRow {
  time: string;
  region: string;
  role: string;
  sessionName: string;
  errorCode: string;
  sourceIdentityRequest: string;
  sourceIdentityResponse: string;
  tags: Record<string, string>;
  accessKeyId: string | undefined;
  tokenUtilization: number | undefined;
}

/** AssumeRoleWithWebIdentity のイベントを行にする。PoC のロール（AwsbridgeHumanPoc*）以外は undefined。 */
export function assumeEventRow(ev: Json): AssumeRow | undefined {
  const req = ev?.requestParameters ?? {};
  const res = ev?.responseElements ?? {};
  const role = str(req.roleArn).split("/").pop() ?? "";
  if (!role.startsWith(POC_ROLE_PREFIX)) return undefined;
  const tags: Record<string, string> = {};
  if (req.principalTags && typeof req.principalTags === "object")
    for (const [k, v] of Object.entries(req.principalTags as Record<string, unknown>))
      tags[k] = String(v);
  const akid = str(res?.credentials?.accessKeyId);
  const util = res?.sessionTokenUtilization ?? res?.packedPolicySize;
  return {
    time: str(ev?.eventTime),
    region: str(ev?.awsRegion),
    role,
    sessionName: str(req.roleSessionName),
    errorCode: str(ev?.errorCode),
    sourceIdentityRequest: str(req.sourceIdentity),
    sourceIdentityResponse: str(res?.sourceIdentity),
    tags,
    accessKeyId: akid === "" ? undefined : akid,
    tokenUtilization: typeof util === "number" ? util : undefined,
  };
}

export interface ApiRow {
  /** userIdentity.accessKeyId（表示は末尾 4 文字。コンソール・aws login は引き受けの時と別のキーになる） */
  key: string;
  time: string;
  region: string;
  eventName: string;
  eventSource: string;
  sourceIdentity: string;
  errorCode: string;
  arn: string;
}

/** 引き受けたあとの API イベントを行にする（userIdentity.sessionContext.sourceIdentity を見る）。 */
export function apiEventRow(ev: Json): ApiRow {
  return {
    key: str(ev?.userIdentity?.accessKeyId),
    time: str(ev?.eventTime),
    region: str(ev?.awsRegion),
    eventName: str(ev?.eventName),
    eventSource: str(ev?.eventSource),
    sourceIdentity: str(ev?.userIdentity?.sessionContext?.sourceIdentity),
    errorCode: str(ev?.errorCode),
    arn: str(ev?.userIdentity?.arn),
  };
}

/**
 * セッション名（Username）で引いたイベントのうち、PoC のロール（sessionContext.sessionIssuer が AwsbridgeHumanPoc*）の
 * セッションでの API イベントか。AssumeRoleWithWebIdentity 自体は除く。
 */
export function isPocSessionEvent(ev: Json): boolean {
  if (str(ev?.eventName) === "AssumeRoleWithWebIdentity") return false;
  const issuer = str(ev?.userIdentity?.sessionContext?.sessionIssuer?.arn).split("/").pop() ?? "";
  return issuer.startsWith(POC_ROLE_PREFIX);
}

/** タグの表示。3 個までは k=v（値は 20 文字まで）、それより多ければ個数と先頭 2 つ。 */
export function tagsLabel(tags: Record<string, string>): string {
  const entries = Object.entries(tags);
  if (entries.length === 0) return "-";
  const kv = ([k, v]: [string, string]) => `${k}=${v.length > 20 ? `${v.slice(0, 20)}…` : v}`;
  if (entries.length <= 3) return entries.map(kv).join(", ");
  return `${entries.length} 個: ${entries.slice(0, 2).map(kv).join(", ")}, …`;
}

/** アクセスキー ID は末尾 4 文字だけ出す（同じセッションかの見分けに使う）。 */
export function shortKey(akid: string | undefined): string {
  return akid ? `…${akid.slice(-4)}` : "-";
}

const dash = (s: string) => (s === "" ? "-" : s);

export function formatAssumeRows(rows: AssumeRow[]): string {
  return maskSensitive(
    markdownTable(
      [
        "時刻",
        "リージョン",
        "ロール",
        "セッション名",
        "エラー",
        "SI（要求）",
        "SI（応答）",
        "タグ",
        "キー",
        "使用率",
      ],
      rows.map((r) => [
        r.time,
        r.region,
        r.role,
        dash(r.sessionName),
        dash(r.errorCode),
        dash(r.sourceIdentityRequest),
        dash(r.sourceIdentityResponse),
        tagsLabel(r.tags),
        shortKey(r.accessKeyId),
        r.tokenUtilization === undefined ? "-" : `${r.tokenUtilization}%`,
      ]),
    ),
  );
}

export function formatApiRows(rows: ApiRow[]): string {
  return maskSensitive(
    markdownTable(
      [
        "時刻",
        "リージョン",
        "イベント",
        "サービス",
        "sessionContext.sourceIdentity",
        "エラー",
        "キー",
        "ARN",
      ],
      rows.map((r) => [
        r.time,
        r.region,
        r.eventName,
        r.eventSource,
        dash(r.sourceIdentity),
        dash(r.errorCode),
        shortKey(r.key === "" ? undefined : r.key),
        dash(r.arn),
      ]),
    ),
  );
}
