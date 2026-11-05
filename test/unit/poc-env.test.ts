import { afterEach, describe, expect, it, vi } from "vitest";
import { rotationPaths } from "../../scripts/key-rotate-lib";
import { keyFile, rotationKeyFiles } from "../../scripts/poc/env";

// 実行環境（mise など）に AWSBRIDGE_KEY_FILE があっても、引数の env だけで決まること
afterEach(() => {
  vi.unstubAllEnvs();
});

const defaultKey = "/.secrets/dev-signing-key";

describe("引数の env を使い、process.env を読まない", () => {
  it("rotationKeyFiles({}) は process.env.AWSBRIDGE_KEY_FILE があっても既定の .secrets 基準", () => {
    vi.stubEnv("AWSBRIDGE_KEY_FILE", "/other/key.json");
    const p = rotationKeyFiles({});
    expect(p.current.endsWith(`${defaultKey}.json`)).toBe(true);
    expect(p.next.endsWith(`${defaultKey}.next.json`)).toBe(true);
    expect(p.previous.endsWith(`${defaultKey}.previous.json`)).toBe(true);
  });

  it("rotationPaths({}) も同様", () => {
    vi.stubEnv("AWSBRIDGE_KEY_FILE", "/other/key.json");
    const p = rotationPaths({});
    expect(p.current.endsWith(`${defaultKey}.json`)).toBe(true);
    expect(p.next.endsWith(`${defaultKey}.next.json`)).toBe(true);
    expect(p.previous.endsWith(`${defaultKey}.previous.json`)).toBe(true);
  });

  it("keyFile({}) は既定、keyFile({ AWSBRIDGE_KEY_FILE }) はその値", () => {
    vi.stubEnv("AWSBRIDGE_KEY_FILE", "/other/key.json");
    expect(keyFile({}).endsWith(`${defaultKey}.json`)).toBe(true);
    expect(keyFile({ AWSBRIDGE_KEY_FILE: "/k/a.json" })).toBe("/k/a.json");
  });

  it("keyFile() は引数なしなら process.env を読む（従来どおり）", () => {
    vi.stubEnv("AWSBRIDGE_KEY_FILE", "/other/key.json");
    expect(keyFile()).toBe("/other/key.json");
  });
});
