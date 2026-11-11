// MCP 用 Worker の実際のバンドル（wrangler deploy --dry-run）に、人間のログインのコードが入らないことを確かめる（cto の D2 の条件）。
// esbuild の metafile の inputs（バンドルに読み込んだモジュール）と、出力の本文の両方を見る。デプロイはしない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PATH, TEAM_TAG_KEY } from "../../src/human/config";

const root = new URL("../../", import.meta.url).pathname;
let out = "";
let inputs: string[] = [];
let bundle = "";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "awsbridge-mcp-bundle-"));
  // リポジトリの wrangler.jsonc を読み、main を絶対パスに、alias を例のファイルに差し替えて使う
  // （config/profiles.json は gitignore。CLI の --alias は "awsbridge:profiles" のコロンで分かれてしまい効かない）。
  const config = JSON.parse(
    readFileSync(join(root, "wrangler.jsonc"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  ) as Record<string, unknown>;
  expect(config.main).toBe("src/index.ts");
  config.main = join(root, "src/index.ts");
  config.alias = { "awsbridge:profiles": join(root, "config/profiles.example.json") };
  delete config.env;
  const wranglerConfig = join(out, "wrangler.bundle.json");
  writeFileSync(wranglerConfig, JSON.stringify(config));
  const r = spawnSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "deploy",
      "--dry-run",
      "--config",
      wranglerConfig,
      "--outdir",
      join(out, "dist"),
      "--metafile",
      join(out, "meta.json"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as {
    inputs: Record<string, unknown>;
  };
  // inputs のパスは cwd（リポジトリのルート）からの相対。照合はチェックアウト先のパスに左右されないよう、ルートからの相対パスで行う
  inputs = Object.keys(meta.inputs).map((p) => relative(root, resolve(root, p)));
  bundle = readdirSync(join(out, "dist"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(out, "dist", f), "utf8"))
    .join("\n");
}, 90_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("MCP 用 Worker のバンドル", () => {
  it("陽性の対照: MCP 用のモジュールとプロファイル一覧は入っている", () => {
    expect(inputs).toContain("src/handler.ts");
    expect(inputs).toContain("config/profiles.example.json");
    expect(bundle).toContain("list_aws_profiles");
  });

  it("人間用のモジュール（src/human/・scripts/）を読み込まない", () => {
    expect(inputs.filter((p) => p.startsWith("src/human/"))).toEqual([]);
    expect(inputs.filter((p) => p.startsWith("scripts/"))).toEqual([]);
    expect(inputs.filter((p) => /human/i.test(p))).toEqual([]);
  });

  it("人間用の固定の名前（タグのキー・ロールのパス・ポータルの経路）が本文にない", () => {
    expect(bundle).not.toContain(TEAM_TAG_KEY);
    expect(bundle).not.toContain(ROLE_PATH);
    expect(bundle).not.toContain("/t/");
  });
});
