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
      "STANDARD_CURRENT_KEYS",
      "STANDARD_PUBLIC_JWKS",
      "STS_REGION",
    ]);
    expect(vars.ACCESS_TEAM_DOMAIN).toMatch(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
    expect(vars.LOGIN_DISABLED).toBe("false");
    const raw = readFileSync(join(root, file), "utf8");
    // secret は名前だけ（説明のコメント）で、値はない
    expect(raw).toContain("CONSOLE_CSRF_KEY");
    expect(vars).not.toHaveProperty("CONSOLE_CSRF_KEY");
  });

  it("互換フラグを持たない（nodejs_compat・webcrypto_modern_algorithms を有効にしない）", () => {
    expect(config).not.toHaveProperty("compatibility_flags");
    const raw = readFileSync(join(root, file), "utf8");
    expect(raw).not.toMatch(/"nodejs_compat"|"webcrypto_modern_algorithms"/);
  });

  it("署名鍵は境界ごとの secret_key 型のバインディング（STANDARD_KEY_<16 進>）で、文字列の秘密鍵の secret（CONSOLE_SIGNING_KEYS）は使わない。例には鍵の値を書かず、今の鍵と公開鍵の vars は空（鍵が無ければ 500）", () => {
    const raw = readFileSync(join(root, file), "utf8");
    expect(raw).toContain("secret_key");
    expect(raw).toContain("STANDARD_KEY_");
    expect(raw).toContain("mise run console:standard-key:put");
    expect(raw).not.toContain("CONSOLE_SIGNING_KEYS");
    expect(raw).not.toMatch(/KMS/);
    expect(raw).not.toMatch(/"n"\s*:/);
    const vars = config.vars as Record<string, string>;
    expect(vars.STANDARD_CURRENT_KEYS).toBe("");
    expect(vars.STANDARD_PUBLIC_JWKS).toBe("");
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
    // Admin の issuer のホスト（admin-id.*。X1 の決裁で A-3 = I-B）を持ち、Standard の issuer のホスト（id.*）・Standard のポータルは持たない
    const patterns = routes.map((r) => r.pattern);
    expect(patterns).toContain("awsbridge-oidc-admin-console.example.com");
    expect(patterns).toContain("awsbridge-admin-console.example.com");
    expect(patterns).not.toContain("awsbridge-oidc-console.example.com");
    const standard = readJsonc(join(root, "wrangler.console-standard.jsonc"));
    const stdPatterns = (standard.routes as { pattern: string }[]).map((r) => r.pattern);
    for (const p of patterns) expect(stdPatterns, p).not.toContain(p);
  });

  it("互換フラグを持たない（nodejs_compat・webcrypto_modern_algorithms を有効にしない）", () => {
    expect(config).not.toHaveProperty("compatibility_flags");
    const raw = readFileSync(join(root, file), "utf8");
    expect(raw).not.toMatch(/"nodejs_compat"|"webcrypto_modern_algorithms"/);
  });

  it("署名鍵は secret_key 型のバインディング（ADMIN_KEY_<16 進>）で、例には実際の鍵の値を書かない。今の鍵と公開鍵の vars は空（鍵が無ければ 503）", () => {
    const raw = readFileSync(join(root, file), "utf8");
    expect(raw).toContain("secret_key");
    expect(raw).toContain("ADMIN_KEY_");
    expect(raw).toContain("mise run console:admin-key:put");
    expect(raw).not.toMatch(/KMS/);
    const vars = config.vars as Record<string, string>;
    expect(vars.ADMIN_CURRENT_KEY).toBe("");
    expect(vars.ADMIN_PUBLIC_JWKS).toBe("");
    expect(vars.ACCESS_MAX_AGE_SECONDS).toBe("900");
    expect(raw).not.toMatch(/"n"\s*:/);
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
      "ACCESS_MAX_AGE_SECONDS",
      "ACCESS_TEAM_DOMAIN",
      "ADMIN_CURRENT_KEY",
      "ADMIN_PUBLIC_JWKS",
      "LOGIN_DISABLED",
      "STS_REGION",
    ]);
    expect(vars.ACCESS_TEAM_DOMAIN).toMatch(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
    expect(vars.LOGIN_DISABLED).toBe("false");
    // 署名鍵の secret（文字列）は持たない。CSRF の鍵の名前だけを説明のコメントに書く（値はない）
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
