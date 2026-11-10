// PoC-A（人間のログイン）: 手元で署名した JWT → STS AssumeRoleWithWebIdentity（署名なし。長期認証情報は使わない）
// → Federation エンドポイントの getSigninToken（SessionDuration なし・あり）→ コンソールのログイン URL。
// URL と認証情報は機密なので標準出力に出さず、権限 600 で AWSBRIDGE_HUMAN_POC_OUT_DIR（既定 .secrets/poc-human/）に書く。
// URL のファイル名は console-url-dur-<DurationSeconds|default>-sd-<SessionDuration|none>.txt。失敗した条件のファイルは消す。
// 標準出力には各段の成否（HTTP ステータス・エラーの要約・Expiration）とファイルのパスだけを出す。
//
// オプション:
//   --role-arn <arn>              省略時は PoC スタックの Output RoleArn（aws cloudformation describe-stacks）
//   --duration-seconds <秒>       STS の DurationSeconds（省略時は送らない = STS の既定 3600 秒）
//   --session-durations <一覧>    getSigninToken の SessionDuration（既定 none,43200,43199。none は付けない）
//   --federation-method get|post  getSigninToken の HTTP メソッド（既定 get。AWS の文書は SessionDuration の説明を GET 前提で書いている）
//   --role base|tagged|notag      引き受けるロール（既定 base = AwsbridgeHumanPoc。tagged / notag は P2〜P4 用。--role-arn があればそちら）
//                                 base 以外はファイル名にロールを入れる（credentials-<role>.json、console-url-<role>-dur-…）
//   --access-profile <値>         セッションタグ access_profile を JWT に入れる（例 poc-admin / poc-viewer）
//   --tag-format nested|flat      セッションタグの書き方（既定 nested）
//   --source-identity             SourceIdentity（値は subject）を JWT に入れる。tagged ロールは必須
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseAssumeRoleResponse, parseStsError } from "../../../src/sts-xml";
import { fail, readKey, required, roleArnOf, stackOutputs, writeSecret } from "./io";
import {
  assumeRoleWithWebIdentityParams,
  consoleDestination,
  consoleUrlFileName,
  credentialsFileName,
  FEDERATION_ENDPOINT,
  getSigninTokenParams,
  humanPocSettings,
  humanSessionName,
  isRoleKey,
  isValidTagValue,
  loginUrl,
  parseSessionDurations,
  parseSigninTokenResponse,
  parseStsExtras,
  sessionDurationLabel,
  sessionTagClaims,
  signHumanToken,
  sourceIdentityClaim,
  stsEndpoint,
  summarizeBody,
} from "./lib";

let values: ReturnType<typeof parse>["values"];
function parse() {
  return parseArgs({
    options: {
      "role-arn": { type: "string" },
      "duration-seconds": { type: "string" },
      "session-durations": { type: "string", default: "none,43200,43199" },
      "federation-method": { type: "string", default: "get" },
      role: { type: "string", default: "base" },
      "access-profile": { type: "string" },
      "tag-format": { type: "string", default: "nested" },
      "source-identity": { type: "boolean", default: false },
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
const issuer = required(settings.issuer, "AWSBRIDGE_HUMAN_POC_ISSUER");
const subject = required(settings.subject, "AWSBRIDGE_HUMAN_POC_SUBJECT");

const method = (values["federation-method"] ?? "get").toUpperCase();
if (method !== "GET" && method !== "POST") fail("--federation-method は get か post");

let durationSeconds: number | undefined;
if (values["duration-seconds"] !== undefined) {
  durationSeconds = Number(values["duration-seconds"]);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 900 || durationSeconds > 43200)
    fail("--duration-seconds は 900〜43200 の整数");
}

const role = values.role ?? "base";
if (!isRoleKey(role)) fail("--role は base / tagged / notag");
const tagFormat = values["tag-format"] ?? "nested";
if (tagFormat !== "nested" && tagFormat !== "flat") fail("--tag-format は nested か flat");
const accessProfile = values["access-profile"];
if (accessProfile !== undefined && (accessProfile === "" || !isValidTagValue(accessProfile)))
  fail("--access-profile はタグの値に使える文字（英数字と _.:/=+-@）で 1〜256 文字");
let extraClaims: Record<string, unknown>;
try {
  extraClaims = {
    ...sessionTagClaims(
      accessProfile === undefined ? {} : { access_profile: accessProfile },
      tagFormat,
    ),
    ...(values["source-identity"] ? sourceIdentityClaim(subject) : {}),
  };
} catch (e) {
  fail(`SourceIdentity にできません: ${(e as Error).message}`);
}

let sessionDurations: (number | undefined)[];
try {
  sessionDurations = parseSessionDurations(values["session-durations"] ?? "");
} catch (e) {
  fail(`--session-durations が不正です: ${(e as Error).message}`);
}

// --role-arn が無ければ PoC スタック（MCP 用ではない）の Output（RoleArn / TaggedRoleArn / NoTagRoleArn）を使う
const roleArn = values["role-arn"] ?? roleArnOf(stackOutputs(settings), role, settings.stackName);
if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/.test(roleArn))
  fail(`ロール ARN が不正です: ${roleArn}`);

// 1. JWT → STS（署名なしの AssumeRoleWithWebIdentity）
const token = await signHumanToken({
  privateJwk: readKey(settings.keyFile),
  issuer,
  audience: settings.audience,
  subject,
  extraClaims,
});
const stsRes = await fetch(stsEndpoint(settings.region), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: assumeRoleWithWebIdentityParams({
    roleArn,
    roleSessionName: humanSessionName(subject),
    webIdentityToken: token,
    durationSeconds,
  }),
});
const stsXml = await stsRes.text();
const creds = parseAssumeRoleResponse(stsXml);
const durationLabel = durationSeconds === undefined ? "指定なし" : String(durationSeconds);
if (!stsRes.ok || !creds) {
  const err = parseStsError(stsXml);
  fail(
    `[NG] STS AssumeRoleWithWebIdentity (DurationSeconds=${durationLabel}) HTTP ${stsRes.status} ` +
      `Code=${err?.code ?? "Unknown"} Message=${summarizeBody(err?.message ?? stsXml, [token])}`,
  );
}
console.log(
  `[OK] STS AssumeRoleWithWebIdentity (DurationSeconds=${durationLabel}) HTTP ${stsRes.status} ` +
    `Arn=${creds.assumedRoleArn} Expiration=${creds.expiration.toISOString()}`,
);
{
  const extras = parseStsExtras(stsXml);
  const tags =
    accessProfile === undefined ? "なし" : `access_profile=${accessProfile}（${tagFormat}）`;
  console.log(
    `     タグ: ${tags}  SourceIdentity（応答）: ${extras.sourceIdentity ?? "なし"}` +
      (extras.sessionTokenUtilization === undefined
        ? ""
        : `  SessionTokenUtilization: ${extras.sessionTokenUtilization}%`),
  );
}
const credsFile = join(settings.outDir, credentialsFileName(role));
writeSecret(
  credsFile,
  `${JSON.stringify(
    {
      AccessKeyId: creds.accessKeyId,
      SecretAccessKey: creds.secretAccessKey,
      SessionToken: creds.sessionToken,
      Expiration: creds.expiration.toISOString(),
      AssumedRoleArn: creds.assumedRoleArn,
      DurationSeconds: durationSeconds ?? null,
    },
    null,
    2,
  )}\n`,
);
console.log(`     認証情報: ${credsFile}（権限 600）`);

// 2. getSigninToken（SessionDuration ごと）→ 3. ログイン URL
const secrets = [creds.accessKeyId, creds.secretAccessKey, creds.sessionToken, token];
let okCount = 0;
for (const sd of sessionDurations) {
  const label = sessionDurationLabel(sd);
  const params = getSigninTokenParams(creds, sd);
  let status = 0;
  let body = "";
  try {
    const res =
      method === "GET"
        ? await fetch(`${FEDERATION_ENDPOINT}?${params}`, { redirect: "manual" })
        : await fetch(FEDERATION_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: params,
            redirect: "manual",
          });
    status = res.status;
    body = await res.text();
  } catch (e) {
    body = (e as Error).message;
  }
  const signinToken = status === 200 ? parseSigninTokenResponse(body) : undefined;
  const file = join(settings.outDir, consoleUrlFileName(durationSeconds, sd, role));
  if (!signinToken) {
    // 前回の同じ条件の URL が残っていると、失敗したのに入れたと誤認しうるので消す
    rmSync(file, { force: true });
    console.log(
      `[NG] getSigninToken (${method}, SessionDuration=${label}) HTTP ${status} ${summarizeBody(body, secrets)}`,
    );
    continue;
  }
  okCount++;
  writeSecret(
    file,
    `${loginUrl({ signinToken, issuer, destination: consoleDestination(settings.region) })}\n`,
  );
  console.log(
    `[OK] getSigninToken (${method}, SessionDuration=${label}) HTTP ${status} → ログイン URL: ${file}（権限 600。15 分以内に開く）`,
  );
}
console.log(`getSigninToken: ${okCount}/${sessionDurations.length} 成功`);
