// 突き合わせの道具の入力: 発行記録の行（NDJSON。生の行・Trace Events の包み・Workers Logs のイベント）と、
// CloudTrail の AssumeRoleWithWebIdentity のイベントを読む部品（src/console/reconcile-input.ts）。
// 切られた行（$cloudflare.truncated など）・読めない行は位置だけを返し、読み飛ばさない（cto の決裁 (c)）。
import { describe, expect, it } from "vitest";
import {
  parseAssumeEvent,
  readRecordLines,
  recordsFromLogEvents,
} from "../../src/console/reconcile-input";

const JTI = "0b9a9d6e-1f4e-4c55-9d2a-7f3c1a2b3c4d";
const ACCOUNT = "333333333333";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/FederatedViewer`;
// AWS のキーの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const ACCESS_KEY_ID = ["ASIA", "Q".repeat(16)].join("");

/** Worker の発行記録（issueLogRecord の形）。 */
const issue = (over: Record<string, unknown> = {}) => ({
  event: "console_issue",
  result: "ok",
  at: "2026-11-12T01:02:03.000Z",
  tier: "standard",
  team: "infra",
  user: { email: "a***@***.com", sourceIdentity: "a***@***.com", accessSub: "1111…" },
  target: {
    accountId: ACCOUNT,
    role: "readonly",
    roleArn: ROLE_ARN,
    boundary: "managed",
    issuer: "https://awsbridge-oidc-console.example.com/standard",
  },
  jwt: { jti: JTI, iat: 1_794_446_523, exp: 1_794_446_823, kid: "kid-1" },
  sts: {
    region: "us-east-1",
    accessKeyId: "ASIA…QQQQ",
    assumedRoleId: "AROA…",
    requestId: "5e1b7c2a…",
  },
  session: { seconds: 3600, consoleRegion: "us-east-1" },
  ...over,
});

describe("readRecordLines（NDJSON のファイルの中身）", () => {
  it("生の行（console.log の JSON）から記録を読み、位置（ファイル:行）を付ける", () => {
    const text = [JSON.stringify(issue()), "", JSON.stringify({ event: "other" })].join("\n");
    const r = readRecordLines(text, "a.ndjson");
    expect(r.lines).toBe(2);
    expect(r.truncated).toEqual([]);
    expect(r.unreadable).toEqual([]);
    expect(r.records).toEqual([
      {
        pos: "a.ndjson:1",
        result: "ok",
        at: Date.UTC(2026, 10, 12, 1, 2, 3),
        tier: "standard",
        team: "infra",
        accountId: ACCOUNT,
        roleArn: ROLE_ARN,
        stsRegion: "us-east-1",
        jti: JTI,
        iat: 1_794_446_523,
        exp: 1_794_446_823,
        kid: "kid-1",
        identity: "a***@***.com",
        accessKeyId: "ASIA…QQQQ",
        assumedRoleId: "AROA…",
        requestId: "5e1b7c2a…",
      },
    ]);
  });

  it("利用者は SourceIdentity に使った値（無ければ email）を、伏せ字の形で持つ。素の email が入っていても伏せ字にして持ち、値を残さない", () => {
    const pick = (user: unknown) =>
      readRecordLines(JSON.stringify(issue({ user })), "a.ndjson").records[0]?.identity;
    expect(pick({ email: "a***@***.com", sourceIdentity: "b***@***.org" })).toBe("b***@***.org");
    expect(pick({ email: "a***@***.com" })).toBe("a***@***.com");
    expect(pick({ email: "alice@example.com", sourceIdentity: "alice@example.com" })).toBe(
      "a***@***.com",
    );
    expect(pick({ accessSub: "1111…" })).toBeUndefined();
    expect(pick(undefined)).toBeUndefined();
    const all = JSON.stringify(
      readRecordLines(JSON.stringify(issue({ user: { email: "alice@example.com" } })), "a").records,
    );
    expect(all).not.toContain("alice");
  });

  it("Trace Events の包み（Logs[].Message[0] が JSON の文字列）からも読む", () => {
    const trace = {
      ScriptName: "awsbridge-console-standard",
      Outcome: "ok",
      Logs: [
        { Level: "log", Message: ["plain text"], TimestampMs: 1 },
        { Level: "log", Message: [JSON.stringify(issue())], TimestampMs: 2 },
      ],
    };
    const r = readRecordLines(JSON.stringify(trace), "t.log");
    expect(r.records.map((x) => [x.pos, x.jti])).toEqual([["t.log:1", JTI]]);
  });

  it("Workers Logs のイベント（source が構造化済みのオブジェクトか JSON の文字列）からも読む", () => {
    const a = { $metadata: { id: "e1" }, $workers: { scriptName: "x" }, source: issue() };
    const b = { $metadata: { id: "e2" }, source: JSON.stringify(issue({ result: "sts_denied" })) };
    const r = readRecordLines([a, b].map((o) => JSON.stringify(o)).join("\n"), "w.json");
    expect(r.records.map((x) => x.result)).toEqual(["ok", "sts_denied"]);
  });

  it("切られた行（$cloudflare.truncated・$workers.truncated・Logpush の truncated の印）は位置だけを返し、記録として読まない", () => {
    const lines = [
      { $cloudflare: { truncated: true }, source: issue() },
      { $workers: { scriptName: "x", truncated: true }, source: { event: "other" } },
      { Logs: [{ Message: ["<<<Logpush: logs truncated>>>"] }] },
      { ...issue(), $cloudflare: { truncated: true } },
    ];
    const r = readRecordLines(lines.map((o) => JSON.stringify(o)).join("\n"), "c.ndjson");
    expect(r.truncated).toEqual(["c.ndjson:1", "c.ndjson:2", "c.ndjson:3", "c.ndjson:4"]);
    expect(r.records).toEqual([]);
  });

  it("読めない行（JSON でない・記録の形が壊れている）は位置だけを返す（値は出さない）", () => {
    const text = [
      '{"event":"console_issue","result":"ok","user":{"email":"alice@exa',
      JSON.stringify(issue({ at: "not a date" })),
      JSON.stringify(issue({ target: { accountId: 1 } })),
      JSON.stringify({ Logs: [{ Message: ['{"event":"console_issue",'] }] }),
    ].join("\n");
    const r = readRecordLines(text, "b.ndjson");
    expect(r.unreadable).toEqual(["b.ndjson:1", "b.ndjson:2", "b.ndjson:3", "b.ndjson:4"]);
    expect(r.records).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("alice");
  });

  it("jwt が無い記録（署名の前の失敗）も読む（jti は持たない）", () => {
    const { jwt: _jwt, ...noJwt } = issue({ result: "rate_limited" });
    const r = readRecordLines(JSON.stringify(noJwt), "n.ndjson");
    expect(r.records[0]?.result).toBe("rate_limited");
    expect(r.records[0]).not.toHaveProperty("jti");
  });

  it("Worker の名前を渡すと、ほかの Worker（$workers.scriptName・ScriptName）の行は数えない", () => {
    const lines = [
      { $workers: { scriptName: "other", truncated: true }, source: issue() },
      { ScriptName: "other", Logs: [{ Message: [JSON.stringify(issue())] }] },
      { $workers: { scriptName: "awsbridge-console-admin" }, source: issue({ tier: "admin" }) },
    ];
    const r = readRecordLines(lines.map((o) => JSON.stringify(o)).join("\n"), "s.ndjson", {
      workers: ["awsbridge-console-standard", "awsbridge-console-admin"],
    });
    expect(r.truncated).toEqual([]);
    expect(r.records.map((x) => x.tier)).toEqual(["admin"]);
  });
});

describe("recordsFromLogEvents（Cloudflare の API の events）", () => {
  it("位置は api#<番号>。切られたイベントは位置だけ", () => {
    const r = recordsFromLogEvents(
      [
        { $metadata: { id: "e1" }, source: issue() },
        { $metadata: { id: "e2" }, $workers: { truncated: true }, source: issue() },
      ],
      "api",
    );
    expect(r.records.map((x) => x.pos)).toEqual(["api#1"]);
    expect(r.truncated).toEqual(["api#2"]);
    expect(r.lines).toBe(2);
  });
});

describe("parseAssumeEvent（CloudTrail の AssumeRoleWithWebIdentity）", () => {
  // 形は https://docs.aws.amazon.com/IAM/latest/UserGuide/cloudtrail-integration.html の例に合わせる（値は例示用）。
  // フィールド名は [推測]（② の最初に実物のイベントで確かめてフィクスチャを取り直す）
  const ev = {
    eventVersion: "1.08",
    userIdentity: {
      type: "WebIdentityUser",
      userName: "alice@example.com",
      identityProvider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-console.example.com/standard`,
    },
    eventTime: "2026-11-12T01:02:05Z",
    eventSource: "sts.amazonaws.com",
    eventName: "AssumeRoleWithWebIdentity",
    awsRegion: "us-east-1",
    requestID: "5e1b7c2a-8d3f-4a6b-9c0d-112233445566",
    eventID: "ev-1",
    recipientAccountId: ACCOUNT,
    requestParameters: {
      roleArn: ROLE_ARN,
      roleSessionName: "console-alice@example.com",
      webIdentityTokenId: JTI,
    },
    responseElements: {
      credentials: { accessKeyId: ACCESS_KEY_ID, expiration: "x" },
      assumedRoleUser: { assumedRoleId: "AROAZZZZ:console-alice@example.com", arn: "x" },
    },
  };

  it("CloudTrailEvent の JSON の文字列から、突き合わせに使う項目だけを取る。STS の ID は発行記録と同じ伏せ字にし、email を持たない", () => {
    const e = parseAssumeEvent(JSON.stringify(ev));
    expect(e).toEqual({
      eventId: "ev-1",
      time: Date.UTC(2026, 10, 12, 1, 2, 5),
      region: "us-east-1",
      accountId: ACCOUNT,
      roleArn: ROLE_ARN,
      provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-console.example.com/standard`,
      tokenId: JTI,
      accessKeyId: "ASIA…QQQQ",
      assumedRoleId: "AROA…",
      requestId: "5e1b7c2a…",
    });
    const text = JSON.stringify(e);
    expect(text).not.toContain("alice");
    expect(text).not.toContain(ACCESS_KEY_ID);
  });

  it("SourceIdentity（requestParameters.sourceIdentity。無ければ responseElements.sourceIdentity）は伏せ字にして持つ。素の値を持たない", () => {
    const e = parseAssumeEvent({
      ...ev,
      requestParameters: { ...ev.requestParameters, sourceIdentity: "alice@example.com" },
    });
    expect(e.sourceIdentity).toBe("a***@***.com");
    expect(JSON.stringify(e)).not.toContain("alice");
    const r = parseAssumeEvent({
      ...ev,
      responseElements: { ...ev.responseElements, sourceIdentity: "bob@example.org" },
    });
    expect(r.sourceIdentity).toBe("b***@***.org");
    expect(parseAssumeEvent(ev)).not.toHaveProperty("sourceIdentity");
  });

  it("失敗したイベント（errorCode。requestParameters・responseElements が null）も読む", () => {
    const e = parseAssumeEvent({
      ...ev,
      errorCode: "AccessDenied",
      requestParameters: null,
      responseElements: null,
    });
    expect(e.errorCode).toBe("AccessDenied");
    expect(e).not.toHaveProperty("tokenId");
    expect(e).not.toHaveProperty("accessKeyId");
  });

  it("読めないイベント（JSON でない・時刻やリージョンが無い・別のイベント名）は例外", () => {
    expect(() => parseAssumeEvent("{not json")).toThrow();
    expect(() => parseAssumeEvent({ ...ev, eventTime: undefined })).toThrow();
    expect(() => parseAssumeEvent({ ...ev, awsRegion: undefined })).toThrow();
    expect(() => parseAssumeEvent({ ...ev, eventName: "AssumeRole" })).toThrow();
  });
});
