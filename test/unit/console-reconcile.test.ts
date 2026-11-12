// 突き合わせの判定（src/console/reconcile.ts。純粋な関数）: 発行記録 × CloudTrail の AssumeRoleWithWebIdentity。
// 計画: impl-plan-g2-remaining.md の件 3。cto の決裁（2026-11-13 の 2 件）: 全リージョン（★1）・保持の窓 (a)・切られた行 (c)・
// 設定に無いプロバイダーでの引き受けは誤り。
import { describe, expect, it } from "vitest";
import {
  formatReconcileReport,
  type ReconcileInput,
  reconcile,
  reconcileExitCode,
} from "../../src/console/reconcile";
import type { AssumeEvent, ReconRecord } from "../../src/console/reconcile-input";

const ACCOUNT = "333333333333";
const OTHER = "444444444444";
const STD_ISSUER = "https://awsbridge-oidc-console.example.com/std";
const ADMIN_ISSUER = "https://awsbridge-oidc-admin-console.example.com/admin";
const STD_ROLE = `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/FederatedViewer`;
const ADMIN_ROLE = `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/admin/FederatedAdministrator`;
const MCP_ROLE = `arn:aws:iam::${ACCOUNT}:role/FederatedAwsBridgeMcpViewer`;
const providerArn = (issuer: string) =>
  `arn:aws:iam::${ACCOUNT}:oidc-provider/${issuer.replace(/^https:\/\//, "")}`;

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

let n = 0;
const jti = () => `j${String(++n).padStart(7, "0")}-0000-4000-8000-000000000000`;

const rec = (over: Partial<ReconRecord> = {}): ReconRecord => ({
  pos: "r.ndjson:1",
  result: "ok",
  at: NOW - 60 * MIN,
  tier: "standard",
  team: "infra",
  accountId: ACCOUNT,
  roleArn: STD_ROLE,
  stsRegion: "us-east-1",
  jti: jti(),
  accessKeyId: "ASIA…QQQQ",
  assumedRoleId: "AROA…",
  requestId: "5e1b7c2a…",
  ...over,
});

/** 記録に対になる引き受け（既定は一致）。 */
const evFor = (r: ReconRecord, over: Partial<AssumeEvent> = {}): AssumeEvent => ({
  eventId: `ev-${r.jti}`,
  time: r.at + 2_000,
  region: r.stsRegion,
  accountId: ACCOUNT,
  roleArn: r.roleArn ?? STD_ROLE,
  provider: providerArn(r.tier === "admin" ? ADMIN_ISSUER : STD_ISSUER),
  ...(r.jti !== undefined ? { tokenId: r.jti } : {}),
  accessKeyId: "ASIA…QQQQ",
  assumedRoleId: "AROA…",
  requestId: "5e1b7c2a…",
  ...over,
});

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  records: [],
  events: [],
  window: { since: NOW - 6 * DAY, until: NOW },
  now: NOW,
  accountId: ACCOUNT,
  issuers: [
    { url: STD_ISSUER, tier: "standard" },
    { url: ADMIN_ISSUER, tier: "admin" },
  ],
  regions: { read: ["us-east-1", "ap-northeast-1"], unread: [] },
  lines: { truncated: [], unreadable: [], total: 0 },
  source: "file",
  ...over,
});

const codes = (r: ReturnType<typeof reconcile>) =>
  r.findings.map((f) => `${f.severity}:${f.code}`).sort();

describe("reconcile: 一致と記録に無い引き受け", () => {
  it("記録と引き受けが jti で 1 対 1 に対になれば、所見は無い", () => {
    const a = rec();
    const b = rec({ tier: "admin", roleArn: ADMIN_ROLE, stsRegion: "ap-northeast-1" });
    const r = reconcile(input({ records: [a, b], events: [evFor(a), evFor(b)] }));
    expect(codes(r)).toEqual([]);
    expect(r.summary.matched).toBe(2);
    expect(r.summary.consoleAssumes).toBe(2);
  });

  it("記録に jti が無い引き受けは assume_without_record（誤り）。jti は先頭 8 文字だけ", () => {
    const a = rec();
    const r = reconcile(input({ events: [evFor(a)] }));
    expect(codes(r)).toEqual(["error:assume_without_record"]);
    expect(r.findings[0]?.jti).toBe(`${a.jti?.slice(0, 8)}…`);
    expect(JSON.stringify(r)).not.toContain(a.jti);
  });

  it("webIdentityTokenId の無い成功した引き受けも assume_without_record", () => {
    const a = rec();
    const { tokenId: _t, ...noToken } = evFor(a);
    expect(codes(reconcile(input({ records: [a], events: [noToken] })))).toContain(
      "error:assume_without_record",
    );
  });

  it("jti の照合は全記録で行う（記録のアカウントが違っても対になる）", () => {
    const a = rec({ accountId: OTHER, roleArn: STD_ROLE });
    expect(codes(reconcile(input({ records: [a], events: [evFor(a)] })))).not.toContain(
      "error:assume_without_record",
    );
  });
});

describe("reconcile: コンソールの引き受けだけに絞る", () => {
  it("MCP の引き受け（パスの外のロール・MCP のプロバイダー）は数えない", () => {
    const mcp: AssumeEvent = {
      time: NOW - 10 * MIN,
      region: "us-east-1",
      roleArn: MCP_ROLE,
      provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-mcp.example.com`,
      tokenId: jti(),
    };
    const r = reconcile(input({ events: [mcp] }));
    expect(codes(r)).toEqual([]);
    expect(r.summary.consoleAssumes).toBe(0);
  });

  it("パスの外の手作りのロールでも、コンソールのプロバイダー（issuer のホスト）で引き受けたものは拾う", () => {
    const e: AssumeEvent = {
      time: NOW - 10 * MIN,
      region: "us-east-1",
      roleArn: `arn:aws:iam::${ACCOUNT}:role/HandMade`,
      provider: providerArn(STD_ISSUER),
      tokenId: jti(),
    };
    const r = reconcile(input({ events: [e] }));
    expect(codes(r)).toEqual(["error:assume_without_record"]);
  });

  it("コンソールのパスのロールを、設定に無いプロバイダーで引き受けたら provider_not_in_config（誤り）。同じホストの別のパスも設定に無い", () => {
    const a = rec();
    const other = evFor(a, {
      provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/evil.example.net`,
    });
    expect(codes(reconcile(input({ records: [a], events: [other] })))).toEqual([
      "error:provider_not_in_config",
    ]);
    const samePathless = evFor(a, {
      provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-console.example.com/std2`,
    });
    expect(codes(reconcile(input({ records: [a], events: [samePathless] })))).toEqual([
      "error:provider_not_in_config",
    ]);
  });

  it("プロバイダーは ARN の形でも、URL のホストとパスの形でも読む", () => {
    const a = rec();
    const bare = evFor(a, { provider: "awsbridge-oidc-console.example.com/std" });
    expect(codes(reconcile(input({ records: [a], events: [bare] })))).toEqual([]);
  });
});

describe("reconcile: jti の重複・階層・補助のキー", () => {
  it("同じ jti で 2 回以上引き受けたら jti_reused（警告）", () => {
    const a = rec();
    const r = reconcile(
      input({
        records: [a],
        events: [evFor(a), evFor(a, { eventId: "again", time: a.at + 9_000 })],
      }),
    );
    expect(codes(r)).toEqual(["warning:jti_reused"]);
  });

  it("記録の tier とロールのパスの階層が違えば tier_mismatch（誤り）", () => {
    const a = rec({ tier: "admin", roleArn: STD_ROLE });
    const e = evFor(a, { provider: providerArn(STD_ISSUER) });
    expect(codes(reconcile(input({ records: [a], events: [e] })))).toEqual(["error:tier_mismatch"]);
  });

  it("プロバイダーの階層とロールのパスの階層が違えば tier_mismatch（誤り。記録が無くても）", () => {
    const a = rec({ tier: "admin", roleArn: ADMIN_ROLE });
    const e = evFor(a, { provider: providerArn(STD_ISSUER) });
    expect(codes(reconcile(input({ records: [a], events: [e] })))).toEqual(["error:tier_mismatch"]);
  });

  it("記録のロール ARN と引き受けたロールが違えば role_mismatch（誤り）", () => {
    const a = rec();
    const e = evFor(a, {
      roleArn: `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/FederatedOther`,
    });
    expect(codes(reconcile(input({ records: [a], events: [e] })))).toEqual(["error:role_mismatch"]);
  });

  it("補助のキー（AccessKeyId・RequestId・AssumedRoleId の伏せ字）が食い違えば aux_mismatch（警告）。欠けていれば比べない", () => {
    const a = rec();
    const e = evFor(a, { accessKeyId: "ASIA…ZZZZ" });
    expect(codes(reconcile(input({ records: [a], events: [e] })))).toEqual([
      "warning:aux_mismatch",
    ]);
    const { requestId: _r, ...noReq } = evFor(a);
    expect(codes(reconcile(input({ records: [a], events: [noReq] })))).toEqual([]);
  });
});

describe("reconcile: 引き受けの無い記録", () => {
  it("ok の記録（このアカウント）に引き受けが無ければ record_without_assume（警告）", () => {
    const r = reconcile(input({ records: [rec()] }));
    expect(codes(r)).toEqual(["warning:record_without_assume"]);
  });

  it("反映の遅れ（lagSeconds。既定 300 秒）より新しい記録は pending（note）", () => {
    const r = reconcile(input({ records: [rec({ at: NOW - 2 * MIN })] }));
    expect(codes(r)).toEqual(["note:pending"]);
    expect(r.summary.pending).toBe(1);
    expect(
      codes(reconcile(input({ records: [rec({ at: NOW - 2 * MIN })], lagSeconds: 60 }))),
    ).toEqual(["warning:record_without_assume"]);
  });

  it("STS が失敗した記録（AccessKeyId が無い）に引き受けが無ければ record_sts_failed_no_event（note）", () => {
    const {
      accessKeyId: _a,
      assumedRoleId: _b,
      requestId: _c,
      ...failed
    } = rec({
      result: "sts_denied",
    });
    expect(codes(reconcile(input({ records: [failed] })))).toEqual([
      "note:record_sts_failed_no_event",
    ]);
  });

  it("STS が通ったあとの失敗（signin_failed。AccessKeyId がある）は引き受けがあるはず", () => {
    expect(codes(reconcile(input({ records: [rec({ result: "signin_failed" })] })))).toEqual([
      "warning:record_without_assume",
    ]);
  });

  it("失敗した引き受け（errorCode）も記録の jti と対になる", () => {
    const { accessKeyId: _a, ...failed } = rec({ result: "sts_denied" });
    const e = evFor(failed as ReconRecord, { errorCode: "AccessDenied" });
    const r = reconcile(input({ records: [failed as ReconRecord], events: [e] }));
    expect(codes(r)).toEqual(["note:assume_failed"]);
  });

  it("ほかのアカウントの記録・読んだ期間の外の記録・jti の無い記録は数えない", () => {
    const r = reconcile(
      input({
        records: [
          rec({ accountId: OTHER }),
          rec({ at: NOW - 7 * DAY }),
          (() => {
            const { jti: _j, ...x } = rec({ result: "rate_limited" });
            return x as ReconRecord;
          })(),
        ],
      }),
    );
    expect(codes(r)).toEqual([]);
  });

  it("古い形の記録（伏せ字のアカウント ID）は末尾 4 桁で対象のアカウントを決める", () => {
    expect(codes(reconcile(input({ records: [rec({ accountId: "********3333" })] })))).toEqual([
      "warning:record_without_assume",
    ]);
    expect(codes(reconcile(input({ records: [rec({ accountId: "********4444" })] })))).toEqual([]);
  });

  it("読めなかったリージョンの記録は record_without_assume にしない（region_unread の誤りが出る）", () => {
    const r = reconcile(
      input({
        records: [rec({ stsRegion: "eu-west-1" })],
        regions: { read: ["us-east-1"], unread: ["eu-west-1"] },
      }),
    );
    expect(codes(r)).toEqual(["error:region_unread"]);
  });
});

describe("reconcile: 保持の窓（決裁 (a)）・切られた行（決裁 (c)）・リージョン（★1）", () => {
  it("記録の保持（既定 7 日）より古く、記録の無い引き受けは unverifiable（誤りにも一致にもしない）", () => {
    const old = rec({ at: NOW - 8 * DAY });
    const r = reconcile(
      input({
        window: { since: NOW - 10 * DAY, until: NOW },
        events: [evFor(old)],
      }),
    );
    expect(r.summary.unverifiable).toBe(1);
    expect(codes(r)).toEqual(["warning:unverifiable", "warning:window_exceeds_retention"]);
  });

  it("保持より古い引き受けでも、ファイルに記録があれば対になる", () => {
    const old = rec({ at: NOW - 8 * DAY });
    const r = reconcile(
      input({
        window: { since: NOW - 10 * DAY, until: NOW },
        records: [old],
        events: [evFor(old)],
        retentionDays: 7,
      }),
    );
    expect(r.summary.unverifiable).toBe(0);
    expect(codes(r)).toEqual(["warning:window_exceeds_retention"]);
  });

  it("さかのぼりが保持より長ければ window_exceeds_retention（警告）。保持を変えれば消える", () => {
    const i = input({ window: { since: NOW - 10 * DAY, until: NOW } });
    expect(codes(reconcile(i))).toEqual(["warning:window_exceeds_retention"]);
    expect(codes(reconcile({ ...i, retentionDays: 90 }))).toEqual([]);
  });

  it("切られた行・読めない行は位置ごとに誤り", () => {
    const r = reconcile(
      input({ lines: { truncated: ["a:3"], unreadable: ["a:5", "a:6"], total: 9 } }),
    );
    expect(codes(r)).toEqual([
      "error:record_line_truncated",
      "error:record_line_unreadable",
      "error:record_line_unreadable",
    ]);
    expect(r.summary.truncatedLines).toBe(1);
    expect(r.summary.unreadableLines).toBe(2);
  });

  it("読めなかったリージョンは region_unread（誤り）", () => {
    const r = reconcile(input({ regions: { read: ["us-east-1"], unread: ["eu-west-1"] } }));
    expect(codes(r)).toEqual(["error:region_unread"]);
    expect(r.findings[0]?.detail).toContain("eu-west-1");
  });
});

describe("formatReconcileReport（伏せ字の出力と要約）", () => {
  it("② の合格条件に使う数（期間・リージョン数・検証できない件数・切られた行・API から読んだか）を出す", () => {
    const a = rec();
    const r = reconcile(input({ records: [a], events: [evFor(a)], source: "api" }));
    const text = formatReconcileReport(r, { label: "profile p1" });
    expect(text).toContain("source: api");
    expect(text).toContain("window: 2026-11-07T12:00:00.000Z .. 2026-11-13T12:00:00.000Z");
    expect(text).toContain("regions: read 2/2");
    expect(text).toContain("unverifiable: 0");
    expect(text).toContain("truncated lines: 0");
    expect(text).toContain("retention: 7d");
    expect(text).toMatch(/errors: 0, warnings: 0$/);
  });

  it("全桁の jti・12 桁のアカウント ID・email を出さない", () => {
    const a = rec();
    const r = reconcile(
      input({
        events: [evFor(a, { roleArn: `arn:aws:iam::${ACCOUNT}:role/x@example.com` })],
      }),
    );
    const text = formatReconcileReport(r, { label: "profile p1" });
    expect(text).toContain("assume_without_record");
    expect(text).not.toContain(a.jti);
    expect(text).toContain(a.jti?.slice(0, 8));
    expect(text).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
    expect(text).not.toMatch(/@/);
  });
});

describe("reconcileExitCode（終了コード。司令塔の判断 2026-11-13: 検証できない引き受けは 0 で終わらせない）", () => {
  it("誤りも検証できない引き受けも無ければ 0", () => {
    const a = rec();
    expect(reconcileExitCode(reconcile(input({ records: [a], events: [evFor(a)] })))).toBe(0);
  });

  it("誤りがあれば 1", () => {
    expect(reconcileExitCode(reconcile(input({ events: [evFor(rec())] })))).toBe(1);
  });

  it("誤りが 0 でも、検証できない引き受けが 1 件以上あれば 1（所見の区分は unverifiable の警告のまま）", () => {
    const old = rec({ at: NOW - 8 * DAY });
    const r = reconcile(
      input({ window: { since: NOW - 10 * DAY, until: NOW }, events: [evFor(old)] }),
    );
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.findings.find((f) => f.code === "unverifiable")?.severity).toBe("warning");
    expect(r.summary.unverifiable).toBe(1);
    expect(reconcileExitCode(r)).toBe(1);
  });

  it("警告だけ（検証できない引き受けは無い）なら 0", () => {
    expect(reconcileExitCode(reconcile(input({ records: [rec()] })))).toBe(0);
  });
});
