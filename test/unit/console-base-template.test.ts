// コンソールログインの必須のスタック（infra/aws/console/base.yaml）: Standard の OIDC プロバイダーと、階層ごとの守りの部品。
// 設計: docs/specs/console-login.md §4.2・§4.4・§4.7・§4.8・§6.3。ロールのテンプレート（PR8）はこのスタックの Export を読む。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AUDIENCE } from "../../src/console/constants";
import {
  BASE_EXPORT_NAME,
  GUARD_POLICY_NAME,
  GUARD_POLICY_PATH,
  MANAGED_POLICY_MAX_CHARS,
  STOP_USER_INLINE_POLICY_NAME,
} from "../../src/console/reserved";
import { evaluate, type Json } from "./cfn";

const BASE_PATH = resolve(import.meta.dirname, "../../infra/aws/console/base.yaml");
const tpl: Json = parse(readFileSync(BASE_PATH, "utf8"), { customTags: [] });

type Params = Record<string, string>;

/** Conditions の式（Fn::Equals / Fn::Not / Fn::And / Fn::Or / Condition）を、パラメーターで評価する。 */
function evalCondition(expr: Json, params: Params): boolean {
  const [key] = Object.keys(expr);
  const arg = expr[key as string];
  if (key === "Condition") return evalCondition(tpl.Conditions[arg], params);
  if (key === "Fn::Equals") {
    const [a, b] = (arg as Json[]).map((v) => evaluate(v, params));
    return a === b;
  }
  if (key === "Fn::Not") return !evalCondition(arg[0], params);
  if (key === "Fn::And") return (arg as Json[]).every((e) => evalCondition(e, params));
  if (key === "Fn::Or") return (arg as Json[]).some((e) => evalCondition(e, params));
  throw new Error(`未対応の条件: ${key}`);
}

/** パラメーター（既定値で補う）から、作られる Resources と Outputs の名前を返す。 */
function created(params: Params): { resources: string[]; outputs: string[] } {
  const full: Params = { ...defaults(), ...params };
  const conds = Object.fromEntries(
    Object.entries(tpl.Conditions ?? {}).map(([k, v]) => [k, evalCondition(v, full)]),
  );
  const pick = (section: Record<string, Json>) =>
    Object.entries(section ?? {})
      .filter(([, v]) => v.Condition === undefined || conds[v.Condition] === true)
      .map(([k]) => k)
      .sort();
  return { resources: pick(tpl.Resources), outputs: pick(tpl.Outputs) };
}

function defaults(): Params {
  return Object.fromEntries(
    Object.entries(tpl.Parameters as Record<string, Json>)
      .filter(([, v]) => v.Default !== undefined)
      .map(([k, v]) => [k, String(v.Default)]),
  );
}

describe("Admin の階層のパラメーター（Conditions）", () => {
  it("AdminIssuerHost が空（既定）なら、Admin のプロバイダー・部品とその Output は作られない", () => {
    const off = created({ AdminIssuerHost: "" });
    expect(off.resources).not.toContain("AdminGuardPolicy");
    expect(off.resources).not.toContain("AdminProvider");
    expect(off.outputs).not.toContain("AdminGuardPolicyArn");
    expect(off.outputs).not.toContain("AdminProviderArn");
    expect(off.resources).toContain("StandardGuardPolicy");
    expect(off.resources).toContain("StandardProvider");
    expect(created({}).resources).not.toContain("AdminGuardPolicy");
    expect(created({}).resources).not.toContain("AdminProvider");
  });

  it("AdminIssuerHost を渡せば、Admin のプロバイダー・部品とその Output が作られる", () => {
    const on = created({ AdminIssuerHost: ADMIN_HOST });
    expect(on.resources).toContain("AdminGuardPolicy");
    expect(on.resources).toContain("AdminProvider");
    expect(on.outputs).toContain("AdminGuardPolicyArn");
    expect(on.outputs).toContain("AdminProviderArn");
  });
});

const HOST = "awsbridge-oidc-console.example.com";
const ADMIN_HOST = "awsbridge-oidc-admin-console.example.com";
const ACCOUNT = "123456789012";
/** Admin の階層あり（Admin を配るアカウント）。 */
const PARAMS: Params = {
  IssuerHost: HOST,
  StandardPath: "standard",
  Audience: AUDIENCE,
  AdminIssuerHost: ADMIN_HOST,
  AdminPath: "admin",
  "AWS::Partition": "aws",
  "AWS::AccountId": ACCOUNT,
};
/** Admin の階層なし（Standard だけのアカウント）。 */
const STD_ONLY: Params = { ...PARAMS, AdminIssuerHost: "" };

const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/*`;
const PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}/*`;
const ADMIN_PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/${ADMIN_HOST}/*`;
const GUARD_ARN = `arn:aws:iam::${ACCOUNT}:policy/awsbridge-console/*`;
const REMOTE_ARN = `arn:aws:signin:*:${ACCOUNT}:oauth2/public-client/remote`;

/**
 * 守りの部品（Standard / Admin の両方）に共通の文。Sid ごとに Action・Resource を固定する（Condition は無い）。
 * コンソール用のプロバイダーの Deny は、Standard のホストと、Admin の階層があれば Admin のホストの両方を守る。
 */
const commonStatements = (admin: boolean) => [
  {
    Sid: "DenyRoleChaining",
    Effect: "Deny",
    Action: ["sts:AssumeRole", "sts:AssumeRoot"],
    Resource: "*",
  },
  {
    Sid: "DenyConsoleRoleWrites",
    Effect: "Deny",
    Action: [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ],
    Resource: ROLE_ARN,
  },
  {
    Sid: "DenyConsoleProviderWrites",
    Effect: "Deny",
    Action: [
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
    ],
    Resource: admin ? [PROVIDER_ARN, ADMIN_PROVIDER_ARN] : [PROVIDER_ARN],
  },
  {
    Sid: "DenyGuardPolicyWrites",
    Effect: "Deny",
    Action: [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ],
    Resource: GUARD_ARN,
  },
];

const REMOTE_STATEMENT = {
  Sid: "DenyAwsLoginRemote",
  Effect: "Deny",
  Action: ["signin:AuthorizeOAuth2Access", "signin:CreateOAuth2Token"],
  Resource: REMOTE_ARN,
};

type Guard = "StandardGuardPolicy" | "AdminGuardPolicy";

/** パラメーターから Conditions を評価した値（"true" / "false"）。Fn::If の評価に使う。 */
function conditionValues(params: Params): Params {
  const full: Params = { ...defaults(), ...params };
  return Object.fromEntries(
    Object.entries(tpl.Conditions ?? {}).map(([k, v]) => [k, String(evalCondition(v, full))]),
  );
}

/** 部品の文書を、パラメーターと Conditions を入れて評価する（Fn::If は条件の値で選ぶ）。 */
function guardDoc(name: Guard, params: Params = PARAMS): Json {
  return evaluate(tpl.Resources[name].Properties.PolicyDocument, {
    ...defaults(),
    ...params,
    ...conditionValues(params),
  });
}

/** Action を並べ替えて比べる（書いた順は問わない）。 */
function normalize(doc: Json): Json[] {
  return (doc.Statement as Json[]).map((s) => ({
    ...s,
    Action: [...(Array.isArray(s.Action) ? s.Action : [s.Action])].sort(),
  }));
}

describe("Parameters", () => {
  const p = tpl.Parameters;
  it("IssuerHost は必須で、ホスト名だけ（https:// や / は不可）", () => {
    expect(p.IssuerHost.Default).toBeUndefined();
    const re = new RegExp(p.IssuerHost.AllowedPattern);
    expect(re.test(HOST)).toBe(true);
    for (const ng of [`https://${HOST}`, `${HOST}/`, `${HOST}/standard`, 'a"b.example.com', ""])
      expect(re.test(ng), ng).toBe(false);
  });
  it("IssuerHost は小文字のラベルを . でつないだ形だけ（大文字・連続ドット・ラベルの端の - は不可）", () => {
    const re = new RegExp(p.IssuerHost.AllowedPattern);
    for (const ok of ["id.example.com", "a", "id-1.ex-ample.co", "x1.y2"])
      expect(re.test(ok), ok).toBe(true);
    for (const ng of [
      "ID.example.com",
      "Id.Example.com",
      "a..b",
      ".a",
      "a.",
      "-a.b",
      "a-.b",
      "a.-b",
    ])
      expect(re.test(ng), ng).toBe(false);
  });
  it("IssuerHost と StandardPath の MaxLength は、URL 全体（https://<host>/<path>）を 255 文字以内に収める", () => {
    const hostMax: number = p.IssuerHost.MaxLength;
    const pathMax: number = p.StandardPath.MaxLength;
    expect(hostMax).toBeGreaterThan(0);
    expect(pathMax).toBeGreaterThan(0);
    expect("https://".length + hostMax + "/".length + pathMax).toBeLessThanOrEqual(255);
  });
  it("StandardPath は既定 standard、§3.1 のパスの規則（先頭・末尾のスラッシュなし、小文字・数字・-）", () => {
    expect(p.StandardPath.Default).toBe("standard");
    const re = new RegExp(p.StandardPath.AllowedPattern);
    for (const ok of ["standard", "p/p01/standard", "standard-2"])
      expect(re.test(ok), ok).toBe(true);
    for (const ng of [
      "/standard",
      "standard/",
      "STANDARD",
      "",
      "standard//x",
      "standard?x",
      "standard#x",
    ])
      expect(re.test(ng), ng).toBe(false);
  });
  it("Audience は上流の定数 AUDIENCE だけ", () => {
    expect(p.Audience.Default).toBe(AUDIENCE);
    expect(p.Audience.AllowedValues).toEqual([AUDIENCE]);
  });
  it("AdminIssuerHost は既定が空で、空か IssuerHost と同じ規則のホスト名だけ", () => {
    expect(p.AdminIssuerHost.Default).toBe("");
    expect(p.AdminIssuerHost.MaxLength).toBe(p.IssuerHost.MaxLength);
    const re = new RegExp(p.AdminIssuerHost.AllowedPattern);
    for (const ok of ["", ADMIN_HOST, "a", "id-1.ex-ample.co"]) expect(re.test(ok), ok).toBe(true);
    for (const ng of [
      `https://${ADMIN_HOST}`,
      `${ADMIN_HOST}/`,
      `${ADMIN_HOST}/admin`,
      'a"b.example.com',
      "Admin.example.com",
      "a..b",
      "-a.b",
      " ",
    ])
      expect(re.test(ng), ng).toBe(false);
  });
  it("AdminPath は既定 admin、StandardPath と同じ規則（世代つきのパスに移れるよう固定にしない）", () => {
    expect(p.AdminPath.Default).toBe("admin");
    expect(p.AdminPath.AllowedPattern).toBe(p.StandardPath.AllowedPattern);
    expect(p.AdminPath.MaxLength).toBe(p.StandardPath.MaxLength);
    expect(p.AdminPath.AllowedValues).toBeUndefined();
    const re = new RegExp(p.AdminPath.AllowedPattern);
    for (const ok of ["admin", "admin-2", "p/p01/admin"]) expect(re.test(ok), ok).toBe(true);
    for (const ng of ["/admin", "admin/", "ADMIN", "", 'admin"'])
      expect(re.test(ng), ng).toBe(false);
  });
  it("AdminIssuerHost と AdminPath の MaxLength も、URL 全体を 255 文字以内に収める", () => {
    const hostMax: number = p.AdminIssuerHost.MaxLength;
    const pathMax: number = p.AdminPath.MaxLength;
    expect("https://".length + hostMax + "/".length + pathMax).toBeLessThanOrEqual(255);
  });
  it("パラメーターは issuer の 4 つと Audience だけ（EnableAdminTier は無い）", () => {
    expect(Object.keys(p).sort()).toEqual(
      ["AdminIssuerHost", "AdminPath", "Audience", "IssuerHost", "StandardPath"].sort(),
    );
  });
});

describe("Rules（D3: Admin の issuer は Standard と別のホスト）", () => {
  /** Rules の Assert をパラメーターで評価する（すべての Assert が真ならスタックの作成・更新が進む）。 */
  const asserts = (params: Params) => {
    const full: Params = { ...defaults(), ...params };
    return Object.values(tpl.Rules as Record<string, Json>).flatMap((rule) => {
      // RuleCondition が偽なら、その規則は検査しない
      if (rule.RuleCondition !== undefined && !evalCondition(rule.RuleCondition, full)) return [];
      return (rule.Assertions as Json[]).map((a) => evalCondition(a.Assert, full));
    });
  };
  it("AdminIssuerHost が IssuerHost と同じなら通らない", () => {
    expect(asserts({ ...PARAMS, AdminIssuerHost: HOST })).toContain(false);
  });
  it("別のホストと空（Admin の階層なし）は通る", () => {
    expect(asserts(PARAMS).every(Boolean)).toBe(true);
    expect(asserts(STD_ONLY).every(Boolean)).toBe(true);
  });
  it("Assert には理由の説明がある", () => {
    for (const rule of Object.values(tpl.Rules as Record<string, Json>))
      for (const a of rule.Assertions as Json[]) expect(a.AssertDescription).toBeTruthy();
  });
});

describe("Resources", () => {
  it("2 つのプロバイダー（Admin は条件つき）と 2 つの部品だけを持ち、ロールは作らない", () => {
    expect(Object.keys(tpl.Resources).sort()).toEqual(
      ["AdminGuardPolicy", "AdminProvider", "StandardGuardPolicy", "StandardProvider"].sort(),
    );
    const types = Object.values(tpl.Resources as Record<string, Json>).map((r) => r.Type);
    expect(types.filter((t) => t === "AWS::IAM::OIDCProvider")).toHaveLength(2);
    expect(types).not.toContain("AWS::IAM::Role");
  });

  it("Admin のプロバイダー: https://<AdminIssuerHost>/<AdminPath>、client ID は audience、Admin の階層のタグ、条件つき", () => {
    const r = tpl.Resources.AdminProvider;
    expect(r.Type).toBe("AWS::IAM::OIDCProvider");
    expect(r.Condition).toBe("AdminTierEnabled");
    const props = evaluate(r.Properties, { ...PARAMS, AdminPath: "admin-2" });
    expect(props.Url).toBe(`https://${ADMIN_HOST}/admin-2`);
    expect(props.ClientIdList).toEqual([AUDIENCE]);
    expect(props.ThumbprintList).toBeUndefined();
    expect(props.Tags).toEqual([
      { Key: "project", Value: "awsbridge" },
      { Key: "awsbridge-console-tier", Value: "admin" },
    ]);
  });

  it("Standard のプロバイダー: https://<IssuerHost>/<StandardPath>、client ID は audience、thumbprint なし", () => {
    const r = tpl.Resources.StandardProvider;
    expect(r.Type).toBe("AWS::IAM::OIDCProvider");
    expect(r.Condition).toBeUndefined();
    const props = evaluate(r.Properties, { ...PARAMS, StandardPath: "p/p01/standard" });
    expect(props.Url).toBe(`https://${HOST}/p/p01/standard`);
    expect(props.ClientIdList).toEqual([AUDIENCE]);
    expect(props.ThumbprintList).toBeUndefined();
  });

  it("部品は予約した名前とパスの顧客管理ポリシー", () => {
    for (const [name, tier] of [
      ["StandardGuardPolicy", "standard"],
      ["AdminGuardPolicy", "admin"],
    ] as const) {
      const r = tpl.Resources[name];
      expect(r.Type, name).toBe("AWS::IAM::ManagedPolicy");
      expect(r.Properties.ManagedPolicyName, name).toBe(GUARD_POLICY_NAME[tier]);
      expect(r.Properties.Path, name).toBe(GUARD_POLICY_PATH);
      // 部品をロールに付けるのはロールのテンプレート（PR8）。このスタックは付けない
      expect(r.Properties.Roles, name).toBeUndefined();
    }
    expect(tpl.Resources.StandardGuardPolicy.Condition).toBeUndefined();
    expect(tpl.Resources.AdminGuardPolicy.Condition).toBe("AdminTierEnabled");
  });
});

describe("守りの部品の文", () => {
  it("Standard の部品: ロールチェーンの禁止・コンソール用のロールとプロバイダーと部品への書き込みの Deny だけ", () => {
    for (const [params, admin] of [
      [PARAMS, true],
      [STD_ONLY, false],
    ] as const) {
      const doc = guardDoc("StandardGuardPolicy", params);
      expect(doc.Version).toBe("2012-10-17");
      expect(normalize(doc), `admin=${admin}`).toEqual(
        normalize({ Statement: commonStatements(admin) }),
      );
    }
  });

  it("Admin の部品: Standard と同じ文に、aws login --remote の明示の Deny を足したもの", () => {
    const doc = guardDoc("AdminGuardPolicy");
    expect(doc.Version).toBe("2012-10-17");
    expect(normalize(doc)).toEqual(
      normalize({ Statement: [...commonStatements(true), REMOTE_STATEMENT] }),
    );
  });

  it("穴の回帰: Admin の階層があれば、両方の部品のプロバイダーの Deny が Admin のホストも守る", () => {
    for (const name of ["StandardGuardPolicy", "AdminGuardPolicy"] as const) {
      const st = (guardDoc(name).Statement as Json[]).find(
        (x) => x.Sid === "DenyConsoleProviderWrites",
      );
      expect(st.Resource, name).toContain(ADMIN_PROVIDER_ARN);
      expect(st.Resource, name).toContain(PROVIDER_ARN);
    }
    const std = (guardDoc("StandardGuardPolicy", STD_ONLY).Statement as Json[]).find(
      (x) => x.Sid === "DenyConsoleProviderWrites",
    );
    expect(std.Resource).toEqual([PROVIDER_ARN]);
  });

  it("remote の Deny は Admin の部品にだけあり、Standard の部品には signin の文が無い", () => {
    const std = JSON.stringify(guardDoc("StandardGuardPolicy"));
    expect(std).not.toContain("signin:");
    expect(std).not.toContain("oauth2/public-client");
    expect(JSON.stringify(guardDoc("AdminGuardPolicy"))).toContain(REMOTE_ARN);
  });

  it("どちらの部品も Deny だけで、条件を持たない（1 人停止の aws:SourceIdentity の Deny は部品に入れない）", () => {
    for (const name of ["StandardGuardPolicy", "AdminGuardPolicy"] as const) {
      const doc = guardDoc(name);
      for (const s of doc.Statement as Json[]) {
        expect(s.Effect, `${name} ${s.Sid}`).toBe("Deny");
        expect(s.Condition, `${name} ${s.Sid}`).toBeUndefined();
        expect(s.NotAction, `${name} ${s.Sid}`).toBeUndefined();
        expect(s.NotResource, `${name} ${s.Sid}`).toBeUndefined();
      }
      expect(JSON.stringify(doc)).not.toMatch(/SourceIdentity/i);
    }
  });

  it("部品の自己保護の Resource は、部品自身の ARN を含む", () => {
    const re = new RegExp(`^${GUARD_ARN.replace(/[.]/g, "\\.").replace("*", ".*")}$`);
    for (const tier of ["standard", "admin"] as const)
      expect(
        re.test(`arn:aws:iam::${ACCOUNT}:policy${GUARD_POLICY_PATH}${GUARD_POLICY_NAME[tier]}`),
        tier,
      ).toBe(true);
  });

  it("パーティションとアカウントはテンプレートの擬似パラメーターから取る", () => {
    const doc = guardDoc("AdminGuardPolicy", {
      ...PARAMS,
      "AWS::Partition": "aws-us-gov",
      "AWS::AccountId": "210987654321",
    });
    const text = JSON.stringify(doc);
    expect(text).not.toContain("arn:aws:");
    expect(text).not.toContain(ACCOUNT);
    expect(text).toContain("arn:aws-us-gov:iam::210987654321:role/awsbridge-console/*");
  });

  it("部品のポリシーは管理ポリシーの上限（6,144 文字。空白を除く）に収まる", () => {
    // 最悪の長さ: パラメーターの MaxLength いっぱいのホストとパス、長いパーティション名
    const hostMax: number = tpl.Parameters.IssuerHost.MaxLength;
    const pathMax: number = tpl.Parameters.StandardPath.MaxLength;
    expect(hostMax).toBeGreaterThan(0);
    expect(pathMax).toBeGreaterThan(0);
    // Admin のホストが 1 つ増える分も含めて、Admin の有り無しの両方で測る
    const adminHostMax: number = tpl.Parameters.AdminIssuerHost.MaxLength;
    const long: Params = {
      ...PARAMS,
      IssuerHost: "a".repeat(hostMax),
      StandardPath: "s".repeat(pathMax),
      AdminIssuerHost: "b".repeat(adminHostMax),
      "AWS::Partition": "aws-iso-b",
    };
    for (const params of [long, { ...long, AdminIssuerHost: "" }])
      for (const name of ["StandardGuardPolicy", "AdminGuardPolicy"] as const) {
        const size = JSON.stringify(guardDoc(name, params)).length;
        expect(size, `${name} admin=${params.AdminIssuerHost !== ""}`).toBeLessThanOrEqual(
          MANAGED_POLICY_MAX_CHARS,
        );
      }
    expect(MANAGED_POLICY_MAX_CHARS).toBe(6144);
  });
});

describe("Outputs と Export（ロールのテンプレートに部品の ARN を渡す）", () => {
  const o = tpl.Outputs;
  it("部品の ARN を予約した Export 名で出す。Admin の部品は Admin の階層を使うときだけ", () => {
    expect(o.StandardGuardPolicyArn.Value).toEqual({ Ref: "StandardGuardPolicy" });
    expect(o.StandardGuardPolicyArn.Export.Name).toBe(BASE_EXPORT_NAME.standardGuardPolicyArn);
    expect(o.StandardGuardPolicyArn.Condition).toBeUndefined();
    expect(o.AdminGuardPolicyArn.Value).toEqual({ Ref: "AdminGuardPolicy" });
    expect(o.AdminGuardPolicyArn.Export.Name).toBe(BASE_EXPORT_NAME.adminGuardPolicyArn);
    expect(o.AdminGuardPolicyArn.Condition).toBe("AdminTierEnabled");
  });
  it("Admin のプロバイダーの ARN も Output に出すが Export しない（世代つきのパスで ARN が変わるため）", () => {
    expect(o.AdminProviderArn.Value).toEqual({ Ref: "AdminProvider" });
    expect(o.AdminProviderArn.Export).toBeUndefined();
    expect(o.AdminProviderArn.Condition).toBe("AdminTierEnabled");
  });
  it("Export 名はスタック名に依存しない（StackSets のスタック名は自動で付く）", () => {
    for (const n of Object.values(BASE_EXPORT_NAME))
      expect(n).toMatch(/^awsbridge-console-[a-z-]+$/);
    for (const v of Object.values(o as Record<string, Json>))
      if (v.Export) expect(typeof v.Export.Name).toBe("string");
  });
  it("プロバイダーの ARN は Output に出すが Export しない（issuer のパスを替えるときに import が更新を止めないように）", () => {
    expect(o.StandardProviderArn.Value).toEqual({ Ref: "StandardProvider" });
    expect(o.StandardProviderArn.Export).toBeUndefined();
  });
});

describe("1 人停止の Deny の予約名（CloudFormation の外のロールのインライン。§6.3）", () => {
  const text = readFileSync(BASE_PATH, "utf8");
  it("IAM のインラインポリシー名の形で、AWS の revoke の名前とも PoC の名前とも重ならない", () => {
    expect(STOP_USER_INLINE_POLICY_NAME).toMatch(/^[\w+=,.@-]{1,128}$/);
    expect(STOP_USER_INLINE_POLICY_NAME).not.toBe("AWSRevokeOlderSessions");
    expect(STOP_USER_INLINE_POLICY_NAME).not.toBe("AwsbridgeDenySourceIdentity");
  });
  it("このスタックはその名前のポリシーを管理せず（インラインポリシーを持たない）、コメントで対応を書く", () => {
    // インラインポリシー（Policies[].PolicyName）も AWS::IAM::Policy / RolePolicy も無い
    expect(text).not.toMatch(/^\s*-?\s*PolicyName:\s/m);
    for (const [name, r] of Object.entries(tpl.Resources as Record<string, Json>)) {
      expect(r.Properties?.Policies, name).toBeUndefined();
      expect(["AWS::IAM::Policy", "AWS::IAM::RolePolicy"], name).not.toContain(r.Type);
    }
    expect(text).toContain(STOP_USER_INLINE_POLICY_NAME);
  });
});

describe("mise の lint", () => {
  it("lint は base.yaml を cfn-lint で検査する", () => {
    const toml = readFileSync(resolve(import.meta.dirname, "../../mise.toml"), "utf8");
    const start = toml.indexOf("[tasks.lint]");
    const rest = toml.slice(start + 1);
    const section = rest.slice(0, rest.search(/^\[/m));
    expect(section).toContain("cfn-lint infra/aws/console/base.yaml");
  });
});
