// G2 の時間差の集計（poc:g2:time-gap）の純粋関数: 発行記録と CloudTrail を jti で結び、eventTime − iat の分布を出す。
import { describe, expect, it } from "vitest";
import { distribution, formatTimeGap, pairGaps } from "../../scripts/poc/g2/time-gap-lib";
import type { AssumeEvent, ReconRecord } from "../../src/console/reconcile-input";

const T0 = Date.parse("2026-11-13T00:00:00Z");
const jti = (n: number) => `${n.toString(16).padStart(8, "0")}-1f4e-4c55-9d2a-7f3c1a2b3c4d`;

/** 項目を落とした写し（exactOptionalPropertyTypes のため undefined を入れない）。 */
function omit<T extends object, K extends keyof T>(o: T, k: K): T {
  const { [k]: _drop, ...rest } = o;
  return rest as T;
}

function rec(n: number, o: Partial<ReconRecord> = {}): ReconRecord {
  return {
    pos: `r:${n}`,
    result: "ok",
    at: T0 + n * 60_000,
    tier: "standard",
    team: "g2std",
    accountId: "123456789012",
    stsRegion: "us-east-1",
    jti: jti(n),
    iat: Math.floor((T0 + n * 60_000) / 1000),
    ...o,
  };
}

function ev(n: number, afterSeconds: number, o: Partial<AssumeEvent> = {}): AssumeEvent {
  return {
    time: T0 + n * 60_000 + afterSeconds * 1000,
    region: "us-east-1",
    tokenId: jti(n),
    ...o,
  };
}

describe("distribution（件数・最小・中央値・p90・最大）", () => {
  it("中央値は偶数なら真ん中の 2 つの平均、p90 は最近順位法（⌈0.9n⌉ 番目）", () => {
    expect(distribution([3, 1, 2])).toEqual({ count: 3, min: 1, median: 2, p90: 3, max: 3 });
    expect(distribution([1, 2, 3, 4])).toEqual({ count: 4, min: 1, median: 2.5, p90: 4, max: 4 });
    expect(distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toMatchObject({ p90: 9, median: 5.5 });
    expect(distribution([-1, 5])).toMatchObject({ min: -1, max: 5 });
  });

  it("空なら undefined", () => {
    expect(distribution([])).toBeUndefined();
  });
});

describe("pairGaps", () => {
  it("jti で結び、差（秒）= eventTime − iat。負の値も残す。階層ごとにも分ける", () => {
    const r = pairGaps(
      [rec(1), rec(2), rec(3, { tier: "admin" })],
      [ev(1, 2), ev(2, -1), ev(3, 40)],
    );
    expect(r.matched.map((m) => m.gapSeconds)).toEqual([2, -1, 40]);
    expect(r.matched.map((m) => m.tier)).toEqual(["standard", "standard", "admin"]);
    expect(r.counts).toMatchObject({ records: 3, events: 3, matched: 3 });
  });

  it("対にならないもの・失敗したイベント・成功でない記録・iat の無い記録・重複を数える", () => {
    const r = pairGaps(
      [
        rec(1),
        rec(2),
        rec(3, { result: "sts_failed" }),
        omit(rec(4), "iat"),
        omit(rec(5), "jti"),
        rec(1, { pos: "r:dup" }),
      ],
      [
        ev(1, 5),
        ev(1, 9),
        ev(6, 1),
        ev(7, 1, { errorCode: "InvalidIdentityToken" }),
        omit(ev(8, 1), "tokenId"),
      ],
    );
    expect(r.matched.map((m) => m.gapSeconds)).toEqual([5]);
    expect(r.counts).toEqual({
      records: 2,
      events: 3,
      matched: 1,
      recordsWithoutEvent: 1,
      eventsWithoutRecord: 1,
      duplicateEvents: 1,
      duplicateRecords: 1,
      recordsNotOk: 1,
      recordsWithoutIat: 1,
      recordsWithoutJti: 1,
      failedEvents: 1,
      eventsWithoutTokenId: 1,
    });
  });
});

describe("formatTimeGap", () => {
  it("分布と件数を出し、jti・アカウント ID を出さない", () => {
    const r = pairGaps([rec(1), rec(2, { tier: "admin" })], [ev(1, 3), ev(2, 7)]);
    const text = formatTimeGap(r);
    expect(text).toMatch(/\| all \| 2 \| 3 \| 5 \| 7 \| 7 \|/);
    expect(text).toMatch(/\| standard \| 1 \| 3 \| 3 \| 3 \| 3 \|/);
    expect(text).toMatch(/\| admin \| 1 \| 7 \| 7 \| 7 \| 7 \|/);
    expect(text).toContain("matched: 2");
    expect(text).not.toContain(jti(1));
    expect(text).not.toContain(jti(1).slice(0, 8));
    expect(text).not.toContain("123456789012");
  });

  it("対が 0 件なら分布は出さずにそう書く", () => {
    expect(formatTimeGap(pairGaps([rec(1)], []))).toMatch(/対になった発行がない/);
  });
});
