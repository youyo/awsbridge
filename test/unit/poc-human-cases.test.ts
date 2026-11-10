import { exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type CheckCase,
  caseClaims,
  checkCases,
  judge,
  markdownTable,
  outcomeLabel,
} from "../../scripts/poc/human/cases";
import { signHumanToken } from "../../scripts/poc/human/lib";

const SUBJECT = "user@example.com";
const cases = checkCases();
const byId = (id: string): CheckCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`case ${id} が無い`);
  return c;
};

let privateJwk: JWK;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateJwk = await exportJWK(privateKey);
});

describe("checkCases（P2・P3 のケース表）", () => {
  it("1〜12 の順で並ぶ", () => {
    expect(cases.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  });
  it("ロールの割り当て: 1〜8 は Tagged、9・10 は NoTag、11・12 は既存ロール", () => {
    for (const id of ["1", "2", "3", "4", "5", "6", "7", "8"]) expect(byId(id).role).toBe("tagged");
    for (const id of ["9", "10"]) expect(byId(id).role).toBe("notag");
    for (const id of ["11", "12"]) expect(byId(id).role).toBe("base");
  });
  it("期待値", () => {
    const exp = Object.fromEntries(cases.map((c) => [c.id, c.expect]));
    expect(exp).toEqual({
      "1": "ok",
      "2": "ok",
      "3": "ok",
      "4": "denied",
      "5": "denied",
      "6": "denied",
      "7": "record",
      "8": "denied",
      "9": "denied",
      "10": "ok",
      "11": "ok",
      "12": "error",
    });
  });
  it("1: 入れ子形式 poc-admin + SI。s3:ListBuckets と iam:ListRoles が通る", () => {
    const c = byId("1");
    expect(c).toMatchObject({
      tags: { access_profile: "poc-admin" },
      tagFormat: "nested",
      sourceIdentity: true,
    });
    expect(c.probes).toEqual([
      { api: "s3:ListBuckets", expect: "ok" },
      { api: "iam:ListRoles", expect: "ok" },
    ]);
  });
  it("2: 1 と形式だけが違う（平坦形式）", () => {
    expect(byId("2")).toMatchObject({ ...pick(byId("1")), tagFormat: "flat" });
  });
  it("3: poc-viewer は引き受けられ、s3:ListBuckets は通り（対照）、iam:ListRoles は拒否", () => {
    const c = byId("3");
    expect(c).toMatchObject({ ...pick(byId("1")), tags: { access_profile: "poc-viewer" } });
    expect(c.probes).toEqual([
      { api: "s3:ListBuckets", expect: "ok" },
      { api: "iam:ListRoles", expect: "denied" },
    ]);
  });
  it("4〜8 は 1 と 1 点だけ違う（否定ケースの原因を 1 つに絞る）", () => {
    const base = pick(byId("1"));
    expect(pick(byId("4"))).toEqual({ ...base, tags: { access_profile: "poc-other" } });
    expect(pick(byId("5"))).toEqual({ ...base, tags: {} });
    expect(pick(byId("6"))).toEqual({
      ...base,
      tags: { access_profile: "poc-admin", unknown_key: "x" },
    });
    expect(pick(byId("7"))).toEqual({ ...base, tags: { Access_Profile: "poc-admin" } });
    expect(pick(byId("8"))).toEqual({ ...base, sourceIdentity: false });
  });
  it("9 は 10（タグも SI もなし）とタグの有無だけが違う", () => {
    expect(pick(byId("10"))).toEqual({
      role: "notag",
      tags: {},
      tagFormat: "nested",
      sourceIdentity: false,
    });
    expect(pick(byId("9"))).toEqual({ ...pick(byId("10")), tags: { access_profile: "poc-admin" } });
  });
  it("否定ケースと 9〜12 では API を試さない（10・11 は対照の s3:ListBuckets だけ）", () => {
    for (const id of ["4", "5", "6", "8", "9", "12"]) expect(byId(id).probes, id).toEqual([]);
    expect(byId("7").probes).toEqual([
      { api: "s3:ListBuckets", expect: "record" },
      { api: "iam:ListRoles", expect: "record" },
    ]);
    expect(byId("10").probes).toEqual([{ api: "s3:ListBuckets", expect: "ok" }]);
    expect(byId("11").probes).toEqual([{ api: "s3:ListBuckets", expect: "ok" }]);
  });
  it("11: 50 個 × 値 256 文字（キーは一意、値は圧縮しにくい文字列）。サイズを記録する", () => {
    const c = byId("11");
    const entries = Object.entries(c.tags);
    expect(entries).toHaveLength(50);
    expect(new Set(entries.map(([k]) => k.toLowerCase())).size).toBe(50);
    for (const [k, v] of entries) {
      expect(k.length).toBeLessThanOrEqual(128);
      expect(v).toHaveLength(256);
      expect(v).toMatch(/^[A-Za-z0-9]+$/);
    }
    expect(new Set(entries.map(([, v]) => v)).size).toBe(50);
    expect(c.reportSize).toBe(true);
    expect(c.sourceIdentity).toBe(false);
  });
  it("11 の JWT は STS の WebIdentityToken 上限（20000 文字）に収まる", async () => {
    const token = await signHumanToken({
      privateJwk,
      issuer: "https://awsbridge-human-poc.example.workers.dev",
      audience: "awsbridge-human-poc",
      subject: SUBJECT,
      extraClaims: caseClaims(byId("11"), SUBJECT),
    });
    expect(token.length).toBeLessThan(20000);
  });
  it("12: 51 個（値は短い。数の上限だけで失敗するように）", () => {
    const c = byId("12");
    expect(Object.keys(c.tags)).toHaveLength(51);
    for (const v of Object.values(c.tags)) expect(v.length).toBeLessThanOrEqual(8);
    expect(c.reportSize).toBe(true);
  });
  it("説明に email を含めない", () => {
    for (const c of cases) expect(c.title).not.toMatch(/@/);
  });
});

describe("caseClaims", () => {
  it("SI ありなら source_identity に subject を入れる。タグは指定の形式", () => {
    expect(caseClaims(byId("2"), SUBJECT)).toEqual({
      "https://aws.amazon.com/tags/principal_tags/access_profile": "poc-admin",
      "https://aws.amazon.com/source_identity": SUBJECT,
    });
  });
  it("SI なし・タグなしなら何も足さない", () => {
    expect(caseClaims(byId("10"), SUBJECT)).toEqual({});
    expect(caseClaims(byId("8"), SUBJECT)).toEqual({
      "https://aws.amazon.com/tags": { principal_tags: { access_profile: ["poc-admin"] } },
    });
  });
});

describe("judge / outcomeLabel", () => {
  it("ok は成功で PASS、失敗で FAIL", () => {
    expect(judge("ok", { ok: true })).toBe("PASS");
    expect(judge("ok", { ok: false, code: "AccessDenied" })).toBe("FAIL");
  });
  it("denied は AccessDenied だけ PASS（ほかのエラーは原因が違うので FAIL）", () => {
    expect(judge("denied", { ok: false, code: "AccessDenied" })).toBe("PASS");
    expect(judge("denied", { ok: false, code: "InvalidIdentityToken" })).toBe("FAIL");
    expect(judge("denied", { ok: true })).toBe("FAIL");
  });
  it("error はどのエラーでも PASS、record は常に INFO", () => {
    expect(judge("error", { ok: false, code: "ValidationError" })).toBe("PASS");
    expect(judge("error", { ok: true })).toBe("FAIL");
    expect(judge("record", { ok: true })).toBe("INFO");
    expect(judge("record", { ok: false, code: "AccessDenied" })).toBe("INFO");
  });
  it("outcomeLabel", () => {
    expect(outcomeLabel({ ok: true })).toBe("成功");
    expect(outcomeLabel({ ok: false, code: "AccessDenied" })).toBe("AccessDenied");
  });
});

describe("markdownTable", () => {
  it("見出し・区切り・行。セル中の | はエスケープする", () => {
    expect(markdownTable(["a", "b"], [["1", "x|y"]])).toBe("| a | b |\n|---|---|\n| 1 | x\\|y |");
  });
});

function pick(c: CheckCase) {
  return { role: c.role, tags: c.tags, tagFormat: c.tagFormat, sourceIdentity: c.sourceIdentity };
}
