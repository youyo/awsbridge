// 1 人停止の一覧と文書の形（src/console/stops.ts）。設計: docs/specs/console-login.md §6.3（U-15）。
// 停止の一覧（{ "sourceIdentities": [...] }）の読み込みと、予約名のインラインに書く文書の形（stopPolicyDocument）が、
// 検査の判定（stopValues）と往復で一致することを確かめる。値はすべてダミー。
import { describe, expect, it } from "vitest";
import {
  parseStops,
  SOURCE_IDENTITY_RE,
  StopsError,
  stopPolicyDocument,
  stopValues,
} from "../../src/console/stops";

const A = "user1@example.com";
const B = "user2@example.com";

describe("parseStops（停止の一覧）", () => {
  it("重複を除いた一覧を返す（順は最初に出た順。値は変えない）", () => {
    expect(parseStops({ sourceIdentities: [A, B, A, "User3@Example.com"] })).toEqual([
      A,
      B,
      "User3@Example.com",
    ]);
  });

  it("空の一覧は受け付ける（だれも止めていない）", () => {
    expect(parseStops({ sourceIdentities: [] })).toEqual([]);
  });

  it.each([
    ["配列", []],
    ["null", null],
    ["キーが無い", {}],
    ["一覧が文字列", { sourceIdentities: A }],
  ])("形の誤り（%s）は位置だけを示して拒否する", (_n, raw) => {
    expect(() => parseStops(raw)).toThrow(new StopsError("stops.sourceIdentities: type"));
  });

  it.each([
    ["65 文字", "a".repeat(65)],
    ["1 文字", "a"],
    ["空白を含む", "user 1@example.com"],
    ["数", 1],
  ])("値の形の誤り（%s）は位置だけを示し、値を出さない", (_n, v) => {
    let message = "";
    try {
      parseStops({ sourceIdentities: [A, v] });
    } catch (e) {
      expect(e).toBeInstanceOf(StopsError);
      message = (e as Error).message;
    }
    expect(message).toBe("stops.sourceIdentities[1]: pattern");
  });

  it("64 文字までの値は受け付ける", () => {
    const v = "a".repeat(64);
    expect(SOURCE_IDENTITY_RE.test(v)).toBe(true);
    expect(parseStops({ sourceIdentities: [v] })).toEqual([v]);
  });
});

describe("stopPolicyDocument と stopValues の往復", () => {
  it.each([[[A]], [[A, B]], [[A, B, A]], [["User3@Example.com", "custom-id_1"]]])(
    "stopValues(stopPolicyDocument(%j)) は重複を除いた一覧と同じ",
    (xs) => {
      expect(stopValues(stopPolicyDocument(xs))).toEqual([...new Set(xs)]);
    },
  );

  it("文書の形: Deny・Action *・Resource *・StringEquals の aws:SourceIdentity だけ", () => {
    expect(stopPolicyDocument([A])).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyBySourceIdentity",
          Effect: "Deny",
          Action: "*",
          Resource: "*",
          Condition: { StringEquals: { "aws:SourceIdentity": [A] } },
        },
      ],
    });
  });

  it.each([
    ["空の一覧", []],
    ["65 文字の値", ["a".repeat(65)]],
    ["形の誤り", ["user 1@example.com"]],
  ])("%s は拒否する（値を出さない）", (_n, xs) => {
    let message = "";
    try {
      stopPolicyDocument(xs as string[]);
    } catch (e) {
      expect(e).toBeInstanceOf(StopsError);
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    for (const v of xs as string[]) expect(message).not.toContain(v);
  });

  it("stopValues: 停止の形でない文書は undefined（衝突）。空の Statement も衝突", () => {
    expect(stopValues({ Version: "2012-10-17", Statement: [] })).toBeUndefined();
    expect(
      stopValues({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      }),
    ).toBeUndefined();
    expect(stopValues("not a document")).toBeUndefined();
  });

  it("stopValues: 1 要素を文字列で書いた形・複数の文も読む（IAM の返す書き方の違い）", () => {
    const st = (v: unknown) => ({
      Effect: "Deny",
      Action: ["*"],
      Resource: "*",
      Condition: { StringEquals: { "aws:SourceIdentity": v } },
    });
    expect(stopValues({ Version: "2012-10-17", Statement: st(A) })).toEqual([A]);
    expect(stopValues({ Version: "2012-10-17", Statement: [st(A), st([B, A])] })).toEqual([A, B]);
  });
});
