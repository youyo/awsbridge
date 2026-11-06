import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const KEY_JSON = '{"kty":"RSA","n":"abc","e":"AQAB","d":"PRIVATE-D-VALUE"}';

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
});

describe("scripts/put-secrets.sh", () => {
  it("wrangler secret bulk の標準入力に JSON を渡し、値を引数に出さない", () => {
    const s = setup();
    const r = run(s, baseEnv(s.keyFile));
    expect(r.status).toBe(0);
    const args = read(s.argsFile).split("\n").filter(Boolean);
    expect(args).toEqual(
      expect.arrayContaining([
        "wrangler",
        "secret",
        "bulk",
        "--config",
        "wrangler.jsonc",
        "--env",
        "dev",
      ]),
    );
    expect(JSON.parse(read(s.stdinFile))).toEqual({
      SIGNING_JWK: KEY_JSON,
      ADDITIONAL_PUBLIC_JWKS: "[]",
      ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag-example",
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

  for (const name of ["AWSBRIDGE_ACCESS_TEAM_DOMAIN", "AWSBRIDGE_ACCESS_AUD"]) {
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

  it("AWS_PROFILES は登録しない（廃止。プロファイル一覧は wrangler の alias でバンドルする）", () => {
    const s = setup();
    const r = run(s, baseEnv(s.keyFile));
    expect(r.status).toBe(0);
    expect(JSON.parse(read(s.stdinFile))).not.toHaveProperty("AWS_PROFILES");
  });

  it("旧 AWSBRIDGE_PROFILES が環境に残っていても AWS_PROFILES を登録せず、値も出さない（不正な JSON でも止めない）", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_PROFILES: "{SECRET-NOT-JSON" });
    expect(r.status).toBe(0);
    expect(JSON.parse(read(s.stdinFile))).not.toHaveProperty("AWS_PROFILES");
    expect(r.stdout + r.stderr).not.toContain("SECRET-NOT-JSON");
    expect(read(s.argsFile)).toContain("bulk");
  });

  it("FEDERATED_ROLE_ARN は登録しない（廃止）", () => {
    const s = setup();
    const r = run(s, {
      ...baseEnv(s.keyFile),
      AWSBRIDGE_ROLE_ARN: "arn:aws:iam::111111111111:role/x",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(read(s.stdinFile))).not.toHaveProperty("FEDERATED_ROLE_ARN");
  });

  it("AWSBRIDGE_WRANGLER_ENV でデプロイ環境を切り替えられる（既定 dev）", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_WRANGLER_ENV: "prod" });
    expect(r.status).toBe(0);
    expect(read(s.argsFile).split("\n")).toEqual(expect.arrayContaining(["--env", "prod"]));
  });

  it("AWSBRIDGE_WRANGLER_ENV が空なら --env を付けない", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_WRANGLER_ENV: "" });
    expect(r.status).toBe(0);
    expect(read(s.argsFile).split("\n")).not.toContain("--env");
  });

  it("AWSBRIDGE_WRANGLER_CONFIG を --config に反映する", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_WRANGLER_CONFIG: "wrangler.x.jsonc" });
    expect(r.status).toBe(0);
    expect(read(s.argsFile).split("\n")).toEqual(
      expect.arrayContaining(["--config", "wrangler.x.jsonc"]),
    );
  });

  it("AWSBRIDGE_KEY_FILE が未設定ならリポジトリルートの .secrets/dev-signing-key.json を使う", () => {
    // スクリプトのルートは自身の位置から決まるので、仮のルートに scripts/ をコピーして検証する
    const s = setup();
    const fakeRoot = join(s.dir, "repo");
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
    for (const f of ["put-secrets.sh", "wrangler.sh"]) {
      copyFileSync(join(root, "scripts", f), join(fakeRoot, "scripts", f));
    }
    const env: Record<string, string> = baseEnv(s.keyFile);
    delete env.AWSBRIDGE_KEY_FILE;
    const exec = () =>
      spawnSync("bash", [join(fakeRoot, "scripts/put-secrets.sh")], {
        env: { PATH: `${s.dir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
        encoding: "utf8",
      });
    const missing = exec();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(".secrets/dev-signing-key.json");
    expect(missing.stderr).toContain("keygen");
    expect(read(s.argsFile)).toBe("");
    mkdirSync(join(fakeRoot, ".secrets"));
    writeFileSync(join(fakeRoot, ".secrets/dev-signing-key.json"), KEY_JSON);
    const ok = exec();
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(read(s.stdinFile)).SIGNING_JWK).toBe(KEY_JSON);
  });

  it("鍵ファイルが無ければ終了コード 1", () => {
    const s = setup();
    const r = run(s, { ...baseEnv(s.keyFile), AWSBRIDGE_KEY_FILE: join(s.dir, "missing.json") });
    expect(r.status).toBe(1);
    expect(read(s.argsFile)).toBe("");
  });

  describe("署名鍵のローテーション（ADDITIONAL_PUBLIC_JWKS）", () => {
    // 実在の RSA 2048 公開成分（検証関数を通るもの）。テスト実行ごとに生成する
    const N: Record<string, string> = {};
    beforeAll(async () => {
      for (const name of ["NEXTN", "PREVN", "IGNORED"]) {
        const { publicKey } = await generateKeyPair("RS256", { extractable: true });
        N[name] = (await exportJWK(publicKey)).n as string;
      }
    });
    const PRIV = (name: string) =>
      JSON.stringify({
        kty: "RSA",
        n: N[name],
        e: "AQAB",
        d: `PRIVATE-D-${name}`,
        p: `PRIVATE-P-${name}`,
        q: `PRIVATE-Q-${name}`,
        dp: "x",
        dq: "y",
        qi: "z",
        kid: `kid-${name}`,
        alg: "RS256",
      });
    const additional = (s: ReturnType<typeof setup>) =>
      JSON.parse(JSON.parse(read(s.stdinFile)).ADDITIONAL_PUBLIC_JWKS);

    it("next / previous が無ければ空配列 [] を登録する（前回の追加鍵を消すため）", () => {
      const s = setup();
      const r = run(s, baseEnv(s.keyFile));
      expect(r.status).toBe(0);
      expect(JSON.parse(read(s.stdinFile)).ADDITIONAL_PUBLIC_JWKS).toBe("[]");
    });

    it("既定のパス（KEY_FILE の拡張子の前に .next / .previous）のファイルから公開鍵だけを登録する", () => {
      const s = setup();
      writeFileSync(join(s.dir, "key.next.json"), PRIV("NEXTN"));
      writeFileSync(join(s.dir, "key.previous.json"), PRIV("PREVN"));
      const r = run(s, baseEnv(s.keyFile));
      expect(r.status, r.stderr).toBe(0);
      const keys = additional(s);
      expect(keys).toHaveLength(2);
      expect(keys.map((k: { n: string }) => k.n)).toEqual([N.NEXTN, N.PREVN]);
      for (const k of keys) {
        expect(Object.keys(k).sort()).toEqual(["e", "kty", "n"]);
      }
      const all = read(s.stdinFile);
      // SIGNING_JWK 以外に秘密成分が出ない
      expect(JSON.parse(all).ADDITIONAL_PUBLIC_JWKS).not.toMatch(/PRIVATE|"d"|"p"|"q"/);
      expect(r.stdout + r.stderr).not.toContain("PRIVATE");
      expect(read(s.argsFile)).not.toContain("PRIVATE");
    });

    it("next だけ・previous だけでも登録する", () => {
      const s = setup();
      writeFileSync(join(s.dir, "key.previous.json"), PRIV("PREVN"));
      expect(run(s, baseEnv(s.keyFile)).status).toBe(0);
      expect(additional(s).map((k: { n: string }) => k.n)).toEqual([N.PREVN]);
      const s2 = setup();
      writeFileSync(join(s2.dir, "key.next.json"), PRIV("NEXTN"));
      expect(run(s2, baseEnv(s2.keyFile)).status).toBe(0);
      expect(additional(s2).map((k: { n: string }) => k.n)).toEqual([N.NEXTN]);
    });

    it("AWSBRIDGE_NEXT_KEY_FILE / AWSBRIDGE_PREVIOUS_KEY_FILE で場所を変えられる", () => {
      const s = setup();
      writeFileSync(join(s.dir, "n.json"), PRIV("NEXTN"));
      writeFileSync(join(s.dir, "p.json"), PRIV("PREVN"));
      writeFileSync(join(s.dir, "key.next.json"), PRIV("IGNORED"));
      const r = run(s, {
        ...baseEnv(s.keyFile),
        AWSBRIDGE_NEXT_KEY_FILE: join(s.dir, "n.json"),
        AWSBRIDGE_PREVIOUS_KEY_FILE: join(s.dir, "p.json"),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(additional(s).map((k: { n: string }) => k.n)).toEqual([N.NEXTN, N.PREVN]);
    });

    it("next が JSON でない・RSA 公開成分が無いなら終了コード 1 で wrangler を呼ばない（中身は出さない）", () => {
      for (const bad of [
        "{SECRET-NOT-JSON",
        '{"kty":"oct","k":"SECRET-K"}',
        '{"kty":"RSA","e":"AQAB"}',
      ]) {
        const s = setup();
        writeFileSync(join(s.dir, "key.next.json"), bad);
        const r = run(s, baseEnv(s.keyFile));
        expect(r.status, bad).toBe(1);
        expect(r.stderr).toContain("NEXT_KEY_FILE");
        expect(r.stderr + r.stdout).not.toContain("SECRET");
        expect(read(s.argsFile)).toBe("");
      }
    });

    it("next / previous が Worker と同じ検証を通らない鍵（短い・壊れた base64url・RSA 以外）なら、どのファイルかを示して終了コード 1、wrangler を呼ばない", () => {
      const bads = [
        '{"kty":"RSA","n":"SECRET-SHORT","e":"AQAB"}',
        `{"kty":"RSA","n":"${"!".repeat(342)}","e":"AQAB","d":"SECRET-D"}`,
        '{"kty":"oct","k":"SECRET-K"}',
      ];
      for (const which of ["next", "previous"] as const) {
        for (const bad of bads) {
          const s = setup();
          const file = join(s.dir, `key.${which}.json`);
          writeFileSync(file, bad);
          const r = run(s, baseEnv(s.keyFile));
          expect(r.status, `${which} ${bad}`).toBe(1);
          expect(r.stderr).toContain(file);
          expect(r.stderr + r.stdout).not.toContain("SECRET");
          expect(read(s.argsFile)).toBe("");
        }
      }
    });
  });
});
