// PoC（人間のログイン）のスクリプトが共有する I/O の小道具。
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JWK } from "jose";
import {
  type ParsedCredentials,
  parseAssumeRoleResponse,
  parseStsError,
} from "../../../src/sts-xml";
import type { Outcome, ProbeApi } from "./cases";
import {
  assumeRoleWithWebIdentityParams,
  type HumanPocSettings,
  humanSessionName,
  outputsMap,
  parseStsExtras,
  type RoleKey,
  roleOutputKey,
  type StsExtras,
  signHumanToken,
  stsEndpoint,
  summarizeBody,
} from "./lib";
import { parseCliErrorCode } from "./ops";
import { failureDetail } from "./watch";

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function required(value: string | undefined, name: string): string {
  if (!value) fail(`${name} が未設定です。mise.local.toml に設定してください。`);
  return value;
}

export function readKey(keyFile: string): JWK {
  try {
    return JSON.parse(readFileSync(keyFile, "utf8")) as JWK;
  } catch {
    fail(`署名鍵を読めません: ${keyFile}（先に mise run poc:human:keygen を実行してください）`);
  }
}

/** 機密を含むファイルを権限 600 で書く（ディレクトリは 700 で作る）。 */
export function writeSecret(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ---- AWS（CLI と STS）。P2〜P4 の道具が共有する ----

/** 管理操作（CloudFormation・IAM・CloudTrail）用の環境変数: PoC の AWS_PROFILE / AWS_REGION を使う。 */
export function adminEnv(settings: HumanPocSettings): NodeJS.ProcessEnv {
  return { ...process.env, AWS_PROFILE: settings.awsProfile, AWS_REGION: settings.region };
}

/** PoC スタックの Outputs（OutputKey → OutputValue）。 */
export function stackOutputs(settings: HumanPocSettings): Record<string, string> {
  let raw: string;
  try {
    raw = execFileSync(
      "aws",
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        settings.stackName,
        "--query",
        "Stacks[0].Outputs",
        "--output",
        "json",
      ],
      { encoding: "utf8", env: adminEnv(settings), stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch {
    fail(
      `スタック ${settings.stackName} の Outputs を読めません（先に mise run poc:human:deploy-aws）`,
    );
  }
  try {
    return outputsMap(raw.trim() === "" ? "null" : raw);
  } catch {
    fail(`スタック ${settings.stackName} の Outputs を解釈できません`);
  }
}

/** スタックの Output からロール ARN を得る（base / tagged / notag）。 */
export function roleArnOf(
  outputs: Record<string, string>,
  role: RoleKey,
  stackName: string,
): string {
  const key = roleOutputKey(role);
  const arn = outputs[key] ?? "";
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/.test(arn))
    fail(
      `ロール ARN を得られません（スタック ${stackName} の Output ${key}。テンプレートを更新したら deploy-aws をやり直す）`,
    );
  return arn;
}

export interface AwsResult {
  code: number;
  stdout: string;
  stderr: string;
  /** timeoutMs を超えて止めた */
  timedOut: boolean;
}

/** aws CLI を非同期で呼ぶ（失敗しても例外にしない）。 */
export function runAws(
  args: string[],
  env: NodeJS.ProcessEnv | Record<string, string>,
  timeoutMs = 60_000,
): Promise<AwsResult> {
  return new Promise((resolve) => {
    execFile("aws", args, { env, timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
      const code =
        err === null
          ? 0
          : typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 1;
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const PROBE_ARGS: Record<ProbeApi, string[]> = {
  "s3:ListBuckets": ["s3api", "list-buckets", "--query", "length(Buckets)", "--output", "text"],
  "iam:ListRoles": [
    "iam",
    "list-roles",
    // --max-items と --query length(Roles) を組み合わせると、ページ送りの後段で CLI が
    // 「invalid type for value: None」で失敗する（呼び出し自体は成功）。1 ページだけ取り、件数は数えない
    "--no-paginate",
    "--max-items",
    "1",
    "--query",
    "Roles[0].RoleName",
    "--output",
    "text",
  ],
};

/**
 * 権限の判定用に、固定の無害な読み取り API を呼ぶ。結果は成功か、エラーコードと失敗の要約（伏せ字）。
 * 時間切れは Timeout。エラー文の形が違う（aws login の更新の失敗など）ときは Unknown で、要約に中身が残る。
 */
export async function probeApi(
  api: ProbeApi,
  env: NodeJS.ProcessEnv | Record<string, string>,
  timeoutMs = 60_000,
): Promise<Outcome> {
  const r = await runAws(PROBE_ARGS[api], env, timeoutMs);
  if (r.code === 0 && !r.timedOut) return { ok: true };
  return {
    ok: false,
    code: r.timedOut ? "Timeout" : parseCliErrorCode(r.stderr),
    detail: failureDetail(r.stderr),
  };
}

export type AssumeResult =
  | { ok: true; creds: ParsedCredentials; extras: StsExtras; tokenLength: number }
  | { ok: false; code: string; message: string; status: number; tokenLength: number };

/** 手元で署名した JWT（追加 claim つき）で AssumeRoleWithWebIdentity を呼ぶ（署名なし）。 */
export async function assumeWithClaims(p: {
  settings: HumanPocSettings;
  issuer: string;
  subject: string;
  roleArn: string;
  extraClaims?: Record<string, unknown>;
  durationSeconds?: number | undefined;
}): Promise<AssumeResult> {
  const token = await signHumanToken({
    privateJwk: readKey(p.settings.keyFile),
    issuer: p.issuer,
    audience: p.settings.audience,
    subject: p.subject,
    ...(p.extraClaims ? { extraClaims: p.extraClaims } : {}),
  });
  let status = 0;
  let xml = "";
  try {
    const res = await fetch(stsEndpoint(p.settings.region), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: assumeRoleWithWebIdentityParams({
        roleArn: p.roleArn,
        roleSessionName: humanSessionName(p.subject),
        webIdentityToken: token,
        durationSeconds: p.durationSeconds,
      }),
    });
    status = res.status;
    xml = await res.text();
  } catch (e) {
    return {
      ok: false,
      code: "NetworkError",
      message: (e as Error).message,
      status,
      tokenLength: token.length,
    };
  }
  const creds = parseAssumeRoleResponse(xml);
  if (status === 200 && creds)
    return { ok: true, creds, extras: parseStsExtras(xml), tokenLength: token.length };
  const err = parseStsError(xml);
  return {
    ok: false,
    code: err?.code ?? "Unknown",
    message: summarizeBody(err?.message ?? xml, [token]),
    status,
    tokenLength: token.length,
  };
}
