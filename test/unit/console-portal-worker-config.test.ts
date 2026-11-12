// 発行用の生成物（worker.<tier>.json）の Worker 側の検査（src/console/portal/worker-config.ts）。
// 設計: docs/specs/console-login-portal.md §9.10・§11.6（生成物の不整合は Worker の初回の要求で 500 server_misconfigured）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConsoleConfig } from "../../src/console/config";
import { generateConsoleArtifacts } from "../../src/console/generate";
import { readWorkerConfig, WorkerConfigError } from "../../src/console/portal/worker-config";
import type { WorkerConfig } from "../../src/console/types";
import { personalConfig } from "./console-fixtures";
import { adminConfig, standardConfig } from "./console-standard-harness";

function kindOf(raw: unknown, tier: "standard" | "admin" = "standard"): string | undefined {
  try {
    readWorkerConfig(raw, tier);
    return undefined;
  } catch (e) {
    if (e instanceof WorkerConfigError) return e.kind;
    throw e;
  }
}

const root = new URL("../../", import.meta.url).pathname;
const std = () => standardConfig() as WorkerConfig & Record<string, unknown>;

describe("readWorkerConfig", () => {
  it("陽性の対照: 生成器が作った Standard・Admin・個人用の生成物は、その階層で通る", () => {
    expect(kindOf(standardConfig())).toBeUndefined();
    expect(kindOf(adminConfig(), "admin")).toBeUndefined();
    const { config } = parseConsoleConfig(personalConfig());
    const personal = generateConsoleArtifacts(config, { mode: "deploy", generatedAt: "x" }).worker
      .standard;
    expect(kindOf(personal)).toBeUndefined();
  });

  it.each(["config/console.example.json", "config/console.company.example.json"])(
    "陽性の対照: 例（%s）から生成した生成物は、各階層で通る（Worker 側の検査が生成器より厳しくない）",
    (p) => {
      const { config } = parseConsoleConfig(readFileSync(join(root, p), "utf8"));
      // 会社用は Terraform の出力の AUD とインベントリを渡す。個人用は手書きの AUD だけで生成する
      const company = config.organizations.some((o) => o.placement === "ou");
      const teams = Object.fromEntries(
        config.teams.map((t, i) => [t.name, `aud${String(i).repeat(20)}`]),
      );
      const w = generateConsoleArtifacts(config, {
        mode: "deploy",
        generatedAt: "x",
        sourceRevision: "rev",
        ...(company
          ? {
              auds: { teams, entry: { standard: `entry${"9".repeat(20)}` } },
              inventory: {
                "org-main": [
                  { accountId: "111111111111", name: "a", ouPath: ["r-abcd", "ou-abcd-11111111"] },
                  { accountId: "111111111112", name: "c", ouPath: ["r-abcd", "ou-abcd-33333333"] },
                ],
              },
            }
          : {}),
      }).worker;
      expect(kindOf(w.standard)).toBeUndefined();
      if (w.admin) expect(kindOf(w.admin, "admin")).toBeUndefined();
    },
  );

  it("階層の取り違え・purpose の違い・形の崩れを種別で返す（値はメッセージに入れない）", () => {
    expect(kindOf(adminConfig())).toBe("tier");
    expect(kindOf(standardConfig(), "admin")).toBe("tier");
    expect(kindOf({ ...std(), purpose: "display" })).toBe("purpose");
    expect(kindOf(null)).toBe("not_object");
    expect(kindOf([])).toBe("not_object");
    expect(kindOf({ ...std(), tagKey: "team" })).toBe("tag_key");
    const c = std();
    c.portal.origin = "https://portal.example.com/";
    expect(kindOf(c)).toBe("portal_origin");
    try {
      readWorkerConfig({ ...std(), purpose: "aud-123-secret" }, "standard");
    } catch (e) {
      expect(String(e)).not.toContain("aud-123-secret");
    }
  });

  it("他の階層の行・チームの混入、ロールの ARN の食い違い、行の長さの食い違いを弾く", () => {
    let c = std();
    c.accounts.push(...adminConfig().accounts);
    expect(kindOf(c)).toBe("row_role_unknown");

    c = std();
    const row = c.accounts[0]?.roles[0];
    if (!row) throw new Error("fixture");
    row.roleArn = row.roleArn.replace("/std/", "/admin/");
    expect(kindOf(c)).toBe("row_tier");

    c = std();
    c.accounts[0]?.roles[0]?.teams.push("infra-elevated");
    expect(kindOf(c)).toBe("row_team");

    c = std();
    const r0 = c.accounts[0]?.roles[0];
    if (r0) r0.sessionSeconds = 900;
    expect(kindOf(c)).toBe("row_session_seconds");

    c = std();
    const a0 = c.accounts[0];
    if (a0) a0.boundary = "partner:unknown";
    expect(kindOf(c)).toBe("account_boundary");
  });

  it("AUD の重複・入口の AUD との重なり・issuer の形の崩れを弾く", () => {
    let c = std();
    const [t0, t1] = c.teams;
    if (t0 && t1) t1.aud = t0.aud as string;
    expect(kindOf(c)).toBe("team_aud_duplicate");

    c = std();
    c.portal.entryAud = c.teams[0]?.aud as string;
    expect(kindOf(c)).toBe("team_aud_entry");

    c = std();
    const b0 = c.boundaries[0];
    if (b0) b0.issuer = `${b0.issuer}/`;
    expect(kindOf(c)).toBe("boundary_issuer");
  });
});
