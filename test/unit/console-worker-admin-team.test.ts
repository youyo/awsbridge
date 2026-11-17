// コンソールログインの Worker（1 つ）の Admin の階層のチーム: 経路（既知の経路以外は env を読む前に 404）・画面（[ADMIN] の印）・
// 発行の 1〜9 段と、階層をまたぐ負の試験（P2（B）の設計メモ §7.3 の X1〜X5・X10・X12・X13・X15・X16）。
// P2 で Admin の Worker（src/console/admin/）を消したので、その試験（console-admin-worker.test.ts）を 1 つの Worker の
// Admin の階層のチーム（同じオリジンの /t/infra-elevated）の形に書き直した。弱めない。
// 鍵があるときの署名の中身・iat の上限（X6）・key-check（X11）・境界の鍵の食い違い（X14）は console-worker-admin-key.test.ts。
// 設計: docs/specs/console-login-portal.md §3・§8・§9、X1 の決裁、G-6、P2（B）の設計メモ §5・§7。
// 偽の Access（手元の鍵）・STS・getSigninToken を相手に、Worker の fetch を直接呼ぶ。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../../src/console/types";
import { createConsoleWorker } from "../../src/console/worker/worker";
import { issueEgressCalls, resetEgressCalls } from "./console-egress-spy";
import {
  ADMIN_ENTRY,
  ADMIN_TEAM,
  ADMIN_TEAM_B,
  AUDS,
  baseEnv,
  CSRF_SECRET,
  createHarness,
  EMAIL,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  PORTAL,
  PORTAL_HOST,
  SUB,
  workerConfig,
} from "./console-worker-harness";

// egress への呼び出しを数える（「STS を呼ばない」を egress の spy で確かめる。console-egress-spy.ts）
vi.mock("../../src/console/issue/egress", async (orig) =>
  (await import("./console-egress-spy")).spyEgressModule(
    await orig<typeof import("../../src/console/issue/egress")>(),
  ),
);

let h: Harness;
let logs: string[];

beforeEach(async () => {
  resetEgressCalls();
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
const ADMIN_B_AUD = AUDS.teams[ADMIN_TEAM_B] as string;
const INFRA = AUDS.teams.infra as string;
const TEAM_PATH = `/t/${ADMIN_TEAM}`;
const ADMIN_ARN = "arn:aws:iam::333333333333:role/awsbridge-console/admin/FederatedAdministrator";

function worker(config: unknown = workerConfig()) {
  return createConsoleWorker(config, { getAccessKey: h.getAccessKey, fetch: h.fetch });
}

type PostOpts = Partial<Parameters<typeof loginRequest>[0]> & {
  aud?: string | string[];
  csrfAud?: string;
};

/** 既定は Admin の階層のチーム（infra-elevated）のパスに、そのチームの AUD で Administrator の行を POST する。 */
async function post(p: PostOpts = {}, env: Record<string, unknown> = baseEnv(h), config?: unknown) {
  const jwt = "jwt" in p ? p.jwt : await h.accessJwt({ aud: p.aud ?? ADMIN_AUD, email: EMAIL });
  const csrf = await h.csrf(p.csrfAud ?? ADMIN_AUD);
  const req = loginRequest({
    host: PORTAL_HOST,
    path: `${TEAM_PATH}/login`,
    origin: PORTAL,
    ...p,
    jwt,
    form: p.form ?? { entry: ADMIN_ENTRY, region: "ap-northeast-1", csrf },
  });
  return worker(config).fetch(req, env);
}

async function get(
  path: string,
  opts: { host?: string; jwt?: string; method?: string } = {},
  env: Record<string, unknown> = baseEnv(h),
  config?: unknown,
) {
  const headers = new Headers();
  if (opts.jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", opts.jwt);
  const req = new Request(`https://${opts.host ?? PORTAL_HOST}${path}`, {
    method: opts.method ?? "GET",
    headers,
  });
  return worker(config).fetch(req, env);
}

const noIssue = () => {
  // egress への呼び出しそのもの（断られた試みも数える）で、STS と getSigninToken を呼ばないことを確かめる
  expect(issueEgressCalls(), "egress への STS・getSigninToken の呼び出し").toEqual({
    sts: 0,
    federation: 0,
  });
  expect(h.seen.sts).toHaveLength(0);
  expect(h.seen.signin).toHaveLength(0);
  expect(h.seen.other).toHaveLength(0);
};

/** 発行の経路のログ（console_login・console_issue）の result を並べる。 */
const results = () =>
  logs
    .filter((l) => l.includes('"console_login"') || l.includes('"console_issue"'))
    .map((l) => JSON.parse(l) as { result: string; tier?: string; reason?: string });

describe("Admin の階層のチーム: 同じ Worker・境界の鍵で発行する（陽性の対照）", () => {
  it("Admin のチームの JWT で 1〜9 段を通ると 302。STS には Admin のパスのロールの ARN を渡す", async () => {
    const res = await post();
    expect(res.status, await res.clone().text()).toBe(302);
    expect(res.headers.get("Location")).toMatch(
      /^https:\/\/signin\.aws\.amazon\.com\/federation\?/,
    );
    expect(h.seen.sts).toHaveLength(1);
    // 陽性の対照: egress の spy が Admin の階層の発行の呼び出しを数えている
    expect(issueEgressCalls()).toEqual({ sts: 1, federation: 1 });
    expect(h.seen.sts[0]?.get("RoleArn")).toBe(ADMIN_ARN);
    // Administrator の MaxSessionDuration はちょうど 3600 なので、Worker が求める長さも 3600
    expect(h.seen.sts[0]?.get("DurationSeconds")).toBe("3600");
  });

  it("発行記録の tier はパスのチームの階層（admin）。JWT・認証情報・email は出ない", async () => {
    await post();
    const line = logs.find((l) => l.includes('"console_issue"'));
    expect(line).toBeDefined();
    const rec = JSON.parse(line as string);
    expect(rec.tier).toBe("admin");
    expect(rec.result).toBe("ok");
    expect(rec.team).toBe(ADMIN_TEAM);
    // cto の決裁 2026-11-13: アカウント ID は全桁（突き合わせのキー）。email は伏せる
    expect(rec.target.accountId).toBe("333333333333");
    const all = logs.join("\n");
    for (const s of [EMAIL, CSRF_SECRET]) expect(all).not.toContain(s);
  });

  it("302 の応答にも no-store と CSP を付け、Set-Cookie を付けない", async () => {
    const res = await post();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("回数の制限のキーはパスのチームの階層（admin:<sub>・standard:<sub>。Viewer の発行が Admin の枠を使い切らない）", async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success: true };
      },
    };
    expect((await post({}, baseEnv(h, { LOGIN_RATE_LIMITER: limiter }))).status).toBe(302);
    const std = await post(
      {
        aud: INFRA,
        csrfAud: INFRA,
        path: "/t/infra/login",
        form: { entry: "333333333333:readonly", csrf: await h.csrf(INFRA) },
      },
      baseEnv(h, { LOGIN_RATE_LIMITER: limiter }),
    );
    expect(std.status).toBe(302);
    expect(keys).toEqual([`admin:${SUB}`, `standard:${SUB}`]);
  });
});

describe("Admin の階層のチーム: 発行の前の段で断る（階層をまたぐ負の試験）", () => {
  it("X2: Standard のチームの AUD で Admin のチームのパスに POST は 403 team_mismatch（STS を呼ばない）", async () => {
    const res = await post({ aud: INFRA, csrfAud: INFRA });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("team_mismatch");
    noIssue();
  });

  it("X5: 入口の AUD で Admin のチームのパスに POST は 403 unknown_audience", async () => {
    const res = await post({ aud: AUDS.entry, csrfAud: AUDS.entry });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unknown_audience");
    noIssue();
  });

  it("X1: Standard のチームの AUD で Standard のチームのパスに Administrator の行を POST は 404 not_listed", async () => {
    const res = await post({
      aud: INFRA,
      csrfAud: INFRA,
      path: "/t/infra/login",
      form: { entry: ADMIN_ENTRY, csrf: await h.csrf(INFRA) },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_listed");
    expect(results().map((r) => r.result)).toEqual(["not_listed"]);
    noIssue();
  });

  it("X3: Standard のチームのページの CSRF を付けて、Admin のチームの AUD で POST は 403 csrf_failed（CSRF は aud に束縛）", async () => {
    const res = await post({ csrfAud: INFRA });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("csrf_failed");
    const other = await post({ csrfAud: ADMIN_B_AUD });
    expect(other.status).toBe(403);
    const none = await post({ form: { entry: ADMIN_ENTRY, region: "ap-northeast-1" } });
    expect(none.status).toBe(403);
    noIssue();
  });

  it("X4: Admin のチームの AUD で Viewer の行・このチームの行でないものは 404 not_listed", async () => {
    const csrf = await h.csrf(ADMIN_AUD);
    for (const entry of ["333333333333:readonly", "555555555555:admin", "bogus"]) {
      const res = await post({ form: { entry, csrf } });
      expect(res.status, entry).toBe(404);
      expect(await res.text()).toContain("not_listed");
    }
    noIssue();
  });

  it("X13: 同じ階層の別のチーム（dev-elevated）の AUD で infra-elevated のパスは 403 team_mismatch、自分のパスで infra-elevated だけの行は 404 not_listed", async () => {
    const mismatch = await post({ aud: ADMIN_B_AUD, csrfAud: ADMIN_B_AUD });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.text()).toContain("team_mismatch");
    const own = await post({
      aud: ADMIN_B_AUD,
      csrfAud: ADMIN_B_AUD,
      path: `/t/${ADMIN_TEAM_B}/login`,
      form: { entry: ADMIN_ENTRY, csrf: await h.csrf(ADMIN_B_AUD) },
    });
    expect(own.status).toBe(404);
    expect(await own.text()).toContain("not_listed");
    noIssue();
  });

  it("X16: Admin の確認画面（S2）の CSRF は、同じチームの別の行の POST に使える（仕様。CSRF は aud と sub に束縛し、行には束縛しない）", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const html = await (await get(`${TEAM_PATH}/a/333333333333`, { jwt })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
    expect(csrf).toBeDefined();
    const res = await worker().fetch(
      loginRequest({
        host: PORTAL_HOST,
        path: `${TEAM_PATH}/login`,
        origin: PORTAL,
        jwt,
        form: { entry: "444444444444:admin", csrf },
      }),
      baseEnv(h),
    );
    expect(res.status).toBe(302);
    expect(h.seen.sts[0]?.get("RoleArn")).toBe(
      "arn:aws:iam::444444444444:role/awsbridge-console/admin/FederatedAdministrator",
    );
  });

  it("Origin がポータルのオリジンでなければ 403 forbidden_origin。Sec-Fetch-Site が same-origin でなくても 403", async () => {
    const res = await post({ origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("forbidden_origin");
    expect((await post({ secFetchSite: "cross-site" })).status).toBe(403);
    expect((await post({ origin: null })).status).toBe(403);
    noIssue();
  });

  it("Access JWT が無い・壊れていれば 401", async () => {
    expect((await post({ jwt: undefined })).status).toBe(401);
    expect((await post({ jwt: "not-a-jwt" })).status).toBe(401);
    noIssue();
  });

  it("停止スイッチ（全体）・回数の制限は署名の前に効く", async () => {
    const stopped = await post({}, baseEnv(h, { LOGIN_DISABLED: "true" }));
    expect(stopped.status).toBe(503);
    expect(await stopped.text()).toContain("login_disabled");
    const limited = await post(
      {},
      baseEnv(h, { LOGIN_RATE_LIMITER: { limit: async () => ({ success: false }) } }),
    );
    expect(limited.status).toBe(429);
    const none = await post({}, baseEnv(h, { LOGIN_RATE_LIMITER: undefined }));
    expect(none.status).toBe(500);
    noIssue();
  });
});

describe("X10: Admin の階層だけの停止スイッチ ADMIN_LOGIN_DISABLED（止める側に倒す）", () => {
  it("真なら Admin のチームの POST は 503 login_disabled（STS を呼ばない）。Standard のチームは 302（対照）", async () => {
    const res = await post({}, baseEnv(h, { ADMIN_LOGIN_DISABLED: "true" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("login_disabled");
    noIssue();
    // Standard のチームの POST は止めない（INFRA の JWT は harness の既定）
    const req = loginRequest({
      jwt: await h.accessJwt(),
      path: "/t/infra/login",
      form: { entry: "333333333333:readonly", csrf: await h.csrf(INFRA) },
    });
    expect((await worker().fetch(req, baseEnv(h, { ADMIN_LOGIN_DISABLED: "true" }))).status).toBe(
      302,
    );
  });

  it("値が false・0・空・未設定なら止めない。それ以外の値は止める側に倒す", async () => {
    for (const v of ["false", "0", "", undefined]) {
      expect((await post({}, baseEnv(h, { ADMIN_LOGIN_DISABLED: v }))).status, String(v)).toBe(302);
    }
    for (const v of ["1", "yes", "TRUE", "on"]) {
      expect((await post({}, baseEnv(h, { ADMIN_LOGIN_DISABLED: v }))).status, v).toBe(503);
    }
  });

  it("S2: Admin のチームの画面だけに停止中の案内を出す", async () => {
    const env = baseEnv(h, { ADMIN_LOGIN_DISABLED: "true" });
    const admin = await get(
      `${TEAM_PATH}/a/333333333333`,
      { jwt: await h.accessJwt({ aud: ADMIN_AUD }) },
      env,
    );
    expect(await admin.text()).toContain("一時停止");
    const std = await get("/t/infra/a/333333333333", { jwt: await h.accessJwt() }, env);
    expect(await std.text()).not.toContain("一時停止");
  });
});

describe("X12: 既知の経路以外は env を読む前に 404（Worker 全体。G-6 の形を変えたもの）", () => {
  const UNKNOWN_ON_PORTAL = [
    "/x",
    "/t",
    "/t/",
    "/t/nope/",
    "/t/nope/login",
    "/t/INFRA-ELEVATED/login",
    `/t/${ADMIN_TEAM}x/`,
    `/t/${ADMIN_TEAM}x/login`,
    `${TEAM_PATH}/x`,
    `${TEAM_PATH}/assets/evil.js`,
    "/assets/evil.js",
    "/console/.well-known/openid-configuration",
    "/admin/.well-known/openid-configuration",
    "/.well-known/jwks.json",
  ];

  /** どのプロパティを読んでも例外を投げる env（読んだら分かる）。 */
  const exploding = () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error("env was read");
        },
        has() {
          throw new Error("env was read");
        },
      },
    ) as Record<string, unknown>;

  it.each(UNKNOWN_ON_PORTAL)(
    "ポータルのホストの %s は 404 で、env を読まない（読むと例外になる env でも 404）",
    async (path) => {
      for (const method of ["GET", "POST"]) {
        const res = await get(path, { method }, exploding());
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      noIssue();
    },
  );

  it("issuer のホストのチームのパス・知らないパス、知らないホストは、env を読まずに 404", async () => {
    for (const [host, path] of [
      [ISSUER_HOST, `${TEAM_PATH}/login`],
      [ISSUER_HOST, "/"],
      [ISSUER_HOST, "/console/.well-known/x"],
      [ISSUER_HOST, "/admin/.well-known/jwks.json"],
      ["evil.example.com", `${TEAM_PATH}/`],
      ["evil.example.com", "/console/.well-known/jwks.json"],
    ] as const) {
      expect((await get(path, { host }, exploding())).status, `${host}${path}`).toBe(404);
    }
    noIssue();
  });

  it("既知の経路（チームのパス・入口・issuer の文書）は env を読む。壊れた env なら 500（発行しない側に倒す）", async () => {
    for (const [host, path] of [
      [PORTAL_HOST, `${TEAM_PATH}/`],
      [PORTAL_HOST, "/t/infra/"],
      [PORTAL_HOST, "/"],
      [ISSUER_HOST, "/console/.well-known/jwks.json"],
    ] as const) {
      expect((await get(path, { host }, {})).status, `${host}${path}`).toBe(500);
      expect((await get(path, { host }, exploding())).status, `${host}${path}`).toBe(500);
    }
    noIssue();
  });

  it("生成物が壊れていれば、どの経路も 500 server_misconfigured（P2 より前の生成物を渡しても）", async () => {
    const old = { ...workerConfig(), schemaVersion: 1, tier: "admin" };
    for (const config of [old, "not json", { ...workerConfig(), purpose: "display" }]) {
      const res = await get(`${TEAM_PATH}/`, {}, baseEnv(h), config);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("server_misconfigured");
    }
    noIssue();
  });
});

describe("X15: ホスト方式（routing: host）。Host → チーム → AUD の対応は 1 つだけ", () => {
  const hostConfig = (): WorkerConfig => {
    const c = workerConfig();
    c.portal.routing = "host";
    return c;
  };
  const teamHost = `${ADMIN_TEAM}.${PORTAL_HOST}`;

  it("<Admin のチーム>.<ホスト> の /login で発行する（陽性の対照）", async () => {
    const res = await post(
      { host: teamHost, path: "/login", origin: `https://${teamHost}` },
      baseEnv(h),
      hostConfig(),
    );
    expect(res.status).toBe(302);
  });

  it("チーム A のホストにチーム B の AUD は 403 team_mismatch。Standard のチームの AUD も 403 team_mismatch", async () => {
    for (const aud of [ADMIN_B_AUD, INFRA]) {
      const res = await post(
        { host: teamHost, path: "/login", origin: `https://${teamHost}`, aud, csrfAud: aud },
        baseEnv(h),
        hostConfig(),
      );
      expect(res.status, aud).toBe(403);
      expect(await res.text()).toContain("team_mismatch");
    }
    noIssue();
  });

  it("設定に無いホスト（別名）・チームに似た名前のホストは 404。ホスト方式ではパス方式の経路を持たない", async () => {
    for (const host of [`x${teamHost}`, `nope.${PORTAL_HOST}`, `${ADMIN_TEAM}.evil.example.com`]) {
      const res = await post(
        { host, path: "/login", origin: `https://${host}` },
        baseEnv(h),
        hostConfig(),
      );
      expect(res.status, host).toBe(404);
    }
    expect((await post({}, baseEnv(h), hostConfig())).status).toBe(404);
    noIssue();
  });

  it("ポータルのホスト自体には入口がある（同じ Worker。入口の AUD でだけ開く）", async () => {
    expect((await get("/", {}, baseEnv(h), hostConfig())).status).toBe(401);
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    expect((await get("/", { jwt }, baseEnv(h), hostConfig())).status).toBe(403);
  });
});

describe("Access アプリの無いチームのパスは必ず断る（両階層。G-6）", () => {
  // チームは設定にあるが、AUD（Access アプリ）が無い。AUD が無いチームは発行にも画面にも使わない
  const noApp = (team: string): WorkerConfig => {
    const c = workerConfig();
    for (const t of c.teams) if (t.name === team) delete t.aud;
    return c;
  };

  it.each([
    [ADMIN_TEAM, ADMIN_ENTRY],
    ["infra", "333333333333:readonly"],
  ])(
    "%s: JWT が無ければ 401、どの AUD の JWT でも 403（未知か他のチーム）。POST・GET とも発行・描画しない",
    async (team, entry) => {
      const config = noApp(team);
      const base = `/t/${team}`;
      expect((await get(`${base}/`, {}, baseEnv(h), config)).status).toBe(401);
      // このチームの AUD は表から消えたので未知（unknown_audience）、他のチームの AUD は team_mismatch。どれも断る
      for (const aud of [AUDS.teams[team] as string, ADMIN_B_AUD, INFRA, AUDS.entry]) {
        const jwt = await h.accessJwt({ aud });
        for (const page of ["/", "/a/333333333333", "/a/333333333333/cli", "/expired", "/login"]) {
          const res = await get(`${base}${page}`, { jwt }, baseEnv(h), config);
          expect(res.status, `${team} ${aud} ${page}`).toBe(403);
        }
        const res = await post(
          { aud, csrfAud: aud, path: `${base}/login`, form: { entry, csrf: await h.csrf(aud) } },
          baseEnv(h),
          config,
        );
        expect(res.status, `${team} ${aud}`).toBe(403);
      }
      noIssue();
    },
  );
});

describe("Admin の階層のチームの画面は Access JWT を確かめてから描く", () => {
  it("JWT が無ければ 401、Standard のチームなら 403 team_mismatch、入口の AUD なら 403 unknown_audience、別の Admin のチームなら 403 team_mismatch", async () => {
    for (const page of ["/", "/a/333333333333", "/a/333333333333/cli", "/expired", "/login"]) {
      expect((await get(`${TEAM_PATH}${page}`)).status, page).toBe(401);
      for (const [aud, code] of [
        [INFRA, "team_mismatch"],
        [AUDS.entry, "unknown_audience"],
        [ADMIN_B_AUD, "team_mismatch"],
      ] as const) {
        const res = await get(`${TEAM_PATH}${page}`, { jwt: await h.accessJwt({ aud }) });
        expect(res.status, `${aud} ${page}`).toBe(403);
        expect(await res.text()).toContain(code);
      }
    }
  });

  it("S2: Admin の行（admin）のフォームを描き、CSRF を付ける。Viewer の行は出さない。送ると発行できる", async () => {
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
    const done = await worker().fetch(
      loginRequest({
        host: PORTAL_HOST,
        path: `${TEAM_PATH}/login`,
        origin: PORTAL,
        jwt,
        form: { entry: ADMIN_ENTRY, region: "us-east-1", csrf: csrf as string },
      }),
      baseEnv(h),
    );
    expect(done.status).toBe(302);
  });

  it("S2: このチームの行がないアカウントは 404 not_listed", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const res = await get(`${TEAM_PATH}/a/555555555555`, { jwt });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_listed");
  });

  it("S1（/t/<team>/）・S3・S5 は枠を返す。入口（/）は同じ Worker にあり、チームの AUD では開かない", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    expect((await get("/")).status).toBe(401);
    expect((await get("/", { jwt })).status).toBe(403);
    for (const page of ["/", "/a/333333333333/cli", "/expired", "/login"]) {
      expect((await get(`${TEAM_PATH}${page}`, { jwt })).status, page).toBe(200);
    }
    expect((await get(`${TEAM_PATH}/a/333333333333`, { jwt, method: "POST" })).status).toBe(405);
  });

  it("S1 の入口へのリンクは同じオリジンの /（Admin のオリジンは無い）", async () => {
    const html = await (
      await get(`${TEAM_PATH}/`, { jwt: await h.accessJwt({ aud: ADMIN_AUD }) })
    ).text();
    expect(html).toContain('href="/"');
    expect(html).not.toContain("admin-portal");
  });
});

describe("Admin の画面: [ADMIN] の印（④ で見た目を決め直す。今の形を保つ）", () => {
  it("Admin のチームの画面（S1・S2・S3・S5・GET /login）とエラー（401 以外・503 を含む）の見出しとタブのタイトルに [ADMIN] が付く", async () => {
    const jwt = await h.accessJwt({ aud: ADMIN_AUD });
    const pages = [
      await get(`${TEAM_PATH}/`, { jwt }),
      await get(`${TEAM_PATH}/a/333333333333`, { jwt }),
      await get(`${TEAM_PATH}/a/333333333333/cli`, { jwt }),
      await get(`${TEAM_PATH}/expired`, { jwt }),
      await get(`${TEAM_PATH}/login`, { jwt }),
      await get(`${TEAM_PATH}/a/555555555555`, { jwt }), // 404 not_listed
      await get(`${TEAM_PATH}/`), // 401
      await post({}, baseEnv(h, { ADMIN_LOGIN_DISABLED: "true" })), // 503
      await post({ aud: INFRA }), // 403
    ];
    for (const res of pages) {
      const html = await res.text();
      expect(html, `${res.status}`).toMatch(/<title>\[ADMIN\] /);
      expect(html, `${res.status}`).toMatch(/<header><p>\[ADMIN\] /);
    }
  });

  it("Standard のチームの画面には [ADMIN] を付けない（対照。同じ Worker）", async () => {
    const html = await (await get("/t/infra/a/333333333333", { jwt: await h.accessJwt() })).text();
    expect(html).toContain("333333333333:readonly");
    expect(html).not.toContain("[ADMIN]");
    expect(html).not.toContain(ADMIN_ENTRY);
  });
});
