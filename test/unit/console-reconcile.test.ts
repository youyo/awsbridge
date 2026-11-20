// 突き合わせの判定（src/console/reconcile.ts。純粋な関数）: 発行記録 × CloudTrail の AssumeRoleWithWebIdentity。
// 計画: impl-plan-g2-remaining.md の件 3。cto の決裁（2026-11-13 の 2 件）: 全リージョン（★1）・保持の窓 (a)・切られた行 (c)・
// 設定に無いプロバイダーでの引き受けは誤り。
import { describe, expect, it } from "vitest";
import {
  acceptedAccountState,
  applyAcceptance,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_OVERLAP_SECONDS,
  decideReadStart,
  formatReconcileReport,
  formatStateLines,
  JWT_LIFETIME_SECONDS,
  MIN_OVERLAP_SECONDS,
  nextAccountState,
  nextCoveredUntil,
  oldestErrorAt,
  type ReconcileInput,
  reconcile,
  reconcileExitCode,
  TIMED_ERROR_CODES,
  UNTIMED_ERROR_CODES,
} from "../../src/console/reconcile";
import type { AssumeEvent, ReconRecord } from "../../src/console/reconcile-input";
import {
  type AccountState,
  type Anchors,
  accountStateOf,
  MAX_CODE_COUNT,
  parseReconcileState,
  serializeReconcileState,
  withAccountState,
} from "../../src/console/reconcile-state";

const ACCOUNT = "333333333333";
const OTHER = "444444444444";
/** 境界の issuer（P2: Standard と Admin の階層で同じ issuer・同じプロバイダー）。 */
const ISSUER = "https://awsbridge-oidc-console.example.com/console";
/** 設定のチームの階層（記録のチームの階層を調べる）。 */
const TEAMS = [
  { name: "infra", tier: "standard" as const },
  { name: "infra-elevated", tier: "admin" as const },
];
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
  // 記録のチームは記録の階層のチーム（Admin の記録は Admin のチーム）
  team: over.tier === "admin" ? "infra-elevated" : "infra",
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
  provider: providerArn(ISSUER),
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
  issuers: [{ url: ISSUER }],
  teams: TEAMS,
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
      provider: providerArn(ISSUER),
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
    const bare = evFor(a, { provider: "awsbridge-oidc-console.example.com/console" });
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
    const a = rec({ tier: "admin", team: "infra-elevated", roleArn: STD_ROLE });
    const e = evFor(a);
    expect(codes(reconcile(input({ records: [a], events: [e] })))).toContain("error:tier_mismatch");
  });

  // P2（B）の設計メモ §9.1: プロバイダーは階層を持たない（プロバイダーの階層とロールのパスの比較は無い）。代わりに、
  // 記録のチームが設定でどの階層かを調べ、記録の tier・ロールのパスの階層と違えば誤り。設定に無いチームの記録も誤り
  it("記録のチームの階層が記録の tier と違えば team_tier_mismatch（誤り）", () => {
    const a = rec({ tier: "admin", team: "infra", roleArn: ADMIN_ROLE });
    expect(codes(reconcile(input({ records: [a], events: [evFor(a)] })))).toEqual([
      "error:team_tier_mismatch",
    ]);
  });

  it("記録のチームの階層がロールのパスの階層と違えば team_tier_mismatch（記録の tier と合っていても）", () => {
    const a = rec({ tier: "standard", team: "infra", roleArn: ADMIN_ROLE });
    const found = codes(reconcile(input({ records: [a], events: [evFor(a)] })));
    expect(found).toContain("error:team_tier_mismatch");
    expect(found).toContain("error:tier_mismatch");
  });

  it("設定に無いチームの記録は team_not_in_config（誤り。引き受けが無くても）", () => {
    const a = rec({ team: "ghost" });
    expect(codes(reconcile(input({ records: [a], events: [evFor(a)] })))).toEqual([
      "error:team_not_in_config",
    ]);
    const { accessKeyId: _drop, ...noKey } = rec({ team: "ghost", result: "sts_denied" });
    const b: ReconRecord = noKey;
    expect(codes(reconcile(input({ records: [b] })))).toContain("error:team_not_in_config");
  });

  it("陽性の対照: 同じプロバイダーで Standard と Admin の階層の引き受けが対になれば、所見は無い", () => {
    const a = rec();
    const b = rec({ tier: "admin", roleArn: ADMIN_ROLE });
    expect(evFor(a).provider).toBe(evFor(b).provider);
    expect(codes(reconcile(input({ records: [a, b], events: [evFor(a), evFor(b)] })))).toEqual([]);
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

// ---- 読み始めの決め方（状態があれば「確認済みの区間の終わり − 重なり」から。既定のさかのぼり 6 日より前には戻らない） ----
// 古い区間を含む長い窓の照会が間引かれて（sampleInterval > 1）record_read_incomplete になるのを避ける緩和策。
// 読み始め = max(今 − 6 日, 確認済みの終わり − 重なり)。--since が勝つ。初回と coverage_gap の判定は変えない。
describe("decideReadStart（読み始め = max(今 − 6 日, 確認済みの終わり − 重なり)。--since が勝つ）", () => {
  const H = 3_600_000;

  it("重なりの既定は 24 時間、下限は 1 時間。既定のさかのぼりは 6 日", () => {
    expect(DEFAULT_OVERLAP_SECONDS).toBe(86_400);
    expect(MIN_OVERLAP_SECONDS).toBe(3_600);
    expect(DEFAULT_LOOKBACK_DAYS).toBe(6);
  });

  it("状態が無い初回は、今までどおり既定のさかのぼり 6 日", () => {
    expect(decideReadStart({ now: NOW })).toEqual({
      basis: "lookback",
      since: NOW - 6 * DAY,
      lookbackDays: 6,
    });
  });

  it("状態があれば、確認済みの区間の終わり − 重なり（既定 24 時間）から読む", () => {
    const coveredUntil = NOW - 2 * H;
    expect(decideReadStart({ now: NOW, coveredUntil })).toEqual({
      basis: "state",
      since: coveredUntil - 24 * H,
      coveredUntil,
      overlapSeconds: 86_400,
    });
  });

  it("重なりは overlapSeconds で変えられる（lag とは別の値）", () => {
    const coveredUntil = NOW - 2 * H;
    expect(decideReadStart({ now: NOW, coveredUntil, overlapSeconds: 3_600 })).toEqual({
      basis: "state",
      since: coveredUntil - H,
      coveredUntil,
      overlapSeconds: 3_600,
    });
  });

  it("重なりが下限（1 時間）より短ければ例外（黙って広げない）", () => {
    expect(() =>
      decideReadStart({ now: NOW, coveredUntil: NOW - 2 * H, overlapSeconds: 3_599 }),
    ).toThrow(RangeError);
    expect(() => decideReadStart({ now: NOW, overlapSeconds: 0 })).toThrow(RangeError);
  });

  it("確認済みの終わり − 重なりが 6 日より前なら、既定のさかのぼり 6 日（それより前には戻らない）。根拠に状態の時刻も残す", () => {
    const coveredUntil = NOW - 5 * DAY - 12 * H;
    expect(decideReadStart({ now: NOW, coveredUntil })).toEqual({
      basis: "lookback",
      since: NOW - 6 * DAY,
      lookbackDays: 6,
      coveredUntil,
    });
  });

  it("境界: 確認済みの終わり − 重なり がちょうど 今 − 6 日なら既定のさかのぼり、1 ミリ秒後なら状態、1 ミリ秒前なら既定のさかのぼり", () => {
    const lookback = NOW - 6 * DAY;
    const at = (coveredUntil: number) => decideReadStart({ now: NOW, coveredUntil });
    expect(at(lookback + 24 * H)).toMatchObject({ basis: "lookback", since: lookback });
    expect(at(lookback + 24 * H + 1)).toMatchObject({ basis: "state", since: lookback + 1 });
    expect(at(lookback + 24 * H - 1)).toMatchObject({ basis: "lookback", since: lookback });
    // どれも前回の終わり以前なので、穴にならない
    for (const c of [lookback + 24 * H - 1, lookback + 24 * H, lookback + 24 * H + 1])
      expect(
        reconcile(input({ window: { since: at(c).since, until: NOW }, previousCoveredUntil: c }))
          .summary.coverage.status,
      ).toBe("continuous");
  });

  it("--since（since）を渡せば、状態があってもそれが勝つ（全部を読み直す監査用の指定を残す）", () => {
    const since = NOW - 6 * DAY;
    expect(decideReadStart({ now: NOW, since, coveredUntil: NOW - 2 * H })).toEqual({
      basis: "option",
      since,
    });
    // 状態より後でも --since のまま（穴の判定は reconcile の側で今までどおり）
    expect(decideReadStart({ now: NOW, since: NOW - H, coveredUntil: NOW - 2 * H })).toEqual({
      basis: "option",
      since: NOW - H,
    });
  });

  it("許容の範囲内で未来の状態（時計のずれ）でも、終わり − 重なりから読む", () => {
    const coveredUntil = NOW + 60_000;
    expect(decideReadStart({ now: NOW, coveredUntil }).since).toBe(coveredUntil - 24 * H);
  });

  it("coverage_gap の判定は変わらない: 状態から決めた読み始めは穴にならず、6 日より古い状態は今までどおり穴", () => {
    for (const coveredUntil of [NOW - 2 * H, NOW - 5 * DAY - 12 * H, NOW - 6 * DAY]) {
      const { since } = decideReadStart({ now: NOW, coveredUntil });
      const r = reconcile(
        input({ window: { since, until: NOW }, previousCoveredUntil: coveredUntil }),
      );
      expect(r.summary.coverage).toEqual({ status: "continuous", previous: coveredUntil });
      expect(reconcileExitCode(r)).toBe(0);
    }
    const old = NOW - 7 * DAY;
    const { since } = decideReadStart({ now: NOW, coveredUntil: old });
    const gap = reconcile(input({ window: { since, until: NOW }, previousCoveredUntil: old }));
    expect(codes(gap)).toEqual(["error:coverage_gap"]);
    // --since で前回の終わりより後から読んでも、今までどおり穴
    const later = decideReadStart({ now: NOW, since: NOW - H, coveredUntil: NOW - 2 * H });
    expect(
      codes(
        reconcile(
          input({ window: { since: later.since, until: NOW }, previousCoveredUntil: NOW - 2 * H }),
        ),
      ),
    ).toEqual(["error:coverage_gap"]);
  });

  it("重なりの中の遅れた引き受け（前回の終わりより前・記録なし）は assume_without_record（誤り）。区間を進めない", () => {
    const coveredUntil = NOW - 2 * H;
    const { since } = decideReadStart({ now: NOW, coveredUntil });
    const late = evFor(rec({ at: NOW - 4 * H }));
    expect(late.time).toBeGreaterThan(since);
    expect(late.time).toBeLessThan(coveredUntil);
    const r = reconcile(
      input({ window: { since, until: NOW }, events: [late], previousCoveredUntil: coveredUntil }),
    );
    expect(codes(r)).toEqual(["error:assume_without_record"]);
    expect(nextCoveredUntil(r, coveredUntil)).toBeUndefined();
  });

  it("出力に、読み始めの決め方と実際の時刻（UTC）を出す", () => {
    const r = reconcile(input());
    const iso = (t: number) => new Date(t).toISOString();
    const coveredUntil = NOW - 2 * H;
    const fromState = decideReadStart({ now: NOW, coveredUntil });
    expect(formatReconcileReport(r, { start: fromState })).toContain(
      `read start: ${iso(coveredUntil - 24 * H)} (from the state: confirmed until ${iso(coveredUntil)} minus overlap 86400s)`,
    );
    expect(formatReconcileReport(r, { start: decideReadStart({ now: NOW }) })).toContain(
      `read start: ${iso(NOW - 6 * DAY)} (default lookback 6d; no confirmed interval on record)`,
    );
    const old = NOW - 5 * DAY - 12 * H;
    expect(
      formatReconcileReport(r, { start: decideReadStart({ now: NOW, coveredUntil: old }) }),
    ).toContain(
      `read start: ${iso(NOW - 6 * DAY)} (default lookback 6d; the confirmed interval ends ${iso(old)}, the overlap would go back further)`,
    );
    expect(
      formatReconcileReport(r, {
        start: decideReadStart({ now: NOW, since: NOW - 3 * DAY, coveredUntil }),
      }),
    ).toContain(`read start: ${iso(NOW - 3 * DAY)} (--since)`);
    // 渡さなければ行を出さない（今までの出力のまま）
    expect(formatReconcileReport(r)).not.toContain("read start:");
  });
});

describe("終了コード 1 のとき、時刻を持つ誤りの最も古い時刻と、既定の窓から外れる時刻を出す（検出した誤りは状態に残らないため）", () => {
  const iso = (t: number) => new Date(t).toISOString();
  it("時刻を持つ誤り（記録に無い引き受け・時間の検査など）のうち最も古い時刻と、その 6 日後を出す", () => {
    const older = evFor(rec({ at: NOW - 3 * DAY }));
    const newer = evFor(rec({ at: NOW - DAY }));
    const r = reconcile(input({ events: [newer, older] }));
    expect(reconcileExitCode(r)).toBe(1);
    expect(oldestErrorAt(r)).toBe(older.time);
    expect(formatReconcileReport(r)).toContain(
      `oldest error finding: ${iso(older.time)} (it leaves the default window of 6d after ${iso(older.time + 6 * DAY)}; the state keeps it until a run reads it with no errors or a person accepts it)`,
    );
  });
  it("記録の側の誤り（設定に無いチーム）の時刻も数える", () => {
    const r0 = rec({ at: NOW - 2 * DAY, team: "nope" });
    const r = reconcile(input({ records: [r0], events: [evFor(r0)] }));
    expect(oldestErrorAt(r)).toBe(r0.at);
  });
  it("誤りが無い・時刻を持つ誤りが無い（読めなかったリージョンだけ・検証できない引き受けだけ）なら出さない", () => {
    const ok = reconcile(input());
    expect(oldestErrorAt(ok)).toBeUndefined();
    expect(formatReconcileReport(ok)).not.toContain("oldest error finding:");
    const unread = reconcile(
      input({ regions: { read: ["us-east-1"], unread: ["ap-northeast-1"] } }),
    );
    expect(reconcileExitCode(unread)).toBe(1);
    expect(oldestErrorAt(unread)).toBeUndefined();
    expect(formatReconcileReport(unread)).not.toContain("oldest error finding:");
    const old = evFor(rec({ at: NOW - 8 * DAY }), { tokenId: "zzzzzzzz-none" });
    const unverifiable = reconcile(input({ events: [old] }));
    expect(reconcileExitCode(unverifiable)).toBe(1);
    expect(oldestErrorAt(unverifiable)).toBeUndefined();
  });
  it("警告（時刻を持つ record_without_assume など）は数えない", () => {
    const r = reconcile(input({ records: [rec({ at: NOW - 2 * DAY })] }));
    expect(codes(r)).toEqual(["warning:record_without_assume"]);
    expect(oldestErrorAt(r)).toBeUndefined();
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

  it("階層は記録の tier・記録のチームの階層・ロールのパスのどれかが admin なら admin とみなす（食い違いで比べ漏れを隠さない）", () => {
    // 記録は standard だが、引き受けたロールは Admin のパス
    const a = noIdentity({ roleArn: ADMIN_ROLE });
    const r = reconcile(input({ records: [a], events: [evFor(a)] }));
    expect(codes(r)).toContain("error:identity_not_compared_admin");
    expect(r.summary.identityNotComparedAdmin).toBe(1);
    // 記録の tier もロールのパスも standard だが、記録のチームが Admin の階層
    const b = noIdentity({ team: "infra-elevated" });
    const rb = reconcile(input({ records: [b], events: [evFor(b)] }));
    expect(codes(rb)).toContain("error:identity_not_compared_admin");
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

// ---- 所見の保持（cto の決裁 2026-11-19 h1〜h5・q3・q1・q2・i3）----
const iso = (t: number) => new Date(t).toISOString();
const HOUR = 3_600_000;
const noIdentity = (e: AssumeEvent): AssumeEvent => {
  const { sourceIdentity: _drop, ...rest } = e;
  return rest;
};
const anchorsOf = (
  oldestAt: number,
  newestAt: number,
  codes: Record<string, number> = { assume_without_record: 1 },
): Anchors => ({
  oldestAt,
  newestAt,
  firstSeenAt: NOW - HOUR,
  codes,
  criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
});

describe("時刻を持つ誤り（錨にする）と持たない誤り（件数だけ）の一覧（q3）", () => {
  it("一覧は確定した code で、重ならない", () => {
    expect([...TIMED_ERROR_CODES].sort()).toEqual(
      [
        "assume_time_gap",
        "assume_without_record",
        "identity_mismatch",
        "identity_not_compared_admin",
        "provider_not_in_config",
        "role_mismatch",
        "team_not_in_config",
        "team_tier_mismatch",
        "tier_mismatch",
      ].sort(),
    );
    expect([...UNTIMED_ERROR_CODES].sort()).toEqual(
      [
        "coverage_gap",
        "record_line_truncated",
        "record_line_unreadable",
        "record_read_incomplete",
        "region_unread",
        "unconfirmed_not_covered",
        "untimed_not_covered",
        "unresolved_criteria_looser",
        "unresolved_not_covered",
        "unresolved_out_of_window",
      ].sort(),
    );
    expect(TIMED_ERROR_CODES.filter((c) => UNTIMED_ERROR_CODES.includes(c))).toEqual([]);
  });

  it("reconcile が出すすべての誤りで、時刻（at）を持つのは一覧の時刻を持つ code だけ。一覧の外の誤りは無い", () => {
    const a = rec();
    const tier = rec({ tier: "admin" });
    const role = rec({ roleArn: `arn:aws:iam::${ACCOUNT}:role/awsbridge-console/std/Other` });
    const gap = rec();
    const ident = rec();
    const admin = rec({ tier: "admin", roleArn: ADMIN_ROLE });
    const team = rec({ team: "nope" });
    const prov = rec();
    const results = [
      reconcile(input({ events: [evFor(a)] })),
      reconcile(
        input({
          records: [prov],
          events: [evFor(prov, { provider: providerArn("https://other.example.com/x") })],
        }),
      ),
      reconcile(input({ records: [tier], events: [evFor(tier)] })),
      reconcile(input({ records: [role], events: [evFor(role, { roleArn: STD_ROLE })] })),
      reconcile(input({ records: [gap], events: [evFor(gap, { time: gap.at + 1000 * 1000 })] })),
      reconcile(
        input({ records: [ident], events: [evFor(ident, { sourceIdentity: "b***@***.org" })] }),
      ),
      reconcile(input({ records: [admin], events: [noIdentity(evFor(admin))] })),
      reconcile(input({ records: [team], events: [evFor(team)] })),
      reconcile(
        input({
          regions: { read: ["us-east-1"], unread: ["eu-west-1"] },
          lines: { truncated: ["a:1"], unreadable: ["a:2"], total: 3 },
          incompleteReads: ["w"],
          previousCoveredUntil: NOW - 7 * DAY,
        }),
      ),
      reconcile(input({ anchors: anchorsOf(NOW - 7 * DAY, NOW - 7 * DAY) })),
      reconcile(
        input({
          window: { since: NOW - DAY, until: NOW },
          anchors: anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY),
        }),
      ),
      reconcile(
        input({
          window: { since: NOW - DAY, until: NOW },
          coverageBasis: "unconfirmed",
          watchStart: NOW - 6 * DAY,
        }),
      ),
      reconcile(input({ anchors: anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY), clockSkewSeconds: 120 })),
      reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 7 * DAY })),
    ];
    const seen = new Set<string>();
    for (const r of results)
      for (const f of r.findings.filter((x) => x.severity === "error")) {
        seen.add(f.code);
        expect(f.at !== undefined, f.code).toBe(TIMED_ERROR_CODES.includes(f.code));
        expect([...TIMED_ERROR_CODES, ...UNTIMED_ERROR_CODES], f.code).toContain(f.code);
      }
    expect([...seen].sort()).toEqual([...TIMED_ERROR_CODES, ...UNTIMED_ERROR_CODES].sort());
  });
});

describe("未解決の錨の読み直し（q3: 読み始め > 最も古い錨 なら誤り）", () => {
  it("窓が錨を含めば unresolved_* は出ない", () => {
    const r = reconcile(input({ anchors: anchorsOf(NOW - 3 * DAY, NOW - DAY) }));
    expect(codes(r)).toEqual([]);
  });
  it("読み始めが最も古い錨より後で、錨が今 − 6 日より新しければ unresolved_not_covered（誤り）", () => {
    const r = reconcile(
      input({
        window: { since: NOW - DAY, until: NOW },
        anchors: anchorsOf(NOW - DAY - 1, NOW - HOUR),
      }),
    );
    expect(codes(r)).toEqual(["error:unresolved_not_covered"]);
    expect(r.findings[0]?.detail).toContain(iso(NOW - DAY - 1));
    expect(reconcileExitCode(r)).toBe(1);
    // ちょうど錨なら含む
    expect(
      codes(
        reconcile(
          input({
            window: { since: NOW - DAY, until: NOW },
            anchors: anchorsOf(NOW - DAY, NOW - HOUR),
          }),
        ),
      ),
    ).toEqual([]);
  });
  it("錨が今 − 6 日より前なら（6 日の窓では読めないので）毎回 unresolved_out_of_window（誤り）", () => {
    for (const now of [NOW, NOW + DAY, NOW + 30 * DAY]) {
      const r = reconcile(
        input({
          now,
          window: { since: now - 6 * DAY, until: now },
          anchors: anchorsOf(NOW - 6 * DAY - 1, NOW - 6 * DAY - 1),
        }),
      );
      expect(codes(r)).toEqual(["error:unresolved_out_of_window"]);
      expect(reconcileExitCode(r)).toBe(1);
    }
  });
  it("--until が最も新しい錨より前でも unresolved_not_covered（その時刻を含む窓を読んでいない）", () => {
    const r = reconcile(
      input({
        window: { since: NOW - 3 * DAY, until: NOW - 2 * DAY },
        anchors: anchorsOf(NOW - 3 * DAY, NOW - DAY),
      }),
    );
    expect(codes(r)).toEqual(["error:unresolved_not_covered"]);
  });
});

describe("decideReadStart: 未解決の錨があれば min(通常, 最も古い錨 − 重なり) を今 − 6 日で切る（h3・q3・i3）", () => {
  it("最も古い錨 − 重なりが通常より前ならそこから。出力に決め方を出す", () => {
    const coveredUntil = NOW - 2 * HOUR;
    const oldestAnchor = NOW - 2 * DAY;
    const s = decideReadStart({ now: NOW, coveredUntil, oldestAnchor });
    expect(s).toEqual({
      basis: "unresolved",
      since: oldestAnchor - DAY,
      oldestAnchor,
      overlapSeconds: 86_400,
      coveredUntil,
    });
    expect(formatReconcileReport(reconcile(input()), { start: s })).toContain(
      `read start: ${iso(oldestAnchor - DAY)} (from the unresolved findings: oldest ${iso(oldestAnchor)} minus overlap 86400s)`,
    );
    // 通常の方が前なら通常（今までの形）
    expect(decideReadStart({ now: NOW, coveredUntil, oldestAnchor: NOW - HOUR })).toEqual(
      decideReadStart({ now: NOW, coveredUntil }),
    );
  });
  it("重なりを縮めても錨の時刻は読む（読み始め ≤ 最も古い錨）", () => {
    const oldestAnchor = NOW - 4 * HOUR;
    const s = decideReadStart({
      now: NOW,
      coveredUntil: NOW - 2 * HOUR,
      oldestAnchor,
      overlapSeconds: 3_600,
    });
    expect(s.since).toBe(oldestAnchor - HOUR);
    expect(
      codes(
        reconcile(
          input({
            window: { since: s.since, until: NOW },
            anchors: anchorsOf(oldestAnchor, oldestAnchor),
          }),
        ),
      ),
    ).toEqual([]);
  });
  it("今 − 6 日で切る。錨がそれより前なら毎回 unresolved_out_of_window", () => {
    const oldestAnchor = NOW - 6 * DAY - HOUR;
    const s = decideReadStart({ now: NOW, coveredUntil: NOW - 7 * DAY, oldestAnchor });
    expect(s).toEqual({
      basis: "lookback",
      since: NOW - 6 * DAY,
      lookbackDays: 6,
      coveredUntil: NOW - 7 * DAY,
      oldestAnchor,
    });
    expect(formatReconcileReport(reconcile(input()), { start: s })).toContain(
      `the oldest unresolved finding is ${iso(oldestAnchor)}`,
    );
    expect(
      codes(
        reconcile(
          input({
            window: { since: s.since, until: NOW },
            anchors: anchorsOf(oldestAnchor, oldestAnchor),
          }),
        ),
      ),
    ).toContain("error:unresolved_out_of_window");
  });
  it("coveredUntil の無い行: 錨があれば 最も古い錨 − 重なり（6 日が下限）。時刻なしの誤りだけの行は 6 日（i3・q3）", () => {
    const oldestAnchor = NOW - 3 * DAY;
    expect(decideReadStart({ now: NOW, oldestAnchor })).toEqual({
      basis: "unresolved",
      since: oldestAnchor - DAY,
      oldestAnchor,
      overlapSeconds: 86_400,
    });
    expect(decideReadStart({ now: NOW, lookbackRequired: true })).toEqual({
      basis: "lookback",
      since: NOW - 6 * DAY,
      lookbackDays: 6,
    });
    // 時刻なしの誤りと錨の両方があれば 6 日（時刻なしの誤りの窓を読み直す）
    expect(
      decideReadStart({ now: NOW, oldestAnchor: NOW - HOUR, lookbackRequired: true }).since,
    ).toBe(NOW - 6 * DAY);
  });
  it("--since が勝つ。錨より後から始めれば unresolved_not_covered", () => {
    const s = decideReadStart({
      now: NOW,
      since: NOW - HOUR,
      coveredUntil: NOW - 2 * HOUR,
      oldestAnchor: NOW - 3 * HOUR,
    });
    expect(s).toEqual({ basis: "option", since: NOW - HOUR });
    expect(
      codes(
        reconcile(
          input({
            window: { since: s.since, until: NOW },
            anchors: anchorsOf(NOW - 3 * HOUR, NOW - 3 * HOUR),
          }),
        ),
      ),
    ).toEqual(["error:unresolved_not_covered"]);
  });
});

describe("受け入れた区間の中の時刻を持つ誤りは以後の実行でも note（accepted）。区間の外と時刻なしは下げない（q1）", () => {
  it("区間の中は note、外の同じ code は誤り、時刻なしの誤りは下げない", () => {
    const inside = evFor(rec({ at: NOW - 2 * DAY }));
    const outside = evFor(rec({ at: NOW - DAY }));
    const accepted = [{ from: NOW - 2 * DAY - HOUR, until: NOW - 2 * DAY + HOUR }];
    const r = reconcile(input({ events: [inside], accepted }));
    expect(codes(r)).toEqual(["note:assume_without_record"]);
    expect(r.findings[0]?.detail).toContain("(accepted)");
    expect(reconcileExitCode(r)).toBe(0);
    const r2 = reconcile(input({ events: [inside, outside], accepted }));
    expect(codes(r2)).toEqual(["error:assume_without_record", "note:assume_without_record"]);
    expect(reconcileExitCode(r2)).toBe(1);
    const r3 = reconcile(
      input({
        events: [inside],
        accepted,
        regions: { read: ["us-east-1"], unread: ["eu-west-1"] },
      }),
    );
    expect(codes(r3)).toEqual(["error:region_unread", "note:assume_without_record"]);
  });
});

describe("applyAcceptance（受け入れは照合の実行と一体。q1・q2）", () => {
  it("前の実行までに記録された錨を受け入れる: 窓の中で読み直した同じ所見は note になり 0。区間は [最も古い錨, 最も新しい錨]", () => {
    const e = evFor(rec({ at: NOW - 2 * DAY }));
    const anchors = anchorsOf(e.time, e.time);
    const r = reconcile(input({ events: [e], anchors, previousCoveredUntil: NOW - 3 * DAY }));
    expect(reconcileExitCode(r)).toBe(1);
    const a = applyAcceptance(r, { anchors, coveredUntil: NOW - 3 * DAY });
    expect(a.status).toBe("applied");
    if (a.status !== "applied") return;
    expect(a.interval).toEqual({
      from: e.time,
      until: e.time,
      codes: { assume_without_record: 1 },
    });
    expect(reconcileExitCode(a.result)).toBe(0);
    expect(codes(a.result)).toEqual(["note:assume_without_record"]);
  });
  it("区間の外に今回初めての誤りがあれば、下げても 1 で受け入れを適用しない（結果は下げる前のまま）", () => {
    const e = evFor(rec({ at: NOW - 2 * DAY }));
    const fresh = evFor(rec({ at: NOW - HOUR }));
    const anchors = anchorsOf(e.time, e.time);
    const r = reconcile(input({ events: [e, fresh], anchors }));
    const a = applyAcceptance(r, { anchors });
    expect(a.status).toBe("rejected");
    if (a.status !== "rejected") return;
    expect(codes(a.result)).toEqual(["error:assume_without_record", "error:assume_without_record"]);
  });
  it("区間の中でも、記録に無い code や記録より多い件数は今回初めての誤りとして下げない", () => {
    const e = evFor(rec({ at: NOW - 2 * DAY }));
    const e2 = evFor(rec({ at: NOW - 2 * DAY + MIN }));
    const anchors = anchorsOf(e.time, e2.time, { identity_mismatch: 1 });
    expect(applyAcceptance(reconcile(input({ events: [e], anchors })), { anchors }).status).toBe(
      "rejected",
    );
    const one = anchorsOf(e.time, e2.time, { assume_without_record: 1 });
    expect(
      applyAcceptance(reconcile(input({ events: [e, e2], anchors: one })), { anchors: one }).status,
    ).toBe("rejected");
  });
  it("今回の coverage_gap を受け入れる: 区間は [coveredUntil, 今回の読み始め]（間を読んでいない）", () => {
    const covered = NOW - 8 * DAY;
    const r = reconcile(input({ previousCoveredUntil: covered }));
    const a = applyAcceptance(r, { coveredUntil: covered });
    expect(a.status).toBe("applied");
    if (a.status !== "applied") return;
    expect(a.interval).toEqual({ from: covered, until: NOW - 6 * DAY, codes: { coverage_gap: 1 } });
    expect(codes(a.result)).toEqual(["note:coverage_gap"]);
  });
  it("窓の外の錨（unresolved_out_of_window）を受け入れる: 区間は [最も古い錨, max(最も新しい錨, 読み始め)]", () => {
    const old = NOW - 7 * DAY;
    const anchors = anchorsOf(old, old);
    const r = reconcile(input({ anchors, previousCoveredUntil: NOW - 2 * DAY }));
    expect(codes(r)).toEqual(["error:unresolved_out_of_window"]);
    const a = applyAcceptance(r, { anchors, coveredUntil: NOW - 2 * DAY });
    expect(a.status).toBe("applied");
    if (a.status !== "applied") return;
    expect(a.interval).toEqual({
      from: old,
      until: NOW - 6 * DAY,
      codes: { assume_without_record: 1 },
    });
    expect(reconcileExitCode(a.result)).toBe(0);
  });
  it("時刻を持たない誤り（region_unread）は受け入れで下げない（1 のまま・適用しない）", () => {
    const anchors = anchorsOf(NOW - 7 * DAY, NOW - 7 * DAY);
    const r = reconcile(
      input({ anchors, regions: { read: ["us-east-1"], unread: ["eu-west-1"] } }),
    );
    expect(applyAcceptance(r, { anchors }).status).toBe("rejected");
  });
  it("錨を窓の中で読み直して誤り 0（何も下げない）なら resolved: 受け入れた区間は作らない（h4 の「誤り 0 で消える」に盲点を作らない）", () => {
    const anchors = anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY);
    const r = reconcile(input({ anchors, previousCoveredUntil: NOW - 3 * DAY }));
    expect(reconcileExitCode(r)).toBe(0);
    const a = applyAcceptance(r, { anchors, coveredUntil: NOW - 3 * DAY });
    expect(a.status).toBe("resolved");
  });
  it("受け入れるもの（錨も今回の coverage_gap も）が無ければ nothing", () => {
    expect(
      applyAcceptance(reconcile(input({ previousCoveredUntil: NOW - DAY })), {
        coveredUntil: NOW - DAY,
      }).status,
    ).toBe("nothing");
  });
});

describe("nextAccountState（終了コード 0 でない実行は錨と時刻なしの件数を書き、coveredUntil は進めない。h2・q3・続き 4 の (2)〜(4)・B1・続き 5 の R2・R4）", () => {
  const W6 = NOW - 6 * DAY;
  it("誤りの実行: 時刻を持つ誤りは錨（最も古い・新しい・件数・最初に見つけた時刻・判定条件）、時刻なしは件数と読もうとした範囲、coverage_gap は保存しない", () => {
    const e1 = evFor(rec({ at: NOW - 3 * DAY }));
    const e2 = evFor(rec({ at: NOW - DAY }));
    const r = reconcile(
      input({
        events: [e1, e2],
        regions: { read: ["us-east-1"], unread: ["eu-west-1"] },
        previousCoveredUntil: NOW - 6 * DAY - 1,
      }),
    );
    const row = nextAccountState({ coveredUntil: NOW - 6 * DAY - 1 }, r, { now: NOW });
    expect(row).toEqual({
      coveredUntil: NOW - 6 * DAY - 1,
      unresolved: {
        oldestAt: e1.time,
        newestAt: e2.time,
        firstSeenAt: NOW,
        codes: { assume_without_record: 2 },
        criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
      },
      untimed: { codes: { region_unread: 1 }, firstWindowStart: W6, settledUntil: NOW - 300_000 },
    });
  });
  it("既にある錨と合わせる: 最も古いは前へ進めない・最も新しいは後へ・最初に見つけた時刻は保つ・件数は code ごとの最大・判定条件は厳しい方", () => {
    const prev: AccountState = {
      coveredUntil: NOW - 2 * DAY,
      unresolved: {
        oldestAt: NOW - 4 * DAY,
        newestAt: NOW - 3 * DAY,
        firstSeenAt: NOW - DAY,
        codes: { assume_without_record: 3, identity_mismatch: 1 },
        criteria: { clockSkewSeconds: 30, lagSeconds: 600 },
      },
      untimed: {
        codes: { region_unread: 1 },
        firstWindowStart: NOW - 5 * DAY,
        settledUntil: NOW - DAY,
      },
      accepted: [
        {
          from: NOW - 9 * DAY,
          until: NOW - 8 * DAY,
          acceptedAt: NOW - 7 * DAY,
          reasonGiven: true,
          codes: { coverage_gap: 1 },
        },
      ],
    };
    const e = evFor(rec({ at: NOW - HOUR }));
    const row = nextAccountState(prev, reconcile(input({ events: [e] })), { now: NOW });
    expect(row).toEqual({
      coveredUntil: NOW - 2 * DAY,
      unresolved: {
        oldestAt: NOW - 4 * DAY,
        newestAt: e.time,
        firstSeenAt: NOW - DAY,
        codes: { assume_without_record: 3, identity_mismatch: 1 },
        criteria: { clockSkewSeconds: 30, lagSeconds: 300 },
      },
      // 時刻なしの件数は誤り 0 の実行でだけ消える（今回の所見に無くても残す。(2)）。範囲はそのまま
      untimed: prev.untimed,
      accepted: prev.accepted,
    });
    // 時刻なしの誤りだけの実行は錨を保ち、件数は code ごとの最大（足し合わせない）。範囲は始まりの最も古い・終わりの最も新しい
    const untimedOnly = nextAccountState(
      prev,
      reconcile(
        input({
          incompleteReads: ["w"],
          regions: { read: ["us-east-1"], unread: ["eu-west-1", "ap-south-1"] },
        }),
      ),
      { now: NOW },
    );
    expect(untimedOnly.unresolved).toEqual(prev.unresolved);
    expect(untimedOnly.untimed).toEqual({
      codes: { record_read_incomplete: 1, region_unread: 2 },
      firstWindowStart: W6,
      settledUntil: NOW - 300_000,
    });
    const again = nextAccountState(
      untimedOnly,
      reconcile(input({ window: { since: NOW - DAY, until: NOW - HOUR }, incompleteReads: ["w"] })),
      { now: NOW },
    );
    expect(again.untimed).toEqual(untimedOnly.untimed);
  });
  it("検証できない引き受けだけの実行（終了コード 1）は時刻なしの件数 unverifiable を書く", () => {
    const old = rec({ at: NOW - 8 * DAY });
    const r = reconcile(
      input({ window: { since: NOW - 10 * DAY, until: NOW }, events: [evFor(old)] }),
    );
    expect(nextAccountState(undefined, r, { now: NOW, watchStart: NOW })).toEqual({
      watchStart: NOW,
      untimed: {
        codes: { unverifiable: 1 },
        firstWindowStart: NOW - 10 * DAY,
        settledUntil: NOW - 300_000,
      },
    });
  });
  it("件数は上限（MAX_CODE_COUNT）で飽和させて書く。書いたものは読める（(4)）", () => {
    const old = rec({ at: NOW - 8 * DAY });
    const r0 = reconcile(
      input({ window: { since: NOW - 10 * DAY, until: NOW }, events: [evFor(old)] }),
    );
    const r = { ...r0, summary: { ...r0.summary, unverifiable: MAX_CODE_COUNT * 3 } };
    const row = nextAccountState(
      {
        watchStart: NOW - 10 * DAY,
        untimed: {
          codes: { unverifiable: MAX_CODE_COUNT },
          firstWindowStart: NOW - 10 * DAY,
          settledUntil: NOW - 300_000,
        },
      },
      r,
      { now: NOW },
    );
    expect(row.untimed?.codes).toEqual({ unverifiable: MAX_CODE_COUNT });
    const text = serializeReconcileState(
      withAccountState(parseReconcileState(undefined), ACCOUNT, row),
    );
    expect(accountStateOf(parseReconcileState(text, NOW), ACCOUNT)).toEqual(row);
  });
  it("終了コード 0: coveredUntil を進め、判定した範囲が錨と時刻なしの範囲を含めば消し、accepted は残す", () => {
    const prev: AccountState = {
      coveredUntil: NOW - 2 * DAY,
      unresolved: anchorsOf(NOW - DAY, NOW - DAY),
      untimed: {
        codes: { region_unread: 1 },
        firstWindowStart: NOW - 3 * DAY,
        settledUntil: NOW - DAY,
      },
      accepted: [
        { from: 1, until: 2, acceptedAt: 3, reasonGiven: true, codes: { coverage_gap: 1 } },
      ],
    };
    const r = reconcile(input({ previousCoveredUntil: NOW - 2 * DAY }));
    expect(nextAccountState(prev, r, { now: NOW })).toEqual({
      coveredUntil: NOW - 300_000,
      accepted: prev.accepted,
    });
    // 行の無い --init の実行で 0 なら coveredUntil だけ
    expect(nextAccountState(undefined, reconcile(input()), { now: NOW })).toEqual({
      coveredUntil: NOW - 300_000,
    });
  });
  it("終了コード 0 でも、判定した範囲（読み始めから --until − lag まで）が錨を含まなければ錨は消さない（(3)・R2）", () => {
    const prev: AccountState = {
      coveredUntil: NOW - 2 * DAY,
      unresolved: anchorsOf(NOW - 3 * DAY, NOW - DAY),
    };
    // 錨を reconcile に渡さずに作った短い窓の成功結果
    const late = reconcile(
      input({ window: { since: NOW - 2 * DAY, until: NOW }, previousCoveredUntil: NOW - 2 * DAY }),
    );
    expect(reconcileExitCode(late)).toBe(0);
    expect(nextAccountState(prev, late, { now: NOW }).unresolved).toEqual(prev.unresolved);
    const early = reconcile(
      input({
        window: { since: NOW - 4 * DAY, until: NOW - 2 * DAY },
        previousCoveredUntil: NOW - 2 * DAY,
      }),
    );
    expect(nextAccountState(prev, early, { now: NOW }).unresolved).toEqual(prev.unresolved);
    // 最も新しい錨が lag（既定 300 秒）の内: pending で判定していないので消さない
    const inLag = reconcile(
      input({
        window: { since: NOW - 3 * DAY, until: NOW - DAY + 60_000 },
        previousCoveredUntil: NOW - 2 * DAY,
      }),
    );
    expect(reconcileExitCode(inLag)).toBe(0);
    expect(nextAccountState(prev, inLag, { now: NOW }).unresolved).toEqual(prev.unresolved);
    const whole = reconcile(
      input({
        window: { since: NOW - 3 * DAY, until: NOW - DAY + 300_000 },
        previousCoveredUntil: NOW - 2 * DAY,
      }),
    );
    expect(nextAccountState(prev, whole, { now: NOW }).unresolved).toBeUndefined();
  });
  it("終了コード 0 でも、時刻なしの誤りを記録した実行が読もうとした範囲を読み直していなければ untimed は消さない（R4）", () => {
    const untimed = {
      codes: { record_read_incomplete: 1 },
      firstWindowStart: NOW - 3 * DAY,
      settledUntil: NOW - DAY,
    };
    const prev: AccountState = { coveredUntil: NOW - 2 * DAY, untimed };
    const at = (since: number, until: number) =>
      nextAccountState(
        prev,
        reconcile(input({ window: { since, until }, previousCoveredUntil: NOW - 2 * DAY })),
        { now: NOW },
      );
    // --until を過去にした（until − lag が記録した終わりより前）
    expect(at(NOW - 3 * DAY, NOW - DAY).untimed).toEqual(untimed);
    // --since を後ろにした
    expect(at(NOW - 2 * DAY, NOW).untimed).toEqual(untimed);
    // 両方を含めば消える
    expect(at(NOW - 3 * DAY, NOW - DAY + 300_000).untimed).toBeUndefined();
    // 確認済みの区間の無い行は、見張りの始まり（watchStart）以前から読んだ誤り 0 の実行だけが消して確認済みにする（続き 5 の w2）
    const unconfirmed: AccountState = {
      watchStart: NOW - 6 * DAY,
      untimed: { ...untimed, firstWindowStart: NOW - 7 * DAY },
    };
    const r6 = reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 6 * DAY }));
    expect(reconcileExitCode(r6)).toBe(0);
    expect(nextAccountState(unconfirmed, r6, { now: NOW })).toEqual({
      coveredUntil: NOW - 300_000,
    });
    const r6past = reconcile(
      input({
        window: { since: NOW - 6 * DAY, until: NOW - 2 * DAY },
        coverageBasis: "unconfirmed",
        watchStart: NOW - 6 * DAY,
      }),
    );
    // 読み始めは見張りの始まり以前なので確認済みにはなるが、終わりの側を読み直していないので untimed は残る
    expect(nextAccountState(unconfirmed, r6past, { now: NOW })).toEqual({
      coveredUntil: NOW - 2 * DAY - 300_000,
      untimed: unconfirmed.untimed,
    });
    // 読み始めが見張りの始まりより後の結果（watchStart を渡さずに作った）は、状態の側でも確認済みにしない
    const later: AccountState = { ...unconfirmed, watchStart: NOW - 7 * DAY };
    expect(nextAccountState(later, r6, { now: NOW })).toEqual(later);
  });
  it("受け入れによる削除は別の関数（acceptedAccountState）: 受け入れの結果（applied）を受け、錨を消し、受け入れた区間を追記し、coveredUntil は通常どおり進める。applied でなければ例外", () => {
    const anchors = anchorsOf(NOW - 7 * DAY, NOW - 7 * DAY);
    const prev: AccountState = {
      coveredUntil: NOW - 2 * DAY,
      unresolved: anchors,
      accepted: [
        { from: 1, until: 2, acceptedAt: 3, reasonGiven: true, codes: { coverage_gap: 1 } },
      ],
    };
    const r = reconcile(input({ anchors, previousCoveredUntil: NOW - 2 * DAY }));
    const outcome = applyAcceptance(r, { anchors, coveredUntil: NOW - 2 * DAY });
    expect(outcome.status).toBe("applied");
    expect(acceptedAccountState(prev, outcome, { acceptedAt: NOW })).toEqual({
      coveredUntil: NOW - 300_000,
      accepted: [
        ...(prev.accepted ?? []),
        {
          from: NOW - 7 * DAY,
          until: NOW - 6 * DAY,
          acceptedAt: NOW,
          reasonGiven: true,
          codes: { assume_without_record: 1 },
        },
      ],
    });
    // 受け入れの結果が applied でなければ使えない（状態の側でも確かめる。cto の見解）
    const rejected = applyAcceptance(reconcile(input({ events: [evFor(rec())], anchors })), {
      anchors,
    });
    expect(rejected.status).toBe("rejected");
    expect(() => acceptedAccountState(prev, rejected, { acceptedAt: NOW })).toThrow();
    const resolved = applyAcceptance(
      reconcile(input({ anchors: anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY) })),
      { anchors: anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY) },
    );
    expect(resolved.status).toBe("resolved");
    expect(() => acceptedAccountState(prev, resolved, { acceptedAt: NOW })).toThrow();
  });
});

describe("coverage の表示（i3・i4）と状態の行（q1: 毎回 accepted intervals の数と最新の区間）", () => {
  it("--init の実行は first run (explicit --init)、coveredUntil の無い行は unconfirmed（first run ではない）", () => {
    const init = reconcile(input({ coverageBasis: "init" }));
    expect(init.summary.coverage).toEqual({ status: "first_run", explicit: true });
    expect(formatReconcileReport(init)).toContain("coverage: first run (explicit --init)");
    const un = reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 6 * DAY }));
    expect(un.summary.coverage).toEqual({ status: "unconfirmed" });
    expect(formatReconcileReport(un)).toContain("coverage: unconfirmed");
    expect(formatReconcileReport(un)).not.toContain("first run");
    expect(codes(un)).toEqual([]);
  });
  it("状態の行: 未解決の錨・時刻なしの件数・accepted intervals の数と最新の区間を出す（件数と時刻だけ）", () => {
    expect(formatStateLines(undefined)).toEqual(["unresolved: none", "accepted intervals: 0"]);
    const lines = formatStateLines({
      coveredUntil: NOW,
      unresolved: {
        oldestAt: NOW - 2 * DAY,
        newestAt: NOW - DAY,
        firstSeenAt: NOW - HOUR,
        codes: { assume_without_record: 2 },
        criteria: { clockSkewSeconds: 60, lagSeconds: 300 },
      },
      untimed: {
        codes: { region_unread: 1 },
        firstWindowStart: NOW - 3 * DAY,
        settledUntil: NOW - DAY,
      },
      accepted: [
        {
          from: NOW - 9 * DAY,
          until: NOW - 8 * DAY,
          acceptedAt: NOW - 7 * DAY,
          reasonGiven: true,
          codes: { coverage_gap: 1 },
        },
        {
          from: NOW - 5 * DAY,
          until: NOW - 4 * DAY,
          acceptedAt: NOW - 3 * DAY,
          reasonGiven: true,
          codes: { assume_without_record: 1 },
        },
      ],
    });
    expect(lines).toEqual([
      `unresolved: oldest ${iso(NOW - 2 * DAY)}, newest ${iso(NOW - DAY)}, first seen ${iso(NOW - HOUR)}, assume_without_record=2 (judged with clock skew 60s, lag 300s)`,
      "unresolved untimed errors (largest count per code): region_unread=1",
      `accepted intervals: 2 (latest ${iso(NOW - 5 * DAY)} .. ${iso(NOW - 4 * DAY)}, accepted at ${iso(NOW - 3 * DAY)}; not confirmed)`,
    ]);
  });
});

describe("確認済みの区間の無い行は、読み始めが今 − 6 日より後なら誤り（続き 4 の (1)。--init の実行そのものは対象外）", () => {
  it("unconfirmed で読み始めが今 − 6 日より後なら unconfirmed_not_covered（誤り）。ちょうど 6 日なら出ない。--init と確認済みの区間のある行には出ない", () => {
    const r = reconcile(
      input({
        window: { since: NOW - HOUR, until: NOW },
        coverageBasis: "unconfirmed",
        watchStart: NOW - 6 * DAY,
      }),
    );
    expect(codes(r)).toEqual(["error:unconfirmed_not_covered"]);
    expect(reconcileExitCode(r)).toBe(1);
    expect(
      codes(reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 6 * DAY }))),
    ).toEqual([]);
    expect(
      codes(reconcile(input({ window: { since: NOW - HOUR, until: NOW }, coverageBasis: "init" }))),
    ).toEqual([]);
    expect(
      codes(
        reconcile(
          input({ window: { since: NOW - HOUR, until: NOW }, previousCoveredUntil: NOW - HOUR }),
        ),
      ),
    ).toEqual([]);
  });
  it("受け入れで下げない（受け入れられるのは錨と今回の coverage_gap の区間だけ）", () => {
    const anchors = anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY);
    const r = reconcile(
      input({
        window: { since: NOW - 3 * DAY, until: NOW },
        coverageBasis: "unconfirmed",
        watchStart: NOW - 6 * DAY,
        anchors,
      }),
    );
    expect(codes(r)).toEqual(["error:unconfirmed_not_covered"]);
    expect(applyAcceptance(r, { anchors }).status).toBe("rejected");
  });
});

describe("錨を作ったときの判定条件より緩い実行は、誤り 0 でも解決にしない（続き 4 の B1・B2）", () => {
  const anchors = anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY);
  it("--clock-skew-seconds・--lag-seconds が錨の値より大きければ unresolved_criteria_looser（誤り）。同じか厳しければ出ない", () => {
    const skew = reconcile(input({ anchors, clockSkewSeconds: 120 }));
    expect(codes(skew)).toEqual(["error:unresolved_criteria_looser"]);
    expect(skew.findings[0]?.detail).toContain("clock skew 120s > 60s");
    expect(skew.findings[0]?.detail).toContain("not treated as resolved");
    const lag = reconcile(input({ anchors, lagSeconds: 600 }));
    expect(codes(lag)).toEqual(["error:unresolved_criteria_looser"]);
    expect(lag.findings[0]?.detail).toContain("lag 600s > 300s");
    expect(codes(reconcile(input({ anchors, clockSkewSeconds: 60, lagSeconds: 300 })))).toEqual([]);
    expect(codes(reconcile(input({ anchors, clockSkewSeconds: 10, lagSeconds: 60 })))).toEqual([]);
  });
  it("緩い実行の結果では錨を消さない（終了コード 1）。出口は理由つきの受け入れ", () => {
    const r = reconcile(input({ anchors, clockSkewSeconds: 120, previousCoveredUntil: NOW - DAY }));
    const prev: AccountState = { coveredUntil: NOW - DAY, unresolved: anchors };
    expect(nextAccountState(prev, r, { now: NOW }).unresolved).toEqual(anchors);
    const a = applyAcceptance(r, { anchors, coveredUntil: NOW - DAY });
    expect(a.status).toBe("applied");
    if (a.status !== "applied") return;
    expect(codes(a.result)).toEqual(["note:unresolved_criteria_looser"]);
  });
  it("緩い実行で新しい錨を足すときも、判定条件は厳しい方（小さい方）を保つ", () => {
    const e = evFor(rec({ at: NOW - HOUR }));
    const r = reconcile(input({ anchors, events: [e], clockSkewSeconds: 120, lagSeconds: 30 }));
    const row = nextAccountState({ coveredUntil: NOW - DAY, unresolved: anchors }, r, { now: NOW });
    expect(row.unresolved?.criteria).toEqual({ clockSkewSeconds: 60, lagSeconds: 30 });
  });
});

describe("受け入れは区間に対して行う（続き 4 の A1・A2・A4）", () => {
  it("既知の限界（A4）: 記録 1 件の code の区間の中で、記録した所見が消えて新しい同じ code が 1 件出たら、見分けられずに受け入れる（code と件数の検査は取り違えへの守りで、同一性の保証ではない）", () => {
    const t0 = NOW - 3 * DAY;
    const t2 = NOW - DAY;
    const anchors = anchorsOf(t0, t2, { assume_without_record: 1, identity_mismatch: 1 });
    // t0 の記録した引き受けは今回は見えず（記録が読めた）、区間の中の別の時刻 t1 に新しい同じ code の誤りが 1 件
    const fresh = evFor(rec({ at: NOW - 2 * DAY }));
    const r = reconcile(input({ events: [fresh], anchors }));
    const a = applyAcceptance(r, { anchors });
    expect(a.status).toBe("applied");
    if (a.status !== "applied") return;
    expect(codes(a.result)).toEqual(["note:assume_without_record"]);
  });
});

describe("続き 5: 判定した範囲で見る（R2）・受け入れの件数は飽和させずに比べる（R3）", () => {
  it("最も新しい錨が判定した範囲（--until − lag）の外なら unresolved_not_covered（lag の内は pending で判定していない）", () => {
    const anchors = anchorsOf(NOW - 2 * DAY, NOW - DAY);
    const r = reconcile(
      input({ window: { since: NOW - 3 * DAY, until: NOW - DAY + 60_000 }, anchors }),
    );
    expect(codes(r)).toEqual(["error:unresolved_not_covered"]);
    expect(r.findings[0]?.detail).toContain("judged");
    expect(
      codes(
        reconcile(input({ window: { since: NOW - 3 * DAY, until: NOW - DAY + 300_000 }, anchors })),
      ),
    ).toEqual([]);
  });
  it("時刻なしの誤りを記録した実行の窓の始まりが通常の読み始めより前なら、既定の読み始めはそこまで戻す（R4 の読み直しを既定の実行でできるように。今 − 6 日で切る）", () => {
    const coveredUntil = NOW - 2 * HOUR;
    const s = decideReadStart({ now: NOW, coveredUntil, untimedStart: NOW - 3 * DAY });
    expect(s).toEqual({
      basis: "untimed",
      since: NOW - 3 * DAY,
      untimedStart: NOW - 3 * DAY,
      coveredUntil,
    });
    expect(formatReconcileReport(reconcile(input()), { start: s })).toContain(
      `read start: ${iso(NOW - 3 * DAY)} (from the unresolved untimed errors: the run that recorded them started ${iso(NOW - 3 * DAY)})`,
    );
    expect(decideReadStart({ now: NOW, coveredUntil, untimedStart: NOW - HOUR })).toEqual(
      decideReadStart({ now: NOW, coveredUntil }),
    );
    expect(decideReadStart({ now: NOW, coveredUntil, untimedStart: NOW - 8 * DAY }).since).toBe(
      NOW - 6 * DAY,
    );
  });
  it("記録した件数が上限（MAX_CODE_COUNT）で飽和していれば、受け入れを適用しない（rejected と理由）", () => {
    const e = evFor(rec({ at: NOW - 2 * DAY }));
    const anchors = anchorsOf(e.time, e.time, { assume_without_record: MAX_CODE_COUNT });
    const a = applyAcceptance(reconcile(input({ events: [e], anchors })), { anchors });
    expect(a.status).toBe("rejected");
    if (a.status !== "rejected") return;
    expect(a.reason).toContain("saturated");
  });
});

describe("続き 6: 受け入れで untimed を消す条件（U3）・解決を飽和の検査より先に（U4）・範囲の前後（U7）", () => {
  it("U3: 受け入れの実行が、時刻なしの誤りを記録した実行の範囲を読み直していなければ untimed を残す（読み直していれば消す）", () => {
    const untimed = {
      codes: { region_unread: 1 },
      firstWindowStart: NOW - 3 * DAY,
      settledUntil: NOW - DAY,
    };
    const e = evFor(rec({ at: NOW - 2 * DAY }));
    const anchors = anchorsOf(e.time, e.time);
    const prev: AccountState = { coveredUntil: NOW - 2 * DAY, unresolved: anchors, untimed };
    // 錨より後から読んだ受け入れ（錨は unresolved_not_covered として受け入れる）。時刻なしの誤りの窓は未読
    const short = reconcile(
      input({
        window: { since: NOW - HOUR, until: NOW },
        anchors,
        previousCoveredUntil: NOW - 2 * DAY,
      }),
    );
    const s1 = applyAcceptance(short, { anchors, coveredUntil: NOW - 2 * DAY });
    expect(s1.status).toBe("applied");
    expect(acceptedAccountState(prev, s1, { acceptedAt: NOW }).untimed).toEqual(untimed);
    // 記録した範囲ごと読み直した受け入れ（同じ所見を読み直して下げる）
    const whole = reconcile(
      input({
        window: { since: NOW - 3 * DAY, until: NOW },
        events: [e],
        anchors,
        previousCoveredUntil: NOW - 2 * DAY,
      }),
    );
    const s2 = applyAcceptance(whole, { anchors, coveredUntil: NOW - 2 * DAY });
    expect(s2.status).toBe("applied");
    expect(acceptedAccountState(prev, s2, { acceptedAt: NOW }).untimed).toBeUndefined();
  });
  it("U4: 記録が飽和していても、読み直して誤り 0 なら受け入れずに解決する（resolved）", () => {
    const anchors = anchorsOf(NOW - 2 * DAY, NOW - 2 * DAY, {
      assume_without_record: MAX_CODE_COUNT,
    });
    const r = reconcile(input({ anchors }));
    expect(reconcileExitCode(r)).toBe(0);
    expect(applyAcceptance(r, { anchors }).status).toBe("resolved");
  });
  it("U7: 判定した終わりが読み始めより前の短い窓でも、書く範囲は前後が逆にならない（読める状態を書く）", () => {
    const r = reconcile(
      input({
        window: { since: NOW - 60_000, until: NOW },
        incompleteReads: ["w"],
        previousCoveredUntil: NOW - HOUR,
      }),
    );
    const row = nextAccountState({ coveredUntil: NOW - HOUR }, r, { now: NOW });
    expect((row.untimed?.firstWindowStart as number) <= (row.untimed?.settledUntil as number)).toBe(
      true,
    );
    const text = serializeReconcileState(
      withAccountState(parseReconcileState(undefined), ACCOUNT, row),
    );
    expect(accountStateOf(parseReconcileState(text, NOW), ACCOUNT)).toEqual(row);
  });
});

describe("続き 5（cto）: 見張りの始まり（watchStart）と、読み直せない時刻なしの誤り（untimed_not_covered）", () => {
  it("w2: 確認済みの区間の無い行は、読み始めが watchStart より後なら誤り。watchStart が今 − 6 日より後なら unconfirmed_not_covered（受け入れの対象外）、前なら untimed_not_covered（受け入れの対象）", () => {
    const later = reconcile(
      input({
        window: { since: NOW - HOUR, until: NOW },
        coverageBasis: "unconfirmed",
        watchStart: NOW - 2 * HOUR,
      }),
    );
    expect(codes(later)).toEqual(["error:unconfirmed_not_covered"]);
    expect(
      codes(reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 2 * HOUR }))),
    ).toEqual([]);
    const gone = reconcile(
      input({ coverageBasis: "unconfirmed", watchStart: NOW - 6 * DAY - HOUR }),
    );
    expect(codes(gone)).toEqual(["error:untimed_not_covered"]);
    expect(gone.findings[0]?.detail).toContain(new Date(NOW - 6 * DAY - HOUR).toISOString());
    // --since を watchStart 以前にすれば読み直せる（既定の読み始めは 6 日より前に伸ばさない）
    expect(
      codes(
        reconcile(
          input({
            window: { since: NOW - 6 * DAY - HOUR, until: NOW },
            coverageBasis: "unconfirmed",
            watchStart: NOW - 6 * DAY - HOUR,
          }),
        ),
      ),
    ).toEqual([]);
  });
  it("w5・U2: 確認済みの行で、時刻なしの誤りを記録した窓の始まりが今 − 6 日より前なら、読み始めが後のとき毎回 untimed_not_covered（受け入れの対象）", () => {
    const untimed = { firstWindowStart: NOW - 6 * DAY - HOUR, settledUntil: NOW - 5 * DAY };
    const r = reconcile(input({ previousCoveredUntil: NOW - 5 * DAY, untimed }));
    expect(codes(r)).toEqual(["error:untimed_not_covered"]);
    expect(
      codes(
        reconcile(
          input({
            window: { since: NOW - 6 * DAY - HOUR, until: NOW },
            previousCoveredUntil: NOW - 5 * DAY,
            untimed,
          }),
        ),
      ),
    ).toEqual([]);
    // 既定の窓で読み直せるなら誤りにしない（消えないだけ）
    expect(
      codes(
        reconcile(
          input({
            previousCoveredUntil: NOW - 5 * DAY,
            untimed: { firstWindowStart: NOW - 5 * DAY, settledUntil: NOW - 4 * DAY },
          }),
        ),
      ),
    ).toEqual([]);
  });
  it("w3・U2: untimed_not_covered は受け入れの対象。受け入れた区間に [記録した窓の始まり（watchStart）, 今回の読み始め] が入り、受け入れで untimed を消す", () => {
    const untimed = {
      codes: { region_unread: 1 },
      firstWindowStart: NOW - 6 * DAY - HOUR,
      settledUntil: NOW - 5 * DAY,
    };
    const prev: AccountState = { coveredUntil: NOW - 5 * DAY, untimed };
    const r = reconcile(input({ previousCoveredUntil: NOW - 5 * DAY, untimed }));
    const a = applyAcceptance(r, {
      coveredUntil: NOW - 5 * DAY,
      untimedStart: untimed.firstWindowStart,
      untimedCodes: untimed.codes,
    });
    expect(a.status).toBe("applied");
    if (a.status !== "applied") return;
    expect(a.interval).toMatchObject({ from: NOW - 6 * DAY - HOUR, until: NOW - 6 * DAY });
    expect(a.interval.codes).toMatchObject({ untimed_not_covered: 1, region_unread: 1 });
    expect(acceptedAccountState(prev, a, { acceptedAt: NOW }).untimed).toBeUndefined();
    // 確認済みの区間の無い行: 区間の始まりは watchStart
    const u2: AccountState = {
      watchStart: NOW - 7 * DAY,
      untimed: { ...untimed, firstWindowStart: NOW - 8 * DAY },
    };
    const r2 = reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 7 * DAY }));
    const a2 = applyAcceptance(r2, { untimedStart: NOW - 7 * DAY });
    expect(a2.status).toBe("applied");
    if (a2.status !== "applied") return;
    expect(a2.interval).toMatchObject({ from: NOW - 7 * DAY, until: NOW - 6 * DAY });
    expect(acceptedAccountState(u2, a2, { acceptedAt: NOW })).toMatchObject({
      coveredUntil: NOW - 300_000,
    });
    expect(acceptedAccountState(u2, a2, { acceptedAt: NOW }).untimed).toBeUndefined();
    expect(acceptedAccountState(u2, a2, { acceptedAt: NOW }).watchStart).toBeUndefined();
  });
  it("w1: --init の誤りの実行は watchStart を書く（以後の誤りの実行でも動かない）。確認済みになれば消える", () => {
    const r = reconcile(
      input({
        window: { since: NOW - 2 * HOUR, until: NOW },
        incompleteReads: ["w"],
        coverageBasis: "init",
      }),
    );
    const row = nextAccountState(undefined, r, { now: NOW, watchStart: NOW - 2 * HOUR });
    expect(row.watchStart).toBe(NOW - 2 * HOUR);
    const again = nextAccountState(
      row,
      reconcile(
        input({ incompleteReads: ["w"], coverageBasis: "unconfirmed", watchStart: NOW - 2 * HOUR }),
      ),
      { now: NOW + 1000 },
    );
    expect(again.watchStart).toBe(NOW - 2 * HOUR);
    expect(() => nextAccountState(undefined, r, { now: NOW })).toThrow();
  });
});

describe("続き 7（V1）: untimed_not_covered の受け入れは、記録した untimed の末尾まで判定していなければ適用しない", () => {
  const untimed = {
    codes: { record_read_incomplete: 1 },
    firstWindowStart: NOW - 6 * DAY - HOUR,
    settledUntil: NOW - HOUR,
  };
  it("今回の判定した終わり（until − lag）が settledUntil より前なら rejected（理由つき）。--until が無ければ applied", () => {
    const past = reconcile(
      input({
        window: { since: NOW - 6 * DAY, until: NOW - 3 * HOUR },
        previousCoveredUntil: NOW - 2 * HOUR,
        untimed,
      }),
    );
    expect(codes(past)).toEqual(["error:untimed_not_covered"]);
    const a = applyAcceptance(past, {
      coveredUntil: NOW - 2 * HOUR,
      untimedStart: untimed.firstWindowStart,
      untimedSettledUntil: untimed.settledUntil,
      untimedCodes: untimed.codes,
    });
    expect(a.status).toBe("rejected");
    if (a.status !== "rejected") return;
    expect(a.reason).toContain("did not read the end of the unresolved untimed errors");
    const now0 = reconcile(input({ previousCoveredUntil: NOW - 2 * HOUR, untimed }));
    expect(
      applyAcceptance(now0, {
        coveredUntil: NOW - 2 * HOUR,
        untimedStart: untimed.firstWindowStart,
        untimedSettledUntil: untimed.settledUntil,
        untimedCodes: untimed.codes,
      }).status,
    ).toBe("applied");
  });
  it("acceptedAccountState も、受け入れた区間 ∪ 今回判定した範囲が [untimed の始まり, settledUntil] を覆わなければ例外（覆えば消す）", () => {
    const prev: AccountState = { coveredUntil: NOW - 2 * HOUR, untimed };
    const ok = applyAcceptance(
      reconcile(input({ previousCoveredUntil: NOW - 2 * HOUR, untimed })),
      {
        coveredUntil: NOW - 2 * HOUR,
        untimedStart: untimed.firstWindowStart,
        untimedSettledUntil: untimed.settledUntil,
      },
    );
    expect(ok.status).toBe("applied");
    expect(acceptedAccountState(prev, ok, { acceptedAt: NOW }).untimed).toBeUndefined();
    // 末尾が今回の判定より後の行に、同じ受け入れの結果を当てる
    const later: AccountState = {
      coveredUntil: NOW - 2 * HOUR,
      untimed: { ...untimed, settledUntil: NOW },
    };
    expect(() => acceptedAccountState(later, ok, { acceptedAt: NOW })).toThrow();
    // 確認済みの区間の無い行は始まりを watchStart で見る
    const u: AccountState = {
      watchStart: NOW - 6 * DAY - HOUR,
      untimed: { ...untimed, firstWindowStart: NOW - 7 * DAY },
    };
    const okU = applyAcceptance(
      reconcile(input({ coverageBasis: "unconfirmed", watchStart: NOW - 6 * DAY - HOUR })),
      { untimedStart: NOW - 6 * DAY - HOUR, untimedSettledUntil: untimed.settledUntil },
    );
    expect(okU.status).toBe("applied");
    expect(acceptedAccountState(u, okU, { acceptedAt: NOW }).untimed).toBeUndefined();
  });
});
