// 突き合わせの判定（src/console/reconcile.ts。純粋な関数）: 発行記録 × CloudTrail の AssumeRoleWithWebIdentity。
// 計画: impl-plan-g2-remaining.md の件 3。cto の決裁（2026-11-13 の 2 件）: 全リージョン（★1）・保持の窓 (a)・切られた行 (c)・
// 設定に無いプロバイダーでの引き受けは誤り。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  formatReconcileReport,
  JWT_LIFETIME_SECONDS,
  nextCoveredUntil,
  type ReconcileInput,
  reconcile,
  reconcileExitCode,
} from "../../src/console/reconcile";
import type { AssumeEvent, ReconRecord } from "../../src/console/reconcile-input";

const ACCOUNT = "333333333333";
const OTHER = "444444444444";
const STD_ISSUER = "https://awsbridge-oidc-console.example.com/standard";
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
  identity: "a***@***.com",
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
  sourceIdentity: "a***@***.com",
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
      provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-console.example.com/standard2`,
    });
    expect(codes(reconcile(input({ records: [a], events: [samePathless] })))).toEqual([
      "error:provider_not_in_config",
    ]);
  });

  it("プロバイダーは ARN の形でも、URL のホストとパスの形でも読む", () => {
    const a = rec();
    const bare = evFor(a, { provider: "awsbridge-oidc-console.example.com/standard" });
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

  it("発行記録を件数（別の経路）まで読み切れなかった区間は record_read_incomplete（誤り）。終了コード 1、確認済みの区間を進めない", () => {
    const a = rec();
    const r = reconcile(
      input({
        records: [a],
        events: [evFor(a)],
        source: "api",
        incompleteReads: ["2026-11-14T04:00:00.000Z..2026-11-14T04:01:00.000Z read 3 of 5"],
      }),
    );
    expect(codes(r)).toEqual(["error:record_read_incomplete"]);
    expect(r.findings[0]?.detail).toContain("read 3 of 5");
    expect(reconcileExitCode(r)).toBe(1);
    expect(nextCoveredUntil(r, NOW - DAY)).toBeUndefined();
    // 欠けが無ければ所見は無い（既定は空）
    expect(
      codes(reconcile(input({ records: [a], events: [evFor(a)], incompleteReads: [] }))),
    ).toEqual([]);
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

// ---- 時間の検査（cto の決裁 G2-A 条件 c5 の Q1 で誤りに上げた。前は警告） ----
describe("reconcile: 時間の検査（引き受けの時刻 − 発行の時刻 が 300 秒＋時計ずれを超えたら assume_time_gap の誤り）", () => {
  const SEC = 1000;
  const iatOf = (r: ReconRecord) => Math.floor(r.at / 1000);

  it("既定: JWT の寿命は 300 秒、時計ずれは 60 秒", () => {
    expect(JWT_LIFETIME_SECONDS).toBe(300);
    expect(DEFAULT_CLOCK_SKEW_SECONDS).toBe(60);
  });

  it("発行（jwt.iat）から 360 秒ちょうどまでは所見なし。361 秒で assume_time_gap（誤り）", () => {
    const a = rec({ iat: Math.floor((NOW - 60 * MIN) / 1000) });
    const issued = (a.iat ?? 0) * SEC;
    expect(
      codes(reconcile(input({ records: [a], events: [evFor(a, { time: issued + 360 * SEC })] }))),
    ).toEqual([]);
    const late = reconcile(
      input({ records: [a], events: [evFor(a, { time: issued + 361 * SEC })] }),
    );
    expect(codes(late)).toEqual(["error:assume_time_gap"]);
    expect(late.findings[0]?.detail).toContain("+361s");
    expect(late.findings[0]?.jti).toBe(`${a.jti?.slice(0, 8)}…`);
  });

  it("発行の時刻は iat を使う。iat が無い記録は記録の時刻（at）を使う", () => {
    const withIat = rec({ at: NOW - 30 * MIN, iat: Math.floor((NOW - 60 * MIN) / 1000) });
    // at から見れば 2 秒後だが、iat から見れば 30 分後
    expect(
      codes(
        reconcile(
          input({ records: [withIat], events: [evFor(withIat, { time: withIat.at + 2 * SEC })] }),
        ),
      ),
    ).toEqual(["error:assume_time_gap"]);
    const noIat = rec({ at: NOW - 60 * MIN });
    expect(
      codes(
        reconcile(
          input({ records: [noIat], events: [evFor(noIat, { time: noIat.at + 400 * SEC })] }),
        ),
      ),
    ).toEqual(["error:assume_time_gap"]);
    expect(
      codes(
        reconcile(
          input({ records: [noIat], events: [evFor(noIat, { time: noIat.at + 300 * SEC })] }),
        ),
      ),
    ).toEqual([]);
  });

  it("引き受けが発行より前（負の差）で、時計ずれより大きければ同じ所見（向きは detail に出る）。ずれの範囲内なら所見なし", () => {
    const a = rec({ iat: Math.floor((NOW - 60 * MIN) / 1000) });
    const issued = (a.iat ?? 0) * SEC;
    expect(
      codes(reconcile(input({ records: [a], events: [evFor(a, { time: issued - 60 * SEC })] }))),
    ).toEqual([]);
    const early = reconcile(
      input({ records: [a], events: [evFor(a, { time: issued - 61 * SEC })] }),
    );
    expect(codes(early)).toEqual(["error:assume_time_gap"]);
    expect(early.findings[0]?.detail).toContain("-61s");
  });

  it("時計ずれは clockSkewSeconds で変えられる", () => {
    const a = rec({ iat: iatOf(rec({ at: NOW - 60 * MIN })) });
    const issued = (a.iat ?? 0) * SEC;
    const e = evFor(a, { time: issued + 400 * SEC });
    expect(codes(reconcile(input({ records: [a], events: [e], clockSkewSeconds: 120 })))).toEqual(
      [],
    );
    expect(codes(reconcile(input({ records: [a], events: [e], clockSkewSeconds: 30 })))).toEqual([
      "error:assume_time_gap",
    ]);
    expect(
      reconcile(input({ records: [a], events: [e], clockSkewSeconds: 30 })).summary
        .clockSkewSeconds,
    ).toBe(30);
  });

  it("誤りなので終了コードは 1、確認済みの区間を進めない。対にならない引き受け・失敗した引き受けには検査しない", () => {
    const a = rec({ iat: Math.floor((NOW - 60 * MIN) / 1000) });
    const issued = (a.iat ?? 0) * SEC;
    const r = reconcile(input({ records: [a], events: [evFor(a, { time: issued + 900 * SEC })] }));
    expect(reconcileExitCode(r)).toBe(1);
    expect(nextCoveredUntil(r, undefined)).toBeUndefined();
    const failed = reconcile(
      input({
        records: [a],
        events: [evFor(a, { time: issued + 900 * SEC, errorCode: "AccessDenied" })],
      }),
    );
    expect(codes(failed)).not.toContain("error:assume_time_gap");
  });
});

// ---- email（SourceIdentity）の一致 ----
describe("reconcile: 発行記録の利用者と CloudTrail の SourceIdentity の一致（伏せ字どうしで比べる）", () => {
  it("両方あって同じ伏せ字なら所見なし。比べた件数を数える", () => {
    const a = rec({ identity: "a***@***.com" });
    const r = reconcile(
      input({ records: [a], events: [evFor(a, { sourceIdentity: "a***@***.com" })] }),
    );
    expect(codes(r)).toEqual([]);
    expect(r.summary.identityCompared).toBe(1);
    expect(r.summary.identityNotCompared).toBe(0);
  });

  it("伏せ字が違えば identity_mismatch（誤り）。値は所見に出さない。終了コードは 1", () => {
    const a = rec({ identity: "a***@***.com" });
    const r = reconcile(
      input({ records: [a], events: [evFor(a, { sourceIdentity: "b***@***.org" })] }),
    );
    expect(codes(r)).toEqual(["error:identity_mismatch"]);
    expect(JSON.stringify(r.findings)).not.toMatch(/a\*\*\*|b\*\*\*|@/);
    expect(reconcileExitCode(r)).toBe(1);
  });

  it("どちらかが無ければ比べない。黙って飛ばさず、比べなかった件数を identity_not_compared（注記）と要約に出す", () => {
    const noRecordIdentity = (() => {
      const { identity: _i, ...r } = rec();
      return r;
    })();
    const noEventIdentity = rec();
    const neither = (() => {
      const { identity: _i, ...r } = rec();
      return r;
    })();
    const strip = (e: AssumeEvent): AssumeEvent => {
      const { sourceIdentity: _s, ...rest } = e;
      return rest;
    };
    const r = reconcile(
      input({
        records: [noRecordIdentity, noEventIdentity, neither],
        events: [evFor(noRecordIdentity), strip(evFor(noEventIdentity)), strip(evFor(neither))],
      }),
    );
    expect(codes(r)).toEqual(["note:identity_not_compared"]);
    expect(r.findings[0]?.detail).toContain("3 ");
    expect(r.summary.identityCompared).toBe(0);
    expect(r.summary.identityNotCompared).toBe(3);
    expect(formatReconcileReport(r)).toContain("identity: compared 0, not compared 3");
  });
});

// ---- 確認済みの区間（穴の検査） ----
describe("reconcile: 確認済みの区間（前回の終わりより今回の読み始めが後なら coverage_gap の誤り）", () => {
  const since = NOW - 6 * DAY;

  it("状態が無い初回は穴なし。そのことを要約と出力に出す", () => {
    const r = reconcile(input());
    expect(codes(r)).toEqual([]);
    expect(r.summary.coverage).toEqual({ status: "first_run" });
    expect(formatReconcileReport(r)).toContain("coverage: first run");
  });

  it("前回の終わりが今回の読み始め以後なら穴なし（continuous）", () => {
    for (const prev of [since, since + 1, NOW - 3 * DAY]) {
      const r = reconcile(input({ previousCoveredUntil: prev }));
      expect(codes(r)).toEqual([]);
      expect(r.summary.coverage).toEqual({ status: "continuous", previous: prev });
    }
    expect(
      formatReconcileReport(reconcile(input({ previousCoveredUntil: NOW - 3 * DAY }))),
    ).toContain("coverage: continuous");
  });

  it("前回の終わりより今回の読み始めが後なら coverage_gap（誤り）。終了コード 1", () => {
    const r = reconcile(input({ previousCoveredUntil: since - 1 }));
    expect(codes(r)).toEqual(["error:coverage_gap"]);
    expect(r.summary.coverage).toEqual({ status: "gap", previous: since - 1 });
    expect(r.findings[0]?.detail).toContain(new Date(since - 1).toISOString());
    expect(reconcileExitCode(r)).toBe(1);
    expect(formatReconcileReport(r)).toContain("coverage: GAP");
  });
});

describe("nextCoveredUntil（成功した実行（終了コード 0）だけが区間を進める）", () => {
  const settled = NOW - 300 * 1000; // until − lag（既定 300 秒）

  it("終了コード 0 なら、今回の終わり − 反映の遅れ（lag）まで進める。前回が先なら戻さない", () => {
    const r = reconcile(input());
    expect(nextCoveredUntil(r, undefined)).toBe(settled);
    expect(nextCoveredUntil(r, NOW - 10 * 60_000)).toBe(settled);
    expect(nextCoveredUntil(r, NOW)).toBe(NOW);
  });

  it("警告だけ（終了コード 0）でも進める", () => {
    const r = reconcile(input({ records: [rec()] }));
    expect(r.findings.some((f) => f.severity === "warning")).toBe(true);
    expect(nextCoveredUntil(r, undefined)).toBe(settled);
  });

  it("誤りがある実行・検証できない引き受けのある実行（終了コード 1）は進めない（誤りを埋もれさせない）", () => {
    expect(nextCoveredUntil(reconcile(input({ events: [evFor(rec())] })), 123)).toBeUndefined();
    const old = rec({ at: NOW - 8 * DAY });
    const un = reconcile(
      input({ window: { since: NOW - 10 * DAY, until: NOW }, events: [evFor(old)] }),
    );
    expect(nextCoveredUntil(un, 123)).toBeUndefined();
    expect(
      nextCoveredUntil(reconcile(input({ previousCoveredUntil: NOW - 6 * DAY - 1 })), 123),
    ).toBeUndefined();
  });
});

// ---- cto の決裁 G2-A 条件 c5（2026-11-17）: Q1 の比べなかった件数（Administrator の階層は誤り）・時間差の記録、Q2 の除外の件数、Q4 の Admin の発行 ----
describe("reconcile: Administrator の階層（admin）で SourceIdentity を比べなかった対は identity_not_compared_admin の誤り（Q1）", () => {
  const noIdentity = (over: Partial<ReconRecord> = {}): ReconRecord => {
    const { identity: _i, ...r } = rec(over);
    return r;
  };
  const stripSi = (e: AssumeEvent): AssumeEvent => {
    const { sourceIdentity: _s, ...rest } = e;
    return rest;
  };

  it("admin の対で記録の利用者か SourceIdentity が無ければ、対ごとに誤り。終了コード 1・区間を進めない。注記の件数（全体）も出す", () => {
    const a = noIdentity({ tier: "admin", roleArn: ADMIN_ROLE });
    const b = rec({ tier: "admin", roleArn: ADMIN_ROLE, stsRegion: "ap-northeast-1" });
    const r = reconcile(input({ records: [a, b], events: [evFor(a), stripSi(evFor(b))] }));
    expect(codes(r)).toEqual([
      "error:identity_not_compared_admin",
      "error:identity_not_compared_admin",
      "note:identity_not_compared",
    ]);
    expect(r.summary.identityNotCompared).toBe(2);
    expect(r.summary.identityNotComparedAdmin).toBe(2);
    const f = r.findings.find((x) => x.code === "identity_not_compared_admin");
    expect(f?.jti).toMatch(/^j\d{7}…$/);
    expect(f?.role).toBe("FederatedAdministrator");
    expect(JSON.stringify(r.findings)).not.toMatch(/@/);
    expect(reconcileExitCode(r)).toBe(1);
    expect(nextCoveredUntil(r, undefined)).toBeUndefined();
    expect(formatReconcileReport(r)).toContain("identity: compared 0, not compared 2 (admin 2)");
  });

  it("standard の対で比べなかったものは今までどおり注記だけ（誤りにしない）", () => {
    const a = noIdentity();
    const r = reconcile(input({ records: [a], events: [evFor(a)] }));
    expect(codes(r)).toEqual(["note:identity_not_compared"]);
    expect(r.summary.identityNotComparedAdmin).toBe(0);
    expect(reconcileExitCode(r)).toBe(0);
    expect(formatReconcileReport(r)).toContain("identity: compared 0, not compared 1 (admin 0)");
  });

  it("階層は記録の tier・ロールのパス・プロバイダーのどれかが admin なら admin とみなす（食い違いで比べ漏れを隠さない）", () => {
    // 記録は standard だが、引き受けたロールは Admin のパス
    const a = noIdentity({ roleArn: ADMIN_ROLE });
    const r = reconcile(
      input({ records: [a], events: [evFor(a, { provider: providerArn(ADMIN_ISSUER) })] }),
    );
    expect(codes(r)).toContain("error:identity_not_compared_admin");
    expect(r.summary.identityNotComparedAdmin).toBe(1);
  });
});

describe("reconcile: 対になった引き受けの発行からの時間差（秒）の最小・最大・件数を階層ごとに出す（Q1 の記録用）", () => {
  const SEC = 1000;

  it("一致した対（失敗した引き受け・対にならない引き受けは数えない）の差を階層ごとにまとめる", () => {
    const s1 = rec();
    const s2 = rec();
    const s3 = rec();
    const a1 = rec({ tier: "admin", roleArn: ADMIN_ROLE });
    const a2 = rec({ tier: "admin", roleArn: ADMIN_ROLE });
    const failed = rec();
    const r = reconcile(
      input({
        records: [s1, s2, s3, a1, a2, failed],
        events: [
          evFor(s1, { time: s1.at }),
          evFor(s2, { time: s2.at + 2 * SEC }),
          evFor(s3, { time: s3.at + 5 * SEC }),
          evFor(a1, { time: a1.at + 1 * SEC }),
          evFor(a2, { time: a2.at + 3 * SEC }),
          evFor(failed, { time: failed.at + 900 * SEC, errorCode: "AccessDenied" }),
          evFor(rec(), { time: NOW - 10 * MIN }), // 記録の無い引き受け（assume_without_record）
        ],
      }),
    );
    expect(r.summary.timeFromIssue).toEqual({
      standard: { count: 3, min: 0, max: 5 },
      admin: { count: 2, min: 1, max: 3 },
    });
    expect(formatReconcileReport(r)).toContain(
      "time from issue: standard n=3 min 0s max 5s, admin n=2 min 1s max 3s",
    );
  });

  it("負の差もそのまま（最小に出る）。対が無い階層は n=0", () => {
    const a = rec({ iat: Math.floor((NOW - 60 * MIN) / 1000) });
    const r = reconcile(
      input({ records: [a], events: [evFor(a, { time: (a.iat ?? 0) * SEC - 30 * SEC })] }),
    );
    expect(r.summary.timeFromIssue).toEqual({
      standard: { count: 1, min: -30, max: -30 },
      admin: { count: 0 },
    });
    expect(formatReconcileReport(r)).toContain(
      "time from issue: standard n=1 min -30s max -30s, admin n=0",
    );
  });

  it("時間の検査は誤りとして出力に書く（警告だけとは書かない）", () => {
    const text = formatReconcileReport(reconcile(input()));
    expect(text).toContain("time check: lifetime 300s + clock skew 60s (error)");
    expect(text).not.toContain("warning only");
  });
});

describe("reconcile: コンソール以外として除外した引き受けの件数（Q2。表示だけで所見にしない）", () => {
  it("MCP の引き受けは数から外し、件数を要約と出力に出す。所見は無く、終了コードは 0", () => {
    const a = rec();
    const mcp: AssumeEvent = {
      time: NOW - 10 * MIN,
      region: "us-east-1",
      roleArn: MCP_ROLE,
      provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/awsbridge-oidc-mcp.example.com`,
      tokenId: jti(),
    };
    const r = reconcile(
      input({ records: [a], events: [evFor(a), mcp, { ...mcp, region: "ap-northeast-1" }] }),
    );
    expect(codes(r)).toEqual([]);
    expect(r.summary.consoleAssumes).toBe(1);
    expect(r.summary.excludedAssumes).toBe(2);
    expect(reconcileExitCode(r)).toBe(0);
    expect(formatReconcileReport(r)).toContain("excluded assumes (not console): 2");
  });

  it("除外が無ければ 0 と出す", () => {
    expect(formatReconcileReport(reconcile(input()))).toContain(
      "excluded assumes (not console): 0",
    );
  });
});

describe("reconcile: Administrator の階層の発行の件数と各時刻（UTC）を出力に出す（Q4）", () => {
  it("このアカウント・読んだ期間の admin の記録を時刻の順に、結果とともに出す（standard・期間の外・別のアカウントは出さない）", () => {
    const t1 = NOW - 120 * MIN;
    const t2 = NOW - 30 * MIN;
    const a1 = rec({ tier: "admin", roleArn: ADMIN_ROLE, at: t2 });
    const a2 = rec({ tier: "admin", roleArn: ADMIN_ROLE, at: t1, result: "sts_denied" });
    const outside = rec({ tier: "admin", roleArn: ADMIN_ROLE, at: NOW - 7 * DAY });
    const other = rec({ tier: "admin", roleArn: ADMIN_ROLE, accountId: OTHER, at: t1 });
    const std = rec({ at: t1 });
    const r = reconcile(
      input({ records: [a1, a2, outside, other, std], events: [evFor(a1), evFor(std)] }),
    );
    expect(r.summary.adminIssues).toEqual([
      { at: t1, result: "sts_denied" },
      { at: t2, result: "ok" },
    ]);
    expect(formatReconcileReport(r)).toContain(
      `admin issues: 2 (${new Date(t1).toISOString()} sts_denied, ${new Date(t2).toISOString()} ok)`,
    );
  });

  it("admin の発行が無ければ 0 と出す", () => {
    expect(formatReconcileReport(reconcile(input({ records: [rec()] })))).toContain(
      "admin issues: 0",
    );
  });
});
