// 突き合わせの「確認済みの区間」の状態（純粋な関数。node:* を import しない）。ファイルの読み書きは scripts/console/reconcile.ts。
// アカウントごとに、成功した実行が確かめ終えた時刻（coveredUntil）だけを持つ。次の実行の読み始めがそれより後なら穴がある
// （cto の決裁 G2 の途中経過: 状態は追跡しない場所のファイルに置く）。入れるのはアカウント ID（12 桁）と時刻だけで、
// トークン・email・jti は入れない。壊れた状態は初回として扱わず拒否する（穴を見落とさないため）。
const ACCOUNT_RE = /^\d{12}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type ReconcileState = {
  version: 1;
  /** アカウント ID（12 桁）→ 確認済みの区間の終わり（epoch ミリ秒）。 */
  accounts: Record<string, number>;
};

/** 状態が読めないとき（値は文に入れない）。 */
export class ReconcileStateError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 状態のファイルの中身を読む。undefined（ファイルが無い）なら空の状態。壊れていれば ReconcileStateError。 */
export function parseReconcileState(text: string | undefined): ReconcileState {
  if (text === undefined) return { version: 1, accounts: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ReconcileStateError("the reconcile state file is not valid JSON");
  }
  if (!isObj(v) || v.version !== 1 || !isObj(v.accounts) || Object.keys(v).length !== 2)
    throw new ReconcileStateError("the reconcile state file has an unexpected shape");
  const accounts: Record<string, number> = {};
  for (const [id, entry] of Object.entries(v.accounts)) {
    if (
      !ACCOUNT_RE.test(id) ||
      !isObj(entry) ||
      Object.keys(entry).length !== 1 ||
      typeof entry.coveredUntil !== "string" ||
      !TIME_RE.test(entry.coveredUntil)
    )
      throw new ReconcileStateError("the reconcile state file has an unexpected entry");
    const t = Date.parse(entry.coveredUntil);
    if (Number.isNaN(t))
      throw new ReconcileStateError("the reconcile state file has an unreadable time");
    accounts[id] = t;
  }
  return { version: 1, accounts };
}

export const coveredUntilOf = (s: ReconcileState, accountId: string): number | undefined =>
  s.accounts[accountId];

export function withCoveredUntil(
  s: ReconcileState,
  accountId: string,
  coveredUntil: number,
): ReconcileState {
  return { version: 1, accounts: { ...s.accounts, [accountId]: coveredUntil } };
}

/** ファイルに書く文字列（アカウント ID の順。時刻は ISO 8601）。 */
export function serializeReconcileState(s: ReconcileState): string {
  const accounts = Object.fromEntries(
    Object.keys(s.accounts)
      .sort()
      .map((id) => [id, { coveredUntil: new Date(s.accounts[id] as number).toISOString() }]),
  );
  return `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`;
}
