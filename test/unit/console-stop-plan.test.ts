// 停止の道具の計画（src/console/stop-plan.ts の純粋な関数 planStop）。設計: docs/specs/console-login.md §6.3・§4.8。
// cto の決裁（2026-11-13 の ★4・★5）と司令塔の判断（同日。値ごとに方向を分ける）:
// - --allow-remove が無ければ「足すだけ」: 各ロールの予約名を (今の値 ∪ 一覧の値) にする。一覧に無い値は消さず、余分の件数を報告する
// - --allow-remove があれば一覧にそろえる。足す書き込みを全ロールで先に行い、外す書き込みはそのあと（外す側の失敗で足す側が止まらない）
// - どちらでも全体を止めない。衝突・容量超え・未読のロールは書かずに報告し（終了コード 1）、ほかのロールには書く
// - パスの外でコンソールのプロバイダーを信頼するロール（設定に無いロール）も対象（足すときも外すときも）
// - 足す値が 1 つも無く外す値だけがある実行（解除だけ）は、--allow-remove が無ければ拒否（終了コード 2）
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
/** ロールの書き込みの要約（段階・種類・書いたあとの値）。 */
const writesOf = (p: StopPlan, name: string) =>
  step(p, name)?.writes.map((w) => [w.phase, w.action, w.values]);

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

describe("planStop: 足すだけ（--allow-remove なし）", () => {
  it("予約名の無いロールには一覧の文書を put する（設定の全ロール。関係の無いロールは対象にしない）", () => {
    const p = plan(goodSnapshot(), [A, B]);
    expect(p.mode).toBe("add");
    expect(p.refusals).toEqual([]);
    expect(p.skipped).toEqual([]);
    expect(p.steps.map((x) => [x.role, x.source, x.before, x.after, x.added, x.extra])).toEqual([
      ["FederatedAdministrator", "config", 0, 2, 2, 0],
      ["FederatedViewer", "config", 0, 2, 2, 0],
    ]);
    expect(writesOf(p, "FederatedViewer")).toEqual([["add", "put", [A, B]]]);
    expect(stopValues(step(p, "FederatedViewer")?.writes[0]?.document)).toEqual([A, B]);
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
    expect(p.steps.map((x) => x.writes)).toEqual([[], []]);
    expect(planExitCode(p)).toBe(0);
  });

  it("ロールに [A, old]・一覧 [A, B]: そのロールは [A, old, B]、ほかのロールにも B。余分 1 件を報告し、終了コード 0", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, "old@example.com"]));
    const p = plan(s, [A, B]);
    expect(p.refusals).toEqual([]);
    expect(writesOf(p, "FederatedViewer")).toEqual([["add", "put", [A, "old@example.com", B]]]);
    expect(step(p, "FederatedViewer")).toMatchObject({ before: 2, after: 3, added: 1, extra: 1 });
    expect(writesOf(p, "FederatedAdministrator")).toEqual([["add", "put", [A, B]]]);
    expect(planExitCode(p)).toBe(0);
  });

  it("足す値が 1 つも無く、外す値だけがある（解除だけ）なら拒否（終了コード 2）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    withStop(s, "FederatedAdministrator", stopPolicyDocument([A]));
    const p = plan(s, [A]);
    expect(p.refusals).toEqual([{ code: "remove_not_allowed", exit: 2 }]);
    expect(planExitCode(p)).toBe(2);
    const empty = plan(s, []);
    expect(empty.refusals).toEqual([{ code: "remove_not_allowed", exit: 2 }]);
  });

  it("空の一覧で予約名の無いロールは何もしない", () => {
    const p = plan(goodSnapshot(), []);
    expect(p.refusals).toEqual([]);
    expect(p.steps.map((x) => x.writes)).toEqual([[], []]);
    expect(planExitCode(p)).toBe(0);
  });

  it("コンソール用のパスにある設定に無いロールも対象（source: path）", () => {
    const s = goodSnapshot();
    s.roles.push({
      ...handmade("ExtraPathRole"),
      path: "/awsbridge-console/std/",
      arn: `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/ExtraPathRole`,
    });
    const p = plan(s, [A]);
    expect(step(p, "ExtraPathRole")?.source).toBe("path");
    expect(writesOf(p, "ExtraPathRole")).toEqual([["add", "put", [A]]]);
  });

  it("値は変えない（小文字にしない）。identity が email のとき大文字を含む値は件数だけ警告する", () => {
    const p = plan(goodSnapshot(), ["User1@Example.com", B]);
    expect(writesOf(p, "FederatedViewer")).toEqual([["add", "put", ["User1@Example.com", B]]]);
    expect(p.warnings).toEqual([{ code: "stops_uppercase", detail: "1" }]);
    expect(JSON.stringify(p.warnings)).not.toContain("User1");
  });

  it("往復の一致: 書く文書は stopValues で書いたあとの値に戻る", () => {
    const p = plan(goodSnapshot(), [A, B, A]);
    for (const x of p.steps)
      for (const w of x.writes) expect(stopValues(w.document)).toEqual(w.values);
  });
});

describe("planStop: 全体を止めない（cto の決裁 ★4・★5）", () => {
  it("パスの外でコンソールのプロバイダーを信頼するロールは「設定に無いロール」として書く対象に含める", () => {
    const s = goodSnapshot();
    s.roles.push(handmade());
    const p = plan(s, [A]);
    expect(step(p, "HandmadeConsoleRole")?.source).toBe("unlisted");
    expect(writesOf(p, "HandmadeConsoleRole")).toEqual([["add", "put", [A]]]);
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
    expect(writesOf(p, "FederatedAdministrator")).toEqual([["add", "put", [A]]]);
    expect(planExitCode(p)).toBe(1);
  });

  it("予約名と大文字小文字だけ違う名前のインラインは触らずに報告する（同じ名前とみなされうるので）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A]), RESERVED.toLowerCase());
    const p = plan(s, [A, B]);
    expect(p.skipped).toEqual([{ role: "FederatedViewer", code: "reserved_name_case" }]);
    expect(writesOf(p, "FederatedAdministrator")).toEqual([["add", "put", [A, B]]]);
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
    expect(writesOf(p, "FederatedAdministrator")).toEqual([["add", "put", [A]]]);
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

describe("planStop: 一覧にそろえる（--allow-remove あり）", () => {
  it("ロールに [A, old]・一覧 [A, B]: 先に [A, old, B] を足し、そのあと [A, B] に外す", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, "old@example.com"]));
    const p = plan(s, [A, B], { allowRemove: true });
    expect(p.mode).toBe("sync");
    expect(p.refusals).toEqual([]);
    expect(writesOf(p, "FederatedViewer")).toEqual([
      ["add", "put", [A, "old@example.com", B]],
      ["remove", "put", [A, B]],
    ]);
    expect(step(p, "FederatedViewer")).toMatchObject({ before: 2, after: 2, added: 1, extra: 1 });
    expect(writesOf(p, "FederatedAdministrator")).toEqual([["add", "put", [A, B]]]);
    expect(planExitCode(p)).toBe(0);
  });

  it("外すだけのロールは remove の段階だけ。空の一覧なら delete", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    withStop(s, "FederatedAdministrator", stopPolicyDocument([A, B]));
    const p1 = plan(s, [A], { allowRemove: true });
    expect(writesOf(p1, "FederatedViewer")).toEqual([["remove", "put", [A]]]);
    const p2 = plan(s, [], { allowRemove: true });
    expect(p2.steps.map((x) => [x.role, x.before, x.after])).toEqual([
      ["FederatedAdministrator", 2, 0],
      ["FederatedViewer", 2, 0],
    ]);
    expect(writesOf(p2, "FederatedViewer")).toEqual([["remove", "delete", []]]);
    expect(p2.steps.every((x) => x.writes.every((w) => w.document === undefined))).toBe(true);
    expect(planExitCode(p2)).toBe(0);
  });

  it("設定に無いロール（パスの外で信頼）からも外す（source: unlisted）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    s.roles.push({
      ...handmade(),
      inlinePolicies: [{ policyName: RESERVED, document: stopPolicyDocument([A, B]) }],
    });
    const p = plan(s, [A], { allowRemove: true });
    expect(p.refusals).toEqual([]);
    expect(step(p, "HandmadeConsoleRole")?.source).toBe("unlisted");
    expect(writesOf(p, "HandmadeConsoleRole")).toEqual([["remove", "put", [A]]]);
  });

  it("衝突のロールは触らずに報告し、ほかのロールは外す（全体を止めない。終了コード 1）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopPolicyDocument([A, B]));
    withStop(s, "FederatedAdministrator", { Version: "2012-10-17", Statement: [] });
    const p = plan(s, [A], { allowRemove: true });
    expect(p.refusals).toEqual([]);
    expect(p.skipped).toEqual([{ role: "FederatedAdministrator", code: "stop_reserved_conflict" }]);
    expect(writesOf(p, "FederatedViewer")).toEqual([["remove", "put", [A]]]);
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
