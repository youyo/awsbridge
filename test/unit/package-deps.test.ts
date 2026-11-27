import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url).pathname, "utf8"),
) as { dependencies?: Record<string, string> };

describe("package.json の実行時の依存", () => {
  it("dependencies（Worker のバンドルに入る jose・aws4fetch）は、すべて版を完全に固定する（^ や ~ の範囲を使わない）", () => {
    const deps = pkg.dependencies ?? {};
    // 陽性の対照: 空の dependencies で素通りしない
    expect(Object.keys(deps)).toEqual(expect.arrayContaining(["jose", "aws4fetch"]));
    for (const [name, version] of Object.entries(deps))
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
