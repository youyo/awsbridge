// Access アプリの読み取り（scripts/console/access-inspect-lib.ts）: Cloudflare API の応答から AccessAppSnapshot を作る。
// fetch は差し替えた関数で、実際の Cloudflare には接続しない。呼ぶのは GET だけで、トークンは例外の文・出力に入れない。
import { describe, expect, it } from "vitest";
import {
  fetchAccessApps,
  InputError,
  parseAccessApps,
  parseAccessSummary,
} from "../../scripts/console/access-inspect-lib";
import { AUDS, accessSummary } from "./console-access-fixtures";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = ["unit", "cf", "token", "y".repeat(32)].join("-");
const BASE = "http://127.0.0.1:1";

describe("parseAccessApps", () => {
  it("aud・type・destinations の uri・path_cookie_attribute を取る", () => {
    const apps = parseAccessApps([
      {
        aud: AUDS.dev,
        type: "self_hosted",
        domain: "ignored.example.com",
        destinations: [{ type: "public", uri: "awsbridge-console.example.com/t/dev" }],
        path_cookie_attribute: true,
        name: "x",
      },
    ]);
    expect(apps).toEqual([
      {
        aud: AUDS.dev,
        type: "self_hosted",
        destinations: ["awsbridge-console.example.com/t/dev"],
        pathCookie: true,
      },
    ]);
  });

  it("destinations が無ければ domain を使う。path_cookie_attribute の欠落・真偽値以外は undefined", () => {
    const apps = parseAccessApps([
      { aud: AUDS.dev, type: "self_hosted", domain: "awsbridge-console.example.com/t/dev" },
      { aud: AUDS.sec, type: "self_hosted", destinations: [], path_cookie_attribute: "true" },
    ]);
    expect(apps[0]).toMatchObject({
      destinations: ["awsbridge-console.example.com/t/dev"],
      pathCookie: undefined,
    });
    expect(apps[1]).toMatchObject({ destinations: [], pathCookie: undefined });
  });

  it("aud が無いもの（bookmark など）は読み飛ばす。一覧でなければ例外", () => {
    expect(parseAccessApps([{ type: "bookmark", name: "b" }, "x", null])).toEqual([]);
    expect(() => parseAccessApps({})).toThrow(/unexpected response/);
  });
});

describe("parseAccessSummary", () => {
  it("access.json（生成物）の形を読む", () => {
    const s = accessSummary();
    const got = parseAccessSummary(JSON.parse(JSON.stringify(s)));
    expect(got).toMatchObject({ routing: s.routing, origins: s.origins, entryAud: s.entryAud });
    expect(got.teams).toEqual(s.teams.map((t) => ({ name: t.name, tier: t.tier, aud: t.aud })));
  });

  it.each([
    ["routing", { routing: "x" }],
    ["origins", { origins: {} }],
    ["entryAud", { entryAud: 1 }],
    ["teams", { teams: "x" }],
  ])("形の誤り（%s）は、位置だけの InputError。値を出さない", (path, patch) => {
    const bad = { ...accessSummary(), ...patch };
    try {
      parseAccessSummary(JSON.parse(JSON.stringify(bad)));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect((e as Error).message).toContain(path);
    }
  });

  it("チームの階層・名前の誤りも InputError", () => {
    const bad = accessSummary();
    (bad.teams[0] as { tier: string }).tier = "x";
    expect(() => parseAccessSummary(JSON.parse(JSON.stringify(bad)))).toThrow(InputError);
  });
});

describe("fetchAccessApps", () => {
  type Call = { url: string; method: string; auth: string | undefined };
  function fakeFetch(pages: unknown[][], status = 200) {
    const calls: Call[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const body =
        status === 200
          ? {
              success: true,
              result: pages[page - 1] ?? [],
              result_info: { page, per_page: 100, total_pages: pages.length },
            }
          : { success: false, errors: [{ code: 10000, message: "Authentication error" }] };
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fn, calls };
  }
  const appJson = (a: string) => ({ aud: a, type: "self_hosted", destinations: [] });

  it("GET だけで、ページを最後まで読む。トークンは Authorization だけに入れる", async () => {
    const { fn, calls } = fakeFetch([[appJson(AUDS.dev)], [appJson(AUDS.sec)]]);
    const apps = await fetchAccessApps({ fetch: fn }, BASE, ACCOUNT, TOKEN);
    expect(apps.map((a) => a.aud)).toEqual([AUDS.dev, AUDS.sec]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    for (const c of calls) {
      expect(c.url).toContain(`${BASE}/accounts/${ACCOUNT}/access/apps?`);
      expect(c.url).not.toContain(TOKEN);
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("API が失敗したら、状態とエラーのコードだけの例外。トークンを入れない", async () => {
    const { fn } = fakeFetch([], 403);
    const err = (await fetchAccessApps({ fetch: fn }, BASE, ACCOUNT, TOKEN).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/403/);
    expect(err.message).toContain("Authentication error");
    expect(err.message).not.toContain(TOKEN);
  });
});
