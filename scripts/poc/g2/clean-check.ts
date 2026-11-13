// G2 の片付けの確認（mise タスク poc:g2:clean-check）。手順書 §4.2。読み取りだけ（aws は照会、Cloudflare は GET）。
//   pnpm tsx scripts/poc/g2/clean-check.ts --profile <AWS のプロファイル（P-RO）> [--role <名前> ...] [--stack <名前> ...]
//     [--baseline <§2.1 で取った list-open-id-connect-providers の JSON>]
// AWS: パス /awsbridge-console/・/awsbridge-g2-ctrl/・/awsbridge-g2-probe/ のロール、名前のロール（既定は手順書 §1.3 の 4 つ）、
//      試験の名前（ポータル・issuer・試験用の issuer のホスト）の OIDC プロバイダーとベースラインとの差、
//      パス /awsbridge-console/・/awsbridge-g2-ctrl/ の管理ポリシー、指定のスタック。
// Cloudflare（AWSBRIDGE_G2_CF_ACCOUNT_ID と AWSBRIDGE_G2_CF_READ_TOKEN があるとき。無ければ SKIP）:
//      Worker（awsbridge-console-*・awsbridge-g2-*）、Custom Domain、Access アプリ（試験の名前のホスト）。
// 終了コード: 0 残っていない（SKIP を含む）/ 1 残っている・読めない。手で見るもの（IAM の全体の前後比較・DNS・Access のポリシー・
// サービストークン・IdP・API トークン・secrets:scan）は最後に一覧で出す。

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { awsRunner } from "../../console/aws-cli";
import { apiBaseFromVar } from "../../console/key-tool-common";
import { fail } from "../human/io";
import {
  type CfGet,
  CLEAN_CHECK_AWS_COMMANDS,
  DEFAULT_ROLE_NAMES,
  formatCleanCheck,
  runCleanCheck,
} from "./clean-check-lib";

let values: Record<string, string | string[] | undefined>;
try {
  values = parseArgs({
    options: {
      profile: { type: "string" },
      role: { type: "string", multiple: true },
      stack: { type: "string", multiple: true },
      baseline: { type: "string" },
    },
  }).values as Record<string, string | string[] | undefined>;
} catch (e) {
  fail((e as Error).message);
}
const profile =
  typeof values.profile === "string" ? values.profile : fail("--profile を指定してください");
if (!/^[\w.+@][\w.+@-]{0,63}$/.test(profile)) fail(`不正なプロファイル名: '${profile}'`);
const NAME_RE = /^[A-Za-z0-9][\w+=,.@-]{0,127}$/;
const roleNames = (values.role as string[] | undefined) ?? DEFAULT_ROLE_NAMES;
const stacks = (values.stack as string[] | undefined) ?? [];
for (const n of [...roleNames, ...stacks]) if (!NAME_RE.test(n)) fail(`不正な名前: '${n}'`);

let baselineProviders: string[] | undefined;
if (typeof values.baseline === "string") {
  try {
    const v = JSON.parse(readFileSync(values.baseline, "utf8")) as {
      OpenIDConnectProviderList?: { Arn?: string }[];
    };
    baselineProviders = (v.OpenIDConnectProviderList ?? []).map((p) => String(p.Arn));
  } catch {
    fail("--baseline は aws iam list-open-id-connect-providers の出力（JSON）");
  }
}

const cfAccount = process.env.AWSBRIDGE_G2_CF_ACCOUNT_ID ?? "";
const cfToken = process.env.AWSBRIDGE_G2_CF_READ_TOKEN ?? "";
let cf: CfGet | undefined;
if (cfAccount !== "" && cfToken !== "") {
  if (!/^[0-9a-f]{32}$/.test(cfAccount)) fail("AWSBRIDGE_G2_CF_ACCOUNT_ID は 32 桁の 16 進");
  let base: string;
  try {
    const v = apiBaseFromVar(process.env, "AWSBRIDGE_G2_CF_API_BASE");
    base = v.startsWith("http://127.0.0.1:") ? `${v}/client/v4` : v;
  } catch (e) {
    fail((e as Error).message);
  }
  cf = async (path) => {
    const res = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${cfToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {}
    return { status: res.status, json };
  };
}

const results = await runCleanCheck(
  { aws: awsRunner(profile, CLEAN_CHECK_AWS_COMMANDS), cf },
  { roleNames, stacks, baselineProviders, cfAccountId: cfAccount },
);
console.log(formatCleanCheck(results));
console.log("");
console.log(
  "手で見るもの（§4.2）: get-account-authorization-details のベースラインとの比較、開発ゾーンの DNS レコード、Access のポリシー・サービストークン・IdP、Cloudflare の API トークン、mise run secrets:scan",
);
const bad = results.filter((r) => r.status === "NG" || r.status === "ERR");
console.log(
  bad.length === 0
    ? "[OK] 道具で見た範囲では残っていない"
    : `[NG] 残っている・読めないもの: ${bad.length}`,
);
process.exitCode = bad.length === 0 ? 0 : 1;
