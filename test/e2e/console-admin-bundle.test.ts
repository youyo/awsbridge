// コンソールログインの Admin の Worker の実際のバンドル（wrangler deploy --dry-run）と wrangler の設定の例を確かめる。
// 設計: docs/specs/console-login-portal.md §9.10（Admin のバンドルに Standard の固有値・Standard の鍵の扱い・MCP のコードが入らない）、
//       G1 の決裁（Admin の Worker は issuer の文書を出さない）、console-login.md §5 の T11（Access を経由しない入口を閉じる）。デプロイはしない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConsoleConfig } from "../../src/console/config";
import { generateConsoleArtifacts } from "../../src/console/generate";
import { readJsonc } from "./jsonc";

const root = new URL("../../", import.meta.url).pathname;
const CONFIG_FILE = "wrangler.console-admin.jsonc";

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

// Standard の生成物にだけある値（Admin のバンドルに入ってはならない）
const STANDARD_ONLY = [
  AUD.infra,
  AUD.dev,
  AUD.sa,
  ENTRY_STD,
  "https://id.example.com/standard",
  "/awsbridge-console/std/",
  "FederatedAwsBridgeViewer",
];

let out = "";
let inputs: string[] = [];
let bundle = "";
let config: Record<string, unknown> = {};
let adminJson = "";
let standardJson = "";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "awsbridge-console-admin-bundle-"));
  config = readJsonc(join(root, CONFIG_FILE));

  // 会社用の例から、Admin と Standard の生成物を作る（Standard の生成物は比較のためだけ。Admin のバンドルには入らないこと）
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
  adminJson = join(out, "worker.admin.json");
  writeFileSync(adminJson, JSON.stringify(artifacts.worker.admin));
  standardJson = join(out, "worker.standard.json");
  writeFileSync(standardJson, JSON.stringify(artifacts.worker.standard));

  const bundleConfig = {
    ...config,
    $schema: undefined,
    main: join(root, config.main as string),
    alias: { "awsbridge:console-worker-admin": adminJson },
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

describe("wrangler.console-admin.jsonc（設定の例）", () => {
  it("入口は Custom Domain だけ（workers_dev・Preview URL は無効。Access を経由しない入口を閉じる）", () => {
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
    // issuer のホスト（id.*）は持たない: Admin の issuer の文書はこの Worker から出さない
    expect(routes.map((r) => r.pattern)).not.toContain("id.example.com");
  });

  it("エントリと Admin の生成物の alias（Standard の alias は持たない）、回数の制限の binding、vars を持ち、secret を vars に書かない", () => {
    expect(config.main).toBe("src/console/admin/index.ts");
    expect(config.alias).toEqual({
      "awsbridge:console-worker-admin": "./.generated/console/worker.admin.json",
    });
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
    // 署名鍵の secret は持たない。CSRF の鍵の名前だけを説明のコメントに書く（値はない）
    const raw = readFileSync(join(root, CONFIG_FILE), "utf8");
    expect(raw).toContain("CONSOLE_CSRF_KEY");
    expect(vars).not.toHaveProperty("CONSOLE_CSRF_KEY");
    expect(vars).not.toHaveProperty("CONSOLE_SIGNING_KEYS");
    // Standard の Worker と同じ回数の制限の namespace を使い回さない
    const standard = readJsonc(join(root, "wrangler.console-standard.jsonc"));
    const stdRl = standard.ratelimits as { namespace_id: string }[];
    expect(rl[0]?.namespace_id).not.toBe(stdRl[0]?.namespace_id);
    expect(standard.name).not.toBe(config.name);
  });
});

describe("Admin の Worker のバンドル", () => {
  it("陽性の対照: エントリ・共通の工場・発行の経路・署名の差し込み口・Admin の生成物（Admin の AUD）は入っている", () => {
    expect(inputs).toContain("src/console/admin/index.ts");
    expect(inputs).toContain("src/console/portal/worker.ts");
    expect(inputs).toContain("src/console/portal/login.ts");
    expect(inputs).toContain("src/console/issue/signer.ts");
    // 生成物のパスは wrangler の設定のディレクトリからの相対で記録されるので、名前で照合する
    expect(inputs.filter((p) => p.endsWith("worker.admin.json"))).toHaveLength(1);
    expect(bundle).toContain(AUD["infra-elevated"]);
    expect(bundle).toContain(AUD["dev-elevated"]);
    expect(bundle).toContain("/awsbridge-console/admin/");
    expect(bundle).toContain("https://admin-portal.example.com");
    expect(bundle).toContain("signing_unavailable");
  });

  it("Standard の固有値（Standard の AUD・入口の AUD・issuer・行）が入らない。Standard のポータルのオリジンは peerOrigin（表示のリンク）としてだけ入る", () => {
    expect(inputs.filter((p) => p.endsWith("worker.standard.json"))).toEqual([]);
    for (const s of STANDARD_ONLY) {
      expect(bundle, s).not.toContain(s);
    }
  });

  it("陽性の対照: 上の Standard の固有値は、Standard の生成物（worker.standard.json）には実際にある。Admin の生成物にはない", () => {
    const std = readFileSync(standardJson, "utf8");
    const admin = readFileSync(adminJson, "utf8");
    for (const s of STANDARD_ONLY) {
      expect(std, s).toContain(s);
      expect(admin, s).not.toContain(s);
    }
  });

  it("Standard の署名の実装・OIDC・鍵の生成・CONSOLE_SIGNING_KEYS の参照・issuer の文書が入らない", () => {
    for (const p of [
      "src/console/issue/sign-standard.ts",
      "src/oidc.ts",
      "src/keys.ts",
      "src/console/standard/index.ts",
      "src/console/standard/worker.ts",
      "src/console/standard/issuer.ts",
    ]) {
      expect(inputs, p).not.toContain(p);
    }
    expect(bundle).not.toContain("CONSOLE_SIGNING_KEYS");
    expect(bundle).not.toContain("openid-configuration");
    expect(bundle).not.toContain("jwks.json");
    expect(bundle).not.toContain('awsbridge:console-worker"');
    // Admin の署名の経路（KMS）はまだ無い
    expect(bundle).not.toMatch(/\bkms\b/i);
  });

  it("MCP のコード・設定の解析器と生成器・表示用の生成物・scripts/ を読み込まない", () => {
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
    expect(inputs.filter((p) => /display/.test(p))).toEqual([]);
    expect(bundle).not.toContain("list_aws_profiles");
    expect(bundle).not.toContain("awsbridge:profiles");
  });
});
