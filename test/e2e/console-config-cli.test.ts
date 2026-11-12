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
    c.portal.standardOrigin = "https://secret-portal.example.workers.dev";
    c.kinds[0].assign.admin.push("infra");
    c.organizations[1].accounts[0].email = "leak@example.org";
    c.organizations[1].accounts.push({ ...c.organizations[1].accounts[0] });
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", c) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("portal.standardOrigin: workers_dev");
    expect(r.stderr).toContain("kinds[0].assign.admin[1]: tier_mismatch");
    expect(r.stderr).toContain("organizations[1].accounts[1].accountId: duplicate");
    expect(r.stderr + r.stdout).not.toContain("secret-portal");
    expect(r.stderr + r.stdout).not.toContain("leak@");
    expect(r.stderr + r.stdout).not.toContain("222222222222");
  });

  it("issuer のホストがポータルのホストと同じ・入れ子なら終了コード 1（G-8）。generate も何も書かない", () => {
    const d = tmp();
    const c = companyConfig();
    c.boundaries[0].issuers.standard = "https://portal.example.com/standard";
    c.boundaries[0].issuers.admin = "https://id.admin-portal.example.com/admin";
    const file = write(d, "console.json", c);
    const r = run("check", { AWSBRIDGE_CONSOLE_CONFIG: file });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("boundaries[0].issuers.standard: issuer_host_overlaps_portal");
    expect(r.stderr).toContain("boundaries[0].issuers.admin: issuer_host_overlaps_portal");
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
  it("個人用の例から、Standard の Worker 用の生成物に FederatedAwsBridgeViewer の行だけが出る", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: join(root, "config/console.example.json"),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("warning");
    const standard = JSON.parse(readFileSync(join(out, "worker.standard.json"), "utf8"));
    const arns = standard.accounts.flatMap((a: { roles: { roleArn: string }[] }) =>
      a.roles.map((x) => x.roleArn),
    );
    expect(arns).toEqual([
      "arn:aws:iam::111111111111:role/awsbridge-console/std/FederatedAwsBridgeViewer",
    ]);
    expect(existsSync(join(out, "worker.admin.json"))).toBe(false);
  });

  it("会社用の例（Admin のチームが 2 つ）を、admin の入口の AUD なしで deploy 生成できる（G-6 が決まるまで要求しない）", () => {
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
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", {
        teams: teamAuds,
        entry: { standard: "a".repeat(64) },
      }),
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

    // 表示用: Administrator の行と Object ID の対応がある
    const display = JSON.parse(readFileSync(join(out, "display.standard.json"), "utf8"));
    expect(display.purpose).toBe("display");
    expect(display.accounts.filter((a: { tier: string }) => a.tier === "admin")).not.toHaveLength(
      0,
    );
    expect(display.groups).toContainEqual({
      objectId: "00000000-0000-0000-0000-000000000004",
      teams: ["infra-elevated"],
    });
    // 発行用と表示用のどちらにも Admin のチームの AUD がない
    const worker = readFileSync(join(out, "worker.standard.json"), "utf8");
    const shown = readFileSync(join(out, "display.standard.json"), "utf8");
    for (const aud of [teamAuds["infra-elevated"], teamAuds["dev-elevated"]] as string[]) {
      expect(worker, "worker.standard.json").not.toContain(aud);
      expect(shown, "display.standard.json").not.toContain(aud);
    }
    // 発行用には Administrator の行も Object ID もない
    expect(worker).not.toContain("FederatedAwsBridgeAdministrator");
    expect(worker).not.toContain("00000000-0000-0000-0000-");
    // Admin の発行用には Standard の行がない
    const admin = readFileSync(join(out, "worker.admin.json"), "utf8");
    expect(admin).not.toContain("FederatedAwsBridgeViewer");
    expect(JSON.parse(admin).identity).toEqual({ sourceIdentity: "email" });
  });
});

describe("console:config:generate", () => {
  it("会社用: 階層ごとの Worker 用・StackSets 用・Access の検査用を書く（他人に読めない権限で）", () => {
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
      "display.standard.json",
      "kind.A.yaml",
      "kind.B.yaml",
      "kind.C.yaml",
      "kind.P.yaml",
      "stacksets.json",
      "worker.admin.json",
      "worker.standard.json",
    ]);
    for (const f of readdirSync(out)) expect(statSync(join(out, f)).mode & 0o077, f).toBe(0);
    const standard = JSON.parse(readFileSync(join(out, "worker.standard.json"), "utf8"));
    expect(standard.tier).toBe("standard");
    expect(standard.sourceRevision).toBe("deadbeef");
    expect(standard.teams.map((t: { name: string }) => t.name)).toEqual(["infra", "dev", "sa"]);
    expect(standard.accounts.length).toBe(3);
    expect(standard.purpose).toBe("issue");
    expect(standard.identity).toEqual({ sourceIdentity: "email" });
    const display = JSON.parse(readFileSync(join(out, "display.standard.json"), "utf8"));
    expect(display.purpose).toBe("display");
    expect(display.sourceRevision).toBe("deadbeef");
    expect(display.accounts.some((a: { tier: string }) => a.tier === "admin")).toBe(true);
    expect(JSON.stringify(standard)).not.toContain("infra-elevated");
    const admin = JSON.parse(readFileSync(join(out, "worker.admin.json"), "utf8"));
    expect(admin.tier).toBe("admin");
    // ロールの ARN は階層ごとのパス（P-2）
    type Rows = { accounts: { roles: { roleArn: string }[] }[] };
    const arns = (w: Rows) => w.accounts.flatMap((a) => a.roles.map((r) => r.roleArn));
    for (const [w, seg] of [
      [standard, "std"],
      [admin, "admin"],
    ] as const) {
      const re = new RegExp(`^arn:aws:iam::\\d{12}:role/awsbridge-console/${seg}/[^/]+$`);
      expect(arns(w).length).toBeGreaterThan(0);
      expect(arns(w).filter((a) => !re.test(a))).toEqual([]);
    }
    const stacksets = JSON.parse(readFileSync(join(out, "stacksets.json"), "utf8"));
    expect(stacksets.assignments).toHaveLength(4);
    expect(stacksets.audience).toBe("awsbridge-console");
    expect(stacksets.rolePathPrefix).toBe("/awsbridge-console/");
    // 出力にパスは出してよいが、AUD・email は出さない
    expect(r.stdout).toContain("worker.standard.json");
    expect(r.stdout).not.toContain("1".repeat(64));
    expect(r.stdout).not.toContain("@example");
  });

  it("個人用: Standard だけを書き、Admin の生成物は作らない", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", personalConfig()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "access.json",
      "display.standard.json",
      "kind.default.yaml",
      "stacksets.json",
      "worker.standard.json",
    ]);
  });

  it("前回の Admin の生成物が残っていても、Admin の階層がなくなれば消す", () => {
    const d = tmp();
    const out = join(d, "out");
    const env = {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console.json", companyConfig()),
      AWSBRIDGE_CONSOLE_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    };
    expect(run("generate", env).status).toBe(0);
    expect(existsSync(join(out, "worker.admin.json"))).toBe(true);
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console2.json", personalConfig()),
      AWSBRIDGE_CONSOLE_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(out, "worker.admin.json"))).toBe(false);
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
    const worker = JSON.parse(readFileSync(join(out, "worker.admin.json"), "utf8"));
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
    const r = run("generate", {
      AWSBRIDGE_CONSOLE_CONFIG: write(d, "console2.json", personalConfig()),
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
