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
  opts: {
    auds?: Raw;
    inventory?: Raw;
    mode?: "check" | "deploy";
    sourceRevision?: string;
    previous?: Raw;
  } = {},
): ConsoleArtifacts {
  const { config } = parseConsoleConfig(raw);
  return generateConsoleArtifacts(config, {
    mode: opts.mode ?? "deploy",
    generatedAt: AT,
    ...(opts.auds !== undefined ? { auds: opts.auds } : {}),
    ...(opts.inventory !== undefined ? { inventory: opts.inventory } : {}),
    ...(opts.sourceRevision !== undefined ? { sourceRevision: opts.sourceRevision } : {}),
    // 台帳の前回の生成物（stacksets.json）。省いた試験では、台帳の検査は「前回なし」の警告だけ
    ...(opts.previous !== undefined ? { previous: opts.previous } : {}),
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

// P2（B）: 発行用の生成物は 1 つ（worker.json）。両階層のチーム・ロール・行を持ち、チームとロールに tier を付ける
describe("Worker 用の生成物（1 つ。P2）", () => {
  it("1 つの生成物に両階層のチーム（AUD・tier つき）・ロール（tier つき）・境界の issuer・ポータルの値を持つ", () => {
    const w = company().worker;
    expect(w).toMatchObject({
      schemaVersion: 2,
      generatedAt: AT,
      sourceRevision: "abc",
      tagKey: "awsbridge_team",
      portal: {
        origin: "https://portal.example.com",
        routing: "path",
        regions: { allowed: ["ap-northeast-1", "us-east-1"], default: "ap-northeast-1" },
        supportUrl: "https://support.example.com/aws",
        entryAud: "6".repeat(64),
      },
    });
    // 階層はデプロイではなくチームとロールに付く（Worker は要求ごとにパスのチームの階層で決める）
    expect(w).not.toHaveProperty("tier");
    expect(w.portal).not.toHaveProperty("peerOrigin");
    expect(w.teams).toEqual([
      { name: "infra", displayName: "インフラ", tier: "standard", aud: "1".repeat(64) },
      { name: "dev", displayName: "開発", tier: "standard", aud: "2".repeat(64) },
      { name: "sa", displayName: "sa", tier: "standard", aud: "3".repeat(64) },
      { name: "infra-elevated", displayName: "infra-elevated", tier: "admin", aud: "4".repeat(64) },
      { name: "dev-elevated", displayName: "dev-elevated", tier: "admin", aud: "5".repeat(64) },
    ]);
    expect(w.roles.map((r) => [r.name, r.tier])).toEqual([
      ["admin", "admin"],
      ["developer", "standard"],
      ["readonly", "standard"],
    ]);
    expect(w.roles[2]).toEqual({
      name: "readonly",
      roleName: "FederatedViewer",
      displayName: "readonly",
      tier: "standard",
      sessionSeconds: 43200,
    });
    // 境界ごとに issuer は 1 つ（階層をまたいで同じ）
    expect(w.boundaries).toEqual([
      { name: "managed", issuer: "https://id.example.com/console" },
      { name: "partner:partner-x", issuer: "https://id.example.com/p/partner-x/console" },
    ]);
  });

  it("一覧の行: 種類の割り当てを展開し、両階層のロールを入れる（ARN のパスはロールの階層）", () => {
    const w = company().worker;
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
          role: "admin",
          roleArn: "arn:aws:iam::444444444444:role/awsbridge-console/admin/FederatedAdministrator",
          teams: ["infra-elevated"],
          sessionSeconds: 3600,
        },
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
  });

  it("行のチームはすべてその行のロールと同じ階層（row_team_tier を生成器でも作らない）", () => {
    const w = company().worker;
    const teamTier = new Map(w.teams.map((t) => [t.name, t.tier]));
    const roleTier = new Map(w.roles.map((r) => [r.name, r.tier]));
    for (const a of w.accounts)
      for (const r of a.roles)
        for (const t of r.teams)
          expect(teamTier.get(t), `${a.accountId}:${r.role}:${t}`).toBe(roleTier.get(r.role));
  });

  it("Admin の階層のロールの行は managed の境界にだけある（admin_boundary）", () => {
    const w = company().worker;
    for (const a of w.accounts)
      if (a.roles.some((r) => r.role === "admin")) expect(a.boundary).toBe("managed");
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
    // 退役したチーム名の台帳は発行用に入れない
    expect(all).not.toContain("retiredTeams");
  });

  it("停止中のアカウントは出さず、どの種類の OU にも属さないアカウントは出さずに件数を警告する", () => {
    const r = company();
    const ids = r.worker.accounts.map((a) => a.accountId);
    expect(ids).toEqual(["333333333333", "444444444444", "222222222222"]);
    expect(r.warnings).toContainEqual(
      expect.objectContaining({
        path: "inventory.org-main",
        code: "unassigned_accounts",
        count: 1,
      }),
    );
  });

  it("ロールが 1 つもないアカウントの行は入れない", () => {
    const c = companyConfig();
    c.kinds[3].assign = { readonly: ["sa"] };
    c.organizations[1].accounts.push({ accountId: "777777777777", name: "x", kind: "A" });
    c.kinds[0].assign = {};
    const ids = gen(c, { auds: companyAuds(), inventory: companyInventory() }).worker.accounts.map(
      (a) => a.accountId,
    );
    expect(ids).not.toContain("333333333333");
    expect(ids).not.toContain("777777777777");
  });

  it("placement: ou の Organization のインベントリがなければ行を作らず警告する", () => {
    const r = gen(companyConfig(), { auds: companyAuds() });
    expect(r.worker.accounts.map((a) => a.accountId)).toEqual(["222222222222"]);
    expect(r.warnings).toContainEqual(issue("inventory.org-main", "inventory_missing"));
  });

  it("organizations には行に現れる Organization の表示名だけを入れる", () => {
    expect(company().worker.organizations).toEqual([
      { name: "org-main", displayName: "本体" },
      { name: "partner-x", displayName: "先方 X" },
    ]);
  });
});

describe("Worker 用の生成物: 契約の印（purpose）と SourceIdentity の出どころ", () => {
  it("purpose は issue。SourceIdentity の出どころは既定 email で、設定の値が入る", () => {
    const r = company();
    expect(r.worker.purpose).toBe("issue");
    expect(r.worker.identity).toEqual({ sourceIdentity: "email" });
    const c = companyConfig();
    c.identity = { sourceIdentity: "custom.employee_id" };
    const custom = gen(c, { auds: companyAuds(), inventory: companyInventory() });
    expect(custom.worker.identity).toEqual({ sourceIdentity: "custom.employee_id" });
  });
});

describe("表示用の生成物（display.json。U2）", () => {
  const display = () => company().display;

  it("表示用の印と、同じオリジンを持つ（Admin のオリジンは無い）", () => {
    expect(display()).toMatchObject({
      schemaVersion: 2,
      purpose: "display",
      generatedAt: AT,
      sourceRevision: "abc",
      portal: {
        origin: "https://portal.example.com",
        routing: "path",
        supportUrl: "https://support.example.com/aws",
      },
    });
    expect(display().portal).not.toHaveProperty("adminOrigin");
    expect(display()).not.toHaveProperty("tier");
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

  it("AUD・Access のポリシー ID・issuer・タグのキー・roleArn・種類の定義・権限ポリシー・台帳を持たない（Admin のチームの AUD も）", () => {
    const c = companyConfig();
    c.teams[2].access = { policyIds: [uuid(77)] };
    c.retiredTeams = [{ name: "ops", tier: "standard" }];
    const auds = companyAuds();
    const all = JSON.stringify(gen(c, { auds, inventory: companyInventory() }).display);
    for (const aud of [...Object.values(auds.teams), auds.entry])
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
      "retiredTeams",
      '"ops"',
    ])
      expect(all, leak).not.toContain(leak);
  });

  it("手書きの AUD だけの構成でも、AUD は表示用に出ない", () => {
    const all = JSON.stringify(gen(personalConfig()).display);
    expect(all).not.toContain("a".repeat(64));
  });

  it("check（AUD なし）でも作れる。個人用（Admin なし）には Administrator の行が無い", () => {
    const r = gen(personalConfig(), { mode: "check" });
    expect(r.display.accounts.every((a) => a.tier === "standard")).toBe(true);
    expect(gen(companyConfig(), { mode: "check" }).display.purpose).toBe("display");
  });

  it("発行用の生成物には Object ID が入らない（発行用と表示用は別のファイル）", () => {
    const s = JSON.stringify(company().worker);
    expect(s).not.toContain("00000000-0000-4000-8000-");
  });
});

describe("アカウントの email（inventory.accountEmail。§5.6）", () => {
  const emailOf = (r: ConsoleArtifacts, id: string) =>
    r.worker.accounts.find((a) => a.accountId === id)?.email;

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
    const partner = r.worker.accounts.find((a) => a.accountId === "222222222222");
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

  it("deploy: Standard の階層のチームが 2 つ以上なら入口の AUD が要る（なければ entry_aud_missing。ポータルの流れの決裁）", () => {
    const auds = companyAuds();
    delete auds.entry;
    expect(issuesOf(() => gen(companyConfig(), { auds }))).toContainEqual(
      issue("portal.entryAud", "entry_aud_missing"),
    );
  });

  it("deploy: Standard の階層のチームが 1 つなら、Admin のチームが 2 つあっても入口の AUD は要らない", () => {
    const c = companyConfig();
    c.teams = c.teams.filter((t: Raw) => t.name !== "dev" && t.name !== "sa");
    c.kinds = [
      { name: "A", assign: { admin: ["infra-elevated", "dev-elevated"], readonly: ["infra"] } },
    ];
    c.organizations[0].kindOus = { A: ["ou-abcd-11111111"] };
    c.organizations.pop();
    c.boundaries.pop();
    c.roles = c.roles.filter((r: Raw) => r.name !== "developer");
    const auds = companyAuds();
    delete auds.entry;
    delete auds.teams.dev;
    delete auds.teams.sa;
    const r = gen(c, { auds });
    expect(r.worker.portal.entryAud).toBeUndefined();
  });

  it("入口の AUD は 1 つの文字列（階層ごとのオブジェクトは type）", () => {
    expect(company().worker.portal.entryAud).toBe("6".repeat(64));
    const auds = companyAuds();
    auds.entry = { standard: "6".repeat(64), admin: "7".repeat(64) };
    expect(issuesOf(() => gen(companyConfig(), { auds }))).toContainEqual(
      issue("auds.entry", "type"),
    );
  });

  it("check: AUD がなくても誤りにしない（PR の検査。§11.5 の順）", () => {
    const r = gen(companyConfig(), { mode: "check" });
    expect(r.worker.teams[0]).toEqual({ name: "infra", displayName: "インフラ", tier: "standard" });
    expect(r.worker.portal.entryAud).toBeUndefined();
  });

  it("手書きの AUD は Terraform の出力がなくても使う（個人用）", () => {
    expect(gen(personalConfig()).worker.teams).toEqual([
      { name: "me", displayName: "自分", tier: "standard", aud: "a".repeat(64) },
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
    auds.entry = auds.teams.sa;
    const found = issuesOf(() => gen(companyConfig(), { auds }));
    expect(found).toContainEqual(issue("auds.teams.dev", "duplicate"));
    expect(found).toContainEqual(issue("auds.entry", "duplicate"));
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

  it("基盤の StackSet: Organization ごとに境界の issuer（1 つ。階層で分けない）", () => {
    expect(company().stacksets.providers).toEqual([
      { organization: "org-main", boundary: "managed", issuer: "https://id.example.com/console" },
      {
        organization: "partner-x",
        boundary: "partner:partner-x",
        issuer: "https://id.example.com/p/partner-x/console",
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
    expect(a.origin).toBe("https://portal.example.com");
    expect(a).not.toHaveProperty("origins");
    expect(a.entryAud).toBe("6".repeat(64));
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

// P2（B）の設計メモ §7.1: 退役したチーム名の台帳。台帳から名前を消せないことを、前回の生成物（stacksets.json の
// teams・retiredTeams）と比べて生成器で守る（cto の決裁 2026-11-17）。生成物は gitignore なので、前回が無いときは警告する。
describe("退役したチーム名の台帳（前回の生成物との比較）", () => {
  const prevOf = (r: ConsoleArtifacts): Raw => JSON.parse(JSON.stringify(r.stacksets));
  const withRetired = (retired: Raw[]) => {
    const c = companyConfig();
    c.retiredTeams = retired;
    return c;
  };
  const opts = () => ({ auds: companyAuds(), inventory: companyInventory() });

  it("StackSets 用の生成物に、今のチームと台帳（name・tier）を持つ", () => {
    const r = gen(withRetired([{ name: "ops", tier: "standard" }]), opts());
    expect(r.stacksets.teams).toEqual([
      { name: "infra", tier: "standard" },
      { name: "dev", tier: "standard" },
      { name: "sa", tier: "standard" },
      { name: "infra-elevated", tier: "admin" },
      { name: "dev-elevated", tier: "admin" },
    ]);
    expect(r.stacksets.retiredTeams).toEqual([{ name: "ops", tier: "standard" }]);
  });

  it("前回の生成物が無ければ ledger_previous_missing の警告（黙って通さない）", () => {
    expect(company().warnings).toContainEqual(issue("previous", "ledger_previous_missing"));
    const withPrev = gen(companyConfig(), { ...opts(), previous: prevOf(company()) });
    expect(withPrev.warnings).not.toContainEqual(issue("previous", "ledger_previous_missing"));
  });

  it("前回の台帳の名前が今の台帳に無ければ retired_team_removed（台帳から名前を消せない）", () => {
    const prev = prevOf(gen(withRetired([{ name: "ops", tier: "standard" }]), opts()));
    expect(issuesOf(() => gen(withRetired([]), { ...opts(), previous: prev }))).toContainEqual(
      issue("retiredTeams", "retired_team_removed"),
    );
    // 台帳に残せば通る（足すのは自由）
    expect(() =>
      gen(
        withRetired([
          { name: "ops", tier: "standard" },
          { name: "qa", tier: "admin" },
        ]),
        {
          ...opts(),
          previous: prev,
        },
      ),
    ).not.toThrow();
  });

  it("前回のチームを消すなら台帳へ移す（移さなければ team_removed_not_retired）", () => {
    const prev = prevOf(company());
    const auds = companyAuds();
    delete auds.teams.sa;
    const noSa = () => ({ auds, inventory: companyInventory(), previous: prev });
    const removed = withRetired([]);
    removed.teams = removed.teams.filter((t: Raw) => t.name !== "sa");
    for (const k of removed.kinds) delete k.assign.readonly;
    expect(issuesOf(() => gen(removed, noSa()))).toEqual([
      issue("teams", "team_removed_not_retired"),
    ]);
    const moved = withRetired([{ name: "sa", tier: "standard" }]);
    moved.teams = moved.teams.filter((t: Raw) => t.name !== "sa");
    for (const k of moved.kinds) delete k.assign.readonly;
    expect(() => gen(moved, noSa())).not.toThrow();
  });

  it("前回と同じ名前のチームの階層を変えたら team_tier_changed（階層を変えるときは新しい名前にする）", () => {
    const prev = prevOf(company());
    const c = companyConfig();
    c.teams[2].tier = "admin"; // sa を Admin に
    c.kinds = c.kinds.map((k: Raw) => ({ ...k, assign: { ...k.assign, readonly: ["infra"] } }));
    c.kinds[0].assign.admin = ["infra-elevated", "sa"];
    expect(issuesOf(() => gen(c, { ...opts(), previous: prev }))).toContainEqual(
      issue("teams[2].tier", "team_tier_changed"),
    );
  });

  it("前回の生成物が壊れていれば ledger_previous（比べられないまま通さない）。値は出さない", () => {
    for (const bad of [[], { teams: "x" }, { teams: [{ name: 1 }] }, { retiredTeams: [{}] }])
      expect(
        issuesOf(() => gen(companyConfig(), { ...opts(), previous: bad })),
        JSON.stringify(bad),
      ).toContainEqual(issue("previous", "ledger_previous"));
  });

  it("前回の生成物に台帳の項目が無い（P2 より前の形）なら、チームだけを比べる", () => {
    const prev = prevOf(company());
    delete prev.retiredTeams;
    expect(() => gen(companyConfig(), { ...opts(), previous: prev })).not.toThrow();
  });
});
