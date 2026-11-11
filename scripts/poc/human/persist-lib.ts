// (4-a) CloudFormation の外で付けたインラインポリシー（AWSRevokeOlderSessions・AwsbridgeDenySourceIdentity）が、
// スタックの更新のあとも残るか・ドリフト検出でどう見えるか（persist.ts）の純粋関数。I/O は呼び出し側で行う。
// 出力は README に貼れるよう、ポリシーの本文（email・アカウント ID を含む）は出さず、名前・場所・種類だけにする。
import { markdownTable } from "./cases";
import type { RoleKey } from "./lib";
import { maskSensitive } from "./ops";

/** aws iam list-role-policies --output json の出力からポリシー名を取る。 */
export function parseRolePolicyNames(json: string): string[] {
  const v = JSON.parse(json) as { PolicyNames?: unknown };
  return Array.isArray(v?.PolicyNames)
    ? v.PolicyNames.filter((n): n is string => typeof n === "string")
    : [];
}

export interface RoleInlinePolicies {
  role: RoleKey;
  roleName: string;
  policyNames: string[];
}

export interface InlinePolicyReport {
  rows: RoleInlinePolicies[];
  expected: string[];
  /** 期待を確かめるロール（out-of-band のポリシーを付けたロール） */
  target: RoleKey;
  /** target のロールに無い、期待したポリシー */
  missing: string[];
}

export function inlinePolicyReport(
  rows: RoleInlinePolicies[],
  expected: string[],
  target: RoleKey,
): InlinePolicyReport {
  const have = rows.find((r) => r.role === target)?.policyNames ?? [];
  return { rows, expected, target, missing: expected.filter((p) => !have.includes(p)) };
}

export function formatInlinePolicyReport(r: InlinePolicyReport): string {
  const table = markdownTable(
    ["ロール", "名前", "インラインポリシー"],
    r.rows.map((row) => [
      row.role,
      row.roleName,
      row.policyNames.length === 0 ? "（なし）" : row.policyNames.join(", "),
    ]),
  );
  if (r.expected.length === 0) return table;
  const verdict =
    r.missing.length === 0
      ? `判定: ${r.target} のロールに ${r.expected.join(", ")} はすべて残っている`
      : `判定: ${r.target} のロールから消えた: ${r.missing.join(", ")}`;
  return `${table}\n\n${verdict}`;
}

// ---- ドリフト検出 ----

export interface DriftDetection {
  status: string;
  stackDriftStatus: string | undefined;
  driftedCount: number | undefined;
  reason?: string | undefined;
}

/** describe-stack-drift-detection-status --output json の出力を読む。 */
export function parseDriftDetection(json: string): DriftDetection {
  const v = JSON.parse(json) as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  return {
    status: str("DetectionStatus") ?? "UNKNOWN",
    stackDriftStatus: str("StackDriftStatus"),
    driftedCount:
      typeof v.DriftedStackResourceCount === "number" ? v.DriftedStackResourceCount : undefined,
    reason: str("DetectionStatusReason"),
  };
}

export interface ResourceDiff {
  path: string;
  type: string;
  /** 差分の値が { PolicyName, ... } のときのポリシー名（インラインポリシーの追加・削除を見分ける） */
  policyName?: string;
}

export interface ResourceDrift {
  logicalId: string;
  type: string;
  status: string;
  differences: ResourceDiff[];
}

function policyNameOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const v = JSON.parse(value) as { PolicyName?: unknown };
    return typeof v?.PolicyName === "string" ? v.PolicyName : undefined;
  } catch {
    return undefined;
  }
}

/** describe-stack-resource-drifts --output json の出力から、論理 ID・状態・差分の場所と種類（とポリシー名）だけを取る。 */
export function parseResourceDrifts(json: string): ResourceDrift[] {
  const v = JSON.parse(json) as { StackResourceDrifts?: unknown };
  if (!Array.isArray(v?.StackResourceDrifts)) return [];
  return (v.StackResourceDrifts as Record<string, unknown>[]).map((d) => {
    const diffs = Array.isArray(d.PropertyDifferences)
      ? (d.PropertyDifferences as Record<string, unknown>[])
      : [];
    return {
      logicalId: String(d.LogicalResourceId ?? ""),
      type: String(d.ResourceType ?? ""),
      status: String(d.StackResourceDriftStatus ?? ""),
      differences: diffs.map((p) => {
        const name = policyNameOf(p.ActualValue) ?? policyNameOf(p.ExpectedValue);
        const diff: ResourceDiff = {
          path: String(p.PropertyPath ?? ""),
          type: String(p.DifferenceType ?? ""),
        };
        if (name !== undefined) diff.policyName = name;
        return diff;
      }),
    };
  });
}

export function formatDriftReport(d: DriftDetection, rows: ResourceDrift[]): string {
  const head =
    `検出: ${d.status}  スタック: ${d.stackDriftStatus ?? "-"}  ずれたリソース: ${d.driftedCount ?? "-"}` +
    (d.reason ? `  理由: ${d.reason}` : "");
  const table = markdownTable(
    ["論理 ID", "種類", "状態", "差分（場所 種類）"],
    rows.map((r) => [
      r.logicalId,
      r.type,
      r.status,
      r.differences.length === 0
        ? "-"
        : r.differences
            .map((x) => `${x.path} ${x.type}${x.policyName ? `（${x.policyName}）` : ""}`)
            .join("; "),
    ]),
  );
  return maskSensitive(`${head}\n\n${table}`);
}
