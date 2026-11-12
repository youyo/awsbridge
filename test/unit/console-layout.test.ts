// コンソールログインの設定の置き場所: MCP 用 Worker から切り離されていること（cto の D2）、例・gitignore・mise タスク。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConsoleConfig } from "../../src/console/config";
import { generateConsoleArtifacts } from "../../src/console/generate";
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

// コンソールログイン用のコードの目印: パスの区切りで始まる console（src/console/・scripts/console/ など）と、
// PoC の名前の human（scripts/poc/human/）。素の文字列 console は JavaScript のグローバル名なので、パスの区切りで照合する。
const LOGIN_PATH_RE = /(^|\/)console([/.-]|$)|human/i;
const LOGIN_BARE_RE = /console|human/i;
// チェックアウト先のパスに左右されないよう、基準のディレクトリからの相対パスで照合する
const loginFiles = (files: string[], base = root) =>
  files.map((f) => relative(base, f)).filter((f) => LOGIN_PATH_RE.test(f));

describe("MCP 用 Worker との分離（静的な import）", () => {
  it("src/index.ts から届くモジュールにコンソールログイン用のコード（src/console/・scripts/）が含まれない", () => {
    const g = importGraph(join(root, "src/index.ts"));
    // 陽性の対照: MCP 用の本体は届いている（パスの照合が壊れていれば落ちる）
    expect(g.files).toContain(join(root, "src/handler.ts"));
    expect(g.files).toContain(join(root, "src/profiles.ts"));
    expect(loginFiles(g.files)).toEqual([]);
    expect(g.files.map((f) => relative(root, f)).filter((f) => !f.startsWith("src/"))).toEqual([]);
    expect(g.bare.filter((b) => LOGIN_BARE_RE.test(b))).toEqual([]);
  });

  it("判定は、コンソールログイン用のモジュールを import するエントリを検出できる", () => {
    const d = mkdtempSync(join(tmpdir(), "awsbridge-graph-"));
    mkdirSync(join(d, "console"));
    mkdirSync(join(d, "poc", "human"), { recursive: true });
    writeFileSync(join(d, "index.ts"), 'import { a } from "./mid";\nexport default a;\n');
    writeFileSync(
      join(d, "mid.ts"),
      'export {\n  parse as a,\n} from "./console/config";\nimport "./poc/human/lib";\nimport "awsbridge:console";\n',
    );
    writeFileSync(join(d, "console", "config.ts"), "export const parse = 1;\n");
    writeFileSync(join(d, "poc", "human", "lib.ts"), "export {};\n");
    const g = importGraph(join(d, "index.ts"));
    expect(loginFiles(g.files, d)).toEqual(["console/config.ts", "poc/human/lib.ts"]);
    expect(g.bare).toEqual(["awsbridge:console"]);
  });

  it("コンソールログイン用のコード（src/console/）は MCP 用のエントリ・ハンドラーを import しない", () => {
    for (const f of [
      "src/console/constants.ts",
      "src/console/types.ts",
      "src/console/config.ts",
      "src/console/generate.ts",
      "src/console/guard.ts",
      "src/console/inspect.ts",
      "src/console/access-inspect.ts",
      "src/console/issue/claims.ts",
      "src/console/issue/errors.ts",
      "src/console/issue/federation.ts",
      "src/console/issue/identity.ts",
      "src/console/issue/record.ts",
      "src/console/issue/sign-standard.ts",
      "src/console/issue/signer.ts",
    ]) {
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

describe("検査の道具（src/console/inspect.ts）の置き場所", () => {
  const INSPECT = [
    "src/console/inspect.ts",
    "src/console/guard.ts",
    "src/console/access-inspect.ts",
  ];

  /** リポジトリの wrangler の設定（node_modules を除く）の main（Worker のエントリ）。 */
  function workerEntries(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const rel = dir === "" ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/^wrangler.*\.jsonc?$/.test(e.name)) {
          const main = /"main"\s*:\s*"([^"]+)"/.exec(read(rel))?.[1];
          if (main) found.push(join(root, dir, main));
        }
      }
    };
    walk("");
    return found;
  }

  it("どの Worker のエントリ（wrangler の main）からも届かない", () => {
    const entries = workerEntries();
    // 陽性の対照: MCP 用と PoC の Worker のエントリを見つけている
    expect(entries.map((f) => relative(root, f))).toEqual(
      expect.arrayContaining(["src/index.ts", "scripts/poc/human/worker.ts"]),
    );
    for (const entry of entries) {
      const files = importGraph(entry).files.map((f) => relative(root, f));
      for (const f of INSPECT) expect(files, `${relative(root, entry)} → ${f}`).not.toContain(f);
    }
  });

  it("src/ と scripts/ のうち検査の判定を（間接にでも）import するのは読み取りの CLI（scripts/console/inspect*.ts）だけ", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (rel.endsWith(".ts") && !INSPECT.includes(rel)) {
          const direct = importGraph(join(root, rel)).files.map((f) => relative(root, f));
          if (direct.includes("src/console/inspect.ts")) importers.push(rel);
        }
      }
    };
    walk("src");
    walk("scripts");
    // 読み取りの CLI とその部品（scripts/console/inspect-read.ts）だけ。陽性の対照として CLI を含むこと
    expect(importers.sort()).toEqual([
      "scripts/console/inspect-read.ts",
      "scripts/console/inspect.ts",
    ]);
  });
});

describe("設定の例（config/console*.example.json）", () => {
  it.each(["config/console.example.json", "config/console.company.example.json"])(
    "%s は検証と生成（check）を警告なしで通る",
    (p) => {
      const { config, warnings } = parseConsoleConfig(read(p));
      expect(warnings).toEqual([]);
      expect(
        generateConsoleArtifacts(config, { mode: "check", generatedAt: "x" }).warnings,
      ).toEqual([]);
    },
  );

  it("個人用の例は Admin の階層を持たず、会社用の例は持つ", () => {
    const personal = parseConsoleConfig(read("config/console.example.json")).config;
    const company = parseConsoleConfig(read("config/console.company.example.json")).config;
    expect(personal.teams.every((t) => t.tier === "standard")).toBe(true);
    expect(company.teams.some((t) => t.tier === "admin")).toBe(true);
    expect(company.organizations.some((o) => o.boundary.startsWith("partner:"))).toBe(true);
  });

  it("例の人のロールは Viewer（Standard）と Administrator（Admin）だけで、名前は FederatedAwsBridge*（cto の決裁 2026-11-12。Developer は廃止）", () => {
    const roles = (p: string) =>
      parseConsoleConfig(read(p)).config.roles.map((r) => [r.name, r.roleName, r.tier]);
    expect(roles("config/console.example.json")).toEqual([
      ["viewer", "FederatedAwsBridgeViewer", "standard"],
    ]);
    expect(roles("config/console.company.example.json")).toEqual([
      ["administrator", "FederatedAwsBridgeAdministrator", "admin"],
      ["viewer", "FederatedAwsBridgeViewer", "standard"],
    ]);
  });

  it("例に Developer（PowerUserAccess 系）のロールを置かない", () => {
    for (const p of ["config/console.example.json", "config/console.company.example.json"]) {
      const raw = read(p);
      expect(raw, p).not.toMatch(/developer|PowerUserAccess/i);
    }
  });

  it("会社用の例は SourceIdentity の出どころ（identity.sourceIdentity）を email と明示する", () => {
    const { config } = parseConsoleConfig(read("config/console.company.example.json"));
    expect(config.identity.sourceIdentity).toBe("email");
    expect(JSON.parse(read("config/console.company.example.json")).identity).toEqual({
      sourceIdentity: "email",
    });
  });

  it("会社用の例（Admin のチームが 2 つ）は admin の入口の AUD なしで deploy 生成できる", () => {
    const { config } = parseConsoleConfig(read("config/console.company.example.json"));
    expect(config.teams.filter((t) => t.tier === "admin")).toHaveLength(2);
    const teams = Object.fromEntries(
      config.teams.map((t, i) => [t.name, String(i + 1).repeat(64)]),
    );
    const r = generateConsoleArtifacts(config, {
      mode: "deploy",
      generatedAt: "x",
      auds: { teams, entry: { standard: "a".repeat(64) } },
    });
    expect(r.worker.admin?.teams).toHaveLength(2);
    expect(r.display.groups).toHaveLength(5);
  });

  it("例はダミーの値だけを持つ（アカウント ID・ドメイン・email）", () => {
    for (const p of ["config/console.example.json", "config/console.company.example.json"]) {
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
    expect(lines).toContain("config/console.json");
    expect(lines).toContain(".generated/");
  });
});

describe("mise タスク（console:config:*）", () => {
  it.each([
    ["check", 'tasks."console:config:check"'],
    ["generate", 'tasks."console:config:generate"'],
  ])("%s は scripts/console/config.ts を呼び、wrangler・aws・terraform を呼ばない", (cmd, name) => {
    const run = /^run\s*=.*$/m.exec(section(name))?.[0] ?? "";
    expect(run).toContain(`scripts/console/config.ts ${cmd}`);
    expect(run).not.toMatch(/wrangler|\baws\b|terraform/);
  });

  it("console:inspect は scripts/console/inspect.ts を呼び、wrangler・terraform を呼ばない（aws の読み取りはスクリプトの中だけ）", () => {
    const run = /^run\s*=.*$/m.exec(section('tasks."console:inspect"'))?.[0] ?? "";
    expect(run).toContain("scripts/console/inspect.ts");
    expect(run).not.toMatch(/wrangler|\baws\b|terraform/);
  });

  it("console:access:inspect は scripts/console/access-inspect.ts を呼び、wrangler・aws・terraform を呼ばない（Cloudflare API の読み取りはスクリプトの中だけ）", () => {
    const run = /^run\s*=.*$/m.exec(section('tasks."console:access:inspect"'))?.[0] ?? "";
    expect(run).toContain("scripts/console/access-inspect.ts");
    expect(run).not.toMatch(/wrangler|\baws\b|terraform/);
  });

  it("入力と出力の場所の既定値を [env] に置かない（下流の mise 設定ファイルで上書きできるように）", () => {
    const env = section("env");
    for (const n of [
      "AWSBRIDGE_CONSOLE_CONFIG",
      "AWSBRIDGE_CONSOLE_AUD_FILE",
      "AWSBRIDGE_CONSOLE_INVENTORY_FILE",
      "AWSBRIDGE_CONSOLE_OUT_DIR",
    ]) {
      expect(env, n).not.toMatch(new RegExp(`^${n}\\s*=`, "m"));
    }
  });
});
