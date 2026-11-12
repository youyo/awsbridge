// PoC N6（Admin の階層の署名鍵を AWS KMS に置く）の純粋関数。Worker（handler.ts）と手元の手順の両方が使う。
// Worker に入るので node:* を import しない。MCP 経路（src/）と既存の PoC（scripts/poc/human/）の振る舞いは変えない。
//
// KMS の Sign の形（出典: https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html）:
// - MessageType RAW は 4096 バイトまで。JWT の署名対象（header.payload）は 1 KB 程度なので RAW で足りる（上限は検査する）
// - RSASSA_PKCS1_V1_5_SHA_256 の Signature は JWS の RS256 の署名そのもの
// - ECDSA_SHA_256 の Signature は DER（SEQUENCE { INTEGER r, INTEGER s }）。JWS の ES256 は r||s（各 32 バイト）
import { calculateJwkThumbprint, type JWK } from "jose";
import { sessionTagClaims, sourceIdentityClaim } from "../human/claims";

export const ADMIN_KMS_DEFAULTS = {
  workerName: "awsbridge-admin-kms-poc",
  stackName: "awsbridge-admin-kms-poc",
  audience: "awsbridge-admin-kms-poc",
  /** JWT の sub と SourceIdentity。個人の値にしない */
  subject: "awsbridge-kms-check",
  accessProfile: "poc-admin",
  awsProfile: "awsbridge",
  region: "ap-northeast-1",
} as const;

export type JwsAlg = "RS256" | "ES256";
export const JWS_ALGS: readonly JwsAlg[] = ["RS256", "ES256"];

export const KMS_RAW_MESSAGE_LIMIT = 4096;

// ---- base64url ----

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64urlJson(v: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(v)));
}

// ---- 署名の組み立て ----

/** ECDSA の DER 署名を JWS の r||s（各 size バイト。P-256 は 32）にする。壊れた DER は例外。 */
export function derToJoseEcdsa(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const byte = () => {
    const v = der[i++];
    if (v === undefined) throw new Error("DER: truncated");
    return v;
  };
  const length = () => {
    const first = byte();
    if (first < 0x80) return first;
    const n = first & 0x7f;
    if (n === 0 || n > 2) throw new Error("DER: unsupported length");
    let len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | byte();
    return len;
  };
  if (byte() !== 0x30) throw new Error("DER: SEQUENCE expected");
  const seqLen = length();
  if (i + seqLen !== der.length) throw new Error("DER: length mismatch");
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (byte() !== 0x02) throw new Error("DER: INTEGER expected");
    const len = length();
    if (len === 0 || i + len > der.length) throw new Error("DER: bad INTEGER length");
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 1 && v[0] === 0) v = v.slice(1);
    if (v.length > size) throw new Error("DER: INTEGER too large");
    out.set(v, part * size + (size - v.length));
  }
  if (i !== der.length) throw new Error("DER: trailing bytes");
  return out;
}

export function kmsSigningAlgorithm(alg: JwsAlg): string {
  return alg === "RS256" ? "RSASSA_PKCS1_V1_5_SHA_256" : "ECDSA_SHA_256";
}

/** JWS の署名対象（base64url(header).base64url(payload)）。header は alg・kid・typ。 */
export function jwsSigningInput(
  header: { alg: JwsAlg; kid: string },
  payload: Record<string, unknown>,
): string {
  return `${base64urlJson({ alg: header.alg, kid: header.kid, typ: "JWT" })}.${base64urlJson(payload)}`;
}

/** KMS の Signature を付けて JWT にする。ES256 は DER を r||s に直す。 */
export function assembleJws(signingInput: string, kmsSignature: Uint8Array, alg: JwsAlg): string {
  const sig = alg === "ES256" ? derToJoseEcdsa(kmsSignature) : kmsSignature;
  return `${signingInput}.${base64url(sig)}`;
}

// ---- 公開鍵（GetPublicKey の SPKI → JWK） ----

/** RFC 7638 thumbprint を kid にする（RSA は kty・n・e、EC は crv・kty・x・y）。 */
export function kidOf(jwk: JWK): Promise<string> {
  if (jwk.kty === "RSA" && jwk.n && jwk.e)
    return calculateJwkThumbprint({ kty: "RSA", n: jwk.n, e: jwk.e });
  if (jwk.kty === "EC" && jwk.crv && jwk.x && jwk.y)
    return calculateJwkThumbprint({ kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y });
  throw new Error("RSA or EC public JWK required");
}

/** KMS の GetPublicKey の PublicKey（DER の SubjectPublicKeyInfo）から公開鍵 JWK（kid・use・alg 付き）を作る。 */
export async function jwkFromSpki(spki: Uint8Array, alg: JwsAlg): Promise<JWK> {
  const params =
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
  const key = await crypto.subtle.importKey("spki", spki, params, true, ["verify"]);
  const exported = (await crypto.subtle.exportKey("jwk", key)) as JWK;
  let pub: JWK;
  if (alg === "RS256") {
    if (exported.kty !== "RSA" || !exported.n || !exported.e) throw new Error("not an RSA key");
    // 2048 bit = 256 バイト = base64url 342 文字
    if (exported.n.length < 342) throw new Error("RSA key must be 2048 bits or more");
    pub = { kty: "RSA", n: exported.n, e: exported.e };
  } else {
    if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y)
      throw new Error("not a P-256 key");
    pub = { kty: "EC", crv: "P-256", x: exported.x, y: exported.y };
  }
  return { ...pub, kid: await kidOf(pub), use: "sig", alg };
}

/** 公開する JWKS。並べた順に出す。空・kid の重複は例外。 */
export function issuerJwks(keys: JWK[]): { keys: JWK[] } {
  if (keys.length === 0) throw new Error("JWKS needs at least one key");
  const kids = keys.map((k) => k.kid);
  if (kids.some((k) => !k) || new Set(kids).size !== kids.length)
    throw new Error("JWKS keys need unique kid");
  return { keys };
}

// ---- claim ----

export interface AdminKmsClaimParams {
  issuer: string;
  audience: string;
  subject: string;
  accessProfile: string;
  /** epoch 秒 */
  now: number;
  jti: string;
  ttlSeconds?: number;
}

/**
 * Worker が固定する claim（呼び出し側から任意の payload を受け取らない）。
 * 既存の PoC の Tagged ロールと同じ形: 入れ子形式のセッションタグ access_profile と、sub と同じ SourceIdentity。
 */
export function adminKmsClaims(p: AdminKmsClaimParams): Record<string, unknown> {
  return {
    iss: p.issuer.replace(/\/+$/, ""),
    aud: p.audience,
    sub: p.subject,
    iat: p.now,
    exp: p.now + (p.ttlSeconds ?? 300),
    jti: p.jti,
    ...sessionTagClaims({ access_profile: p.accessProfile }, "nested"),
    ...sourceIdentityClaim(p.subject),
  };
}

// ---- KMS の要求と応答 ----

export interface KmsRequest {
  headers: Record<string, string>;
  body: string;
}

/** KMS Sign の要求（JSON 1.1）。署名対象は RAW で渡す（4096 バイトを超えたら例外）。 */
export function kmsSignRequest(p: {
  keyId: string;
  message: Uint8Array;
  alg: JwsAlg;
  /** 鍵ポリシーの確認用の上書き（既定は RAW と alg の方式） */
  messageType?: "RAW" | "DIGEST";
  signingAlgorithm?: string;
}): KmsRequest {
  if (p.message.length > KMS_RAW_MESSAGE_LIMIT)
    throw new Error(`KMS RAW message must be ${KMS_RAW_MESSAGE_LIMIT} bytes or less`);
  return {
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "TrentService.Sign",
    },
    body: JSON.stringify({
      KeyId: p.keyId,
      Message: bytesToBase64(p.message),
      MessageType: p.messageType ?? "RAW",
      SigningAlgorithm: p.signingAlgorithm ?? kmsSigningAlgorithm(p.alg),
    }),
  };
}

/** Sign の応答から Signature（base64）を取り出す。無ければ例外。 */
export function parseKmsSignResponse(body: string): Uint8Array {
  const v = JSON.parse(body) as { Signature?: unknown };
  if (typeof v?.Signature !== "string" || v.Signature === "")
    throw new Error("KMS Sign response has no Signature");
  return base64ToBytes(v.Signature);
}

/** KMS のエラー応答（{"__type": "...#Code"}）のコード。読めなければ HTTP<status>。 */
export function kmsErrorCode(status: number, body: string): string {
  try {
    const t = (JSON.parse(body) as { __type?: unknown }).__type;
    if (typeof t === "string" && t !== "") return t.split("#").pop() as string;
  } catch {}
  return `HTTP${status}`;
}

// ---- Worker の設定 ----

export interface KmsKeyConfig {
  keyId: string;
  alg: JwsAlg;
  kid: string;
}

const KMS_KEY_ARN_RE = /^arn:aws[a-z-]*:kms:[a-z]{2}(-[a-z]+)+-\d:\d{12}:key\/[0-9a-f-]{36}$/;

/** Worker の KMS_KEYS（[{label, keyId, alg, kid}]）を label → 鍵にする。不正なら例外。 */
export function parseKeysConfig(raw: string): Record<string, KmsKeyConfig> {
  const v: unknown = JSON.parse(raw);
  if (!Array.isArray(v)) throw new Error("KMS_KEYS must be an array");
  const out: Record<string, KmsKeyConfig> = {};
  for (const item of v as Record<string, unknown>[]) {
    const { label, keyId, alg, kid } = item ?? {};
    if (typeof label !== "string" || !/^[a-z0-9-]{1,32}$/.test(label))
      throw new Error("KMS_KEYS: invalid label");
    if (typeof keyId !== "string" || !KMS_KEY_ARN_RE.test(keyId))
      throw new Error(`KMS_KEYS: ${label}: keyId must be a KMS key ARN`);
    if (alg !== "RS256" && alg !== "ES256") throw new Error(`KMS_KEYS: ${label}: invalid alg`);
    if (typeof kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(kid))
      throw new Error(`KMS_KEYS: ${label}: invalid kid`);
    if (label in out) throw new Error(`KMS_KEYS: duplicate label ${label}`);
    out[label] = { keyId, alg, kid };
  }
  return out;
}

/** RoleSessionName。KMS の RequestId を入れ、CloudTrail で Sign と AssumeRoleWithWebIdentity を突き合わせられるようにする。 */
export function kmsSessionName(kmsRequestId: string | undefined): string {
  if (kmsRequestId === undefined || !/^[A-Za-z0-9-]{8,59}$/.test(kmsRequestId))
    return "kms-unknown";
  return `kms-${kmsRequestId}`;
}

// ---- 計測 ----

export interface TimingStats {
  n: number;
  min?: number;
  median?: number;
  p90?: number;
  max?: number;
  mean?: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 件数・最小・中央値・p90（最近接順位）・最大・平均。 */
export function timingStats(samples: number[]): TimingStats {
  const n = samples.length;
  if (n === 0) return { n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  const p90 = s[Math.min(n - 1, Math.ceil(0.9 * n) - 1)] as number;
  return {
    n,
    min: round1(s[0] as number),
    median: round1(median),
    p90: round1(p90),
    max: round1(s[n - 1] as number),
    mean: round1(s.reduce((a, b) => a + b, 0) / n),
  };
}

// ---- 呼び出し側の確認 ----

/** Authorization: Bearer <token> が expected と一致するか（長さに依らず全バイトを比べる）。 */
export function bearerMatches(header: string | null, expected: string): boolean {
  if (!header || expected === "") return false;
  const m = /^Bearer (.+)$/i.exec(header);
  if (!m) return false;
  const a = new TextEncoder().encode(m[1]);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
