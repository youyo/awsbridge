// 検査の道具の判定（src/console/inspect.ts）。設計: docs/specs/console-login.md §4.8・§4.9・§6.3。
// 信頼ポリシーは承認済みの厳格な形だけを許す許可リスト方式。回避の形を集めた材料がすべて違反になり、生成器の出力は通ることを確かめる。
import { describe, expect, it } from "vitest";
import { guardPolicyDocument } from "../../src/console/guard";
import {
  type AccountSnapshot,
  type Finding,
  formatReport,
  inspectAccount,
} from "../../src/console/inspect";
import { STOP_USER_INLINE_POLICY_NAME } from "../../src/console/reserved";
import type { Json } from "./cfn";
import {
  ACCOUNT,
  ADMIN_GUARD,
  ADMIN_PROVIDER,
  goodSnapshot,
  guardDocument,
  HOST,
  inspectConfig,
  inventory,
  MCP_PROVIDER,
  role,
  SIGNING_ACCOUNT,
  STD_GUARD,
  STD_PROVIDER,
} from "./console-inspect-fixtures";

function run(s: AccountSnapshot, stops?: string[]): Finding[] {
  return inspectAccount({
    config: inspectConfig(),
    snapshot: s,
    inventory: inventory(),
    ...(stops ? { stops } : {}),
  }).findings;
}

const errors = (f: Finding[]) => f.filter((x) => x.severity === "error");
const codesOf = (f: Finding[], roleName?: string) =>
  errors(f)
    .filter((x) => roleName === undefined || x.role === roleName)
    .map((x) => x.code);

describe("信頼ポリシー（許可リスト方式）", () => {
  it("最初の Red: 2 つ目の Allow 文に StringLikeIfExists がある信頼ポリシーは違反", () => {
    const s = goodSnapshot();
    const r = role(s, "FederatedViewer");
    const doc = r.trustPolicy as Json;
    doc.Statement.push({
      Effect: "Allow",
      Principal: { Federated: doc.Statement[0].Principal.Federated },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: { StringLikeIfExists: { "aws:RequestTag/awsbridge_team": "*" } },
    });
    expect(codesOf(run(s), "FederatedViewer")).toContain("trust_allow_extra");
  });

  it("正しい形（生成器の出力と base.yaml の部品）は誤りも警告もない", () => {
    const f = run(goodSnapshot());
    expect(f.filter((x) => x.severity !== "note")).toEqual([]);
  });

  // 回避の形: 1 つの Allow 文の中の書き換え・文の追加。[名前, 書き換え, 期待する誤りの種別]
  type Mutate = (st: Json, doc: Json) => void;
  const CORPUS: [string, Mutate, string][] = [
    [
      "余分な Principal（AWS のアカウント）",
      (st) => {
        st.Principal.AWS = "arn:aws:iam::111111111111:root";
      },
      "trust_principal",
    ],
    [
      "Principal にサービス",
      (st) => {
        st.Principal.Service = "lambda.amazonaws.com";
      },
      "trust_principal",
    ],
    [
      "Federated に MCP 用のプロバイダーを足す",
      (st) => {
        st.Principal.Federated = [st.Principal.Federated, MCP_PROVIDER];
      },
      "trust_principal",
    ],
    [
      "Federated が別の階層（Admin）のプロバイダー",
      (st) => {
        st.Principal.Federated = ADMIN_PROVIDER;
      },
      "trust_principal",
    ],
    [
      "Principal が *",
      (st) => {
        st.Principal = "*";
      },
      "trust_principal",
    ],
    [
      "NotPrincipal を足す",
      (st) => {
        st.NotPrincipal = { AWS: "arn:aws:iam::111111111111:root" };
      },
      "trust_statement_key",
    ],
    [
      "2 つ目の Allow（同じ形）",
      (st, doc) => {
        doc.Statement.push(structuredClone(st));
      },
      "trust_allow_extra",
    ],
    [
      "2 つ目の Allow（条件を空にしたもの）",
      (st, doc) => {
        doc.Statement = [st, { ...structuredClone(st), Condition: {} }];
      },
      "trust_allow_extra",
    ],
    [
      "チームの条件を StringEqualsIfExists に",
      (st) => {
        const c = st.Condition;
        c.StringEqualsIfExists = {
          "aws:RequestTag/awsbridge_team": c.StringEquals["aws:RequestTag/awsbridge_team"],
        };
        delete c.StringEquals["aws:RequestTag/awsbridge_team"];
      },
      "trust_condition_operator",
    ],
    [
      "チームの条件を StringLike のワイルドカードに",
      (st) => {
        const c = st.Condition;
        c.StringLike = { "aws:RequestTag/awsbridge_team": "*" };
        delete c.StringEquals["aws:RequestTag/awsbridge_team"];
      },
      "trust_condition_operator",
    ],
    [
      "Null（SourceIdentity 必須）の欠落",
      (st) => {
        delete st.Condition.Null;
      },
      "trust_source_identity",
    ],
    [
      "Null の値を true に",
      (st) => {
        st.Condition.Null["sts:SourceIdentity"] = "true";
      },
      "trust_source_identity",
    ],
    [
      "ForAllValues を ForAnyValue に",
      (st) => {
        const c = st.Condition;
        c["ForAnyValue:StringEquals"] = c["ForAllValues:StringEquals"];
        delete c["ForAllValues:StringEquals"];
      },
      "trust_condition_operator",
    ],
    [
      "aws:TagKeys の値を足す",
      (st) => {
        st.Condition["ForAllValues:StringEquals"]["aws:TagKeys"] = ["awsbridge_team", "other"];
      },
      "trust_tag_keys",
    ],
    [
      "aud の値を足す",
      (st) => {
        st.Condition.StringEquals[`${HOST}/standard:aud`] = ["awsbridge-console", "awsbridge"];
      },
      "trust_aud",
    ],
    [
      "aud の条件キーが別の階層の issuer",
      (st) => {
        const e = st.Condition.StringEquals;
        e[`${HOST}/admin:aud`] = e[`${HOST}/standard:aud`];
        delete e[`${HOST}/standard:aud`];
      },
      "trust_aud",
    ],
    [
      "チームのタグの値を足す（その種類で割り当てていないチーム）",
      (st) => {
        st.Condition.StringEquals["aws:RequestTag/awsbridge_team"] = ["sa", "infra", "dev"];
      },
      "trust_team",
    ],
    [
      "チームのタグの値に別の階層のチーム",
      (st) => {
        st.Condition.StringEquals["aws:RequestTag/awsbridge_team"] = ["infra-elevated"];
      },
      "trust_team",
    ],
    [
      "StringEquals に余分な条件キー",
      (st) => {
        st.Condition.StringEquals["aws:RequestTag/other"] = "x";
      },
      "trust_condition_key",
    ],
    [
      "Action に sts:AssumeRole を足す",
      (st) => {
        st.Action = [...st.Action, "sts:AssumeRole"];
      },
      "trust_action",
    ],
    [
      "Action のワイルドカード sts:*",
      (st) => {
        st.Action = "sts:*";
      },
      "trust_action",
    ],
    [
      "Condition を外す",
      (st) => {
        delete st.Condition;
      },
      "trust_condition_operator",
    ],
    [
      "Version が 2008-10-17",
      (_st, doc) => {
        doc.Version = "2008-10-17";
      },
      "trust_version",
    ],
  ];

  it.each([
    ["文書がオブジェクトでない（読めなかった文字列）", "%7B%22broken", "trust_parse"],
    [
      "Effect が Allow でも Deny でもない",
      { Version: "2012-10-17", Statement: [{ Effect: "allow" }] },
      "trust_effect",
    ],
    ["最上位に余分なキー", "extra-top", "trust_top_key"],
  ])("形の誤り（読み違いで通さない）: %s", (_name, doc, code) => {
    const s = goodSnapshot();
    const r = role(s, "FederatedViewer");
    if (doc === "extra-top") (r.trustPolicy as Json).Statement2 = [];
    else r.trustPolicy = doc;
    expect(codesOf(run(s), "FederatedViewer")).toContain(code);
  });

  it.each([
    ["attachedPolicies", "attached"],
    ["inlinePolicies", "inline"],
  ] as const)(
    "ロールの %s を読めていなければ違反（確かめられないものを通さない）",
    (key, detail) => {
      const s = goodSnapshot();
      delete role(s, "FederatedViewer")[key];
      expect(errors(run(s))).toContainEqual(
        expect.objectContaining({ code: "role_unreadable", role: "FederatedViewer", detail }),
      );
    },
  );

  it.each(CORPUS)("回避の形: %s → 違反", (_name, mutate, code) => {
    const s = goodSnapshot();
    const doc = role(s, "FederatedViewer").trustPolicy as Json;
    mutate(doc.Statement[0], doc);
    expect(codesOf(run(s), "FederatedViewer")).toContain(code);
  });

  it("Deny の文はあってよい（条件つきで、承認済みの形と重ならないもの）", () => {
    const s = goodSnapshot();
    const doc = role(s, "FederatedViewer").trustPolicy as Json;
    doc.Statement.push({
      Effect: "Deny",
      Principal: "*",
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: { StringEquals: { "aws:RequestTag/awsbridge_team": "sa" } },
    });
    const f = run(s);
    expect(errors(f)).toEqual([]);
    // 常に偽かは判定しきれないので、人が見る警告にする
    expect(f.filter((x) => x.severity === "warning").map((x) => x.code)).toEqual([
      "trust_deny_review",
    ]);
  });

  it("正常性: 条件のない Deny（常に効く）は強すぎる Deny として誤り", () => {
    const s = goodSnapshot();
    const doc = role(s, "FederatedViewer").trustPolicy as Json;
    doc.Statement.push({ Effect: "Deny", Principal: "*", Action: "sts:*" });
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["trust_deny_always"]);
  });

  it("正常性: 承認済みの Allow の条件と同じ条件の Deny も常に効くので誤り", () => {
    const s = goodSnapshot();
    const doc = role(s, "FederatedViewer").trustPolicy as Json;
    doc.Statement.push({
      Effect: "Deny",
      Principal: { Federated: STD_PROVIDER },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: { Null: { "sts:SourceIdentity": "false" } },
    });
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["trust_deny_always"]);
  });

  it("正常性: Allow が無い（だれも入れない）", () => {
    const s = goodSnapshot();
    (role(s, "FederatedViewer").trustPolicy as Json).Statement = [];
    expect(codesOf(run(s), "FederatedViewer")).toContain("trust_allow_missing");
  });

  it("正常性: その種類で割り当てたチームの一部が信頼ポリシーに無いのは警告", () => {
    const s = goodSnapshot();
    const st = (role(s, "FederatedViewer").trustPolicy as Json).Statement[0];
    st.Condition.StringEquals["aws:RequestTag/awsbridge_team"] = "sa";
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning").map((x) => x.code)).toEqual([
      "trust_team_missing",
    ]);
  });

  it("IAM が 1 要素の配列を文字列で返しても（同じ意味なので）通る", () => {
    const s = goodSnapshot();
    const doc = role(s, "FederatedViewer").trustPolicy as Json;
    const st = doc.Statement[0];
    doc.Statement = st;
    st.Principal.Federated = [st.Principal.Federated];
    st.Condition["ForAllValues:StringEquals"]["aws:TagKeys"] = "awsbridge_team";
    st.Condition.Null["sts:SourceIdentity"] = ["false"];
    st.Action = [...st.Action].reverse();
    expect(run(s).filter((x) => x.severity !== "note")).toEqual([]);
  });

  it("Admin のロール: Standard のプロバイダーを信頼していれば違反", () => {
    const s = goodSnapshot();
    const st = (role(s, "FederatedAdministrator").trustPolicy as Json).Statement[0];
    st.Principal.Federated = STD_PROVIDER;
    expect(codesOf(run(s), "FederatedAdministrator")).toContain("trust_principal");
  });
});

describe("パス", () => {
  it.each([
    ["/", "パスなし"],
    ["/awsbridge-console/admin/", "別の階層のパス"],
    ["/awsbridge-console/std/x/", "下の階層"],
  ])("%s（%s）は違反", (path) => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").path = path;
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["path_mismatch"]);
  });
});

describe("守りの部品", () => {
  it("部品の守りの文書（src/console/guard.ts）は base.yaml の部品と同じ", () => {
    for (const [tier, id] of [
      ["standard", "StandardGuardPolicy"],
      ["admin", "AdminGuardPolicy"],
    ] as const) {
      expect(
        guardPolicyDocument(tier, { partition: "aws", accountId: ACCOUNT, issuerHost: HOST }),
        tier,
      ).toEqual(guardDocument(id));
    }
  });

  it("部品の欠落は違反", () => {
    const s = goodSnapshot();
    const r = role(s, "FederatedViewer");
    r.attachedPolicies = (r.attachedPolicies ?? []).filter((p) => p.policyArn !== STD_GUARD);
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["guard_missing"]);
  });

  it("同じ名前でも別のパスの顧客管理ポリシーは部品ではない", () => {
    const s = goodSnapshot();
    const fake = STD_GUARD.replace("policy/awsbridge-console/", "policy/");
    const r = role(s, "FederatedViewer");
    r.attachedPolicies = (r.attachedPolicies ?? []).map((p) =>
      p.policyArn === STD_GUARD ? { ...p, policyArn: fake } : p,
    );
    s.managedPolicies.push({
      arn: fake,
      defaultVersionId: "v1",
      document: guardDocument("StandardGuardPolicy"),
    });
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["guard_missing"]);
  });

  it("部品の版の差し替え（既定の版の中身が上流の形と違う）は違反", () => {
    const s = goodSnapshot();
    const p = s.managedPolicies.find((x) => x.arn === STD_GUARD);
    if (!p) throw new Error("no guard");
    p.defaultVersionId = "v2";
    (p.document as Json).Statement = (p.document as Json).Statement.filter(
      (st: Json) => st.Sid !== "DenyConsoleRoleWrites",
    );
    const f = run(s);
    expect(codesOf(f, "FederatedViewer")).toEqual(["guard_version_mismatch"]);
    expect(errors(f).find((x) => x.code === "guard_version_mismatch")?.detail).toContain("v2");
  });

  it("部品の文の Action を 1 つ減らしても違反", () => {
    const s = goodSnapshot();
    const p = s.managedPolicies.find((x) => x.arn === ADMIN_GUARD);
    const st = (p?.document as Json).Statement.find((x: Json) => x.Sid === "DenyAwsLoginRemote");
    st.Action = ["signin:AuthorizeOAuth2Access"];
    expect(codesOf(run(s), "FederatedAdministrator")).toEqual(["guard_version_mismatch"]);
  });

  it("部品の文書を読めていなければ違反（中身を確かめられない）", () => {
    const s = goodSnapshot();
    s.managedPolicies = s.managedPolicies.filter((x) => x.arn !== STD_GUARD);
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["guard_unreadable"]);
  });

  it("Admin のロールに Standard の部品だけでは違反（Admin の部品が要る）", () => {
    const s = goodSnapshot();
    const r = role(s, "FederatedAdministrator");
    r.attachedPolicies = (r.attachedPolicies ?? []).map((p) =>
      p.policyArn === ADMIN_GUARD ? { policyName: "x", policyArn: STD_GUARD } : p,
    );
    expect(codesOf(run(s), "FederatedAdministrator")).toEqual(["guard_missing"]);
  });

  it("Standard のロールに Admin の部品も付いていれば警告（remote の Deny で aws login --remote が使えない）", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").attachedPolicies?.push({ policyName: "x", policyArn: ADMIN_GUARD });
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning").map((x) => x.code)).toEqual([
      "guard_other_tier",
    ]);
  });
});

const STOP = STOP_USER_INLINE_POLICY_NAME;
const stopDoc = (values: string[]) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyBySourceIdentity",
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: { StringEquals: { "aws:SourceIdentity": values } },
    },
  ],
});
const withStop = (s: AccountSnapshot, name: string, doc: unknown) =>
  role(s, name).inlinePolicies?.push({ policyName: STOP, document: doc });

describe("1 人停止の予約名とその確認", () => {
  const USER = "user1@example.com";

  it.each([
    [
      "Allow の文",
      { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }] },
    ],
    [
      "条件キーが aws:SourceIdentity でない",
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Action: "*",
            Resource: "*",
            Condition: { StringEquals: { "aws:userid": USER } },
          },
        ],
      },
    ],
    [
      "StringLike（ワイルドカードで止めすぎうる）",
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Action: "*",
            Resource: "*",
            Condition: { StringLike: { "aws:SourceIdentity": "*" } },
          },
        ],
      },
    ],
    [
      "一部の操作だけの Deny",
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Action: "s3:*",
            Resource: "*",
            Condition: { StringEquals: { "aws:SourceIdentity": USER } },
          },
        ],
      },
    ],
    [
      "Deny と Allow の混在",
      {
        Version: "2012-10-17",
        Statement: [stopDoc([USER]).Statement[0], { Effect: "Allow", Action: "*", Resource: "*" }],
      },
    ],
  ])("予約名の衝突: %s", (_name, doc) => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", doc);
    expect(codesOf(run(s), "FederatedViewer")).toContain("stop_reserved_conflict");
  });

  it("停止の形なら衝突ではない。停止の一覧を渡さなければ、付いていることを（値を出さずに）知らせるだけ", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopDoc([USER]));
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.find((x) => x.code === "stop_present")).toMatchObject({
      severity: "note",
      role: "FederatedViewer",
    });
    expect(JSON.stringify(f)).not.toContain(USER);
  });

  it("停止中の確認: 設定の全ロールにその人の Deny があれば誤りなし", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopDoc([USER]));
    withStop(s, "FederatedAdministrator", stopDoc([USER, "old@example.com"]));
    expect(errors(run(s, [USER, "old@example.com"]))).toEqual([
      expect.objectContaining({ code: "stop_missing", role: "FederatedViewer" }),
    ]);
  });

  it("停止中の確認: Deny の無いロールは違反（値は出さない）", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopDoc([USER]));
    const f = run(s, [USER]);
    expect(codesOf(f)).toEqual(["stop_missing"]);
    expect(errors(f)[0]?.role).toBe("FederatedAdministrator");
    expect(JSON.stringify(f)).not.toContain(USER);
  });

  it("正常性: 停止の一覧に無い値の Deny（外し忘れ・対象の違い）は警告", () => {
    const s = goodSnapshot();
    withStop(s, "FederatedViewer", stopDoc([USER, "other@example.com"]));
    withStop(s, "FederatedAdministrator", stopDoc([USER]));
    const f = run(s, [USER]);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning")).toEqual([
      expect.objectContaining({ code: "stop_extra", role: "FederatedViewer", detail: "1" }),
    ]);
    expect(JSON.stringify(f)).not.toContain("other@example.com");
  });
});

describe("正常性", () => {
  it("インラインの条件のない全拒否（Deny * *）は強すぎる Deny", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: "Oops",
      document: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }],
      },
    });
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["deny_all"]);
  });

  it("その種類で配るロールが無ければ違反", () => {
    const s = goodSnapshot();
    s.roles = s.roles.filter((r) => r.roleName !== "FederatedAdministrator");
    const f = run(s);
    expect(codesOf(f)).toEqual(["role_missing"]);
    expect(errors(f)[0]?.role).toBe("FederatedAdministrator");
  });

  it("その階層のプロバイダーが無ければ違反", () => {
    const s = goodSnapshot();
    s.providers = s.providers.filter((p) => p !== ADMIN_PROVIDER);
    expect(errors(run(s))).toEqual([
      expect.objectContaining({ code: "provider_missing", detail: "admin" }),
    ]);
  });

  it("MaxSessionDuration が設定と違えば警告", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").maxSessionDuration = 3600;
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning").map((x) => x.code)).toEqual([
      "session_mismatch",
    ]);
  });
});

const consoleTrust = (principal: unknown) => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: principal, Action: "sts:AssumeRoleWithWebIdentity" }],
});
const extraRole = (name: string, path: string, trust: unknown) => ({
  roleName: name,
  path,
  arn: `arn:aws:iam::${ACCOUNT}:role${path}${name}`,
  trustPolicy: trust,
});

describe("棚卸し（設定に無いのにコンソール用のプロバイダーを信頼するロール）", () => {
  it.each([
    ["Standard のプロバイダーを信頼", "/", consoleTrust({ Federated: STD_PROVIDER })],
    ["Admin のプロバイダーを信頼", "/", consoleTrust({ Federated: ADMIN_PROVIDER })],
    ["Principal が *", "/", consoleTrust("*")],
    [
      "コンソール用のパスにある",
      "/awsbridge-console/std/",
      consoleTrust({ Service: "ec2.amazonaws.com" }),
    ],
  ])("%s → 違反", (_name, path, trust) => {
    const s = goodSnapshot();
    s.roles.push(extraRole("Handmade", path, trust));
    expect(codesOf(run(s), "Handmade")).toEqual(["unlisted_role"]);
  });

  it("設定のロールでも、このアカウントの種類で割り当てていなければ違反（種類 A に developer は無い）", () => {
    const s = goodSnapshot();
    s.roles.push(
      extraRole(
        "FederatedDeveloper",
        "/awsbridge-console/std/",
        consoleTrust({ Federated: STD_PROVIDER }),
      ),
    );
    expect(codesOf(run(s), "FederatedDeveloper")).toEqual(["unlisted_role"]);
  });

  it("だれでも（AWS: *）を信頼していても、AssumeRoleWithWebIdentity を許さないロールは対象外", () => {
    const s = goodSnapshot();
    s.roles.push(
      extraRole("CrossAccount", "/", {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": "x" } },
          },
        ],
      }),
    );
    expect(errors(run(s))).toEqual([]);
  });

  it("NotPrincipal の Allow で sts:* を許すロールは違反", () => {
    const s = goodSnapshot();
    s.roles.push(
      extraRole("Loose", "/", {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            NotPrincipal: { AWS: "arn:aws:iam::111111111111:root" },
            Action: "sts:*",
          },
        ],
      }),
    );
    expect(codesOf(run(s), "Loose")).toEqual(["unlisted_role"]);
  });

  it("MCP 用のプロバイダーを信頼するロールは対象外", () => {
    const s = goodSnapshot();
    s.roles.push(extraRole("FederatedMcpViewer", "/", consoleTrust({ Federated: MCP_PROVIDER })));
    expect(errors(run(s))).toEqual([]);
  });
});

describe("署名を置くアカウント（signing.accountIds）", () => {
  const signing = (): AccountSnapshot => ({
    accountId: SIGNING_ACCOUNT,
    partition: "aws",
    providers: [],
    roles: [],
    managedPolicies: [],
  });

  it("コンソール用のプロバイダーもロールも無ければ誤りなし", () => {
    const s = signing();
    s.providers.push(`arn:aws:iam::${SIGNING_ACCOUNT}:oidc-provider/awsbridge.example.workers.dev`);
    expect(errors(run(s))).toEqual([]);
  });

  it("コンソール用のプロバイダーがあれば違反", () => {
    const s = signing();
    s.providers.push(`arn:aws:iam::${SIGNING_ACCOUNT}:oidc-provider/${HOST}/standard`);
    expect(codesOf(run(s))).toEqual(["signing_account_provider"]);
  });

  it("コンソール用のロールがあれば違反", () => {
    const s = signing();
    s.roles.push({
      ...extraRole("FederatedViewer", "/awsbridge-console/std/", consoleTrust({ Federated: "x" })),
      arn: `arn:aws:iam::${SIGNING_ACCOUNT}:role/awsbridge-console/std/FederatedViewer`,
    });
    expect(codesOf(run(s))).toEqual(["signing_account_role"]);
  });
});

describe("警告と限界", () => {
  it("Standard の階層のロールに既知の広い管理ポリシーがあれば警告（インラインは見きれない、と書く）", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").attachedPolicies?.push({
      policyName: "AdministratorAccess",
      policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    });
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning")).toEqual([
      expect.objectContaining({
        code: "broad_managed_policy",
        role: "FederatedViewer",
        detail: "AdministratorAccess",
      }),
    ]);
    expect(f.map((x) => x.code)).toContain("limit_inline_not_evaluated");
  });

  it("Admin の階層の AdministratorAccess は警告しない", () => {
    expect(run(goodSnapshot()).filter((x) => x.code === "broad_managed_policy")).toEqual([]);
  });

  it("限界（インライン・時点・1 アカウント）はいつも結果に書く", () => {
    const codes = run(goodSnapshot())
      .filter((x) => x.severity === "note")
      .map((x) => x.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "limit_inline_not_evaluated",
        "limit_point_in_time",
        "limit_single_account",
      ]),
    );
  });

  it("設定に無いアカウント（取り違えたプロファイル）は誤り。設定のロールはどれかの種類で割り当てたチームで照合する", () => {
    const s = goodSnapshot();
    const other = "777777777777";
    const json = JSON.stringify(s).replaceAll(ACCOUNT, other);
    const moved = JSON.parse(json) as AccountSnapshot;
    const f = run(moved);
    expect(codesOf(f)).toEqual(["account_not_in_config"]);
    expect(f.filter((x) => x.severity === "warning")).toEqual([]);
  });

  it("顧客管理ポリシーの中身は評価しない、と限界に書く", () => {
    expect(run(goodSnapshot()).map((x) => x.code)).toContain(
      "limit_customer_managed_not_evaluated",
    );
  });
});

describe("出力（伏せ字）", () => {
  it("アカウント ID と email を出さない", () => {
    const s = goodSnapshot();
    s.roles.push(extraRole("Handmade", "/", consoleTrust({ Federated: STD_PROVIDER })));
    withStop(s, "FederatedViewer", {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: "*",
          Resource: "*",
          Condition: { StringEquals: { "aws:userid": "user1@example.com" } },
        },
      ],
    });
    const r = inspectAccount({ config: inspectConfig(), snapshot: s, inventory: inventory() });
    const text = formatReport(r);
    expect(text).toContain("unlisted_role");
    expect(text).toContain("stop_reserved_conflict");
    expect(text).not.toMatch(/\d{12}/);
    expect(text).not.toMatch(/@/);
  });

  it("formatReport は誤りがあれば最後に誤りの数を出す", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").path = "/";
    const text = formatReport(
      inspectAccount({ config: inspectConfig(), snapshot: s, inventory: inventory() }),
    );
    expect(text).toMatch(/errors: 1/);
  });

  it("見出しにアカウント ID の末尾 4 桁だけを出す（取り違えたプロファイルに気づけるように）", () => {
    const text = formatReport(
      inspectAccount({ config: inspectConfig(), snapshot: goodSnapshot(), inventory: inventory() }),
    );
    expect(text.split("\n")[0]).toContain(`****${ACCOUNT.slice(-4)}`);
    expect(text).not.toMatch(/\d{12}/);
  });
});

describe("検証役の指摘（2026-11-12）", () => {
  it("NotAction の Deny（Resource *・条件なし）も強すぎる Deny として誤り", () => {
    const s = goodSnapshot();
    role(s, "FederatedViewer").inlinePolicies?.push({
      policyName: "Oops",
      document: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Deny", NotAction: "iam:GetUser", Resource: "*" }],
      },
    });
    expect(codesOf(run(s), "FederatedViewer")).toEqual(["deny_all"]);
  });

  it("信頼ポリシーを読めない（文字列のまま）設定外のロールは、棚卸しで警告 trust_unreadable", () => {
    const s = goodSnapshot();
    s.roles.push(extraRole("Opaque", "/", "%7B%22broken"));
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning")).toEqual([
      expect.objectContaining({ code: "trust_unreadable", role: "Opaque" }),
    ]);
  });

  it("署名アカウントでも、信頼ポリシーを読めないロールは警告 trust_unreadable", () => {
    const s: AccountSnapshot = {
      accountId: SIGNING_ACCOUNT,
      partition: "aws",
      providers: [],
      roles: [
        {
          roleName: "Opaque",
          path: "/",
          arn: `arn:aws:iam::${SIGNING_ACCOUNT}:role/Opaque`,
          trustPolicy: "%7B%22broken",
        },
      ],
      managedPolicies: [],
    };
    const f = run(s);
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.severity === "warning").map((x) => x.code)).toEqual([
      "trust_unreadable",
    ]);
  });
});
