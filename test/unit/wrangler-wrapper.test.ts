import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// 偽 pnpm が受けた引数を 1 行 1 引数で記録する
function run(args: string[], env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "awsbridge-wrangler-"));
  tmpDirs.push(dir);
  const argsFile = join(dir, "args.txt");
  writeFileSync(
    join(dir, "pnpm"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argsFile}"; done\n`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  const r = spawnSync("bash", [join(root, "scripts/wrangler.sh"), ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  let got: string[] = [];
  try {
    got = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
  } catch {
    // 呼ばれていない
  }
  return { ...r, got };
}

describe("scripts/wrangler.sh", () => {
  it("未設定なら upstream の既定（wrangler.jsonc と --env dev）を使う", () => {
    const r = run(["deploy", "--dry-run"], {});
    expect(r.status).toBe(0);
    expect(r.got).toEqual([
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      "wrangler.jsonc",
      "--env",
      "dev",
    ]);
  });
  it("AWSBRIDGE_WRANGLER_CONFIG を --config に反映する", () => {
    const r = run(["dev"], { AWSBRIDGE_WRANGLER_CONFIG: "wrangler.awsbridge-mcp.jsonc" });
    expect(r.got).toEqual(expect.arrayContaining(["--config", "wrangler.awsbridge-mcp.jsonc"]));
    expect(r.got).not.toContain("wrangler.jsonc");
  });
  it("AWSBRIDGE_WRANGLER_ENV が空文字なら --env を付けない（未設定とは区別する）", () => {
    const r = run(["deploy"], {
      AWSBRIDGE_WRANGLER_ENV: "",
      AWSBRIDGE_WRANGLER_DEPLOY_MODE: "deploy",
    });
    expect(r.got).not.toContain("--env");
    expect(r.got).toEqual(expect.arrayContaining(["--config", "wrangler.jsonc"]));
  });
  it("AWSBRIDGE_WRANGLER_ENV に値があれば --env に渡す", () => {
    const r = run(["deploy"], {
      AWSBRIDGE_WRANGLER_ENV: "prod",
      AWSBRIDGE_WRANGLER_DEPLOY_MODE: "deploy",
    });
    expect(r.got).toEqual(expect.arrayContaining(["--env", "prod"]));
  });
  it("空白や記号を含む引数を壊さずに渡す", () => {
    const r = run(["deploy", "--var", "ISSUER:https://x.example/ a"], {
      AWSBRIDGE_WRANGLER_DEPLOY_MODE: "deploy",
    });
    expect(r.got).toContain("ISSUER:https://x.example/ a");
  });
});

// 呼び出しごとに引数を記録し、サブコマンド別に出力と終了コードを返す偽 pnpm
const SEP = "\u001f";
function runVersions(args: string[], env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "awsbridge-wrangler-"));
  tmpDirs.push(dir);
  const callsFile = join(dir, "calls.txt");
  writeFileSync(
    join(dir, "pnpm"),
    `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a" >> "${callsFile}"; done
printf '\\n' >> "${callsFile}"
case "$*" in
  *"versions upload"*) printf '%s\\n' "$STUB_UPLOAD_OUTPUT"; exit "\${STUB_UPLOAD_EXIT:-0}" ;;
  *"versions deploy"*) exit "\${STUB_DEPLOY_EXIT:-0}" ;;
esac
`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  const r = spawnSync("bash", [join(root, "scripts/wrangler.sh"), ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  let calls: string[][] = [];
  try {
    calls = readFileSync(callsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(SEP).filter((x) => x !== ""));
  } catch {
    // 呼ばれていない
  }
  return { ...r, calls };
}

const VID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UPLOAD_OK = `Total Upload: 1.00 KiB / gzip: 0.50 KiB\nUploaded awsbridge (1.00 sec)\nWorker Version ID: ${VID}\nTo deploy this version to production traffic use the command "wrangler versions deploy"`;

describe("scripts/wrangler.sh deploy（既定は versions upload + versions deploy）", () => {
  it("既定では versions upload のあと versions deploy <id>@100% --yes を流し、deploy は流さない", () => {
    const r = runVersions(["deploy", "--var", "ISSUER:https://x.example"], {
      STUB_UPLOAD_OUTPUT: UPLOAD_OK,
    });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      [
        "exec",
        "wrangler",
        "versions",
        "upload",
        "--var",
        "ISSUER:https://x.example",
        "--config",
        "wrangler.jsonc",
        "--env",
        "dev",
      ],
      [
        "exec",
        "wrangler",
        "versions",
        "deploy",
        `${VID}@100%`,
        "--yes",
        "--config",
        "wrangler.jsonc",
        "--env",
        "dev",
      ],
    ]);
    expect(r.calls.flat()).not.toContain("deploy-only");
    expect(r.calls.some((c) => c[2] === "deploy")).toBe(false);
  });
  it("--config と --env は upload と deploy の両方に同じ値で渡る", () => {
    const r = runVersions(["deploy"], {
      STUB_UPLOAD_OUTPUT: UPLOAD_OK,
      AWSBRIDGE_WRANGLER_CONFIG: "wrangler.awsbridge-mcp.jsonc",
      AWSBRIDGE_WRANGLER_ENV: "prod",
    });
    expect(r.status).toBe(0);
    for (const c of r.calls) {
      expect(c).toEqual(
        expect.arrayContaining(["--config", "wrangler.awsbridge-mcp.jsonc", "--env", "prod"]),
      );
    }
  });
  it("AWSBRIDGE_WRANGLER_ENV が空文字なら --env を付けない", () => {
    const r = runVersions(["deploy"], {
      STUB_UPLOAD_OUTPUT: UPLOAD_OK,
      AWSBRIDGE_WRANGLER_ENV: "",
    });
    expect(r.status).toBe(0);
    expect(r.calls.flat()).not.toContain("--env");
  });
  it("versions upload が受け付ける引数（--var・--message・--tag・--outdir・--minify・--keep-vars）を引き継ぐ。空白を含む値も壊さない", () => {
    const r = runVersions(
      [
        "deploy",
        "--var",
        "A:b c",
        "--message",
        "m s g",
        "--tag",
        "t1",
        "--outdir",
        "dist/x",
        "--minify",
        "--keep-vars",
      ],
      { STUB_UPLOAD_OUTPUT: UPLOAD_OK },
    );
    expect(r.status).toBe(0);
    expect(r.calls[0]).toEqual(
      expect.arrayContaining([
        "--var",
        "A:b c",
        "--message",
        "m s g",
        "--tag",
        "t1",
        "--outdir",
        "dist/x",
        "--minify",
        "--keep-vars",
      ]),
    );
    // versions deploy には upload 専用の引数を渡さない
    expect(r.calls[1]).not.toContain("--var");
    expect(r.calls[1]).not.toContain("--outdir");
  });
  it("--var=KEY:VAL の形も受け付ける", () => {
    const r = runVersions(["deploy", "--var=ISSUER:https://x.example"], {
      STUB_UPLOAD_OUTPUT: UPLOAD_OK,
    });
    expect(r.status).toBe(0);
    expect(r.calls[0]).toContain("--var=ISSUER:https://x.example");
  });
  it("versions upload が受け付けない引数（--routes・--triggers など）は黙って捨てず、何も流さずエラーで止める", () => {
    for (const bad of [
      ["--routes", "x.example.com/*"],
      ["--triggers"],
      ["--domain", "x.example.com"],
      ["entry.ts"],
    ]) {
      const r = runVersions(["deploy", ...bad], { STUB_UPLOAD_OUTPUT: UPLOAD_OK });
      expect(r.status).not.toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.stderr).toContain(bad[0]);
      expect(r.stderr).toContain("AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy");
    }
  });
  it("引数の --config / --env は受け付けない（ラッパーの環境変数で指定する）", () => {
    const r = runVersions(["deploy", "--env", "prod"], { STUB_UPLOAD_OUTPUT: UPLOAD_OK });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
  it("値が必要な引数に値が無ければエラーで止める", () => {
    const r = runVersions(["deploy", "--var"], { STUB_UPLOAD_OUTPUT: UPLOAD_OK });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
  it("出力から Version ID が取れなければ exit 1 で、versions deploy を流さない", () => {
    const r = runVersions(["deploy"], { STUB_UPLOAD_OUTPUT: "Uploaded awsbridge (1.00 sec)" });
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.stderr).toContain("Version ID");
  });
  it("Version ID の形が UUID でなければ取れなかったものとして扱う", () => {
    const r = runVersions(["deploy"], {
      STUB_UPLOAD_OUTPUT: "Worker Version ID: not-a-uuid; rm -rf /",
    });
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(1);
  });
  it("色付き（ANSI）の出力からも Version ID を取り出す", () => {
    const r = runVersions(["deploy"], {
      STUB_UPLOAD_OUTPUT: `\u001b[1mWorker Version ID:\u001b[0m ${VID}`,
    });
    expect(r.status).toBe(0);
    expect(r.calls[1]).toContain(`${VID}@100%`);
  });
  it("versions upload が失敗したら、その終了コードで止まり、versions deploy を流さない", () => {
    const r = runVersions(["deploy"], { STUB_UPLOAD_OUTPUT: UPLOAD_OK, STUB_UPLOAD_EXIT: "3" });
    expect(r.status).toBe(3);
    expect(r.calls).toHaveLength(1);
  });
  it("versions deploy が失敗したら、その終了コードで終わる", () => {
    const r = runVersions(["deploy"], { STUB_UPLOAD_OUTPUT: UPLOAD_OK, STUB_DEPLOY_EXIT: "4" });
    expect(r.status).toBe(4);
    expect(r.calls).toHaveLength(2);
  });
  it("upload の出力は利用者にも見える", () => {
    const r = runVersions(["deploy"], { STUB_UPLOAD_OUTPUT: UPLOAD_OK });
    expect(r.stdout).toContain(`Worker Version ID: ${VID}`);
  });
  it("--dry-run を含む deploy は今までどおり wrangler deploy を流す", () => {
    const r = runVersions(["deploy", "--dry-run", "--outdir", "dist"], {});
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        "dist",
        "--config",
        "wrangler.jsonc",
        "--env",
        "dev",
      ],
    ]);
  });
  it("AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy なら wrangler deploy（triggers の同期を含む）を流す", () => {
    const r = runVersions(["deploy", "--var", "A:b"], { AWSBRIDGE_WRANGLER_DEPLOY_MODE: "deploy" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      ["exec", "wrangler", "deploy", "--var", "A:b", "--config", "wrangler.jsonc", "--env", "dev"],
    ]);
  });
  it("AWSBRIDGE_WRANGLER_DEPLOY_MODE が versions なら既定と同じ経路", () => {
    const r = runVersions(["deploy"], {
      AWSBRIDGE_WRANGLER_DEPLOY_MODE: "versions",
      STUB_UPLOAD_OUTPUT: UPLOAD_OK,
    });
    expect(r.status).toBe(0);
    expect(r.calls[0]?.slice(2, 4)).toEqual(["versions", "upload"]);
  });
  it("AWSBRIDGE_WRANGLER_DEPLOY_MODE が versions / deploy 以外なら何も流さずエラー", () => {
    const r = runVersions(["deploy"], {
      AWSBRIDGE_WRANGLER_DEPLOY_MODE: "yes",
      STUB_UPLOAD_OUTPUT: UPLOAD_OK,
    });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
  it("deploy 以外のサブコマンド（dev など）はモードに関係なくそのまま渡す", () => {
    const r = runVersions(["dev"], {});
    expect(r.calls).toEqual([
      ["exec", "wrangler", "dev", "--config", "wrangler.jsonc", "--env", "dev"],
    ]);
  });
});
