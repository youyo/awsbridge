// G2 の試験用の issuer（poc:g2:probe:*）の純粋関数。I/O は scripts/poc/g2/probe.ts。
// 手順書 §2.6・§2.6.1、cto の決裁 Q2（adr の G2 (ii) の手順書）。隔離の条件をここで守る:
//   aud            awsbridge-g2-probe（awsbridge-console と MCP の awsbridge は断る）
//   ホスト          awsbridge-g2-probe-<label>.<zone> だけ（接頭辞で決める）。本物の issuer・ポータルのホストの一覧に当たれば断る
//   ロール          パスが /awsbridge-g2-probe/ のロールだけ（/awsbridge-console/ の下は断る）
// 守る場所は、引数の解釈ではなく、署名（signProbeToken）・文書（probeDocuments）・デプロイの設定（probeWranglerConfig）・
// STS の呼び出し（assumeProbe）の関数の中。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { importJWK, type JWK, SignJWT } from "jose";
import { issuerDiscovery } from "../../../src/console/signing/issuer-doc";
import { thumbprintOf } from "../../../src/keys";
import { parseAssumeRoleResponse, parseStsError } from "../../../src/sts-xml";
import { assumeRoleWithWebIdentityParams, summarizeBody } from "../human/claims";
import { maskSensitive } from "../human/ops";
import { g2Settings } from "./common";

export const PROBE_DEFAULTS = {
  audience: "awsbridge-g2-probe",
  hostPrefix: "awsbridge-g2-probe-",
  workerPrefix: "awsbridge-g2-probe-",
  rolePath: "/awsbridge-g2-probe/",
  issuerPath: "/p",
  subject: "g2-probe",
  region: "ap-northeast-1",
  ttlSeconds: 300,
} as const;

/** 試験用の issuer に使ってはいけない aud（コンソールと MCP）。 */
const FORBIDDEN_AUDIENCES = ["awsbridge-console", "awsbridge"];
/** コンソールのロールのパス。この下のロールは引き受けない。 */
const CONSOLE_ROLE_PATH = "/awsbridge-console/";

const LABEL_RE = /^[a-z0-9]{1,16}$/;
const ZONE_RE =
  /^(?=.{1,200}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const KEY_NAME_RE = /^[A-Za-z0-9_-]{1,16}$/;

export function assertProbeLabel(label: string): string {
  if (!LABEL_RE.test(label) || label.includes("console"))
    throw new Error(`issuer の名前は英小文字と数字の 1〜16 文字（console を含めない）: '${label}'`);
  return label;
}

export function assertKeyName(name: string): string {
  if (!KEY_NAME_RE.test(name)) throw new Error(`鍵の名前は英数字・_・- の 1〜16 文字: '${name}'`);
  return name;
}

/** https://awsbridge-g2-probe-<label>.<zone>/p */
export function probeIssuer(label: string, zone: string): string {
  assertProbeLabel(label);
  if (!ZONE_RE.test(zone)) throw new Error(`ゾーンの形が違う: '${zone}'`);
  return `https://${PROBE_DEFAULTS.hostPrefix}${label}.${zone}${PROBE_DEFAULTS.issuerPath}`;
}

/** aud の隔離の条件。awsbridge-console と MCP の awsbridge は断る。 */
export function assertProbeAudience(aud: string): string {
  const norm = aud.trim().toLowerCase();
  if (FORBIDDEN_AUDIENCES.includes(norm))
    throw new Error(`この aud は試験用の issuer に使えない（コンソール・MCP の aud）: '${aud}'`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(aud)) throw new Error(`aud の形が違う: '${aud}'`);
  return aud;
}

/**
 * issuer の隔離の条件。https・ポートなし・パス 1 段（末尾のスラッシュ・クエリなし）、ホストの最初のラベルが
 * awsbridge-g2-probe- で始まること、本物の issuer・ポータルのホストの一覧に無いこと。
 */
export function assertProbeIssuer(
  issuer: string,
  realHosts: ReadonlySet<string>,
  /** 渡すと、ホストが awsbridge-g2-probe-<label>.<zone> の形（ゾーンの内の 1 段）であることも見る */
  zone?: string,
): { issuer: string; host: string; path: string } {
  const m = /^https:\/\/([a-z0-9.-]+)(\/[a-z0-9-]+)$/.exec(issuer);
  const host = m?.[1];
  const path = m?.[2];
  if (!host || !path)
    throw new Error(
      `試験用の issuer は https://<host>/<path> の形（ポート・クエリなし）: '${issuer}'`,
    );
  // 末尾のドット（FQDN の書き方）・空のラベル・- で始まる／終わるラベルは断る（同じホストの別の書き方で一覧をすり抜けないように）
  if (!host.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)))
    throw new Error(
      `試験用の issuer のホストの形が違う（末尾のドット・空のラベルなど）: '${host}'`,
    );
  if (
    zone !== undefined &&
    !new RegExp(
      `^${PROBE_DEFAULTS.hostPrefix}[a-z0-9]{1,16}\\.${zone.replace(/\./g, "\\.")}$`,
    ).test(host)
  )
    throw new Error(
      `試験用の issuer のホストがゾーン ${zone} の内の ${PROBE_DEFAULTS.hostPrefix}<label> でない: '${host}'`,
    );
  if (!host.startsWith(PROBE_DEFAULTS.hostPrefix))
    throw new Error(`試験用の issuer のホストは ${PROBE_DEFAULTS.hostPrefix}* だけ: '${host}'`);
  if (realHosts.has(host))
    throw new Error(`本物の issuer・ポータルのホストと同じなので使えない: '${host}'`);
  return { issuer, host, path };
}

/** 引き受けるロールの隔離の条件。パスが /awsbridge-g2-probe/ のロールだけ（/awsbridge-console/ の下は断る）。 */
export function assertProbeRoleArn(arn: string): string {
  const m = /^arn:aws[a-z-]*:iam::\d{12}:role(\/(?:[\w+=,.@-]+\/)*)([\w+=,.@-]{1,64})$/.exec(arn);
  const path = m?.[1];
  if (path === undefined) throw new Error(`ロールの ARN の形が違う: '${maskSensitive(arn)}'`);
  if (path.startsWith(CONSOLE_ROLE_PATH))
    throw new Error(`コンソールのロール（パス ${CONSOLE_ROLE_PATH}）は引き受けない`);
  if (path !== PROBE_DEFAULTS.rolePath)
    throw new Error(
      `試験用のロールはパス ${PROBE_DEFAULTS.rolePath} のものだけ（今のパス ${path}）`,
    );
  return arn;
}

const hostOf = (u: unknown): string | undefined => {
  if (typeof u !== "string" || u === "") return undefined;
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * 本物のホストの一覧: MCP の issuer（AWSBRIDGE_ISSUER）、コンソールの設定のポータル（standardOrigin・adminOrigin）と
 * 境界の issuer、AWSBRIDGE_G2_PROBE_REAL_HOSTS（カンマ区切り）。設定が読めなければその分は飛ばす（接頭辞の検査で守る）。
 */
export function realHostsFrom(
  env: Record<string, string | undefined>,
  consoleConfigText: string | undefined,
): Set<string> {
  const out = new Set<string>();
  const add = (h: string | undefined) => {
    if (h) out.add(h);
  };
  add(hostOf(env.AWSBRIDGE_ISSUER));
  for (const h of (env.AWSBRIDGE_G2_PROBE_REAL_HOSTS ?? "").split(","))
    if (h.trim() !== "") out.add(h.trim().toLowerCase());
  if (consoleConfigText !== undefined) {
    try {
      const c = JSON.parse(consoleConfigText) as {
        portal?: { standardOrigin?: unknown; adminOrigin?: unknown };
        boundaries?: { issuers?: Record<string, unknown> }[];
      };
      add(hostOf(c.portal?.standardOrigin));
      add(hostOf(c.portal?.adminOrigin));
      for (const b of Array.isArray(c.boundaries) ? c.boundaries : [])
        for (const v of Object.values(b?.issuers ?? {})) add(hostOf(v));
    } catch {
      // 読めない設定は飛ばす
    }
  }
  return out;
}

export interface ProbeSettings {
  label: string;
  /** 開発用のゾーン（AWSBRIDGE_G2_PROBE_ZONE） */
  zone: string;
  issuer: string;
  host: string;
  workerName: string;
  audience: string;
  subject: string;
  region: string;
  /** <g2 dir>/probe/<label> */
  dir: string;
  documentsFile: string;
  deployConfigFile: string;
}

/** 試験用の issuer ごとの設定。ゾーンは AWSBRIDGE_G2_PROBE_ZONE（例 dev.example.com）。 */
export function probeSettings(
  env: Record<string, string | undefined>,
  label: string,
): ProbeSettings {
  const zone = env.AWSBRIDGE_G2_PROBE_ZONE;
  if (!zone)
    throw new Error("AWSBRIDGE_G2_PROBE_ZONE（開発用のゾーン。例 dev.example.com）が未設定");
  const issuer = probeIssuer(label, zone);
  const dir = join(g2Settings(env).dir, "probe", label);
  return {
    label,
    zone,
    issuer,
    host: new URL(issuer).hostname,
    workerName: `${PROBE_DEFAULTS.workerPrefix}${label}`,
    audience: assertProbeAudience(env.AWSBRIDGE_G2_PROBE_AUDIENCE || PROBE_DEFAULTS.audience),
    subject: env.AWSBRIDGE_G2_PROBE_SUBJECT || PROBE_DEFAULTS.subject,
    region: env.AWS_REGION || PROBE_DEFAULTS.region,
    dir,
    documentsFile: join(dir, "issuer-documents.json"),
    deployConfigFile: join(dir, "wrangler.deploy.json"),
  };
}

/** 鍵のファイル（秘密鍵 JWK）。<dir>/key-<name>.json */
export const keyFileOf = (dir: string, name: string): string =>
  join(dir, `key-${assertKeyName(name)}.json`);

/** "A,B" を鍵の名前の一覧にする（順を保つ）。知らない名前・重複・空は例外。 */
export function parseKeyNames(raw: string, available: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of raw.split(",").map((s) => s.trim())) {
    if (item === "") continue;
    if (!available.includes(item))
      throw new Error(`知らない鍵: ${item}（あるもの: ${available.join(", ") || "なし"}）`);
    if (out.includes(item)) throw new Error(`鍵の名前が重複している: ${item}`);
    out.push(item);
  }
  if (out.length === 0) throw new Error("鍵を 1 つ以上指定する");
  return out;
}

/** kid の先頭 8 文字（出力に出すのはこれだけ）。 */
export const kid8 = (kid: string): string => kid.slice(0, 8);

export interface ProbeDocs {
  discovery: ReturnType<typeof issuerDiscovery>;
  jwks: { keys: JWK[] };
}

/** discovery（本物の issuer と同じ形）と、渡した公開鍵だけの JWKS。秘密成分のある鍵・空は断る。 */
export function probeDocuments(
  issuer: string,
  publicJwks: readonly JWK[],
  realHosts: ReadonlySet<string>,
  zone?: string,
): ProbeDocs {
  assertProbeIssuer(issuer, realHosts, zone);
  if (publicJwks.length === 0) throw new Error("JWKS に載せる鍵がない");
  for (const k of publicJwks)
    if (["d", "p", "q", "dp", "dq", "qi"].some((f) => f in k))
      throw new Error("JWKS に秘密の成分を載せようとした");
  return { discovery: issuerDiscovery(issuer), jwks: { keys: publicJwks.map((k) => ({ ...k })) } };
}

/** 指定の鍵（kid = thumbprint）で JWT に署名する。aud・issuer の隔離の条件を署名の前に見る。 */
export async function signProbeToken(p: {
  privateJwk: JWK;
  issuer: string;
  audience: string;
  subject: string;
  realHosts: ReadonlySet<string>;
  /** 渡すとホストがこのゾーンの内かも見る */
  zone?: string | undefined;
  /** epoch 秒 */
  now?: number;
}): Promise<{ token: string; kid: string; jti: string }> {
  assertProbeAudience(p.audience);
  assertProbeIssuer(p.issuer, p.realHosts, p.zone);
  const kid = await thumbprintOf(p.privateJwk);
  const key = await importJWK({ ...p.privateJwk, alg: "RS256" }, "RS256");
  const iat = p.now ?? Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const token = await new SignJWT({
    iss: p.issuer,
    aud: p.audience,
    sub: p.subject,
    iat,
    exp: iat + PROBE_DEFAULTS.ttlSeconds,
    jti,
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .sign(key);
  return { token, kid, jti };
}

/** wrangler.jsonc（テンプレート）をデプロイ用の設定にする。Worker 名・ホストは試験用のものだけ、workers.dev と Preview URL は無効。 */
export function probeWranglerConfig(
  template: Record<string, unknown>,
  p: { templateDir: string; workerName: string; host: string; documentsFile: string },
): Record<string, unknown> {
  if (!new RegExp(`^${PROBE_DEFAULTS.workerPrefix}[a-z0-9]{1,16}$`).test(p.workerName))
    throw new Error(`Worker 名は ${PROBE_DEFAULTS.workerPrefix}<label> だけ: '${p.workerName}'`);
  if (!p.host.startsWith(PROBE_DEFAULTS.hostPrefix))
    throw new Error(`ホストは ${PROBE_DEFAULTS.hostPrefix}* だけ: '${p.host}'`);
  if (template.workers_dev !== false || template.preview_urls !== false)
    throw new Error("テンプレートの workers_dev と preview_urls は false にする");
  const { $schema: _schema, alias: _alias, name: _name, ...rest } = template;
  return {
    ...rest,
    name: p.workerName,
    main: join(p.templateDir, String(template.main)),
    routes: [{ pattern: p.host, custom_domain: true }],
    alias: { "awsbridge-g2-probe-documents": p.documentsFile },
  };
}

const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/;

/** STS の宛先。AWSBRIDGE_G2_PROBE_STS_ENDPOINT は試験用で http://127.0.0.1:<port> だけ。 */
export function stsEndpointFrom(env: Record<string, string | undefined>, region: string): string {
  const v = env.AWSBRIDGE_G2_PROBE_STS_ENDPOINT;
  if (v !== undefined && v !== "") {
    if (!LOOPBACK_RE.test(v))
      throw new Error("AWSBRIDGE_G2_PROBE_STS_ENDPOINT は試験用で、http://127.0.0.1:<port> だけ");
    return v.endsWith("/") ? v : `${v}/`;
  }
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`invalid region: ${region}`);
  return `https://sts.${region}.amazonaws.com/`;
}

const UNPARSEABLE_DETAIL = "STS の応答を解析できない（本文は出さない）";

export type ProbeOutcome =
  | { ok: true; status: number }
  | { ok: false; code: string; status: number; detail: string };

/** 伏せ字の要約: トークンを伏せ、email・アカウント ID を伏せる。 */
function maskDetail(text: string, token: string): string {
  return maskSensitive(summarizeBody(text, [token], 200)).replace(
    /(?<!\d)\d{12}(?!\d)/g,
    "<account>",
  );
}

/**
 * AssumeRoleWithWebIdentity を呼ぶ（署名なしの POST。トークンは本文だけに載せる）。
 * 認証情報は返さない（成功かどうかとエラーコードだけ）。ロールの隔離の条件を呼ぶ前に見る。
 */
export async function assumeProbe(p: {
  endpoint: string;
  roleArn: string;
  token: string;
  sessionName: string;
  fetch: typeof fetch;
}): Promise<ProbeOutcome> {
  assertProbeRoleArn(p.roleArn);
  let status = 0;
  let xml = "";
  try {
    const res = await p.fetch(p.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: assumeRoleWithWebIdentityParams({
        roleArn: p.roleArn,
        roleSessionName: p.sessionName,
        webIdentityToken: p.token,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    xml = await res.text();
  } catch (e) {
    return {
      ok: false,
      code: (e as Error).name === "TimeoutError" ? "Timeout" : "NetworkError",
      status,
      detail: maskDetail((e as Error).message, p.token),
    };
  }
  if (status === 200 && parseAssumeRoleResponse(xml)) return { ok: true, status };
  const err = status === 200 ? undefined : parseStsError(xml);
  // 解析できない応答（200 で認証情報が読めないものを含む）は、本文を転記しない
  if (err === undefined)
    return { ok: false, code: `http_${status}`, status, detail: UNPARSEABLE_DETAIL };
  return { ok: false, code: err.code, status, detail: maskDetail(err.message, p.token) };
}

/**
 * 延長の止め方（--until-refused）に数える結果。成功は false、STS が 4xx で断ったものは true。
 * 通信の失敗・時間切れ・5xx は undefined（数えない。手元の回線や STS の一時の失敗で「断られ続けた」と誤って止めないため）。
 */
export function refusalOf(o: ProbeOutcome): boolean | undefined {
  if (o.ok) return false;
  return o.status >= 400 && o.status < 500 ? true : undefined;
}

/** check が出す応答ヘッダーの 1 行。Set-Cookie（エッジが付けるもの）は値を出さない。 */
export function headerLine(name: string, value: string): string {
  return `${name}: ${name.toLowerCase() === "set-cookie" ? "(省略)" : value}`;
}
