// コンソールログインの発行の経路の部品（src/console/issue/・src/console/http/）の置き場所:
// Worker で動くよう node の API に依存せず、MCP 用のエントリ・ハンドラーと scripts/ を import しない。
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { importGraph } from "./import-graph";

const root = new URL("../../", import.meta.url).pathname;
const FILES = [
  "src/console/issue/access.ts",
  "src/console/issue/csrf.ts",
  "src/console/issue/request.ts",
  "src/console/http/headers.ts",
];

describe("発行の経路の部品の依存", () => {
  it.each(FILES)("%s は node の API・MCP 用の本体・scripts/ を import しない", (f) => {
    const g = importGraph(join(root, f));
    const files = g.files.map((p) => relative(root, p));
    // 陽性の対照: 自分自身は届いている
    expect(files).toContain(f);
    for (const mcp of ["src/index.ts", "src/handler.ts", "src/proxy.ts"]) {
      expect(files, `${f} → ${mcp}`).not.toContain(mcp);
    }
    expect(files.filter((p) => !p.startsWith("src/console/"))).toEqual([]);
    expect(g.bare.filter((b) => b.startsWith("node:"))).toEqual([]);
    // 外部のパッケージは jose だけ
    expect(g.bare.filter((b) => b !== "jose")).toEqual([]);
  });
});
