// 「Access を経由しない入口」を閉じたことの確認（cto の条件 (2)）の純粋関数。bypass-check.ts と deploy.ts が使う。
//   - wrangler.jsonc の検査: workers.dev・Preview URL を無効にし、入口を自社ドメインの Custom Domain 1 つにする
//   - 実環境の応答の分類と判定: Access のログインへ送られたか / Cloudflare のエラーか / Worker に届いたか
// Worker には入らない（node でだけ使う）。
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { hasPortalHostPrefix, PORTAL_HOST_PREFIXES, PORTAL_PREFIX } from "./lib";

/** リポジトリの wrangler.jsonc に置くダミーのホスト（deploy.ts が AWSBRIDGE_HUMAN_POC_PORTAL_HOST に置き換える）。 */
export const PLACEHOLDER_HOST = `${PORTAL_PREFIX}.example.invalid`;

/** Worker の HTML の本文の印（handler.ts の html()）。 */
const PORTAL_MARKER = "awsbridge PoC（人間のログイン）のポータル";
/** Worker の HTML の CSP の特徴（handler.ts の CSP）。 */
const PORTAL_CSP_MARK = "form-action 'self' https://signin.aws.amazon.com";
/** handler.ts の poc-token の応答のファイル名。 */
export const POC_TOKEN_FILENAME = "awsbridge-poc-access-jwt.txt";

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * ポータルの入口のホスト（自社ドメインの Custom Domain）。awsbridge-human-poc-portal.<zone> か awsbridge-console-poc.<zone> の形だけ受け付ける
 * （名前の接頭辞で PoC 用のリソースに限る既存のガードを保つため）。workers.dev は不可。
 */
export function assertCustomHost(host: string): string {
  if (
    !HOST_RE.test(host) ||
    !hasPortalHostPrefix(host) ||
    host.split(".").length < 3 ||
    host.endsWith(".workers.dev")
  )
    throw new Error(
      `ポータルのホストは <${PORTAL_HOST_PREFIXES.join(" か ")}>.<自社ドメインのゾーン> の形（スキーム・パス・ポートなし。workers.dev は不可）: '${host}'`,
    );
  return host;
}

/** 行コメント（// で始まる行）だけを読み飛ばす JSONC の読み込み。トップレベルはオブジェクト。 */
export function parseJsonc(text: string): Record<string, unknown> {
  const v: unknown = JSON.parse(
    text
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("wrangler の設定はオブジェクト");
  return v as Record<string, unknown>;
}

/**
 * wrangler の設定の入口を検査し、問題の一覧を返す（空なら問題なし）。
 * workers_dev・preview_urls は明示的に false、routes は Custom Domain（パス・ワイルドカードなし）ちょうど 1 つ、
 * Custom Domain の Preview は無効。route（単数形）と env（環境ごとの上書き）は置かない。
 * host を渡すと、パターンがそのホストと一致することも確かめる（渡さなければダミーのホストかどうかは問わない）。
 */
export function checkWranglerConfig(cfg: unknown, host?: string): string[] {
  if (typeof cfg !== "object" || cfg === null) return ["設定がオブジェクトではない"];
  const c = cfg as Record<string, unknown>;
  const p: string[] = [];
  if (c.name !== PORTAL_PREFIX) p.push(`name が ${PORTAL_PREFIX} ではない`);
  if (c.workers_dev !== false) p.push("workers_dev が false ではない（workers.dev の入口が開く）");
  if (c.preview_urls !== false)
    p.push("preview_urls が false ではない（Preview URL の入口が開く）");
  if ("route" in c) p.push("route（単数形）は使わない");
  if ("env" in c) p.push("env（環境ごとの上書き）は置かない");
  const routes = c.routes;
  if (!Array.isArray(routes) || routes.length !== 1) {
    p.push("routes は Custom Domain ちょうど 1 つ");
    return p;
  }
  const r = routes[0] as unknown;
  if (typeof r !== "object" || r === null) {
    p.push("routes の要素がオブジェクトではない（ゾーンのルート）");
    return p;
  }
  const route = r as Record<string, unknown>;
  if (route.custom_domain !== true) p.push("routes の要素が Custom Domain ではない");
  if (typeof route.pattern !== "string" || !HOST_RE.test(route.pattern))
    p.push("Custom Domain のパターンはホスト名だけ（パス・ワイルドカードなし）");
  else if (host !== undefined && route.pattern !== host)
    p.push("Custom Domain のパターンが AWSBRIDGE_HUMAN_POC_PORTAL_HOST と一致しない");
  if (route.previews_enabled === true)
    p.push("Custom Domain の previews_enabled が true（Preview の入口が開く）");
  if (route.enabled === false) p.push("Custom Domain の enabled が false（本番の入口が無い）");
  for (const k of Object.keys(route))
    if (!["pattern", "custom_domain", "previews_enabled", "enabled"].includes(k))
      p.push(`routes の要素に想定外のキー ${k}`);
  return p;
}

/**
 * デプロイ用の設定を作る: ダミーのホストを実ホストに、main を絶対パスにし、$schema を落とす。
 * 元の設定・ホスト・作った設定のどれかに問題があれば例外。
 */
export function renderWranglerConfig(
  cfg: Record<string, unknown>,
  host: string,
  mainPath: string,
): Record<string, unknown> {
  const before = checkWranglerConfig(cfg);
  if (before.length > 0)
    throw new Error(`wrangler.jsonc の入口に問題がある: ${before.join(" / ")}`);
  assertCustomHost(host);
  const { $schema: _omit, ...rest } = cfg;
  const routes = (cfg.routes as Record<string, unknown>[]).map((r) => ({ ...r, pattern: host }));
  const out = { ...rest, main: mainPath, routes };
  const after = checkWranglerConfig(out, host);
  if (after.length > 0) throw new Error(`デプロイ用の設定に問題がある: ${after.join(" / ")}`);
  return out;
}

// ---- B3: 偽の Access JWT ----

/** 偽の Access JWT の claim（iss はチームドメイン、aud はチームのアプリの AUD。email・sub は架空）。 */
export function forgedAccessClaims(p: {
  teamDomain: string;
  aud: string;
  now: number;
}): Record<string, unknown> {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(p.teamDomain))
    throw new Error("チームドメインは https://<team>.cloudflareaccess.com");
  if (!/^[A-Za-z0-9]+$/.test(p.aud)) throw new Error("AUD は英数字");
  return {
    iss: p.teamDomain,
    aud: [p.aud],
    sub: "00000000-0000-0000-0000-000000000000",
    email: "forged@example.invalid",
    type: "app",
    iat: p.now,
    exp: p.now + 300,
  };
}

/** その場で作った RSA 鍵で署名した偽の Access JWT（チームの鍵とは無関係。kid も架空）。 */
export async function signForgedAccessJwt(p: {
  teamDomain: string;
  aud: string;
  now?: number;
}): Promise<string> {
  const claims = forgedAccessClaims({ ...p, now: p.now ?? Math.floor(Date.now() / 1000) });
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = `forged-${String((await exportJWK(publicKey)).n).slice(0, 16)}`;
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid, typ: "JWT" }).sign(privateKey);
}

// ---- 応答の分類と判定 ----

export type EdgeKind =
  | "access_login_redirect"
  | "redirect_other"
  | "worker_login_redirect"
  | "worker_json"
  | "worker_document"
  | "worker_html"
  | "worker_token"
  | "cloudflare_error"
  | "network_error"
  | "other";

export interface Classified {
  kind: EdgeKind;
  status: number;
  /** Cloudflare のエラーコード（error code: 1042 など） */
  cfCode?: string;
  /** worker_json の whoami: Access JWT を検証できたか */
  verified?: boolean;
  /** worker_json の whoami: AUD のチームがパスのチームと一致したか */
  teamMatch?: boolean;
}

export const isWorkerKind = (k: EdgeKind): boolean => k.startsWith("worker_");

/**
 * 応答が Access（ログインへのリダイレクト）・Cloudflare（エラーページ）・Worker のどれから来たかを分類する。
 * Location・本文・Set-Cookie は返さない（ホスト・AUD・トークンを含みうるため）。
 */
export function classifyEdgeResponse(r: {
  status: number;
  headers: Headers;
  body: string;
  teamDomain: string;
  portalHost: string;
}): Classified {
  const { status, headers, body } = r;
  if (status >= 300 && status < 400) {
    let loc: URL | undefined;
    try {
      loc = new URL(headers.get("location") ?? "", `https://${r.portalHost}`);
    } catch {}
    const login =
      loc?.pathname.startsWith("/cdn-cgi/access/login") === true &&
      (loc.origin === r.teamDomain || loc.origin === `https://${r.portalHost}`);
    if (login) return { kind: "access_login_redirect", status };
    // Worker がログインを発行した（STS → getSigninToken → Federation の login へ 302）
    const federation =
      loc !== undefined &&
      loc.protocol === "https:" &&
      (loc.hostname === "signin.aws.amazon.com" ||
        loc.hostname.endsWith(".signin.aws.amazon.com")) &&
      loc.pathname === "/federation";
    return { kind: federation ? "worker_login_redirect" : "redirect_other", status };
  }
  if ((headers.get("content-disposition") ?? "").includes(POC_TOKEN_FILENAME))
    return { kind: "worker_token", status };
  if (
    (headers.get("content-security-policy") ?? "").includes(PORTAL_CSP_MARK) ||
    body.includes(PORTAL_MARKER)
  )
    return { kind: "worker_html", status };
  if ((headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    let v: unknown;
    try {
      v = JSON.parse(body);
    } catch {}
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if ("verified" in o)
        return {
          kind: "worker_json",
          status,
          verified: o.verified === true,
          teamMatch: o.team_match === true,
        };
      if (Array.isArray(o.keys) || ("issuer" in o && "jwks_uri" in o))
        return { kind: "worker_document", status };
      if (o.error === "server_misconfigured") return { kind: "worker_json", status };
    }
  }
  const code = /error code:\s*(\d{3,5})/i.exec(body)?.[1] ?? /\bError (1\d{3})\b/.exec(body)?.[1];
  if (code !== undefined) return { kind: "cloudflare_error", status, cfCode: code };
  return { kind: "other", status };
}

export type Expectation = "access_login" | "not_worker" | "worker_ok" | "record";
export type Verdict = "PASS" | "FAIL" | "記録";

/** 期待と分類から判定する。PASS は積極的な証拠があるときだけ（Worker に届いたら FAIL、判断できなければ記録）。 */
export function judge(expect: Expectation, c: Classified): Verdict {
  switch (expect) {
    case "access_login":
      if (c.kind === "access_login_redirect") return "PASS";
      return isWorkerKind(c.kind) ? "FAIL" : "記録";
    case "not_worker":
      if (isWorkerKind(c.kind)) return "FAIL";
      return c.kind === "cloudflare_error" && c.cfCode !== "1010" ? "PASS" : "記録";
    case "worker_ok":
      return c.kind === "worker_json" && c.verified === true && c.teamMatch === true
        ? "PASS"
        : "FAIL";
    case "record":
      return "記録";
  }
}

export interface RoutingRow {
  item: string;
  expected: string;
  actual: string;
  result: "PASS" | "FAIL";
}

const row = (item: string, expected: string, actual: string, ok: boolean): RoutingRow => ({
  item,
  expected,
  actual,
  result: ok ? "PASS" : "FAIL",
});

type Rec = Record<string, unknown>;

/**
 * B2: API で読んだ入口を判定する。ホスト・ゾーン ID は表に出さない（<host> と書く）。
 * routes は Custom Domain のゾーンの Worker のルート一覧（このスクリプトのものが 0 であること）。
 */
export function judgeRouting(p: {
  host: string;
  script: string;
  subdomain: { enabled: unknown; previews_enabled: unknown };
  domainsByService: Rec[];
  domainsByHost: Rec[];
  routes: Rec[];
}): RoutingRow[] {
  const d = p.domainsByService;
  const only = d.length === 1 ? d[0] : undefined;
  const others = p.domainsByHost.filter((x) => x.service !== p.script);
  const scriptRoutes = p.routes.filter((x) => x.script === p.script);
  return [
    row(
      "workers.dev（スクリプトの subdomain.enabled）",
      "false",
      String(p.subdomain.enabled),
      p.subdomain.enabled === false,
    ),
    row(
      "Preview URL（subdomain.previews_enabled）",
      "false",
      String(p.subdomain.previews_enabled),
      p.subdomain.previews_enabled === false,
    ),
    row("このスクリプトの Custom Domain の数", "1", String(d.length), d.length === 1),
    row(
      "Custom Domain のホスト",
      "<host>",
      only === undefined ? "-" : only.hostname === p.host ? "<host>" : "別のホスト",
      only?.hostname === p.host,
    ),
    row(
      "Custom Domain の本番（enabled）",
      "true",
      String(only?.enabled ?? "-"),
      only !== undefined && only.enabled !== false,
    ),
    row(
      "Custom Domain の Preview（previews_enabled）",
      "false",
      String(only?.previews_enabled ?? "-"),
      only !== undefined && only.previews_enabled !== true,
    ),
    row(
      "<host> に付いたほかの Worker",
      "0",
      String(others.length),
      others.length === 0 && p.domainsByHost.length > 0,
    ),
    row(
      "このスクリプトのゾーンのルート（Custom Domain のゾーン）",
      "0",
      String(scriptRoutes.length),
      scriptRoutes.length === 0,
    ),
  ];
}

/** 片付けのあと: このスクリプトとホストの Custom Domain が無く、スクリプトも無い（subdomain の API が 404）。 */
export function judgeAfterDestroy(p: {
  domainsByService: Rec[];
  domainsByHost: Rec[];
  scriptStatus: number;
}): RoutingRow[] {
  return [
    row(
      "このスクリプトの Custom Domain",
      "0",
      String(p.domainsByService.length),
      p.domainsByService.length === 0,
    ),
    row(
      "<host> の Custom Domain",
      "0",
      String(p.domainsByHost.length),
      p.domainsByHost.length === 0,
    ),
    row(
      "スクリプト（subdomain の API の HTTP）",
      "404",
      String(p.scriptStatus),
      p.scriptStatus === 404,
    ),
  ];
}

// ---- Version URL ----

/** Version URL のホスト（<バージョン ID の先頭 8 文字>-<Worker>.<アカウントのサブドメイン>.workers.dev）。 */
export function versionUrlHost(versionId: string, script: string, subdomain: string): string {
  const prefix = /^([0-9a-f]{8})-/.exec(versionId)?.[1];
  if (!prefix) throw new Error("バージョン ID の形が違う");
  if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error("workers.dev のサブドメインの形が違う");
  return `${prefix}-${script}.${subdomain}.workers.dev`;
}

/** バージョンの一覧から number が最大のものの ID。 */
export function latestVersionId(items: { id?: unknown; number?: unknown }[]): string | undefined {
  let best: { id: string; number: number } | undefined;
  for (const i of items)
    if (typeof i.id === "string" && typeof i.number === "number")
      if (best === undefined || i.number > best.number) best = { id: i.id, number: i.number };
  return best?.id;
}

// ---- B4 ----

/** 持ち込む Access JWT の exp・iat・aud（署名は検証しない。値そのものは返さない）。 */
export function tokenWindow(token: string): { exp: number; iat?: number; aud: string[] } {
  let p: ReturnType<typeof decodeJwt>;
  try {
    p = decodeJwt(token);
  } catch {
    throw new Error("Access JWT の形ではない");
  }
  if (typeof p.exp !== "number") throw new Error("Access JWT に exp が無い");
  const aud = typeof p.aud === "string" ? [p.aud] : Array.isArray(p.aud) ? p.aud : [];
  return { exp: p.exp, ...(typeof p.iat === "number" ? { iat: p.iat } : {}), aud };
}

export interface ProbeSample {
  at: string;
  transport: string;
  kind: EdgeKind | string;
  /** Access がログインへ送った（access_login_redirect）。判断できない応答（5xx・タイムアウトなど）は false */
  rejected: boolean;
}

/** 送り方ごとに、since 以降で最初に Access のログインへ送られた時刻と秒数、最後の分類（送り方は出現順）。 */
export function firstRejections(
  samples: ProbeSample[],
  since: Date,
): {
  transport: string;
  firstRejectedAt: string | undefined;
  seconds: number | undefined;
  lastKind: string | undefined;
}[] {
  const order: string[] = [];
  for (const s of samples) if (!order.includes(s.transport)) order.push(s.transport);
  return order.map((transport) => {
    const after = samples
      .filter((s) => s.transport === transport && new Date(s.at).getTime() >= since.getTime())
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const first = after.find((s) => s.rejected);
    return {
      transport,
      firstRejectedAt: first?.at,
      seconds:
        first === undefined
          ? undefined
          : Math.round((new Date(first.at).getTime() - since.getTime()) / 1000),
      lastKind: after.at(-1)?.kind,
    };
  });
}
