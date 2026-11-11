// 人間のログインの設定の置き場所: MCP 用 Worker から切り離されていること（cto の D2）、例・gitignore・mise タスク。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHumanConfig } from "../../src/human/config";
import { generateHumanArtifacts } from "../../src/human/generate";
import { importGraph } from "./import-graph";

const root = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");
const toml = read("mise.toml");

function section(name: string): string {
  const start = toml.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = toml.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

// チェックアウト先のパスに左右されないよう、基準のディレクトリからの相対パスで照合する
const humanFiles = (files: string[], base = root) =>
  files.map((f) => relative(base, f)).filter((f) => /human/i.test(f));

describe("MCP 用 Worker との分離（静的な import）", () => {
  it("src/index.ts から届くモジュールに人間用のコード（src/human/・scripts/）が含まれない", () => {
    const g = importGraph(join(root, "src/index.ts"));
    // 陽性の対照: MCP 用の本体は届いている（パスの照合が壊れていれば落ちる）
    expect(g.files).toContain(join(root, "src/handler.ts"));
    expect(g.files).toContain(join(root, "src/profiles.ts"));
    expect(humanFiles(g.files)).toEqual([]);
    expect(g.files.map((f) => relative(root, f)).filter((f) => !f.startsWith("src/"))).toEqual([]);
    expect(g.bare.filter((b) => /human/i.test(b))).toEqual([]);
  });

  it("判定は、人間用のモジュールを import するエントリを検出できる", () => {
    const d = mkdtempSync(join(tmpdir(), "awsbridge-graph-"));
    mkdirSync(join(d, "human"));
    writeFileSync(join(d, "index.ts"), 'import { a } from "./mid";\nexport default a;\n');
    writeFileSync(
      join(d, "mid.ts"),
      'export {\n  parse as a,\n} from "./human/config";\nimport "awsbridge:human";\n',
    );
    writeFileSync(join(d, "human", "config.ts"), "export const parse = 1;\n");
    const g = importGraph(join(d, "index.ts"));
    expect(humanFiles(g.files, d)).toEqual(["human/config.ts"]);
    expect(g.bare).toEqual(["awsbridge:human"]);
  });

  it("人間用のコード（src/human/）は MCP 用のエントリ・ハンドラーを import しない", () => {
    for (const f of ["src/human/config.ts", "src/human/generate.ts"]) {
      const g = importGraph(join(root, f));
      for (const mcp of ["src/index.ts", "src/handler.ts", "src/proxy.ts"]) {
        expect(g.files, `${f} → ${mcp}`).not.toContain(join(root, mcp));
      }
      // Worker でも使えるよう、node の API に依存しない
      expect(
        g.bare.filter((b) => b.startsWith("node:")),
        f,
      ).toEqual([]);
    }
  });
});

describe("設定の例（config/human*.example.json）", () => {
  it.each(["config/human.example.json", "config/human.company.example.json"])(
    "%s は検証と生成（check）を警告なしで通る",
    (p) => {
      const { config, warnings } = parseHumanConfig(read(p));
      expect(warnings).toEqual([]);
      expect(generateHumanArtifacts(config, { mode: "check", generatedAt: "x" }).warnings).toEqual(
        [],
      );
    },
  );

  it("個人用の例は Admin の階層を持たず、会社用の例は持つ", () => {
    const personal = parseHumanConfig(read("config/human.example.json")).config;
    const company = parseHumanConfig(read("config/human.company.example.json")).config;
    expect(personal.teams.every((t) => t.tier === "standard")).toBe(true);
    expect(company.teams.some((t) => t.tier === "admin")).toBe(true);
    expect(company.organizations.some((o) => o.boundary.startsWith("partner:"))).toBe(true);
  });

  it("例はダミーの値だけを持つ（アカウント ID・ドメイン・email）", () => {
    for (const p of ["config/human.example.json", "config/human.company.example.json"]) {
      const raw = read(p);
      const ids = new Set([...raw.matchAll(/(?<![-\d])(\d{12})(?!\d)/g)].map((m) => m[1]));
      for (const id of ids) expect(["111111111111", "222222222222"], `${p}: ${id}`).toContain(id);
      const hosts = [...raw.matchAll(/https:\/\/([^/"]+)/g)].map((m) => m[1] ?? "");
      for (const h of hosts) expect(h, `${p}: ${h}`).toMatch(/(^|\.)example\.(com|org)$/);
      const mails = [...raw.matchAll(/@([a-z0-9.-]+)/gi)].map((m) => m[1] ?? "");
      for (const m of mails) expect(m, `${p}: ${m}`).toMatch(/^example\.(com|org)$/);
    }
  });

  it("実物の設定と生成物は gitignore する", () => {
    const lines = read(".gitignore").split("\n");
    expect(lines).toContain("config/human.json");
    expect(lines).toContain(".generated/");
  });
});

describe("mise タスク（human:config:*）", () => {
  it.each([
    ["check", 'tasks."human:config:check"'],
    ["generate", 'tasks."human:config:generate"'],
  ])("%s は scripts/human/config.ts を呼び、wrangler・aws・terraform を呼ばない", (cmd, name) => {
    const run = /^run\s*=.*$/m.exec(section(name))?.[0] ?? "";
    expect(run).toContain(`scripts/human/config.ts ${cmd}`);
    expect(run).not.toMatch(/wrangler|\baws\b|terraform/);
  });

  it("入力と出力の場所の既定値を [env] に置かない（下流の mise 設定ファイルで上書きできるように）", () => {
    const env = section("env");
    for (const n of [
      "AWSBRIDGE_HUMAN_CONFIG",
      "AWSBRIDGE_HUMAN_AUD_FILE",
      "AWSBRIDGE_HUMAN_INVENTORY_FILE",
      "AWSBRIDGE_HUMAN_OUT_DIR",
    ]) {
      expect(env, n).not.toMatch(new RegExp(`^${n}\\s*=`, "m"));
    }
  });
});
