// console:secrets:standard（scripts/console/secrets.ts）の試験。wrangler は差し替え、実 Cloudflare を呼ばない。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeySet } from "../../scripts/console/keygen-lib";
import { runSecrets, type SecretPutter } from "../../scripts/console/secrets-lib";

const root = new URL("../../", import.meta.url).pathname;
const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-console-secrets-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

let keysJson = "";
let keysDemoBoundary = "";
async function setupKeys(dir: string, mode = 0o600): Promise<string> {
  if (!keysJson) {
    keysJson = (await generateKeySet(["managed"])).json;
    keysDemoBoundary = "managed";
  }
  const f = join(dir, "signing-keys.json");
  writeFileSync(f, keysJson, { mode });
  chmodSync(f, mode);
  return f;
}

function fakePutter() {
  const calls: { name: string; value: string }[] = [];
  const put: SecretPutter = (name, value) => {
    calls.push({ name, value });
    return { ok: true };
  };
  return { calls, put };
}

describe("runSecrets", () => {
  it("確認が無い（既定）なら wrangler を呼ばず、何を入れるかだけ返す。値は含めない", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const csrfFile = join(dir, "csrf-key");
    const { calls, put } = fakePutter();
    const r = await runSecrets({ keyFile, csrfKeyFile: csrfFile, confirm: false }, put);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(r.lines.join("\n")).toContain("CONSOLE_SIGNING_KEYS");
    expect(r.lines.join("\n")).toContain("CONSOLE_CSRF_KEY");
    expect(r.lines.join("\n")).toContain(keysDemoBoundary);
    expect(r.lines.join("\n")).not.toContain(JSON.parse(keysJson).managed.d);
    // dry-run は CSRF の鍵のファイルも作らない
    expect(existsSync(csrfFile)).toBe(false);
  }, 30_000);

  it("確認があれば 2 つの secret を入れ、CSRF の鍵が無ければ 32 バイト以上を 0600 で作る", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const csrfFile = join(dir, "csrf-key");
    const { calls, put } = fakePutter();
    const r = await runSecrets({ keyFile, csrfKeyFile: csrfFile, confirm: true }, put);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["CONSOLE_SIGNING_KEYS", "CONSOLE_CSRF_KEY"]);
    expect(calls[0]?.value).toBe(keysJson);
    const csrf = calls[1]?.value ?? "";
    expect(Buffer.byteLength(csrf)).toBeGreaterThanOrEqual(32);
    expect(readFileSync(csrfFile, "utf8").trim()).toBe(csrf);
    expect(statSync(csrfFile).mode & 0o777).toBe(0o600);
    // 出力に秘密の値を出さない
    const out = r.lines.join("\n");
    expect(out).not.toContain(csrf);
    expect(out).not.toContain(JSON.parse(keysJson).managed.d);
  }, 30_000);

  it("CSRF の鍵が既にあれば再利用する（作り直さない）", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const csrfFile = join(dir, "csrf-key");
    const existing = "x".repeat(40);
    writeFileSync(csrfFile, `${existing}\n`, { mode: 0o600 });
    const { calls, put } = fakePutter();
    const r = await runSecrets({ keyFile, csrfKeyFile: csrfFile, confirm: true }, put);
    expect(r.ok).toBe(true);
    expect(calls[1]?.value).toBe(existing);
  }, 30_000);

  it("署名鍵のファイルが無い・壊れている・権限が広いときは、確認があっても wrangler を呼ばない", async () => {
    const dir = tmp();
    const csrfFile = join(dir, "csrf-key");
    const { calls, put } = fakePutter();
    const missing = await runSecrets(
      { keyFile: join(dir, "nope.json"), csrfKeyFile: csrfFile, confirm: true },
      put,
    );
    expect(missing.ok).toBe(false);

    const broken = join(dir, "broken.json");
    writeFileSync(broken, '{"managed":{"kty":"RSA"}}', { mode: 0o600 });
    const r2 = await runSecrets({ keyFile: broken, csrfKeyFile: csrfFile, confirm: true }, put);
    expect(r2.ok).toBe(false);

    const wide = await setupKeys(tmp(), 0o644);
    const r3 = await runSecrets({ keyFile: wide, csrfKeyFile: csrfFile, confirm: true }, put);
    expect(r3.ok).toBe(false);
    expect(r3.lines.join("\n")).toContain("0600");
    expect(calls).toEqual([]);
    expect(existsSync(csrfFile)).toBe(false);
  }, 30_000);

  it("CSRF の鍵が 32 バイト未満なら入れない", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const csrfFile = join(dir, "csrf-key");
    writeFileSync(csrfFile, "short\n", { mode: 0o600 });
    const { calls, put } = fakePutter();
    const r = await runSecrets({ keyFile, csrfKeyFile: csrfFile, confirm: true }, put);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  }, 30_000);

  it("wrangler が失敗したら止まり、ok=false（出力に値を出さない）", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const put: SecretPutter = () => ({ ok: false, message: "boom" });
    const r = await runSecrets({ keyFile, csrfKeyFile: join(dir, "csrf-key"), confirm: true }, put);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("CONSOLE_SIGNING_KEYS");
  }, 30_000);
});

// 実プロセス（tsx + scripts/wrangler.sh）で通しに確かめる。pnpm を差し替えて wrangler の呼び出しを記録する。
function fakePnpm(exitCode = 0): { dir: string; log: string } {
  const dir = tmpDirsPush();
  const log = join(dir, "calls.txt");
  const body = `#!/bin/sh\n{ printf 'ARGS'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; printf 'STDIN '; cat; printf '\\n'; } >> "${log}"\necho "wrangler said: $(cat /dev/null)"\nexit ${exitCode}\n`;
  const p = join(dir, "pnpm");
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return { dir, log };
}
function tmpDirsPush(): string {
  return tmp();
}

async function cli(args: string[], extraEnv: Record<string, string>, pnpmDir: string) {
  const r = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "scripts/console/secrets.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${pnpmDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        ...extraEnv,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("console:secrets:standard の CLI", () => {
  it("--yes が無ければ wrangler（pnpm）を呼ばない", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const { dir: bin, log } = fakePnpm();
    const r = await cli(
      [],
      {
        AWSBRIDGE_CONSOLE_KEY_FILE: keyFile,
        AWSBRIDGE_CONSOLE_CSRF_KEY_FILE: join(dir, "csrf-key"),
      },
      bin,
    );
    expect(r.status, r.out).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(r.out).toContain("--yes");
    expect(r.out).not.toContain(JSON.parse(keysJson).managed.d);
  }, 30_000);

  it("--yes なら標準入力で値を渡し、引数に値を載せず、既定で Standard の設定ファイルを使う", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const csrfFile = join(dir, "csrf-key");
    const { dir: bin, log } = fakePnpm();
    const r = await cli(
      ["--yes"],
      {
        AWSBRIDGE_CONSOLE_KEY_FILE: keyFile,
        AWSBRIDGE_CONSOLE_CSRF_KEY_FILE: csrfFile,
      },
      bin,
    );
    expect(r.status, r.out).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("[exec] [wrangler] [secret] [put] [CONSOLE_SIGNING_KEYS]");
    expect(calls).toContain("[exec] [wrangler] [secret] [put] [CONSOLE_CSRF_KEY]");
    expect(calls).toContain("[--config] [wrangler.console-standard.jsonc]");
    expect(calls).not.toContain("[--env]");
    const csrf = readFileSync(csrfFile, "utf8").trim();
    expect(calls).toContain(`STDIN ${csrf}`);
    expect(calls).toContain(`STDIN ${keysJson}`);
    // 引数（ARGS の行）に値を載せない
    for (const line of calls.split("\n").filter((l) => l.startsWith("ARGS"))) {
      expect(line).not.toContain(csrf);
      expect(line).not.toContain(JSON.parse(keysJson).managed.d);
    }
    expect(r.out).not.toContain(csrf);
    expect(r.out).not.toContain(JSON.parse(keysJson).managed.d);
  }, 30_000);

  it("AWSBRIDGE_CONSOLE_WRANGLER_CONFIG で下流の設定ファイルに切り替えられる", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const { dir: bin, log } = fakePnpm();
    const r = await cli(
      ["--yes"],
      {
        AWSBRIDGE_CONSOLE_KEY_FILE: keyFile,
        AWSBRIDGE_CONSOLE_CSRF_KEY_FILE: join(dir, "csrf-key"),
        AWSBRIDGE_CONSOLE_WRANGLER_CONFIG: "wrangler.down-console.jsonc",
        // MCP 用の設定が環境に入っていても、コンソール用は影響を受けない
        AWSBRIDGE_WRANGLER_CONFIG: "wrangler.mcp.jsonc",
        AWSBRIDGE_WRANGLER_ENV: "dev",
      },
      bin,
    );
    expect(r.status, r.out).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("[--config] [wrangler.down-console.jsonc]");
    expect(calls).not.toContain("wrangler.mcp.jsonc");
    expect(calls).not.toContain("[--env]");
  }, 30_000);

  it("wrangler が失敗したら終了コード 1", async () => {
    const dir = tmp();
    const keyFile = await setupKeys(dir);
    const { dir: bin } = fakePnpm(3);
    const r = await cli(
      ["--yes"],
      {
        AWSBRIDGE_CONSOLE_KEY_FILE: keyFile,
        AWSBRIDGE_CONSOLE_CSRF_KEY_FILE: join(dir, "csrf-key"),
      },
      bin,
    );
    expect(r.status).toBe(1);
  }, 30_000);
});
