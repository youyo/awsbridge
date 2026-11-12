// コンソールログインの Admin の Worker: 経路（チームのパス以外は処理の最初で 404）・画面（[ADMIN] の印）・発行の 1〜8 段。
// ここでは署名鍵を設定しない（vars ADMIN_CURRENT_KEY なし）ので、9 段目は 503 signing_unavailable で止まり、STS を呼ばない。
// 鍵があるときの署名・Admin の issuer の文書（Admin の issuer のホスト）・iat の上限・key-check は console-admin-worker-key.test.ts。
// 設計: docs/specs/console-login-portal.md §3・§8・§9、X1 の決裁、G-6。
// 偽の Access（手元の鍵）・STS・getSigninToken を相手に、Worker の fetch を直接呼ぶ。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminWorker } from "../../src/console/admin/worker";
import type { WorkerConfig } from "../../src/console/types";
import {
  ADMIN_ENTRY,
  ADMIN_HOST,
  ADMIN_PORTAL,
  ADMIN_TEAM,
  AUDS,
  adminConfig,
  adminEnv,
  CSRF_SECRET,
  createHarness,
  EMAIL,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  PORTAL,
  PORTAL_HOST,
  standardConfig,
  standardKeyEnv,
} from "./console-standard-harness";

let h: Harness;
let logs: string[];

beforeEach(async () => {
  h = await createHarness();
  logs = [];
  const sink = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(sink);
  vi.spyOn(console, "error").mockImplementation(sink);
  vi.spyOn(console, "warn").mockImplementation(sink);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ADMIN_AUD = AUDS.teams[ADMIN_TEAM] as string;
const ADMIN_DEV_AUD = AUDS.teams["dev-elevated"] as string;
const INFRA = AUDS.teams.infra as string;
const TEAM_PATH = `/t/${ADMIN_TEAM}`;

function worker(config: unknown = adminConfig()) {
  return createAdminWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });
}

type PostOpts = Partial<Parameters<typeof loginRequest>[0]> & {
  aud?: string | string[];
  csrfAud?: string;
};

async function post(
  p: PostOpts = {},
  env: Record<string, unknown> = adminEnv(h),
  config?: unknown,
) {
  const jwt = "jwt" in p ? p.jwt : await h.accessJwt({ aud: p.aud ?? ADMIN_AUD, email: EMAIL });
  const csrf = await h.csrf(p.csrfAud ?? ADMIN_AUD);
  const req = loginRequest({
    host: ADMIN_HOST,
    path: `${TEAM_PATH}/login`,
    origin: ADMIN_PORTAL,
    ...p,
    jwt,
    form: p.form ?? { entry: ADMIN_ENTRY, region: "ap-northeast-1", csrf },
  });
  return worker(config).fetch(req, env);
}

async function get(
  path: string,
  opts: { host?: string; jwt?: string; method?: string } = {},
  env: Record<string, unknown> = adminEnv(h),
  config?: unknown,
) {
  const headers = new Headers();
  if (opts.jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", opts.jwt);
  const req = new Request(`https://${opts.host ?? ADMIN_HOST}${path}`, {
    method: opts.method ?? "GET",
    headers,
  });
  return worker(config).fetch(req, env);
}

const noIssue = () => {
  expect(h.seen.sts).toHaveLength(0);
  expect(h.seen.signin).toHaveLength(0);
  expect(h.seen.other).toHaveLength(0);
};

describe("Admin の Worker: 9 段目は 503 signing_unavailable（最初の Red）", () => {
  it("Admin のチームの JWT で 1〜8 段を通ると 503 signing_unavailable で、STS も getSigninToken も呼ばない", async () => {
    const res = await post();
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("signing_unavailable");
    expect(res.headers.get("Location")).toBeNull();
    noIssue();
  });

  it("発行記録は tier admin・result signing_unavailable。JWT・認証情報は出ない", async () => {
    await post();
    const line = logs.find((l) => l.includes('"console_issue"'));
    expect(line).toBeDefined();
    const rec = JSON.parse(line as string);
    expect(rec.tier).toBe("admin");
    expect(rec.result).toBe("signing_unavailable");
    expect(rec.team).toBe(ADMIN_TEAM);
    // cto の決裁 2026-11-13: アカウント ID は全桁（突き合わせのキー）。email は伏せる
    expect(rec.target.accountId).toBe("333333333333");
    const all = logs.join("\n");
    for (const s of [EMAIL, CSRF_SECRET]) expect(all).not.toContain(s);
  });

  it("503 の応答にも no-store と CSP を付け、Set-Cookie を付けない", async () => {
    const res = await post();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("Standard の署名鍵の vars（STANDARD_CURRENT_KEYS・STANDARD_PUBLIC_JWKS）・旧い文字列の鍵の secret を読まない（壊れていても読まない）", async () => {
    expect((await post({}, adminEnv(h))).status).toBe(503);
    const res = await post(
      {},
      adminEnv(h, {
        STANDARD_CURRENT_KEYS: "not json",
        STANDARD_PUBLIC_JWKS: "not json",
        CONSOLE_SIGNING_KEYS: "not json",
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("signing_unavailable");
  });

  it("入口の AUD（Admin の入口）がなくても動く（entryAud.admin は要求しない）", async () => {
    const config = adminConfig();
    delete config.portal.entryAud;
    const res = await post({}, adminEnv(h), config);
    expect(res.status).toBe(503);
    noIssue();
  });
});

describe("Admin の Worker: 発行の前の段は Standard と同じに断る", () => {
  it("Standard のチームの AUD は 403 unknown_audience", async () => {
    const res = await post({ aud: INFRA, csrfAud: INFRA });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unknown_audience");
    noIssue();
  });

  it("入口の AUD（Admin・Standard のどちらも）での POST は 403 unknown_audience", async () => {
    for (const aud of [AUDS.entry.admin, AUDS.entry.standard]) {
      const res = await post({ aud, csrfAud: aud });
      expect(res.status, aud).toBe(403);
      expect(await res.text()).toContain("unknown_audience");
    }
    noIssue();
  });

  it("Origin が Standard のオリジンなら 403 forbidden_origin。Sec-Fetch-Site が same-origin でなくても 403", async () => {
    const res = await post({ origin: PORTAL });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("forbidden_origin");
    expect((await post({ secFetchSite: "cross-site" })).status).toBe(403);
    expect((await post({ origin: null })).status).toBe(403);
    noIssue();
  });

  it("パスのチームと AUD のチームが違えば 403 team_mismatch", async () => {
    const res = await post({ path: "/t/dev-elevated/login" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("team_mismatch");
    noIssue();
  });

  it("Access JWT が無い・壊れていれば 401", async () => {
    expect((await post({ jwt: undefined })).status).toBe(401);
    expect((await post({ jwt: "not-a-jwt" })).status).toBe(401);
    noIssue();
  });

  it("CSRF が無い・他の aud のものは 403 csrf_failed", async () => {
    const other = await post({ csrfAud: ADMIN_DEV_AUD });
    expect(other.status).toBe(403);
    expect(await other.text()).toContain("csrf_failed");
    const none = await post({ form: { entry: ADMIN_ENTRY, region: "ap-northeast-1" } });
    expect(none.status).toBe(403);
    noIssue();
  });

  it("このチームの行でない・Standard の行（readonly）の entry は 404 not_listed", async () => {
    const csrf = await h.csrf(ADMIN_AUD);
    for (const entry of ["333333333333:readonly", "555555555555:admin", "bogus"]) {
      const res = await post({ form: { entry, csrf } });
      expect(res.status, entry).toBe(404);
      expect(await res.text()).toContain("not_listed");
    }
    // dev-elevated のチームの行はこのアカウントにない
    const dev = await post({
      aud: ADMIN_DEV_AUD,
      csrfAud: ADMIN_DEV_AUD,
      path: "/t/dev-elevated/login",
      form: { entry: ADMIN_ENTRY, csrf: await h.csrf(ADMIN_DEV_AUD) },
    });
    expect(dev.status).toBe(404);
    noIssue();
  });

  it("停止スイッチ・回数の制限は署名の前に効く", async () => {
    const stopped = await post({}, adminEnv(h, { LOGIN_DISABLED: "true" }));
    expect(stopped.status).toBe(503);
    expect(await stopped.text()).toContain("login_disabled");
    const limited = await post(
      {},
      adminEnv(h, { LOGIN_RATE_LIMITER: { limit: async () => ({ success: false }) } }),
    );
    expect(limited.status).toBe(429);
    const none = await post({}, adminEnv(h, { LOGIN_RATE_LIMITER: undefined }));
    expect(none.status).toBe(500);
    noIssue();
  });
});

describe("Admin の Worker: チームのパス以外は処理の最初で 404（G-6）", () => {
  const NON_TEAM = [
    "/",
    "/x",
    "/t",
    "/t/",
    "/t/nope/",
    "/t/nope/login",
    "/t/INFRA-ELEVATED/login",
    "/t/infra/login", // Standard のチーム
    "/standard/.well-known/openid-configuration",
    "/admin/.well-known/openid-configuration",
    "/admin/.well-known/jwks.json",
    "/.well-known/openid-configuration",
    "/.well-known/jwks.json",
  ];

  it.each(NON_TEAM)(
    "%s は 404 で、どのメソッドでも Access の検査・発行に進まない",
    async (path) => {
      for (const method of ["GET", "POST"]) {
        const res = await get(path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      noIssue();
    },
  );

  it("issuer のホスト・Standard のポータルのホスト・知らないホストでは、チームのパスでも 404（issuer の文書も出さない）", async () => {
    for (const host of [ISSUER_HOST, PORTAL_HOST, "evil.example.com"]) {
      expect((await get(`${TEAM_PATH}/`, { host })).status, host).toBe(404);
      expect((await post({ host })).status, host).toBe(404);
      for (const doc of ["jwks.json", "openid-configuration"]) {
        expect((await get(`/admin/.well-known/${doc}`, { host })).status).toBe(404);
        expect((await get(`/standard/.well-known/${doc}`, { host })).status).toBe(404);
      }
    }
    noIssue();
  });

  it("処理の最初: env が壊れていても、チームのパス以外は 500 でなく 404", async () => {
    expect((await get("/", {}, {})).status).toBe(404);
    expect((await get("/.well-known/jwks.json", {}, {})).status).toBe(404);
    // チームのパスは env が壊れていれば 500（発行しない側に倒す）
    expect((await get(`${TEAM_PATH}/`, {}, {})).status).toBe(500);
  });

  it("生成物が壊れていれば、どの経路も 500 server_misconfigured（Standard の生成物を渡しても）", async () => {
    for (const config of [standardConfig(), "not json", { ...adminConfig(), purpose: "display" }]) {
      const res = await get(`${TEAM_PATH}/`, {}, adminEnv(h), config);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("server_misconfigured");
    }
    noIssue();
  });

  it("ホスト方式（routing: host）: <team>.<ホスト> のチームのページだけで、Admin のホスト自体の / は 404", async () => {
    const config = adminConfig();
    config.portal.routing = "host";
    const teamOrigin = `https://${ADMIN_TEAM}.${ADMIN_HOST}`;
    const res = await post(
      { host: `${ADMIN_TEAM}.${ADMIN_HOST}`, path: "/login", origin: teamOrigin },
      adminEnv(h),
      config,
    );
    expect(res.status).toBe(503);
    expect((await get("/", {}, adminEnv(h), config)).status).toBe(404);
    expect(
      (await get("/x", { host: `${ADMIN_TEAM}.${ADMIN_HOST}` }, adminEnv(h), config)).status,
    ).toBe(404);
    // ホスト方式ではパス方式の経路を持たない
    expect((await post({}, adminEnv(h), config)).status).toBe(404);
    noIssue();
  });
});

describe("Admin の Worker: Access アプリの無いチームのパスは必ず断る（G-6）", () => {
  // チームは設定にあるが、AUD（Access アプリ）が無い。AUD が無いチームは発行にも画面にも使わない
  const noApp = (): WorkerConfig => {
    const c = adminConfig();
    for (const t of c.teams) if (t.name === ADMIN_TEAM) delete t.aud;
    return c;
  };

  it("JWT が無ければ 401、どの AUD の JWT でも 403（未知か他のチーム）。POST・GET とも発行・描画しない", async () => {
    const config = noApp();
    expect((await get(`${TEAM_PATH}/`, {}, adminEnv(h), config)).status).toBe(401);
    for (const aud of [ADMIN_AUD, ADMIN_DEV_AUD, INFRA, AUDS.entry.admin]) {
      const jwt = await h.accessJwt({ aud });
      // 他のチームの AUD は team_mismatch、それ以外（このチームの AUD を含む）は未知。どれも断る
      const expected = aud === ADMIN_DEV_AUD ? "team_mismatch" : "unknown_audience";
      for (const page of ["/", "/a/333333333333", "/a/333333333333/cli", "/expired", "/login"]) {
        const res = await get(`${TEAM_PATH}${page}`, { jwt }, adminEnv(h), config);
        expect(res.status, `${aud} ${page}`).toBe(403);
        expect(await res.text()).toContain(expected);
      }
      const res = await post({ aud, csrfAud: aud }, adminEnv(h), config);
      expect(res.status, aud).toBe(403);
      expect(await res.text()).toContain(expected);
    }
    noIssue();
  });
});

describe("Admin の Worker: チームのパスの画面は Access JWT を確かめてから描く", () => {
  it("JWT が無ければ 401、Standard のチーム・入口の AUD なら 403、別のチームなら 403 team_mismatch", async () => {
    for (const page of ["/", "/a/333333333333", "/a/333333333333/cli", "/expired", "/login"]) {
      expect((await get(`${TEAM_PATH}${page}`)).status, page).toBe(401);
      for (const aud of [INFRA, AUDS.entry.admin, AUDS.entry.standard]) {
        const jwt = await h.accessJwt({ aud });
        const res = await get(`${TEAM_PATH}${page}`, { jwt });
        expect(res.status, `${aud} ${page}`).toBe(403);
        expect(await res.text()).toContain("unknown_audience");
      }
      const other = await h.accessJwt({ aud: ADMIN_DEV_AUD });
      const res = await get(`${TEAM_PATH}${page}`, { jwt: other });
      expect(res.status, page).toBe(403);
      expect(await res.text()).toContain("team_mismatch");
    }
  });

  it("S2: Admin の行（admin）のフォームを描き、CSRF を付ける。Standard の行は出さない", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const res = await get(`${TEAM_PATH}/a/333333333333`, { jwt });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="${TEAM_PATH}/login"`);
    expect(html).toContain(`value="${ADMIN_ENTRY}"`);
    expect(html).not.toContain("333333333333:readonly");
    expect(html).not.toMatch(/<script|style=/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeDefined();
    // そのまま送ると 9 段目で止まる（STS は呼ばない）
    const done = await worker().fetch(
      loginRequest({
        host: ADMIN_HOST,
        path: `${TEAM_PATH}/login`,
        origin: ADMIN_PORTAL,
        jwt,
        form: { entry: ADMIN_ENTRY, region: "us-east-1", csrf: csrf as string },
      }),
      adminEnv(h),
    );
    expect(done.status).toBe(503);
    noIssue();
  });

  it("S2: このチームの行がないアカウントは 404 not_listed", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const res = await get(`${TEAM_PATH}/a/555555555555`, { jwt });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_listed");
  });

  it("S0（/）は無い。S1（/t/<team>/）・S3・S5 は枠を返す", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    expect((await get("/")).status).toBe(404);
    expect((await get("/", { jwt })).status).toBe(404);
    for (const page of ["/", "/a/333333333333/cli", "/expired", "/login"]) {
      expect((await get(`${TEAM_PATH}${page}`, { jwt })).status, page).toBe(200);
    }
    expect((await get(`${TEAM_PATH}/a/333333333333`, { jwt, method: "POST" })).status).toBe(405);
  });
});

describe("Admin の画面: [ADMIN] の印（ユーザーの確認待ちの既定の案）", () => {
  it("チームの画面（S1・S2・S3・S5・GET /login）とエラー（401 以外のエラー・503 を含む）の見出しとタブのタイトルに [ADMIN] が付く", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const pages = [
      await get(`${TEAM_PATH}/`, { jwt }),
      await get(`${TEAM_PATH}/a/333333333333`, { jwt }),
      await get(`${TEAM_PATH}/a/333333333333/cli`, { jwt }),
      await get(`${TEAM_PATH}/expired`, { jwt }),
      await get(`${TEAM_PATH}/login`, { jwt }),
      await get(`${TEAM_PATH}/a/555555555555`, { jwt }), // 404 not_listed
      await get(`${TEAM_PATH}/`), // 401
      await post(), // 503 signing_unavailable
      await post({ aud: INFRA }), // 403
    ];
    for (const res of pages) {
      const html = await res.text();
      expect(html, `${res.status}`).toMatch(/<title>\[ADMIN\] /);
      expect(html, `${res.status}`).toMatch(/<header><p>\[ADMIN\] /);
    }
  });

  it("Standard の画面には [ADMIN] を付けない（対照）", async () => {
    const { createStandardWorker } = await import("../../src/console/standard/worker");
    const std = createStandardWorker(standardConfig(), { getAccessKey: h.getAccessKey });
    const env = {
      ACCESS_TEAM_DOMAIN: "https://unit-team.cloudflareaccess.com",
      ...standardKeyEnv(h.stdKeys),
      CONSOLE_CSRF_KEY: CSRF_SECRET,
    };
    const jwt = await h.accessJwt({ aud: INFRA });
    const html = await (
      await std.fetch(
        new Request(`https://${PORTAL_HOST}/t/infra/a/333333333333`, {
          headers: { "Cf-Access-Jwt-Assertion": jwt },
        }),
        env,
      )
    ).text();
    expect(html).toContain("333333333333:readonly");
    expect(html).not.toContain("[ADMIN]");
    expect(html).not.toContain("ADMIN");
  });
});
