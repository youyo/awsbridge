import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { buildSessionName } from "../../src/oidc";
import { parseStsResponse } from "../../src/sts-xml";
import { envOr, requireEnv } from "./env";
import { mintToken } from "./token";

const { values } = parseArgs({ options: { "role-arn": { type: "string" } } });
const subject = requireEnv("AWSBRIDGE_POC_SUBJECT");

// --role-arn が無ければ CloudFormation スタックの Output RoleArn を使う
function roleArnFromStack(): string {
  const stack = envOr("AWSBRIDGE_STACK_NAME", "awsbridge");
  return execFileSync(
    "aws",
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stack,
      "--query",
      "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue",
      "--output",
      "text",
    ],
    { encoding: "utf8", env: { ...process.env, AWS_PROFILE: envOr("AWS_PROFILE", "awsbridge") } },
  ).trim();
}
const roleArn = values["role-arn"] ?? roleArnFromStack();

async function assume(token: string) {
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: buildSessionName("gw-", subject, ""),
    WebIdentityToken: token,
    DurationSeconds: "900",
  });
  const res = await fetch("https://sts.amazonaws.com/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, parsed: parseStsResponse(await res.text()) };
}

const cases = [
  { name: "正常", expectOk: true, opts: {} },
  { name: "aud 違い", expectOk: false, opts: { aud: "wrong-audience" } },
  { name: "期限切れ", expectOk: false, opts: { expOffset: -3600 } },
  { name: "別鍵", expectOk: false, opts: { otherKey: true } },
  // 信頼ポリシーの sub 条件が効いていること（署名・aud は正しいが許可されていない利用者）
  { name: "sub 違い", expectOk: false, opts: { sub: "not-allowed@invalid.example" } },
];

let failed = false;
for (const c of cases) {
  const { status, parsed } = await assume(await mintToken(c.opts));
  const pass = parsed.ok === c.expectOk;
  if (!pass) failed = true;
  const detail = parsed.ok
    ? `Arn=${parsed.assumedRoleArn} Credentials=${parsed.hasCredentials ? "あり" : "なし"}`
    : `Code=${parsed.code} Message=${parsed.message}`;
  console.log(
    `[${pass ? "OK" : "NG"}] ${c.name} (期待: ${c.expectOk ? "成功" : "拒否"}) HTTP ${status} ${detail}`,
  );
}
process.exit(failed ? 1 : 0);
