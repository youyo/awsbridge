// 突き合わせの道具の読み取り: aws CLI（許可リストの 4 種類だけ）と Cloudflare の API（telemetry/query の照会だけ）。
// aws と fetch は差し替える（実際の AWS・Cloudflare に接続しない）。
import { describe, expect, it } from "vitest";
import {
  queryIssueLogs,
  TELEMETRY_PAGE_LIMIT,
  telemetryQueryBody,
} from "../../scripts/console/reconcile-cf";
import {
  type AwsRun,
  guardRun,
  RECONCILE_READ_COMMANDS,
  readAssumeEvents,
  readCallerAccount,
  readEnabledRegions,
} from "../../scripts/console/reconcile-read";

const ACCOUNT = "333333333333";

/** 応答の表で動く偽の aws（呼ばれた引数を記録）。値が Error なら失敗させる。 */
function fakeRun(table: (args: string[]) => unknown) {
  const calls: string[][] = [];
  const run: AwsRun = async (args) => {
    calls.push(args);
    const v = table(args);
    if (v instanceof Error) throw v;
    return v;
  };
  return { run, calls };
}

const event = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventName: "AssumeRoleWithWebIdentity",
    eventTime: "2026-11-12T01:00:00Z",
    awsRegion: "us-east-1",
    recipientAccountId: ACCOUNT,
    requestParameters: { roleArn: `arn:aws:iam::${ACCOUNT}:role/x`, webIdentityTokenId: "j1" },
    ...o,
  });

describe("aws の読み取り（許可リスト RECONCILE_READ_COMMANDS）", () => {
  it("許可リストは照会の 4 種類だけ（IAM の検査の READ_COMMANDS とは別の一覧）", () => {
    expect([...RECONCILE_READ_COMMANDS].sort()).toEqual(
      [
        "account list-regions",
        "cloudtrail lookup-events",
        "ec2 describe-regions",
        "sts get-caller-identity",
      ].sort(),
    );
  });

  it("guardRun は許可リストの外のコマンドを呼ばずに例外にする", async () => {
    const { run, calls } = fakeRun(() => ({}));
    const g = guardRun(run);
    await expect(g(["iam", "list-roles"])).rejects.toThrow(/not allowed/);
    await expect(g(["cloudtrail", "delete-trail"])).rejects.toThrow(/not allowed/);
    expect(calls).toEqual([]);
    await g(["sts", "get-caller-identity", "--region=us-east-1"]);
    expect(calls).toHaveLength(1);
  });

  it("readCallerAccount はプロファイルのアカウント（12 桁）を返す。形が違えば例外", async () => {
    const ok = fakeRun(() => ({ Account: ACCOUNT, Arn: "x" }));
    expect(await readCallerAccount(ok.run)).toBe(ACCOUNT);
    expect(ok.calls[0]?.slice(0, 2)).toEqual(["sts", "get-caller-identity"]);
    expect(ok.calls[0]).toContain("--region=us-east-1");
    await expect(readCallerAccount(fakeRun(() => ({ Account: "1" })).run)).rejects.toThrow();
  });

  it("readEnabledRegions は account list-regions の有効なリージョン（ENABLED・ENABLED_BY_DEFAULT）を返す", async () => {
    const { run, calls } = fakeRun(() => ({
      Regions: [
        { RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" },
        { RegionName: "ap-east-1", RegionOptStatus: "ENABLED" },
      ],
    }));
    expect(await readEnabledRegions(run)).toEqual(["ap-east-1", "us-east-1"]);
    expect(calls[0]?.slice(0, 2)).toEqual(["account", "list-regions"]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["--region-opt-status-contains", "ENABLED", "ENABLED_BY_DEFAULT"]),
    );
  });

  it("account list-regions が使えなければ ec2 describe-regions（有効なリージョンだけ）に落ちる。どちらも駄目なら例外", async () => {
    const { run, calls } = fakeRun((a) =>
      a[0] === "account"
        ? new Error("AccessDenied")
        : {
            Regions: [
              { RegionName: "us-east-1", OptInStatus: "opt-in-not-required" },
              { RegionName: "me-south-1", OptInStatus: "not-opted-in" },
            ],
          },
    );
    expect(await readEnabledRegions(run)).toEqual(["us-east-1"]);
    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "account list-regions",
      "ec2 describe-regions",
    ]);
    await expect(readEnabledRegions(fakeRun(() => new Error("denied")).run)).rejects.toThrow();
    await expect(readEnabledRegions(fakeRun(() => ({ Regions: [] })).run)).rejects.toThrow();
  });

  it("readAssumeEvents はリージョンごとに lookup-events（EventName=AssumeRoleWithWebIdentity・期間・--region）を呼ぶ", async () => {
    const { run, calls } = fakeRun((a) =>
      a.includes("--region=us-east-1")
        ? { Events: [{ CloudTrailEvent: event() }] }
        : { Events: [] },
    );
    const since = Date.UTC(2026, 10, 7);
    const until = Date.UTC(2026, 10, 13);
    const r = await readAssumeEvents(run, ["us-east-1", "eu-west-1"], { since, until });
    expect(r.read).toEqual(["us-east-1", "eu-west-1"]);
    expect(r.unread).toEqual([]);
    expect(r.events.map((e) => e.tokenId)).toEqual(["j1"]);
    for (const c of calls) {
      expect(c.slice(0, 2)).toEqual(["cloudtrail", "lookup-events"]);
      expect(c).toEqual(
        expect.arrayContaining([
          "--lookup-attributes",
          "AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity",
          "--start-time",
          "2026-11-07T00:00:00.000Z",
          "--end-time",
          "2026-11-13T00:00:00.000Z",
        ]),
      );
    }
    expect(calls.map((c) => c.find((x) => x.startsWith("--region=")))).toEqual([
      "--region=us-east-1",
      "--region=eu-west-1",
    ]);
  });

  it("読めなかったリージョン（呼び出しの失敗・応答の形・読めない CloudTrailEvent）は unread に入れ、空の読み取りとして扱わない", async () => {
    const { run } = fakeRun((a) => {
      if (a.includes("--region=eu-west-1")) return new Error("timeout");
      if (a.includes("--region=ap-northeast-1")) return { Nope: [] };
      if (a.includes("--region=sa-east-1")) return { Events: [{ CloudTrailEvent: "{broken" }] };
      return { Events: [] };
    });
    const r = await readAssumeEvents(
      run,
      ["us-east-1", "eu-west-1", "ap-northeast-1", "sa-east-1"],
      { since: 0, until: 1 },
    );
    expect(r.read).toEqual(["us-east-1"]);
    expect(r.unread).toEqual(["eu-west-1", "ap-northeast-1", "sa-east-1"]);
  });
});

describe("Cloudflare の API（POST /accounts/{id}/workers/observability/telemetry/query）", () => {
  const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
  const TOKEN = ["unit", "cf", "token", "y".repeat(20)].join("-");

  it("照会の本文: queryId・events の view・期間（epoch ミリ秒）・Worker の名前の絞り込み・上限 2000", () => {
    const b = telemetryQueryBody({
      from: 1000,
      to: 2000,
      workers: ["awsbridge-console-standard", "awsbridge-console-admin"],
    });
    expect(b).toMatchObject({
      queryId: expect.any(String),
      view: "events",
      timeframe: { from: 1000, to: 2000 },
      limit: TELEMETRY_PAGE_LIMIT,
      parameters: {
        filterCombination: "or",
        filters: [
          {
            key: "$workers.scriptName",
            operation: "eq",
            type: "string",
            value: "awsbridge-console-standard",
          },
          {
            key: "$workers.scriptName",
            operation: "eq",
            type: "string",
            value: "awsbridge-console-admin",
          },
        ],
      },
    });
    expect(TELEMETRY_PAGE_LIMIT).toBe(2000);
    expect(b).not.toHaveProperty("offset");
    expect(telemetryQueryBody({ from: 1, to: 2, workers: ["a"], offset: "e9" })).toMatchObject({
      offset: "e9",
      offsetDirection: "next",
    });
  });

  type Seen = { url: string; method: string; auth: string | null; body: Record<string, unknown> };
  function fakeFetch(pages: unknown[], status = 200) {
    const seen: Seen[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const page = pages[seen.length - 1] ?? { success: true, result: { events: { events: [] } } };
      return new Response(JSON.stringify(page), { status });
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const page = (ids: string[], count?: number) => ({
    success: true,
    result: {
      events: {
        events: ids.map((id) => ({ $metadata: { id }, source: { event: "x" } })),
        ...(count !== undefined ? { count } : {}),
      },
    },
  });

  it("照会の API だけを POST で呼び、トークンは Authorization の Bearer で渡す。最後の $metadata.id で次のページを読む", async () => {
    const full = Array.from({ length: 3 }, (_, i) => `e${i}`);
    const { f, seen } = fakeFetch([page(full, 4), page(["e3"])]);
    const r = await queryIssueLogs(
      { fetch: f },
      {
        base: "http://127.0.0.1:9",
        accountId: CF_ACCOUNT,
        token: TOKEN,
        workers: ["w"],
        from: 1,
        to: 2,
        pageLimit: 3,
      },
    );
    expect(r.events).toHaveLength(4);
    expect(r.count).toBe(4);
    expect(r.pages).toBe(2);
    for (const s of seen) {
      expect(s.method).toBe("POST");
      expect(s.url).toBe(
        `http://127.0.0.1:9/accounts/${CF_ACCOUNT}/workers/observability/telemetry/query`,
      );
      expect(s.auth).toBe(`Bearer ${TOKEN}`);
    }
    expect(seen[1]?.body.offset).toBe("e2");
  });

  it("失敗（HTTP の誤り・success false・形の違い・進まないカーソル）は例外にし、トークンを文に入れない", async () => {
    const opts = {
      base: "http://127.0.0.1:9",
      accountId: CF_ACCOUNT,
      token: TOKEN,
      workers: ["w"],
      from: 1,
      to: 2,
      pageLimit: 2,
    };
    const cases: [unknown[], number][] = [
      [[{ success: false, errors: [{ code: 10000, message: "Authentication error" }] }], 403],
      [[{ success: false, errors: [] }], 200],
      [[{ success: true, result: { events: {} } }], 200],
      [[page(["a", "b"]), page(["b", "b"])], 200],
      [[page(["a", "b"]), page(["a", "b"])], 200],
    ];
    for (const [pages, status] of cases) {
      const { f } = fakeFetch(pages, status);
      const err = await queryIssueLogs({ fetch: f }, opts).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err, JSON.stringify(pages)).toBeInstanceOf(Error);
      expect(err?.message).not.toContain(TOKEN);
    }
  });
});
