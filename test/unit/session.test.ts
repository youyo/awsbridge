import { describe, expect, it } from "vitest";
import { buildSessionName, sanitizeSessionName } from "../../src/oidc";

describe("sanitizeSessionName", () => {
  it("許可文字 [\\w+=,.@-] のみ残す", () => {
    expect(sanitizeSessionName("a b/c:d*e")).toBe("abcde");
    expect(sanitizeSessionName("user+tag=1,2.x@ex-ample_com")).toBe("user+tag=1,2.x@ex-ample_com");
    expect(sanitizeSessionName("日本語!あ")).toBe("");
  });
});

describe("buildSessionName", () => {
  it("prefix + sanitize(id) + suffix", () => {
    expect(buildSessionName("gw-", "user@example.com", "")).toBe("gw-user@example.com");
    expect(buildSessionName("gw-", "a b", "-chain")).toBe("gw-ab-chain");
  });
  it("64 文字に切り詰め、suffix は保持する", () => {
    const long = "a".repeat(100);
    const n = buildSessionName("gw-", long, "-chain");
    expect(n).toHaveLength(64);
    expect(n.startsWith("gw-a")).toBe(true);
    expect(n.endsWith("-chain")).toBe(true);
  });
  it("ちょうど 64 文字はそのまま、prefix+suffix が 64 超でも id は空", () => {
    expect(buildSessionName("", "a".repeat(64), "")).toHaveLength(64);
    expect(buildSessionName("p".repeat(40), "xyz", "s".repeat(30))).toBe(
      "p".repeat(40) + "s".repeat(30),
    );
  });
});
