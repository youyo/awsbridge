// PoC（人間のログイン）のスクリプトが共有する I/O の小道具。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JWK } from "jose";

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
