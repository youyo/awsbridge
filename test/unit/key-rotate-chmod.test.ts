import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { newPrivateJwk } from "./helpers";

// chmod が失敗しても、現行 / 次の鍵の入れ替えが中途半端に残らないこと（activate の操作順）
const state = vi.hoisted(() => ({ failChmod: false }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (...a: Parameters<typeof actual.chmodSync>) => {
      if (state.failChmod) throw new Error("chmod failed");
      return actual.chmodSync(...a);
    },
  };
});

import { activate, rotationPaths } from "../../scripts/key-rotate-lib";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("activate の chmod 失敗", () => {
  it("chmod が失敗したら何も入れ替えない（現行・次の鍵はそのまま、前の鍵は作らない）", async () => {
    const d = mkdtempSync(join(tmpdir(), "awsbridge-rot-chmod-"));
    dirs.push(d);
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: join(d, "k.json") });
    const cur = await newPrivateJwk();
    const nxt = await newPrivateJwk();
    writeFileSync(p.current, JSON.stringify(cur));
    writeFileSync(p.next, JSON.stringify(nxt));
    state.failChmod = true;
    try {
      await expect(activate(p)).rejects.toThrow("chmod failed");
    } finally {
      state.failChmod = false;
    }
    expect(JSON.parse(readFileSync(p.current, "utf8")).n).toBe(cur.n);
    expect(JSON.parse(readFileSync(p.next, "utf8")).n).toBe(nxt.n);
    expect(existsSync(p.previous)).toBe(false);
  });
});
