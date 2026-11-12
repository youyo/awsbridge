// 停止の道具の計画（src/console/stop-plan.ts の純粋な関数 planStop）。設計: docs/specs/console-login.md §6.3・§4.8。
// 宣言的: 対象の全ロールの予約名の中身を、停止の一覧にそろえる。cto の決裁（2026-11-13）:
// - 止める方向（値が増える・同じ）では全体を止めない。衝突・容量超えのロールは書かずに報告し（終了コード 1）、ほかのロールには書く
// - パスの外でコンソールのプロバイダーを信頼するロール（設定に無いロール）も、止める方向では書く対象に含める
// - 解除の方向（値が減る）は --allow-remove が要り、衝突・容量超え・設定に無いロールがあれば何も書かずに止める
import { describe, expect, it } from "vitest";
import type { AccountSnapshot, RoleSnapshot } from "../../src/console/inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "../../src/console/reserved";
import {
  INLINE_POLICY_MAX_CHARS,
  planExitCode,
  planStop,
  policySize,
  type StopPlan,
  unlistedRoleNames,
} from "../../src/console/stop-plan";
import { stopPolicyDocument, stopValues } from "../../src/console/stops";
import {
  ACCOUNT,
  goodSnapshot,
  inspectConfig,
  inventory,
  role,
  STD_PROVIDER,
} from "./console-inspect-fixtures";

const A = "user1@example.com";
const B = "user2@example.com";
const RESERVED = STOP_USER_INLINE_POLICY_NAME;
const OPS_CALLER = {
  account: ACCOUNT,
  arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_Ops_0123456789abcdef/${A}`,
};

function plan(
  s: AccountSnapshot,
  stops: string[],
  o: { allowRemove?: boolean; caller?: { account: string; arn: string } } = {},
): StopPlan {
  return planStop(s, inspectConfig(), stops, {
    allowRemove: o.allowRemove ?? false,
    caller: o.caller ?? OPS_CALLER,
    inventory: inventory(),
  });
}

const withStop = (s: AccountSnapshot, name: string, doc: unknown, policyName = RESERVED) =>
  role(s, name).inlinePolicies?.push({ policyName, document: doc });

const step = (p: StopPlan, name: string) => p.steps.find((x) => x.role === name);

/** パスの外で、コンソールの Standard のプロバイダーを信頼する手作りのロール（設定に無い）。 */
function handmade(name = "HandmadeConsoleRole"): RoleSnapshot {
  return {
    roleName: name,
    path: "/",
    arn: `arn:aws:iam::${ACCOUNT}:role/${name}`,
    trustPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: STD_PROVIDER },
          Action: "sts:AssumeRoleWithWebIdentity",
        },
      ],
    },
    attachedPolicies: [],
    inlinePolicies: [],
  };
}

describe("planStop: 対象のロールと差分", () => {
  it("予約名の無いロールには一覧の文書を put する（設定の全ロール。関係の無いロールは対象にしない）", () => {
    const p = plan(goodSnapshot(), [A, B]);
    expect(p.direction).toBe("stop");
    expect(p.refusals).toEqual([]);
    expect(p.skipped).toEqual([]);
    expect(p.steps.map((x) => [x.role, x.source, x.action, x.before, x.after])).toEqual([
      ["FederatedAdministrator", "config", "put", 0, 2],
      ["FederatedViewer", "config", "put", 0, 2],
    ]);
    expect(stopValues(step(p, "FederatedViewer")?.document)).toEqual([A, B]);
    expect(planExitCode(p)).toBe(0);
  });

  it("同じ値の集合なら書かない（書き方の違いは同じとみなす）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([B, A]));
    withStop(s, "FederatedAdministrator", {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: "*",
          Resource: "*",
          Condition: { StringEquals: { "aws:SourceIdentity": A } },
        },
        {
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: { StringEquals: { "aws:SourceIdentity": [B] } },
        },
      ],
    });
    const p = plan(s, [A, B]);
    expect(p.steps.map((x) => x.action)).toEqual(["none", "none"]);
    expect(planExitCode(p)).toBe(0);
  });

  it("値を足すのは止める方向（--allow-remove は要らない）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A]));
    const p = plan(s, [A, B]);
    expect(p.direction).toBe("stop");
    expect(step(p, "FederatedViewer")).toMatchObject({ action: "put", before: 1, after: 2 });
  });

  it("コンソール用のパスにある設定に無いロールも対象（source: path）", () => {
    const s = goodSnapshot();
    s.roles.push({
      ...handmade("ExtraPathRole"),
      path: "/awsbridge-console/std/",
      arn: `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/ExtraPathRole`,
    });
    const p = plan(s, [A]);
    expect(step(p, "ExtraPathRole")).toMatchObject({ source: "path", action: "put" });
  });

  it("値は変えない（小文字にしない）。identity が email のとき大文字を含む値は件数だけ警告する", () => {
    const p = plan(goodSnapshot(), ["User1@Example.com", B]);
    expect(stopValues(step(p, "FederatedViewer")?.document)).toEqual(["User1@Example.com", B]);
    expect(p.warnings).toEqual([{ code: "stops_uppercase", detail: "1" }]);
    expect(JSON.stringify(p.warnings)).not.toContain("User1");
  });

  it("往復の一致: 書く文書は stopValues で一覧と同じ値に戻る", () => {
    const p = plan(goodSnapshot(), [A, B, A]);
    for (const x of p.steps) expect(stopValues(x.document)).toEqual([A, B]);
  });
});

describe("planStop: 止める方向は全体を止めない（cto の決裁 ★4・★5）", () => {
  it("パスの外でコンソールのプロバイダーを信頼するロールは「設定に無いロール」として書く対象に含める", () => {
    const s = goodSnapshot();
    s.roles.push(handmade());
    const p = plan(s, [A]);
    expect(step(p, "HandmadeConsoleRole")).toMatchObject({ source: "unlisted", action: "put" });
    expect(p.refusals).toEqual([]);
    expect(planExitCode(p)).toBe(0);
  });

  it("予約名に停止の形でない文書があるロールは上書きせず報告し、ほかのロールには書く（終了コード 1）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }],
    });
    const p = plan(s, [A]);
    expect(p.refusals).toEqual([]);
    expect(p.skipped).toEqual([{ role: "FederatedViewer", code: "stop_reserved_conflict" }]);
    expect(step(p, "FederatedViewer")).toBeUndefined();
    expect(step(p, "FederatedAdministrator")).toMatchObject({ action: "put" });
    expect(planExitCode(p)).toBe(1);
  });

  it("予約名と大文字小文字だけ違う名前のインラインは触らずに報告する（同じ名前とみなされうるので）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A]), RESERVED.toLowerCase());
    const p = plan(s, [A, B]);
    expect(p.skipped).toEqual([{ role: "FederatedViewer", code: "reserved_name_case" }]);
    expect(step(p, "FederatedAdministrator")).toMatchObject({ action: "put" });
    expect(planExitCode(p)).toBe(1);
  });

  it("インラインの合計（空白を除く）が 10,240 文字を超えるロールは書かずに報告し、ほかのロールには書く", () => {
    const s = goodSnapshot();
    const big = {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "s3:GetObject", Resource: `arn:${"x".repeat(10_100)}` },
      ],
    };
    role(s, "FederatedViewer").inlinePolicies?.push({ policyName: "Big", document: big });
    const p = plan(s, [A]);
    expect(p.skipped).toEqual([{ role: "FederatedViewer", code: "inline_capacity" }]);
    expect(step(p, "FederatedAdministrator")).toMatchObject({ action: "put" });
    expect(planExitCode(p)).toBe(1);
  });

  it("policySize は空白を除いた文字数。上限は 10,240", () => {
    expect(INLINE_POLICY_MAX_CHARS).toBe(10_240);
    expect(policySize({ a: "b c" })).toBe('{"a":"bc"}'.length);
    expect(policySize('{ "a" : 1 }')).toBe('{"a":1}'.length);
  });

  it("unlistedRoleNames: パスの外でコンソールのプロバイダーを信頼する、設定に無いロールの名前（詳細を読み足すため）", () => {
    const s = goodSnapshot();
    const { inlinePolicies: _i, attachedPolicies: _a, ...unread } = handmade();
    s.roles.push(unread);
    expect(unlistedRoleNames(s, inspectConfig(), inventory())).toEqual(["HandmadeConsoleRole"]);
    expect(unlistedRoleNames(goodSnapshot(), inspectConfig(), inventory())).toEqual([]);
  });

  it("詳細を読めていないロール（インラインが未読）は書かずに報告する", () => {
    const s = goodSnapshot();
    const { inlinePolicies: _i, ...unread } = handmade();
    s.roles.push(unread);
    const p = plan(s, [A]);
    expect(p.skipped).toEqual([{ role: "HandmadeConsoleRole", code: "role_unreadable" }]);
    expect(planExitCode(p)).toBe(1);
  });
});

describe("planStop: 解除の方向（値が減る・空の一覧）", () => {
  it("--allow-remove が無ければ拒否（終了コード 2）。何も書かない", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    const p = plan(s, [A]);
    expect(p.direction).toBe("remove");
    expect(p.refusals).toEqual([{ code: "remove_not_allowed", exit: 2 }]);
    expect(planExitCode(p)).toBe(2);
  });

  it("--allow-remove があれば、減らすロールは put、空の一覧なら delete", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    withStop(s, "FederatedAdministrator", stopPolicyDocument([A, B]));
    const p1 = plan(s, [A], { allowRemove: true });
    expect(p1.refusals).toEqual([]);
    expect(step(p1, "FederatedViewer")).toMatchObject({ action: "put", before: 2, after: 1 });
    const p2 = plan(s, [], { allowRemove: true });
    expect(p2.steps.map((x) => [x.role, x.action, x.before, x.after])).toEqual([
      ["FederatedAdministrator", "delete", 2, 0],
      ["FederatedViewer", "delete", 2, 0],
    ]);
    expect(p2.steps.every((x) => x.document === undefined)).toBe(true);
    expect(planExitCode(p2)).toBe(0);
  });

  it("空の一覧で予約名の無いロールは何もしない", () => {
    const p = plan(goodSnapshot(), []);
    expect(p.direction).toBe("stop");
    expect(p.steps.map((x) => x.action)).toEqual(["none", "none"]);
  });

  it("解除の方向では、衝突のロールがあれば何も書かずに止める（終了コード 2）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    withStop(s, "FederatedAdministrator", { Version: "2012-10-17", Statement: [] });
    const p = plan(s, [A], { allowRemove: true });
    expect(p.refusals).toEqual([
      { code: "stop_reserved_conflict", role: "FederatedAdministrator", exit: 2 },
    ]);
    expect(planExitCode(p)).toBe(2);
  });

  it("解除の方向では、設定に無いロールがあれば書かずに警告して止める（終了コード 1）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    s.roles.push(handmade());
    const p = plan(s, [A], { allowRemove: true });
    expect(p.refusals).toEqual([{ code: "unlisted_role", role: "HandmadeConsoleRole", exit: 1 }]);
    expect(planExitCode(p)).toBe(1);
  });
});

describe("planStop: 呼び出し元", () => {
  it.each([
    ["設定のロール", `arn:aws:sts::${ACCOUNT}:assumed-role/FederatedAdministrator/${A}`],
    ["大文字小文字の違い", `arn:aws:sts::${ACCOUNT}:assumed-role/federatedviewer/x`],
  ])("コンソール用のロール（%s）からは実行しない（終了コード 2）", (_n, arn) => {
    const p = plan(goodSnapshot(), [A], { caller: { account: ACCOUNT, arn } });
    expect(p.refusals).toEqual([{ code: "caller_console_role", exit: 2 }]);
    expect(planExitCode(p)).toBe(2);
  });

  it("/awsbridge-console/ のパスのロール（設定に無い）からも実行しない", () => {
    const s = goodSnapshot();
    s.roles.push({
      ...handmade("ExtraPathRole"),
      path: "/awsbridge-console/admin/",
      arn: `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/admin/ExtraPathRole`,
    });
    const p = plan(s, [A], {
      caller: { account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ExtraPathRole/x` },
    });
    expect(p.refusals).toEqual([{ code: "caller_console_role", exit: 2 }]);
  });

  it("呼び出し元のアカウントが読んだアカウントと違えば実行しない", () => {
    const p = plan(goodSnapshot(), [A], {
      caller: { account: "444444444444", arn: "arn:aws:sts::444444444444:assumed-role/Ops/x" },
    });
    expect(p.refusals).toEqual([{ code: "caller_account_mismatch", exit: 2 }]);
  });

  it("IAM ユーザーやコンソール用でないロールからは実行できる", () => {
    for (const arn of [
      `arn:aws:iam::${ACCOUNT}:user/ops`,
      `arn:aws:sts::${ACCOUNT}:assumed-role/OrganizationAccountAccessRole/x`,
    ])
      expect(plan(goodSnapshot(), [A], { caller: { account: ACCOUNT, arn } }).refusals).toEqual([]);
  });
});
