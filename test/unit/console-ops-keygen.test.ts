// console:keygen（scripts/console/keygen.ts）の試験。鍵は一時ディレクトリにだけ作り、作業ツリーに残さない。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeySet, writeKeyFile } from "../../scripts/console/keygen-lib";
import { parseSigningKeys } from "../../src/console/issue/sign-standard";
import { thumbprintOf } from "../../src/keys";

const root = new URL("../../", import.meta.url).pathname;
const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-console-keygen-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("generateKeySet", () => {
  it("境界ごとに parseSigningKeys が受け付ける鍵を作り、kid は公開鍵の thumbprint", async () => {
    const { json, kids } = await generateKeySet(["managed", "partner:partner-x"]);
    const keys = parseSigningKeys(json);
    expect(Object.keys(keys).sort()).toEqual(["managed", "partner:partner-x"]);
    for (const [b, jwk] of Object.entries(keys)) {
      expect(jwk.alg).toBe("RS256");
      expect(kids[b]).toBe(await thumbprintOf(jwk));
    }
    // 境界ごとに別の鍵
    expect(kids.managed).not.toBe(kids["partner:partner-x"]);
  }, 30_000);

  it("境界が無い・空文字・重複は拒む", async () => {
    await expect(generateKeySet([])).rejects.toThrow();
    await expect(generateKeySet([""])).rejects.toThrow();
    await expect(generateKeySet(["a", "a"])).rejects.toThrow();
  });
});

describe("writeKeyFile", () => {
  it("0600 で書き、親ディレクトリを作る", () => {
    const file = join(tmp(), ".secrets", "console", "keys.json");
    expect(writeKeyFile(file, '{"a":1}', false)).toBe("created");
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("既存のファイルは上書きしない（force が無ければ）", () => {
    const file = join(tmp(), "keys.json");
    writeFileSync(file, "old", { mode: 0o600 });
    expect(writeKeyFile(file, "new", false)).toBe("exists");
    expect(readFileSync(file, "utf8")).toBe("old");
  });

  it("force なら上書きし、権限も 0600 にそろえる", () => {
    const file = join(tmp(), "keys.json");
    writeFileSync(file, "old", { mode: 0o644 });
    expect(writeKeyFile(file, "new", true)).toBe("overwritten");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("force でもシンボリックリンクは辿らない（誤りで、リンク先は変わらない）", () => {
    const dir = tmp();
    const target = join(dir, "target.json");
    writeFileSync(target, "target", { mode: 0o644 });
    const link = join(dir, "keys.json");
    symlinkSync(target, link);
    expect(writeKeyFile(link, "new", true)).toBe("symlink");
    expect(readFileSync(target, "utf8")).toBe("target");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    // 宛先の無いリンクも同じ
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere.json"), dangling);
    expect(writeKeyFile(dangling, "new", true)).toBe("symlink");
    expect(existsSync(join(dir, "nowhere.json"))).toBe(false);
  });

  it("force の上書きは同じディレクトリの一時ファイルを rename する（原子的。一時ファイルを残さない）", () => {
    const dir = tmp();
    const file = join(dir, "keys.json");
    writeFileSync(file, "old", { mode: 0o644 });
    const inode = statSync(file).ino;
    expect(writeKeyFile(file, "new", true)).toBe("overwritten");
    // 同じ inode に書き込むのではなく、別のファイルに差し替わる
    expect(statSync(file).ino).not.toBe(inode);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["keys.json"]);
  });
});

// 実プロセス（tsx）で CLI を通しで確かめる
function cli(args: string[], env: Record<string, string>) {
  const r = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "scripts/console/keygen.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

describe("console:keygen の CLI", () => {
  it("--boundary で作り、0600・parseSigningKeys が通る・kid を表示し、秘密成分は表示しない", () => {
    const file = join(tmp(), ".secrets", "console", "signing-keys.json");
    const r = cli(["--boundary", "managed", "--boundary", "partner:partner-x"], {
      AWSBRIDGE_CONSOLE_KEY_FILE: file,
    });
    expect(r.status, r.out).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf8");
    const keys = parseSigningKeys(raw);
    expect(Object.keys(keys).sort()).toEqual(["managed", "partner:partner-x"]);
    for (const [b, jwk] of Object.entries(keys)) {
      expect(r.stdout).toContain(b);
      expect(r.stdout).toContain(String(jwk.kid));
      for (const secret of [jwk.d, jwk.p, jwk.q, jwk.dp, jwk.dq, jwk.qi]) {
        expect(r.out).not.toContain(secret as string);
      }
    }
  }, 60_000);

  it("既存のファイルがあれば、force が無いと誤り（終了コード 1・中身は変わらない）", () => {
    const file = join(tmp(), "signing-keys.json");
    writeFileSync(file, "old", { mode: 0o600 });
    const r = cli(["--boundary", "managed"], { AWSBRIDGE_CONSOLE_KEY_FILE: file });
    expect(r.status).toBe(1);
    expect(r.out).toContain("--force");
    expect(readFileSync(file, "utf8")).toBe("old");
  });

  it("--force でもシンボリックリンクなら誤り（終了コード 1・リンク先は変わらない）", () => {
    const dir = tmp();
    const target = join(dir, "target.json");
    writeFileSync(target, "target", { mode: 0o600 });
    const link = join(dir, "signing-keys.json");
    symlinkSync(target, link);
    const r = cli(["--boundary", "managed", "--force"], { AWSBRIDGE_CONSOLE_KEY_FILE: link });
    expect(r.status).toBe(1);
    expect(r.out).toContain("シンボリックリンク");
    expect(readFileSync(target, "utf8")).toBe("target");
  });

  it("--force なら上書きする", () => {
    const file = join(tmp(), "signing-keys.json");
    writeFileSync(file, "old", { mode: 0o600 });
    const r = cli(["--boundary", "managed", "--force"], { AWSBRIDGE_CONSOLE_KEY_FILE: file });
    expect(r.status, r.out).toBe(0);
    expect(Object.keys(parseSigningKeys(readFileSync(file, "utf8")))).toEqual(["managed"]);
  }, 60_000);

  it("--boundary を省くと設定ファイルの Standard の境界（issuers.standard があるもの）を使う", () => {
    const dir = tmp();
    const configFile = join(dir, "console.json");
    const base = JSON.parse(readFileSync(join(root, "config/console.example.json"), "utf8"));
    writeFileSync(configFile, JSON.stringify(base));
    const file = join(dir, "keys", "signing-keys.json");
    const r = cli([], { AWSBRIDGE_CONSOLE_KEY_FILE: file, AWSBRIDGE_CONSOLE_CONFIG: configFile });
    expect(r.status, r.out).toBe(0);
    expect(Object.keys(parseSigningKeys(readFileSync(file, "utf8")))).toEqual(["managed"]);
  }, 60_000);

  it("境界の指定も設定ファイルも無ければ誤りで、ファイルを作らない", () => {
    const dir = tmp();
    const file = join(dir, "signing-keys.json");
    const r = cli([], {
      AWSBRIDGE_CONSOLE_KEY_FILE: file,
      AWSBRIDGE_CONSOLE_CONFIG: join(dir, "none.json"),
    });
    expect(r.status).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("作業ツリーの .secrets/ の外の置き場所でも、親ディレクトリを作って書く", () => {
    const file = join(tmp(), "a", "b", "keys.json");
    mkdirSync(dirname(dirname(file)), { recursive: true });
    const r = cli(["--boundary", "managed"], { AWSBRIDGE_CONSOLE_KEY_FILE: file });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(file)).toBe(true);
  }, 60_000);
});
