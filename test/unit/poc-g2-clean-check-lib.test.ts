// G2 の片付けの確認（poc:g2:clean-check）の判定。aws と Cloudflare の API は差し替える（読み取りだけを呼ぶこと）。
import { describe, expect, it } from "vitest";
import {
  CLEAN_CHECK_AWS_COMMANDS,
  type CleanCheckDeps,
  DEFAULT_ROLE_NAMES,
  formatCleanCheck,
  runCleanCheck,
} from "../../scripts/poc/g2/clean-check-lib";

const ACCOUNT = "123456789012";
const PROVIDERS_BASELINE = [
  `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
];

function fakeAws(o: {
  roles?: Record<string, string[]>;
  existing?: string[];
  providers?: string[];
  policies?: Record<string, string[]>;
  stacks?: string[];
  fail?: string;
}) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const cmd = `${args[0]} ${args[1]}`;
    if (o.fail === cmd)
      throw new Error(`aws ${cmd} failed: An error occurred (AccessDenied) when calling`);
    const arg = (k: string) => args[args.indexOf(k) + 1] ?? "";
    switch (cmd) {
      case "iam list-roles":
        return { Roles: (o.roles?.[arg("--path-prefix")] ?? []).map((n) => ({ RoleName: n })) };
      case "iam get-role":
        if ((o.existing ?? []).includes(arg("--role-name")))
          return { Role: { RoleName: arg("--role-name") } };
        throw new Error(
          "aws iam get-role failed: An error occurred (NoSuchEntity) when calling the GetRole operation",
        );
      case "iam list-open-id-connect-providers":
        return { OpenIDConnectProviderList: (o.providers ?? []).map((a) => ({ Arn: a })) };
      case "iam list-policies":
        return {
          Policies: (o.policies?.[arg("--path-prefix")] ?? []).map((n) => ({ PolicyName: n })),
        };
      case "cloudformation describe-stacks":
        if ((o.stacks ?? []).includes(arg("--stack-name")))
          return { Stacks: [{ StackName: arg("--stack-name") }] };
        throw new Error(
          `aws cloudformation describe-stacks failed: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${arg("--stack-name")} does not exist`,
        );
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  };
  return { run, calls };
}

function fakeCf(o: { scripts?: string[]; domains?: string[]; apps?: string[]; status?: number }) {
  const paths: string[] = [];
  const get = async (url: string) => {
    paths.push(url);
    const path = url.split("?")[0] ?? "";
    if (o.status) return { status: o.status, json: { success: false } };
    if (path.endsWith("/workers/scripts"))
      return {
        status: 200,
        json: { success: true, result: (o.scripts ?? []).map((id) => ({ id })) },
      };
    if (path.endsWith("/workers/domains"))
      return {
        status: 200,
        json: { success: true, result: (o.domains ?? []).map((hostname) => ({ hostname })) },
      };
    if (path.endsWith("/access/apps"))
      return {
        status: 200,
        json: { success: true, result: (o.apps ?? []).map((domain) => ({ name: "app", domain })) },
      };
    return { status: 404, json: {} };
  };
  return { get, paths };
}

const deps = (aws: ReturnType<typeof fakeAws>, cf?: ReturnType<typeof fakeCf>): CleanCheckDeps => ({
  aws: aws.run,
  ...(cf ? { cf: cf.get } : {}),
});

describe("runCleanCheck", () => {
  it("何も残っていなければすべて OK。呼ぶのは読み取りの aws と GET だけ", async () => {
    const aws = fakeAws({ providers: PROVIDERS_BASELINE });
    const cf = fakeCf({
      scripts: ["other-worker"],
      domains: ["www.example.com"],
      apps: ["x.example.com"],
    });
    const r = await runCleanCheck(deps(aws, cf), {
      roleNames: DEFAULT_ROLE_NAMES,
      stacks: ["g2-base", "g2-roles"],
      baselineProviders: PROVIDERS_BASELINE,
    });
    expect(
      r.every((c) => c.status === "OK"),
      JSON.stringify(r),
    ).toBe(true);
    for (const c of aws.calls)
      expect(CLEAN_CHECK_AWS_COMMANDS as readonly string[]).toContain(`${c[0]} ${c[1]}`);
    // 既定のロール名は手順書 §1.3 の 4 つ
    expect(DEFAULT_ROLE_NAMES).toEqual([
      "FederatedAwsBridgeViewer",
      "AwsbridgeG2AdminProbe",
      "FederatedAwsBridgeAdministrator",
      "AwsbridgeG2CtrlChain",
    ]);
    expect(cf.paths).toHaveLength(3);
  });

  it("残っているものを NG にする（ロール・パス・プロバイダー・管理ポリシー・スタック・Worker・Custom Domain・Access アプリ）", async () => {
    const aws = fakeAws({
      roles: { "/awsbridge-g2-probe/": ["AwsbridgeG2ProbeKid"] },
      existing: ["FederatedAwsBridgeAdministrator"],
      providers: [
        ...PROVIDERS_BASELINE,
        `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-g2-probe-kid.dev.example.com/p`,
      ],
      policies: { "/awsbridge-console/": ["AwsbridgeConsoleGuardAdmin"] },
      stacks: ["g2-base"],
    });
    const cf = fakeCf({
      scripts: ["awsbridge-console-admin", "awsbridge-g2-probe-n5"],
      domains: ["awsbridge-oidc-console.dev.example.com"],
      apps: ["awsbridge-console.dev.example.com/t/g2std"],
    });
    const r = await runCleanCheck(deps(aws, cf), {
      roleNames: DEFAULT_ROLE_NAMES,
      stacks: ["g2-base"],
      baselineProviders: PROVIDERS_BASELINE,
    });
    const ng = r.filter((c) => c.status === "NG").map((c) => c.name);
    expect(ng).toEqual(
      expect.arrayContaining([
        "iam list-roles /awsbridge-g2-probe/",
        "iam get-role FederatedAwsBridgeAdministrator",
        "iam oidc providers",
        "iam list-policies /awsbridge-console/",
        "cloudformation g2-base",
        "cloudflare workers",
        "cloudflare custom domains",
        "cloudflare access apps",
      ]),
    );
    const text = formatCleanCheck(r);
    expect(text).not.toContain(ACCOUNT);
  });

  it("ベースラインが無いときは、試験の名前のプロバイダーが無いことだけを見る", async () => {
    const aws = fakeAws({ providers: PROVIDERS_BASELINE });
    const r = await runCleanCheck(deps(aws), {
      roleNames: [],
      stacks: [],
      baselineProviders: undefined,
    });
    expect(r.find((c) => c.name === "iam oidc providers")?.status).toBe("OK");
    expect(r.find((c) => c.name.startsWith("cloudflare"))?.status).toBe("SKIP");
  });

  it("Cloudflare の一覧に続きのページがある・success が true でない・形が違うなら ERR（残っていないと言わない）", async () => {
    const aws = fakeAws({ providers: PROVIDERS_BASELINE });
    const replies: Record<string, unknown> = {
      "/workers/scripts": { success: true, result: [], result_info: { page: 1, total_pages: 2 } },
      "/workers/domains": { success: false, result: [] },
      "/access/apps": { success: true, result: { not: "a list" } },
    };
    const cf = async (url: string) => {
      const path = url.split("?")[0] ?? "";
      const key = Object.keys(replies).find((k) => path.endsWith(k)) as string;
      return { status: 200, json: replies[key] };
    };
    const r = await runCleanCheck(
      { aws: aws.run, cf },
      { roleNames: [], stacks: [], baselineProviders: undefined },
    );
    const cfr = r.filter((c) => c.name.startsWith("cloudflare"));
    expect(cfr.map((c) => c.status)).toEqual(["ERR", "ERR", "ERR"]);
    expect(cfr[0]?.detail).toMatch(/truncated/);
  });

  it("読めなければ ERR（残っていないとは言わない）", async () => {
    const aws = fakeAws({ fail: "iam list-roles" });
    const cf = fakeCf({ status: 403 });
    const r = await runCleanCheck(deps(aws, cf), {
      roleNames: [],
      stacks: [],
      baselineProviders: undefined,
    });
    expect(
      r.filter((c) => c.name.startsWith("iam list-roles")).every((c) => c.status === "ERR"),
    ).toBe(true);
    expect(r.filter((c) => c.name.startsWith("cloudflare")).every((c) => c.status === "ERR")).toBe(
      true,
    );
  });
});
