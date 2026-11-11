// コンソールログインの設定ファイル（チーム・ロール・種類）の検証。設計: docs/specs/console-login-portal.md §11.3・§11.6。
import { describe, expect, it } from "vitest";
import {
  AUDIENCE,
  ConsoleConfigError,
  type ConsoleConfigIssue,
  parseConsoleConfig,
  ROLE_PATH_PREFIX,
  rolePath,
  TEAM_TAG_KEY,
} from "../../src/console/config";
import { companyConfig, personalConfig, type Raw, uuid } from "./console-fixtures";

function issuesOf(raw: unknown): ConsoleConfigIssue[] {
  try {
    parseConsoleConfig(raw);
  } catch (e) {
    if (e instanceof ConsoleConfigError) return e.issues;
    throw e;
  }
  return [];
}

const issue = (path: string, code: string) => expect.objectContaining({ path, code });

function withChange(base: () => Raw, change: (c: Raw) => void): Raw {
  const c = base();
  change(c);
  return c;
}

describe("parseConsoleConfig: 正しい設定", () => {
  it("会社用の設定を受け付け、既定値を補う", () => {
    const { config, warnings } = parseConsoleConfig(companyConfig());
    expect(warnings).toEqual([]);
    expect(config.teams.map((t) => [t.name, t.tier, t.displayName])).toEqual([
      ["infra", "standard", "インフラ"],
      ["dev", "standard", "開発"],
      ["sa", "standard", "sa"],
      ["infra-elevated", "admin", "infra-elevated"],
      ["dev-elevated", "admin", "dev-elevated"],
    ]);
    expect(config.roles.find((r) => r.name === "readonly")).toMatchObject({
      tier: "standard",
      displayName: "readonly",
      managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      inlinePolicyFiles: [],
    });
    expect(config.portal.routing).toBe("path");
  });

  it("個人用の最小構成を受け付ける（Admin なし・Terraform なし・Organization なし）", () => {
    const { config, warnings } = parseConsoleConfig(personalConfig());
    expect(warnings).toEqual([]);
    expect(config.portal.adminOrigin).toBeUndefined();
    expect(config.portal.routing).toBe("path");
  });

  it("アカウントの email の既定は管理下・管理外とも full（すべて表示。Q-P9）", () => {
    const { config } = parseConsoleConfig(personalConfig());
    expect(config.inventory.accountEmail).toEqual({ managed: "full", partner: "full" });
    const c = withChange(personalConfig, (x) => {
      x.inventory = { accountEmail: { partner: "hidden" } };
    });
    expect(parseConsoleConfig(c).config.inventory.accountEmail).toEqual({
      managed: "full",
      partner: "hidden",
    });
  });

  it("JSON の文字列も受け付け、$schema キーは無視する", () => {
    const c = withChange(personalConfig, (x) => {
      x.$schema = "./anything.json";
    });
    expect(parseConsoleConfig(JSON.stringify(c)).config.teams).toHaveLength(1);
  });

  it("固定の約束（タグのキー・audience・ロールのパス）", () => {
    expect(TEAM_TAG_KEY).toBe("awsbridge_team");
    // audience は全階層・全境界で 1 つ（MCP 用の awsbridge と重ならない）
    expect(AUDIENCE).toBe("awsbridge-console");
    expect(ROLE_PATH_PREFIX).toBe("/awsbridge-console/");
  });

  it("ロールのパスは階層ごと（P-2: /awsbridge-console/<tier>/。tier は std / admin で、issuer のパスと同じ）", () => {
    expect(rolePath("standard")).toBe("/awsbridge-console/std/");
    expect(rolePath("admin")).toBe("/awsbridge-console/admin/");
    for (const t of ["standard", "admin"] as const)
      expect(rolePath(t).startsWith(ROLE_PATH_PREFIX)).toBe(true);
  });
});

describe("parseConsoleConfig: 構文・型・未知のキー", () => {
  it("JSON として読めない文字列は json", () => {
    expect(issuesOf("{")).toEqual([issue("$", "json")]);
  });

  it("オブジェクトでなければ type", () => {
    expect(issuesOf([])).toEqual([issue("$", "type")]);
  });

  it("schemaVersion が 1 でなければ schema_version", () => {
    const c = withChange(personalConfig, (x) => {
      x.schemaVersion = 2;
    });
    expect(issuesOf(c)).toContainEqual(issue("schemaVersion", "schema_version"));
  });

  it.each([
    [
      "$",
      (x: Raw) => {
        x.extra = 1;
      },
      "extra",
    ],
    [
      "portal",
      (x: Raw) => {
        x.portal.standardOrign = "https://x.example.com";
      },
      "standardOrign",
    ],
    [
      "teams[0]",
      (x: Raw) => {
        x.teams[0].tire = "admin";
      },
      "tire",
    ],
    [
      "teams[0].access",
      (x: Raw) => {
        x.teams[0].access.audd = "x";
      },
      "audd",
    ],
    [
      "roles[0]",
      (x: Raw) => {
        x.roles[0].sessionSecond = 1;
      },
      "sessionSecond",
    ],
    [
      "roles[0].permissions",
      (x: Raw) => {
        x.roles[0].permissions.inline = [];
      },
      "inline",
    ],
    [
      "kinds[0]",
      (x: Raw) => {
        x.kinds[0].assing = {};
      },
      "assing",
    ],
    [
      "boundaries[0].issuers",
      (x: Raw) => {
        x.boundaries[0].issuers.adm = "x";
      },
      "adm",
    ],
    [
      "organizations[0]",
      (x: Raw) => {
        x.organizations[0].kindOus = {};
      },
      "kindOus",
    ],
    [
      "organizations[0].accounts[0]",
      (x: Raw) => {
        x.organizations[0].accounts[0].mail = "x";
      },
      "mail",
    ],
    [
      "inventory.accountEmail",
      (x: Raw) => {
        x.inventory = { accountEmail: { other: "full" } };
      },
      "other",
    ],
  ])("未知のキーは unknown_key（%s）", (path, change, key) => {
    const c = withChange(personalConfig, change);
    const expected = path === "$" ? key : `${path}.${key}`;
    expect(issuesOf(c)).toContainEqual(issue(expected, "unknown_key"));
  });

  it.each([
    ["portal", (x: Raw) => delete x.portal],
    ["portal.standardOrigin", (x: Raw) => delete x.portal.standardOrigin],
    ["teams[0].access", (x: Raw) => delete x.teams[0].access],
    ["roles[0].roleName", (x: Raw) => delete x.roles[0].roleName],
    ["roles[0].sessionSeconds", (x: Raw) => delete x.roles[0].sessionSeconds],
    ["roles[0].permissions", (x: Raw) => delete x.roles[0].permissions],
    ["kinds[0].assign", (x: Raw) => delete x.kinds[0].assign],
    ["boundaries[0].issuers.standard", (x: Raw) => delete x.boundaries[0].issuers.standard],
    ["organizations[0].placement", (x: Raw) => delete x.organizations[0].placement],
    ["organizations[0].accounts", (x: Raw) => delete x.organizations[0].accounts],
  ])("必須の欠落は required（%s）", (path, change) => {
    expect(issuesOf(withChange(personalConfig, change))).toContainEqual(issue(path, "required"));
  });

  it("空の配列は empty（teams・roles・kinds・boundaries・organizations）", () => {
    const c = withChange(personalConfig, (x) => {
      x.teams = [];
      x.roles = [];
      x.kinds = [];
      x.boundaries = [];
      x.organizations = [];
    });
    const found = issuesOf(c);
    for (const p of ["teams", "roles", "kinds", "boundaries", "organizations"]) {
      expect(found).toContainEqual(issue(p, "empty"));
    }
  });

  it("項目ごとの型の誤りは type（配列でない・数でない・マップでない）", () => {
    const notArray = withChange(personalConfig, (x) => {
      x.teams = { me: {} };
    });
    expect(issuesOf(notArray)).toContainEqual(issue("teams", "type"));
    const notNumber = withChange(personalConfig, (x) => {
      x.roles[0].sessionSeconds = "43200";
    });
    expect(issuesOf(notNumber)).toContainEqual(issue("roles[0].sessionSeconds", "type"));
    const notMap = withChange(personalConfig, (x) => {
      x.kinds[0].assign = [["readonly", ["me"]]];
    });
    expect(issuesOf(notMap)).toContainEqual(issue("kinds[0].assign", "type"));
    const notString = withChange(personalConfig, (x) => {
      x.teams[0].displayName = 1;
    });
    expect(issuesOf(notString)).toContainEqual(issue("teams[0].displayName", "type"));
  });

  it("利用者が書いたキーのうち名前の形でないもの（AUD・email・アカウント ID を含むもの）はパスに出さない", () => {
    const aud = "d".repeat(64);
    const c = withChange(companyConfig, (x) => {
      x.kinds[0].assign[aud] = ["sa"];
      x.organizations[0].kindOus["111111111111"] = ["ou-abcd-44444444"];
      x.teams[0]["someone@example.com"] = 1;
    });
    const paths = issuesOf(c).map((i) => i.path);
    expect(paths).toContain("kinds[0].assign.<redacted>");
    expect(paths).toContain("organizations[0].kindOus.<redacted>");
    expect(paths).toContain("teams[0].<redacted>");
    expect(paths.join("\n")).not.toMatch(/d{16}|111111111111|someone/);
  });

  it("複数の誤りをまとめて返す", () => {
    const c = withChange(personalConfig, (x) => {
      x.teams[0].name = "Bad Name";
      x.roles[0].sessionSeconds = 60;
    });
    const found = issuesOf(c);
    expect(found).toContainEqual(issue("teams[0].name", "pattern"));
    expect(found).toContainEqual(issue("roles[0].sessionSeconds", "range"));
  });

  it("エラーの文面にはキーのパスと種別だけを出し、値を出さない", () => {
    const secretAud = "f".repeat(64);
    const c = withChange(personalConfig, (x) => {
      x.teams.push({ name: "me", access: { aud: secretAud } });
      x.organizations[0].accounts[0].email = "not-an-email";
    });
    let message = "";
    try {
      parseConsoleConfig(c);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("teams[1].name: duplicate");
    expect(message).not.toContain(secretAud);
    expect(message).not.toContain("not-an-email");
    expect(message).not.toContain("111111111111");
  });
});

describe("parseConsoleConfig: 値の形", () => {
  it.each([
    [
      "teams[0].name",
      (x: Raw) => {
        x.teams[0].name = "Me";
      },
      "pattern",
    ],
    [
      "teams[0].name",
      (x: Raw) => {
        x.teams[0].name = `a${"b".repeat(32)}`;
      },
      "pattern",
    ],
    [
      "teams[0].tier",
      (x: Raw) => {
        x.teams[0].tier = "root";
      },
      "enum",
    ],
    [
      "roles[0].name",
      (x: Raw) => {
        x.roles[0].name = "read_only";
      },
      "pattern",
    ],
    [
      "roles[0].roleName",
      (x: Raw) => {
        x.roles[0].roleName = "a/b";
      },
      "pattern",
    ],
    [
      "roles[0].sessionSeconds",
      (x: Raw) => {
        x.roles[0].sessionSeconds = 899;
      },
      "range",
    ],
    [
      "roles[0].sessionSeconds",
      (x: Raw) => {
        x.roles[0].sessionSeconds = 43201;
      },
      "range",
    ],
    [
      "roles[0].sessionSeconds",
      (x: Raw) => {
        x.roles[0].sessionSeconds = 3600.5;
      },
      "range",
    ],
    [
      "roles[0].permissions.managedPolicyArns[0]",
      (x: Raw) => {
        x.roles[0].permissions.managedPolicyArns = ["arn:aws:iam::111111111111:policy/Mine"];
      },
      "pattern",
    ],
    [
      "kinds[0].name",
      (x: Raw) => {
        x.kinds[0].name = "has space";
      },
      "pattern",
    ],
    [
      "boundaries[0].name",
      (x: Raw) => {
        x.boundaries[0].name = "partner";
      },
      "pattern",
    ],
    [
      "boundaries[0].issuers.standard",
      (x: Raw) => {
        x.boundaries[0].issuers.standard = "http://id.example.com/standard";
      },
      "url",
    ],
    [
      "boundaries[0].issuers.standard",
      (x: Raw) => {
        x.boundaries[0].issuers.standard = "https://id.example.com/standard/";
      },
      "url",
    ],
    [
      "organizations[0].accounts[0].accountId",
      (x: Raw) => {
        x.organizations[0].accounts[0].accountId = "12345";
      },
      "pattern",
    ],
    [
      "organizations[0].accounts[0].email",
      (x: Raw) => {
        x.organizations[0].accounts[0].email = "nobody";
      },
      "pattern",
    ],
    [
      "inventory.accountEmail.managed",
      (x: Raw) => {
        x.inventory = { accountEmail: { managed: "partial" } };
      },
      "enum",
    ],
    [
      "portal.routing",
      (x: Raw) => {
        x.portal.routing = "query";
      },
      "enum",
    ],
    [
      "portal.supportUrl",
      (x: Raw) => {
        x.portal.supportUrl = "javascript:alert(1)";
      },
      "url",
    ],
    [
      "portal.regions.allowed[0]",
      (x: Raw) => {
        x.portal.regions = { allowed: ["tokyo"], default: "tokyo" };
      },
      "pattern",
    ],
  ])("%s の形が違えば誤り", (path, change, code) => {
    expect(issuesOf(withChange(personalConfig, change))).toContainEqual(issue(path, code));
  });

  it("regions.default は allowed に含まれること", () => {
    const c = withChange(personalConfig, (x) => {
      x.portal.regions = { allowed: ["ap-northeast-1"], default: "us-east-1" };
    });
    expect(issuesOf(c)).toContainEqual(issue("portal.regions.default", "region_default"));
  });

  it("access は groupObjectIds・policyIds・aud のどれか 1 つだけ", () => {
    const both = withChange(companyConfig, (x) => {
      x.teams[0].access = { groupObjectIds: [uuid(1)], policyIds: [uuid(9)] };
    });
    expect(issuesOf(both)).toContainEqual(issue("teams[0].access", "access_shape"));
    const none = withChange(companyConfig, (x) => {
      x.teams[0].access = {};
    });
    expect(issuesOf(none)).toContainEqual(issue("teams[0].access", "access_shape"));
    const badId = withChange(companyConfig, (x) => {
      x.teams[0].access = { groupObjectIds: ["not-a-uuid"] };
    });
    expect(issuesOf(badId)).toContainEqual(issue("teams[0].access.groupObjectIds[0]", "pattern"));
  });
});

describe("parseConsoleConfig: ポータルのオリジン", () => {
  it.each([
    ["https://portal.example.workers.dev", "workers_dev"],
    ["https://PORTAL.Example.Workers.Dev", "workers_dev"],
    ["https://workers.dev", "workers_dev"],
    ["https://portal.example.workers.dev.", "workers_dev"],
    ["http://portal.example.com", "origin"],
    ["https://portal.example.com/", "origin"],
    ["https://portal.example.com/t/dev", "origin"],
    ["https://user@portal.example.com", "origin"],
    ["portal.example.com", "origin"],
  ])("standardOrigin %s は %s", (origin, code) => {
    const c = withChange(personalConfig, (x) => {
      x.portal.standardOrigin = origin;
    });
    expect(issuesOf(c)).toContainEqual(issue("portal.standardOrigin", code));
  });

  it("adminOrigin の workers.dev も拒否する", () => {
    const c = withChange(companyConfig, (x) => {
      x.portal.adminOrigin = "https://admin.example.workers.dev";
    });
    expect(issuesOf(c)).toContainEqual(issue("portal.adminOrigin", "workers_dev"));
  });

  it("Admin の階層があるのに adminOrigin がなければ admin_origin_missing", () => {
    const c = withChange(companyConfig, (x) => {
      delete x.portal.adminOrigin;
    });
    expect(issuesOf(c)).toContainEqual(issue("portal.adminOrigin", "admin_origin_missing"));
  });

  it("Admin のロールだけがある場合も adminOrigin が要る", () => {
    const c = withChange(personalConfig, (x) => {
      x.roles[0].tier = "admin";
      x.kinds[0].assign = { developer: ["me"] };
    });
    expect(issuesOf(c)).toContainEqual(issue("portal.adminOrigin", "admin_origin_missing"));
  });

  it("standardOrigin と adminOrigin が同じなら origin_same", () => {
    const c = withChange(companyConfig, (x) => {
      x.portal.adminOrigin = x.portal.standardOrigin;
    });
    expect(issuesOf(c)).toContainEqual(issue("portal.adminOrigin", "origin_same"));
  });
});

describe("parseConsoleConfig: 参照と重複", () => {
  it("kinds[].assign の未知のロール・未知のチーム", () => {
    const c = withChange(companyConfig, (x) => {
      x.kinds[0].assign.poweruser = ["sa"];
      x.kinds[0].assign.readonly.push("qa");
    });
    const found = issuesOf(c);
    expect(found).toContainEqual(issue("kinds[0].assign.poweruser", "unknown_role"));
    expect(found).toContainEqual(issue("kinds[0].assign.readonly[2]", "unknown_team"));
  });

  it("assign のキーは Object.prototype の名前でも未知のロールとして扱う", () => {
    const c = withChange(personalConfig, (x) => {
      x.kinds[0].assign = JSON.parse('{"constructor":["me"],"toString":["me"]}');
    });
    const found = issuesOf(c);
    expect(found).toContainEqual(issue("kinds[0].assign.constructor", "unknown_role"));
    expect(found).toContainEqual(issue("kinds[0].assign.toString", "unknown_role"));
  });

  it("organizations の未知の境界・未知の種類", () => {
    const c = withChange(companyConfig, (x) => {
      x.organizations[0].boundary = "partner:nobody";
      x.organizations[0].kindOus.Z = ["ou-abcd-44444444"];
      x.organizations[1].accounts[0].kind = "Q";
    });
    const found = issuesOf(c);
    expect(found).toContainEqual(issue("organizations[0].boundary", "unknown_boundary"));
    expect(found).toContainEqual(issue("organizations[0].kindOus.Z", "unknown_kind"));
    expect(found).toContainEqual(issue("organizations[1].accounts[0].kind", "unknown_kind"));
  });

  it.each([
    ["teams[5].name", (x: Raw) => x.teams.push({ ...x.teams[0] })],
    ["roles[3].name", (x: Raw) => x.roles.push({ ...x.roles[0], roleName: "Other" })],
    ["roles[3].roleName", (x: Raw) => x.roles.push({ ...x.roles[0], name: "other" })],
    ["kinds[4].name", (x: Raw) => x.kinds.push({ name: "A", assign: {} })],
    ["boundaries[2].name", (x: Raw) => x.boundaries.push({ ...x.boundaries[0] })],
    [
      "organizations[2].name",
      (x: Raw) => x.organizations.push({ ...x.organizations[1], accounts: [] }),
    ],
    ["kinds[0].assign.readonly[2]", (x: Raw) => x.kinds[0].assign.readonly.push("sa")],
  ])("名前の重複は duplicate（%s）", (path, change) => {
    expect(issuesOf(withChange(companyConfig, change))).toContainEqual(issue(path, "duplicate"));
  });

  it("アカウント ID の重複は Organization をまたいでも duplicate", () => {
    const c = withChange(companyConfig, (x) => {
      x.organizations.push({
        name: "org-sub",
        boundary: "managed",
        placement: "accounts",
        accounts: [{ accountId: "222222222222", name: "dup", kind: "A" }],
      });
    });
    expect(issuesOf(c)).toContainEqual(
      issue("organizations[2].accounts[0].accountId", "duplicate"),
    );
  });

  it("OU ID の重複（2 つの種類に同じ OU）は duplicate", () => {
    const c = withChange(companyConfig, (x) => {
      x.organizations[0].kindOus.B = ["ou-abcd-11111111"];
    });
    expect(issuesOf(c)).toContainEqual(issue("organizations[0].kindOus.B[0]", "duplicate"));
  });

  it("AUD の重複は入口の AUD も含めて duplicate", () => {
    const aud = "c".repeat(64);
    const c = withChange(personalConfig, (x) => {
      x.teams[0].access = { aud };
      x.teams.push({ name: "you", access: { aud } });
      x.portal.entryAud = { standard: aud };
    });
    const found = issuesOf(c);
    expect(found).toContainEqual(issue("teams[1].access.aud", "duplicate"));
    expect(found).toContainEqual(issue("portal.entryAud.standard", "duplicate"));
  });

  it("issuer の URL の重複（階層・境界をまたいでも）は duplicate", () => {
    const c = withChange(companyConfig, (x) => {
      x.boundaries[1].issuers.standard = x.boundaries[0].issuers.admin;
    });
    expect(issuesOf(c)).toContainEqual(issue("boundaries[1].issuers.standard", "duplicate"));
  });

  it("ロールの name から作る StackSets のパラメーター名が衝突すれば param_collision", () => {
    const c = withChange(personalConfig, (x) => {
      x.roles.push({ ...x.roles[0], name: "read-only", roleName: "Other1" });
      x.roles.push({ ...x.roles[0], name: "a-1", roleName: "Other2" });
      x.roles.push({ ...x.roles[0], name: "a1", roleName: "Other3" });
    });
    const found = issuesOf(c);
    expect(found).toContainEqual(issue("roles[4].name", "param_collision"));
    expect(found).not.toContainEqual(issue("roles[2].name", "param_collision"));
  });
});

describe("parseConsoleConfig: 階層の一致", () => {
  it("Admin のロールに Standard のチームを割り当てると tier_mismatch", () => {
    const c = withChange(companyConfig, (x) => {
      x.kinds[0].assign.admin.push("infra");
    });
    expect(issuesOf(c)).toContainEqual(issue("kinds[0].assign.admin[1]", "tier_mismatch"));
  });

  it("Standard のロールに Admin のチームを割り当てると tier_mismatch", () => {
    const c = withChange(companyConfig, (x) => {
      x.kinds[2].assign.developer.push("dev-elevated");
    });
    expect(issuesOf(c)).toContainEqual(issue("kinds[2].assign.developer[1]", "tier_mismatch"));
  });

  it("境界に Admin の issuer がないのに Admin のロールが届く割り当ては boundary_tier_missing", () => {
    const c = withChange(companyConfig, (x) => {
      x.kinds[3].assign.admin = ["infra-elevated"];
    });
    expect(issuesOf(c)).toContainEqual(issue("organizations[1]", "boundary_tier_missing"));
  });

  it("管理外の境界は placement: ou にできない（ListAccounts を読めない）", () => {
    const c = withChange(companyConfig, (x) => {
      x.organizations[0].boundary = "partner:partner-x";
    });
    expect(issuesOf(c)).toContainEqual(issue("organizations[0].placement", "placement"));
  });
});

describe("parseConsoleConfig: 警告", () => {
  it("どの種類にも割り当てられていないチーム・ロールは警告（エラーにしない）", () => {
    const c = withChange(companyConfig, (x) => {
      for (const k of x.kinds) delete k.assign.developer;
    });
    const { warnings } = parseConsoleConfig(c);
    expect(warnings).toContainEqual(issue("teams[1]", "unassigned_team"));
    expect(warnings).toContainEqual(issue("roles[1]", "unassigned_role"));
  });
});
