// コンソールログイン PR2: 身元の制約（identity.ts）と JWT の claim（claims.ts）。設計: console-login.md §3.4。
import { describe, expect, it } from "vitest";
import { AUDIENCE, TEAM_TAG_KEY, UUID_RE } from "../../src/console/constants";
import {
  AWS_SOURCE_IDENTITY_CLAIM,
  AWS_TAGS_CLAIM,
  buildClaims,
  TOKEN_TTL_SECONDS,
} from "../../src/console/issue/claims";
import { type AccessIdentity, resolveIdentity } from "../../src/console/issue/identity";

const emailOfLength = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;
const who = (email: string, extra: Partial<AccessIdentity> = {}): AccessIdentity => ({
  sub: "access-sub-1",
  email,
  ...extra,
});

describe("resolveIdentity（身元の制約。切り詰めない）", () => {
  it("57 文字の email は identity_unsupported（RoleSessionName の console- を付けると 65 文字）", () => {
    const email = emailOfLength(57);
    expect(email).toHaveLength(57);
    expect(resolveIdentity(who(email), "email")).toEqual({
      ok: false,
      code: "identity_unsupported",
    });
  });

  it("56 文字の email は通り、RoleSessionName は console-<email>（64 文字）", () => {
    const email = emailOfLength(56);
    const r = resolveIdentity(who(email), "email");
    expect(r).toEqual({
      ok: true,
      value: { email, sourceIdentity: email, sessionName: `console-${email}` },
    });
    if (r.ok) expect(r.value.sessionName).toHaveLength(64);
  });

  it("email は小文字にして SourceIdentity・RoleSessionName に使う", () => {
    const r = resolveIdentity(who("Alice.Smith@Example.COM"), "email");
    expect(r).toMatchObject({
      ok: true,
      value: {
        email: "alice.smith@example.com",
        sourceIdentity: "alice.smith@example.com",
        sessionName: "console-alice.smith@example.com",
      },
    });
  });

  it.each([
    "",
    "no-at-sign",
    "a b@example.com",
    "a/b@example.com",
    "a@@example.com",
    "@example.com",
  ])("RoleSessionName に使えない・形が崩れた email %j は identity_unsupported", (email) => {
    expect(resolveIdentity(who(email), "email")).toEqual({
      ok: false,
      code: "identity_unsupported",
    });
  });

  it("小文字化の前に ASCII を検査する（Kelvin 記号 U+212A は小文字化で k になるので通さない）", () => {
    const kelvin = "\u212Aim@example.com";
    expect(kelvin.toLowerCase()).toBe("kim@example.com"); // 前提: 小文字化すると ASCII に化ける
    expect(resolveIdentity(who(kelvin), "email")).toEqual({
      ok: false,
      code: "identity_unsupported",
    });
    expect(resolveIdentity(who("\u0130x@example.com"), "email")).toEqual({
      ok: false,
      code: "identity_unsupported",
    });
  });

  it("email が文字列でなければ identity_unsupported", () => {
    expect(resolveIdentity({ sub: "s", email: undefined as unknown as string }, "email")).toEqual({
      ok: false,
      code: "identity_unsupported",
    });
  });

  describe("custom.<名前>（SourceIdentity の出どころを切り替えたとき）", () => {
    it("custom の値を SourceIdentity にする（RoleSessionName は email のまま）", () => {
      const r = resolveIdentity(
        who("a@example.com", { custom: { employeeId: "E-1234" } }),
        "custom.employeeId",
      );
      expect(r).toEqual({
        ok: true,
        value: {
          email: "a@example.com",
          sourceIdentity: "E-1234",
          sessionName: "console-a@example.com",
        },
      });
    });

    it("64 文字までは通り、65 文字は identity_unsupported", () => {
      const ok = resolveIdentity(
        who("a@example.com", { custom: { id: "x".repeat(64) } }),
        "custom.id",
      );
      expect(ok).toMatchObject({ ok: true, value: { sourceIdentity: "x".repeat(64) } });
      const ng = resolveIdentity(
        who("a@example.com", { custom: { id: "x".repeat(65) } }),
        "custom.id",
      );
      expect(ng).toEqual({ ok: false, code: "identity_unsupported" });
    });

    it.each([
      ["値がない", { custom: {} }],
      ["custom がない", {}],
      ["文字列でない", { custom: { id: 12345 } }],
      ["1 文字", { custom: { id: "x" } }],
      ["使えない文字（空白）", { custom: { id: "a b" } }],
      ["継承したプロパティ", { custom: {} }],
    ] as [string, Partial<AccessIdentity>][])("%s は identity_unsupported", (_name, extra) => {
      expect(resolveIdentity(who("a@example.com", extra), "custom.id")).toEqual({
        ok: false,
        code: "identity_unsupported",
      });
    });

    it("Object.prototype の名前（custom.constructor）は拾わない", () => {
      expect(resolveIdentity(who("a@example.com", { custom: {} }), "custom.constructor")).toEqual({
        ok: false,
        code: "identity_unsupported",
      });
    });

    it("custom でも email が RoleSessionName の制約に合わなければ identity_unsupported", () => {
      const r = resolveIdentity(who(emailOfLength(57), { custom: { id: "E-1" } }), "custom.id");
      expect(r).toEqual({ ok: false, code: "identity_unsupported" });
    });
  });
});

describe("buildClaims（STS に渡す JWT の claim）", () => {
  const base = {
    issuer: "https://idp.example.test/standard",
    sub: "a@example.com",
    team: "infra",
    sourceIdentity: "a@example.com",
    now: 1_700_000_000,
  };

  it("azp が無く、jti は UUID", () => {
    const c = buildClaims(base);
    expect("azp" in c).toBe(false);
    expect(c.jti).toMatch(UUID_RE);
  });

  it("claim は iss・aud・sub・タグ・SourceIdentity・jti・iat・exp だけ", () => {
    const c = buildClaims(base);
    expect(Object.keys(c).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "jti", AWS_SOURCE_IDENTITY_CLAIM, AWS_TAGS_CLAIM, "sub"].sort(),
    );
    expect(c).toMatchObject({
      iss: base.issuer,
      aud: AUDIENCE,
      sub: "a@example.com",
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 300,
      [AWS_SOURCE_IDENTITY_CLAIM]: "a@example.com",
    });
    expect(TOKEN_TTL_SECONDS).toBe(300);
  });

  it("タグは入れ子形式で awsbridge_team の 1 つだけ。transitive_tag_keys は入れない", () => {
    const c = buildClaims(base);
    expect(c[AWS_TAGS_CLAIM]).toEqual({ principal_tags: { [TEAM_TAG_KEY]: ["infra"] } });
    expect(JSON.stringify(c)).not.toContain("transitive_tag_keys");
  });

  it("jti は呼ぶたびに変わる。差し込みもできる", () => {
    expect(buildClaims(base).jti).not.toBe(buildClaims(base).jti);
    expect(buildClaims({ ...base, jti: "11111111-1111-4111-8111-111111111111" }).jti).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it.each([
    ["チーム名が規則に合わない", { team: "Infra Team" }],
    ["issuer が https でない", { issuer: "http://idp.example.test/standard" }],
    ["SourceIdentity が 65 文字", { sourceIdentity: "x".repeat(65) }],
    ["SourceIdentity が空", { sourceIdentity: "" }],
  ])("%s は例外（発行しない側に倒す）", (_n, over) => {
    expect(() => buildClaims({ ...base, ...over })).toThrow();
  });
});
