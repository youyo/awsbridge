// 突き合わせの道具の読み取り: aws CLI（許可リストの 4 種類だけ）と Cloudflare の API（telemetry/query の照会だけ）。
// aws と fetch は差し替える（実際の AWS・Cloudflare に接続しない）。
import { describe, expect, it } from "vitest";
import {
  formatIncompleteRead,
  type IncompleteRead,
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
      workers: ["awsbridge-console", "awsbridge-console-admin"],
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
            value: "awsbridge-console",
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
  const parse = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;
  /** calculations の count の応答（実物の形: calculations[0].aggregates[0]、statistics.abr_level）。 */
  const countPage = (count: number, o: { abr?: number; sampleInterval?: number } = {}) => ({
    success: true,
    result: {
      calculations: [
        {
          alias: "n",
          calculation: "count",
          aggregates: [
            {
              value: count,
              count,
              interval: o.sampleInterval ?? (count === 0 ? 0 : 1),
              sampleInterval: o.sampleInterval ?? (count === 0 ? 0 : 1),
            },
          ],
          series: [],
        },
      ],
      statistics: { abr_level: o.abr ?? 1 },
    },
  });
  /** 順に返す偽の fetch（events の view は pages を順に、calculations の view は count を返す）。 */
  function fakeFetch(pages: unknown[], status = 200, count = 4) {
    const seen: Seen[] = [];
    let ev = 0;
    const f = (async (url: string, init: RequestInit) => {
      const body = parse(init);
      seen.push({
        url,
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("authorization"),
        body,
      });
      if (status !== 200) return new Response(JSON.stringify(pages[0]), { status });
      const page =
        body.view === "calculations"
          ? countPage(count)
          : (pages[ev++] ?? { success: true, result: { events: { events: [] } } });
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

  it("照会の API だけを POST で呼び、トークンは Authorization の Bearer で渡す。最小の幅の窓で件数が上限を超えれば、最後の $metadata.id で次のページを読む", async () => {
    const full = Array.from({ length: 3 }, (_, i) => `e${i}`);
    const { f, seen } = fakeFetch([page(full, 3), page(["e3"], 1)]);
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
    expect(r.incomplete).toEqual([]);
    for (const s of seen) {
      expect(s.method).toBe("POST");
      expect(s.url).toBe(
        `http://127.0.0.1:9/accounts/${CF_ACCOUNT}/workers/observability/telemetry/query`,
      );
      expect(s.auth).toBe(`Bearer ${TOKEN}`);
    }
    const evReqs = seen.filter((s) => s.body.view === "events");
    expect(evReqs[1]?.body.offset).toBe("e2");
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
    // 件数の経路（calculations）の応答の形が違えば例外
    const bad = (async () =>
      new Response(JSON.stringify({ success: true, result: { calculations: "x" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(queryIssueLogs({ fetch: bad }, opts)).rejects.toThrow();
  });

  // ---- 件数で確かめながら窓を割って読む（読み落としの直し。cto の受け入れ条件 a） ----
  type Row = { id: string; ts: number };
  /**
   * 実物の振る舞いをまねた偽の telemetry/query。
   * - timeframe は両端を含まない（from < ts < to。実物の応答で確かめた）
   * - events の view: 新しい順。幅が sampleAboveMs を超えると間引く（10 行に 1 行、statistics.abr_level 10）。
   *   events.count はそのページの行数（実物と同じ。全件ではない）。offset は最後の $metadata.id の次から
   * - calculations の view: 窓の行数（countBias を足せる）。幅が countSampledAboveMs を超えると abr_level 10
   */
  function store(
    rows: Row[],
    o: {
      sampleAboveMs?: number;
      countSampledAboveMs?: number;
      sampleInterval?: number;
      dropAlways?: boolean;
      countBias?: number;
      /** 件数の照会の結果を窓ごとに差し替える（境目の前提が崩れた場合など）。 */
      countFor?: (from: number, to: number, n: number) => number;
      /**
       * offset の解釈（API の仕様では id が重複したときの扱いが不明）。既定 "first" は最初に一致した行の次から、
       * "skipAll" は同じ id の行をまとめて飛ばす（境目をまたいだ同じ id の行を取りこぼす）。
       */
      offsetMode?: "first" | "skipAll";
    } = {},
  ) {
    const seen: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const body = parse(init);
      seen.push(body);
      const tf = body.timeframe as { from: number; to: number };
      const width = tf.to - tf.from;
      const inside = rows.filter((r) => r.ts > tf.from && r.ts < tf.to).sort((a, b) => b.ts - a.ts);
      if (body.view === "calculations") {
        const abr = o.countSampledAboveMs !== undefined && width > o.countSampledAboveMs ? 10 : 1;
        return new Response(
          JSON.stringify(
            countPage(
              (o.countFor ?? ((_a, _b, n) => n))(tf.from, tf.to, inside.length) +
                (o.countBias ?? 0),
              {
                abr,
                ...(o.sampleInterval !== undefined ? { sampleInterval: o.sampleInterval } : {}),
              },
            ),
          ),
        );
      }
      const sampled = o.sampleAboveMs !== undefined && width > o.sampleAboveMs;
      let list = sampled ? inside.filter((_, i) => i % 10 === 9) : inside;
      if (o.dropAlways) list = list.slice(1);
      if (typeof body.offset === "string") {
        const at =
          o.offsetMode === "skipAll"
            ? list.length - 1 - [...list].reverse().findIndex((r) => r.id === body.offset)
            : list.findIndex((r) => r.id === body.offset);
        list = list.slice(at + 1);
      }
      const limit = body.limit as number;
      const events = list.slice(0, limit).map((r) => ({
        $metadata: { id: r.id },
        timestamp: r.ts,
        source: { event: "x" },
      }));
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            events: { events, count: events.length },
            statistics: { abr_level: sampled ? 10 : 1 },
          },
        }),
      );
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const H = 3_600_000;
  const idsOf = (events: unknown[]) =>
    events.map((e) => (e as { $metadata: { id: string } }).$metadata.id).sort();
  const opts6d = (from: number, to: number) => ({
    base: "http://127.0.0.1:9",
    accountId: CF_ACCOUNT,
    token: TOKEN,
    workers: ["awsbridge-console", "awsbridge-console-admin"],
    from,
    to,
  });

  it("広い窓は読み取りで間引かれる（abr_level 10・limit より少ない行で終わる）。件数（calculations の count）より少なければ窓を半分に割り、全行を 1 回ずつ読む", async () => {
    const T0 = Date.UTC(2026, 10, 10);
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      ts: T0 + 1000 + i * 1_700_000,
    }));
    const { f, seen } = store(rows, { sampleAboveMs: 2 * H });
    const r = await queryIssueLogs({ fetch: f }, opts6d(T0, T0 + 6 * 24 * H));
    expect(r.incomplete).toEqual([]);
    expect(r.events).toHaveLength(300);
    expect(idsOf(r.events)).toEqual(rows.map((x) => x.id).sort());
    expect(r.count).toBe(300);
    expect(r.windows).toBeGreaterThan(1);
    // 件数の照会は events と同じ絞り込み（Worker の名前）で count を求める
    const calc = seen.find((b) => b.view === "calculations");
    expect(calc).toMatchObject({
      timeframe: { from: T0, to: T0 + 6 * 24 * H },
      parameters: {
        filterCombination: "or",
        filters: [
          { key: "$workers.scriptName", operation: "eq", value: "awsbridge-console" },
          { key: "$workers.scriptName", operation: "eq", value: "awsbridge-console-admin" },
        ],
        calculations: [{ operator: "count" }],
      },
    });
  });

  it("割った境目ちょうどの行も 1 回だけ読む（timeframe の両端は含まれないので (from, mid+1) と (mid, to) に割る）", async () => {
    // 1 ミリ秒おきに行を置き、どの境目にも行があるようにする
    const rows = Array.from({ length: 999 }, (_, i) => ({ id: `b${i}`, ts: i + 1 }));
    const { f } = store(rows, { sampleAboveMs: 40 });
    const r = await queryIssueLogs({ fetch: f }, { ...opts6d(0, 1000), minWindowMs: 1 });
    expect(r.incomplete).toEqual([]);
    expect(r.events).toHaveLength(999);
    expect(new Set(idsOf(r.events)).size).toBe(999);
  });

  it("同じ $metadata.id の行が 2 つあっても両方読む（実物でも id は一意でない。重複を消さずに行数で比べる）", async () => {
    const rows = [
      { id: "same", ts: 10 },
      { id: "same", ts: 10 },
      { id: "other", ts: 20 },
    ];
    const { f } = store(rows);
    const r = await queryIssueLogs({ fetch: f }, opts6d(0, 100));
    expect(r.events).toHaveLength(3);
    expect(r.count).toBe(3);
    expect(r.incomplete).toEqual([]);
  });

  it("最小の幅まで割っても件数に足りなければ、例外にせず incomplete に窓・件数・読んだ数を入れる（終了コード 1 の材料）", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, ts: 1000 + i * 10 }));
    const { f } = store(rows, { dropAlways: true });
    const r = await queryIssueLogs({ fetch: f }, { ...opts6d(0, 2000), minWindowMs: 500 });
    expect(r.incomplete.length).toBeGreaterThan(0);
    const total = r.incomplete.reduce((n, x) => n + (x.expected - x.read), 0);
    expect(total).toBeGreaterThan(0);
    for (const x of r.incomplete) {
      expect(x.read).toBeLessThan(x.expected);
      expect(x.to - x.from).toBeLessThanOrEqual(500 + 1);
    }
    expect(formatIncompleteRead(r.incomplete[0] as IncompleteRead)).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*Z\.\.\d{4}-.*Z read \d+ of \d+/,
    );
  });

  it("件数そのものが間引かれていれば（calculations の abr_level > 1）信用せずに割る。割れば合う", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, ts: 100 + i * 20 }));
    const { f } = store(rows, { countSampledAboveMs: 300, countBias: 0 });
    const r = await queryIssueLogs({ fetch: f }, { ...opts6d(0, 1000), minWindowMs: 10 });
    expect(r.incomplete).toEqual([]);
    expect(r.events).toHaveLength(40);
  });

  it("取り込みの時点で間引かれた記録（sampleInterval > 1）は、割っても取り戻せないので incomplete", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, ts: 100 + i }));
    const { f } = store(rows, { sampleInterval: 2 });
    const r = await queryIssueLogs({ fetch: f }, { ...opts6d(0, 1000), minWindowMs: 10 });
    expect(r.incomplete.length).toBeGreaterThan(0);
    expect(r.incomplete[0]?.reason).toContain("sampled");
  });

  it("件数が上限（limit）を超える窓は、ページ送りより先に割る（カーソルの id が一意でないので頼らない）", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, ts: 10 + i * 10 }));
    const { f, seen } = store(rows);
    const r = await queryIssueLogs(
      { fetch: f },
      { ...opts6d(0, 1000), pageLimit: 20, minWindowMs: 1 },
    );
    expect(r.incomplete).toEqual([]);
    expect(r.events).toHaveLength(50);
    expect(seen.some((b) => typeof b.offset === "string")).toBe(false);
  });

  it("行数が件数より多い窓（件数を数えたあとに取り込まれた行。今に近い窓）は読み落としではないので受け入れる", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, ts: 100 + i * 10 }));
    const { f } = store(rows, { countBias: -1 });
    const r = await queryIssueLogs({ fetch: f }, opts6d(0, 1000));
    expect(r.incomplete).toEqual([]);
    expect(r.events).toHaveLength(5);
    expect(r.count).toBe(4);
  });

  it("割った両側の件数の和が親の件数より少なければ（数え直しても）、境目の前提が崩れたとして incomplete（split lost rows）", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, ts: 10 + i * 30 }));
    // 親の窓だけ 1 件多く数える（両端を含まないという前提が崩れた場合をまねる）。親は間引かれて読めないので割る
    const { f } = store(rows, {
      sampleAboveMs: 600,
      countFor: (from, to, n) => (from === 0 && to === 1000 ? n + 1 : n),
    });
    const r = await queryIssueLogs({ fetch: f }, { ...opts6d(0, 1000), minWindowMs: 10 });
    const lost = r.incomplete.filter((x) => x.reason === "split lost rows");
    expect(lost).toEqual([
      { from: 0, to: 1000, expected: 31, read: 30, reason: "split lost rows" },
    ]);
    expect(r.events).toHaveLength(30);
  });

  it("件数が 0 の窓は events を読まない。照会の回数には上限があり、超えれば例外（読み切れないまま空として扱わない）", async () => {
    const { f, seen } = store([]);
    const r = await queryIssueLogs({ fetch: f }, opts6d(0, 1000));
    expect(r.events).toEqual([]);
    expect(r.count).toBe(0);
    expect(seen.filter((b) => b.view === "events")).toEqual([]);
    const rows = Array.from({ length: 64 }, (_, i) => ({ id: `m${i}`, ts: 1 + i * 15 }));
    const many = store(rows, { sampleAboveMs: 1 });
    await expect(
      queryIssueLogs({ fetch: many.f }, { ...opts6d(0, 1000), minWindowMs: 1, maxRequests: 10 }),
    ).rejects.toThrow(/requests/);
  });

  it("件数が 0 でも取り込みの時点で間引かれていれば（sampleInterval > 1）早期に終えず incomplete（0 件を信用しない）", async () => {
    const { f } = store([], { sampleInterval: 2 });
    const r = await queryIssueLogs({ fetch: f }, opts6d(0, 1000));
    expect(r.incomplete).toHaveLength(1);
    expect(r.incomplete[0]?.reason).toContain("ingestion sampled");
  });

  it("件数が上限以下でもページが満杯なら（件数のあとに行が増えた）、割れる窓ではページ送りせずに割る", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, ts: 10 + i * 30 }));
    // 全体の窓だけ件数を少なく返す（数えたあとに行が増えた場合をまねる）
    const { f, seen } = store(rows, {
      countFor: (from, to, n) => (from === 0 && to === 1000 ? 15 : n),
    });
    const r = await queryIssueLogs(
      { fetch: f },
      { ...opts6d(0, 1000), pageLimit: 20, minWindowMs: 1 },
    );
    expect(r.incomplete).toEqual([]);
    expect(r.events).toHaveLength(30);
    expect(new Set(idsOf(r.events)).size).toBe(30);
    expect(seen.some((b) => typeof b.offset === "string")).toBe(false);
  });

  it("割れない窓のページ送りで、前のページの $metadata.id が後のページに再び出たら（offset の解釈が決まらない）incomplete", async () => {
    // 新しい順に a, X, X, b, c。limit 2 だと 1 ページ目の最後が X、次のページの先頭も X になる
    const rows = [
      { id: "a", ts: 50 },
      { id: "X", ts: 40 },
      { id: "X", ts: 30 },
      { id: "b", ts: 20 },
      { id: "c", ts: 10 },
    ];
    const { f } = store(rows);
    const r = await queryIssueLogs(
      { fetch: f },
      { ...opts6d(0, 100), pageLimit: 2, minWindowMs: 1000 },
    );
    expect(r.incomplete).toHaveLength(1);
    expect(r.incomplete[0]).toMatchObject({ from: 0, to: 100, expected: 5 });
    expect(r.incomplete[0]?.reason).toContain("cursor");
  });

  it("割れない窓のページ送りで同じ id の行がまとめて飛ばされ、あとから入った行が欠けを埋めても、読み終えたあとの件数で incomplete", async () => {
    // 新しい順に n（数えたあとに入った行）, a, X, X, b, c。limit 3 で 1 ページ目の最後が X、
    // offset を「同じ id をまとめて飛ばす」と解釈されると 2 つ目の X を取りこぼし、行数は最初の件数（5）と同じになる
    const rows = [
      { id: "n", ts: 60 },
      { id: "a", ts: 50 },
      { id: "X", ts: 40 },
      { id: "X", ts: 30 },
      { id: "b", ts: 20 },
      { id: "c", ts: 10 },
    ];
    let k = 0;
    const { f } = store(rows, {
      offsetMode: "skipAll",
      countFor: (_from, _to, n) => (k++ === 0 ? n - 1 : n),
    });
    const r = await queryIssueLogs(
      { fetch: f },
      { ...opts6d(0, 100), pageLimit: 3, minWindowMs: 1000 },
    );
    expect(r.incomplete).toHaveLength(1);
    expect(r.incomplete[0]).toMatchObject({ from: 0, to: 100, expected: 6, read: 5 });
  });
});
