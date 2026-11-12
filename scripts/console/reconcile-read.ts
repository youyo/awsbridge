// 突き合わせの道具の CloudTrail の読み取り: aws CLI の照会だけ（書き込みはしない）。
// 呼べるのは RECONCILE_READ_COMMANDS の 4 種類だけ（IAM の検査の READ_COMMANDS とは別の一覧。そちらには足さない）。
// aws CLI の呼び出しは AwsRun として差し替えられる（試験は材料の応答で動かし、実際の AWS に接続しない）。
// 有効な全リージョンを読む（cto の決裁 ★1）。読めなかったリージョンは unread に入れ、空の読み取りとして扱わない（判定で誤り）。
// 設計: docs/specs/console-login.md §5.6。
import { type AssumeEvent, parseAssumeEvent } from "../../src/console/reconcile-input";

/** aws CLI を `aws <args> --profile <p> --output json` で呼び、JSON を返す（失敗は例外）。 */
export type AwsRun = (args: string[]) => Promise<unknown>;

/** 使う照会の API（aws CLI の「サービス サブコマンド」）。これ以外は呼ばない。 */
export const RECONCILE_READ_COMMANDS = [
  "sts get-caller-identity",
  "account list-regions",
  "ec2 describe-regions",
  "cloudtrail lookup-events",
] as const;

/** 許可リストの外のコマンドを呼ばずに断る AwsRun にする。 */
export function guardRun(run: AwsRun): AwsRun {
  return (args) => {
    const cmd = `${args[0]} ${args[1]}`;
    if (!(RECONCILE_READ_COMMANDS as readonly string[]).includes(cmd))
      return Promise.reject(new Error(`aws ${cmd}: not allowed (reconcile reads only)`));
    return run(args);
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** グローバルの照会（STS・Account・EC2 のリージョン一覧）に渡すリージョン。 */
const HOME_REGION = "us-east-1";

/** プロファイルのアカウント（12 桁）。 */
export async function readCallerAccount(run: AwsRun): Promise<string> {
  const r = await run(["sts", "get-caller-identity", `--region=${HOME_REGION}`]);
  const id = isObj(r) ? r.Account : undefined;
  if (typeof id !== "string" || !/^\d{12}$/.test(id))
    throw new Error("unexpected response: sts get-caller-identity");
  return id;
}

function regionNames(r: unknown, where: string, keep: (o: Obj) => boolean): string[] {
  const list = isObj(r) ? r.Regions : undefined;
  if (!Array.isArray(list)) throw new Error(`unexpected response: ${where}`);
  const out: string[] = [];
  for (const x of list) {
    if (!isObj(x) || typeof x.RegionName !== "string" || !/^[a-z0-9-]+$/.test(x.RegionName))
      throw new Error(`unexpected response: ${where}.Regions[]`);
    if (keep(x)) out.push(x.RegionName);
  }
  return out.sort();
}

/**
 * 有効なリージョン（ENABLED・ENABLED_BY_DEFAULT）。account list-regions（account:ListRegions）を使い、
 * 使えなければ ec2 describe-regions（既定で有効なリージョンだけを返す。not-opted-in は除く）。どちらも駄目・空なら例外。
 */
export async function readEnabledRegions(run: AwsRun): Promise<string[]> {
  let regions: string[];
  try {
    regions = regionNames(
      await run([
        "account",
        "list-regions",
        `--region=${HOME_REGION}`,
        "--region-opt-status-contains",
        "ENABLED",
        "ENABLED_BY_DEFAULT",
      ]),
      "account list-regions",
      (o) => o.RegionOptStatus === undefined || /^ENABLED/.test(String(o.RegionOptStatus)),
    );
  } catch {
    try {
      regions = regionNames(
        await run(["ec2", "describe-regions", `--region=${HOME_REGION}`]),
        "ec2 describe-regions",
        (o) => o.OptInStatus !== "not-opted-in",
      );
    } catch {
      throw new Error(
        "could not list the enabled regions (account list-regions / ec2 describe-regions)",
      );
    }
  }
  if (regions.length === 0) throw new Error("no enabled regions in the response");
  return regions;
}

export type AssumeRead = { events: AssumeEvent[]; read: string[]; unread: string[] };

/** リージョンごとに AssumeRoleWithWebIdentity を読む（CLI の自動ページング。待ちと再試行は CLI に任せる）。 */
export async function readAssumeEvents(
  run: AwsRun,
  regions: readonly string[],
  window: { since: number; until: number },
): Promise<AssumeRead> {
  const out: AssumeRead = { events: [], read: [], unread: [] };
  for (const region of regions) {
    try {
      const r = await run([
        "cloudtrail",
        "lookup-events",
        `--region=${region}`,
        "--lookup-attributes",
        "AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity",
        "--start-time",
        new Date(window.since).toISOString(),
        "--end-time",
        new Date(window.until).toISOString(),
      ]);
      const list = isObj(r) ? r.Events : undefined;
      if (!Array.isArray(list)) throw new Error("unexpected response: lookup-events");
      const events = list.map((e) => parseAssumeEvent(isObj(e) ? e.CloudTrailEvent : undefined));
      out.events.push(...events);
      out.read.push(region);
    } catch {
      out.unread.push(region);
    }
  }
  return out;
}
