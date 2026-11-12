// コンソールログインの発行: 発行記録の型と、伏せ字にして出す関数。Worker に入るので node:* を import しない。
// 設計: docs/specs/console-login-portal.md §10.3、console-login.md §5.6。
//   CloudTrail との突き合わせの主なキーは jti（requestParameters.webIdentityTokenId）。あわせて STS の応答の
//   AccessKeyId・AssumedRoleId・RequestId と、時刻・アカウント ID で引く。STS のリージョンは CloudTrail の記録先を決める。
//   Access の sub と（取れれば）Entra の oid も残す（email の変更・再利用のあとで誰の発行かをたどるため）。
// 記録には、秘密鍵・セッショントークン・SigninToken・ログイン URL を入れない（入力にも持たない）。アカウントの email も残さない。
// createIssueRecord の戻り値は完全な形、maskIssueRecord は画面・共有するログに貼れる形。
// issueLogRecord は Worker のログ（Workers Logs。② の置き場所）に出す形: 突き合わせのキーの jti・kid・アカウント ID・ロール ARN と
// Worker の版 ID は全桁、email・SourceIdentity・Access の sub・oid・STS の ID は伏せる（cto の決裁 2026-11-13）。
// 突き合わせの道具（src/console/reconcile.ts）はこの形を読む。
import type { Tier } from "../constants";
import type { IssueErrorCode } from "./errors";
import type { AccessIdentity, ResolvedIdentity } from "./identity";
import type { IssueRow } from "./signer";

export type IssueRecord = {
  /** `ok` か portal §9.4 の code。 */
  result: "ok" | IssueErrorCode;
  /** ISO 8601（UTC）。 */
  at: string;
  tier: Tier;
  team: string;
  user: {
    email: string;
    /** SourceIdentity に使った値。 */
    sourceIdentity: string;
    accessSub: string;
    oid?: string;
  };
  target: {
    accountId: string;
    role: string;
    roleArn: string;
    boundary: string;
    issuer: string;
  };
  /** 署名に進んでいなければない。JWT 自体は残さない。kid は署名した鍵（JWT のヘッダー）。 */
  jwt?: { jti: string; iat: number; exp: number; kid?: string };
  sts: {
    /** AssumeRoleWithWebIdentity を呼んだ STS のリージョン（CloudTrail の記録先）。 */
    region: string;
    accessKeyId?: string;
    assumedRoleId?: string;
    requestId?: string;
  };
  session: { seconds: number; consoleRegion: string };
  /** Cf-Ray（要求 ID）。 */
  cfRay?: string;
  /** 一覧の版。 */
  list?: { generatedAt: string; sourceRevision?: string };
  /** 発行した Worker の版（CF_VERSION_METADATA の id。取れたときだけ）。 */
  worker?: { versionId: string };
};

export type IssueRecordInput = {
  tier: Tier;
  result: IssueRecord["result"];
  /** epoch ミリ秒。 */
  now: number;
  identity: AccessIdentity;
  resolved: ResolvedIdentity;
  row: IssueRow;
  token?: { jti: string; iat: number; exp: number; kid?: string | undefined } | undefined;
  consoleRegion: string;
  sts: IssueRecord["sts"];
  cfRay?: string | undefined;
  list?: { generatedAt: string; sourceRevision?: string | undefined } | undefined;
  workerVersionId?: string | undefined;
};

export function createIssueRecord(i: IssueRecordInput): IssueRecord {
  return {
    result: i.result,
    at: new Date(i.now).toISOString(),
    tier: i.tier,
    team: i.row.team,
    user: {
      email: i.resolved.email,
      sourceIdentity: i.resolved.sourceIdentity,
      accessSub: i.identity.sub,
      ...(i.identity.oid !== undefined ? { oid: i.identity.oid } : {}),
    },
    target: {
      accountId: i.row.accountId,
      role: i.row.role,
      roleArn: i.row.roleArn,
      boundary: i.row.boundary,
      issuer: i.row.issuer,
    },
    ...(i.token !== undefined
      ? {
          jwt: {
            jti: i.token.jti,
            iat: i.token.iat,
            exp: i.token.exp,
            ...(i.token.kid !== undefined ? { kid: i.token.kid } : {}),
          },
        }
      : {}),
    sts: {
      region: i.sts.region,
      ...(i.sts.accessKeyId !== undefined ? { accessKeyId: i.sts.accessKeyId } : {}),
      ...(i.sts.assumedRoleId !== undefined ? { assumedRoleId: i.sts.assumedRoleId } : {}),
      ...(i.sts.requestId !== undefined ? { requestId: i.sts.requestId } : {}),
    },
    session: { seconds: i.row.sessionSeconds, consoleRegion: i.consoleRegion },
    ...(i.cfRay !== undefined ? { cfRay: i.cfRay } : {}),
    ...(i.list !== undefined
      ? {
          list: {
            generatedAt: i.list.generatedAt,
            ...(i.list.sourceRevision !== undefined
              ? { sourceRevision: i.list.sourceRevision }
              : {}),
          },
        }
      : {}),
    ...(i.workerVersionId !== undefined ? { worker: { versionId: i.workerVersionId } } : {}),
  };
}

// ---- 伏せ字 ----

/** 先頭 n 文字だけ残す。 */
const head = (s: string, n: number) => `${s.slice(0, n)}…`;

/** email を a***@***.com の形にする。email でなければ先頭 1 文字だけ残す。 */
export function maskEmail(email: string): string {
  const m = /^([^@\s])[^@\s]*@[^@\s]+\.([A-Za-z]{2,})$/.exec(email);
  return m ? `${m[1]}***@***.${m[2]}` : `${email.slice(0, 1)}***`;
}

/** 12 桁のアカウント ID の末尾 4 桁だけ残す。 */
export const maskAccountId = (id: string): string =>
  /^\d{12}$/.test(id) ? `********${id.slice(-4)}` : "***";

/** ロール ARN の中のアカウント ID を伏せる。 */
export const maskRoleArn = (arn: string): string =>
  arn.replace(/\b\d{12}\b/g, (id) => maskAccountId(id));

/** AccessKeyId の先頭 4 文字（ASIA など）と末尾 4 文字だけ残す。 */
export const maskAccessKeyId = (id: string): string => `${id.slice(0, 4)}…${id.slice(-4)}`;

/** AssumedRoleId（<ロール ID>:<セッション名>）は、セッション名に email が入るので ID の先頭 4 文字だけ残す。 */
export const maskAssumedRoleId = (id: string): string => head(id, 4);

/** STS の要求 ID（RequestId）は先頭 8 文字だけ残す。 */
export const maskRequestId = (id: string): string => head(id, 8);

export function maskIssueRecord(r: IssueRecord): IssueRecord {
  return {
    ...r,
    user: {
      email: maskEmail(r.user.email),
      sourceIdentity: maskEmail(r.user.sourceIdentity),
      accessSub: head(r.user.accessSub, 4),
      ...(r.user.oid !== undefined ? { oid: head(r.user.oid, 4) } : {}),
    },
    target: {
      ...r.target,
      accountId: maskAccountId(r.target.accountId),
      roleArn: maskRoleArn(r.target.roleArn),
    },
    ...(r.jwt !== undefined ? { jwt: { ...r.jwt, jti: head(r.jwt.jti, 8) } } : {}),
    sts: {
      region: r.sts.region,
      ...(r.sts.accessKeyId !== undefined
        ? { accessKeyId: maskAccessKeyId(r.sts.accessKeyId) }
        : {}),
      ...(r.sts.assumedRoleId !== undefined
        ? { assumedRoleId: maskAssumedRoleId(r.sts.assumedRoleId) }
        : {}),
      ...(r.sts.requestId !== undefined ? { requestId: maskRequestId(r.sts.requestId) } : {}),
    },
  };
}

/**
 * Worker のログに出す発行記録。maskIssueRecord の伏せ字に、突き合わせのキー（jti・kid・アカウント ID・ロール ARN）を
 * 全桁で戻した形（cto の決裁 2026-11-13。アカウント ID は秘密ではない。email は伏せたまま）。
 */
export function issueLogRecord(r: IssueRecord): IssueRecord {
  const m = maskIssueRecord(r);
  return {
    ...m,
    target: { ...m.target, accountId: r.target.accountId, roleArn: r.target.roleArn },
    ...(r.jwt !== undefined ? { jwt: { ...r.jwt } } : {}),
  };
}
