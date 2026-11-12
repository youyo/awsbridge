// PoC P4（緊急停止）の操作。PoC 用の名前のロール・OIDC プロバイダーにしか効かない（ガードあり）。
//   revoke             ロールに AWSRevokeOlderSessions 相当のインラインポリシーを付ける（コンソールの Revoke sessions と同じ考え方）
//   unrevoke           そのインラインポリシーを外す
//   delete-provider    PoC の OIDC プロバイダーを消す（CloudFormation の外での操作。スタックとずれる）
//   recreate-provider  同じ URL・client ID・タグで OIDC プロバイダーを作り直す（ARN が同じになるのでロールの信頼ポリシーはそのまま）
//   deny-si            (4-b) ロールに AwsbridgeDenySourceIdentity（aws:SourceIdentity が 1 人の利用者と一致するセッションの全操作を Deny）を付ける
//   undeny-si          そのインラインポリシーを外す
// 操作が返った時刻（UTC）を出す。stop-watch の --since に渡して、止まるまでの秒数を測る。
//
// オプション:
//   --role base|tagged|notag|localonly|viewer   revoke / unrevoke / deny-si / undeny-si の対象（既定 tagged）
//   --future-seconds <秒>      revoke の基準時刻を今から何秒先にするか（既定 30。コンソールと同じく伝播の遅れを見込む）
//   --who primary|second       deny-si で止める利用者（既定 primary = AWSBRIDGE_HUMAN_POC_SUBJECT、
//                              second = AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT）。SourceIdentity は subject と同じ値
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { adminEnv, fail, roleArnOf, stackOutputs } from "./io";
import {
  humanPocSettings,
  isRoleKey,
  issuerHost,
  isWho,
  ROLE_KEYS,
  type RoleKey,
  subjectFor,
} from "./lib";
import {
  assertPocProviderArn,
  assertPocRoleArn,
  assertPocStackName,
  DENY_SOURCE_IDENTITY_POLICY_NAME,
  denySourceIdentityPolicyDocument,
  maskSensitive,
  REVOKE_POLICY_NAME,
  revokeCutoff,
  revokePolicyDocument,
} from "./ops";

const COMMANDS = [
  "revoke",
  "unrevoke",
  "delete-provider",
  "recreate-provider",
  "deny-si",
  "undeny-si",
] as const;

let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      role: { type: "string", default: "tagged" },
      "future-seconds": { type: "string", default: "30" },
      who: { type: "string", default: "primary" },
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
    `使い方: revoke.ts <${COMMANDS.join("|")}> [--role ${ROLE_KEYS.join("|")}] [--future-seconds 30] [--who primary|second]`,
  );
const role = parsed.values.role ?? "tagged";
if (!isRoleKey(role)) fail(`--role は ${ROLE_KEYS.join(" / ")}`);
const who = parsed.values.who ?? "primary";
if (!isWho(who)) fail("--who は primary か second");
const futureSeconds = Number(parsed.values["future-seconds"]);

let settings: ReturnType<typeof humanPocSettings>;
try {
  settings = humanPocSettings(process.env);
  assertPocStackName(settings.stackName);
} catch (e) {
  fail((e as Error).message);
}

// deny-si は止める利用者と文書を aws を呼ぶ前に決める（未設定・2 人目が 1 人目と同じなら何も呼ばずに止まる）
let denyDocument = "";
if (command === "deny-si") {
  try {
    denyDocument = denySourceIdentityPolicyDocument([subjectFor(settings, who)]);
  } catch (e) {
    fail(`${(e as Error).message}（mise.local.toml を確認してください）`);
  }
}

function aws(args: string[]): void {
  try {
    execFileSync("aws", args, { env: adminEnv(settings), stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    fail(`aws ${args.slice(0, 2).join(" ")} が失敗しました`);
  }
}

const now = () => new Date().toISOString();
const outputs = stackOutputs(settings);

function pocRoleName(r: RoleKey): string {
  try {
    return assertPocRoleArn(roleArnOf(outputs, r, settings.stackName));
  } catch (e) {
    fail((e as Error).message);
  }
}

if (command === "revoke") {
  const roleName = pocRoleName(role);
  let cutoff: Date;
  try {
    cutoff = revokeCutoff(new Date(), futureSeconds);
  } catch (e) {
    fail(`--future-seconds が不正です: ${(e as Error).message}`);
  }
  console.log(
    `開始: ${now()}  ロール ${roleName} に ${REVOKE_POLICY_NAME} を付けます（基準 ${cutoff.toISOString()}）`,
  );
  aws([
    "iam",
    "put-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    REVOKE_POLICY_NAME,
    "--policy-document",
    revokePolicyDocument(cutoff),
  ]);
  console.log(`完了: ${now()}（stop-watch の --since にこの時刻を渡す）`);
  console.log(
    `aws:TokenIssueTime < ${cutoff.toISOString()} の一時認証情報は全操作が Deny になる（伝播に数秒〜数十秒）`,
  );
} else if (command === "unrevoke") {
  const roleName = pocRoleName(role);
  console.log(`開始: ${now()}  ロール ${roleName} から ${REVOKE_POLICY_NAME} を外します`);
  aws(["iam", "delete-role-policy", "--role-name", roleName, "--policy-name", REVOKE_POLICY_NAME]);
  console.log(`完了: ${now()}`);
} else if (command === "deny-si") {
  const roleName = pocRoleName(role);
  // 標準出力は README に貼れるよう email を伏せる
  console.log(
    maskSensitive(
      `開始: ${now()}  ロール ${roleName} に ${DENY_SOURCE_IDENTITY_POLICY_NAME}（${who} の SourceIdentity を Deny）を付けます`,
    ),
  );
  aws([
    "iam",
    "put-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    DENY_SOURCE_IDENTITY_POLICY_NAME,
    "--policy-document",
    denyDocument,
  ]);
  console.log(`完了: ${now()}（stop-watch の --since にこの時刻を渡す）`);
  console.log(
    `aws:SourceIdentity が ${who} の利用者と一致するセッションは、発行時刻に関係なく全操作が Deny になる（伝播に数秒〜数十秒）。` +
      "新しい引き受け自体は止まらない（引き受けたあとの API が拒否される）",
  );
} else if (command === "undeny-si") {
  const roleName = pocRoleName(role);
  console.log(
    `開始: ${now()}  ロール ${roleName} から ${DENY_SOURCE_IDENTITY_POLICY_NAME} を外します`,
  );
  aws([
    "iam",
    "delete-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    DENY_SOURCE_IDENTITY_POLICY_NAME,
  ]);
  console.log(`完了: ${now()}（stop-watch の --since にこの時刻を渡して、戻るまでの秒数を見る）`);
} else {
  if (!settings.issuer)
    fail("AWSBRIDGE_HUMAN_POC_ISSUER が未設定です。mise.local.toml に設定してください。");
  const host = issuerHost(settings.issuer);
  // スタックの Output（OidcProviderArn）が PoC の issuer のものであることを確かめてから触る
  let arn: string;
  try {
    arn = assertPocProviderArn(outputs.OidcProviderArn ?? "", host);
  } catch (e) {
    fail((e as Error).message);
  }
  if (command === "delete-provider") {
    console.log(`開始: ${now()}  OIDC プロバイダー（issuer ${host}）を消します`);
    aws(["iam", "delete-open-id-connect-provider", "--open-id-connect-provider-arn", arn]);
    console.log(`完了: ${now()}（stop-watch の --since にこの時刻を渡す）`);
    console.log("戻すときは mise run poc:human:recreate-provider（deploy-aws では作り直されない）");
  } else {
    console.log(
      `開始: ${now()}  OIDC プロバイダー（issuer ${host}、client ID ${settings.audience}）を作り直します`,
    );
    aws([
      "iam",
      "create-open-id-connect-provider",
      "--url",
      `https://${host}`,
      "--client-id-list",
      settings.audience,
      "--tags",
      "Key=project,Value=awsbridge-human-poc",
    ]);
    console.log(`完了: ${now()}`);
  }
}
