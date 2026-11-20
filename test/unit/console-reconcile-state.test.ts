// 確認済みの区間の状態ファイル（src/console/reconcile-state.ts。純粋な関数）。
// 入れるのはアカウント ID と時刻だけ（トークン・email・jti は入れない）。壊れた状態は初回として扱わず、拒否する。
import { describe, expect, it } from "vitest";
import {
  type AccountState,
  accountStateOf,
  coveredUntilOf,
  FUTURE_TOLERANCE_MS,
  MAX_CODE_COUNT,
  parseReconcileState,
  serializeReconcileState,
  withAccountState,
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
      version: 2,
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
      JSON.stringify({ version: 3, accounts: {} }),
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

  it("未来の時刻（今 + 許容 5 分より後）は壊れた状態と同じ扱いで例外。許容の範囲内と今ちょうどは受け付ける。中身は文に入れない", () => {
    expect(FUTURE_TOLERANCE_MS).toBe(5 * 60_000);
    const text = (t: number) =>
      serializeReconcileState(withCoveredUntil(parseReconcileState(undefined), ACCOUNT, t));
    expect(() => parseReconcileState(text(T), T)).not.toThrow();
    expect(() => parseReconcileState(text(T + FUTURE_TOLERANCE_MS), T)).not.toThrow();
    expect(() => parseReconcileState(text(T + FUTURE_TOLERANCE_MS + 1000), T)).toThrow();
    // ほかのアカウントの値が未来でも拒否する
    const two = withCoveredUntil(
      withCoveredUntil(parseReconcileState(undefined), "444444444444", T + 86_400_000),
      ACCOUNT,
      T,
    );
    expect(() => parseReconcileState(serializeReconcileState(two), T)).toThrow();
    try {
      parseReconcileState(text(T + 86_400_000), T);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("2026");
      expect((e as Error).message).not.toContain(ACCOUNT);
    }
    // now を渡さなければ未来の検査はしない（純粋な読み取りだけ）
    expect(() => parseReconcileState(text(T + 86_400_000))).not.toThrow();
  });
});

// 所見の保持（cto の決裁 2026-11-19 h1・q3・q1・q2）: version 2。アカウントの行は coveredUntil（任意。i2）・unresolved（時刻を持つ所見の錨）・
// untimed（時刻を持たない誤りの件数だけ）・accepted（受け入れた区間。追記だけ）の部分集合で、coveredUntil・unresolved・untimed のどれか 1 つ以上。
describe("reconcile-state: version 2（所見の保持）", () => {
  const iso = (t: number) => new Date(t).toISOString();
  const H = 3_600_000;
  const full: AccountState = {
    coveredUntil: T,
    unresolved: {
      oldestAt: T - 5 * H,
      newestAt: T - 2 * H,
      firstSeenAt: T - H,
      codes: { assume_without_record: 2, identity_mismatch: 1 },
      criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
    },
    untimed: { codes: { region_unread: 1 }, firstWindowStart: T - 30 * H, settledUntil: T - 6 * H },
    accepted: [
      {
        from: T - 9 * H,
        until: T - 8 * H,
        acceptedAt: T - 7 * H,
        reasonGiven: true,
        codes: { assume_without_record: 1 },
      },
    ],
  };

  it("書くときは version 2。行は在る項目だけ（誤りなしの行は coveredUntil だけ）。時刻は ISO 8601、件数は code ごと", () => {
    const s = withAccountState(parseReconcileState(undefined), ACCOUNT, full);
    const body = JSON.parse(serializeReconcileState(s));
    expect(body).toEqual({
      version: 2,
      accounts: {
        [ACCOUNT]: {
          coveredUntil: iso(T),
          unresolved: {
            oldestAt: iso(T - 5 * H),
            newestAt: iso(T - 2 * H),
            firstSeenAt: iso(T - H),
            codes: { assume_without_record: 2, identity_mismatch: 1 },
            criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
          },
          untimed: {
            codes: { region_unread: 1 },
            firstWindowStart: iso(T - 30 * H),
            settledUntil: iso(T - 6 * H),
          },
          accepted: [
            {
              from: iso(T - 9 * H),
              until: iso(T - 8 * H),
              acceptedAt: iso(T - 7 * H),
              reasonGiven: true,
              codes: { assume_without_record: 1 },
            },
          ],
        },
      },
    });
    expect(accountStateOf(parseReconcileState(serializeReconcileState(s), T), ACCOUNT)).toEqual(
      full,
    );
    const plain = JSON.parse(
      serializeReconcileState(withCoveredUntil(parseReconcileState(undefined), ACCOUNT, T)),
    );
    expect(Object.keys(plain.accounts[ACCOUNT])).toEqual(["coveredUntil"]);
  });

  it("coveredUntil の無い行（--init の実行が誤りだった行）を読み書きできる（i2）", () => {
    const row: AccountState = {
      watchStart: T - H,
      untimed: {
        codes: { record_read_incomplete: 1 },
        firstWindowStart: T - 144 * H,
        settledUntil: T,
      },
    };
    const text = serializeReconcileState(
      withAccountState(parseReconcileState(undefined), ACCOUNT, row),
    );
    const back = parseReconcileState(text, T);
    expect(accountStateOf(back, ACCOUNT)).toEqual(row);
    expect(coveredUntilOf(back, ACCOUNT)).toBeUndefined();
  });

  it("version 1 は unresolved なしとして読む（書くときは 2）", () => {
    const v1 = JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { coveredUntil: iso(T) } } });
    const s = parseReconcileState(v1, T);
    expect(accountStateOf(s, ACCOUNT)).toEqual({ coveredUntil: T });
    expect(JSON.parse(serializeReconcileState(s)).version).toBe(2);
  });

  it("withCoveredUntil は同じ行の unresolved・accepted を残す", () => {
    const s = withCoveredUntil(
      withAccountState(parseReconcileState(undefined), ACCOUNT, full),
      ACCOUNT,
      T + 1000,
    );
    expect(accountStateOf(s, ACCOUNT)).toEqual({ ...full, coveredUntil: T + 1000 });
  });

  it("壊れた version 2 は例外（空の行・知らない項目・時刻の誤り・前後の逆転・件数の誤り・理由の有無が true でない・accepted が配列でない・version 2 の形の v1）。中身は文に入れない", () => {
    const row = (r: unknown) => JSON.stringify({ version: 2, accounts: { [ACCOUNT]: r } });
    const un = (o: Record<string, unknown>) =>
      row({
        watchStart: iso(T),
        unresolved: {
          oldestAt: iso(T - H),
          newestAt: iso(T),
          firstSeenAt: iso(T),
          codes: { a_b: 1 },
          criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
          ...o,
        },
      });
    const ut = (o: Record<string, unknown>) =>
      row({
        watchStart: iso(T),
        untimed: { codes: { a_b: 1 }, firstWindowStart: iso(T - H), settledUntil: iso(T), ...o },
      });
    const acc = (o: Record<string, unknown>) =>
      row({
        coveredUntil: iso(T),
        accepted: [
          {
            from: iso(T - H),
            until: iso(T),
            acceptedAt: iso(T),
            reasonGiven: true,
            codes: { a_b: 1 },
            ...o,
          },
        ],
      });
    const bad = [
      row({}),
      row({ accepted: [] }),
      row({ coveredUntil: iso(T), extra: 1 }),
      row({ coveredUntil: "secret-value" }),
      un({ oldestAt: "secret-value" }),
      un({ oldestAt: iso(T), newestAt: iso(T - H) }),
      un({ codes: {} }),
      un({ codes: { a_b: 0 } }),
      un({ codes: { a_b: 1.5 } }),
      un({ codes: { "Bad Code": 1 } }),
      un({ jti: "secret-value" }),
      // 錨を作ったときの判定条件（B1）: 無い・知らない項目・整数でない・範囲の外
      un({ criteria: undefined }),
      un({ criteria: { clockSkewSeconds: 60 } }),
      un({ criteria: { clockSkewSeconds: 60, lagSeconds: 300, extra: 1 } }),
      un({ criteria: { clockSkewSeconds: -1, lagSeconds: 300 } }),
      un({ criteria: { clockSkewSeconds: 60, lagSeconds: 0 } }),
      un({ criteria: { clockSkewSeconds: 1.5, lagSeconds: 300 } }),
      un({ criteria: { clockSkewSeconds: 60, lagSeconds: 1_000_000 } }),
      un({ codes: { a_b: MAX_CODE_COUNT + 1 } }),
      ut({ codes: {} }),
      ut({ at: iso(T) }),
      // 時刻を持たない誤りを記録した実行の窓（続き 5 の R4）: 無い・読めない
      ut({ firstWindowStart: undefined }),
      ut({ settledUntil: undefined }),
      ut({ firstWindowStart: "secret-value" }),
      // 範囲の前後が逆（続き 6 の U7）
      ut({ firstWindowStart: iso(T), settledUntil: iso(T - H) }),
      row({ watchStart: iso(T), untimed: { codes: { a_b: 1 } } }),
      // 見張りの始まり（続き 5 の w1）: 確認済みの区間の無い行には必ず 1 つ、確認済みの行には無い。読めない時刻は拒否
      row({ untimed: { codes: { a_b: 1 }, firstWindowStart: iso(T - H), settledUntil: iso(T) } }),
      row({ coveredUntil: iso(T), watchStart: iso(T) }),
      row({ watchStart: iso(T) }),
      row({
        watchStart: "secret-value",
        untimed: { codes: { a_b: 1 }, firstWindowStart: iso(T - H), settledUntil: iso(T) },
      }),
      row({ coveredUntil: iso(T), accepted: {} }),
      row({ coveredUntil: iso(T), accepted: [] }),
      acc({ reasonGiven: false }),
      acc({ reason: "secret-value" }),
      acc({ from: iso(T), until: iso(T - H) }),
      acc({ codes: {} }),
      JSON.stringify({
        version: 1,
        accounts: { [ACCOUNT]: { coveredUntil: iso(T), unresolved: {} } },
      }),
    ];
    // 形の正しいものは読める（上の例が狙いの理由で拒否されることの確かめ）
    expect(() => parseReconcileState(un({}), T)).not.toThrow();
    expect(() => parseReconcileState(ut({}), T)).not.toThrow();
    expect(() => parseReconcileState(un({ codes: { a_b: MAX_CODE_COUNT } }), T)).not.toThrow();
    for (const b of bad) {
      expect(() => parseReconcileState(b, T), b).toThrow();
      try {
        parseReconcileState(b, T);
      } catch (e) {
        expect((e as Error).message).not.toContain("secret-value");
        expect((e as Error).message).not.toContain(ACCOUNT);
      }
    }
  });

  it("未来の時刻はどの項目でも拒否する（unresolved・accepted の時刻も）", () => {
    const future = iso(T + FUTURE_TOLERANCE_MS + 1000);
    const row = (r: unknown) => JSON.stringify({ version: 2, accounts: { [ACCOUNT]: r } });
    for (const b of [
      row({
        watchStart: iso(T),
        untimed: { codes: { a: 1 }, firstWindowStart: iso(T), settledUntil: future },
      }),
      row({
        watchStart: future,
        untimed: { codes: { a: 1 }, firstWindowStart: iso(T), settledUntil: iso(T) },
      }),
      row({
        watchStart: iso(T),
        unresolved: {
          oldestAt: iso(T),
          newestAt: future,
          firstSeenAt: iso(T),
          codes: { a: 1 },
          criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
        },
      }),
      row({
        watchStart: iso(T),
        unresolved: {
          oldestAt: iso(T),
          newestAt: iso(T),
          firstSeenAt: future,
          codes: { a: 1 },
          criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
        },
      }),
      row({
        coveredUntil: iso(T),
        accepted: [
          { from: iso(T), until: iso(T), acceptedAt: future, reasonGiven: true, codes: { a: 1 } },
        ],
      }),
    ]) {
      expect(() => parseReconcileState(b, T), b).toThrow();
      // 同じ形で時刻を今にすれば読める（未来の時刻が拒否の理由であることの確かめ）
      expect(() => parseReconcileState(b.split(future).join(iso(T)), T), b).not.toThrow();
    }
  });
});
