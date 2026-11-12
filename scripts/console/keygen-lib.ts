// console:keygen の本体（CLI は keygen.ts）。境界ごとの RS256 署名鍵（RSA 2048 bit、秘密鍵 JWK）を作り、
// CONSOLE_SIGNING_KEYS の形（境界の名前 → 秘密鍵 JWK の JSON）にする。表示してよいのは境界の名前と kid（公開鍵の thumbprint）だけ。
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { generateSigningJwk, thumbprintOf } from "../../src/keys";

export type KeySet = {
  /** CONSOLE_SIGNING_KEYS に入れる JSON（秘密を含む。表示しない）。 */
  json: string;
  /** 境界の名前 → kid（公開鍵の thumbprint）。 */
  kids: Record<string, string>;
};

export async function generateKeySet(boundaries: string[]): Promise<KeySet> {
  if (boundaries.length === 0) throw new Error("境界が 1 つもありません");
  if (boundaries.some((b) => typeof b !== "string" || b === ""))
    throw new Error("境界の名前が空です");
  if (new Set(boundaries).size !== boundaries.length) throw new Error("境界の名前が重複しています");
  const keys: Record<string, unknown> = {};
  const kids: Record<string, string> = {};
  for (const b of boundaries) {
    const jwk = await generateSigningJwk();
    keys[b] = jwk;
    kids[b] = await thumbprintOf(jwk);
  }
  return { json: JSON.stringify(keys), kids };
}

export type WriteResult = "created" | "exists" | "overwritten" | "symlink";

/**
 * 鍵のファイルを 0600 で書く。既に有れば force が無い限り何も書かない（"wx" で競合も防ぐ）。
 * force のときは、パスがシンボリックリンクなら辿らず "symlink" を返す（リンク先を壊さない）。
 * そうでなければ、同じディレクトリに wx・0600 で一時ファイルを作って rename する（原子的。権限の隙間がない）。
 */
export function writeKeyFile(path: string, content: string, force: boolean): WriteResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!force) {
    try {
      writeFileSync(path, content, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw e;
    }
    chmodSync(path, 0o600);
    return "created";
  }
  let existed = true;
  try {
    if (lstatSync(path).isSymbolicLink()) return "symlink";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    existed = false;
  }
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, "0")).join("")}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmpPath, 0o600); // umask に左右されない
    renameSync(tmpPath, path);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
  return existed ? "overwritten" : "created";
}
