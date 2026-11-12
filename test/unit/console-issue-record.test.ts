// コンソールログイン PR2: 発行記録の型と、伏せ字にして出す関数（portal §10.3・console-login.md §5.6）。
import { describe, expect, it } from "vitest";
import {
  createIssueRecord,
  type IssueRecord,
  issueLogRecord,
  maskAccessKeyId,
  maskAssumedRoleId,
  maskIssueRecord,
  maskRequestId,
} from "../../src/console/issue/record";

const JTI = "0b9a9d6e-1f4e-4c55-9d2a-7f3c1a2b3c4d";
const ACCESS_KEY_ID = ["ASIA", "Q".repeat(16)].join("");
const ROLE_ID = ["AROA", "Z".repeat(17)].join("");
const REQUEST_ID = "5e1b7c2a-8d3f-4a6b-9c0d-112233445566";

const record = (over: Partial<Parameters<typeof createIssueRecord>[0]> = {}): IssueRecord =>
  createIssueRecord({
    tier: "standard",
    result: "ok",
    now: Date.UTC(2026, 10, 12, 1, 2, 3),
    identity: { sub: "access-sub-0123456789", email: "Alice@Example.com", oid: "oid-0123456789" },
    resolved: {
      email: "alice@example.com",
      sourceIdentity: "alice@example.com",
      sessionName: "console-alice@example.com",
    },
    row: {
      team: "infra",
      boundary: "managed",
      issuer: "https://idp.example.test/standard",
      accountId: "123456789012",
      role: "viewer",
      roleArn: "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
      sessionSeconds: 3600,
    },
    token: { jti: JTI, iat: 1_700_000_000, exp: 1_700_000_300 },
    consoleRegion: "us-east-1",
    sts: {
      region: "ap-northeast-1",
      accessKeyId: ACCESS_KEY_ID,
      assumedRoleId: `${ROLE_ID}:console-alice@example.com`,
      requestId: REQUEST_ID,
    },
    cfRay: "ray-1",
    list: { generatedAt: "2026-11-12T00:00:00Z", sourceRevision: "abc123" },
    ...over,
  });

describe("createIssueRecord", () => {
  it("設計の項目を持ち、時刻は ISO 8601", () => {
    expect(record()).toEqual({
      result: "ok",
      at: "2026-11-12T01:02:03.000Z",
      tier: "standard",
      team: "infra",
      user: {
        email: "alice@example.com",
        sourceIdentity: "alice@example.com",
        accessSub: "access-sub-0123456789",
        oid: "oid-0123456789",
      },
      target: {
        accountId: "123456789012",
        role: "viewer",
        roleArn: "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
        boundary: "managed",
        issuer: "https://idp.example.test/standard",
      },
      jwt: { jti: JTI, iat: 1_700_000_000, exp: 1_700_000_300 },
      sts: {
        region: "ap-northeast-1",
        accessKeyId: ACCESS_KEY_ID,
        assumedRoleId: `${ROLE_ID}:console-alice@example.com`,
        requestId: REQUEST_ID,
      },
      session: { seconds: 3600, consoleRegion: "us-east-1" },
      cfRay: "ray-1",
      list: { generatedAt: "2026-11-12T00:00:00Z", sourceRevision: "abc123" },
    });
  });

  it("失敗の記録は、署名や STS の前なら jwt・sts の ID を持たなくてよい（result に §9.4 の code）", () => {
    const r = record({ result: "sts_denied", token: undefined, sts: { region: "ap-northeast-1" } });
    expect(r.result).toBe("sts_denied");
    expect(r.jwt).toBeUndefined();
    expect(r.sts).toEqual({ region: "ap-northeast-1" });
  });

  it("認証情報の項目（秘密鍵・セッショントークン）と URL を持たない", () => {
    const text = JSON.stringify(record());
    for (const k of ["secret", "sessionToken", "SigninToken", "signinToken", "Location", "http://"])
      expect(text).not.toContain(k);
    expect(Object.keys(record().sts).sort()).toEqual(
      ["accessKeyId", "assumedRoleId", "region", "requestId"].sort(),
    );
  });

  it("アカウントの email を持たない", () => {
    expect(JSON.stringify(record().target)).not.toContain("@");
  });
});

describe("maskIssueRecord（画面・共有するログに貼れる形）", () => {
  const masked = maskIssueRecord(record());
  const text = JSON.stringify(masked);

  it("email・jti・アカウント ID・ロール ARN・STS の ID を伏せる", () => {
    expect(masked.user.email).toBe("a***@***.com");
    expect(masked.jwt?.jti).toBe("0b9a9d6e…");
    expect(masked.target.accountId).toBe("********9012");
    expect(masked.target.roleArn).toBe(
      "arn:aws:iam::********9012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
    );
    expect(masked.sts.accessKeyId).toBe("ASIA…QQQQ");
    expect(masked.sts.assumedRoleId).toBe("AROA…");
    expect(masked.sts.requestId).toBe("5e1b7c2a…");
  });

  it("元の値（完全な email・jti・12 桁のアカウント ID・AccessKeyId・RoleId・セッション名・RequestId）が出力に残らない", () => {
    for (const v of [
      "alice@example.com",
      JTI,
      "123456789012",
      ACCESS_KEY_ID,
      ROLE_ID,
      "console-alice",
      REQUEST_ID,
      "access-sub-0123456789",
      "oid-0123456789",
    ])
      expect(text, v).not.toContain(v);
  });

  it("チーム・ロール名・境界・時刻・リージョン・結果は伏せない（状況を読むのに要る）", () => {
    expect(masked).toMatchObject({
      result: "ok",
      at: "2026-11-12T01:02:03.000Z",
      tier: "standard",
      team: "infra",
      target: { role: "viewer", boundary: "managed", issuer: "https://idp.example.test/standard" },
      jwt: { iat: 1_700_000_000, exp: 1_700_000_300 },
      sts: { region: "ap-northeast-1" },
      session: { seconds: 3600, consoleRegion: "us-east-1" },
    });
  });

  it("SourceIdentity が email でない出どころ（custom.<名前>）でも値をそのまま出さない", () => {
    const m = maskIssueRecord(
      record({
        resolved: {
          email: "alice@example.com",
          sourceIdentity: "E-1234567",
          sessionName: "console-alice@example.com",
        },
      }),
    );
    expect(m.user.sourceIdentity).toBe("E***");
  });

  it("欠けた項目（失敗の記録）も壊れずに伏せる", () => {
    const m = maskIssueRecord(record({ token: undefined, sts: { region: "ap-northeast-1" } }));
    expect(m.jwt).toBeUndefined();
    expect(m.sts).toEqual({ region: "ap-northeast-1" });
  });
});

describe("記録の中身の追加（cto の決裁 2026-11-13: kid と Worker の版 ID）", () => {
  it("署名した鍵の kid と Worker の版 ID を持つ（渡されたときだけ）", () => {
    const r = record({
      token: { jti: JTI, iat: 1_700_000_000, exp: 1_700_000_300, kid: "kid-abc" },
      workerVersionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    });
    expect(r.jwt).toEqual({ jti: JTI, iat: 1_700_000_000, exp: 1_700_000_300, kid: "kid-abc" });
    expect(r.worker).toEqual({ versionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
    const none = record();
    expect(none.jwt).not.toHaveProperty("kid");
    expect(none).not.toHaveProperty("worker");
  });
});

describe("issueLogRecord（Worker のログに出す発行記録。cto の決裁: アカウント ID とロール ARN は全桁、email は伏せる）", () => {
  const log = issueLogRecord(
    record({
      token: { jti: JTI, iat: 1_700_000_000, exp: 1_700_000_300, kid: "kid-abc" },
      workerVersionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    }),
  );
  const text = JSON.stringify(log);

  it("jti・kid・アカウント ID・ロール ARN・Worker の版 ID は全桁（突き合わせのキー）", () => {
    expect(log.jwt).toEqual({ jti: JTI, iat: 1_700_000_000, exp: 1_700_000_300, kid: "kid-abc" });
    expect(log.target.accountId).toBe("123456789012");
    expect(log.target.roleArn).toBe(
      "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
    );
    expect(log.worker).toEqual({ versionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  });

  it("email・SourceIdentity・Access の sub・oid・STS の ID は伏せたまま（maskIssueRecord と同じ形）", () => {
    const m = maskIssueRecord(record());
    expect(log.user).toEqual(m.user);
    expect(log.sts).toEqual(m.sts);
    for (const v of [
      "alice@example.com",
      ACCESS_KEY_ID,
      ROLE_ID,
      "console-alice",
      REQUEST_ID,
      "access-sub-0123456789",
      "oid-0123456789",
    ])
      expect(text, v).not.toContain(v);
    expect(text).not.toMatch(/[^\s"*]+@[^\s"*]+\.[a-z]+/i);
  });

  it("STS の ID の伏せ字の関数を外に出す（突き合わせの道具が CloudTrail の値を同じ形にして比べる）", () => {
    expect(maskAccessKeyId(ACCESS_KEY_ID)).toBe("ASIA…QQQQ");
    expect(maskAssumedRoleId(`${ROLE_ID}:console-alice@example.com`)).toBe("AROA…");
    expect(maskRequestId(REQUEST_ID)).toBe("5e1b7c2a…");
  });
});
