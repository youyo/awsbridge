// PoC N6 の手順（*.ts）が共有する I/O の小道具。aws CLI はプロファイル（既定 awsbridge）で呼ぶ。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../human/io";
import { outputsMap } from "../human/lib";
import { type AdminKmsSettings, adminKmsSettings, maskIds } from "./ops";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const pocDir = resolve(dirname(fileURLToPath(import.meta.url)));

export function loadSettings(): AdminKmsSettings {
  try {
    return adminKmsSettings(process.env, repoRoot);
  } catch (e) {
    fail((e as Error).message);
  }
}

export function requireIssuer(s: AdminKmsSettings): string {
  if (!s.issuer)
    fail(
      "AWSBRIDGE_ADMIN_KMS_POC_ISSUER が未設定です（mise.local.toml に https://awsbridge-admin-kms-poc.<subdomain>.workers.dev）",
    );
  return s.issuer;
}

export function awsEnv(s: AdminKmsSettings): NodeJS.ProcessEnv {
  return { ...process.env, AWS_PROFILE: s.awsProfile, AWS_REGION: s.region };
}

export interface AwsCall {
  ok: boolean;
  status: number | null;
  stdout: string;
  /** 伏せ字にした stderr */
  stderr: string;
}

/** aws CLI を同期で呼ぶ（失敗しても例外にしない）。stderr は伏せ字にする。 */
export function aws(s: AdminKmsSettings, args: string[]): AwsCall {
  const r = spawnSync("aws", args, { encoding: "utf8", env: awsEnv(s) });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: maskIds((r.stderr ?? "").trim()),
  };
}

/** aws CLI を呼んで JSON を返す。失敗したら止まる。 */
export function awsJson<T = Record<string, unknown>>(s: AdminKmsSettings, args: string[]): T {
  const r = aws(s, [...args, "--output", "json"]);
  if (!r.ok) fail(`aws ${args.slice(0, 2).join(" ")} が失敗しました: ${r.stderr}`);
  return JSON.parse(r.stdout || "null") as T;
}

export function stackOutputs(s: AdminKmsSettings): Record<string, string> {
  const r = aws(s, [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    s.stackName,
    "--query",
    "Stacks[0].Outputs",
    "--output",
    "json",
  ]);
  if (!r.ok) fail(`スタック ${s.stackName} を読めません（deploy-aws を先に）: ${r.stderr}`);
  return outputsMap(r.stdout.trim() === "" ? "null" : r.stdout);
}

export function readCallerToken(s: AdminKmsSettings): string {
  if (!existsSync(s.callerTokenFile))
    fail(`${s.callerTokenFile} がありません（mise run poc:admin-kms:access-key -- create を先に）`);
  return readFileSync(s.callerTokenFile, "utf8").trim();
}

export interface WorkerCall {
  status: number;
  body: Record<string, unknown>;
  /** 手元から見た往復（ミリ秒） */
  clientMs: number;
}

/** Worker の /poc/* を bearer 付きで呼ぶ。 */
export async function callWorker(
  issuer: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<WorkerCall> {
  const t0 = performance.now();
  const res = await fetch(`${issuer}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const clientMs = Math.round((performance.now() - t0) * 10) / 10;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed, clientMs };
}
