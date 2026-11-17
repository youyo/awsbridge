// コンソールログインの Worker（1 つ。Standard と Admin の両方のチームを受ける。P2）の wrangler の設定の例（wrangler.console.jsonc）を確かめる。
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

describe("wrangler.console.jsonc（設定の例）", () => {
  const file = "wrangler.console.jsonc";
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
    // ホストは 2 つ（ポータルと issuer）。P2 より前の Admin のホスト（awsbridge-admin-console・awsbridge-oidc-admin-console）は無い
    expect(routes.map((r) => r.pattern).sort()).toEqual([
      "awsbridge-console.example.com",
      "awsbridge-oidc-console.example.com",
    ]);
    expect(config.name).toBe("awsbridge-console");
  });

  it("エントリと生成物の alias、回数の制限の binding、vars（ACCESS_TEAM_DOMAIN など）を持ち、secret を vars に書かない", () => {
    expect(config.main).toBe("src/console/worker/index.ts");
    expect(config.alias).toEqual({
      "awsbridge:console-worker": "./.generated/console/worker.json",
      "awsbridge:console-display": "./.generated/console/display.json",
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
      "ADMIN_ACCESS_MAX_AGE_SECONDS",
      "ADMIN_LOGIN_DISABLED",
      "CONSOLE_CURRENT_KEYS",
      "CONSOLE_PUBLIC_JWKS",
      "LOGIN_DISABLED",
      "STS_REGION",
    ]);
    expect(vars.ACCESS_TEAM_DOMAIN).toMatch(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
    expect(vars.LOGIN_DISABLED).toBe("false");
    // Admin の階層のチームだけの停止スイッチと、Access JWT の経過時間の上限（既定 15 分）
    expect(vars.ADMIN_LOGIN_DISABLED).toBe("false");
    expect(vars.ADMIN_ACCESS_MAX_AGE_SECONDS).toBe("900");
    const raw = readFileSync(join(root, file), "utf8");
    // 受容 a: この Worker をデプロイできる者は Administrator を配った全アカウントの全権を持つ、をコメントに書く
    expect(raw).toContain("Administrator を配った全アカウントの全権");
    // secret は名前だけ（説明のコメント）で、値はない
    expect(raw).toContain("CONSOLE_CSRF_KEY");
    expect(vars).not.toHaveProperty("CONSOLE_CSRF_KEY");
  });

  it("互換フラグを持たない（nodejs_compat・webcrypto_modern_algorithms を有効にしない）", () => {
    expect(config).not.toHaveProperty("compatibility_flags");
    const raw = readFileSync(join(root, file), "utf8");
    expect(raw).not.toMatch(/"nodejs_compat"|"webcrypto_modern_algorithms"/);
  });

  it("署名鍵は境界ごとの secret_key 型のバインディング（CONSOLE_KEY_<16 進>）で、文字列の秘密鍵の secret（CONSOLE_SIGNING_KEYS）は使わない。例には鍵の値を書かず、今の鍵と公開鍵の vars は空（鍵が無ければ 500）", () => {
    const raw = readFileSync(join(root, file), "utf8");
    expect(raw).toContain("secret_key");
    expect(raw).toContain("CONSOLE_KEY_");
    expect(raw).toContain("mise run console:key:put");
    expect(raw).not.toContain("CONSOLE_SIGNING_KEYS");
    expect(raw).not.toMatch(/KMS/);
    expect(raw).not.toMatch(/"n"\s*:/);
    const vars = config.vars as Record<string, string>;
    expect(vars.CONSOLE_CURRENT_KEYS).toBe("");
    expect(vars.CONSOLE_PUBLIC_JWKS).toBe("");
  });
});

describe("P2: Admin の Worker の wrangler の設定は無い", () => {
  it("wrangler.console-admin.jsonc・wrangler.console-standard.jsonc は無い（コンソールの Worker は 1 つ）", () => {
    expect(() => readFileSync(join(root, "wrangler.console-admin.jsonc"), "utf8")).toThrow();
    expect(() => readFileSync(join(root, "wrangler.console-standard.jsonc"), "utf8")).toThrow();
  });
});

// cto の決裁 2026-11-13「② の発行記録を Workers Logs のままにする」(b): 発行記録は Workers Logs に置くので、
// 間引き（head-based sampling）で記録が落ちないよう、コンソールの Worker の head_sampling_rate を 1 に固定する。
// あわせて、発行記録に Worker の版 ID を残すため version_metadata の binding（CF_VERSION_METADATA）を持つ。
describe.each(["wrangler.console.jsonc"])("%s: 発行記録の置き場所（Workers Logs）", (file) => {
  const config = readJsonc(join(root, file));

  it("observability は有効で、head_sampling_rate は 1（間引かない）を明示する", () => {
    expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 1 });
  });

  it("version_metadata の binding は CF_VERSION_METADATA（発行記録の worker.versionId）", () => {
    expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });
});
