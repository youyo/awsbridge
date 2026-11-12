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
  type StopWrite,
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

/** 書いたあとに読み直し、予約名の中身が書いた値と一致するか（delete なら予約名が無いこと）を確かめる。 */
async function verify(run: AwsRun, role: string, w: StopWrite): Promise<void> {
  const name = STOP_USER_INLINE_POLICY_NAME;
  if (w.action === "delete") {
    const got = await run(["iam", "list-role-policies", `--role-name=${role}`]);
    const names = (got as { PolicyNames?: unknown }).PolicyNames;
    if (!Array.isArray(names)) throw new Error("unexpected response: list-role-policies");
    if (names.some((n) => typeof n === "string" && n.toLowerCase() === name.toLowerCase()))
      throw new Error("verify: the reserved policy is still there");
    return;
  }
  const got = await run(["iam", "get-role-policy", `--role-name=${role}`, `--policy-name=${name}`]);
  const values = stopValues(policyDocument((got as { PolicyDocument?: unknown }).PolicyDocument));
  if (values === undefined || !sameValues(values, w.values))
    throw new Error("verify: the reserved policy does not match what was written");
}

async function write(run: AwsRun, role: string, w: StopWrite): Promise<void> {
  const base = [`--role-name=${role}`, `--policy-name=${STOP_USER_INLINE_POLICY_NAME}`];
  if (w.action === "put")
    await run([
      "iam",
      "put-role-policy",
      ...base,
      `--policy-document=${JSON.stringify(w.document)}`,
    ]);
  else await run(["iam", "delete-role-policy", ...base]);
  await verify(run, role, w);
}

const writesText = (s: StopStep) =>
  s.writes.length === 0 ? "none" : s.writes.map((w) => `${w.phase}:${w.action}`).join(",");

function printPlan(p: StopPlan, out: (l: string) => void): void {
  for (const s of p.steps)
    out(
      `PLAN  ${pad(s.role, 32)} ${pad(s.source, 8)} values ${s.before} -> ${s.after}  add ${s.added}  extra ${s.extra}  writes ${writesText(s)}${SOURCE_NOTE[s.source]}`,
    );
  if (p.mode === "add")
    for (const s of p.steps.filter((x) => x.extra > 0))
      out(
        `EXTRA  ${s.role}  ${s.extra}  （一覧に無い値。消さない。外すには --allow-remove を付ける）`,
      );
  for (const s of p.skipped)
    out(`SKIP  ${s.code}  ${s.role}  （書かない。予約名・インラインを人が見て直し、回し直す）`);
  for (const w of p.warnings) out(`WARN  ${w.code}  -  ${w.detail}`);
  for (const r of p.refusals) out(`REFUSE  ${r.code}`);
}

type WriteResult = "ok" | "failed" | "not_run";

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
  out(
    `mode: ${plan.mode}（${plan.mode === "add" ? "足すだけ。一覧に無い値は消さない" : "一覧にそろえる。足してから外す"}）  values: ${desired.length}`,
  );
  out(
    `caller: ${plan.refusals.some((r) => r.code.startsWith("caller_")) ? "refused" : "ok (not a console role)"}`,
  );
  printPlan(plan, out);
  if (plan.steps.some((s) => s.writes.some((w) => w.phase === "remove")))
    for (const l of REMOVE_CONDITIONS) out(l);

  const code = planExitCode(plan);
  if (plan.refusals.length > 0) {
    out("何も書かなかった（REFUSE を直してから回し直す）");
    return code;
  }
  const todo = plan.steps.filter((s) => s.writes.length > 0);
  if (!c.yes) {
    out(
      todo.length === 0
        ? "変更なし"
        : `計画の表示だけ（IAM の読み取りはした）。書き込むには --yes を付ける（${todo.length} ロール）`,
    );
    return code;
  }

  // 書き込み: 足す段階を全ロールで先に行い、外す段階はそのあと。どちらも 1 つのロールの失敗で全体を止めない（★4）。
  // 足す段階で失敗したロールは、外す段階を行わない
  const results = new Map<string, Map<StopWrite["phase"], WriteResult>>();
  const setResult = (role: string, phase: StopWrite["phase"], r: WriteResult) =>
    results.set(role, (results.get(role) ?? new Map()).set(phase, r));
  let failed = 0;
  for (const phase of ["add", "remove"] as const)
    for (const s of todo)
      for (const w of s.writes.filter((x) => x.phase === phase)) {
        if (phase === "remove" && results.get(s.role)?.get("add") === "failed") {
          setResult(s.role, phase, "not_run");
          out(`not run:  ${s.role}  remove  （足す段階が失敗したので外さない）`);
          continue;
        }
        try {
          await write(deps.run, s.role, w);
          setResult(s.role, phase, "ok");
          out(`done:  ${s.role}  ${phase}  ${w.action}`);
        } catch (e) {
          failed++;
          setResult(s.role, phase, "failed");
          out(`failed:  ${s.role}  ${phase}  ${w.action}  ${(e as Error).message}`);
        }
      }
  for (const s of plan.skipped) out(`not written:  ${s.role}  ${s.code}`);

  // 記録（§6.3: 付けた時刻・対象・理由。値は入れない。保管は運用者が行う）
  out(
    JSON.stringify({
      event: "awsbridge-console-stop",
      time: deps.now().toISOString(),
      account: masked(snapshot.accountId),
      profile: c.profile,
      mode: plan.mode,
      reason: c.reason,
      values: desired.length,
      roles: [
        ...plan.steps.map((s) => ({
          role: s.role,
          source: s.source,
          before: s.before,
          after: s.after,
          added: s.added,
          extra: s.extra,
          writes: s.writes.map((w) => ({
            phase: w.phase,
            action: w.action,
            result: results.get(s.role)?.get(w.phase),
          })),
        })),
        ...plan.skipped.map((s) => ({ role: s.role, result: "skipped", code: s.code })),
      ],
    }),
  );
  out(
    `次に mise run console:inspect -- --profile=${c.profile} --stops=${c.stopsPath} を回す。` +
      "console:inspect --stops は設定のロールを確かめる。設定に無いロールとパスの外のロールは、この道具の読み直しで確かめた（結果は上の表）",
  );
  return failed > 0 || plan.skipped.length > 0 ? 1 : 0;
}
