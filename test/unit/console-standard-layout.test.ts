// コンソールログインの Standard の Worker（src/console/standard/）・Admin の Worker（src/console/admin/）と、階層に共通のポータルの部品（src/console/portal/）の依存:
// Worker で動くよう node の API に依存せず、MCP 用のエントリ・ハンドラー・scripts/・設定の解析器と生成器を import しない。
// 発行の経路（portal/login.ts）は、画面・ルーター・表示用の生成物を import しない（docs/specs/console-login-portal.md §9.10 の U2 の条件）。
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
  "src/console/standard/index.ts",
  "src/console/standard/worker.ts",
  "src/console/standard/issuer.ts",
  "src/console/admin/index.ts",
  "src/console/admin/worker.ts",
  "src/console/portal/worker.ts",
  "src/console/portal/login.ts",
  "src/console/portal/pages.ts",
  "src/console/portal/routes.ts",
  "src/console/portal/worker-config.ts",
];

describe("Standard の Worker とポータルの部品の依存", () => {
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
      // 外部のパッケージは jose と、生成物の alias（Standard・Admin の発行用）だけ
      expect(
        g.bare.filter(
          (b) =>
            b !== "jose" &&
            b !== "awsbridge:console-worker" &&
            b !== "awsbridge:console-worker-admin",
        ),
      ).toEqual([]);
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
    // Standard の鍵の扱い（sign-standard.ts）は Admin でも使う発行の経路に入れない（差し込み口で渡す）
    expect(files).not.toContain("src/console/issue/sign-standard.ts");
  });

  it("Standard の鍵の扱いと issuer の文書は src/console/standard/ からだけ読む（ポータルの部品は読まない）", () => {
    for (const f of FILES.filter((x) => x.startsWith("src/console/portal/"))) {
      const files = importGraph(join(root, f)).files.map((p) => relative(root, p));
      expect(files, f).not.toContain("src/console/issue/sign-standard.ts");
      expect(files, f).not.toContain("src/oidc.ts");
      expect(
        files.filter((p) => p.startsWith("src/console/standard/")),
        f,
      ).toEqual([]);
    }
  });

  it("Admin の Worker は Standard の鍵の扱い・OIDC・issuer の文書・Standard のエントリを読まず、自分の生成物の alias だけを読む", () => {
    for (const f of ["src/console/admin/index.ts", "src/console/admin/worker.ts"]) {
      const g = importGraph(join(root, f));
      const files = g.files.map((p) => relative(root, p));
      // 陽性の対照: 共通の工場・署名の差し込み口・発行の経路は届いている
      expect(files, f).toContain("src/console/portal/worker.ts");
      expect(files, f).toContain("src/console/portal/login.ts");
      expect(files, f).toContain("src/console/issue/signer.ts");
      for (const banned of [
        "src/console/issue/sign-standard.ts",
        "src/oidc.ts",
        "src/console/standard/index.ts",
        "src/console/standard/worker.ts",
        "src/console/standard/issuer.ts",
        "src/keys.ts",
      ]) {
        expect(files, `${f} → ${banned}`).not.toContain(banned);
      }
      expect(g.bare, f).not.toContain("awsbridge:console-worker");
    }
    const entry = importGraph(join(root, "src/console/admin/index.ts"));
    expect(entry.bare).toContain("awsbridge:console-worker-admin");
  });

  it("Standard の Worker は Admin のエントリ・Admin の生成物の alias を読まない（取り違えを防ぐ）", () => {
    const g = importGraph(join(root, "src/console/standard/index.ts"));
    const files = g.files.map((p) => relative(root, p));
    expect(files.filter((p) => p.startsWith("src/console/admin/"))).toEqual([]);
    expect(g.bare).not.toContain("awsbridge:console-worker-admin");
  });
});
