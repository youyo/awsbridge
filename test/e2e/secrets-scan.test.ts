// 秘密の検査（scripts/secrets-scan.sh。mise run secrets:scan）を一時的な git リポジトリで実際に動かす。
// 作業ツリーで削除した tracked のファイルがあっても落ちない（存在するファイルだけを検査に渡す）こと、未追跡のファイルも見ることを確かめる。
// gitleaks は mise.toml の [tools] で固定した版（mise run test の PATH にある）。
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { root } from "./console-e2e-kit";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-secrets-scan-"));
  dirs.push(d);
  const git = (...a: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: d });
  git("init", "-q");
  copyFileSync(join(root, "scripts/secrets-scan.sh"), join(d, "secrets-scan.sh"));
  writeFileSync(join(d, "keep.txt"), "hello\n");
  writeFileSync(join(d, "gone.txt"), "bye\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return d;
}

const scan = (d: string) =>
  spawnSync("bash", [join(d, "secrets-scan.sh")], { cwd: d, encoding: "utf8" });

describe("secrets:scan（scripts/secrets-scan.sh）", () => {
  it("作業ツリーで削除済みの tracked のファイルがあっても終了コード 0（漏れなし）", () => {
    const d = repo();
    unlinkSync(join(d, "gone.txt"));
    const r = scan(d);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it("陽性の対照: 未追跡のファイルの秘密の形は見つけて終了コード 1（値は伏せる）", () => {
    const d = repo();
    unlinkSync(join(d, "gone.txt"));
    // 実行時に組む（このファイル自体が検査に引っかからないように）
    const key = ["AKIA", "Z7QW3XK2PL5N8RTV"].join("");
    const secret = ["wJalrXUtnFEMI", "K7MDENGbPxRfiCYzZ9q3kLm2"].join("/");
    writeFileSync(
      join(d, "untracked.env"),
      `aws_access_key_id = ${key}\naws_secret_access_key = ${secret}\n`,
    );
    const r = scan(d);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).not.toContain(secret);
  });
});
