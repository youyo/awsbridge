import { describe, expect, it } from "vitest";
import {
  ProfilesConfigError,
  parseProfilesConfig,
  profileNames,
  selectProfile,
} from "../../src/profiles";

const A = "arn:aws:iam::111111111111:role/awsbridge";
const B = "arn:aws:iam::222222222222:role/awsbridge";
const valid = {
  default: "dev",
  profiles: { dev: { roleArn: A, description: "dev" }, "prod-1_x": { roleArn: B } },
  tools: ["call_aws"],
};

function kindOf(raw: unknown): string {
  try {
    parseProfilesConfig(raw);
  } catch (e) {
    if (e instanceof ProfilesConfigError) return e.kind;
    throw e;
  }
  return "ok";
}

describe("parseProfilesConfig", () => {
  it("未設定・空文字は missing（必須設定）", () => {
    expect(kindOf(undefined)).toBe("missing");
    expect(kindOf("")).toBe("missing");
  });

  it("default が無い・文字列でない・profiles に存在しない（prototype 由来含む）は default エラー", () => {
    expect(kindOf({ profiles: { a: { roleArn: A } } })).toBe("default");
    expect(kindOf({ default: 1, profiles: { a: { roleArn: A } } })).toBe("default");
    expect(kindOf({ default: "zzz", profiles: { a: { roleArn: A } } })).toBe("default");
    expect(kindOf({ default: "toString", profiles: { a: { roleArn: A } } })).toBe("default");
  });

  it("オブジェクト（vars）と JSON 文字列（secret）の両方を受け付ける", () => {
    const fromObj = parseProfilesConfig(valid);
    const fromStr = parseProfilesConfig(JSON.stringify(valid));
    expect(fromObj).toEqual(valid);
    expect(fromStr).toEqual(valid);
  });

  it("tools は省略できる", () => {
    const cfg = parseProfilesConfig({ default: "a", profiles: { a: { roleArn: A } } });
    expect(cfg?.tools).toBeUndefined();
  });

  it("同じ入力は isolate 内でキャッシュされる", () => {
    const s = JSON.stringify(valid);
    expect(parseProfilesConfig(s)).toBe(parseProfilesConfig(s));
    expect(parseProfilesConfig(valid)).toBe(parseProfilesConfig(valid));
  });

  it("不正な設定は ProfilesConfigError（種別つき）", () => {
    expect(kindOf("{not json")).toBe("json");
    expect(kindOf(null)).toBe("shape");
    expect(kindOf([])).toBe("shape");
    expect(kindOf(42)).toBe("shape");
    expect(kindOf({})).toBe("shape");
    expect(kindOf({ profiles: "x" })).toBe("shape");
    expect(kindOf({ profiles: [] })).toBe("profiles_empty"); // 配列形式が有効になったため空配列は profiles_empty
    expect(kindOf({ profiles: {} })).toBe("profiles_empty");
    expect(kindOf({ profiles: { "bad name": { roleArn: A } } })).toBe("profile_name");
    expect(kindOf({ profiles: { "": { roleArn: A } } })).toBe("profile_name");
    expect(kindOf({ profiles: { [`a${"b".repeat(32)}`]: { roleArn: A } } })).toBe("profile_name");
    expect(
      kindOf({ default: "x".repeat(32), profiles: { ["x".repeat(32)]: { roleArn: A } } }),
    ).toBe("ok");
    expect(kindOf({ profiles: { a: { roleArn: "arn:aws:iam::123:role/x" } } })).toBe("role_arn");
    expect(kindOf({ profiles: { a: { roleArn: "arn:aws:iam::111111111111:user/x" } } })).toBe(
      "role_arn",
    );
    expect(kindOf({ profiles: { a: {} } })).toBe("role_arn");
    expect(kindOf({ profiles: { a: "x" } })).toBe("shape");
    expect(kindOf({ profiles: { a: { roleArn: A, description: 1 } } })).toBe("shape");
    expect(kindOf({ default: "a", profiles: { a: { roleArn: A } }, tools: [] })).toBe("tools");
    expect(kindOf({ default: "a", profiles: { a: { roleArn: A } }, tools: "call_aws" })).toBe(
      "tools",
    );
    expect(kindOf({ default: "a", profiles: { a: { roleArn: A } }, tools: [""] })).toBe("tools");
    expect(kindOf({ default: "a", profiles: { a: { roleArn: A } }, tools: [1] })).toBe("tools");
  });

  it("aws-cn / aws-us-gov のパーティションも受け付ける", () => {
    expect(
      kindOf({
        default: "a",
        profiles: { a: { roleArn: "arn:aws-cn:iam::111111111111:role/path/awsbridge" } },
      }),
    ).toBe("ok");
  });

  it("エラーメッセージに設定値を含めない", () => {
    try {
      parseProfilesConfig({ default: "a", profiles: { a: { roleArn: "SECRET-VALUE" } } });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET-VALUE");
    }
  });
});

const cfg = () => {
  const c = parseProfilesConfig(valid);
  if (!c) throw new Error("no config");
  return c;
};
const call = (args?: unknown, name = "call_aws") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
});
const DEV = { kind: "profile", name: "dev", roleArn: A };

describe("selectProfile", () => {
  it("対象ツールで aws_profile があればそのロールを選び、arguments から取り除く", () => {
    const rpc = call({ cli_command: "aws s3 ls", aws_profile: "prod-1_x" });
    expect(selectProfile(cfg(), rpc)).toEqual({ kind: "profile", name: "prod-1_x", roleArn: B });
    expect(rpc.params).toEqual({ name: "call_aws", arguments: { cli_command: "aws s3 ls" } });
  });

  it("対象ツールで aws_profile が無ければ default のロール", () => {
    for (const a of [undefined, {}, null, "x", [], { other: 1 }]) {
      expect(selectProfile(cfg(), call(a)), JSON.stringify(a)).toEqual(DEV);
    }
  });

  it("一覧にない名前は unknown_aws_profile（prototype 由来の名前も不可）", () => {
    for (const n of ["nope", "", "DEV", "__proto__", "constructor", "toString"]) {
      expect(selectProfile(cfg(), call({ aws_profile: n })), n).toEqual({
        kind: "error",
        code: "unknown_aws_profile",
      });
    }
  });

  it("文字列以外は invalid_aws_profile", () => {
    for (const v of [1, true, null, {}, ["dev"]]) {
      expect(selectProfile(cfg(), call({ aws_profile: v })), JSON.stringify(v)).toEqual({
        kind: "error",
        code: "invalid_aws_profile",
      });
    }
  });

  it("tools に含まれないツールは default。aws_profile は検証せず取り除く", () => {
    const rpc = call({ x: 1, aws_profile: "nope" }, "other_tool");
    expect(selectProfile(cfg(), rpc)).toEqual(DEV);
    expect(rpc.params.arguments).toEqual({ x: 1 });
    const rpc2 = call({ aws_profile: 5 }, "other_tool");
    expect(selectProfile(cfg(), rpc2)).toEqual(DEV);
    expect(rpc2.params.arguments).toEqual({});
  });

  it("tools 省略時は全ツールが対象", () => {
    const c = parseProfilesConfig({ default: "dev", profiles: valid.profiles });
    if (!c) throw new Error("no config");
    expect(selectProfile(c, call({ aws_profile: "prod-1_x" }, "any_tool"))).toMatchObject({
      roleArn: B,
    });
    expect(selectProfile(c, call({ aws_profile: "nope" }, "any_tool"))).toMatchObject({
      code: "unknown_aws_profile",
    });
  });

  it("tools/call 以外は default で、本文は変えない", () => {
    for (const method of ["initialize", "tools/list", "ping", "notifications/initialized"]) {
      const rpc = { jsonrpc: "2.0", id: 1, method, params: { aws_profile: "x" } };
      expect(selectProfile(cfg(), rpc)).toEqual(DEV);
      expect(rpc.params).toEqual({ aws_profile: "x" });
    }
  });

  it("形が想定外の本文（非 object・params 無し・name 無し）は default", () => {
    expect(selectProfile(cfg(), "x")).toEqual(DEV);
    expect(selectProfile(cfg(), null)).toEqual(DEV);
    expect(selectProfile(cfg(), { method: "tools/call" })).toEqual(DEV);
    expect(selectProfile(cfg(), { method: "tools/call", params: { arguments: {} } })).toEqual(DEV);
  });

  describe("バッチ", () => {
    it("対象ツールの aws_profile がすべて同じならそのロール、全部取り除く", () => {
      const batch = [
        { jsonrpc: "2.0", method: "tools/list" },
        call({ aws_profile: "prod-1_x", a: 1 }),
        call({ aws_profile: "prod-1_x" }),
        call({ aws_profile: "zzz" }, "other_tool"),
      ];
      expect(selectProfile(cfg(), batch)).toEqual({
        kind: "profile",
        name: "prod-1_x",
        roleArn: B,
      });
      expect(JSON.stringify(batch)).not.toContain("aws_profile");
    });

    it("すべて省略なら default。省略と default 明示は同じ扱い", () => {
      expect(selectProfile(cfg(), [call({}), call({ aws_profile: "dev" })])).toEqual(DEV);
      expect(selectProfile(cfg(), [{ method: "tools/list" }])).toEqual(DEV);
    });

    it("異なるプロファイルが混在すれば batch_not_supported（省略は default と比較）", () => {
      const e = { kind: "error", code: "batch_not_supported" };
      expect(
        selectProfile(cfg(), [call({ aws_profile: "dev" }), call({ aws_profile: "prod-1_x" })]),
      ).toEqual(e);
      expect(selectProfile(cfg(), [call({}), call({ aws_profile: "prod-1_x" })])).toEqual(e);
    });

    it("バッチ内の未知・型違いはそのエラー", () => {
      expect(selectProfile(cfg(), [call({ aws_profile: "nope" })])).toMatchObject({
        code: "unknown_aws_profile",
      });
      expect(selectProfile(cfg(), [call({ aws_profile: 1 })])).toMatchObject({
        code: "invalid_aws_profile",
      });
    });
  });
});

describe("profiles の配列形式", () => {
  const arr = {
    default: "dev-readonly",
    profiles: [
      { name: "dev-readonly", roleArn: A, description: "ro" },
      { name: "dev-debug", roleArn: B },
      { name: "prod", roleArn: A },
    ],
  };

  it("配列形式を受け付け、オブジェクト形式と同じ ProfilesConfig になり、順が保たれる", () => {
    const cfg = parseProfilesConfig(arr);
    expect(Object.keys(cfg.profiles)).toEqual(["dev-readonly", "dev-debug", "prod"]);
    expect(cfg.profiles["dev-readonly"]).toEqual({ roleArn: A, description: "ro" });
    expect(cfg.profiles["dev-debug"]).toEqual({ roleArn: B });
    expect(parseProfilesConfig(JSON.stringify(arr))).toEqual(cfg);
  });

  it("オブジェクト形式も従来どおり（キーの順）", () => {
    const cfg = parseProfilesConfig(valid);
    expect(Object.keys(cfg.profiles)).toEqual(["dev", "prod-1_x"]);
  });

  it("配列形式の不正は種別つきエラー", () => {
    const e = (profiles: unknown, d = "a") => kindOf({ default: d, profiles });
    expect(e([])).toBe("profiles_empty");
    expect(e([null])).toBe("shape");
    expect(e(["a"])).toBe("shape");
    expect(e([{ roleArn: A }])).toBe("profile_name");
    expect(e([{ name: 1, roleArn: A }])).toBe("profile_name");
    expect(e([{ name: "bad name", roleArn: A }])).toBe("profile_name");
    expect(e([{ name: "a", roleArn: "x" }])).toBe("role_arn");
    expect(e([{ name: "a", roleArn: A, description: 1 }])).toBe("shape");
    expect(e([{ name: "b", roleArn: A }])).toBe("default");
  });

  it("名前の重複は duplicate エラー", () => {
    expect(
      kindOf({
        default: "a",
        profiles: [
          { name: "a", roleArn: A },
          { name: "a", roleArn: B },
        ],
      }),
    ).toBe("duplicate");
  });

  it("prototype 由来の名前（__proto__ など）でも配列形式で壊れない", () => {
    const cfg = parseProfilesConfig({
      default: "a",
      profiles: [{ name: "a", roleArn: A }],
    });
    expect(Object.hasOwn(cfg.profiles, "toString")).toBe(false);
  });
});

describe("profileNames", () => {
  it("default を先頭に、残りを設定の順に並べる", () => {
    const cfg = parseProfilesConfig({
      default: "b",
      profiles: [
        { name: "a", roleArn: A },
        { name: "b", roleArn: A },
        { name: "c", roleArn: A },
      ],
    });
    expect(profileNames(cfg)).toEqual(["b", "a", "c"]);
  });

  it("default が先頭ならそのまま", () => {
    expect(profileNames(parseProfilesConfig(valid))).toEqual(["dev", "prod-1_x"]);
  });
});

describe("配列形式での selectProfile", () => {
  it("aws_profile で配列形式のプロファイルを選べる", () => {
    const cfg = parseProfilesConfig({
      default: "a",
      profiles: [
        { name: "a", roleArn: A },
        { name: "b", roleArn: B },
      ],
    });
    const rpc = {
      method: "tools/call",
      params: { name: "call_aws", arguments: { aws_profile: "b" } },
    };
    expect(selectProfile(cfg, rpc)).toEqual({ kind: "profile", name: "b", roleArn: B });
  });
});
