// コンソールログインの Standard の Worker の実際のバンドル（wrangler deploy --dry-run）と wrangler の設定の例を確かめる。
// 設計: docs/specs/console-login-portal.md §9.10（Standard のバンドルに Admin の発行に使える値・MCP のコードが入らない）、
//       ADR の P1'・U2（Standard のバンドルに入れてよい Admin の情報は表示用だけ。Admin のチーム名・表示用の行・Object ID は可、
//       Admin の AUD・Admin のロールの ARN・Admin の issuer は不可。2026-11-12 に分離の試験を引き直した）、
//       console-login.md §5 の T11（Access を経由しない入口: workers.dev・Preview URL を閉じる）。デプロイはしない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConsoleConfig } from "../../src/console/config";
import { generateConsoleArtifacts } from "../../src/console/generate";
import { readJsonc } from "./jsonc";

const root = new URL("../../", import.meta.url).pathname;
const CONFIG_FILE = "wrangler.console-standard.jsonc";

// 照合しやすい AUD（英数字 16〜128 文字）
const AUD = {
  infra: `stdinfraaud${"1".repeat(40)}`,
  dev: `stddevaud${"2".repeat(40)}`,
  sa: `stdsaaud${"3".repeat(40)}`,
  "infra-elevated": `admininfraaud${"4".repeat(40)}`,
  "dev-elevated": `admindevaud${"5".repeat(40)}`,
};
const ENTRY_STD = `stdentryaud${"6".repeat(40)}`;
const ENTRY_ADMIN = `adminentryaud${"7".repeat(40)}`;

// Admin の発行に使える値（Admin の生成物にだけあり、Standard のバンドルに入ってはならない）
const ADMIN_ONLY = [
  AUD["infra-elevated"],
  AUD["dev-elevated"],
  ENTRY_ADMIN,
  "https://id.example.com/admin",
  "/awsbridge-console/admin/",
  "FederatedAwsBridgeAdministrator",
];
// 表示用だけの Admin の情報（Standard のバンドルに入ってよい。表示用の生成物から入る）
const ADMIN_DISPLAY = ["infra-elevated", "dev-elevated", "00000000-0000-0000-0000-000000000004"];

let out = "";
let inputs: string[] = [];
let bundle = "";
let config: Record<string, unknown> = {};
let standardJson = "";
let adminJson = "";
let displayJson = "";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "awsbridge-console-std-bundle-"));
  config = readJsonc(join(root, CONFIG_FILE));

  // 会社用の例から、Standard と Admin の生成物を作る（Admin の生成物は比較のためだけ。Standard のバンドルには入らないこと）
  const { config: consoleConfig } = parseConsoleConfig(
    readFileSync(join(root, "config/console.company.example.json"), "utf8"),
  );
  const artifacts = generateConsoleArtifacts(consoleConfig, {
    mode: "deploy",
    generatedAt: "2026-11-12T00:00:00.000Z",
    auds: { teams: AUD, entry: { standard: ENTRY_STD, admin: ENTRY_ADMIN } },
    inventory: {
      "org-main": [
        { accountId: "111111111111", name: "svc-a-prod", ouPath: ["r-abcd", "ou-abcd-11111111"] },
        { accountId: "111111111112", name: "svc-c-dev", ouPath: ["r-abcd", "ou-abcd-33333333"] },
      ],
    },
  });
  standardJson = join(out, "worker.standard.json");
  writeFileSync(standardJson, JSON.stringify(artifacts.worker.standard));
  adminJson = join(out, "worker.admin.json");
  writeFileSync(adminJson, JSON.stringify(artifacts.worker.admin));
  displayJson = join(out, "display.standard.json");
  writeFileSync(displayJson, JSON.stringify(artifacts.display));

  const bundleConfig = {
    ...config,
    $schema: undefined,
    main: join(root, config.main as string),
    alias: { "awsbridge:console-worker": standardJson, "awsbridge:console-display": displayJson },
  };
  const wranglerConfig = join(out, "wrangler.bundle.json");
  writeFileSync(wranglerConfig, JSON.stringify(bundleConfig));
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
  inputs = Object.keys(meta.inputs).map((p) => relative(root, resolve(root, p)));
  bundle = readdirSync(join(out, "dist"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(out, "dist", f), "utf8"))
    .join("\n");
}, 90_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("wrangler.console-standard.jsonc（設定の例）", () => {
  it("入口は Custom Domain だけ（workers.dev・Preview URL は無効。Access を経由しない入口を閉じる）", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    const routes = config.routes as { pattern: string; custom_domain?: boolean }[];
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.custom_domain, r.pattern).toBe(true);
      expect(r.pattern).not.toMatch(/workers\.dev|\*|\//);
      expect(r.pattern).toMatch(/(^|\.)example\.com$/);
    }
    expect(config).not.toHaveProperty("env");
  });

  it("エントリと生成物の alias、回数の制限の binding、vars（ACCESS_TEAM_DOMAIN など）を持ち、secret を vars に書かない", () => {
    expect(config.main).toBe("src/console/standard/index.ts");
    expect(config.alias).toEqual({
      "awsbridge:console-worker": "./.generated/console/worker.standard.json",
      "awsbridge:console-display": "./.generated/console/display.standard.json",
    });
    // 静的なファイルはバンドルに埋め込む（Workers の静的アセットは Worker より先に返るので使わない）
    expect(config).not.toHaveProperty("assets");
    const rl = config.ratelimits as {
      name: string;
      namespace_id: string;
      simple: { limit: number; period: number };
    }[];
    expect(rl).toHaveLength(1);
    expect(rl[0]?.name).toBe("LOGIN_RATE_LIMITER");
    expect(rl[0]?.simple.limit).toBeGreaterThan(0);
    expect([10, 60]).toContain(rl[0]?.simple.period);
    const vars = config.vars as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual([
      "ACCESS_TEAM_DOMAIN",
      "LOGIN_DISABLED",
      "STS_REGION",
    ]);
    expect(vars.ACCESS_TEAM_DOMAIN).toMatch(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
    expect(vars.LOGIN_DISABLED).toBe("false");
    const raw = readFileSync(join(root, CONFIG_FILE), "utf8");
    // secret は名前だけ（説明のコメント）で、値はない
    expect(raw).toContain("CONSOLE_SIGNING_KEYS");
    expect(raw).toContain("CONSOLE_CSRF_KEY");
    expect(vars).not.toHaveProperty("CONSOLE_SIGNING_KEYS");
    expect(vars).not.toHaveProperty("CONSOLE_CSRF_KEY");
  });
});

describe("Standard の Worker のバンドル", () => {
  it("陽性の対照: エントリ・発行の経路・Standard の生成物（Standard の AUD）は入っている", () => {
    expect(inputs).toContain("src/console/standard/index.ts");
    expect(inputs).toContain("src/console/portal/login.ts");
    expect(inputs).toContain("src/console/issue/sign-standard.ts");
    // 生成物のパスは wrangler の設定のディレクトリからの相対で記録されるので、名前で照合する
    expect(inputs.filter((p) => p.endsWith("worker.standard.json"))).toHaveLength(1);
    expect(bundle).toContain(AUD.infra);
    expect(bundle).toContain(ENTRY_STD);
    expect(bundle).toContain("https://id.example.com/standard");
  });

  it("Admin の発行に使える値（Admin のチームの AUD・Admin の入口の AUD・Admin の issuer・Admin のロールの ARN とロール名）が入らない", () => {
    expect(inputs.filter((p) => p.endsWith("worker.admin.json"))).toEqual([]);
    for (const s of ADMIN_ONLY) {
      expect(bundle, s).not.toContain(s);
    }
    // Admin の鍵（KMS）の参照を持たない
    expect(bundle).not.toMatch(/\bkms\b/i);
  });

  it("陽性の対照: 上の Admin の固有値は、Admin の生成物（worker.admin.json）には実際にある（入らないことの試験が空振りしていない）", () => {
    const admin = readFileSync(adminJson, "utf8");
    for (const s of ADMIN_ONLY) expect(admin, s).toContain(s);
    // 逆向きの対照: Standard の生成物（発行用・表示用）には、Admin の発行に使える値がない
    const std = readFileSync(standardJson, "utf8");
    for (const s of ADMIN_ONLY) expect(std, s).not.toContain(s);
    const display = readFileSync(displayJson, "utf8");
    for (const s of ADMIN_ONLY) expect(display, s).not.toContain(s);
  });

  it("表示用の生成物（入口の一覧）は入っていて、表示用の Admin の情報（チーム名・Object ID）だけを持つ", () => {
    expect(inputs.filter((p) => p.endsWith("display.standard.json"))).toHaveLength(1);
    expect(inputs).toContain("src/console/display/entry.ts");
    for (const s of ADMIN_DISPLAY) expect(bundle, s).toContain(s);
    // Admin のバンドルの「表示用が無い」の試験（console-admin-bundle.test.ts）の陽性の対照
    expect(bundle).toContain("membership unknown");
    expect(bundle).toContain("no_group_table");
    expect(bundle).toContain("00000000-0000-0000-0000-000000000001");
    // 表示用の Administrator の行は email を持たない（司令塔の決定）
    const display = JSON.parse(readFileSync(displayJson, "utf8")) as {
      accounts: { tier: string; email?: string }[];
    };
    const admins = display.accounts.filter((a) => a.tier === "admin");
    expect(admins.length).toBeGreaterThan(0);
    for (const a of admins) expect(a).not.toHaveProperty("email");
  });

  it("静的なファイル（CSS・JS）はバンドルに埋め込まれ、外部の script を読まない", () => {
    expect(inputs).toContain("src/console/portal/assets.ts");
    expect(bundle).toContain("awsbridge.console.recent");
    expect(bundle).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("MCP のコード・設定の解析器と生成器・scripts/ を読み込まない", () => {
    for (const p of [
      "src/index.ts",
      "src/handler.ts",
      "src/proxy.ts",
      "src/access.ts",
      "src/toolslist.ts",
      "src/profiles.ts",
      "src/console/config.ts",
      "src/console/generate.ts",
    ]) {
      expect(inputs, p).not.toContain(p);
    }
    expect(inputs.filter((p) => p.startsWith("scripts/"))).toEqual([]);
    expect(inputs.filter((p) => /profiles/.test(p))).toEqual([]);
    expect(bundle).not.toContain("list_aws_profiles");
    expect(bundle).not.toContain("awsbridge:profiles");
  });
});
