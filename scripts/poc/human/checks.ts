// PoC P2（セッションタグでの認可）・P3（SourceIdentity）のケース表（cases.ts）を順に流し、
// 各ケースの期待と実際（成功 / エラーコード）を Markdown の表で出す。認証情報は出さない（ファイルにも書かない）。
// 引き受けに成功したケースでは、権限の差を s3:ListBuckets / iam:ListRoles で確かめる（sts:GetCallerIdentity は権限で拒否されないので使わない）。
// email・アカウント ID は伏せて出す（結果を README に貼れるように）。
//
// オプション:
//   --only <ID の一覧>   流すケースを絞る（例 --only 1,3,8）
import { parseArgs } from "node:util";
import {
  type CheckCase,
  caseClaims,
  checkCases,
  expectLabel,
  judge,
  markdownTable,
  type Outcome,
  outcomeLabel,
} from "./cases";
import { assumeWithClaims, fail, probeApi, required, roleArnOf, stackOutputs } from "./io";
import { humanPocSettings, type RoleKey } from "./lib";
import { credentialsEnv, maskSensitive } from "./ops";

let values: ReturnType<typeof parse>["values"];
function parse() {
  return parseArgs({ options: { only: { type: "string" } } });
}
try {
  values = parse().values;
} catch (e) {
  fail((e as Error).message);
}

let settings: ReturnType<typeof humanPocSettings>;
try {
  settings = humanPocSettings(process.env);
} catch (e) {
  fail(`AWSBRIDGE_HUMAN_POC_ISSUER が不正です: ${(e as Error).message}`);
}
const issuer = required(settings.issuer, "AWSBRIDGE_HUMAN_POC_ISSUER");
const subject = required(settings.subject, "AWSBRIDGE_HUMAN_POC_SUBJECT");

let cases: CheckCase[] = checkCases();
if (values.only !== undefined) {
  const ids = values.only.split(",").map((s) => s.trim());
  const unknown = ids.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length > 0)
    fail(`--only に不明なケース ID: ${unknown.join(", ")}（1〜${cases.length}）`);
  cases = cases.filter((c) => ids.includes(c.id));
}

const outputs = stackOutputs(settings);
const roleArns = new Map<RoleKey, string>();
for (const role of new Set(cases.map((c) => c.role)))
  roleArns.set(role, roleArnOf(outputs, role, settings.stackName));
const roleName = (role: RoleKey) => (roleArns.get(role) ?? "").split("/").pop() ?? role;

const rows: string[][] = [];
let failCount = 0;
for (const c of cases) {
  const r = await assumeWithClaims({
    settings,
    issuer,
    subject,
    roleArn: roleArns.get(c.role) as string,
    extraClaims: caseClaims(c, subject),
  });
  const outcome: Outcome = r.ok ? { ok: true } : { ok: false, code: r.code };
  const verdict = judge(c.expect, outcome);
  if (verdict === "FAIL") failCount++;

  const probeCells: string[] = [];
  if (r.ok) {
    const env = credentialsEnv(process.env, r.creds, settings.region);
    for (const p of c.probes) {
      const o = await probeApi(p.api, env);
      const v = judge(p.expect, o);
      if (v === "FAIL") failCount++;
      probeCells.push(`${p.api}=${outcomeLabel(o)}（期待 ${expectLabel(p.expect)}: ${v}）`);
    }
  }

  let si = "-";
  if (r.ok) {
    const got = r.extras.sourceIdentity;
    si = got === undefined ? "なし" : got === subject ? "subject と一致" : "subject と不一致";
  }
  const size: string[] = [];
  if (c.reportSize) {
    size.push(`JWT ${r.tokenLength} 文字`);
    if (r.ok) {
      const e = r.extras;
      if (e.packedPolicySize !== undefined) size.push(`PackedPolicySize ${e.packedPolicySize}%`);
      if (e.sessionTokenUtilization !== undefined)
        size.push(`SessionTokenUtilization ${e.sessionTokenUtilization}%`);
      if (e.sessionTokenSize !== undefined) size.push(`SessionTokenSize ${e.sessionTokenSize} B`);
    }
  }
  const message = r.ok ? "" : maskSensitive(r.message).slice(0, 120);

  rows.push([
    c.id,
    roleName(c.role),
    c.title,
    expectLabel(c.expect),
    outcomeLabel(outcome),
    verdict,
    probeCells.join("<br>") || "-",
    si,
    size.join(", ") || "-",
    message || "-",
  ]);
  console.error(`[${c.id}] ${verdict} ${outcomeLabel(outcome)}`);
}

console.log(
  maskSensitive(
    markdownTable(
      [
        "ID",
        "ロール",
        "内容",
        "期待",
        "実際",
        "判定",
        "API の確認",
        "SourceIdentity（応答）",
        "サイズ",
        "エラーの要約",
      ],
      rows,
    ),
  ),
);
console.log("");
console.log(
  `判定: FAIL ${failCount} 件（PASS = 期待どおり、INFO = 記録のみ）。` +
    "信頼ポリシーの拒否はどれも AccessDenied で理由は返らない。否定ケースは対照のケース（4〜8 は 1、9 は 10）と 1 点だけ違う。",
);
