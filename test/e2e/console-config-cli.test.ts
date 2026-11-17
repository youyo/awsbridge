// コンソールログインの設定の CLI（scripts/console/config.ts。mise タスク console:config:check / console:config:generate）を実プロセスで動かし、
// 終了コード・出力・生成物を確かめる。入力と出力は一時ディレクトリに置き、リポジトリの中には書かない。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseConsoleConfig } from "../../src/console/config";
import { buildKindTemplate } from "../../src/console/template";
import {
  companyAuds,
  companyConfig,
  companyInventory,
  personalConfig,
} from "../unit/console-fixtures";

const root = new URL("../../", import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-console-cli-"));
  dirs.push(d);
  return d;
}

function run(cmd: string, env: Record<string, string>, cwd = root) {
  return spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "scripts/console/config.ts"), cmd],
    {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    },
  );
}

function write(d: string, name: string, value: unknown): string {
  const p = join(d, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

describe("console:config:check", () => {
  it("会社用の設定を AUD なしで検査して終了コード 0。生成物は書かない", () => {
    const d = tmp();
    const r = run("check", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_OUT_DIR: join(d, "out"),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(existsSync(join(d, "out"))).toBe(false);
  });

  it("誤りがあれば終了コード 1 で、キーのパスと種別だけを出す（値を出さない）", () => {
    const d = tmp();
    const c = companyConfig();
    c.portal.origin = "https://secret-portal.example.workers.dev";
    c.kinds[0].assign.admin.push("infra");
    c.organizations[1].accounts[0].email = "leak@example.org";
    c.organizations[1].accounts.push({ ...c.organizations[1].accounts[0] });
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("portal.origin: workers_dev");
    expect(r.stderr).toContain("kinds[0].assign.admin[1]: tier_mismatch");
    expect(r.stderr).toContain("organizations[1].accounts[1].accountId: duplicate");
    expect(r.stderr + r.stdout).not.toContain("secret-portal");
    expect(r.stderr + r.stdout).not.toContain("leak@");
    expect(r.stderr + r.stdout).not.toContain("222222222222");
  });

  it("issuer のホストがポータルのホストと同じ・入れ子なら終了コード 1（G-8）。generate も何も書かない", () => {
    const d = tmp();
    const c = companyConfig();
    c.boundaries[0].issuer = "https://portal.example.com/console";
    c.boundaries[1].issuer = "https://id.portal.example.com/p/partner-x/console";
    const file = write(d, "console.json", c);
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: file });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("boundaries[0].issuer: issuer_host_overlaps_portal");
    expect(r.stderr).toContain("boundaries[1].issuer: issuer_host_overlaps_portal");
    expect(r.stderr + r.stdout).not.toContain("portal.example.com");
    const out = join(d, "out");
    const g = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: file,
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_INVENTORY_FILE: write(d, "inventory.json", companyInventory()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(g.status).toBe(1);
    expect(g.stderr).toContain("issuer_host_overlaps_portal");
    expect(existsSync(out)).toBe(false);
  });

  it("Admin のロールの sessionSeconds が 3600 を超えれば終了コード 1（admin_session_seconds）。generate も何も書かない", () => {
    const d = tmp();
    const c = companyConfig();
    c.roles[0].sessionSeconds = 7200; // roles[0] は Admin の階層
    const file = write(d, "console.json", c);
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: file });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("roles[0].sessionSeconds: admin_session_seconds");
    const out = join(d, "out");
    const g = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: file,
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(g.status).toBe(1);
    expect(g.stderr).toContain("admin_session_seconds");
    expect(existsSync(out)).toBe(false);
  });

  it("AUD のファイルを渡すと、AUD の対応（欠落・食い違い）まで検査する", () => {
    const d = tmp();
    const auds = companyAuds();
    delete auds.teams.sa;
    const r = run("check", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", auds),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("teams[2].access: aud_missing");
    expect(r.stderr + r.stdout).not.toContain("1".repeat(64));
  });

  it("警告は出すが終了コードは 0", () => {
    const d = tmp();
    const c = companyConfig();
    for (const k of c.kinds) delete k.assign.developer;
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("warning: teams[1]: unassigned_team");
  });

  it("設定ファイルがなければ終了コード 1", () => {
    const d = tmp();
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: join(d, "nothing.json") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("設定ファイルがありません");
  });

  it("未知のサブコマンドは終了コード 1", () => {
    expect(run("nope", {}).status).toBe(1);
  });
});

describe("設定の例（config/console*.example.json）を CLI に通す", () => {
  it("個人用の例から、発行用の生成物（worker.json）に FederatedAwsBridgeViewer の行だけが出る", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: join(root, "config/console.example.json"),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    // 初回は前回の生成物が無いので、台帳を比べられない旨の警告だけ
    expect(r.stderr.trim().split("\n")).toEqual(["warning: previous: ledger_previous_missing"]);
    const worker = JSON.parse(readFileSync(join(out, "worker.json"), "utf8"));
    const arns = worker.accounts.flatMap((a: { roles: { roleArn: string }[] }) =>
      a.roles.map((x) => x.roleArn),
    );
    expect(arns).toEqual([
      "arn:aws:iam::111111111111:role/awsbridge-console/std/FederatedAwsBridgeViewer",
    ]);
    expect(existsSync(join(out, "worker.admin.json"))).toBe(false);
    // 2 回目は前回の台帳と比べるので警告なし
    const again = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: join(root, "config/console.example.json"),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).not.toContain("warning");
  });

  it("会社用の例（Admin のチームが 2 つ）を deploy 生成できる。1 つの発行用の生成物に両階層があり、表示用に AUD が無い", () => {
    const d = tmp();
    const out = join(d, "out");
    const teamAuds = Object.fromEntries(
      ["infra", "dev", "sa", "infra-elevated", "dev-elevated"].map((t, i) => [
        t,
        String(i + 1).repeat(64),
      ]),
    );
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: join(root, "config/console.company.example.json"),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", { teams: teamAuds, entry: "a".repeat(64) }),
      // org-main は placement: ou なので、種類 A の OU（Administrator と Viewer を割り当てた種類）にアカウントを 1 つ置く
      AWSBRIDGE_CONSOLE_INVENTORY_FILE: write(d, "inventory.json", {
        "org-main": [
          {
            accountId: "333333333333",
            name: "svc-a-prod",
            ouPath: ["r-abcd", "ou-abcd-11111111"],
          },
        ],
      }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("entry_aud_missing");
    const stacksets = JSON.parse(readFileSync(join(out, "stacksets.json"), "utf8"));
    expect(
      stacksets.roles.map((x: { roleName: string; rolePath: string }) => [x.roleName, x.rolePath]),
    ).toEqual([
      ["FederatedAwsBridgeAdministrator", "/awsbridge-console/admin/"],
      ["FederatedAwsBridgeViewer", "/awsbridge-console/std/"],
    ]);
    expect(stacksets.providers.map((x: { issuer: string }) => x.issuer)).toEqual([
      "https://awsbridge-oidc-console.example.com/console",
      "https://awsbridge-oidc-console.example.com/p/p01/console",
    ]);

    // 表示用: Administrator の行と Object ID の対応がある
    const display = JSON.parse(readFileSync(join(out, "display.json"), "utf8"));
    expect(display.purpose).toBe("display");
    expect(display.accounts.filter((a: { tier: string }) => a.tier === "admin")).not.toHaveLength(
      0,
    );
    expect(display.groups).toContainEqual({
      objectId: "00000000-0000-0000-0000-000000000004",
      teams: ["infra-elevated"],
    });
    // 表示用には AUD が無い。発行用には両階層のチームの AUD があり、Object ID は無い
    const worker = readFileSync(join(out, "worker.json"), "utf8");
    const shown = readFileSync(join(out, "display.json"), "utf8");
    for (const aud of Object.values(teamAuds)) {
      expect(shown, "display.json").not.toContain(aud);
      expect(worker, "worker.json").toContain(aud);
    }
    expect(worker).toContain("FederatedAwsBridgeAdministrator");
    expect(worker).not.toContain("00000000-0000-0000-0000-");
    const w = JSON.parse(worker);
    expect(w.identity).toEqual({ sourceIdentity: "email" });
    expect(w.teams.map((t: { name: string; tier: string }) => [t.name, t.tier])).toContainEqual([
      "infra-elevated",
      "admin",
    ]);
  });
});

describe("console:config:generate", () => {
  it("会社用: 発行用（worker.json）・表示用（display.json）・StackSets 用・Access の検査用を書く（他人に読めない権限で）", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_INVENTORY_FILE: write(d, "inventory.json", companyInventory()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
      AWSBRIDGE_CONSOLE_SOURCE_REVISION: "deadbeef",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "access.json",
      "display.json",
      "kind.A.yaml",
      "kind.B.yaml",
      "kind.C.yaml",
      "kind.P.yaml",
      "stacksets.json",
      "worker.json",
    ]);
    for (const f of readdirSync(out)) expect(statSync(join(out, f)).mode & 0o077, f).toBe(0);
    const worker = JSON.parse(readFileSync(join(out, "worker.json"), "utf8"));
    expect(worker.schemaVersion).toBe(2);
    expect(worker).not.toHaveProperty("tier");
    expect(worker.sourceRevision).toBe("deadbeef");
    expect(worker.teams.map((t: { name: string }) => t.name)).toEqual([
      "infra",
      "dev",
      "sa",
      "infra-elevated",
      "dev-elevated",
    ]);
    expect(worker.accounts.length).toBe(3);
    expect(worker.purpose).toBe("issue");
    expect(worker.identity).toEqual({ sourceIdentity: "email" });
    const display = JSON.parse(readFileSync(join(out, "display.json"), "utf8"));
    expect(display.purpose).toBe("display");
    expect(display.sourceRevision).toBe("deadbeef");
    expect(display.accounts.some((a: { tier: string }) => a.tier === "admin")).toBe(true);
    // ロールの ARN はロールの階層のパス（P-2）
    type Row = { role: string; roleArn: string };
    const rows: Row[] = worker.accounts.flatMap((a: { roles: Row[] }) => a.roles);
    const tierOf = new Map(
      worker.roles.map((x: { name: string; tier: string }) => [x.name, x.tier]),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const seg = tierOf.get(row.role) === "admin" ? "admin" : "std";
      expect(row.roleArn).toMatch(
        new RegExp(`^arn:aws:iam::\\d{12}:role/awsbridge-console/${seg}/[^/]+$`),
      );
    }
    const stacksets = JSON.parse(readFileSync(join(out, "stacksets.json"), "utf8"));
    expect(stacksets.assignments).toHaveLength(4);
    expect(stacksets.audience).toBe("awsbridge-console");
    expect(stacksets.rolePathPrefix).toBe("/awsbridge-console/");
    const access = JSON.parse(readFileSync(join(out, "access.json"), "utf8"));
    expect(access.origin).toBe("https://portal.example.com");
    expect(access.entryAud).toBe("6".repeat(64));
    // 出力にパスは出してよいが、AUD・email は出さない
    expect(r.stdout).toContain("worker.json");
    expect(r.stdout).not.toContain("1".repeat(64));
    expect(r.stdout).not.toContain("@example");
  });

  it("個人用: 同じ 4 つの生成物を書く（階層ごとのファイルは作らない）", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", personalConfig()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "access.json",
      "display.json",
      "kind.default.yaml",
      "stacksets.json",
      "worker.json",
    ]);
  });

  it("前回の階層ごとの生成物（worker.standard.json・worker.admin.json・display.standard.json）が残っていれば消す", () => {
    const d = tmp();
    const out = join(d, "out");
    mkdirSync(out, { recursive: true });
    for (const old of ["worker.standard.json", "worker.admin.json", "display.standard.json"])
      writeFileSync(join(out, old), "{}");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    for (const old of ["worker.standard.json", "worker.admin.json", "display.standard.json"])
      expect(existsSync(join(out, old)), old).toBe(false);
    expect(existsSync(join(out, "worker.json"))).toBe(true);
  });

  it("schemaVersion 1 の設定は終了コード 1 で、新しいキーを案内する（黙って読み替えない）。何も書かない", () => {
    const d = tmp();
    const out = join(d, "out");
    const c = companyConfig();
    c.schemaVersion = 1;
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("schemaVersion: schema_version");
    expect(r.stderr).toContain("portal.origin");
    expect(r.stderr).toContain("boundaries[].issuer");
    expect(existsSync(out)).toBe(false);
  });

  it("退役したチーム名の台帳: 前回の台帳から名前を消すと終了コード 1（retired_team_removed）で、何も書き換えない", () => {
    const d = tmp();
    const out = join(d, "out");
    const c = companyConfig();
    c.retiredTeams = [{ name: "ops", tier: "standard" }];
    const base = {
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    };
    expect(
      run("generate", { ...base, AWSBRIDGE_CONSOLE_CONFIG: write(d, "c1.json", c) }).status,
    ).toBe(0);
    const before = readFileSync(join(out, "stacksets.json"), "utf8");
    c.retiredTeams = [];
    const r = run("generate", { ...base, AWSBRIDGE_CONSOLE_CONFIG: write(d, "c2.json", c) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("retiredTeams: retired_team_removed");
    expect(readFileSync(join(out, "stacksets.json"), "utf8")).toBe(before);
    // check も同じ前回の生成物と比べる
    const chk = run("check", { ...base, AWSBRIDGE_CONSOLE_CONFIG: join(d, "c2.json") });
    expect(chk.status).toBe(1);
    expect(chk.stderr).toContain("retired_team_removed");
  });

  it("AUD が足りなければ終了コード 1 で、何も書かない", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("teams[0].access: aud_missing");
    expect(existsSync(out)).toBe(false);
  });

  it("AUD・インベントリのファイルが JSON として読めなければ終了コード 1", () => {
    const d = tmp();
    writeFileSync(join(d, "auds.json"), "{");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: join(d, "auds.json"),
      AWSBRIDGE_CONSOLE_OUT_DIR: join(d, "out"),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("auds: json");
  });
});

describe("console:config:generate: ロールのテンプレート（種類の StackSet。参考の形）", () => {
  it("種類ごとに kind.<kind>.yaml を書く。中身は生成器の出力で、パラメーターは stacksets.json と対応する", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("kind.C.yaml");
    const tpl = parse(readFileSync(join(out, "kind.C.yaml"), "utf8"), { customTags: [] });
    expect(tpl).toEqual(buildKindTemplate(parseConsoleConfig(companyConfig()).config, "C"));
    const stacksets = JSON.parse(readFileSync(join(out, "stacksets.json"), "utf8"));
    const c = stacksets.assignments.find((a: { kind: string }) => a.kind === "C");
    for (const k of Object.keys(c.parameters)) expect(tpl.Parameters[k], k).toBeDefined();
  });

  it("Admin のロールの MaxSessionDuration は sessionSeconds（1800）によらず 3600。Worker の生成物の sessionSeconds は 1800 のまま", () => {
    const d = tmp();
    const out = join(d, "out");
    const c = companyConfig();
    c.roles[0].sessionSeconds = 1800; // roles[0] は Admin の階層（name: admin）
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    const tpl = parse(readFileSync(join(out, "kind.C.yaml"), "utf8"), { customTags: [] });
    expect(tpl.Resources.AdminRole.Properties.MaxSessionDuration).toBe(3600);
    expect(tpl.Resources.ReadonlyRole.Properties.MaxSessionDuration).toBe(43200);
    const worker = JSON.parse(readFileSync(join(out, "worker.json"), "utf8"));
    expect(worker.roles.find((x: { name: string }) => x.name === "admin").sessionSeconds).toBe(
      1800,
    );
  });

  it("前回の種類のテンプレートが残っていても、設定から消えた種類のものは消す", () => {
    const d = tmp();
    const out = join(d, "out");
    const env = {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    };
    expect(run("generate", env).status).toBe(0);
    // 消したチームは台帳へ移す（移さなければ team_removed_not_retired で止まる）
    const personal = personalConfig();
    personal.retiredTeams = companyConfig().teams.map((t: { name: string; tier?: string }) => ({
      name: t.name,
      tier: t.tier ?? "standard",
    }));
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console2.json", personal),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).filter((f) => f.startsWith("kind."))).toEqual(["kind.default.yaml"]);
  });

  it("下流のポリシー文書（inlinePolicyFiles）は作業ディレクトリからの相対パスで読み、テンプレートに入れる", () => {
    const d = tmp();
    const c = personalConfig();
    c.roles[0].permissions.inlinePolicyFiles = ["policies/extra.json"];
    mkdirSync(join(d, "policies"));
    const extra = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "ce:GetCostAndUsage", Resource: "*" }],
    };
    write(d, "policies/extra.json", extra);
    const out = join(d, "out");
    const r = run(
      "generate",
      { AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c), AWSBRIDGE_CONSOLE_OUT_DIR: out },
      d,
    );
    expect(r.status, r.stderr).toBe(0);
    const tpl = parse(readFileSync(join(out, "kind.default.yaml"), "utf8"), { customTags: [] });
    expect(
      tpl.Resources.ReadonlyRole.Properties.Policies.find(
        (p: { PolicyName: string }) => p.PolicyName === "InlinePolicy1",
      ).PolicyDocument,
    ).toEqual(extra);
  });

  it("下流のポリシー文書がない・JSON でなければ、check でも終了コード 1（パスと種別だけ）", () => {
    const d = tmp();
    const c = personalConfig();
    c.roles[0].permissions.inlinePolicyFiles = ["policies/none.json", "policies/bad.json"];
    mkdirSync(join(d, "policies"));
    writeFileSync(join(d, "policies/bad.json"), "{");
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c) }, d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("roles[0].permissions.inlinePolicyFiles[0]: required");
    expect(r.stderr).toContain("roles[0].permissions.inlinePolicyFiles[1]: json");
  });

  it("署名を置くアカウントを配る先に含めたら終了コード 1 で、何も書かず、アカウント ID を出さない", () => {
    const d = tmp();
    const out = join(d, "out");
    const c = personalConfig();
    c.signing = { accountIds: ["111111111111"] };
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("organizations[0].accounts[0].accountId: signing_account");
    expect(r.stderr + r.stdout).not.toContain("111111111111");
    expect(existsSync(out)).toBe(false);
  });
});
