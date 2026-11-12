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

// ---- aws login（signin.amazonaws.com の AuthorizeOAuth2Access / CreateOAuth2Token） ----

/** 値を出さないキー（トークン・認可コード・state・PKCE・鍵・秘密）。キー名の最後の要素で判定する。 */
const SECRET_KEY =
  /tokens?$|secret|password|assertion|verifier|dpop|privatekey|^code$|authorizationcode|^state$|challenge$/i;

/** IPv4 は上位 2 オクテットだけ、IPv6 は先頭 2 グループだけ、それ以外（AWS 内部の名前など）はそのまま。 */
function maskIp(ip: string): string {
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 2).join(":")}:x`;
  return ip;
}

/**
 * aws login のイベントを「パス = 値」に平らにする（resources・additionalEventData も含む）。
 * remote と localhost を見分けられるフィールドを探すため、項目を決め打ちしない。
 * 秘密になりうる値は <redacted>、アカウント ID・email は伏せ、送信元 IP は下位を伏せる。
 */
export function signinEventFields(ev: Json): Record<string, string> {
  const out: Record<string, string> = {};
  // secret: 祖先のどれかが秘密名のキーなら、子（オブジェクト・配列の中身）もすべて伏せる
  const walk = (v: Json, path: string, secret: boolean) => {
    const last = path.split(".").pop() ?? "";
    const hidden = secret || SECRET_KEY.test(last);
    if (v !== null && typeof v === "object") {
      for (const [k, c] of Object.entries(v)) walk(c, path === "" ? k : `${path}.${k}`, hidden);
      return;
    }
    if (hidden) {
      out[path] = "<redacted>";
      return;
    }
    const s = String(v);
    out[path] =
      path === "sourceIPAddress" ? maskIp(s) : maskSensitive(s).replace(/\b\d{12}\b/g, "<account>");
  };
  walk(ev, "", false);
  return out;
}

/** signin のイベントを新しい順に、1 件ごとに見出しと「パス = 値」の行で出す。 */
export function formatSigninEvents(events: Json[]): string {
  return events
    .map((ev) => {
      const f = signinEventFields(ev);
      const head = `### ${f.eventTime ?? "-"} ${f.eventName ?? "-"} ${f.awsRegion ?? "-"} ${f.errorCode ? `エラー ${f.errorCode}` : "成功"}`;
      const lines = Object.entries(f)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `- ${k} = ${v}`);
      return [head, ...lines].join("\n");
    })
    .join("\n\n");
}

/**
 * trail --signin の既定の絞り込み: PoC のロール（sessionIssuer が AwsbridgeHumanPoc*）のセッションのイベントか、
 * userIdentity が無い（主体が分からない）イベント。利用者のほかのセッション（SSO など）の aws login は除く。
 */
export function isPocSigninEvent(ev: Json): boolean {
  if (ev?.userIdentity === undefined || ev?.userIdentity === null) return true;
  const issuer = str(ev?.userIdentity?.sessionContext?.sessionIssuer?.arn).split("/").pop() ?? "";
  return issuer.startsWith(POC_ROLE_PREFIX);
}
