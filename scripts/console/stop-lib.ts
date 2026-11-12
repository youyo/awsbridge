// 停止の道具の本体（show・apply）。CLI は scripts/console/stop.ts。計画は src/console/stop-plan.ts（純粋な関数）。
// aws CLI の呼び出しは AwsRun として受け取る（stop.ts が許可リストつきの runner を渡す。--yes が無ければ書き込みを含めない）。
// 出力は値（email・SourceIdentity）を出さず件数だけ。アカウント ID は末尾 4 桁。すべての行を redact に通す。
// 設計: docs/specs/console-login.md §6.3・§4.8。cto の決裁 2026-11-13（★4・★5）。

import type { ConsoleConfig } from "../../src/console/config";
import { type Finding, inspectAccount, redact } from "../../src/console/inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "../../src/console/reserved";
import {
  planExitCode,
  planStop,
  type StopPlan,
  type StopStep,
  stopTargets,
  unlistedRoleNames,
} from "../../src/console/stop-plan";
import { stopValues } from "../../src/console/stops";
import type { AwsRun } from "./aws-cli";
import { policyDocument, READ_COMMANDS, readAccountSnapshot } from "./inspect-read";

/** 停止の道具が使う読み取り: 検査の 8 種類と、呼び出し元の確認（sts get-caller-identity）。 */
export const STOP_READ_COMMANDS = [...READ_COMMANDS, "sts get-caller-identity"] as const;
/** 停止の道具の書き込み（この 2 種類だけ。--yes のときだけ runner に含める）。 */
export const STOP_WRITE_COMMANDS = ["iam put-role-policy", "iam delete-role-policy"] as const;

export type StopDeps = {
  run: AwsRun;
  print: (line: string) => void;
  now: () => Date;
};

type Common = {
  config: ConsoleConfig;
  inventory?: unknown;
  profile: string;
  expectAccountId?: string;
};

const masked = (id: string) => `****${id.slice(-4)}`;
const pad = (s: string, n: number) => s.padEnd(n);

/** 設定のロールとパスのロールに加え、パスの外でプロバイダーを信頼するロールの詳細も読む。 */
async function readSnapshot(run: AwsRun, c: Common) {
  const base = {
    roleNames: c.config.roles.map((r) => r.roleName),
    ...(c.expectAccountId !== undefined ? { expectAccountId: c.expectAccountId } : {}),
  };
  const first = await readAccountSnapshot(run, base);
  const extra = unlistedRoleNames(first, c.config, c.inventory);
  if (extra.length === 0) return first;
  return readAccountSnapshot(run, { ...base, roleNames: [...base.roleNames, ...extra] });
}

const SOURCE_NOTE: Record<StopStep["source"], string> = {
  config: "",
  path: "  （設定に無いロール: コンソール用のパスにある）",
  unlisted: "  （設定に無いロール: パスの外でコンソールのプロバイダーを信頼している）",
};

const LABEL: Record<Finding["severity"], string> = {
  error: "ERROR",
  warning: "WARN ",
  note: "NOTE ",
};

// ---- show ----

export async function runShow(
  c: Common & { stops?: string[] },
  deps: Pick<StopDeps, "run" | "print">,
): Promise<number> {
  const out = (line: string) => deps.print(redact(line));
  const snapshot = await readSnapshot(deps.run, c);
  out(`account: ${masked(snapshot.accountId)} profile ${c.profile}`);
  for (const { role, source } of stopTargets(snapshot, c.config, c.inventory)) {
    const reserved = role.inlinePolicies?.find(
      (p) => p.policyName.toLowerCase() === STOP_USER_INLINE_POLICY_NAME.toLowerCase(),
    );
    const values = reserved === undefined ? [] : stopValues(reserved.document);
    const state =
      role.inlinePolicies === undefined
        ? "unreadable"
        : reserved === undefined
          ? "no"
          : values === undefined
            ? "conflict"
            : "yes";
    out(
      `ROLE  ${pad(role.roleName, 32)} ${pad(source, 8)} reserved: ${pad(state, 8)} values: ${values?.length ?? "-"}${SOURCE_NOTE[source]}`,
    );
  }
  // 停止中の判定は検査（inspectAccount の stop_*）をそのまま使う
  const findings = inspectAccount({
    config: c.config,
    snapshot,
    ...(c.inventory !== undefined ? { inventory: c.inventory } : {}),
    ...(c.stops !== undefined ? { stops: c.stops } : {}),
  }).findings.filter((f) => f.code.startsWith("stop_"));
  for (const f of findings)
    out([LABEL[f.severity], f.code, f.role ?? "-", f.detail ?? ""].join("  ").trimEnd());
  const errors = findings.filter((f) => f.severity === "error").length;
  out(`errors: ${errors}, warnings: ${findings.filter((f) => f.severity === "warning").length}`);
  return errors > 0 ? 1 : 0;
}

// ---- apply ----

/** §6.3 の解除の条件（道具は確かめられないので、人が確かめる）。 */
const REMOVE_CONDITIONS = [
  "解除の条件（§6.3。道具は確かめられない。人が確かめてから --yes を付ける）:",
  "  - 対象のロールの最長のセッション（MaxSessionDuration）が、止めた時刻から切れるまで外さない",
  "  - 原因を除いた（漏れた鍵・侵害された経路の排除）",
  "  - 古い鍵が残っていない（JWKS・プロバイダー）",
  "  - 止めた経路で新しいセッションが作れないことを確かめた",
];

function callerOf(v: unknown): { account: string; arn: string } {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  if (typeof o.Account !== "string" || typeof o.Arn !== "string")
    throw new Error("unexpected response: sts get-caller-identity");
  return { account: o.Account, arn: o.Arn };
}

const sameValues = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

/** 書いたあとに読み直し、予約名の中身が一覧と一致するか（delete なら予約名が無いこと）を確かめる。 */
async function verify(run: AwsRun, s: StopStep, desired: string[]): Promise<void> {
  const name = STOP_USER_INLINE_POLICY_NAME;
  if (s.action === "delete") {
    const got = await run(["iam", "list-role-policies", `--role-name=${s.role}`]);
    const names = (got as { PolicyNames?: unknown }).PolicyNames;
    if (!Array.isArray(names)) throw new Error("unexpected response: list-role-policies");
    if (names.some((n) => typeof n === "string" && n.toLowerCase() === name.toLowerCase()))
      throw new Error("verify: the reserved policy is still there");
    return;
  }
  const got = await run([
    "iam",
    "get-role-policy",
    `--role-name=${s.role}`,
    `--policy-name=${name}`,
  ]);
  const values = stopValues(policyDocument((got as { PolicyDocument?: unknown }).PolicyDocument));
  if (values === undefined || !sameValues(values, desired))
    throw new Error("verify: the reserved policy does not match the list");
}

function printPlan(p: StopPlan, out: (l: string) => void): void {
  for (const s of p.steps)
    out(
      `PLAN  ${pad(s.action, 6)} ${pad(s.role, 32)} ${pad(s.source, 8)} values ${s.before} -> ${s.after}${SOURCE_NOTE[s.source]}`,
    );
  for (const s of p.skipped)
    out(`SKIP  ${s.code}  ${s.role}  （書かない。予約名・インラインを人が見て直し、回し直す）`);
  for (const w of p.warnings) out(`WARN  ${w.code}  -  ${w.detail}`);
  for (const r of p.refusals) out(`REFUSE  ${r.code}  ${r.role ?? "-"}`);
}

export async function runApply(
  c: Common & {
    stops: string[];
    stopsPath: string;
    reason: string;
    yes: boolean;
    allowRemove: boolean;
  },
  deps: StopDeps,
): Promise<number> {
  const out = (line: string) => deps.print(redact(line));
  const snapshot = await readSnapshot(deps.run, c);
  const caller = callerOf(await deps.run(["sts", "get-caller-identity"]));
  const plan = planStop(snapshot, c.config, c.stops, {
    allowRemove: c.allowRemove,
    caller,
    ...(c.inventory !== undefined ? { inventory: c.inventory } : {}),
  });
  const desired = [...new Set(c.stops)];

  out(`account: ${masked(snapshot.accountId)} profile ${c.profile}`);
  out(`direction: ${plan.direction}  values: ${desired.length}`);
  out(
    `caller: ${plan.refusals.some((r) => r.code.startsWith("caller_")) ? "refused" : "ok (not a console role)"}`,
  );
  printPlan(plan, out);
  if (plan.direction === "remove") for (const l of REMOVE_CONDITIONS) out(l);

  const code = planExitCode(plan);
  if (plan.refusals.length > 0) {
    out("何も書かなかった（REFUSE を直してから回し直す）");
    return code;
  }
  const todo = plan.steps.filter((s) => s.action !== "none");
  if (!c.yes) {
    out(
      todo.length === 0
        ? "変更なし"
        : `計画の表示だけ（IAM の読み取りはした）。書き込むには --yes を付ける（${todo.length} ロール）`,
    );
    return code;
  }

  // 書き込み: 止める方向は失敗しても次のロールへ進む（★4）。解除の方向は失敗で止める
  const result = new Map<string, "ok" | "failed" | "not_run">();
  let failed = 0;
  for (const s of todo) {
    if (plan.direction === "remove" && failed > 0) {
      result.set(s.role, "not_run");
      continue;
    }
    try {
      if (s.action === "put")
        await deps.run([
          "iam",
          "put-role-policy",
          `--role-name=${s.role}`,
          `--policy-name=${STOP_USER_INLINE_POLICY_NAME}`,
          `--policy-document=${JSON.stringify(s.document)}`,
        ]);
      else
        await deps.run([
          "iam",
          "delete-role-policy",
          `--role-name=${s.role}`,
          `--policy-name=${STOP_USER_INLINE_POLICY_NAME}`,
        ]);
      await verify(deps.run, s, desired);
      result.set(s.role, "ok");
      out(`done:  ${s.role}  ${s.action}`);
    } catch (e) {
      failed++;
      result.set(s.role, "failed");
      out(`failed:  ${s.role}  ${s.action}  ${(e as Error).message}`);
    }
  }
  const remaining = todo.filter((s) => result.get(s.role) === "not_run").map((s) => s.role);
  if (remaining.length > 0)
    out(
      `remaining:  ${remaining.join(", ")}  （直してから同じ一覧で回し直す。済んだロールは変わらない）`,
    );
  for (const s of plan.skipped) out(`not written:  ${s.role}  ${s.code}`);

  // 記録（§6.3: 付けた時刻・対象・理由。値は入れない。保管は運用者が行う）
  out(
    JSON.stringify({
      event: "awsbridge-console-stop",
      time: deps.now().toISOString(),
      account: masked(snapshot.accountId),
      profile: c.profile,
      direction: plan.direction,
      reason: c.reason,
      values: desired.length,
      roles: [
        ...plan.steps.map((s) => ({
          role: s.role,
          source: s.source,
          action: s.action,
          before: s.before,
          after: s.after,
          result: s.action === "none" ? "unchanged" : result.get(s.role),
        })),
        ...plan.skipped.map((s) => ({ role: s.role, result: "skipped", code: s.code })),
      ],
    }),
  );
  out(
    `次に mise run console:inspect -- --profile=${c.profile} --stops=${c.stopsPath} を回し、全ロールを確かめる`,
  );
  return failed > 0 || plan.skipped.length > 0 ? 1 : 0;
}
