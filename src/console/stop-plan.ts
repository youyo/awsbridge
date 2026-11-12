// コンソールログイン: 停止の道具の計画（純粋な関数）。設計: docs/specs/console-login.md §6.3・§4.8。
// 宣言的: 対象の全ロールの予約名（reserved.ts の STOP_USER_INLINE_POLICY_NAME）のインラインの中身を、停止の一覧にそろえる。
// 読み取り（aws CLI）と書き込みは scripts/console/stop.ts。node の API を使わない。Worker からは import しない。
//
// 対象のロール: 設定の roles[].roleName のうちアカウントにあるもの、コンソール用のパス（/awsbridge-console/）のロール、
// パスの外でコンソールのプロバイダーを信頼するロール（設定に無いロール。検査の unlisted_role）。
// 方向（cto の決裁 2026-11-13 の ★4・★5）:
// - 止める方向（どのロールでも値が減らない）: 全体を止めない。予約名の衝突・名前の大文字小文字の違い・容量超え・
//   詳細を読めていないロールは書かずに報告し（終了コード 1）、ほかのロールには書く
// - 解除の方向（どれかのロールで値が減る）: --allow-remove が要る。衝突・容量超えなどがあれば何も書かずに止める
// 結果には値（email）を入れない（件数だけ）。書く文書（document）だけが値を持つ。

import type { ConsoleConfig } from "./config";
import { ROLE_PATH_PREFIX } from "./constants";
import { type AccountSnapshot, inspectAccount, type RoleSnapshot } from "./inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "./reserved";
import { stopPolicyDocument, stopValues } from "./stops";

/** ロールのインラインポリシーの合計の上限（空白を除いた文字数。IAM のクォータ）。 */
export const INLINE_POLICY_MAX_CHARS = 10_240;

/** 対象のロールの出どころ: 設定のロール / コンソール用のパスのロール（設定に無い）/ パスの外でプロバイダーを信頼するロール（設定に無い）。 */
export type RoleSource = "config" | "path" | "unlisted";

export type StopStep = {
  role: string;
  source: RoleSource;
  action: "put" | "delete" | "none";
  /** 今の予約名の値の件数と、そろえたあとの件数。 */
  before: number;
  after: number;
  /** put のときに書く文書（値を持つ。出力しない）。 */
  document?: ReturnType<typeof stopPolicyDocument>;
};

/** 書かずに報告するロール（止める方向）。 */
export type StopSkip = {
  role: string;
  code: "stop_reserved_conflict" | "reserved_name_case" | "inline_capacity" | "role_unreadable";
};

/** 全体を止める理由（何も書かない）。exit は終了コード。 */
export type StopRefusal = {
  code:
    | "caller_console_role"
    | "caller_account_mismatch"
    | "remove_not_allowed"
    | StopSkip["code"]
    | "unlisted_role";
  role?: string;
  exit: 1 | 2;
};

export type StopWarning = { code: "stops_uppercase"; detail: string };

export type StopPlan = {
  direction: "stop" | "remove";
  steps: StopStep[];
  skipped: StopSkip[];
  refusals: StopRefusal[];
  warnings: StopWarning[];
};

export type StopPlanOptions = {
  /** 値を減らす（停止の解除）ことを許すか（--allow-remove）。 */
  allowRemove: boolean;
  /** sts get-caller-identity の結果。 */
  caller: { account: string; arn: string };
  /** placement: ou のインベントリ（検査と同じ。任意）。 */
  inventory?: unknown;
};

/** ポリシーの大きさ（空白を除いた文字数）。読めない文書（文字列）はそのまま数える。 */
export function policySize(doc: unknown): number {
  const text = typeof doc === "string" ? doc : JSON.stringify(doc);
  return text.replace(/\s/g, "").length;
}

const lower = (s: string) => s.toLowerCase();
const RESERVED = lower(STOP_USER_INLINE_POLICY_NAME);
const onPath = (r: RoleSnapshot) => r.path.startsWith(ROLE_PATH_PREFIX);

/**
 * パスの外でコンソールのプロバイダーを信頼する、設定に無いロールの名前（検査の unlisted_role・signing_account_role の判定を使う）。
 * 読み取りは設定のロールとパスのロールしか詳細を読まないので、停止の道具はこの名前の詳細を読み足す。
 */
export function unlistedRoleNames(
  snapshot: AccountSnapshot,
  config: ConsoleConfig,
  inventory?: unknown,
): string[] {
  const configured = new Set(config.roles.map((r) => lower(r.roleName)));
  const flagged = new Set(
    inspectAccount({ config, snapshot, ...(inventory !== undefined ? { inventory } : {}) })
      .findings.filter((f) => f.code === "unlisted_role" || f.code === "signing_account_role")
      .flatMap((f) => (f.role !== undefined ? [f.role] : [])),
  );
  return snapshot.roles
    .filter((r) => flagged.has(r.roleName) && !onPath(r) && !configured.has(lower(r.roleName)))
    .map((r) => r.roleName)
    .sort();
}

/** 対象のロール（名前の順）: 設定のロール・コンソール用のパスのロール・パスの外でプロバイダーを信頼する設定に無いロール。 */
export function stopTargets(
  snapshot: AccountSnapshot,
  config: ConsoleConfig,
  inventory?: unknown,
): { role: RoleSnapshot; source: RoleSource }[] {
  const configured = new Set(config.roles.map((r) => lower(r.roleName)));
  const unlisted = new Set(unlistedRoleNames(snapshot, config, inventory));
  return snapshot.roles
    .flatMap((role) => {
      const source: RoleSource | undefined = configured.has(lower(role.roleName))
        ? "config"
        : onPath(role)
          ? "path"
          : unlisted.has(role.roleName)
            ? "unlisted"
            : undefined;
      return source !== undefined ? [{ role, source }] : [];
    })
    .sort((a, b) =>
      a.role.roleName < b.role.roleName ? -1 : a.role.roleName > b.role.roleName ? 1 : 0,
    );
}

const ASSUMED_ROLE_RE = /^arn:[\w-]+:sts::\d{12}:assumed-role\/([^/]+)\//;

export function planStop(
  snapshot: AccountSnapshot,
  config: ConsoleConfig,
  stops: string[],
  o: StopPlanOptions,
): StopPlan {
  const desired = [...new Set(stops)];
  const configured = new Set(config.roles.map((r) => lower(r.roleName)));
  const refusals: StopRefusal[] = [];
  const warnings: StopWarning[] = [];

  // 呼び出し元: コンソール用のロールのセッションは、守りの部品の Deny で書き込みが途中から失敗するので先に止める
  if (o.caller.account !== snapshot.accountId)
    refusals.push({ code: "caller_account_mismatch", exit: 2 });
  const callerRole = ASSUMED_ROLE_RE.exec(o.caller.arn)?.[1];
  if (callerRole !== undefined) {
    const r = snapshot.roles.find((x) => lower(x.roleName) === lower(callerRole));
    if (configured.has(lower(callerRole)) || (r !== undefined && onPath(r)))
      refusals.push({ code: "caller_console_role", exit: 2 });
  }

  if (config.identity.sourceIdentity === "email") {
    const upper = desired.filter((v) => /[A-Z]/.test(v)).length;
    if (upper > 0) warnings.push({ code: "stops_uppercase", detail: String(upper) });
  }

  // ロールごとの差分（値の集合で比べる）
  type Eval = { step: StopStep; removes: boolean } | { skip: StopSkip };
  const evals: { role: RoleSnapshot; source: RoleSource; e: Eval }[] = [];
  for (const { role: r, source } of stopTargets(snapshot, config, o.inventory)) {
    const skip = (code: StopSkip["code"]) =>
      evals.push({ role: r, source, e: { skip: { role: r.roleName, code } } });
    if (r.inlinePolicies === undefined) {
      skip("role_unreadable");
      continue;
    }
    const reserved = r.inlinePolicies.filter((p) => lower(p.policyName) === RESERVED);
    const others = r.inlinePolicies.filter((p) => lower(p.policyName) !== RESERVED);
    if (reserved.some((p) => p.policyName !== STOP_USER_INLINE_POLICY_NAME)) {
      skip("reserved_name_case");
      continue;
    }
    const current = reserved[0];
    const have = current === undefined ? [] : stopValues(current.document);
    if (have === undefined) {
      skip("stop_reserved_conflict");
      continue;
    }
    const removes = have.some((v) => !desired.includes(v));
    const same = !removes && desired.every((v) => have.includes(v));
    const base = { role: r.roleName, source, before: have.length, after: desired.length };
    if (desired.length === 0) {
      evals.push({
        role: r,
        source,
        e: { step: { ...base, action: current ? "delete" : "none" }, removes },
      });
      continue;
    }
    if (same) {
      evals.push({ role: r, source, e: { step: { ...base, action: "none" }, removes } });
      continue;
    }
    const document = stopPolicyDocument(desired);
    const total = others.reduce((n, p) => n + policySize(p.document), 0) + policySize(document);
    if (total > INLINE_POLICY_MAX_CHARS) {
      skip("inline_capacity");
      continue;
    }
    evals.push({ role: r, source, e: { step: { ...base, action: "put", document }, removes } });
  }

  const direction = evals.some((x) => "step" in x.e && x.e.removes) ? "remove" : "stop";
  const steps = evals.flatMap((x) => ("step" in x.e ? [x.e.step] : []));
  let skipped = evals.flatMap((x) => ("skip" in x.e ? [x.e.skip] : []));

  if (direction === "remove") {
    // 解除は計画どおり: 許可が無い・書けないロールがある・設定に無いロールがあるなら、何も書かずに止める
    if (!o.allowRemove) refusals.push({ code: "remove_not_allowed", exit: 2 });
    for (const s of skipped) refusals.push({ code: s.code, role: s.role, exit: 2 });
    for (const s of steps)
      if (s.source === "unlisted") refusals.push({ code: "unlisted_role", role: s.role, exit: 1 });
    skipped = [];
  }

  return { direction, steps, skipped, refusals, warnings };
}

/**
 * 計画の終了コード（書く前）: 拒否があれば 2（設定に無いロールだけなら 1）、書かずに報告するロールがあれば 1、ほかは 0。
 * 書き込みの失敗は呼び出し側で 1 にする。
 */
export function planExitCode(p: StopPlan): 0 | 1 | 2 {
  if (p.refusals.length > 0) return p.refusals.some((r) => r.exit === 2) ? 2 : 1;
  return p.skipped.length > 0 ? 1 : 0;
}
