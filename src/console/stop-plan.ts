// コンソールログイン: 停止の道具の計画（純粋な関数）。設計: docs/specs/console-login.md §6.3・§4.8。
// 対象の全ロールの予約名（reserved.ts の STOP_USER_INLINE_POLICY_NAME）のインラインの中身を、停止の一覧に合わせる。
// 読み取り（aws CLI）と書き込みは scripts/console/stop.ts。node の API を使わない。Worker からは import しない。
//
// 対象のロール: 設定の roles[].roleName のうちアカウントにあるもの、コンソール用のパス（/awsbridge-console/）のロール、
// パスの外でコンソールのプロバイダーを信頼するロール（設定に無いロール。検査の unlisted_role）。
// 値ごとに方向を分ける（cto の決裁 2026-11-13 の ★4・★5 と、同日の司令塔の判断）:
// - --allow-remove なし（mode: add）: 足すだけ。各ロールを (今の値 ∪ 一覧の値) にする。一覧に無い値は消さず、余分の件数を報告する
// - --allow-remove あり（mode: sync）: 一覧にそろえる。足す書き込み（今の値 ∪ 一覧）を全ロールで先に行い、外す書き込みはそのあと
// - どちらでも全体を止めない。予約名の衝突・名前の大文字小文字の違い・容量超え・詳細を読めていないロールは書かずに報告する（終了コード 1）
// - 足す値が 1 つも無く外す値だけがある実行（解除だけ）は、--allow-remove が無ければ拒否する（終了コード 2）
// 結果の件数・コードには値（email）を入れない。書き込み（writes）の values と document だけが値を持ち、出力しない。

import type { ConsoleConfig } from "./config";
import { ROLE_PATH_PREFIX } from "./constants";
import { type AccountSnapshot, inspectAccount, type RoleSnapshot } from "./inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "./reserved";
import { stopPolicyDocument, stopValues } from "./stops";

/** ロールのインラインポリシーの合計の上限（空白を除いた文字数。IAM のクォータ）。 */
export const INLINE_POLICY_MAX_CHARS = 10_240;

/** 対象のロールの出どころ: 設定のロール / コンソール用のパスのロール（設定に無い）/ パスの外でプロバイダーを信頼するロール（設定に無い）。 */
export type RoleSource = "config" | "path" | "unlisted";

/** 1 回の書き込み。values は書いたあとに予約名にある値（読み直しで確かめる）。document は put のときだけ。 */
export type StopWrite = {
  phase: "add" | "remove";
  action: "put" | "delete";
  values: string[];
  document?: ReturnType<typeof stopPolicyDocument>;
};

export type StopStep = {
  role: string;
  source: RoleSource;
  /** 今の予約名の値の件数と、書き終えたあとの件数。 */
  before: number;
  after: number;
  /** 一覧にあって今は無い値の件数（足す）と、今あって一覧に無い値の件数（余分。mode: sync なら外す）。 */
  added: number;
  extra: number;
  /** 書き込み（add の段階が先、remove の段階があと）。空なら変更なし。 */
  writes: StopWrite[];
};

/** 書かずに報告するロール。 */
export type StopSkip = {
  role: string;
  code: "stop_reserved_conflict" | "reserved_name_case" | "inline_capacity" | "role_unreadable";
};

/** 全体を止める理由（何も書かない）。終了コードは 2。 */
export type StopRefusal = {
  code: "caller_console_role" | "caller_account_mismatch" | "remove_not_allowed";
  exit: 2;
};

export type StopWarning = { code: "stops_uppercase"; detail: string };

export type StopPlan = {
  mode: "add" | "sync";
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
  const steps: StopStep[] = [];
  const skipped: StopSkip[] = [];
  for (const { role: r, source } of stopTargets(snapshot, config, o.inventory)) {
    const skip = (code: StopSkip["code"]) => skipped.push({ role: r.roleName, code });
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
    const have = reserved[0] === undefined ? [] : stopValues(reserved[0].document);
    if (have === undefined) {
      skip("stop_reserved_conflict");
      continue;
    }
    const add = desired.filter((v) => !have.includes(v));
    const extra = have.filter((v) => !desired.includes(v));
    const union = [...have, ...add];
    const writes: StopWrite[] = [];
    if (add.length > 0) {
      const document = stopPolicyDocument(union);
      const total = others.reduce((n, p) => n + policySize(p.document), 0) + policySize(document);
      if (total > INLINE_POLICY_MAX_CHARS) {
        skip("inline_capacity");
        continue;
      }
      writes.push({ phase: "add", action: "put", values: union, document });
    }
    // 外す段階（mode: sync だけ）。書く文書は足す段階より小さいので、容量は超えない
    if (o.allowRemove && extra.length > 0)
      writes.push(
        desired.length === 0
          ? { phase: "remove", action: "delete", values: [] }
          : {
              phase: "remove",
              action: "put",
              values: desired,
              document: stopPolicyDocument(desired),
            },
      );
    steps.push({
      role: r.roleName,
      source,
      before: have.length,
      after: o.allowRemove ? desired.length : union.length,
      added: add.length,
      extra: extra.length,
      writes,
    });
  }

  // 解除だけの実行（足す値が無く、余分だけがある）は --allow-remove が要る
  if (!o.allowRemove && steps.every((x) => x.added === 0) && steps.some((x) => x.extra > 0))
    refusals.push({ code: "remove_not_allowed", exit: 2 });

  return { mode: o.allowRemove ? "sync" : "add", steps, skipped, refusals, warnings };
}

/**
 * 計画の終了コード（書く前）: 拒否があれば 2、書かずに報告するロールがあれば 1、ほかは 0（余分があるだけなら 0）。
 * 書き込みの失敗は呼び出し側で 1 にする。
 */
export function planExitCode(p: StopPlan): 0 | 1 | 2 {
  if (p.refusals.length > 0) return 2;
  return p.skipped.length > 0 ? 1 : 0;
}
