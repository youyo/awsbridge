// (4-a) CloudFormation の外で付けたインラインポリシー（revoke.ts の AWSRevokeOlderSessions・AwsbridgeDenySourceIdentity）が、
// スタックの更新（deploy-aws。AWSBRIDGE_HUMAN_POC_UPDATE_MARKER を変えると Tagged の CFN 管理のポリシーが変わる）のあとも
// 残るか、ドリフト検出でどう見えるかを記録する。読み取りとドリフト検出だけで、IAM は変えない。
//
//   inline   スタックの全ロール（Output の RoleArn / TaggedRoleArn / NoTagRoleArn / LocalOnlyRoleArn / ViewerRoleArn）のインラインポリシー名を出し、
//            --role のロールに --expect のポリシーが残っているかを判定する
//   drift    detect-stack-drift → 完了を待つ → リソースごとの状態と差分の場所・種類（とポリシー名）を出す。値は出さない
//
// オプション:
//   --role base|tagged|notag|localonly|viewer   inline の判定の対象（既定 tagged）
//   --expect <名前,名前>                 inline で残っているはずのポリシー（既定 AWSRevokeOlderSessions,AwsbridgeDenySourceIdentity。空で判定なし）
//   --poll-seconds <秒>                  drift の完了を待つ間隔（既定 5）
//   --max-wait <秒>                      drift の完了を待つ上限（既定 300）
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { adminEnv, fail, stackOutputs } from "./io";
import { humanPocSettings, isRoleKey, ROLE_KEYS, type RoleKey, roleOutputKey } from "./lib";
import {
  assertPocRoleArn,
  assertPocStackName,
  DENY_SOURCE_IDENTITY_POLICY_NAME,
  REVOKE_POLICY_NAME,
} from "./ops";
import {
  formatDriftReport,
  formatInlinePolicyReport,
  inlinePolicyReport,
  parseDriftDetection,
  parseResourceDrifts,
  parseRolePolicyNames,
  type RoleInlinePolicies,
} from "./persist-lib";

const COMMANDS = ["inline", "drift"] as const;

let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      role: { type: "string", default: "tagged" },
      expect: {
        type: "string",
        default: `${REVOKE_POLICY_NAME},${DENY_SOURCE_IDENTITY_POLICY_NAME}`,
      },
      "poll-seconds": { type: "string", default: "5" },
      "max-wait": { type: "string", default: "300" },
    },
  });
}
try {
  parsed = parse();
} catch (e) {
  fail((e as Error).message);
}
const command = parsed.positionals[0] ?? "";
if (!(COMMANDS as readonly string[]).includes(command) || parsed.positionals.length !== 1)
  fail(
    `使い方: persist.ts <${COMMANDS.join("|")}> [--role ${ROLE_KEYS.join("|")}] [--expect 名前,名前] [--poll-seconds 5]`,
  );
const target = parsed.values.role ?? "tagged";
if (!isRoleKey(target)) fail(`--role は ${ROLE_KEYS.join(" / ")}`);
const expected = (parsed.values.expect ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x !== "");
for (const name of expected)
  if (!/^[\w+=,.@-]{1,128}$/.test(name)) fail(`--expect のポリシー名が不正です: '${name}'`);
const pollSeconds = Number(parsed.values["poll-seconds"]);
const maxWait = Number(parsed.values["max-wait"]);
if (!Number.isFinite(pollSeconds) || pollSeconds < 0) fail("--poll-seconds は 0 以上の秒数");
if (!Number.isFinite(maxWait) || maxWait <= 0) fail("--max-wait は正の秒数");

let settings: ReturnType<typeof humanPocSettings>;
try {
  settings = humanPocSettings(process.env);
  assertPocStackName(settings.stackName);
} catch (e) {
  fail((e as Error).message);
}

function awsJson(args: string[]): string {
  try {
    return execFileSync("aws", [...args, "--output", "json"], {
      encoding: "utf8",
      env: adminEnv(settings),
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    fail(`aws ${args.slice(0, 2).join(" ")} が失敗しました`);
  }
}

if (command === "inline") {
  const outputs = stackOutputs(settings);
  // 先に全ロールが PoC 用であることを確かめてから一覧を取る
  const roles: { role: RoleKey; roleName: string }[] = [];
  for (const r of ROLE_KEYS) {
    const arn = outputs[roleOutputKey(r)];
    if (arn === undefined) continue;
    try {
      roles.push({ role: r, roleName: assertPocRoleArn(arn) });
    } catch (e) {
      fail((e as Error).message);
    }
  }
  if (roles.length === 0)
    fail(`スタック ${settings.stackName} の Output にロールがありません（先に deploy-aws）`);
  const rows: RoleInlinePolicies[] = roles.map(({ role, roleName }) => {
    let names: string[];
    try {
      names = parseRolePolicyNames(awsJson(["iam", "list-role-policies", "--role-name", roleName]));
    } catch {
      fail(`list-role-policies の出力を解釈できません（${roleName}）`);
    }
    return { role, roleName, policyNames: names };
  });
  console.log(`時刻: ${new Date().toISOString()}  スタック ${settings.stackName}`);
  console.log(formatInlinePolicyReport(inlinePolicyReport(rows, expected, target)));
} else {
  let id: string;
  try {
    const v = JSON.parse(
      awsJson(["cloudformation", "detect-stack-drift", "--stack-name", settings.stackName]),
    ) as { StackDriftDetectionId?: unknown };
    if (typeof v.StackDriftDetectionId !== "string") throw new Error("no id");
    id = v.StackDriftDetectionId;
  } catch {
    fail("detect-stack-drift の出力を解釈できません");
  }
  const started = Date.now();
  let detection: ReturnType<typeof parseDriftDetection>;
  for (;;) {
    try {
      detection = parseDriftDetection(
        awsJson([
          "cloudformation",
          "describe-stack-drift-detection-status",
          "--stack-drift-detection-id",
          id,
        ]),
      );
    } catch {
      fail("describe-stack-drift-detection-status の出力を解釈できません");
    }
    if (detection.status !== "DETECTION_IN_PROGRESS") break;
    if (Date.now() - started > maxWait * 1000)
      fail(`ドリフト検出が ${maxWait} 秒で終わりませんでした`);
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
  if (detection.status !== "DETECTION_COMPLETE")
    fail(`ドリフト検出が失敗しました: ${detection.status} ${detection.reason ?? ""}`);
  let rows: ReturnType<typeof parseResourceDrifts>;
  try {
    rows = parseResourceDrifts(
      awsJson([
        "cloudformation",
        "describe-stack-resource-drifts",
        "--stack-name",
        settings.stackName,
      ]),
    );
  } catch {
    fail("describe-stack-resource-drifts の出力を解釈できません");
  }
  console.log(`時刻: ${new Date().toISOString()}  スタック ${settings.stackName}`);
  console.log(formatDriftReport(detection, rows));
}
