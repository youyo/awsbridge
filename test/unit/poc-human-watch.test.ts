import { describe, expect, it } from "vitest";
import {
  failureDetail,
  formatWatchSummary,
  parseSamples,
  parseWatchTargets,
  type Sample,
  summarizeSamples,
} from "../../scripts/poc/human/watch";

const s = (at: string, target: string, ok: boolean, code?: string): Sample =>
  code === undefined ? { at, target, ok } : { at, target, ok, code };

describe("parseWatchTargets", () => {
  it("認証情報ファイル・AWS プロファイル・新しい引き受けを対象にできる（名前で区別）", () => {
    expect(
      parseWatchTargets({
        credentials: ["/o/credentials-tagged.json"],
        profile: ["human-poc"],
        assume: ["tagged"],
      }),
    ).toEqual([
      {
        kind: "credentials",
        name: "file:credentials-tagged.json",
        file: "/o/credentials-tagged.json",
      },
      { kind: "profile", name: "profile:human-poc", profile: "human-poc" },
      { kind: "assume", name: "assume:tagged", role: "tagged" },
    ]);
  });
  it("対象が無い・不正なプロファイル名・不明なロール・名前の重複は例外", () => {
    expect(() => parseWatchTargets({})).toThrow();
    expect(() => parseWatchTargets({ profile: ["a b"] })).toThrow();
    expect(() => parseWatchTargets({ profile: ["--x"] })).toThrow();
    expect(() => parseWatchTargets({ assume: ["admin"] })).toThrow();
    expect(() => parseWatchTargets({ profile: ["p", "p"] })).toThrow();
  });
});

describe("summarizeSamples", () => {
  it("対象ごとに最後の成功・最初の失敗（コード）を出す", () => {
    const r = summarizeSamples([
      s("2026-11-11T00:00:00Z", "a", true),
      s("2026-11-11T00:00:00Z", "b", true),
      s("2026-11-11T00:00:05Z", "a", true),
      s("2026-11-11T00:00:05Z", "b", false, "AccessDenied"),
      s("2026-11-11T00:00:10Z", "a", false, "AccessDenied"),
      s("2026-11-11T00:00:10Z", "b", false, "AccessDenied"),
    ]);
    expect(r).toEqual([
      {
        target: "a",
        total: 3,
        okCount: 2,
        ngCount: 1,
        lastOk: "2026-11-11T00:00:05Z",
        firstNg: "2026-11-11T00:00:10Z",
        firstNgCode: "AccessDenied",
        okAfterNg: false,
        firstOkAfterNg: undefined,
        gapSeconds: 5,
        sinceToFirstNgSeconds: undefined,
      },
      {
        target: "b",
        total: 3,
        okCount: 1,
        ngCount: 2,
        lastOk: "2026-11-11T00:00:00Z",
        firstNg: "2026-11-11T00:00:05Z",
        firstNgCode: "AccessDenied",
        okAfterNg: false,
        firstOkAfterNg: undefined,
        gapSeconds: 5,
        sinceToFirstNgSeconds: undefined,
      },
    ]);
  });
  it("失敗のあとに成功した（伝播の揺れ・aws login の更新）ことを okAfterNg で示す", () => {
    const [r] = summarizeSamples([
      s("2026-11-11T00:00:00Z", "p", false, "AccessDenied"),
      s("2026-11-11T00:00:05Z", "p", true),
    ]);
    expect(r?.okAfterNg).toBe(true);
    expect(r?.firstOkAfterNg).toBe("2026-11-11T00:00:05Z");
    expect(r?.firstNg).toBe("2026-11-11T00:00:00Z");
    expect(r?.lastOk).toBe("2026-11-11T00:00:05Z");
    expect(r?.gapSeconds).toBeUndefined();
  });
  it("since（revoke の時刻）を渡すと、そこから最初の失敗までの秒数を出す", () => {
    const [r] = summarizeSamples(
      [s("2026-11-11T00:00:00Z", "a", true), s("2026-11-11T00:00:42Z", "a", false, "X")],
      new Date("2026-11-11T00:00:10Z"),
    );
    expect(r?.sinceToFirstNgSeconds).toBe(32);
  });
  it("since より前の失敗は数えない（操作の前の揺れで秒数が負にならないように）", () => {
    const [r] = summarizeSamples(
      [
        s("2026-11-11T00:00:00Z", "a", false, "Timeout"),
        s("2026-11-11T00:00:05Z", "a", true),
        s("2026-11-11T00:00:20Z", "a", true),
        s("2026-11-11T00:00:25Z", "a", false, "AccessDenied"),
      ],
      new Date("2026-11-11T00:00:10Z"),
    );
    expect(r?.firstNg).toBe("2026-11-11T00:00:25Z");
    expect(r?.firstNgCode).toBe("AccessDenied");
    expect(r?.sinceToFirstNgSeconds).toBe(15);
    expect(r?.gapSeconds).toBe(5);
    expect(r?.okAfterNg).toBe(false);
  });
  it("失敗が無ければ firstNg は undefined", () => {
    const [r] = summarizeSamples([s("2026-11-11T00:00:00Z", "a", true)]);
    expect(r?.firstNg).toBeUndefined();
    expect(r?.okAfterNg).toBe(false);
  });
});

describe("formatWatchSummary", () => {
  it("Markdown の表（対象・最後の成功・最初の失敗・コード・間隔・since から・失敗後の成功）", () => {
    const t = formatWatchSummary(
      summarizeSamples([
        s("2026-11-11T00:00:00Z", "file:credentials.json", true),
        s("2026-11-11T00:00:05Z", "file:credentials.json", false, "AccessDenied"),
      ]),
    );
    const lines = t.split("\n");
    expect(lines[0]).toContain("対象");
    expect(lines[2]).toContain("file:credentials.json");
    expect(lines[2]).toContain("2026-11-11T00:00:00Z");
    expect(lines[2]).toContain("2026-11-11T00:00:05Z");
    expect(lines[2]).toContain("AccessDenied");
  });
});

describe("parseSamples（記録 .jsonl から読み直す）", () => {
  it("1 行 1 件。壊れた行・形の違う行は飛ばす", () => {
    const text = [
      JSON.stringify({ at: "2026-11-11T00:00:00Z", target: "a", ok: true }),
      "{broken",
      JSON.stringify({
        at: "2026-11-11T00:00:05Z",
        target: "a",
        ok: false,
        code: "X",
        detail: "d",
      }),
      JSON.stringify({ foo: 1 }),
      "",
    ].join("\n");
    expect(parseSamples(text)).toEqual([
      { at: "2026-11-11T00:00:00Z", target: "a", ok: true },
      { at: "2026-11-11T00:00:05Z", target: "a", ok: false, code: "X", detail: "d" },
    ]);
  });
});

describe("failureDetail", () => {
  it("stderr を 1 行に詰め、email・アカウント ID を伏せ、160 文字までにする", () => {
    const d = failureDetail(
      "\nError when retrieving credentials from login:\n  arn:aws:sts::123456789012:assumed-role/R/human-user@example.com " +
        "x".repeat(300),
    );
    expect(d).not.toContain("123456789012");
    expect(d).not.toContain("user@example.com");
    expect(d).not.toContain("\n");
    expect(d.length).toBeLessThanOrEqual(161);
    expect(d.startsWith("Error when retrieving credentials from login:")).toBe(true);
  });
});
