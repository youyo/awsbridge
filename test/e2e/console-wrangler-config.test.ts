// コンソールログインの Worker（Standard・Admin）の wrangler の設定の例（wrangler.console-{standard,admin}.jsonc）を確かめる。
// 入口は Custom Domain だけ（workers.dev・Preview URL は無効。console-login.md §5 の T11: Access を経由しない入口を閉じる）、
// エントリと生成物の alias、回数の制限の binding、vars、secret を vars に書かないこと。バンドルの分離は console-isolation.test.ts。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonc } from "./jsonc";

const root = new URL("../../", import.meta.url).pathname;

type RateLimit = {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
};

describe("wrangler.console-standard.jsonc（設定の例）", () => {
  const file = "wrangler.console-standard.jsonc";
  const config = readJsonc(join(root, file));

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
    const rl = config.ratelimits as RateLimit[];
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
    const raw = readFileSync(join(root, file), "utf8");
    // secret は名前だけ（説明のコメント）で、値はない
    expect(raw).toContain("CONSOLE_SIGNING_KEYS");
    expect(raw).toContain("CONSOLE_CSRF_KEY");
    expect(vars).not.toHaveProperty("CONSOLE_SIGNING_KEYS");
    expect(vars).not.toHaveProperty("CONSOLE_CSRF_KEY");
  });
});

describe("wrangler.console-admin.jsonc（設定の例）", () => {
  const file = "wrangler.console-admin.jsonc";
  const config = readJsonc(join(root, file));

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
    const rl = config.ratelimits as RateLimit[];
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
    const raw = readFileSync(join(root, file), "utf8");
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
