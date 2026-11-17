// コンソールの Worker が外に出す通信を 1 つの関数に集める（P2（B）の設計メモ §4.2、cto の決裁 2026-11-17 の c3）。
// 宛先は 3 つだけ（Access の certs の GET・STS の地域の endpoint の POST・getSigninToken の POST）。オリジン・パス・メソッドの完全一致で、
// リダイレクトは追わない（3xx は失敗）。Worker 全体の試験は、記録する fetch を渡して、入口・画面・発行（両階層）・key-check の
// 到達先がこの 3 つだけであることを確かめる（getAccessKey を差し替えない。差し替えると certs がこの関数を通らない）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEgress, EgressError } from "../../src/console/issue/egress";
import { createConsoleWorker } from "../../src/console/worker/worker";
import {
  ADMIN_ENTRY,
  ADMIN_TEAM,
  AUDS,
  baseEnv,
  createHarness,
  displayConfig,
  ENTRY,
  type Harness,
  ISSUER_HOST,
  loginRequest,
  PORTAL,
  PORTAL_HOST,
  SIGNIN_TOKEN,
  stsXml,
  TEAM_DOMAIN,
  workerConfig,
} from "./console-worker-harness";

const CERTS = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const STS = "https://sts.us-east-1.amazonaws.com/";
const SIGNIN = "https://signin.aws.amazon.com/federation";

type Call = { url: string; method: string; redirect: RequestInit["redirect"] };

/** 呼ばれた宛先を記録し、応答を返す擬似の fetch。 */
function recorder(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
    return respond(url);
  }) as typeof fetch;
  return { fn, calls };
}

const targets = { accessTeamDomain: TEAM_DOMAIN, stsRegion: "us-east-1" };

describe("createEgress（外への通信を 1 つの関数に集める）", () => {
  it.each([
    ["Access の certs", CERTS, "GET"],
    ["STS の地域の endpoint", STS, "POST"],
    ["getSigninToken", SIGNIN, "POST"],
  ])("%s（%s %s）は通し、リダイレクトを追わない（redirect: manual）", async (_n, url, method) => {
    const r = recorder(() => new Response("{}", { status: 200 }));
    const egress = createEgress(targets, r.fn);
    const res = await egress(url, { method, redirect: "follow" });
    expect(res.status).toBe(200);
    expect(r.calls).toEqual([{ url, method, redirect: "manual" }]);
  });

  it.each([
    ["別のホスト", "https://evil.example.com/", "POST"],
    ["別のリージョンの STS", "https://sts.eu-west-1.amazonaws.com/", "POST"],
    ["グローバルの STS", "https://sts.amazonaws.com/", "POST"],
    ["http の STS", "http://sts.us-east-1.amazonaws.com/", "POST"],
    ["STS の別のパス", "https://sts.us-east-1.amazonaws.com/x", "POST"],
    ["STS にクエリ", "https://sts.us-east-1.amazonaws.com/?Action=x", "POST"],
    ["STS を GET", STS, "GET"],
    ["getSigninToken を GET（認証情報を URL に出す形）", SIGNIN, "GET"],
    ["getSigninToken の別のパス", "https://signin.aws.amazon.com/oauth", "POST"],
    [
      "別のチームドメインの certs",
      "https://other.cloudflareaccess.com/cdn-cgi/access/certs",
      "GET",
    ],
    ["certs の別のパス", `${TEAM_DOMAIN}/cdn-cgi/access/get-identity`, "GET"],
    ["certs を POST", CERTS, "POST"],
    ["ユーザー情報つき", "https://user@sts.us-east-1.amazonaws.com/", "POST"],
  ])("%s は送らずに断る（EgressError）", async (_n, url, method) => {
    const r = recorder(() => new Response("{}"));
    const egress = createEgress(targets, r.fn);
    await expect(egress(url, { method })).rejects.toBeInstanceOf(EgressError);
    expect(r.calls).toEqual([]);
  });

  it("Request オブジェクトで渡しても、URL とメソッドで同じに判定する", async () => {
    const r = recorder(() => new Response("{}"));
    const egress = createEgress(targets, r.fn);
    await expect(
      egress(new Request("https://evil.example.com/", { method: "POST" })),
    ).rejects.toBeInstanceOf(EgressError);
    expect(r.calls).toEqual([]);
  });

  it.each([
    ["Access の certs", CERTS, "GET"],
    ["STS", STS, "POST"],
    ["getSigninToken", SIGNIN, "POST"],
  ])("%s の 3xx は失敗（Location の先に届かない）", async (_n, url, method) => {
    for (const status of [301, 302, 303, 307, 308]) {
      const r = recorder(
        () => new Response(null, { status, headers: { Location: "https://evil.example.com/" } }),
      );
      const egress = createEgress(targets, r.fn);
      await expect(egress(url, { method })).rejects.toBeInstanceOf(EgressError);
      expect(r.calls.map((c) => c.url)).toEqual([url]);
    }
  });

  it("base を渡さなければ、呼ぶ時点の globalThis.fetch を使う（E2E のエントリが後から差し替える）", async () => {
    const egress = createEgress(targets);
    const r = recorder(() => new Response("ok"));
    const saved = globalThis.fetch;
    globalThis.fetch = r.fn;
    try {
      expect((await egress(CERTS, { method: "GET" })).status).toBe(200);
    } finally {
      globalThis.fetch = saved;
    }
    expect(r.calls).toHaveLength(1);
  });
});

describe("Worker 全体: 到達先は 3 つだけ（入口・画面・発行（両階層）・key-check。certs も差し替えずに通す）", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    for (const m of ["log", "error", "warn"] as const)
      vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** 3 つの宛先に答える擬似の fetch（certs は harness の Access の公開鍵）。redirect を付けた応答も作れる。 */
  const world = (redirectAt?: string) =>
    recorder((url) => {
      if (url === redirectAt)
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example.com/" },
        });
      if (url === CERTS)
        return new Response(JSON.stringify(h.accessJwks), {
          headers: { "content-type": "application/json" },
        });
      if (url === STS) return new Response(stsXml("ASIAEGRESSTEST00001"));
      if (url === SIGNIN) return new Response(JSON.stringify({ SigninToken: SIGNIN_TOKEN }));
      return new Response("unexpected", { status: 599 });
    });

  const workerWith = (fetchFn: typeof fetch) =>
    createConsoleWorker(workerConfig(), { fetch: fetchFn }, displayConfig());

  async function walk(fetchFn: typeof fetch) {
    const w = workerWith(fetchFn);
    const env = baseEnv(h);
    const get = async (path: string, aud: string, host = PORTAL_HOST) =>
      w.fetch(
        new Request(`https://${host}${path}`, {
          headers: { "Cf-Access-Jwt-Assertion": await h.accessJwt({ aud }) },
        }),
        env,
      );
    const out: Record<string, number> = {};
    out.entry = (await get("/", AUDS.entry)).status;
    out.s1 = (await get("/t/infra/", AUDS.teams.infra as string)).status;
    out.s2 = (
      await get(`/t/${ADMIN_TEAM}/a/333333333333`, AUDS.teams[ADMIN_TEAM] as string)
    ).status;
    out.keyCheck = (
      await get(`/t/${ADMIN_TEAM}/key-check`, AUDS.teams[ADMIN_TEAM] as string)
    ).status;
    out.issuer = (await get("/console/.well-known/jwks.json", AUDS.entry, ISSUER_HOST)).status;
    for (const [team, entry] of [
      ["infra", ENTRY],
      [ADMIN_TEAM, ADMIN_ENTRY],
    ] as const) {
      const aud = AUDS.teams[team] as string;
      const res = await w.fetch(
        loginRequest({
          jwt: await h.accessJwt({ aud }),
          path: `/t/${team}/login`,
          origin: PORTAL,
          form: { entry, csrf: await h.csrf(aud) },
        }),
        env,
      );
      out[`login:${team}`] = res.status;
    }
    return out;
  }

  it("両階層の発行が 302 になり、そのあいだの外への通信は 3 つの宛先（メソッドも）だけで、どれも redirect: manual", async () => {
    const r = world();
    const status = await walk(r.fn);
    expect(status).toEqual({
      entry: 200,
      s1: 200,
      s2: 200,
      keyCheck: 200,
      issuer: 200,
      "login:infra": 302,
      [`login:${ADMIN_TEAM}`]: 302,
    });
    // 陽性の対照: certs・STS・getSigninToken のどれも実際に呼んだ
    const seen = new Set(r.calls.map((c) => `${c.method} ${c.url}`));
    expect([...seen].sort()).toEqual([`GET ${CERTS}`, `POST ${SIGNIN}`, `POST ${STS}`].sort());
    for (const c of r.calls) expect(c.redirect, c.url).toBe("manual");
  });

  it.each([
    ["Access の certs", CERTS, 401],
    ["STS", STS, 503],
    ["getSigninToken", SIGNIN, 503],
  ])(
    "%s が 3xx を返したら発行は失敗し（302 にならない）、Location の先に届かない",
    async (_n, at, status) => {
      const r = world(at);
      const w = workerWith(r.fn);
      const aud = AUDS.teams.infra as string;
      const res = await w.fetch(
        loginRequest({
          jwt: await h.accessJwt({ aud }),
          form: { entry: ENTRY, csrf: await h.csrf(aud) },
        }),
        baseEnv(h),
      );
      expect(res.status).toBe(status);
      expect(res.headers.get("Location")).toBeNull();
      expect(r.calls.map((c) => c.url)).not.toContain("https://evil.example.com/");
      expect(r.calls.every((c) => [CERTS, STS, SIGNIN].includes(c.url))).toBe(true);
    },
  );

  it("STS_REGION を変えると、STS の宛先もそのリージョンだけになる", async () => {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === CERTS) return new Response(JSON.stringify(h.accessJwks));
      if (url === "https://sts.ap-northeast-1.amazonaws.com/")
        return new Response(stsXml("ASIAEGRESSTEST00002"));
      return new Response(JSON.stringify({ SigninToken: SIGNIN_TOKEN }));
    }) as typeof fetch;
    const aud = AUDS.teams.infra as string;
    const res = await workerWith(fn).fetch(
      loginRequest({
        jwt: await h.accessJwt({ aud }),
        form: { entry: ENTRY, csrf: await h.csrf(aud) },
      }),
      baseEnv(h, { STS_REGION: "ap-northeast-1" }),
    );
    expect(res.status).toBe(302);
    expect(calls).toContain("https://sts.ap-northeast-1.amazonaws.com/");
    expect(calls).not.toContain(STS);
  });
});
