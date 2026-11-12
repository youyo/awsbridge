// 行頭の // のコメントだけを外して JSON として読む（wrangler の設定の例は行の途中にコメントを書かない）。
import { readFileSync } from "node:fs";

export function readJsonc(path: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  ) as Record<string, unknown>;
}
