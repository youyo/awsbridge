// コンソールログインの定数と契約の型（src/console/constants.ts・types.ts）。
// Worker のエントリは設定の解析器（config.ts）と生成器（generate.ts）をバンドルに引き込まず、この 2 つだけを読む。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ID_RE,
  AUD_RE,
  AUDIENCE,
  CONSOLE_SCHEMA_VERSION,
  DEFAULT_SOURCE_IDENTITY,
  isEmail,
  isSourceIdentitySource,
  NAME_RE,
  ROLE_PATH_PREFIX,
  rolePath,
  SESSION_SECONDS_MAX,
  SESSION_SECONDS_MIN,
  TEAM_TAG_KEY,
  TIERS,
  UUID_RE,
} from "../../src/console/constants";
import { importGraph } from "./import-graph";

const root = new URL("../../", import.meta.url).pathname;

describe("定数", () => {
  it("固定の約束（スキーマの版・タグのキー・audience・ロールのパス・階層・セッションの長さ）", () => {
    expect(CONSOLE_SCHEMA_VERSION).toBe(1);
    expect(TEAM_TAG_KEY).toBe("awsbridge_team");
    expect(AUDIENCE).toBe("awsbridge-console");
    expect(ROLE_PATH_PREFIX).toBe("/awsbridge-console/");
    expect([...TIERS]).toEqual(["standard", "admin"]);
    expect(rolePath("standard")).toBe("/awsbridge-console/std/");
    expect(rolePath("admin")).toBe("/awsbridge-console/admin/");
    expect([SESSION_SECONDS_MIN, SESSION_SECONDS_MAX]).toEqual([900, 43200]);
  });

  it("値の形（チーム名・アカウント ID・AUD・UUID・email）", () => {
    expect(NAME_RE.test("infra-elevated")).toBe(true);
    expect(NAME_RE.test("Infra")).toBe(false);
    expect(ACCOUNT_ID_RE.test("111111111111")).toBe(true);
    expect(ACCOUNT_ID_RE.test("11111111111")).toBe(false);
    expect(AUD_RE.test("a".repeat(64))).toBe(true);
    expect(AUD_RE.test("short")).toBe(false);
    expect(UUID_RE.test("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isEmail("user@example.com")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
  });

  it("SourceIdentity の出どころは email（既定）か custom.<名前>。sub は受け付けない", () => {
    expect(DEFAULT_SOURCE_IDENTITY).toBe("email");
    for (const ok of ["email", "custom.employee_id", "custom.oid"])
      expect(isSourceIdentitySource(ok), ok).toBe(true);
    for (const ng of ["sub", "custom.", "custom", "Email", "custom.a b", "custom.1a", "oid", ""])
      expect(isSourceIdentitySource(ng), ng).toBe(false);
    expect(isSourceIdentitySource(undefined)).toBe(false);
  });
});

describe("Worker のエントリから読めるモジュールの分離", () => {
  it("constants.ts は何も import しない（node の API も使わない）", () => {
    const g = importGraph(join(root, "src/console/constants.ts"));
    expect(g.files).toEqual([join(root, "src/console/constants.ts")]);
    expect(g.bare).toEqual([]);
  });

  it("types.ts は constants.ts だけを import する（設定の解析器・生成器に届かない）", () => {
    const g = importGraph(join(root, "src/console/types.ts"));
    expect(g.files).toEqual([
      join(root, "src/console/constants.ts"),
      join(root, "src/console/types.ts"),
    ]);
    expect(g.bare).toEqual([]);
  });
});
