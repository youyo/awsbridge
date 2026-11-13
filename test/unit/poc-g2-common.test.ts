// G2 の実測の道具（scripts/poc/g2/）の共通の純粋関数: 時間の指定・見張りの予定（追 2 の延長）・出力の検査の小道具。
import { describe, expect, it } from "vitest";
import {
  findLeaks,
  g2Settings,
  nextStep,
  parseDuration,
  refusedForSeconds,
  type Schedule,
} from "../../scripts/poc/g2/common";

describe("parseDuration", () => {
  it("秒（数字だけ・s）・分（m）・時間（h）を秒にする", () => {
    expect(parseDuration("90", "--x")).toBe(90);
    expect(parseDuration("45s", "--x")).toBe(45);
    expect(parseDuration("60m", "--x")).toBe(3600);
    expect(parseDuration("24h", "--x")).toBe(86_400);
    expect(parseDuration("0", "--x")).toBe(0);
  });

  it("形の違う値・負の値・小数は断る（名前を文に入れる）", () => {
    for (const v of ["", "-1", "1.5", "10d", "m", "1 m", "abc"])
      expect(() => parseDuration(v, "--interval"), v).toThrow(/--interval/);
  });
});

describe("g2Settings", () => {
  it("記録の置き場所の既定はリポジトリの .secrets/g2-dev、AWSBRIDGE_G2_DEV_DIR で変えられる", () => {
    expect(g2Settings({}).dir).toMatch(/\/\.secrets\/g2-dev$/);
    expect(g2Settings({ AWSBRIDGE_G2_DEV_DIR: "/tmp/x" }).dir).toBe("/tmp/x");
    expect(g2Settings({ AWSBRIDGE_G2_DEV_DIR: "/tmp/x" }).cookiesDir).toBe("/tmp/x/cookies");
  });
});

describe("見張りの予定 nextStep（追 2: 1 分おきに 60 分、通り続ければ 5 分おきに最長 24 時間）", () => {
  const extended: Schedule = {
    intervalSeconds: 60,
    durationSeconds: 3600,
    extendIntervalSeconds: 300,
    maxDurationSeconds: 86_400,
    stopAfterRefusedSeconds: 1800,
  };

  it("最初の区間は間隔どおりに続ける（断られていても 60 分は止めない）", () => {
    expect(nextStep(extended, 0, undefined)).toEqual({ action: "wait", delaySeconds: 60 });
    expect(nextStep(extended, 3540, 3000)).toEqual({ action: "wait", delaySeconds: 60 });
  });

  it("延長を指定しなければ、最初の区間の終わりで止める", () => {
    const plain: Schedule = { intervalSeconds: 60, durationSeconds: 1800 };
    expect(nextStep(plain, 1799, undefined)).toEqual({ action: "wait", delaySeconds: 60 });
    expect(nextStep(plain, 1800, undefined)).toEqual({ action: "stop", reason: "duration" });
  });

  it("60 分の時点で見張る kid がまだ通るなら、5 分おきに広げる", () => {
    expect(nextStep(extended, 3600, undefined)).toEqual({ action: "wait", delaySeconds: 300 });
    expect(nextStep(extended, 50_000, undefined)).toEqual({ action: "wait", delaySeconds: 300 });
  });

  it("延長の区間で、見張る kid が 30 分断られ続けたら止める", () => {
    expect(nextStep(extended, 3600, 1799)).toEqual({ action: "wait", delaySeconds: 300 });
    expect(nextStep(extended, 3600, 1800)).toEqual({ action: "stop", reason: "refused" });
  });

  it("最長（24 時間）に届いたら止める。次の待ちは最長を越えない", () => {
    expect(nextStep(extended, 86_400, undefined)).toEqual({ action: "stop", reason: "max" });
    expect(nextStep(extended, 86_300, undefined)).toEqual({ action: "wait", delaySeconds: 100 });
  });

  it("延長の間隔か最長の片方だけは断る。最長が最初の区間より短いのも断る", () => {
    expect(() => nextStep({ ...extended, maxDurationSeconds: undefined }, 0, undefined)).toThrow();
    expect(() =>
      nextStep({ ...extended, extendIntervalSeconds: undefined }, 0, undefined),
    ).toThrow();
    expect(() => nextStep({ ...extended, maxDurationSeconds: 60 }, 0, undefined)).toThrow();
  });
});

describe("refusedForSeconds（見張る対象が今まで続けて断られている秒数）", () => {
  const s = (at: number, ok: boolean) => ({ atSeconds: at, ok });

  it("最後が成功なら undefined、まだ 1 回もなければ undefined", () => {
    expect(refusedForSeconds([], 100)).toBeUndefined();
    expect(refusedForSeconds([s(0, false), s(60, true)], 100)).toBeUndefined();
  });

  it("末尾の失敗の連続の最初から今までの秒数", () => {
    expect(refusedForSeconds([s(0, true), s(60, false), s(120, false)], 200)).toBe(140);
    expect(refusedForSeconds([s(0, false), s(60, false)], 60)).toBe(60);
  });
});

describe("findLeaks（出力に秘密の形の文字列が無いかの検査。試験と道具の両方で使う）", () => {
  // JWT の形の文字列は実行時に組む（gitleaks の誤検知を避ける）
  const part = (s: string) => Buffer.from(s).toString("base64url");
  const jwt = [part('{"alg":"RS256"}'), part('{"sub":"x"}'), "c2lnbmF0dXJl"].join(".");

  it("JWT の形・AWS の一時キー・渡した値を見つける", () => {
    expect(findLeaks(`token ${jwt} end`, [])).toEqual(["jwt"]);
    expect(findLeaks(`id ${["ASIA", "Q".repeat(16)].join("")}`, [])).toEqual(["aws_access_key_id"]);
    expect(findLeaks("cookie=abcdefghij", ["abcdefghij"])).toEqual(["value#1"]);
  });

  it("何も無ければ空", () => {
    expect(findLeaks("2026-11-13T00:00:00Z A=OK", ["zzzzzzzzzz"])).toEqual([]);
  });
});
