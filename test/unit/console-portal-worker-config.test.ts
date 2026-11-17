// 発行用の生成物（worker.json）の Worker 側の検査（src/console/portal/worker-config.ts）。
// 設計: docs/specs/console-login-portal.md §9.10・§11.6（生成物の不整合は Worker の初回の要求で 500 server_misconfigured）、
// P2（B）の設計メモ §7.1・§7.3（X7: row_team_tier、X8: row_tier）・§2.3（admin_boundary）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConsoleConfig } from "../../src/console/config";
import { generateConsoleArtifacts } from "../../src/console/generate";
import { readWorkerConfig, WorkerConfigError } from "../../src/console/portal/worker-config";
import type { WorkerConfig } from "../../src/console/types";
import { personalConfig } from "./console-fixtures";
import { workerConfig } from "./console-worker-harness";

function kindOf(raw: unknown): string | undefined {
  try {
    readWorkerConfig(raw);
    return undefined;
  } catch (e) {
    if (e instanceof WorkerConfigError) return e.kind;
    throw e;
  }
}

const root = new URL("../../", import.meta.url).pathname;
const std = () => workerConfig() as WorkerConfig & Record<string, unknown>;

describe("readWorkerConfig", () => {
  it("陽性の対照: 生成器が作った会社用（両階層）・個人用の生成物は通る", () => {
    expect(kindOf(workerConfig())).toBeUndefined();
    const { config } = parseConsoleConfig(personalConfig());
    const personal = generateConsoleArtifacts(config, { mode: "deploy", generatedAt: "x" }).worker;
    expect(kindOf(personal)).toBeUndefined();
  });

  it.each(["config/console.example.json", "config/console.company.example.json"])(
    "陽性の対照: 例（%s）から生成した生成物は通る（Worker 側の検査が生成器より厳しくない）",
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
              auds: { teams, entry: `entry${"9".repeat(20)}` },
              inventory: {
                "org-main": [
                  { accountId: "111111111111", name: "a", ouPath: ["r-abcd", "ou-abcd-11111111"] },
                  { accountId: "111111111112", name: "c", ouPath: ["r-abcd", "ou-abcd-33333333"] },
                ],
              },
            }
          : {}),
      }).worker;
      expect(kindOf(w)).toBeUndefined();
    },
  );

  it("P2 より前の形（schemaVersion 1・デプロイの tier・peerOrigin）・purpose の違い・形の崩れを種別で返す（値はメッセージに入れない）", () => {
    expect(kindOf({ ...std(), schemaVersion: 1 })).toBe("schema_version");
    expect(kindOf({ ...std(), tier: "standard" })).toBe("tier");
    const peer = std();
    (peer.portal as Record<string, unknown>).peerOrigin = "https://admin-portal.example.com";
    expect(kindOf(peer)).toBe("portal_peer_origin");
    expect(kindOf({ ...std(), purpose: "display" })).toBe("purpose");
    expect(kindOf(null)).toBe("not_object");
    expect(kindOf([])).toBe("not_object");
    expect(kindOf({ ...std(), tagKey: "team" })).toBe("tag_key");
    const c = std();
    c.portal.origin = "https://portal.example.com/";
    expect(kindOf(c)).toBe("portal_origin");
    try {
      readWorkerConfig({ ...std(), purpose: "aud-123-secret" });
    } catch (e) {
      expect(String(e)).not.toContain("aud-123-secret");
    }
  });

  it("チームとロールの tier が無い・値が違えば team_tier・role_tier", () => {
    let c = std();
    delete (c.teams[0] as Record<string, unknown>).tier;
    expect(kindOf(c)).toBe("team_tier");
    c = std();
    (c.roles[0] as Record<string, unknown>).tier = "root";
    expect(kindOf(c)).toBe("role_tier");
  });

  /** 行（アカウント × ロール）を探す。 */
  const rowOf = (c: WorkerConfig, accountId: string, role: string) => {
    const r = c.accounts.find((a) => a.accountId === accountId)?.roles.find((x) => x.role === role);
    if (!r) throw new Error(`fixture: ${accountId}:${role}`);
    return r;
  };

  it("X7: Admin のロールの行に Standard のチームを混ぜると row_team_tier（逆向きも）", () => {
    let c = std();
    rowOf(c, "333333333333", "admin").teams.push("infra");
    expect(kindOf(c)).toBe("row_team_tier");
    c = std();
    rowOf(c, "333333333333", "readonly").teams.push("infra-elevated");
    expect(kindOf(c)).toBe("row_team_tier");
  });

  it("X8: Standard のロールの行の ARN を /awsbridge-console/admin/ にすると row_tier（逆向きも）", () => {
    let c = std();
    const r = rowOf(c, "333333333333", "readonly");
    r.roleArn = r.roleArn.replace("/std/", "/admin/");
    expect(kindOf(c)).toBe("row_tier");
    c = std();
    const a = rowOf(c, "333333333333", "admin");
    a.roleArn = a.roleArn.replace("/admin/", "/std/");
    expect(kindOf(c)).toBe("row_tier");
  });

  it("Admin の階層のロールの行が managed 以外の境界にあれば admin_boundary（設定の検査と同じ規則を Worker でも）", () => {
    const c = std();
    const partner = c.accounts.find((a) => a.boundary === "partner:partner-x");
    const adminRow = c.accounts.find((a) => a.roles.some((r) => r.role === "admin"));
    if (!partner || !adminRow) throw new Error("fixture");
    const row = adminRow.roles.find((r) => r.role === "admin");
    if (!row) throw new Error("fixture");
    partner.roles.push({
      ...row,
      roleArn: row.roleArn.replace(adminRow.accountId, partner.accountId),
    });
    expect(kindOf(c)).toBe("admin_boundary");
    // 陽性の対照: 同じ行を managed のアカウントに置けば通る（行の重複がない別のアカウント）
    const ok = std();
    const managed = ok.accounts.find(
      (a) => a.boundary === "managed" && !a.roles.some((r) => r.role === "admin"),
    );
    expect(managed).toBeUndefined(); // fixture の managed のアカウントは、どれも Admin の行を持つ
  });

  it("未知のチームの混入、ロールの ARN の食い違い、行の長さの食い違いを弾く", () => {
    let c = std();
    c.accounts[0]?.roles[0]?.teams.push("ghost");
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
