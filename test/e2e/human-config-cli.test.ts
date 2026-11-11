// 人間のログインの設定の CLI（scripts/human/config.ts。mise タスク human:config:check / human:config:generate）を実プロセスで動かし、
// 終了コード・出力・生成物を確かめる。入力と出力は一時ディレクトリに置き、リポジトリの中には書かない。
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import {
  companyAuds,
  companyConfig,
  companyInventory,
  personalConfig,
} from "../unit/human-fixtures";

const root = new URL("../../", import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-human-cli-"));
  dirs.push(d);
  return d;
}

function run(cmd: string, env: Record<string, string>) {
  return spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "scripts/human/config.ts"), cmd],
    {
      cwd: root,
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

describe("human:config:check", () => {
  it("会社用の設定を AUD なしで検査して終了コード 0。生成物は書かない", () => {
    const d = tmp();
    const r = run("check", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", companyConfig()),
      AWSBRIDGE_HUMAN_OUT_DIR: join(d, "out"),
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
    const r = run("check", { AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", c) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("portal.standardOrigin: workers_dev");
    expect(r.stderr).toContain("kinds[0].assign.admin[1]: tier_mismatch");
    expect(r.stderr).toContain("organizations[1].accounts[1].accountId: duplicate");
    expect(r.stderr + r.stdout).not.toContain("secret-portal");
    expect(r.stderr + r.stdout).not.toContain("leak@");
    expect(r.stderr + r.stdout).not.toContain("222222222222");
  });

  it("AUD のファイルを渡すと、AUD の対応（欠落・食い違い）まで検査する", () => {
    const d = tmp();
    const auds = companyAuds();
    delete auds.teams.sa;
    const r = run("check", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", companyConfig()),
      AWSBRIDGE_HUMAN_AUD_FILE: write(d, "auds.json", auds),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("teams[2].access: aud_missing");
    expect(r.stderr + r.stdout).not.toContain("1".repeat(64));
  });

  it("警告は出すが終了コードは 0", () => {
    const d = tmp();
    const c = companyConfig();
    for (const k of c.kinds) delete k.assign.developer;
    const r = run("check", { AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", c) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("warning: teams[1]: unassigned_team");
  });

  it("設定ファイルがなければ終了コード 1", () => {
    const d = tmp();
    const r = run("check", { AWSBRIDGE_HUMAN_CONFIG: join(d, "nothing.json") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("設定ファイルがありません");
  });

  it("未知のサブコマンドは終了コード 1", () => {
    expect(run("nope", {}).status).toBe(1);
  });
});

describe("human:config:generate", () => {
  it("会社用: 階層ごとの Worker 用・StackSets 用・Access の検査用を書く（他人に読めない権限で）", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", companyConfig()),
      AWSBRIDGE_HUMAN_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_HUMAN_INVENTORY_FILE: write(d, "inventory.json", companyInventory()),
      AWSBRIDGE_HUMAN_OUT_DIR: out,
      AWSBRIDGE_HUMAN_SOURCE_REVISION: "deadbeef",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "access.json",
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
    expect(JSON.stringify(standard)).not.toContain("infra-elevated");
    const admin = JSON.parse(readFileSync(join(out, "worker.admin.json"), "utf8"));
    expect(admin.tier).toBe("admin");
    const stacksets = JSON.parse(readFileSync(join(out, "stacksets.json"), "utf8"));
    expect(stacksets.assignments).toHaveLength(4);
    // 出力にパスは出してよいが、AUD・email は出さない
    expect(r.stdout).toContain("worker.standard.json");
    expect(r.stdout).not.toContain("1".repeat(64));
    expect(r.stdout).not.toContain("@example");
  });

  it("個人用: Standard だけを書き、Admin の生成物は作らない", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", personalConfig()),
      AWSBRIDGE_HUMAN_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "access.json",
      "stacksets.json",
      "worker.standard.json",
    ]);
  });

  it("前回の Admin の生成物が残っていても、Admin の階層がなくなれば消す", () => {
    const d = tmp();
    const out = join(d, "out");
    const env = {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", companyConfig()),
      AWSBRIDGE_HUMAN_AUD_FILE: write(d, "auds.json", companyAuds()),
      AWSBRIDGE_HUMAN_OUT_DIR: out,
    };
    expect(run("generate", env).status).toBe(0);
    expect(existsSync(join(out, "worker.admin.json"))).toBe(true);
    const r = run("generate", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human2.json", personalConfig()),
      AWSBRIDGE_HUMAN_OUT_DIR: out,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(out, "worker.admin.json"))).toBe(false);
  });

  it("AUD が足りなければ終了コード 1 で、何も書かない", () => {
    const d = tmp();
    const out = join(d, "out");
    const r = run("generate", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", companyConfig()),
      AWSBRIDGE_HUMAN_OUT_DIR: out,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("teams[0].access: aud_missing");
    expect(existsSync(out)).toBe(false);
  });

  it("AUD・インベントリのファイルが JSON として読めなければ終了コード 1", () => {
    const d = tmp();
    writeFileSync(join(d, "auds.json"), "{");
    const r = run("generate", {
      AWSBRIDGE_HUMAN_CONFIG: write(d, "human.json", companyConfig()),
      AWSBRIDGE_HUMAN_AUD_FILE: join(d, "auds.json"),
      AWSBRIDGE_HUMAN_OUT_DIR: join(d, "out"),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("auds: json");
  });
});
