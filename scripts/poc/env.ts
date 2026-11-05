import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} が未設定です。mise.local.toml に設定してください。`);
    process.exit(1);
  }
  return v;
}

// 未設定または空なら既定値（mise.toml の [env] ではなくここで補い、下流が上書きしやすくする）
export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// 署名鍵の既定の置き場所（リポジトリルート相対の .secrets/dev-signing-key.json）
export function keyFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AWSBRIDGE_KEY_FILE ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.secrets/dev-signing-key.json")
  );
}

// 署名鍵のローテーションで使う次の鍵・前の鍵の置き場所。
// 既定は現行の鍵ファイルの拡張子の前に .next / .previous を付けたもの（.secrets/dev-signing-key.next.json など）。
export function rotationKeyFiles(env: NodeJS.ProcessEnv = process.env): {
  current: string;
  next: string;
  previous: string;
} {
  const current = keyFile(env);
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(current);
  const stem = m?.[1] ?? current;
  return {
    current,
    next: env.AWSBRIDGE_NEXT_KEY_FILE || `${stem}.next.json`,
    previous: env.AWSBRIDGE_PREVIOUS_KEY_FILE || `${stem}.previous.json`,
  };
}
