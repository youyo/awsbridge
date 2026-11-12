// 状態ファイルの書き込み（scripts/console/reconcile-state-io.ts）: 一時ファイルに書いて置き換える。
// 置き換えの前後どちらで失敗しても、一時ファイルを残さない。
import { describe, expect, it } from "vitest";
import { type StateFileIo, writeStateFile } from "../../scripts/console/reconcile-state-io";

function fakeIo(fail: "write" | "rename" | undefined) {
  const files = new Map<string, string>();
  const io: StateFileIo = {
    mkdir: () => {},
    write: (p, t) => {
      files.set(p, "partial");
      if (fail === "write") throw new Error("disk full");
      files.set(p, t);
    },
    rename: (a, b) => {
      if (fail === "rename") throw new Error("rename failed");
      files.set(b, files.get(a) ?? "");
      files.delete(a);
    },
    rm: (p) => {
      files.delete(p);
    },
  };
  return { io, files };
}

describe("writeStateFile", () => {
  it("一時ファイルに書いてから置き換える。成功したら一時ファイルは残らない", () => {
    const { io, files } = fakeIo(undefined);
    writeStateFile("/x/s.json", "body", io);
    expect([...files.keys()]).toEqual(["/x/s.json"]);
    expect(files.get("/x/s.json")).toBe("body");
  });

  it("置き換えの前（書き込み）で失敗したら、一時ファイルを消して例外を投げる。元のファイルは触らない", () => {
    const { io, files } = fakeIo("write");
    files.set("/x/s.json", "old");
    expect(() => writeStateFile("/x/s.json", "body", io)).toThrow();
    expect([...files.keys()]).toEqual(["/x/s.json"]);
    expect(files.get("/x/s.json")).toBe("old");
  });

  it("置き換え（rename）で失敗しても、一時ファイルを消す", () => {
    const { io, files } = fakeIo("rename");
    expect(() => writeStateFile("/x/s.json", "body", io)).toThrow();
    expect([...files.keys()]).toEqual([]);
  });
});
