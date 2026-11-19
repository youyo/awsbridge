// コンソールログインの Worker（src/console/worker/。P2 で 1 つ。Admin の Worker は消した）と、ポータルの部品（src/console/portal/）の依存:
// Worker で動くよう node の API に依存せず、MCP 用のエントリ・ハンドラー・scripts/・設定の解析器と生成器を import しない。
// 発行の経路（portal/login.ts）は、画面・ルーター・表示用の生成物を import しない（docs/specs/console-login-portal.md §9.10 の U2 の条件）。
// 表示用の照合（src/console/display/）と表示用の生成物の alias（awsbridge:console-display）はエントリからだけ届く。
// 発行の経路（portal/login.ts・issue/*）・工場（portal/*）からは届かない。
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { importGraph } from "./import-graph";

const root = new URL("../../", import.meta.url).pathname;
const MCP = [
  "src/index.ts",
  "src/handler.ts",
  "src/proxy.ts",
  "src/access.ts",
  "src/toolslist.ts",
  "src/profiles.ts",
];
const FILES = [
  "src/console/worker/index.ts",
  "src/console/worker/worker.ts",
  "src/console/worker/issuer.ts",
  "src/console/worker/key.ts",
  "src/console/signing/key.ts",
  "src/console/signing/jws.ts",
  "src/console/signing/signer.ts",
  "src/console/signing/issuer-doc.ts",
  "src/console/portal/worker.ts",
  "src/console/portal/login.ts",
  "src/console/portal/pages.ts",
  "src/console/portal/routes.ts",
  "src/console/portal/worker-config.ts",
  "src/console/portal/assets.ts",
  "src/console/display/entry.ts",
  "src/console/display/entry-page.ts",
  "src/console/display/groups.ts",
  "src/console/display/display-config.ts",
];
const ISSUE = [
  "src/console/issue/access.ts",
  "src/console/issue/claims.ts",
  "src/console/issue/csrf.ts",
  "src/console/issue/egress.ts",
  "src/console/issue/errors.ts",
  "src/console/issue/federation.ts",
  "src/console/issue/identity.ts",
  "src/console/issue/record.ts",
  "src/console/issue/request.ts",
  "src/console/issue/sign-boundary.ts",
  "src/console/issue/signer.ts",
];
const DISPLAY_ALIAS = "awsbridge:console-display";

describe("コンソールの Worker とポータルの部品の依存", () => {
  it.each(FILES)(
    "%s は node の API・MCP 用の本体・scripts/・設定の解析器と生成器を import しない",
    (f) => {
      const g = importGraph(join(root, f));
      const files = g.files.map((p) => relative(root, p));
      expect(files).toContain(f);
      for (const mcp of MCP) expect(files, `${f} → ${mcp}`).not.toContain(mcp);
      expect(files).not.toContain("src/console/config.ts");
      expect(files).not.toContain("src/console/generate.ts");
      expect(files.filter((p) => p.startsWith("scripts/"))).toEqual([]);
      expect(g.bare.filter((b) => b.startsWith("node:"))).toEqual([]);
      // 外部のパッケージは jose と、生成物の alias（発行用・表示用）だけ
      expect(
        g.bare.filter(
          (b) => b !== "jose" && b !== "awsbridge:console-worker" && b !== DISPLAY_ALIAS,
        ),
      ).toEqual([]);
      // 表示用の生成物の alias はエントリだけが読む
      if (f !== "src/console/worker/index.ts") expect(g.bare, f).not.toContain(DISPLAY_ALIAS);
    },
  );

  it("発行の経路（portal/login.ts）は画面・ルーター・表示用の生成物を import しない", () => {
    const g = importGraph(join(root, "src/console/portal/login.ts"));
    const files = g.files.map((p) => relative(root, p));
    // 陽性の対照: 発行の部品と STS は届いている
    expect(files).toContain("src/console/issue/access.ts");
    expect(files).toContain("src/sts.ts");
    expect(files).not.toContain("src/console/portal/pages.ts");
    expect(files).not.toContain("src/console/portal/routes.ts");
    expect(files.filter((p) => /display/.test(p))).toEqual([]);
    expect(g.bare).not.toContain("awsbridge:console-display");
    // 鍵の扱い（sign-boundary.ts）は発行の経路に入れない（差し込み口 TokenSigner で渡す）
    expect(files).not.toContain("src/console/issue/sign-boundary.ts");
  });

  it("鍵の扱いと issuer の文書は src/console/worker/ からだけ読む（ポータルの部品は読まない）", () => {
    for (const f of FILES.filter((x) => x.startsWith("src/console/portal/"))) {
      const files = importGraph(join(root, f)).files.map((p) => relative(root, p));
      expect(files, f).not.toContain("src/console/issue/sign-boundary.ts");
      expect(files, f).not.toContain("src/oidc.ts");
      expect(
        files.filter((p) => p.startsWith("src/console/worker/")),
        f,
      ).toEqual([]);
    }
  });

  it("署名の共通の部品（signing/）は外部のパッケージを読まない（WebCrypto だけで JWS を組む。X1 の決裁 (d) を Worker 全体に）", () => {
    for (const f of [
      "src/console/signing/key.ts",
      "src/console/signing/jws.ts",
      "src/console/signing/signer.ts",
      "src/console/signing/issuer-doc.ts",
    ]) {
      const g = importGraph(join(root, f));
      expect(g.bare, f).toEqual([]);
      const files = g.files.map((p) => relative(root, p));
      expect(files, f).not.toContain("src/console/issue/sign-boundary.ts");
      expect(files, f).not.toContain("src/oidc.ts");
    }
  });

  it("境界ごとの署名の部品（sign-boundary・worker/key・worker/issuer）は外部のパッケージ・文字列の秘密鍵を読む部品（src/keys・src/oidc）を読まない（cto の決裁「Standard も secret_key に揃える」）", () => {
    for (const f of [
      "src/console/issue/sign-boundary.ts",
      "src/console/worker/key.ts",
      "src/console/worker/issuer.ts",
    ]) {
      const g = importGraph(join(root, f));
      expect(g.bare, f).toEqual([]);
      const files = g.files.map((p) => relative(root, p));
      for (const banned of ["src/keys.ts", "src/oidc.ts"]) expect(files, f).not.toContain(banned);
      expect(
        files.filter((p) => p.startsWith("src/console/admin/")),
        f,
      ).toEqual([]);
    }
    // 陽性の対照: 共通の署名の部品は届いている
    const files = importGraph(join(root, "src/console/issue/sign-boundary.ts")).files.map((p) =>
      relative(root, p),
    );
    expect(files).toContain("src/console/signing/signer.ts");
  });

  it("Worker は P2 より前の Admin の Worker の部品・Admin の生成物の alias を読まない（消したものを戻さない）", () => {
    const g = importGraph(join(root, "src/console/worker/index.ts"));
    const files = g.files.map((p) => relative(root, p));
    expect(files.filter((p) => p.startsWith("src/console/admin/"))).toEqual([]);
    expect(g.bare).not.toContain("awsbridge:console-worker-admin");
    // 陽性の対照: 発行の経路・境界の署名・入口は届いている
    expect(files).toContain("src/console/portal/login.ts");
    expect(files).toContain("src/console/issue/sign-boundary.ts");
    expect(files).toContain("src/console/display/entry.ts");
  });

  it("表示用の照合（display/）と表示用の生成物は、エントリからだけ届く（陽性の対照つき）", () => {
    const std = importGraph(join(root, "src/console/worker/index.ts"));
    const stdFiles = std.files.map((p) => relative(root, p));
    expect(stdFiles).toContain("src/console/display/entry.ts");
    expect(stdFiles).toContain("src/console/display/groups.ts");
    expect(std.bare).toContain(DISPLAY_ALIAS);
    for (const f of [
      "src/console/portal/worker.ts",
      "src/console/portal/pages.ts",
      "src/console/portal/routes.ts",
      "src/console/portal/assets.ts",
      "src/console/issue/sign-boundary.ts",
    ]) {
      const g = importGraph(join(root, f));
      const files = g.files.map((p) => relative(root, p));
      expect(
        files.filter((p) => p.startsWith("src/console/display/")),
        f,
      ).toEqual([]);
      expect(g.bare, f).not.toContain(DISPLAY_ALIAS);
    }
  });

  it.each(["src/console/portal/login.ts", ...ISSUE])(
    "発行の経路 %s は表示用の照合（display/）と表示用の生成物を import しない（U2 の条件）",
    (f) => {
      const g = importGraph(join(root, f));
      const files = g.files.map((p) => relative(root, p));
      expect(files).toContain(f);
      expect(files.filter((p) => p.startsWith("src/console/display/"))).toEqual([]);
      expect(g.bare).not.toContain(DISPLAY_ALIAS);
    },
  );
});
