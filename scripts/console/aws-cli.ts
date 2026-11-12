// コンソールログインの道具（検査・停止）が aws CLI を呼ぶ部品。execFile でシェルを通さずに呼び、JSON を返す。
// 呼べるコマンドは許可リスト（「サービス サブコマンド」）で道具ごとに渡し、それ以外は aws を起動せずに断る。
// プロファイルは --profile=<名前> の形で必ず付ける（- で始まる値を別の引数と読ませない）。
import { execFile } from "node:child_process";

/** aws CLI を `aws <args> --profile=<p> --output json` で呼び、JSON を返す（失敗は例外）。inspect-read.ts の AwsRun と同じ形。 */
export type AwsRun = (args: string[]) => Promise<unknown>;

/** 許可リストのコマンドだけを呼ぶ runner。失敗の文は stderr の最初の行か終了コードだけ（引数は出さない。伏せ字は呼び出し側で行う）。 */
export function awsRunner(profile: string, allowed: readonly string[]): AwsRun {
  return (args) =>
    new Promise((resolve, reject) => {
      const command = `${args[0]} ${args[1]}`;
      if (!allowed.includes(command)) {
        reject(new Error(`aws ${command}: not in the allowed list`));
        return;
      }
      execFile(
        "aws",
        [...args, `--profile=${profile}`, "--output", "json"],
        { env: process.env, timeout: 60_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // err.message は引数（ポリシーの文書 = 停止の値）を含むので使わない。終了コードかシグナルだけにする
            const e = err as NodeJS.ErrnoException & { signal?: string | null };
            const first =
              stderr.split("\n").find((l) => l.trim() !== "") ??
              `exit ${String(e.code ?? "?")}${e.signal ? ` (${e.signal})` : ""}`;
            reject(new Error(`aws ${command} failed: ${first.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim() === "" ? "null" : stdout));
          } catch {
            reject(new Error(`aws ${command}: could not parse the response`));
          }
        },
      );
    });
}
