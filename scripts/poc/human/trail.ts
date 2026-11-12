// PoC P2・P3 の CloudTrail 確認: 直近の AssumeRoleWithWebIdentity（PoC のロールだけ）の SourceIdentity・セッションタグと、
// そのセッション（アクセスキー ID）の API イベントの userIdentity.sessionContext.sourceIdentity を表で出す。
// email・アカウント ID は伏せ、アクセスキー ID は末尾 4 文字だけ出す。CloudTrail の反映には数分〜15 分かかる。
// STS のイベントは呼んだリージョン（regional endpoint）に、IAM などグローバルなサービスのイベントは us-east-1 に残る。
//
// オプション:
//   --minutes <分>        何分前から引くか（既定 60）
//   --regions <一覧>      引くリージョン（既定 AWS_REGION と us-east-1）
//   --max-events <数>     出す AssumeRoleWithWebIdentity の数（既定 20、新しい順）
//   --follow <数>         アクセスキーごとに出す API イベントの数（既定 10。セッション名ごとはその 5 倍。0 なら追わない）
//   --signin              代わりに aws login のイベント（eventSource signin.amazonaws.com の *OAuth2*）を新しい順に出す。
//                         項目を決め打ちせず「パス = 値」に平らにする（remote と localhost を見分けるフィールドを探すため）。
//                         トークン・認可コード・state・PKCE の値は <redacted>、送信元 IP は下位を伏せる。
//                         既定は PoC のロールのセッション（と主体の無いイベント）だけ。--all-principals でほかの主体も出す
import { parseArgs } from "node:util";
import { adminEnv, fail, runAws } from "./io";
import { humanPocSettings } from "./lib";
import { maskSensitive } from "./ops";
import {
  type ApiRow,
  type AssumeRow,
  apiEventRow,
  assumeEventRow,
  formatApiRows,
  formatAssumeRows,
  formatSigninEvents,
  isPocSessionEvent,
  isPocSigninEvent,
  parseLookupEvents,
  shortKey,
} from "./trail-lib";

let values: ReturnType<typeof parse>["values"];
function parse() {
  return parseArgs({
    options: {
      minutes: { type: "string", default: "60" },
      regions: { type: "string" },
      "max-events": { type: "string", default: "20" },
      follow: { type: "string", default: "10" },
      signin: { type: "boolean", default: false },
      "all-principals": { type: "boolean", default: false },
    },
  });
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

const intOpt = (name: string, v: string | undefined, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} は ${min}〜${max} の整数`);
  return n;
};
const minutes = intOpt("minutes", values.minutes, 1, 60 * 24 * 90);
const maxEvents = intOpt("max-events", values["max-events"], 1, 200);
const follow = intOpt("follow", values.follow, 0, 100);
const regions = [
  ...new Set(
    (values.regions ?? `${settings.region},us-east-1`)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
for (const r of regions)
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(r)) fail(`--regions に不正なリージョン: '${r}'`);
const startTime = new Date(Date.now() - minutes * 60_000).toISOString();

async function lookup(region: string, key: string, value: string, maxItems: number) {
  const r = await runAws(
    [
      "cloudtrail",
      "lookup-events",
      "--region",
      region,
      "--lookup-attributes",
      `AttributeKey=${key},AttributeValue=${value}`,
      "--start-time",
      startTime,
      "--max-items",
      String(maxItems),
      "--output",
      "json",
    ],
    adminEnv(settings),
  );
  if (r.code !== 0) {
    console.error(
      `[警告] lookup-events（${region}、${key}）が失敗しました: ${r.stderr.trim().slice(0, 200)}`,
    );
    return [];
  }
  try {
    return parseLookupEvents(r.stdout);
  } catch {
    console.error(`[警告] lookup-events（${region}）の出力を解釈できません`);
    return [];
  }
}

console.log(
  `CloudTrail: ${startTime} 以降、リージョン ${regions.join(", ")}（反映には数分〜15 分かかる）`,
);

if (values.signin) {
  const events = (
    await Promise.all(regions.map((r) => lookup(r, "EventSource", "signin.amazonaws.com", 200)))
  )
    .flat()
    .filter((e) => /OAuth2/.test(String(e?.eventName ?? "")))
    .filter((e) => values["all-principals"] || isPocSigninEvent(e))
    .sort((a, b) => String(b?.eventTime ?? "").localeCompare(String(a?.eventTime ?? "")))
    .slice(0, maxEvents);
  console.log("");
  console.log(`## aws login のイベント（signin.amazonaws.com、新しい順に ${events.length} 件）`);
  console.log(events.length === 0 ? "（無い。反映を待つ）" : formatSigninEvents(events));
  process.exit(0);
}

const assumes: AssumeRow[] = (
  await Promise.all(regions.map((r) => lookup(r, "EventName", "AssumeRoleWithWebIdentity", 200)))
)
  .flat()
  .filter((e) => e?.eventName === "AssumeRoleWithWebIdentity")
  .map(assumeEventRow)
  .filter((r): r is AssumeRow => r !== undefined)
  .sort((a, b) => b.time.localeCompare(a.time))
  .slice(0, maxEvents);

console.log("");
console.log(`## AssumeRoleWithWebIdentity（PoC のロール、新しい順に ${assumes.length} 件）`);
console.log(formatAssumeRows(assumes));

if (follow > 0) {
  for (const a of assumes) {
    if (!a.accessKeyId) continue;
    const akid = a.accessKeyId;
    const rows: ApiRow[] = (
      await Promise.all(regions.map((r) => lookup(r, "AccessKeyId", akid, follow)))
    )
      .flat()
      .filter(
        (e) =>
          e?.userIdentity?.accessKeyId === akid && e?.eventName !== "AssumeRoleWithWebIdentity",
      )
      .map(apiEventRow)
      .sort((x, y) => x.time.localeCompare(y.time))
      .slice(0, follow);
    console.log("");
    console.log(
      `## セッション ${shortKey(akid)}（${a.role}、${a.time}）の API イベント ${rows.length} 件`,
    );
    console.log(
      rows.length === 0
        ? "（まだ無い。反映を待つか、そのセッションで API を呼ぶ）"
        : formatApiRows(rows),
    );
  }

  // コンソールと aws login のセッションは、引き受けの時とは別のアクセスキーで API を呼ぶ見込み。
  // そのため、セッション名（Username）でも引き、PoC のロールのセッションの API イベントをキーごとに出す。
  // Username が assumed-role のセッション名に当たるかは初回の実行で確かめる（README 参照）。
  const sessionNames = [...new Set(assumes.filter((a) => a.accessKeyId).map((a) => a.sessionName))];
  for (const name of sessionNames) {
    if (name === "") continue;
    const rows: ApiRow[] = (
      await Promise.all(regions.map((r) => lookup(r, "Username", name, follow * 5)))
    )
      .flat()
      .filter(isPocSessionEvent)
      .map(apiEventRow)
      .sort((x, y) => x.time.localeCompare(y.time))
      .slice(-follow * 5);
    console.log("");
    console.log(
      maskSensitive(
        `## セッション名 ${name} の API イベント ${rows.length} 件（Username で引いた。全アクセスキー。キーの列でコンソール・aws login を見分ける）`,
      ),
    );
    console.log(
      rows.length === 0
        ? "（無い。反映を待つか、Username がセッション名に当たらない可能性がある）"
        : formatApiRows(rows),
    );
  }
}
