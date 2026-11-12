// 本番用の STS AssumeRoleWithWebIdentity クライアント。署名不要なので fetch + XML パースだけで呼ぶ。
// 設計: docs/specs/architecture.md（決定事項の STS 行、PoC 結果のエラー分類）。
import {
  parseAssumedRoleId,
  parseAssumeRoleResponse,
  parseRequestId,
  parseStsError,
} from "./sts-xml";

export type StsErrorKind = "invalid_token" | "forbidden" | "transient";

const GENERIC_MESSAGES: Record<StsErrorKind, string> = {
  invalid_token: "identity token was rejected",
  forbidden: "role assumption is not permitted",
  transient: "temporary failure while obtaining credentials",
};

/**
 * 型付き STS エラー。`message` は一般化した文言のみ（そのままクライアントへ返しても漏れない）。
 * AWS 由来の本文は `awsMessage` に保持するので、ログ用途に限って使うこと。
 */
export class StsError extends Error {
  readonly kind: StsErrorKind;
  readonly code?: string;
  readonly status: number;
  readonly awsMessage?: string;

  constructor(kind: StsErrorKind, status: number, code?: string, awsMessage?: string) {
    super(GENERIC_MESSAGES[kind]);
    this.name = "StsError";
    this.kind = kind;
    this.status = status;
    if (code !== undefined) this.code = code;
    if (awsMessage !== undefined) this.awsMessage = awsMessage;
  }
}

const INVALID_TOKEN = new Set([
  "InvalidIdentityToken",
  "ExpiredTokenException",
  "IDPRejectedClaim",
]);
const FORBIDDEN = new Set([
  "AccessDenied",
  "MalformedPolicyDocument",
  "PackedPolicyTooLarge",
  "RegionDisabledException",
]);

/** STS のエラーコードを分類する。未知のコードは transient（リトライ可能側に倒す）。 */
export function classifyStsErrorCode(code: string): StsErrorKind {
  if (INVALID_TOKEN.has(code)) return "invalid_token";
  if (FORBIDDEN.has(code)) return "forbidden";
  return "transient";
}

export type AssumedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
  assumedRoleArn: string;
};

export type AssumeRoleOptions = {
  token: string;
  roleArn: string;
  sessionName: string;
  durationSeconds?: number;
  region: string;
  /** 既定は https://sts.<region>.amazonaws.com/。E2E で擬似 STS を指すときに上書きする。 */
  endpoint?: string;
  fetch?: typeof fetch;
};

/**
 * 認証情報に、CloudTrail との突き合わせに使う ID を添えたもの（コンソールログインの発行記録用）。
 * `requestId` は応答ヘッダー x-amzn-RequestId、なければ本文の RequestId。
 */
export type AssumedRoleDetails = {
  credentials: AssumedCredentials;
  assumedRoleId?: string;
  requestId?: string;
};

export async function assumeRoleWithWebIdentity(
  opts: AssumeRoleOptions,
): Promise<AssumedCredentials> {
  return (await assumeRoleWithWebIdentityDetailed(opts)).credentials;
}

/** assumeRoleWithWebIdentity と同じ呼び出しで、AssumedRoleId と RequestId も返す。 */
export async function assumeRoleWithWebIdentityDetailed(
  opts: AssumeRoleOptions,
): Promise<AssumedRoleDetails> {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? `https://sts.${opts.region}.amazonaws.com/`;
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: opts.roleArn,
    RoleSessionName: opts.sessionName,
    WebIdentityToken: opts.token,
    DurationSeconds: String(opts.durationSeconds ?? 900),
  });

  let res: Response;
  let xml: string;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    xml = await res.text();
  } catch {
    throw new StsError("transient", 0);
  }

  if (res.status >= 500) {
    const err = parseStsError(xml);
    throw new StsError("transient", res.status, err?.code, err?.message);
  }
  if (res.ok) {
    const creds = parseAssumeRoleResponse(xml);
    if (!creds) throw new StsError("transient", res.status);
    const assumedRoleId = parseAssumedRoleId(xml);
    const requestId = res.headers.get("x-amzn-RequestId") || parseRequestId(xml);
    return {
      credentials: creds,
      ...(assumedRoleId !== undefined ? { assumedRoleId } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
  const err = parseStsError(xml);
  if (!err) throw new StsError("transient", res.status);
  throw new StsError(classifyStsErrorCode(err.code), res.status, err.code, err.message);
}

export type CredentialCacheKey = { identity: string; roleArn: string };

export type CredentialCache = {
  get(key: CredentialCacheKey): AssumedCredentials | undefined;
  set(key: CredentialCacheKey, creds: AssumedCredentials): void;
  delete(key: CredentialCacheKey): void;
};

const EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * isolate 内の Map による認証情報キャッシュ（ベストエフォート）。
 * isolate の再生成や別 isolate では共有されず、ヒットしなくても正しく動くことを前提とする。
 * 認証情報を KV 等の永続ストアには保存しない。
 * 期限の 5 分前から失効扱い。上限を超えたら挿入の古いものから捨てる。
 */
export function createCredentialCache(
  opts: { now?: () => number; maxEntries?: number } = {},
): CredentialCache {
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? 1000;
  const map = new Map<string, AssumedCredentials>();
  const k = (key: CredentialCacheKey) => JSON.stringify([key.identity, key.roleArn]);
  return {
    get(key) {
      const id = k(key);
      const v = map.get(id);
      if (!v) return undefined;
      if (v.expiration.getTime() - EXPIRY_MARGIN_MS <= now()) {
        map.delete(id);
        return undefined;
      }
      return v;
    },
    set(key, creds) {
      const id = k(key);
      map.delete(id); // 再挿入で順序を更新する
      map.set(id, creds);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(key) {
      map.delete(k(key));
    },
  };
}
