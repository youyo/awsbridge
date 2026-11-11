// 人間のログインの設定ファイルからの生成（Worker 用・StackSets 用・Access の検査用）。設計: docs/specs/human-login-portal.md §5.2・§9.10・§11.4〜§11.6。
import { describe, expect, it } from "vitest";
import { HumanConfigError, type HumanConfigIssue, parseHumanConfig } from "../../src/human/config";
import { generateHumanArtifacts, type HumanArtifacts } from "../../src/human/generate";
import {
  companyAuds,
  companyConfig,
  companyInventory,
  personalConfig,
  type Raw,
  uuid,
} from "./human-fixtures";

const AT = "2026-11-11T00:00:00.000Z";

function gen(
  raw: Raw,
  opts: { auds?: Raw; inventory?: Raw; mode?: "check" | "deploy"; sourceRevision?: string } = {},
): HumanArtifacts {
  const { config } = parseHumanConfig(raw);
  return generateHumanArtifacts(config, {
    mode: opts.mode ?? "deploy",
    generatedAt: AT,
    ...(opts.auds !== undefined ? { auds: opts.auds } : {}),
    ...(opts.inventory !== undefined ? { inventory: opts.inventory } : {}),
    ...(opts.sourceRevision !== undefined ? { sourceRevision: opts.sourceRevision } : {}),
  });
}

function issuesOf(f: () => unknown): HumanConfigIssue[] {
  try {
    f();
  } catch (e) {
    if (e instanceof HumanConfigError) return e.issues;
    throw e;
  }
  return [];
}

const issue = (path: string, code: string) => expect.objectContaining({ path, code });

const company = () =>
  gen(companyConfig(), {
    auds: companyAuds(),
    inventory: companyInventory(),
    sourceRevision: "abc",
  });

describe("Worker 用の生成物（階層ごと）", () => {
  it("使われている階層ごとに 1 つずつ作る（個人用は Standard だけ）", () => {
    expect(Object.keys(company().worker).sort()).toEqual(["admin", "standard"]);
    expect(Object.keys(gen(personalConfig()).worker)).toEqual(["standard"]);
  });

  it("Standard: その階層のチーム（AUD つき）・ロール・issuer・ポータルの値だけを持つ", () => {
    const w = company().worker.standard;
    expect(w).toMatchObject({
      schemaVersion: 1,
      tier: "standard",
      generatedAt: AT,
      sourceRevision: "abc",
      tagKey: "awsbridge_team",
      portal: {
        origin: "https://portal.example.com",
        peerOrigin: "https://admin-portal.example.com",
        routing: "path",
        regions: { allowed: ["ap-northeast-1", "us-east-1"], default: "ap-northeast-1" },
        supportUrl: "https://support.example.com/aws",
        entryAud: "6".repeat(64),
      },
    });
    expect(w.teams).toEqual([
      { name: "infra", displayName: "インフラ", aud: "1".repeat(64) },
      { name: "dev", displayName: "開発", aud: "2".repeat(64) },
      { name: "sa", displayName: "sa", aud: "3".repeat(64) },
    ]);
    expect(w.roles.map((r) => r.name)).toEqual(["developer", "readonly"]);
    expect(w.roles[1]).toEqual({
      name: "readonly",
      roleName: "HumanReadOnly",
      displayName: "readonly",
      sessionSeconds: 43200,
    });
    expect(w.boundaries).toEqual([
      { name: "managed", issuer: "https://id.example.com/standard" },
      { name: "partner:partner-x", issuer: "https://id.example.com/partner-x" },
    ]);
  });

  it("Admin: Admin のチーム・ロール・Admin の issuer を持つ境界だけ", () => {
    const w = company().worker.admin;
    expect(w?.tier).toBe("admin");
    expect(w?.portal.origin).toBe("https://admin-portal.example.com");
    expect(w?.portal.peerOrigin).toBe("https://portal.example.com");
    expect(w?.portal.entryAud).toBe("7".repeat(64));
    expect(w?.teams.map((t) => t.name)).toEqual(["infra-elevated", "dev-elevated"]);
    expect(w?.roles.map((r) => r.name)).toEqual(["admin"]);
    expect(w?.boundaries).toEqual([{ name: "managed", issuer: "https://id.example.com/admin" }]);
  });

  it("一覧の行: 種類の割り当てを展開し、その階層のロールだけを入れる（§5.2 の形）", () => {
    const w = company().worker.standard;
    const svcC = w.accounts.find((a) => a.accountId === "444444444444");
    expect(svcC).toEqual({
      accountId: "444444444444",
      name: "svc-c-dev",
      email: "aws+svc-c-dev@example.com",
      orgLabel: "org-main",
      boundary: "managed",
      kind: "C",
      roles: [
        {
          role: "developer",
          roleArn: "arn:aws:iam::444444444444:role/awsbridge-human/HumanDeveloper",
          teams: ["dev"],
          sessionSeconds: 28800,
        },
        {
          role: "readonly",
          roleArn: "arn:aws:iam::444444444444:role/awsbridge-human/HumanReadOnly",
          teams: ["sa", "infra"],
          sessionSeconds: 43200,
        },
      ],
    });
    const admin = company().worker.admin;
    expect(admin?.accounts.find((a) => a.accountId === "444444444444")?.roles).toEqual([
      {
        role: "admin",
        roleArn: "arn:aws:iam::444444444444:role/awsbridge-human/HumanAdmin",
        teams: ["infra-elevated"],
        sessionSeconds: 3600,
      },
    ]);
  });

  it("Standard のファイルに Admin の行・チーム・AUD・issuer がなく、Admin のファイルに Standard のものがない", () => {
    const { standard, admin } = company().worker;
    const s = JSON.stringify(standard);
    const a = JSON.stringify(admin);
    for (const leak of [
      "HumanAdmin",
      "infra-elevated",
      "dev-elevated",
      "4".repeat(64),
      "7".repeat(64),
      "https://id.example.com/admin",
    ]) {
      expect(s, leak).not.toContain(leak);
    }
    for (const leak of [
      "HumanReadOnly",
      "HumanDeveloper",
      '"dev"',
      "1".repeat(64),
      "6".repeat(64),
      "https://id.example.com/standard",
      "partner-x",
    ]) {
      expect(a, leak).not.toContain(leak);
    }
  });

  it("種類の定義（kinds）・Entra のグループの Object ID・Access のポリシー ID・権限ポリシーを入れない", () => {
    const c = companyConfig();
    c.teams[2].access = { policyIds: [uuid(77)] };
    const all = JSON.stringify(
      gen(c, { auds: companyAuds(), inventory: companyInventory() }).worker,
    );
    expect(all).not.toContain("kinds");
    expect(all).not.toContain("assign");
    expect(all).not.toContain("kindOus");
    expect(all).not.toContain("ou-abcd-");
    expect(all).not.toContain("inventoryRoleArn");
    expect(all).not.toContain("00000000-0000-4000-8000-");
    expect(all).not.toContain("arn:aws:iam::aws:policy/");
  });

  it("停止中のアカウントは出さず、どの種類の OU にも属さないアカウントは出さずに件数を警告する", () => {
    const r = company();
    const ids = r.worker.standard.accounts.map((a) => a.accountId);
    expect(ids).toEqual(["333333333333", "444444444444", "222222222222"]);
    expect(r.warnings).toContainEqual(
      expect.objectContaining({
        path: "inventory.org-main",
        code: "unassigned_accounts",
        count: 1,
      }),
    );
  });

  it("その階層のロールが 1 つもないアカウントの行は入れない", () => {
    const admin = company().worker.admin;
    expect(admin?.accounts.map((a) => a.accountId)).toEqual(["333333333333", "444444444444"]);
  });

  it("placement: ou の Organization のインベントリがなければ行を作らず警告する", () => {
    const r = gen(companyConfig(), { auds: companyAuds() });
    expect(r.worker.standard.accounts.map((a) => a.accountId)).toEqual(["222222222222"]);
    expect(r.warnings).toContainEqual(issue("inventory.org-main", "inventory_missing"));
  });

  it("organizations には行に現れる Organization の表示名だけを入れる", () => {
    expect(company().worker.standard.organizations).toEqual([
      { name: "org-main", displayName: "本体" },
      { name: "partner-x", displayName: "先方 X" },
    ]);
    expect(company().worker.admin?.organizations).toEqual([
      { name: "org-main", displayName: "本体" },
    ]);
  });
});

describe("アカウントの email（inventory.accountEmail。§5.6）", () => {
  const emailOf = (r: HumanArtifacts, id: string) =>
    r.worker.standard.accounts.find((a) => a.accountId === id)?.email;

  it("既定（full）では管理下・管理外ともそのまま入れる", () => {
    const r = company();
    expect(emailOf(r, "333333333333")).toBe("aws+svc-a-prod@example.com");
    expect(emailOf(r, "222222222222")).toBe("aws+partner-x-dev@example.org");
  });

  it("masked はローカル部の先頭 2 文字だけを残し、hidden は入れない（元の値はどこにも残らない）", () => {
    const c = companyConfig();
    c.inventory = { accountEmail: { managed: "masked", partner: "hidden" } };
    const r = gen(c, { auds: companyAuds(), inventory: companyInventory() });
    expect(emailOf(r, "333333333333")).toBe("aw***@example.com");
    const partner = r.worker.standard.accounts.find((a) => a.accountId === "222222222222");
    expect(partner).toBeDefined();
    expect(partner && "email" in partner).toBe(false);
    const all = JSON.stringify(r);
    expect(all).not.toContain("aws+svc-a-prod@");
    expect(all).not.toContain("partner-x-dev@");
  });

  it("masked でローカル部が 2 文字以下なら先頭 1 文字だけを残す", () => {
    const c = personalConfig();
    c.organizations[0].accounts[0].email = "ab@example.com";
    c.inventory = { accountEmail: { managed: "masked" } };
    expect(emailOf(gen(c), "111111111111")).toBe("a***@example.com");
  });
});

describe("AUD（Terraform の出力と手書き）", () => {
  it("deploy: チームの AUD がなければ aud_missing（階層をまたいでまとめて作るので、Admin の 1 つが欠けても全体が誤り）", () => {
    const auds = companyAuds();
    delete auds.teams.dev;
    expect(issuesOf(() => gen(companyConfig(), { auds }))).toContainEqual(
      issue("teams[1].access", "aud_missing"),
    );
    const adminMissing = companyAuds();
    delete adminMissing.teams["dev-elevated"];
    expect(issuesOf(() => gen(companyConfig(), { auds: adminMissing }))).toContainEqual(
      issue("teams[4].access", "aud_missing"),
    );
  });

  it("AUD の入力の、名前の形でないキー（AUD を逆向きに書いた場合など）はパスに出さない", () => {
    const auds = companyAuds();
    auds.teams["e".repeat(64)] = "dev";
    const paths = issuesOf(() => gen(companyConfig(), { auds })).map((i) => i.path);
    expect(paths).toContain("auds.teams.<redacted>");
    expect(paths.join("\n")).not.toContain("e".repeat(16));
  });

  it("deploy: チームが 2 つ以上の階層で入口の AUD がなければ entry_aud_missing", () => {
    const auds = companyAuds();
    delete auds.entry;
    const found = issuesOf(() => gen(companyConfig(), { auds }));
    expect(found).toContainEqual(issue("portal.entryAud.standard", "entry_aud_missing"));
    expect(found).toContainEqual(issue("portal.entryAud.admin", "entry_aud_missing"));
  });

  it("check: AUD がなくても誤りにしない（PR の検査。§11.5 の順）", () => {
    const r = gen(companyConfig(), { mode: "check" });
    expect(r.worker.standard.teams[0]).toEqual({ name: "infra", displayName: "インフラ" });
    expect(r.worker.standard.portal.entryAud).toBeUndefined();
  });

  it("手書きの AUD は Terraform の出力がなくても使う（個人用）", () => {
    expect(gen(personalConfig()).worker.standard.teams).toEqual([
      { name: "me", displayName: "自分", aud: "a".repeat(64) },
    ]);
  });

  it("手書きの AUD と Terraform の出力が違えば aud_mismatch", () => {
    expect(
      issuesOf(() => gen(personalConfig(), { auds: { teams: { me: "b".repeat(64) } } })),
    ).toContainEqual(issue("teams[0].access.aud", "aud_mismatch"));
  });

  it("Terraform の出力に設定にないチームがあれば unknown_team", () => {
    const auds = companyAuds();
    auds.teams.qa = "9".repeat(64);
    expect(issuesOf(() => gen(companyConfig(), { auds }))).toContainEqual(
      issue("auds.teams.qa", "unknown_team"),
    );
  });

  it("AUD の重複（チーム同士・入口との間）は duplicate", () => {
    const auds = companyAuds();
    auds.teams.dev = auds.teams.infra;
    auds.entry.admin = auds.teams.sa;
    const found = issuesOf(() => gen(companyConfig(), { auds }));
    expect(found).toContainEqual(issue("auds.teams.dev", "duplicate"));
    expect(found).toContainEqual(issue("auds.entry.admin", "duplicate"));
  });

  it("AUD の入力の形が違えば type / unknown_key", () => {
    expect(issuesOf(() => gen(companyConfig(), { auds: [] }))).toContainEqual(
      issue("auds", "type"),
    );
    expect(issuesOf(() => gen(companyConfig(), { auds: { team: {} } }))).toContainEqual(
      issue("auds.team", "unknown_key"),
    );
    expect(issuesOf(() => gen(companyConfig(), { auds: { teams: { dev: 1 } } }))).toContainEqual(
      issue("auds.teams.dev", "type"),
    );
  });
});

describe("インベントリの入力", () => {
  it("設定にない Organization・placement: accounts の Organization は誤り", () => {
    const inv = companyInventory();
    inv["org-x"] = [];
    inv["partner-x"] = [];
    const found = issuesOf(() => gen(companyConfig(), { auds: companyAuds(), inventory: inv }));
    expect(found).toContainEqual(issue("inventory.org-x", "unknown_organization"));
    expect(found).toContainEqual(issue("inventory.partner-x", "placement"));
  });

  it("2 つの種類の OU に属するアカウント（OU の入れ子）は ou_nested", () => {
    const c = companyConfig();
    c.organizations[0].kindOus.B = ["ou-abcd-99999999"];
    const found = issuesOf(() => gen(c, { auds: companyAuds(), inventory: companyInventory() }));
    expect(found).toContainEqual(issue("inventory.org-main[1]", "ou_nested"));
  });

  it("設定の accounts と重複するアカウント ID は duplicate", () => {
    const inv = companyInventory();
    inv["org-main"][0].accountId = "222222222222";
    expect(
      issuesOf(() => gen(companyConfig(), { auds: companyAuds(), inventory: inv })),
    ).toContainEqual(issue("inventory.org-main[0].accountId", "duplicate"));
  });

  it("行の形が違えば誤り（accountId の桁・未知のキー）", () => {
    const inv = companyInventory();
    inv["org-main"][0].accountId = "1";
    inv["org-main"][1].arn = "x";
    const found = issuesOf(() => gen(companyConfig(), { auds: companyAuds(), inventory: inv }));
    expect(found).toContainEqual(issue("inventory.org-main[0].accountId", "pattern"));
    expect(found).toContainEqual(issue("inventory.org-main[1].arn", "unknown_key"));
  });
});

describe("StackSets 用の生成物", () => {
  it("ロールの定義（テンプレートに渡す形）と固定の約束を持つ", () => {
    const s = company().stacksets;
    expect(s.tagKey).toBe("awsbridge_team");
    expect(s.rolePath).toBe("/awsbridge-human/");
    expect(s.roles.find((r) => r.name === "readonly")).toEqual({
      name: "readonly",
      roleName: "HumanReadOnly",
      tier: "standard",
      sessionSeconds: 43200,
      managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      inlinePolicyFiles: [],
      teamsParameter: "ReadonlyTeams",
    });
  });

  it("基盤の StackSet: Organization ごとに境界の issuer（Standard・Admin）", () => {
    expect(company().stacksets.providers).toEqual([
      {
        organization: "org-main",
        boundary: "managed",
        issuers: {
          standard: "https://id.example.com/standard",
          admin: "https://id.example.com/admin",
        },
      },
      {
        organization: "partner-x",
        boundary: "partner:partner-x",
        issuers: { standard: "https://id.example.com/partner-x" },
      },
    ]);
  });

  it("種類 × Organization ごとに、ロール → 受け付けるチーム（カンマ区切り。割り当てなしは空文字）", () => {
    const s = company().stacksets;
    expect(s.assignments).toEqual([
      {
        organization: "org-main",
        kind: "A",
        target: { ous: ["ou-abcd-11111111"] },
        parameters: { AdminTeams: "infra-elevated", DeveloperTeams: "", ReadonlyTeams: "sa,infra" },
      },
      {
        organization: "org-main",
        kind: "B",
        target: { ous: ["ou-abcd-22222222"] },
        parameters: {
          AdminTeams: "infra-elevated,dev-elevated",
          DeveloperTeams: "",
          ReadonlyTeams: "sa,infra",
        },
      },
      {
        organization: "org-main",
        kind: "C",
        target: { ous: ["ou-abcd-33333333"] },
        parameters: {
          AdminTeams: "infra-elevated",
          DeveloperTeams: "dev",
          ReadonlyTeams: "sa,infra",
        },
      },
      {
        organization: "partner-x",
        kind: "P",
        target: { accounts: ["222222222222"] },
        parameters: { AdminTeams: "", DeveloperTeams: "dev", ReadonlyTeams: "sa,infra" },
      },
    ]);
  });

  it("AUD・email・Object ID を入れない（AUD がなくても作れる）", () => {
    const s = JSON.stringify(gen(companyConfig(), { mode: "check" }).stacksets);
    expect(s).not.toContain("@");
    expect(s).not.toContain("00000000-0000-4000-8000-");
  });
});

describe("Access の検査用の生成物（Terraform との突き合わせ）", () => {
  it("チームごとの階層・ポリシーの元・AUD と、ポータルのオリジン", () => {
    const a = company().access;
    expect(a.routing).toBe("path");
    expect(a.origins).toEqual({
      standard: "https://portal.example.com",
      admin: "https://admin-portal.example.com",
    });
    expect(a.entryAud).toEqual({ standard: "6".repeat(64), admin: "7".repeat(64) });
    expect(a.teams[0]).toEqual({
      name: "infra",
      tier: "standard",
      groupObjectIds: [uuid(1)],
      aud: "1".repeat(64),
    });
    expect(a.teams.map((t) => t.name)).toEqual([
      "infra",
      "dev",
      "sa",
      "infra-elevated",
      "dev-elevated",
    ]);
  });

  it("手書きの AUD のチームは manualAud: true", () => {
    expect(gen(personalConfig()).access.teams).toEqual([
      { name: "me", tier: "standard", manualAud: true, aud: "a".repeat(64) },
    ]);
  });
});
