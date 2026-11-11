// N9（パス付き issuer）: 手元の鍵で JWT を署名し、STS AssumeRoleWithWebIdentity（署名なし）をケースごとに呼んで表を出す。
// Access を使わないので、Access アプリを作る前（Worker と deploy-aws だけ）でも、作ったあと（Bypass 越し）でも流せる。
// 認証情報はどこにも書かない。email・アカウント ID は伏せて出す。
// オプション: --only 1,3,8（ケースを絞る）
import { parseArgs } from "node:util";
import { parseAssumeRoleResponse, parseStsError } from "../../../../src/sts-xml";
import { expectLabel, judge, markdownTable, type Outcome, outcomeLabel } from "../cases";
import { fail, readKey, required } from "../io";
import {
  assumeRoleWithWebIdentityParams,
  humanSessionName,
  parseStsExtras,
  stsEndpoint,
  summarizeBody,
} from "../lib";
import { maskSensitive } from "../ops";
import { loadSettings, localOverride, tryStackOutputs } from "./io";
import { assertPortalRoleArn, issuerFor, providerIdOf, signPortalToken } from "./lib";
import { n9Cases, n9Issuer, n9RoleOutputKey } from "./n9-cases";
import { BASE_VARS } from "./settings";

let only: string | undefined;
try {
  only = parseArgs({ options: { only: { type: "string" } } }).values.only;
} catch (e) {
  fail((e as Error).message);
}
const s = loadSettings();
const base = required(s.base, BASE_VARS);
const all = n9Cases();
const ids = only === undefined ? all.map((c) => c.id) : only.split(",").map((x) => x.trim());
const unknown = ids.filter((id) => !all.some((c) => c.id === id));
if (unknown.length > 0) fail(`--only に知らないケースがあります: ${unknown.join(",")}`);
const cases = all.filter((c) => ids.includes(c.id));

const keys = { std: readKey(s.stdKeyFile), admin: readKey(s.adminKeyFile) };
const outputs = tryStackOutputs(s);
if (!outputs)
  fail(
    `スタック ${s.stackName} の Outputs を読めません（先に mise run poc:human:portal:deploy-aws）`,
  );
const endpoint = localOverride("AWSBRIDGE_HUMAN_POC_PORTAL_STS_ENDPOINT") ?? stsEndpoint(s.region);

console.error(
  `issuer: std=${providerIdOf(issuerFor(base, "std"))} admin=${providerIdOf(issuerFor(base, "admin"))}（IAM の条件キーは <host>/<path>:aud）`,
);
const rows: string[][] = [];
let failCount = 0;
for (const c of cases) {
  const roleArn = outputs[n9RoleOutputKey(c.role)] ?? "";
  try {
    assertPortalRoleArn(roleArn);
  } catch (e) {
    fail(`${(e as Error).message}（スタックの Output ${n9RoleOutputKey(c.role)}）`);
  }
  const token = await signPortalToken({
    privateJwk: keys[c.signWith],
    issuer: n9Issuer(base, c.issuer),
    audience: s.audience,
    subject: s.subject,
    team: c.team,
    ...(c.sourceIdentity ? { sourceIdentity: s.subject } : {}),
  });
  let status = 0;
  let xml = "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: assumeRoleWithWebIdentityParams({
        roleArn,
        roleSessionName: humanSessionName(s.subject),
        webIdentityToken: token,
      }),
    });
    status = res.status;
    xml = await res.text();
  } catch (e) {
    xml = (e as Error).message;
  }
  const creds = status === 200 ? parseAssumeRoleResponse(xml) : undefined;
  const err = creds ? undefined : parseStsError(xml);
  const outcome: Outcome = creds
    ? { ok: true }
    : { ok: false, code: err?.code ?? (status ? `HTTP ${status}` : "NetworkError") };
  const verdict = judge(c.expect, outcome);
  if (verdict === "FAIL") failCount++;
  const si = creds
    ? parseStsExtras(xml).sourceIdentity === s.subject
      ? "subject と一致"
      : "なし・不一致"
    : "-";
  rows.push([
    c.id,
    roleArn.split("/").pop() ?? "",
    c.title,
    expectLabel(c.expect),
    outcomeLabel(outcome),
    verdict,
    si,
    creds ? "-" : summarizeBody(err?.message ?? xml, [token], 120) || "-",
  ]);
  console.error(`[${c.id}] ${verdict} ${outcomeLabel(outcome)}`);
}

console.log(
  maskSensitive(
    markdownTable(
      ["ID", "ロール", "内容", "期待", "実際", "判定", "SourceIdentity（応答）", "エラーの要約"],
      rows,
    ),
  ),
);
console.log("");
console.log(
  `判定: FAIL ${failCount} 件（PASS = 期待どおり、INFO = 記録のみ）。3・4 は 1・2 とロールだけ、5 は 2 と鍵だけ、` +
    "6・7 は 1 と iss だけ、8 は 9 とチームだけ、10 は 1 と SI だけ違う。",
);
