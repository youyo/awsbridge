// 確認済みの区間の状態ファイル（src/console/reconcile-state.ts。純粋な関数）。
// 入れるのはアカウント ID と時刻だけ（トークン・email・jti は入れない）。壊れた状態は初回として扱わず、拒否する。
import { describe, expect, it } from "vitest";
import {
  coveredUntilOf,
  parseReconcileState,
  serializeReconcileState,
  withCoveredUntil,
} from "../../src/console/reconcile-state";

const ACCOUNT = "333333333333";
const T = Date.UTC(2026, 10, 13, 11, 55, 0);

describe("reconcile-state", () => {
  it("空の状態から作り、アカウントごとの時刻を引ける。直列化はアカウント ID と時刻（ISO 8601）だけ", () => {
    const s = withCoveredUntil(parseReconcileState(undefined), ACCOUNT, T);
    expect(coveredUntilOf(s, ACCOUNT)).toBe(T);
    expect(coveredUntilOf(s, "444444444444")).toBeUndefined();
    const text = serializeReconcileState(s);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      accounts: { [ACCOUNT]: { coveredUntil: "2026-11-13T11:55:00.000Z" } },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(coveredUntilOf(parseReconcileState(text), ACCOUNT)).toBe(T);
  });

  it("ほかのアカウントの値は残し、同じアカウントは上書きする", () => {
    const s0 = withCoveredUntil(
      withCoveredUntil(parseReconcileState(undefined), "444444444444", T),
      ACCOUNT,
      T,
    );
    const s1 = withCoveredUntil(s0, ACCOUNT, T + 1000);
    expect(coveredUntilOf(s1, "444444444444")).toBe(T);
    expect(coveredUntilOf(s1, ACCOUNT)).toBe(T + 1000);
  });

  it("壊れた状態（JSON でない・版が違う・アカウント ID が 12 桁でない・時刻が読めない・余計な項目）は例外。初回として扱わない", () => {
    const bad = [
      "{not json",
      "[]",
      JSON.stringify({ version: 2, accounts: {} }),
      JSON.stringify({ version: 1, accounts: { abc: { coveredUntil: "2026-11-13T00:00:00Z" } } }),
      JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil: "yesterday" } } }),
      JSON.stringify({
        version: 1,
        accounts: { [ACCOUNT]: { coveredUntil: "2026-11-13T00:00:00Z", token: "x" } },
      }),
      JSON.stringify({ version: 1, accounts: {}, extra: 1 }),
    ];
    for (const b of bad) expect(() => parseReconcileState(b), b).toThrow();
  });

  it("例外の文に状態の中身を入れない", () => {
    try {
      parseReconcileState(
        JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil: "secret-value" } } }),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-value");
      expect((e as Error).message).not.toContain(ACCOUNT);
    }
  });
});
