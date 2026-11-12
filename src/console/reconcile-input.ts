// 突き合わせの道具の入力: 発行記録の行と、CloudTrail の AssumeRoleWithWebIdentity のイベントを読む（純粋な関数。node:* を import しない）。
// 判定は reconcile.ts。読み取りの CLI は scripts/console/reconcile.ts。設計: docs/specs/console-login.md §5.6。
//
// 発行記録（Worker の console_issue の構造化ログ。src/console/issue/record.ts の issueLogRecord の形）の入れ物は 3 つを読む:
//   1. 生の行            {"event":"console_issue", ...}（console.log の 1 行）
//   2. Trace Events の包み {"ScriptName":..., "Logs":[{"Message":["<JSON の文字列>"]}]}（Logpush の workers_trace_events）
//   3. Workers Logs のイベント {"$metadata":{...}, "$workers":{...}, "source": <オブジェクトか JSON の文字列>}
//      （Cloudflare の API POST .../workers/observability/telemetry/query の events と同じ形）
// 切られた行（$cloudflare.truncated・$workers.truncated・Trace Events の Truncated・Logpush の「<<<Logpush: … truncated>>>」）は、
// 記録を読む前に位置だけを返す（cto の決裁 (c): 切られた行は誤り。記録が欠けたかどうかを確かめられないため）。
// 読めない行（JSON でない・記録の形が壊れている）も位置だけを返す。どちらも値は返さない（email を出さない）。
//
// CloudTrail のイベントのフィールド名は [推測]（AWS の文書の例に合わせた。② の最初に実物で確かめてフィクスチャを取り直す）。
// STS の ID は発行記録と同じ伏せ字にしてから持つ（AssumedRoleId のセッション名に email が入るため）。
import type { Tier } from "./constants";
import { maskAccessKeyId, maskAssumedRoleId, maskEmail, maskRequestId } from "./issue/record";

/** 突き合わせに使う発行記録の項目。STS の ID は伏せ字（issueLogRecord の形のまま）。 */
export type ReconRecord = {
  /** 入力の中の位置（<ファイル>:<行> か api#<番号>）。 */
  pos: string;
  result: string;
  /** epoch ミリ秒。 */
  at: number;
  tier: Tier | string;
  team: string;
  /** 全桁（12 桁）。古い形の記録は伏せ字（********1234）。 */
  accountId: string;
  roleArn?: string;
  stsRegion: string;
  jti?: string;
  iat?: number;
  exp?: number;
  kid?: string;
  /**
   * 利用者の伏せ字（a***@***.com）。SourceIdentity に使った値（user.sourceIdentity。無ければ user.email）を maskEmail にかけたもの。
   * 発行記録（issueLogRecord）は email を伏せて残すので、CloudTrail の SourceIdentity も同じ形に伏せて比べる（弱い一致）。
   */
  identity?: string;
  accessKeyId?: string;
  assumedRoleId?: string;
  requestId?: string;
};

export type RecordRead = {
  records: ReconRecord[];
  /** 切られた行の位置。 */
  truncated: string[];
  /** 読めない行の位置。 */
  unreadable: string[];
  /** 読んだ行（イベント）の数（空行を除く）。 */
  lines: number;
};

export type ReadRecordOptions = {
  /** 渡せば、Worker の名前（$workers.scriptName・ScriptName）がこの外の行は数えない。名前の無い行は数える。 */
  workers?: readonly string[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const TRUNCATED_MARK_RE = /<<<Logpush:[^>]*truncated>>>/i;

/** 切られた印があるか（入れ物の 3 つの形のどれでも）。 */
function isTruncated(o: Obj): boolean {
  if (isObj(o.$cloudflare) && o.$cloudflare.truncated === true) return true;
  if (isObj(o.$workers) && o.$workers.truncated === true) return true;
  if (o.Truncated === true || o.truncated === true) return true;
  if (Array.isArray(o.Logs))
    for (const l of o.Logs) {
      const msg = isObj(l) ? l.Message : undefined;
      for (const m of Array.isArray(msg) ? msg : [msg])
        if (typeof m === "string" && TRUNCATED_MARK_RE.test(m)) return true;
    }
  return false;
}

/** Worker の名前（Workers Logs のイベントと Trace Events の包み）。 */
function scriptNameOf(o: Obj): string | undefined {
  return (isObj(o.$workers) ? str(o.$workers.scriptName) : undefined) ?? str(o.ScriptName);
}

class Unreadable extends Error {}

/** 文字列なら JSON として読む（console_issue らしい文字列が読めなければ Unreadable）。 */
function asObject(v: unknown): Obj | undefined {
  if (isObj(v)) return v;
  if (typeof v !== "string") return undefined;
  try {
    const p = JSON.parse(v) as unknown;
    return isObj(p) ? p : undefined;
  } catch {
    if (v.includes("console_issue")) throw new Unreadable();
    return undefined;
  }
}

/** 1 つの入れ物（行）から console_issue の本体を取り出す（無ければ空）。 */
function issueBodies(o: Obj): Obj[] {
  // 2. Trace Events の包み
  if (Array.isArray(o.Logs)) {
    const out: Obj[] = [];
    for (const l of o.Logs) {
      const msg = isObj(l) ? l.Message : undefined;
      const first = Array.isArray(msg) ? msg[0] : msg;
      const body = asObject(first);
      if (body?.event === "console_issue") out.push(body);
    }
    return out;
  }
  // 3. Workers Logs のイベント
  if ("source" in o || "$metadata" in o) {
    const body = asObject(o.source);
    if (body?.event === "console_issue") return [body];
    const message = isObj(o.$metadata) ? o.$metadata.message : undefined;
    const fromMessage = asObject(message);
    return fromMessage?.event === "console_issue" ? [fromMessage] : [];
  }
  // 1. 生の行
  return o.event === "console_issue" ? [o] : [];
}

/** console_issue の本体を ReconRecord にする（形が違えば Unreadable）。 */
function toRecord(b: Obj, pos: string): ReconRecord {
  const result = str(b.result);
  const atText = str(b.at);
  const at = atText !== undefined ? Date.parse(atText) : Number.NaN;
  const tier = str(b.tier);
  const team = str(b.team);
  const target = isObj(b.target) ? b.target : undefined;
  const accountId = str(target?.accountId);
  const sts = isObj(b.sts) ? b.sts : undefined;
  const stsRegion = str(sts?.region);
  if (
    result === undefined ||
    Number.isNaN(at) ||
    tier === undefined ||
    team === undefined ||
    accountId === undefined ||
    stsRegion === undefined
  )
    throw new Unreadable();
  const user = isObj(b.user) ? b.user : undefined;
  const who = str(user?.sourceIdentity) ?? str(user?.email);
  const jwt = b.jwt;
  if (jwt !== undefined && (!isObj(jwt) || typeof jwt.jti !== "string" || jwt.jti === ""))
    throw new Unreadable();
  const roleArn = str(target?.roleArn);
  const opt = <K extends string>(k: K, v: string | number | undefined) =>
    v !== undefined ? ({ [k]: v } as Record<K, string | number>) : {};
  return {
    pos,
    result,
    at,
    tier,
    team,
    accountId,
    ...opt("roleArn", roleArn),
    stsRegion,
    ...(isObj(jwt)
      ? {
          ...opt("jti", str(jwt.jti)),
          ...opt("iat", num(jwt.iat)),
          ...opt("exp", num(jwt.exp)),
          ...opt("kid", str(jwt.kid)),
        }
      : {}),
    ...opt("identity", who !== undefined && who !== "" ? maskEmail(who) : undefined),
    ...opt("accessKeyId", str(sts?.accessKeyId)),
    ...opt("assumedRoleId", str(sts?.assumedRoleId)),
    ...opt("requestId", str(sts?.requestId)),
  } as ReconRecord;
}

/** 1 つの入れ物を読んで out に足す。 */
function readOne(v: unknown, pos: string, out: RecordRead, o: ReadRecordOptions): void {
  if (!isObj(v)) {
    out.lines++;
    out.unreadable.push(pos);
    return;
  }
  const name = scriptNameOf(v);
  if (o.workers !== undefined && name !== undefined && !o.workers.includes(name)) return;
  out.lines++;
  // 切られた印は記録を読む前に見る（切られた記録は console_issue として読めないことがあるため）
  if (isTruncated(v)) {
    out.truncated.push(pos);
    return;
  }
  try {
    for (const b of issueBodies(v)) out.records.push(toRecord(b, pos));
  } catch (e) {
    if (!(e instanceof Unreadable)) throw e;
    out.unreadable.push(pos);
  }
}

const empty = (): RecordRead => ({ records: [], truncated: [], unreadable: [], lines: 0 });

/** NDJSON の中身を読む。label はファイルの名前（位置に使う）。 */
export function readRecordLines(
  text: string,
  label: string,
  o: ReadRecordOptions = {},
): RecordRead {
  const out = empty();
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const pos = `${label}:${i + 1}`;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      out.lines++;
      out.unreadable.push(pos);
      return;
    }
    readOne(v, pos, out, o);
  });
  return out;
}

/** Cloudflare の API（telemetry/query）の events を読む。位置は <label>#<番号>（1 から）。 */
export function recordsFromLogEvents(
  events: readonly unknown[],
  label: string,
  o: ReadRecordOptions = {},
): RecordRead {
  const out = empty();
  events.forEach((v, i) => {
    readOne(v, `${label}#${i + 1}`, out, o);
  });
  return out;
}

/** 2 つの読み取りの結果を 1 つにまとめる。 */
export function mergeRecordReads(reads: readonly RecordRead[]): RecordRead {
  const out = empty();
  for (const r of reads) {
    out.records.push(...r.records);
    out.truncated.push(...r.truncated);
    out.unreadable.push(...r.unreadable);
    out.lines += r.lines;
  }
  return out;
}

// ---- CloudTrail ----

/** 突き合わせに使う AssumeRoleWithWebIdentity のイベントの項目。STS の ID は伏せ字。email・セッション名は持たない。 */
export type AssumeEvent = {
  eventId?: string;
  /** epoch ミリ秒。 */
  time: number;
  /** awsRegion（STS を呼んだリージョン）。 */
  region: string;
  /** recipientAccountId。 */
  accountId?: string;
  roleArn?: string;
  /** userIdentity.identityProvider（プロバイダーの ARN か、URL のホストとパス）。 */
  provider?: string;
  /** requestParameters.webIdentityTokenId（= JWT の jti）。 */
  tokenId?: string;
  errorCode?: string;
  /** requestParameters.sourceIdentity（無ければ responseElements.sourceIdentity）を maskEmail にかけたもの。素の値は持たない。 */
  sourceIdentity?: string;
  accessKeyId?: string;
  assumedRoleId?: string;
  requestId?: string;
};

/** CloudTrailEvent（JSON の文字列か、読んだオブジェクト）を読む。読めなければ例外（値は文に入れない）。 */
export function parseAssumeEvent(raw: unknown): AssumeEvent {
  let e: unknown = raw;
  if (typeof raw === "string") {
    try {
      e = JSON.parse(raw);
    } catch {
      throw new Error("CloudTrailEvent: json");
    }
  }
  if (!isObj(e)) throw new Error("CloudTrailEvent: type");
  if (e.eventName !== "AssumeRoleWithWebIdentity") throw new Error("CloudTrailEvent: eventName");
  const timeText = str(e.eventTime);
  const time = timeText !== undefined ? Date.parse(timeText) : Number.NaN;
  if (Number.isNaN(time)) throw new Error("CloudTrailEvent: eventTime");
  const region = str(e.awsRegion);
  if (region === undefined || region === "") throw new Error("CloudTrailEvent: awsRegion");
  const ui = isObj(e.userIdentity) ? e.userIdentity : {};
  const rp = isObj(e.requestParameters) ? e.requestParameters : {};
  const re = isObj(e.responseElements) ? e.responseElements : {};
  const creds = isObj(re.credentials) ? re.credentials : {};
  const aru = isObj(re.assumedRoleUser) ? re.assumedRoleUser : {};
  const opt = (k: keyof AssumeEvent, v: string | undefined) =>
    v !== undefined && v !== "" ? { [k]: v } : {};
  const accessKeyId = str(creds.accessKeyId);
  const assumedRoleId = str(aru.assumedRoleId);
  const requestId = str(e.requestID);
  // フィールドの位置は [推測]（資料: N6 の K4 でイベントに sourceIdentity が出ることは確認済み。位置は ② の最初に実物で確かめる）
  const sourceIdentity = str(rp.sourceIdentity) ?? str(re.sourceIdentity);
  return {
    ...opt("eventId", str(e.eventID)),
    time,
    region,
    ...opt("accountId", str(e.recipientAccountId)),
    ...opt("roleArn", str(rp.roleArn)),
    ...opt("provider", str(ui.identityProvider)),
    ...opt("tokenId", str(rp.webIdentityTokenId)),
    ...opt("errorCode", str(e.errorCode)),
    ...opt(
      "sourceIdentity",
      sourceIdentity !== undefined && sourceIdentity !== "" ? maskEmail(sourceIdentity) : undefined,
    ),
    ...opt("accessKeyId", accessKeyId !== undefined ? maskAccessKeyId(accessKeyId) : undefined),
    ...opt(
      "assumedRoleId",
      assumedRoleId !== undefined ? maskAssumedRoleId(assumedRoleId) : undefined,
    ),
    ...opt("requestId", requestId !== undefined ? maskRequestId(requestId) : undefined),
  } as AssumeEvent;
}
