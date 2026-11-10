// PoC P2（セッションタグでの認可）・P3（SourceIdentity）のケース表と判定。I/O は checks.ts で行う。
// 否定ケースは対照のケースと 1 点だけ違うようにする（信頼ポリシーの拒否はどれも AccessDenied で、理由が返らないため）。
//   4〜8 は 1 と、9 は 10 と 1 点だけ違う。
import { type RoleKey, sessionTagClaims, sourceIdentityClaim, type TagFormat } from "./lib";

/** ok = 成功、denied = AccessDenied、error = 何らかのエラー（コードは問わない）、record = 結果を記録するだけ */
export type Expect = "ok" | "denied" | "error" | "record";
export type Outcome = { ok: true } | { ok: false; code: string; detail?: string };
export type ProbeApi = "s3:ListBuckets" | "iam:ListRoles";

export interface ProbeSpec {
  api: ProbeApi;
  expect: Expect;
}

export interface CheckCase {
  id: string;
  role: RoleKey;
  title: string;
  tags: Record<string, string>;
  tagFormat: TagFormat;
  /** true なら SourceIdentity に subject を入れる */
  sourceIdentity: boolean;
  expect: Expect;
  /** 引き受けに成功したときに試す API（権限の判定。sts:GetCallerIdentity は権限で拒否されないので使わない） */
  probes: ProbeSpec[];
  /** PackedPolicySize / SessionTokenSize / トークン長を記録する */
  reportSize?: boolean;
}

const ADMIN = { access_profile: "poc-admin" };
const BOTH_OK: ProbeSpec[] = [
  { api: "s3:ListBuckets", expect: "ok" },
  { api: "iam:ListRoles", expect: "ok" },
];

/** 決まった種から作る、圧縮しにくい英数字の列（PackedPolicySize を実際に近い大きさで測るため）。 */
function pseudoRandomValue(seed: number, length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let x = (seed * 2654435761) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < length; i++) {
    // xorshift32
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += chars[x % chars.length];
  }
  return out;
}

function manyTags(count: number, value: (i: number) => string): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`t${String(i + 1).padStart(2, "0")}`, value(i + 1)]),
  );
}

export function checkCases(): CheckCase[] {
  const tagged = { role: "tagged" as const, tagFormat: "nested" as const, sourceIdentity: true };
  return [
    {
      id: "1",
      ...tagged,
      title: "入れ子形式 poc-admin + SI",
      tags: ADMIN,
      expect: "ok",
      probes: BOTH_OK,
    },
    {
      id: "2",
      ...tagged,
      tagFormat: "flat",
      title: "平坦形式 poc-admin + SI",
      tags: ADMIN,
      expect: "ok",
      probes: BOTH_OK,
    },
    {
      id: "3",
      ...tagged,
      title: "poc-viewer + SI（ListRoles は PrincipalTag で拒否）",
      tags: { access_profile: "poc-viewer" },
      expect: "ok",
      probes: [
        { api: "s3:ListBuckets", expect: "ok" },
        { api: "iam:ListRoles", expect: "denied" },
      ],
    },
    {
      id: "4",
      ...tagged,
      title: "値違い poc-other + SI",
      tags: { access_profile: "poc-other" },
      expect: "denied",
      probes: [],
    },
    { id: "5", ...tagged, title: "タグなし + SI", tags: {}, expect: "denied", probes: [] },
    {
      id: "6",
      ...tagged,
      title: "未知のキーを追加（unknown_key）+ SI",
      tags: { ...ADMIN, unknown_key: "x" },
      expect: "denied",
      probes: [],
    },
    {
      id: "7",
      ...tagged,
      title: "キーの大文字違い Access_Profile=poc-admin + SI",
      tags: { Access_Profile: "poc-admin" },
      expect: "record",
      probes: [
        { api: "s3:ListBuckets", expect: "record" },
        { api: "iam:ListRoles", expect: "record" },
      ],
    },
    {
      id: "8",
      ...tagged,
      sourceIdentity: false,
      title: "SI なし poc-admin",
      tags: ADMIN,
      expect: "denied",
      probes: [],
    },
    {
      id: "9",
      role: "notag",
      tagFormat: "nested",
      sourceIdentity: false,
      title: "TagSession なしのロールにタグ付き（SI なし）",
      tags: ADMIN,
      expect: "denied",
      probes: [],
    },
    {
      id: "10",
      role: "notag",
      tagFormat: "nested",
      sourceIdentity: false,
      title: "TagSession なしのロールにタグも SI もなし",
      tags: {},
      expect: "ok",
      probes: [{ api: "s3:ListBuckets", expect: "ok" }],
    },
    {
      id: "11",
      role: "base",
      tagFormat: "nested",
      sourceIdentity: false,
      title: "既存ロールに 50 個 × 値 256 文字",
      tags: manyTags(50, (i) => pseudoRandomValue(i, 256)),
      expect: "ok",
      probes: [{ api: "s3:ListBuckets", expect: "ok" }],
      reportSize: true,
    },
    {
      id: "12",
      role: "base",
      tagFormat: "nested",
      sourceIdentity: false,
      title: "既存ロールに 51 個（値は短い）",
      tags: manyTags(51, () => "v"),
      expect: "error",
      probes: [],
      reportSize: true,
    },
  ];
}

/** ケースの JWT に足す claim（タグ + SI。SI の値は subject）。 */
export function caseClaims(c: CheckCase, subject: string): Record<string, unknown> {
  return {
    ...sessionTagClaims(c.tags, c.tagFormat),
    ...(c.sourceIdentity ? sourceIdentityClaim(subject) : {}),
  };
}

export function judge(expect: Expect, outcome: Outcome): "PASS" | "FAIL" | "INFO" {
  switch (expect) {
    case "record":
      return "INFO";
    case "ok":
      return outcome.ok ? "PASS" : "FAIL";
    case "denied":
      return !outcome.ok && outcome.code === "AccessDenied" ? "PASS" : "FAIL";
    case "error":
      return outcome.ok ? "FAIL" : "PASS";
  }
}

export function outcomeLabel(o: Outcome): string {
  return o.ok ? "成功" : o.code;
}

export function expectLabel(e: Expect): string {
  return { ok: "成功", denied: "AccessDenied", error: "エラー", record: "記録" }[e];
}

/** Markdown の表。セル中の | はエスケープする。 */
export function markdownTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
