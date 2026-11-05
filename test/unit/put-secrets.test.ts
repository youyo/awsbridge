import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const KEY_JSON = '{"kty":"RSA","n":"abc","e":"AQAB","d":"PRIVATE-D-VALUE"}';
const PROFILES = JSON.stringify({
  default: "dev",
  profiles: { dev: { roleArn: "arn:aws:iam::111111111111:role/awsbridge" } },
});

// 偽 pnpm（`pnpm exec wrangler ...` を受けて引数と標準入力を記録する）と偽 aws を PATH 先頭に置く。
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "awsbridge-put-secrets-"));
  tmpDirs.push(dir);
  const argsFile = join(dir, "wrangler-args.txt");
  const stdinFile = join(dir, "wrangler-stdin.json");
  const awsArgsFile = join(dir, "aws-args.txt");
  const keyFile = join(dir, "key.json");
  writeFileSync(keyFile, KEY_JSON);
  writeFileSync(
    join(dir, "pnpm"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\ncat > "${stdinFile}"\n`,
  );
  writeFileSync(
    join(dir, "aws"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${awsArgsFile}"; done\nexit 99\n`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  chmodSync(join(dir, "aws"), 0o755);
  return { dir, argsFile, stdinFile, awsArgsFile, keyFile };
}

const read = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

function run(s: ReturnType<typeof setup>, env: Record<string, string>) {
  return spawnSync("bash", [join(root, "scripts/put-secrets.sh")], {
    env: { PATH: `${s.dir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
}

const baseEnv = (keyFile: string) => ({
  AWSBRIDGE_KEY_FILE: keyFile,
  AWSBRIDGE_ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
  AWSBRIDGE_ACCESS_AUD: "aud-tag-example",
  AWSBRIDGE_PROFILES: PROFILES,
});

describe("scripts/put-secrets.sh", () => {
  it("wrangler secret bulk の標準入力に JSON を渡し、値を引数に出さない", () => {
    const s = setup();
    const r = run(s, baseEnv(s.keyFile));
    expect(r.status).toBe(0);
    const args = read(s.argsFile).split("\n").filter(Boolean);
    expect(args).toEqual(expect.arrayContaining(["wrangler", "secret", "bulk", "--env", "dev"]));
    expect(JSON.parse(read(s.stdinFile))).toEqual({
      SIGNING_JWK: KEY_JSON,
      ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag-example",
      AWS_PROFILES: PROFILES,
    });
    const argText = args.join("\n");
    for (const v of ["PRIVATE-D-VALUE", "aud-tag-example", "cloudflareaccess", "111111111111"]) {
      expect(argText).not.toContain(v);
    }
    expect(r.stdout + r.stderr).not.toContain("PRIVATE-D-VALUE");
  });

  it("aws を一切呼ばない（Worker のデプロイは AWS に依存しない）", () => {
    const s = setup();
    const r = run(s, baseEnv(s.keyFile));
    expect(r.status).toBe(0);
    expect(read(s.awsArgsFile)).toBe("");
  });

  it("特殊文字を含む値も JSON として安全にエスケープされる", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_ACCESS_AUD: 'a"b\\c' });
    expect(r.status).toBe(0);
    expect(JSON.parse(read(s.stdinFile)).ACCESS_AUD).toBe('a"b\\c');
  });

  for (const name of [
    "AWSBRIDGE_KEY_FILE",
    "AWSBRIDGE_ACCESS_TEAM_DOMAIN",
    "AWSBRIDGE_ACCESS_AUD",
  ]) {
    it(`${name} が未設定なら終了コード 1 で mise.local.toml を案内し wrangler を呼ばない`, () => {
      const s = setup();
      const env: Record<string, string> = baseEnv(s.keyFile);
      delete env[name];
      const r = run(s, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(name);
      expect(r.stderr).toContain("mise.local.toml");
      expect(read(s.argsFile)).toBe("");
    });
  }

  for (const v of [undefined, ""]) {
    it(`AWSBRIDGE_PROFILES が${v === "" ? "空" : "未設定"}なら AWS_PROFILES を登録せず 1 行表示する`, () => {
      const s = setup();
      const env: Record<string, string> = baseEnv(s.keyFile);
      if (v === undefined) delete env.AWSBRIDGE_PROFILES;
      else env.AWSBRIDGE_PROFILES = v;
      const r = run(s, env);
      expect(r.status).toBe(0);
      expect(JSON.parse(read(s.stdinFile))).not.toHaveProperty("AWS_PROFILES");
      expect(r.stderr).toContain("AWS_PROFILES");
      expect(read(s.argsFile)).toContain("bulk");
    });
  }

  it("FEDERATED_ROLE_ARN は登録しない（廃止）", () => {
    const s = setup();
    const r = run(s, {
      ...baseEnv(s.keyFile),
      AWSBRIDGE_ROLE_ARN: "arn:aws:iam::111111111111:role/x",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(read(s.stdinFile))).not.toHaveProperty("FEDERATED_ROLE_ARN");
  });

  it("AWSBRIDGE_PROFILES が JSON として不正なら終了コード 1 で wrangler を呼ばない（値は出さない）", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_PROFILES: "{SECRET-NOT-JSON" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AWSBRIDGE_PROFILES");
    expect(r.stderr).not.toContain("SECRET-NOT-JSON");
    expect(read(s.argsFile)).toBe("");
  });

  it("AWSBRIDGE_WRANGLER_ENV でデプロイ環境を切り替えられる（既定 dev）", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_WRANGLER_ENV: "prod" });
    expect(r.status).toBe(0);
    expect(read(s.argsFile).split("\n")).toEqual(expect.arrayContaining(["--env", "prod"]));
  });

  it("鍵ファイルが無ければ終了コード 1", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_KEY_FILE: join(s.dir, "missing.json") });
    expect(r.status).toBe(1);
    expect(read(s.argsFile)).toBe("");
  });
});
