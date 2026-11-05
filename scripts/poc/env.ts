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
export function keyFile(): string {
  return envOr(
    "AWSBRIDGE_KEY_FILE",
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.secrets/dev-signing-key.json"),
  );
}
