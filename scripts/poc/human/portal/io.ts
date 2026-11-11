// PoC のポータルの手順（*.ts）が共有する I/O の小道具。
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../io";
import { outputsMap } from "../lib";
import { type PortalSettings, portalSettings } from "./settings";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const portalDir = resolve(dirname(fileURLToPath(import.meta.url)));

export function loadSettings(): PortalSettings {
  try {
    return portalSettings(process.env, repoRoot);
  } catch (e) {
    fail((e as Error).message);
  }
}

export function adminEnv(s: PortalSettings): NodeJS.ProcessEnv {
  return { ...process.env, AWS_PROFILE: s.awsProfile, AWS_REGION: s.region };
}

/** PoC のポータルのスタックの Outputs。スタックが無い・読めないなら undefined。 */
export function tryStackOutputs(s: PortalSettings): Record<string, string> | undefined {
  try {
    const raw = execFileSync(
      "aws",
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        s.stackName,
        "--query",
        "Stacks[0].Outputs",
        "--output",
        "json",
      ],
      { encoding: "utf8", env: adminEnv(s), stdio: ["ignore", "pipe", "pipe"] },
    );
    return outputsMap(raw.trim() === "" ? "null" : raw);
  } catch {
    return undefined;
  }
}

/** Access アプリの Terraform の `terraform output -json`。state が無い・失敗なら空文字。 */
export function terraformOutputJson(s: PortalSettings): string {
  try {
    return execFileSync("terraform", [`-chdir=${s.accessDir}`, "output", "-json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

/** E2E・テスト用の宛先の差し替え（http://127.0.0.1 / localhost だけ受け付ける）。 */
export function localOverride(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(v))
    fail(`${name} は http://127.0.0.1 / http://localhost だけ（テスト用）`);
  return v.replace(/\/+$/, "");
}
