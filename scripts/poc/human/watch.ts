// PoC P4（緊急停止）の見張り（stop-watch.ts）の純粋関数: 対象の解釈と、記録の集計。
import { basename } from "node:path";
import { markdownTable } from "./cases";
import { isRoleKey, isWho, ROLE_KEYS, type RoleKey } from "./lib";
import { maskSensitive } from "./ops";

export type WatchTarget =
  | { kind: "credentials"; name: string; file: string }
  | { kind: "profile"; name: string; profile: string }
  /** who は 2 人目（AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT）で引き受けるときだけ付く */
  | { kind: "assume"; name: string; role: RoleKey; who?: "second" };

export interface Sample {
  /** ISO 8601（UTC） */
  at: string;
  target: string;
  ok: boolean;
  code?: string;
  /** 失敗の要約（stderr を 1 行に詰めて伏せ字にしたもの） */
  detail?: string;
}

/** 失敗の要約: stderr を 1 行に詰め、email・アカウント ID を伏せ、160 文字までにする。 */
export function failureDetail(stderr: string): string {
  const s = maskSensitive(stderr.replace(/\s+/g, " ").trim());
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 記録（.jsonl）を読み直す。壊れた行・形の違う行は飛ばす。 */
export function parseSamples(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as Partial<Sample>;
      if (typeof v.at !== "string" || typeof v.target !== "string" || typeof v.ok !== "boolean")
        continue;
      const s: Sample = { at: v.at, target: v.target, ok: v.ok };
      if (typeof v.code === "string") s.code = v.code;
      if (typeof v.detail === "string") s.detail = v.detail;
      out.push(s);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}

/** --credentials / --profile / --assume を対象の一覧にする。対象なし・不正な値・名前の重複は例外。 */
export function parseWatchTargets(opts: {
  credentials?: string[] | undefined;
  profile?: string[] | undefined;
  assume?: string[] | undefined;
}): WatchTarget[] {
  const out: WatchTarget[] = [];
  for (const file of opts.credentials ?? [])
    out.push({ kind: "credentials", name: `file:${basename(file)}`, file });
  for (const profile of opts.profile ?? []) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(profile))
      throw new Error(`不正なプロファイル名: '${profile}'`);
    out.push({ kind: "profile", name: `profile:${profile}`, profile });
  }
  for (const spec of opts.assume ?? []) {
    // <ロール> か <ロール>:<primary|second>（2 人目の subject・SourceIdentity で引き受け直す）
    const [role = "", who = "primary", ...rest] = spec.split(":");
    if (!isRoleKey(role) || !isWho(who) || rest.length > 0)
      throw new Error(
        `--assume は <ロール>[:primary|second]（ロールは ${ROLE_KEYS.join(" / ")}）: '${spec}'`,
      );
    out.push(
      who === "second"
        ? { kind: "assume", name: `assume:${role}:second`, role, who }
        : { kind: "assume", name: `assume:${role}`, role },
    );
  }
  if (out.length === 0)
    throw new Error("見張る対象がありません（--credentials / --profile / --assume を 1 つ以上）");
  const names = out.map((t) => t.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`対象の名前が重複しています: ${dup}`);
  return out;
}

export interface TargetSummary {
  target: string;
  total: number;
  okCount: number;
  ngCount: number;
  lastOk: string | undefined;
  firstNg: string | undefined;
  firstNgCode: string | undefined;
  /** 最初の失敗のあとに成功した（伝播の揺れ、aws login の認証情報の更新など） */
  okAfterNg: boolean;
  /** 最初の失敗のあとの最初の成功の時刻 */
  firstOkAfterNg: string | undefined;
  /** 最初の失敗の直前の成功 → 最初の失敗の秒数（見張りの間隔より細かくは分からない） */
  gapSeconds: number | undefined;
  /** since（revoke などの操作時刻）→ 最初の失敗の秒数 */
  sinceToFirstNgSeconds: number | undefined;
}

const sec = (a: string, b: string | Date) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 1000);

/**
 * 対象ごと（最初に出た順）に集計する。
 * since（操作の時刻）を渡すと、それより前の失敗は「最初の失敗」に数えない（操作の前の揺れで秒数が負にならないように）。
 */
export function summarizeSamples(samples: Sample[], since?: Date): TargetSummary[] {
  const order: string[] = [];
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    if (!groups.has(s.target)) {
      groups.set(s.target, []);
      order.push(s.target);
    }
    groups.get(s.target)?.push(s);
  }
  return order.map((target) => {
    const list = [...(groups.get(target) ?? [])].sort(
      (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
    );
    const firstNgIdx = list.findIndex(
      (s) => !s.ok && (since === undefined || new Date(s.at).getTime() >= since.getTime()),
    );
    const firstNg = firstNgIdx >= 0 ? list[firstNgIdx] : undefined;
    const lastOk = [...list].reverse().find((s) => s.ok);
    const okAfter = firstNgIdx >= 0 ? list.slice(firstNgIdx + 1).find((s) => s.ok) : undefined;
    const okAfterNg = okAfter !== undefined;
    const lastOkBefore =
      firstNgIdx > 0 ? [...list.slice(0, firstNgIdx)].reverse().find((s) => s.ok) : undefined;
    return {
      target,
      total: list.length,
      okCount: list.filter((s) => s.ok).length,
      ngCount: list.filter((s) => !s.ok).length,
      lastOk: lastOk?.at,
      firstNg: firstNg?.at,
      firstNgCode: firstNg?.code,
      okAfterNg,
      firstOkAfterNg: okAfter?.at,
      gapSeconds: firstNg && lastOkBefore ? sec(firstNg.at, lastOkBefore.at) : undefined,
      sinceToFirstNgSeconds: firstNg && since ? sec(firstNg.at, since) : undefined,
    };
  });
}

export function formatWatchSummary(summaries: TargetSummary[]): string {
  const dash = (v: string | number | undefined) => (v === undefined ? "-" : String(v));
  return markdownTable(
    [
      "対象",
      "回数（成功/失敗）",
      "最後の成功",
      "最初の失敗",
      "コード",
      "成功→失敗の間隔（秒）",
      "since→最初の失敗（秒）",
      "失敗のあとの最初の成功",
    ],
    summaries.map((s) => [
      s.target,
      `${s.total}（${s.okCount}/${s.ngCount}）`,
      dash(s.lastOk),
      dash(s.firstNg),
      dash(s.firstNgCode),
      dash(s.gapSeconds),
      dash(s.sinceToFirstNgSeconds),
      s.firstOkAfterNg ?? "なし",
    ]),
  );
}
