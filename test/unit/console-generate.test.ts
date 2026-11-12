// コンソールログインの設定ファイルからの生成（Worker 用・StackSets 用・Access の検査用）。設計: docs/specs/console-login-portal.md §5.2・§9.10・§11.4〜§11.6。
import { describe, expect, it } from "vitest";
import {
  ConsoleConfigError,
  type ConsoleConfigIssue,
  parseConsoleConfig,
} from "../../src/console/config";
import { type ConsoleArtifacts, generateConsoleArtifacts } from "../../src/console/generate";
import {
  companyAuds,
  companyConfig,
  companyInventory,
  personalConfig,
  type Raw,
  uuid,
} from "./console-fixtures";

const AT = "2026-11-11T00:00:00.000Z";

function gen(
  raw: Raw,
  opts: { auds?: Raw; inventory?: Raw; mode?: "check" | "deploy"; sourceRevision?: string } = {},
): ConsoleArtifacts {
  const { config } = parseConsoleConfig(raw);
  return generateConsoleArtifacts(config, {
    mode: opts.mode ?? "deploy",
    generatedAt: AT,
    ...(opts.auds !== undefined ? { auds: opts.auds } : {}),
    ...(opts.inventory !== undefined ? { inventory: opts.inventory } : {}),
    ...(opts.sourceRevision !== undefined ? { sourceRevision: opts.sourceRevision } : {}),
  });
}

function issuesOf(f: () => unknown): ConsoleConfigIssue[] {
  try {
    f();
  } catch (e) {
    if (e instanceof ConsoleConfigError) return e.issues;
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
      roleName: "FederatedViewer",
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
    expect(w?.boundaries).toEqual([
      { name: "managed", issuer: "https://admin-id.example.com/admin" },
    ]);
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
          roleArn: "arn:aws:iam::444444444444:role/awsbridge-console/std/FederatedDeveloper",
          teams: ["dev"],
          sessionSeconds: 28800,
        },
        {
          role: "readonly",
          roleArn: "arn:aws:iam::444444444444:role/awsbridge-console/std/FederatedViewer",
          teams: ["sa", "infra"],
          sessionSeconds: 43200,
        },
      ],
    });
    const admin = company().worker.admin;
    expect(admin?.accounts.find((a) => a.accountId === "444444444444")?.roles).toEqual([
      {
        role: "admin",
        roleArn: "arn:aws:iam::444444444444:role/awsbridge-console/admin/FederatedAdministrator",
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
      "FederatedAdministrator",
      "infra-elevated",
      "dev-elevated",
      "4".repeat(64),
      "7".repeat(64),
      "https://admin-id.example.com/admin",
    ]) {
      expect(s, leak).not.toContain(leak);
    }
    for (const leak of [
      "FederatedViewer",
      "FederatedDeveloper",
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

describe("Worker 用の生成物: 契約の印（purpose）と SourceIdentity の出どころ", () => {
  it("purpose は issue。SourceIdentity の出どころは既定 email で、設定の値が両方の階層に入る", () => {
    const r = company();
    expect(r.worker.standard.purpose).toBe("issue");
    expect(r.worker.admin?.purpose).toBe("issue");
    expect(r.worker.standard.identity).toEqual({ sourceIdentity: "email" });
    expect(r.worker.admin?.identity).toEqual({ sourceIdentity: "email" });
    const c = companyConfig();
    c.identity = { sourceIdentity: "custom.employee_id" };
    const custom = gen(c, { auds: companyAuds(), inventory: companyInventory() });
    expect(custom.worker.standard.identity).toEqual({ sourceIdentity: "custom.employee_id" });
    expect(custom.worker.admin?.identity).toEqual({ sourceIdentity: "custom.employee_id" });
  });
});

describe("表示用の生成物（display.standard.json。U2・P1'）", () => {
  const display = () => company().display;

  it("Standard のデプロイにだけ渡す表示用の印と、遷移先のオリジンを持つ", () => {
    expect(display()).toMatchObject({
      schemaVersion: 1,
      purpose: "display",
      tier: "standard",
      generatedAt: AT,
      sourceRevision: "abc",
      portal: {
        origin: "https://portal.example.com",
        adminOrigin: "https://admin-portal.example.com",
        routing: "path",
        supportUrl: "https://support.example.com/aws",
      },
    });
  });

  it("Administrator の行（表示用だけ）を持つ。アカウント・ロール・チームはあるが、email と roleArn はない", () => {
    const rows = display().accounts.filter((a) => a.tier === "admin");
    expect(rows.map((a) => a.accountId)).toEqual(["333333333333", "444444444444"]);
    expect(rows[1]).toEqual({
      tier: "admin",
      accountId: "444444444444",
      name: "svc-c-dev",
      orgLabel: "org-main",
      boundary: "managed",
      kind: "C",
      roles: [{ role: "admin", teams: ["infra-elevated"], sessionSeconds: 3600 }],
    });
    for (const r of rows) expect("email" in r).toBe(false);
    expect(display().roles.find((r) => r.name === "admin")).toEqual({
      name: "admin",
      displayName: "Admin",
      tier: "admin",
      sessionSeconds: 3600,
    });
    expect(display().teams.filter((t) => t.tier === "admin")).toEqual([
      { name: "infra-elevated", displayName: "infra-elevated", tier: "admin" },
      { name: "dev-elevated", displayName: "dev-elevated", tier: "admin" },
    ]);
  });

  it("Standard の行は Worker 用と同じアカウントと email を持つ（email の規則は Standard と同じ）", () => {
    const rows = display().accounts.filter((a) => a.tier === "standard");
    expect(rows.map((a) => a.accountId)).toEqual(["333333333333", "444444444444", "222222222222"]);
    expect(rows[0]?.email).toBe("aws+svc-a-prod@example.com");
    expect(rows[1]?.roles).toEqual([
      { role: "developer", teams: ["dev"], sessionSeconds: 28800 },
      { role: "readonly", teams: ["sa", "infra"], sessionSeconds: 43200 },
    ]);
    const c = companyConfig();
    c.inventory = { accountEmail: { managed: "hidden", partner: "masked" } };
    const hidden = gen(c, { auds: companyAuds(), inventory: companyInventory() }).display;
    expect(JSON.stringify(hidden)).not.toContain("aws+svc-a-prod");
    expect(hidden.accounts.find((a) => a.accountId === "222222222222")?.email).toBe(
      "aw***@example.org",
    );
  });

  it("Entra グループの Object ID → チームの対応表を持つ（Standard・Admin の両方。小文字にそろえる。同じグループを持つチームはまとめる）", () => {
    const g = display().groups;
    expect(g).toEqual([
      { objectId: uuid(1), teams: ["infra"] },
      { objectId: uuid(2), teams: ["dev"] },
      { objectId: uuid(3), teams: ["sa"] },
      { objectId: uuid(4), teams: ["infra-elevated"] },
      { objectId: uuid(5), teams: ["dev-elevated"] },
    ]);
    const c = companyConfig();
    c.teams[0].access = { groupObjectIds: [uuid(1).toUpperCase()] };
    c.teams[1].access = { groupObjectIds: [uuid(1), uuid(2)] };
    const merged = gen(c, { auds: companyAuds(), inventory: companyInventory() }).display.groups;
    expect(merged).toContainEqual({ objectId: uuid(1), teams: ["infra", "dev"] });
    expect(merged).toContainEqual({ objectId: uuid(2), teams: ["dev"] });
    expect(merged.every((x) => x.objectId === x.objectId.toLowerCase())).toBe(true);
  });

  it("policyIds・手書きの AUD のチームはグループの対応表に入らない", () => {
    const c = companyConfig();
    c.teams[2].access = { policyIds: [uuid(77)] };
    const r = gen(c, { auds: companyAuds(), inventory: companyInventory() });
    expect(r.display.groups.flatMap((x) => x.teams)).not.toContain("sa");
    expect(JSON.stringify(r.display)).not.toContain(uuid(77));
    const p = gen(personalConfig()).display;
    expect(p.groups).toEqual([]);
    expect(p.teams).toEqual([{ name: "me", displayName: "自分", tier: "standard" }]);
  });

  it("AUD・Access のポリシー ID・issuer・タグのキー・roleArn・種類の定義・権限ポリシーを持たない（Admin のチームの AUD も）", () => {
    const c = companyConfig();
    c.teams[2].access = { policyIds: [uuid(77)] };
    const auds = companyAuds();
    const all = JSON.stringify(gen(c, { auds, inventory: companyInventory() }).display);
    for (const aud of [...Object.values(auds.teams), ...Object.values(auds.entry)])
      expect(all, String(aud)).not.toContain(aud as string);
    for (const leak of [
      '"aud"',
      "entryAud",
      "policyIds",
      uuid(77),
      "https://id.example.com",
      "awsbridge_team",
      "roleArn",
      "arn:aws:iam::",
      "FederatedAdministrator",
      "kinds",
      "assign",
      "kindOus",
      "inventoryRoleArn",
      "ou-abcd-",
      "sourceIdentity",
    ])
      expect(all, leak).not.toContain(leak);
  });

  it("手書きの AUD だけの構成でも、AUD は表示用に出ない", () => {
    const all = JSON.stringify(gen(personalConfig()).display);
    expect(all).not.toContain("a".repeat(64));
  });

  it("check（AUD なし）でも作れる。個人用（Admin なし）には Administrator の行も adminOrigin もない", () => {
    const r = gen(personalConfig(), { mode: "check" });
    expect(r.display.accounts.every((a) => a.tier === "standard")).toBe(true);
    expect(r.display.portal.adminOrigin).toBeUndefined();
    expect(gen(companyConfig(), { mode: "check" }).display.purpose).toBe("display");
  });

  it("Worker 用の Standard の生成物には、Administrator の行も Object ID も入らない（発行用と表示用は別のファイル）", () => {
    const s = JSON.stringify(company().worker.standard);
    expect(s).not.toContain("00000000-0000-4000-8000-");
    expect(s).not.toContain('"tier":"admin"');
    expect(s).not.toContain("infra-elevated");
  });
});

describe("アカウントの email（inventory.accountEmail。§5.6）", () => {
  const emailOf = (r: ConsoleArtifacts, id: string) =>
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

  it("deploy: Standard はチームが 2 つ以上なら入口の AUD が要る（なければ entry_aud_missing）", () => {
    const auds = companyAuds();
    delete auds.entry;
    expect(issuesOf(() => gen(companyConfig(), { auds }))).toContainEqual(
      issue("portal.entryAud.standard", "entry_aud_missing"),
    );
  });

  it("deploy: Admin のチームが 2 つ以上でも admin の入口の AUD は要らない（G-6 が決まるまで。entry_aud_missing にしない）", () => {
    const auds = companyAuds();
    delete auds.entry.admin;
    // 会社用の設定は Admin のチームが 2 つ（infra-elevated・dev-elevated）
    const c = companyConfig();
    expect(c.teams.filter((t: Raw) => t.tier === "admin")).toHaveLength(2);
    const r = gen(c, { auds });
    expect(r.worker.admin?.portal.entryAud).toBeUndefined();
    // 入口の AUD を全部省いても、誤りは Standard の分だけ
    delete auds.entry;
    const found = issuesOf(() => gen(companyConfig(), { auds }));
    expect(found).toContainEqual(issue("portal.entryAud.standard", "entry_aud_missing"));
    expect(found).not.toContainEqual(issue("portal.entryAud.admin", "entry_aud_missing"));
  });

  it("admin の入口の AUD を渡したときは、これまでどおり Admin の生成物に入る（受け付ける。重複は誤り）", () => {
    expect(company().worker.admin?.portal.entryAud).toBe("7".repeat(64));
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
    expect(s.audience).toBe("awsbridge-console");
    // SCP・aws:PrincipalArn で「コンソールログイン用すべて」を止めるための接頭辞と、ロールごとの階層のパス（P-2）
    expect(s.rolePathPrefix).toBe("/awsbridge-console/");
    expect(s).not.toHaveProperty("rolePath");
    expect(s.roles.find((r) => r.name === "admin")?.rolePath).toBe("/awsbridge-console/admin/");
    expect(s.roles.find((r) => r.name === "readonly")).toEqual({
      name: "readonly",
      roleName: "FederatedViewer",
      tier: "standard",
      rolePath: "/awsbridge-console/std/",
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
          admin: "https://admin-id.example.com/admin",
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

describe("署名を置くアカウント（signing.accountIds。cto の決裁 (5)(b)）", () => {
  it("インベントリで種類の OU に入るアカウントが署名を置くアカウントなら誤り（停止中でも配る先なので誤り）", () => {
    for (const id of ["333333333333", "555555555555"]) {
      const c = companyConfig();
      c.signing = { accountIds: [id] };
      const found = issuesOf(() => gen(c, { auds: companyAuds(), inventory: companyInventory() }));
      expect(found, id).toContainEqual(
        issue(`inventory.org-main[${id === "333333333333" ? 0 : 2}].accountId`, "signing_account"),
      );
      expect(JSON.stringify(found)).not.toContain(id);
    }
  });

  it("どの種類の OU にも入らないアカウント（配る先でない）なら誤りにしない", () => {
    const c = companyConfig();
    c.signing = { accountIds: ["666666666666"] };
    expect(() => gen(c, { auds: companyAuds(), inventory: companyInventory() })).not.toThrow();
  });
});
