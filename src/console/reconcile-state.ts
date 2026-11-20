// 突き合わせの「確認済みの区間」と「未解決の所見」の状態（純粋な関数。node:* を import しない）。ファイルの読み書きは scripts/console/reconcile.ts。
// アカウントごとの行（cto の決裁 2026-11-19 h1・i2・q3・q1・q2）:
//   coveredUntil  成功した実行（終了コード 0）が確かめ終えた時刻（任意: --init の実行が誤りだった行には無い）
//   unresolved    時刻を持つ所見の錨（最も古い・最も新しい時刻、code ごとの件数、最初に見つけた時刻）。誤り 0 の実行か受け入れで消える
//   untimed       時刻を持たない誤りの code ごとの件数だけ（record_read_incomplete・region_unread など。coverage_gap は入れない）。
//                 coveredUntil を進めないので読み直され、次の誤り 0 の実行で消える
//   accepted      人が理由つきで受け入れた区間（両端・受け入れた時刻・理由の有無・code ごとの件数）。追記だけで消さない。「確認済み」とは別
// 入れるのはアカウント ID・時刻・code の件数だけで、トークン・email・jti・理由の本文は入れない。
// version 1（coveredUntil だけ）は unresolved なしとして読み、書くときは 2。壊れた状態・知らない形は初回として扱わず拒否する（穴を見落とさないため）。
const ACCOUNT_RE = /^\d{12}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CODE_RE = /^[a-z][a-z_]{0,63}$/;
/** code ごとの件数の上限。書くときはこの値で飽和させ、読むときもこの値まで受け付ける（読めない状態を書かない。(4)）。 */
export const MAX_CODE_COUNT = 1_000_000;
/** 判定条件の秒数の上限（CLI の引数は 6 桁まで）。 */
const MAX_CRITERIA_SECONDS = 999_999;

/** 状態の時刻が「今」より先でも許す幅（時計のずれ）。これより先は壊れた状態として扱う。 */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** code ごとの件数（1 以上の整数）。 */
export type CodeCounts = Record<string, number>;
/**
 * 錨を作ったときの判定条件（cto の決裁 2026-11-19 続き 4 の B1）。CLI の引数で緩められるもの: 時計ずれの許容（--clock-skew-seconds。
 * 大きいほど緩い）と反映の遅れ（--lag-seconds。大きいほど判定しない記録が増えて緩い）。足すときは厳しい方（小さい方）を保つ。
 */
export type JudgmentCriteria = { clockSkewSeconds: number; lagSeconds: number };
/** 時刻を持つ所見の錨（q3）と、それを作ったときの判定条件（B1）。 */
export type Anchors = {
  oldestAt: number;
  newestAt: number;
  firstSeenAt: number;
  codes: CodeCounts;
  criteria: JudgmentCriteria;
};
/**
 * 時刻を持たない誤りの件数（q3。code ごとの最大）と、それを記録した実行が読もうとした範囲（続き 5 の R4）: 窓の始まりの最も古いもの
 * （firstWindowStart）と、判定した終わり（until − lag）の最も新しいもの（settledUntil）。消せるのはこの範囲を読み直した誤り 0 の実行だけ。
 */
export type Untimed = { codes: CodeCounts; firstWindowStart: number; settledUntil: number };
/** 受け入れた区間（q1・q2）。理由の本文は入れない（reasonGiven だけ）。 */
export type AcceptedInterval = {
  from: number;
  until: number;
  acceptedAt: number;
  reasonGiven: true;
  codes: CodeCounts;
};
export type AccountState = {
  coveredUntil?: number;
  /**
   * 見張りの始まり（確認済みの区間の無い行だけ。続き 5 の w1）: --init の実行で決まり以後動かない。--init に --since を明示したら
   * その読み始め、明示しなかったらその実行の終わり（until）。この行を確認済みにできるのは、読み始めがこれ以前の誤り 0 の実行だけ（w2）。
   */
  watchStart?: number;
  unresolved?: Anchors;
  untimed?: Untimed;
  accepted?: AcceptedInterval[];
};

export type ReconcileState = {
  version: 2;
  /** アカウント ID（12 桁）→ 行。 */
  accounts: Record<string, AccountState>;
};

/** 状態が読めないとき（値は文に入れない）。 */
export class ReconcileStateError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const entryError = () =>
  new ReconcileStateError("the reconcile state file has an unexpected entry");

/** 項目が許した名前だけで、必ず要るものがあるか。 */
function keysOk(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

function readTime(v: unknown, now: number | undefined): number {
  if (typeof v !== "string" || !TIME_RE.test(v)) throw entryError();
  const t = Date.parse(v);
  if (Number.isNaN(t))
    throw new ReconcileStateError("the reconcile state file has an unreadable time");
  if (now !== undefined && t > now + FUTURE_TOLERANCE_MS)
    throw new ReconcileStateError("the reconcile state file has a time in the future");
  return t;
}

function readCodes(v: unknown): CodeCounts {
  if (!isObj(v) || Object.keys(v).length === 0) throw entryError();
  const out: CodeCounts = {};
  for (const [code, n] of Object.entries(v)) {
    if (
      !CODE_RE.test(code) ||
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_CODE_COUNT
    )
      throw entryError();
    out[code] = n;
  }
  return out;
}

function readCriteria(v: unknown): JudgmentCriteria {
  const sec = (n: unknown, min: number) =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= MAX_CRITERIA_SECONDS;
  if (
    !isObj(v) ||
    !keysOk(v, ["clockSkewSeconds", "lagSeconds"]) ||
    !sec(v.clockSkewSeconds, 0) ||
    !sec(v.lagSeconds, 1)
  )
    throw entryError();
  return { clockSkewSeconds: v.clockSkewSeconds as number, lagSeconds: v.lagSeconds as number };
}

function readRowV2(entry: unknown, now: number | undefined): AccountState {
  if (
    !isObj(entry) ||
    !keysOk(entry, [], ["coveredUntil", "watchStart", "unresolved", "untimed", "accepted"])
  )
    throw entryError();
  if (
    entry.coveredUntil === undefined &&
    entry.unresolved === undefined &&
    entry.untimed === undefined
  )
    throw entryError();
  // 確認済みの区間の無い行は見張りの始まりを必ず 1 つ持ち、確認済みの行は持たない（w1）
  if ((entry.coveredUntil === undefined) !== (entry.watchStart !== undefined)) throw entryError();
  const row: AccountState = {};
  if (entry.coveredUntil !== undefined) row.coveredUntil = readTime(entry.coveredUntil, now);
  if (entry.watchStart !== undefined) row.watchStart = readTime(entry.watchStart, now);
  if (entry.unresolved !== undefined) {
    const u = entry.unresolved;
    if (!isObj(u) || !keysOk(u, ["oldestAt", "newestAt", "firstSeenAt", "codes", "criteria"]))
      throw entryError();
    const oldestAt = readTime(u.oldestAt, now);
    const newestAt = readTime(u.newestAt, now);
    if (oldestAt > newestAt) throw entryError();
    row.unresolved = {
      oldestAt,
      newestAt,
      firstSeenAt: readTime(u.firstSeenAt, now),
      codes: readCodes(u.codes),
      criteria: readCriteria(u.criteria),
    };
  }
  if (entry.untimed !== undefined) {
    const u = entry.untimed;
    if (!isObj(u) || !keysOk(u, ["codes", "firstWindowStart", "settledUntil"])) throw entryError();
    const firstWindowStart = readTime(u.firstWindowStart, now);
    const settledUntil = readTime(u.settledUntil, now);
    // 範囲の前後が逆なら壊れた状態（書く側は逆にならないように書く。続き 6 の U7）
    if (firstWindowStart > settledUntil) throw entryError();
    row.untimed = { codes: readCodes(u.codes), firstWindowStart, settledUntil };
  }
  if (entry.accepted !== undefined) {
    if (!Array.isArray(entry.accepted) || entry.accepted.length === 0) throw entryError();
    row.accepted = entry.accepted.map((a) => {
      if (
        !isObj(a) ||
        !keysOk(a, ["from", "until", "acceptedAt", "reasonGiven", "codes"]) ||
        a.reasonGiven !== true
      )
        throw entryError();
      const from = readTime(a.from, now);
      const until = readTime(a.until, now);
      if (from > until) throw entryError();
      return {
        from,
        until,
        acceptedAt: readTime(a.acceptedAt, now),
        reasonGiven: true,
        codes: readCodes(a.codes),
      };
    });
  }
  return row;
}

/**
 * 状態のファイルの中身を読む。undefined（ファイルが無い）なら空の状態。壊れていれば ReconcileStateError。
 * now（epoch ミリ秒）を渡すと、now + FUTURE_TOLERANCE_MS より先の時刻（どの項目でも）も壊れた状態として拒否する
 * （手で直したり時計がずれたりして未来の値が入ると、区間が進まず、穴も見つからなくなるため）。
 */
export function parseReconcileState(text: string | undefined, now?: number): ReconcileState {
  if (text === undefined) return { version: 2, accounts: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ReconcileStateError("the reconcile state file is not valid JSON");
  }
  if (
    !isObj(v) ||
    (v.version !== 1 && v.version !== 2) ||
    !isObj(v.accounts) ||
    Object.keys(v).length !== 2
  )
    throw new ReconcileStateError("the reconcile state file has an unexpected shape");
  const accounts: Record<string, AccountState> = {};
  for (const [id, entry] of Object.entries(v.accounts)) {
    if (!ACCOUNT_RE.test(id)) throw entryError();
    if (v.version === 1) {
      if (!isObj(entry) || !keysOk(entry, ["coveredUntil"])) throw entryError();
      accounts[id] = { coveredUntil: readTime(entry.coveredUntil, now) };
    } else accounts[id] = readRowV2(entry, now);
  }
  return { version: 2, accounts };
}

export const accountStateOf = (s: ReconcileState, accountId: string): AccountState | undefined =>
  s.accounts[accountId];

export const coveredUntilOf = (s: ReconcileState, accountId: string): number | undefined =>
  s.accounts[accountId]?.coveredUntil;

/** 行を置き換える（ほかのアカウントの行は残す）。 */
export function withAccountState(
  s: ReconcileState,
  accountId: string,
  row: AccountState,
): ReconcileState {
  return { version: 2, accounts: { ...s.accounts, [accountId]: row } };
}

/** 確認済みの区間の終わりだけを変える（同じ行の unresolved・untimed・accepted は残す）。 */
export function withCoveredUntil(
  s: ReconcileState,
  accountId: string,
  coveredUntil: number,
): ReconcileState {
  return withAccountState(s, accountId, { ...s.accounts[accountId], coveredUntil });
}

const iso = (t: number) => new Date(t).toISOString();
const sortedCodes = (c: CodeCounts): CodeCounts =>
  Object.fromEntries(
    Object.keys(c)
      .sort()
      .map((k) => [k, c[k] as number]),
  );

function serializeRow(r: AccountState): Record<string, unknown> {
  return {
    ...(r.coveredUntil !== undefined ? { coveredUntil: iso(r.coveredUntil) } : {}),
    ...(r.watchStart !== undefined ? { watchStart: iso(r.watchStart) } : {}),
    ...(r.unresolved !== undefined
      ? {
          unresolved: {
            oldestAt: iso(r.unresolved.oldestAt),
            newestAt: iso(r.unresolved.newestAt),
            firstSeenAt: iso(r.unresolved.firstSeenAt),
            codes: sortedCodes(r.unresolved.codes),
            criteria: {
              clockSkewSeconds: r.unresolved.criteria.clockSkewSeconds,
              lagSeconds: r.unresolved.criteria.lagSeconds,
            },
          },
        }
      : {}),
    ...(r.untimed !== undefined
      ? {
          untimed: {
            codes: sortedCodes(r.untimed.codes),
            firstWindowStart: iso(r.untimed.firstWindowStart),
            settledUntil: iso(r.untimed.settledUntil),
          },
        }
      : {}),
    ...(r.accepted !== undefined && r.accepted.length > 0
      ? {
          accepted: r.accepted.map((a) => ({
            from: iso(a.from),
            until: iso(a.until),
            acceptedAt: iso(a.acceptedAt),
            reasonGiven: true,
            codes: sortedCodes(a.codes),
          })),
        }
      : {}),
  };
}

/** ファイルに書く文字列（version 2。アカウント ID の順。時刻は ISO 8601。在る項目だけ）。 */
export function serializeReconcileState(s: ReconcileState): string {
  const accounts = Object.fromEntries(
    Object.keys(s.accounts)
      .sort()
      .map((id) => [id, serializeRow(s.accounts[id] as AccountState)]),
  );
  return `${JSON.stringify({ version: 2, accounts }, null, 2)}\n`;
}
