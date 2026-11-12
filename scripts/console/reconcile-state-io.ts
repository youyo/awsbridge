// 確認済みの区間の状態ファイルの書き込み（突き合わせの CLI から使う）。同じ場所に一時ファイルを置いて置き換える。
// 書き込みでも置き換えでも失敗したら、一時ファイルを消してから例外を投げる（元のファイルは触らない）。
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type StateFileIo = {
  mkdir: (dir: string) => void;
  write: (path: string, text: string) => void;
  rename: (from: string, to: string) => void;
  rm: (path: string) => void;
};

/** ディレクトリは 0700、ファイルは 0600。 */
export const nodeStateFileIo: StateFileIo = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  },
  write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  rename: renameSync,
  rm: (path) => rmSync(path, { force: true }),
};

export function writeStateFile(
  path: string,
  text: string,
  io: StateFileIo = nodeStateFileIo,
): void {
  io.mkdir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    io.write(tmp, text);
    io.rename(tmp, path);
  } catch (e) {
    try {
      io.rm(tmp);
    } catch {
      // 消せなくても、元の失敗を返す
    }
    throw e;
  }
}
