import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  assertCustomHost,
  checkWranglerConfig,
  classifyEdgeResponse,
  firstRejections,
  forgedAccessClaims,
  judge,
  judgeAfterDestroy,
  judgeRouting,
  latestVersionId,
  PLACEHOLDER_HOST,
  parseJsonc,
  renderWranglerConfig,
  signForgedAccessJwt,
  tokenWindow,
  versionUrlHost,
} from "../../scripts/poc/human/portal/bypass-lib";

// 「Access を経由しない入口」を閉じたことの確認（cto の条件 (2)）の純粋関数。

const root = new URL("../../", import.meta.url).pathname;
const PORTAL = "scripts/poc/human/portal";
const HOST = "awsbridge-human-poc-portal.example.com";
const SCRIPT = "awsbridge-human-poc-portal";
const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);

const good = () => ({
  name: SCRIPT,
  main: "worker.ts",
  compatibility_date: "2026-07-21",
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: PLACEHOLDER_HOST, custom_domain: true }],
});

describe("assertCustomHost（ポータルの入口のホスト。自社ドメインの awsbridge-human-poc-portal.<zone>）", () => {
  it("awsbridge-human-poc-portal.<zone> を受け付ける", () => {
    expect(assertCustomHost(HOST)).toBe(HOST);
    expect(assertCustomHost("awsbridge-human-poc-portal.dev.example.co.jp")).toBe(
      "awsbridge-human-poc-portal.dev.example.co.jp",
    );
  });
  it("利用者が承認した awsbridge-console-poc.<zone> も受け付ける（workers.dev・似た名前は不可）", () => {
    expect(assertCustomHost("awsbridge-console-poc.example.com")).toBe(
      "awsbridge-console-poc.example.com",
    );
    for (const bad of [
      "awsbridge-console-poc.example.workers.dev",
      "awsbridge-console.example.com",
      "awsbridge-console-pocx.example.com",
      "awsbridge-console-poc",
    ])
      expect(() => assertCustomHost(bad), bad).toThrow();
    const out = renderWranglerConfig(good(), "awsbridge-console-poc.example.com", "/abs/worker.ts");
    expect(out.routes).toEqual([
      { pattern: "awsbridge-console-poc.example.com", custom_domain: true },
    ]);
    expect(out.name).toBe("awsbridge-human-poc-portal");
  });
  for (const bad of [
    "awsbridge-human-poc-portal.example.workers.dev",
    "awsbridge.example.com",
    "awsbridge-human-poc.example.com",
    "awsbridge-human-poc-portal",
    "https://awsbridge-human-poc-portal.example.com",
    "awsbridge-human-poc-portal.example.com/x",
    "awsbridge-human-poc-portal.example.com:8443",
    "*.example.com",
    "Awsbridge-human-poc-portal.example.com",
  ])
    it(`${bad} は拒否する`, () => {
      expect(() => assertCustomHost(bad)).toThrow();
    });
});

describe("parseJsonc / checkWranglerConfig（wrangler.jsonc の入口の検査）", () => {
  it("リポジトリの wrangler.jsonc: workers.dev と Preview URL は無効、routes は Custom Domain 1 つ（ホストは置き換え用のダミー）", () => {
    const cfg = parseJsonc(readFileSync(join(root, PORTAL, "wrangler.jsonc"), "utf8"));
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    expect(cfg.routes).toEqual([{ pattern: PLACEHOLDER_HOST, custom_domain: true }]);
    expect(checkWranglerConfig(cfg)).toEqual([]);
  });
  it("リポジトリの wrangler.jsonc に実ドメインを書かない（ダミーの .invalid だけ）", () => {
    const text = readFileSync(join(root, PORTAL, "wrangler.jsonc"), "utf8");
    expect(PLACEHOLDER_HOST.endsWith(".invalid")).toBe(true);
    expect(text).not.toMatch(/"vars"|"env"\s*:|"route"\s*:/);
  });
  it("問題の無い形は []", () => {
    expect(checkWranglerConfig(good())).toEqual([]);
  });
  const cases: [string, Record<string, unknown>][] = [
    ["workers_dev が true", { workers_dev: true }],
    ["workers_dev が無い（routes から推定される値に頼らない）", { workers_dev: undefined }],
    ["preview_urls が true", { preview_urls: true }],
    ["preview_urls が無い", { preview_urls: undefined }],
    ["routes が無い", { routes: undefined }],
    ["routes が空", { routes: [] }],
    [
      "routes が 2 つ",
      {
        routes: [
          { pattern: PLACEHOLDER_HOST, custom_domain: true },
          { pattern: "awsbridge-human-poc-portal.example.net", custom_domain: true },
        ],
      },
    ],
    [
      "ゾーンのルート（custom_domain なし）",
      { routes: [{ pattern: `${HOST}/*`, zone_name: "x" }] },
    ],
    ["文字列のルート", { routes: [`${HOST}/*`] }],
    ["パスつきのパターン", { routes: [{ pattern: `${HOST}/t/*`, custom_domain: true }] }],
    ["ワイルドカード", { routes: [{ pattern: "*.example.com", custom_domain: true }] }],
    [
      "Custom Domain の Preview（previews_enabled）",
      { routes: [{ pattern: PLACEHOLDER_HOST, custom_domain: true, previews_enabled: true }] },
    ],
    [
      "Custom Domain の本番を無効（enabled: false）",
      { routes: [{ pattern: PLACEHOLDER_HOST, custom_domain: true, enabled: false }] },
    ],
    ["route（単数形）がある", { route: `${HOST}/*` }],
    ["env がある（環境ごとに上書きされる）", { env: { staging: { workers_dev: true } } }],
    ["Worker 名が違う", { name: "awsbridge" }],
  ];
  for (const [label, patch] of cases)
    it(`${label} は問題として返す`, () => {
      const cfg: Record<string, unknown> = { ...good(), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete cfg[k];
      expect(checkWranglerConfig(cfg).length, label).toBeGreaterThan(0);
    });
  it("ホストを渡すと、パターンがそのホストと一致することも確かめる", () => {
    expect(checkWranglerConfig(good(), HOST).length).toBeGreaterThan(0);
    const rendered = { ...good(), routes: [{ pattern: HOST, custom_domain: true }] };
    expect(checkWranglerConfig(rendered, HOST)).toEqual([]);
  });
  it("JSONC の行コメントを読み飛ばす。オブジェクトでなければ例外", () => {
    expect(parseJsonc('// c\n{\n  // x\n  "a": 1\n}')).toEqual({ a: 1 });
    expect(() => parseJsonc("[1]")).toThrow();
  });
});

describe("renderWranglerConfig（デプロイ用の設定。ダミーのホストを実ホストに、main を絶対パスに）", () => {
  it("パターンを置き換え、main を絶対パスにし、$schema を落とす。ほかは変えない", () => {
    const cfg = { $schema: "../x.json", ...good() };
    const out = renderWranglerConfig(cfg, HOST, "/abs/worker.ts");
    expect(out).toEqual({
      name: SCRIPT,
      main: "/abs/worker.ts",
      compatibility_date: "2026-07-21",
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: HOST, custom_domain: true }],
    });
    expect(checkWranglerConfig(out, HOST)).toEqual([]);
    // 元のオブジェクトは変えない
    expect(cfg.routes[0]?.pattern).toBe(PLACEHOLDER_HOST);
  });
  it("元の設定に問題があるか、ホストが不正なら例外", () => {
    expect(() =>
      renderWranglerConfig({ ...good(), workers_dev: true }, HOST, "/abs/worker.ts"),
    ).toThrow();
    expect(() =>
      renderWranglerConfig(good(), "awsbridge-human-poc-portal.example.workers.dev", "/a"),
    ).toThrow();
  });
});

describe("forgedAccessClaims / signForgedAccessJwt（B3: 手元の鍵で署名した偽の Access JWT）", () => {
  it("iss はチームドメイン、aud はチームのアプリの AUD、期限は短い", () => {
    const c = forgedAccessClaims({ teamDomain: TEAM_DOMAIN, aud: AUD, now: 1000 });
    expect(c).toMatchObject({ iss: TEAM_DOMAIN, aud: [AUD], iat: 1000, exp: 1300, type: "app" });
    expect(typeof c.email).toBe("string");
    expect(typeof c.sub).toBe("string");
  });
  it("チームドメインと AUD の形を確かめる", () => {
    expect(() =>
      forgedAccessClaims({ teamDomain: "https://evil.example.com", aud: AUD, now: 1 }),
    ).toThrow();
    expect(() => forgedAccessClaims({ teamDomain: TEAM_DOMAIN, aud: "x y", now: 1 })).toThrow();
  });
  it("その場で作った鍵で RS256 署名する（kid はチームの鍵と無関係）", async () => {
    const jwt = await signForgedAccessJwt({ teamDomain: TEAM_DOMAIN, aud: AUD });
    const h = decodeProtectedHeader(jwt);
    expect(h.alg).toBe("RS256");
    expect(typeof h.kid).toBe("string");
    expect(decodeJwt(jwt)).toMatchObject({ iss: TEAM_DOMAIN, aud: [AUD] });
  });
});

const hdr = (h: Record<string, string>) => new Headers(h);
const PORTAL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://signin.aws.amazon.com https://*.signin.aws.amazon.com https://console.aws.amazon.com https://*.console.aws.amazon.com; frame-ancestors 'none'; base-uri 'none'";

describe("classifyEdgeResponse（応答が Access・Cloudflare・Worker のどれから来たか）", () => {
  const c = (r: { status: number; headers?: Record<string, string>; body?: string }) =>
    classifyEdgeResponse({
      status: r.status,
      headers: hdr(r.headers ?? {}),
      body: r.body ?? "",
      teamDomain: TEAM_DOMAIN,
      portalHost: HOST,
    });
  it("チームドメインの /cdn-cgi/access/login へのリダイレクトは access_login_redirect", () => {
    expect(
      c({
        status: 302,
        headers: {
          location: `${TEAM_DOMAIN}/cdn-cgi/access/login/${HOST}?kid=${AUD}&redirect_url=%2F`,
        },
      }).kind,
    ).toBe("access_login_redirect");
    expect(
      c({ status: 302, headers: { location: `https://${HOST}/cdn-cgi/access/login?x=1` } }).kind,
    ).toBe("access_login_redirect");
  });
  it("Worker がログインを発行したときの Federation へのリダイレクト（Action=login）は worker_login_redirect（FAIL の側）", () => {
    for (const loc of [
      "https://signin.aws.amazon.com/federation?Action=login&SigninToken=x",
      "https://ap-northeast-1.signin.aws.amazon.com/federation?Action=login&SigninToken=x",
    ])
      expect(c({ status: 302, headers: { location: loc } }).kind, loc).toBe(
        "worker_login_redirect",
      );
    expect(judge("access_login", { kind: "worker_login_redirect", status: 302 })).toBe("FAIL");
  });
  it("ほかのチームドメイン・ほかの場所へのリダイレクトは redirect_other", () => {
    expect(
      c({
        status: 302,
        headers: { location: "https://other-team.cloudflareaccess.com/cdn-cgi/access/login/x" },
      }).kind,
    ).toBe("redirect_other");
    expect(c({ status: 302, headers: { location: "https://example.com/" } }).kind).toBe(
      "redirect_other",
    );
  });
  it("Worker の whoami の JSON（401 の verified:false も）は worker_json。verified と team_match を返す", () => {
    const ok = c({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ verified: true, team_match: true, aud_team: "infra" }),
    });
    expect(ok).toMatchObject({ kind: "worker_json", verified: true, teamMatch: true });
    expect(
      c({
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verified: false, error: "missing" }),
      }),
    ).toMatchObject({ kind: "worker_json", verified: false });
  });
  it("issuer の文書（JWKS・discovery）・Worker の HTML（CSP か本文の印）・PoC のトークンは worker_*", () => {
    expect(
      c({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"keys":[{"kty":"RSA"}]}',
      }).kind,
    ).toBe("worker_document");
    expect(
      c({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"issuer":"https://x/std","jwks_uri":"https://x/std/.well-known/jwks.json"}',
      }).kind,
    ).toBe("worker_document");
    expect(
      c({ status: 403, headers: { "content-security-policy": PORTAL_CSP }, body: "<p>x</p>" }).kind,
    ).toBe("worker_html");
    expect(
      c({ status: 403, body: "<p>awsbridge PoC（人間のログイン）のポータル。本番ではない。</p>" })
        .kind,
    ).toBe("worker_html");
    expect(
      c({
        status: 200,
        headers: { "content-disposition": 'attachment; filename="awsbridge-poc-access-jwt.txt"' },
        body: "eyJ...",
      }).kind,
    ).toBe("worker_token");
  });
  it("Cloudflare のエラー（error code: 1042 など）は cloudflare_error とコード", () => {
    expect(c({ status: 404, body: "error code: 1042" })).toEqual({
      kind: "cloudflare_error",
      status: 404,
      cfCode: "1042",
    });
    expect(c({ status: 403, body: "<html><title>Error 1010</title>...</html>" })).toMatchObject({
      kind: "cloudflare_error",
      cfCode: "1010",
    });
  });
  it("それ以外（Worker の素の 404 と区別できないものなど）は other", () => {
    expect(c({ status: 404, body: "not found" }).kind).toBe("other");
    expect(c({ status: 500, body: "" }).kind).toBe("other");
  });
});

describe("judge（期待と分類から PASS / FAIL / 記録。PASS は積極的な証拠があるときだけ）", () => {
  const k = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ kind, status: 0, ...extra }) as Parameters<typeof judge>[1];
  it("access_login: Access のログインへのリダイレクトだけ PASS、Worker の応答は FAIL、ほかは記録", () => {
    expect(judge("access_login", k("access_login_redirect"))).toBe("PASS");
    for (const w of ["worker_json", "worker_html", "worker_document", "worker_token"])
      expect(judge("access_login", k(w)), w).toBe("FAIL");
    for (const o of ["cloudflare_error", "other", "redirect_other", "network_error"])
      expect(judge("access_login", k(o)), o).toBe("記録");
  });
  it("not_worker: Cloudflare のエラー（1010 以外）は PASS、Worker は FAIL、1010・ほかは記録", () => {
    expect(judge("not_worker", k("cloudflare_error", { cfCode: "1042" }))).toBe("PASS");
    expect(judge("not_worker", k("cloudflare_error", { cfCode: "1010" }))).toBe("記録");
    expect(judge("not_worker", k("worker_document"))).toBe("FAIL");
    expect(judge("not_worker", k("other"))).toBe("記録");
  });
  it("worker_ok: verified かつ team_match の whoami だけ PASS", () => {
    expect(judge("worker_ok", k("worker_json", { verified: true, teamMatch: true }))).toBe("PASS");
    expect(judge("worker_ok", k("worker_json", { verified: true, teamMatch: false }))).toBe("FAIL");
    expect(judge("worker_ok", k("access_login_redirect"))).toBe("FAIL");
  });
  it("record: いつも記録", () => {
    expect(judge("record", k("worker_json", { verified: true, teamMatch: true }))).toBe("記録");
  });
});

describe("judgeRouting（B2: API で読んだ入口が Custom Domain 1 つだけか）", () => {
  const domain = (o: Record<string, unknown> = {}) => ({
    hostname: HOST,
    service: SCRIPT,
    environment: "production",
    zone_id: "z1",
    enabled: true,
    previews_enabled: false,
    ...o,
  });
  const base = () => ({
    host: HOST,
    script: SCRIPT,
    subdomain: { enabled: false, previews_enabled: false },
    domainsByService: [domain()],
    domainsByHost: [domain()],
    routes: [{ id: "r1", pattern: "other.example.com/*", script: "other" }],
  });
  const results = (p: ReturnType<typeof base>) =>
    Object.fromEntries(judgeRouting(p).map((r) => [r.item, r.result]));
  it("期待どおりなら全項目 PASS", () => {
    const r = judgeRouting(base());
    expect(r.length).toBeGreaterThanOrEqual(6);
    expect(
      r.every((x) => x.result === "PASS"),
      JSON.stringify(r),
    ).toBe(true);
    // 表にホスト・ゾーン ID を出さない
    expect(JSON.stringify(r)).not.toContain(HOST);
    expect(JSON.stringify(r)).not.toContain("z1");
  });
  it("workers.dev・Preview URL が有効なら FAIL", () => {
    const p = base();
    p.subdomain = { enabled: true, previews_enabled: true };
    const r = judgeRouting(p).filter((x) => x.result === "FAIL");
    expect(r.length).toBe(2);
  });
  it("Custom Domain が 0・2 つ・別のホスト・Preview つき・本番無効なら FAIL", () => {
    for (const domains of [
      [],
      [domain(), domain({ hostname: "awsbridge-human-poc-portal.example.net" })],
      [domain({ hostname: "awsbridge-human-poc-portal.example.net" })],
      [domain({ previews_enabled: true })],
      [domain({ enabled: false })],
    ]) {
      const r = results({ ...base(), domainsByService: domains });
      expect(Object.values(r), JSON.stringify(domains)).toContain("FAIL");
    }
  });
  it("ホストが別の Worker にも付いていれば FAIL", () => {
    const r = results({ ...base(), domainsByHost: [domain(), domain({ service: "other" })] });
    expect(Object.values(r)).toContain("FAIL");
  });
  it("このスクリプトのゾーンのルートがあれば FAIL", () => {
    const r = results({ ...base(), routes: [{ id: "r2", pattern: `${HOST}/*`, script: SCRIPT }] });
    expect(Object.values(r)).toContain("FAIL");
  });
});

describe("judgeAfterDestroy（片付けのあと: Custom Domain とスクリプトが残っていないか）", () => {
  it("どれも空・スクリプトが 404 なら PASS", () => {
    const r = judgeAfterDestroy({ domainsByService: [], domainsByHost: [], scriptStatus: 404 });
    expect(r.every((x) => x.result === "PASS")).toBe(true);
  });
  it("残っていれば FAIL", () => {
    const r = judgeAfterDestroy({
      domainsByService: [{ hostname: HOST }],
      domainsByHost: [{ hostname: HOST }],
      scriptStatus: 200,
    });
    expect(r.filter((x) => x.result === "FAIL").length).toBe(3);
  });
});

describe("versionUrlHost / latestVersionId（Version URL の形）", () => {
  it("<バージョン ID の先頭 8 文字>-<Worker>.<サブドメイン>.workers.dev", () => {
    expect(versionUrlHost("18f97339-c287-4872-9bdd-e2135c07ec12", SCRIPT, "sub")).toBe(
      `18f97339-${SCRIPT}.sub.workers.dev`,
    );
    expect(() => versionUrlHost("x", SCRIPT, "sub")).toThrow();
    expect(() => versionUrlHost("18f97339-c287", SCRIPT, "a.b")).toThrow();
  });
  it("number が最大のバージョン", () => {
    expect(
      latestVersionId([
        { id: "11111111-a", number: 1 },
        { id: "33333333-c", number: 3 },
        { id: "22222222-b", number: 2 },
      ]),
    ).toBe("33333333-c");
    expect(latestVersionId([])).toBeUndefined();
  });
});

describe("tokenWindow（B4: 持ち込む Access JWT の期限。値は出さない）", () => {
  it("exp・iat・aud を読む", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setAudience([AUD])
      .setIssuedAt(100)
      .setExpirationTime(5000)
      .sign(privateKey);
    expect(tokenWindow(t)).toEqual({ exp: 5000, iat: 100, aud: [AUD] });
  });
  it("JWT でない・exp が無ければ例外", () => {
    expect(() => tokenWindow("not-a-jwt")).toThrow();
    expect(() => tokenWindow("eyJhbGciOiJub25lIn0.e30.")).toThrow();
  });
});

describe("firstRejections（B4: 送り方ごとに、最初に Access のログインへ送られた時刻）", () => {
  it("since 以降で、送り方ごとに最初の拒否（rejected）と最後の分類を返す。判断できない応答は拒否に数えない", () => {
    const s = [
      { at: "2026-01-01T00:00:00Z", transport: "cookie", kind: "worker_json", rejected: false },
      { at: "2026-01-01T00:00:10Z", transport: "cookie", kind: "network_error", rejected: false },
      {
        at: "2026-01-01T00:00:20Z",
        transport: "cookie",
        kind: "access_login_redirect",
        rejected: true,
      },
      { at: "2026-01-01T00:00:00Z", transport: "header", kind: "worker_json", rejected: false },
      { at: "2026-01-01T00:00:30Z", transport: "header", kind: "worker_json", rejected: false },
      { at: "2026-01-01T00:00:00Z", transport: "token", kind: "other", rejected: false },
    ];
    expect(firstRejections(s, new Date("2026-01-01T00:00:05Z"))).toEqual([
      {
        transport: "cookie",
        firstRejectedAt: "2026-01-01T00:00:20Z",
        seconds: 15,
        lastKind: "access_login_redirect",
      },
      {
        transport: "header",
        firstRejectedAt: undefined,
        seconds: undefined,
        lastKind: "worker_json",
      },
      { transport: "token", firstRejectedAt: undefined, seconds: undefined, lastKind: undefined },
    ]);
  });
});
