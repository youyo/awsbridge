// PoC N6（K4）: CloudTrail（イベント履歴。LookupEvents）で KMS の Sign・DisableKey・EnableKey と
// AssumeRoleWithWebIdentity を読み、項目を平らにして出し、Sign と AssumeRoleWithWebIdentity を突き合わせる。
// 突き合わせ: Worker は RoleSessionName を kms-<KMS の RequestId> にする → Sign のイベントの requestID と一致するか。
// ほかに共通する項目（送信元 IP・時刻差・userAgent）も事実として並べる。値は伏せ字にする（アカウント ID・鍵 ID・email）。
// オプション: --since ISO（既定 2 時間前）、--until ISO（既定 いま）、--samples 2（種類ごとに出す生のイベントの数）
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { awsJson, loadSettings, stackOutputs } from "./io";
import { correlateTrail, keysFromOutputs, maskIds, matchJti, type TrailEvent } from "./ops";

const { values } = parseArgs({
  options: {
    since: { type: "string" },
    until: { type: "string" },
    samples: { type: "string", default: "2" },
  },
});
const s = loadSettings();
const since = values.since ?? new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const until = values.until ?? new Date().toISOString();
const outputs = stackOutputs(s);
const keyArns = new Set(keysFromOutputs(outputs).map((k) => k.keyId));
const roleArn = outputs.RoleArn;

function lookup(eventName: string): TrailEvent[] {
  const r = awsJson<{ Events: { CloudTrailEvent: string }[] }>(s, [
    "cloudtrail",
    "lookup-events",
    "--lookup-attributes",
    `AttributeKey=EventName,AttributeValue=${eventName}`,
    "--start-time",
    since,
    "--end-time",
    until,
  ]);
  return r.Events.map((e) => JSON.parse(e.CloudTrailEvent) as TrailEvent);
}

const ofOurKeys = (e: TrailEvent) => {
  const p = e.requestParameters ?? {};
  const res = (e.resources as { ARN?: string }[] | undefined)?.map((r) => r.ARN) ?? [];
  return keyArns.has(String(p.keyId)) || res.some((a) => a !== undefined && keyArns.has(a));
};

const signs = lookup("Sign").filter(ofOurKeys);
const disables = [...lookup("DisableKey"), ...lookup("EnableKey")].filter(ofOurKeys);
const assumes = lookup("AssumeRoleWithWebIdentity").filter(
  (e) => e.requestParameters?.roleArn === roleArn,
);

function flat(e: TrailEvent): Record<string, unknown> {
  const ui = (e.userIdentity ?? {}) as Record<string, unknown>;
  return {
    eventTime: e.eventTime,
    eventName: e.eventName,
    eventSource: e.eventSource,
    awsRegion: e.awsRegion,
    requestID: e.requestID,
    eventID: e.eventID,
    sourceIPAddress: e.sourceIPAddress,
    userAgent: e.userAgent,
    "userIdentity.type": ui.type,
    "userIdentity.arn": ui.arn,
    "userIdentity.userName": ui.userName,
    "userIdentity.principalId": ui.principalId,
    "userIdentity.identityProvider": ui.identityProvider,
    "userIdentity.accessKeyId": ui.accessKeyId,
    requestParameters: e.requestParameters,
    responseElements: e.responseElements,
    additionalEventData: e.additionalEventData,
    errorCode: e.errorCode,
    readOnly: e.readOnly,
    managementEvent: e.managementEvent,
    eventCategory: e.eventCategory,
    tlsDetails: e.tlsDetails,
  };
}

// responseElements（AssumeRoleWithWebIdentity）は認証情報の一部（accessKeyId・期限）を含む。キー名だけ出す
function safe(e: TrailEvent): Record<string, unknown> {
  const f = flat(e);
  if (e.eventName === "AssumeRoleWithWebIdentity" && f.responseElements)
    f.responseElements = { keys: Object.keys(f.responseElements as object) };
  return f;
}

const n = Number(values.samples);
console.log(`期間 ${since} 〜 ${until}（${s.region}）`);
console.log(
  `Sign ${signs.length} 件、DisableKey/EnableKey ${disables.length} 件、AssumeRoleWithWebIdentity ${assumes.length} 件（PoC の鍵・ロールのもの）`,
);
for (const [name, list] of [
  ["Sign", signs],
  ["DisableKey/EnableKey", disables],
  ["AssumeRoleWithWebIdentity", assumes],
] as const) {
  console.log(`\n## ${name}: 項目名（全イベントの和集合）`);
  console.log(`  ${[...new Set(list.flatMap((e) => Object.keys(e)))].sort().join(", ")}`);
  for (const e of list.slice(0, n)) console.log(maskIds(JSON.stringify(safe(e), null, 2)));
}
for (const e of disables)
  console.log(
    maskIds(
      `${e.eventTime} ${e.eventName} errorCode=${e.errorCode ?? "-"} requestID=${e.requestID}`,
    ),
  );

const pairs = correlateTrail(signs, assumes);
console.log("\n## 突き合わせ（RoleSessionName の kms-<RequestId> ↔ Sign の requestID）");
console.log("| AssumeRoleWithWebIdentity | Sign | 秒差 | 送信元 IP 一致 | アルゴリズム |");
console.log("|---|---|---|---|---|");
for (const p of pairs)
  console.log(
    `| ${p.assumeTime} | ${p.signTime ?? "（見つからない）"} | ${p.secondsBetween ?? "-"} | ${p.sameSourceIp ?? "-"} | ${p.signingAlgorithm ?? "-"} |`,
  );
const matched = pairs.filter((p) => p.signTime !== undefined).length;
console.log(
  `\n対になった ${matched} / ${pairs.length}（kms- の RoleSessionName の AssumeRoleWithWebIdentity）`,
);

// JWT の jti（Worker の記録 runs.jsonl）と AssumeRoleWithWebIdentity の webIdentityTokenId
const runsFile = join(s.outDir, "runs.jsonl");
if (existsSync(runsFile)) {
  const runs = readFileSync(runsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const m = matchJti(runs, assumes);
  console.log(
    `jti ↔ webIdentityTokenId: 一致 ${m.matched} / 不一致 ${m.mismatched} / 記録なし ${m.unknown}（${assumes.length} 件中）`,
  );
}
const failedSigns = signs.filter((e) => e.errorCode);
console.log(
  `失敗した Sign: ${failedSigns.length} 件（errorCode: ${[...new Set(failedSigns.map((e) => e.errorCode))].join(", ") || "-"}）`,
);
const failedAssumes = assumes.filter((e) => e.errorCode);
console.log(
  `失敗した AssumeRoleWithWebIdentity: ${failedAssumes.length} 件（errorCode: ${[...new Set(failedAssumes.map((e) => e.errorCode))].join(", ") || "-"}）`,
);
