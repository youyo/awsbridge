import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { activate, prepare, retire, rotationPaths } from "../../scripts/key-rotate-lib";
import { thumbprintOf } from "../../src/keys";
import { newPrivateJwk } from "./helpers";

const root = new URL("../../", import.meta.url).pathname;
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "awsbridge-rotate-"));
  tmpDirs.push(d);
  return d;
};
const mode = (f: string) => statSync(f).mode & 0o777;
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

describe("rotationPaths", () => {
  it("NEXT / PREVIOUS の既定は KEY_FILE の拡張子の前に .next / .previous を付ける", () => {
    expect(rotationPaths({ AWSBRIDGE_KEY_FILE: "/k/dev-signing-key.json" })).toEqual({
      current: "/k/dev-signing-key.json",
      next: "/k/dev-signing-key.next.json",
      previous: "/k/dev-signing-key.previous.json",
    });
  });

  it("AWSBRIDGE_NEXT_KEY_FILE / AWSBRIDGE_PREVIOUS_KEY_FILE で上書きできる。空文字は既定", () => {
    expect(
      rotationPaths({
        AWSBRIDGE_KEY_FILE: "/k/a.json",
        AWSBRIDGE_NEXT_KEY_FILE: "/n/x.json",
        AWSBRIDGE_PREVIOUS_KEY_FILE: "",
      }),
    ).toEqual({ current: "/k/a.json", next: "/n/x.json", previous: "/k/a.previous.json" });
  });

  it("拡張子が無い KEY_FILE にも付く", () => {
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: "/k/key" });
    expect(p.next).toBe("/k/key.next.json");
    expect(p.previous).toBe("/k/key.previous.json");
  });

  it("KEY_FILE 未設定なら .secrets/dev-signing-key.json 基準", () => {
    const p = rotationPaths({});
    expect(p.current.endsWith("/.secrets/dev-signing-key.json")).toBe(true);
    expect(p.next.endsWith("/.secrets/dev-signing-key.next.json")).toBe(true);
    expect(p.previous.endsWith("/.secrets/dev-signing-key.previous.json")).toBe(true);
  });
});

describe("prepare", () => {
  it("次の鍵を NEXT に 0600 で保存し、現行・PREVIOUS は触らない。次の手順を表示する", async () => {
    const d = tmp();
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: join(d, "k.json") });
    writeFileSync(p.current, "CURRENT", { mode: 0o600 });
    const msg = (await prepare(p)).join("\n");
    expect(mode(p.next)).toBe(0o600);
    const jwk = readJson(p.next);
    expect(jwk.kty).toBe("RSA");
    expect(jwk.d).toBeTruthy();
    expect(jwk.kid).toBe(await thumbprintOf(jwk));
    expect(readFileSync(p.current, "utf8")).toBe("CURRENT");
    expect(existsSync(p.previous)).toBe(false);
    expect(msg).toContain("mise run secrets");
    expect(msg).toContain("key:activate");
    expect(msg).not.toContain(jwk.d);
  });

  it("NEXT が既にあれば中止し、上書きしない", async () => {
    const d = tmp();
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: join(d, "k.json") });
    writeFileSync(p.next, "EXISTING");
    await expect(prepare(p)).rejects.toThrow(/既に/);
    expect(readFileSync(p.next, "utf8")).toBe("EXISTING");
  });
});

describe("activate", () => {
  async function seed(opts: { next?: boolean; previous?: boolean; current?: boolean }) {
    const d = tmp();
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: join(d, "k.json") });
    const cur = await newPrivateJwk();
    const nxt = await newPrivateJwk();
    if (opts.current !== false) writeFileSync(p.current, JSON.stringify(cur), { mode: 0o600 });
    if (opts.next !== false) writeFileSync(p.next, JSON.stringify(nxt), { mode: 0o600 });
    if (opts.previous) writeFileSync(p.previous, "OLD-PREVIOUS", { mode: 0o600 });
    return { p, cur, nxt };
  }

  it("現行 → PREVIOUS、NEXT → 現行 に移す（0600 のまま）。NEXT は残らない", async () => {
    const { p, cur, nxt } = await seed({});
    const msg = (await activate(p)).join("\n");
    expect(readJson(p.previous).n).toBe(cur.n);
    expect(readJson(p.current).n).toBe(nxt.n);
    expect(existsSync(p.next)).toBe(false);
    expect(mode(p.current)).toBe(0o600);
    expect(mode(p.previous)).toBe(0o600);
    expect(msg).toContain("mise run secrets");
    expect(msg).toContain("key:retire");
  });

  it("NEXT が無ければ中止し、何も動かさない", async () => {
    const { p, cur } = await seed({ next: false });
    await expect(activate(p)).rejects.toThrow(/key:prepare/);
    expect(readJson(p.current).n).toBe(cur.n);
    expect(existsSync(p.previous)).toBe(false);
  });

  it("PREVIOUS が既にあれば中止し、何も動かさない（key:retire を案内）", async () => {
    const { p, cur, nxt } = await seed({ previous: true });
    await expect(activate(p)).rejects.toThrow(/key:retire/);
    expect(readJson(p.current).n).toBe(cur.n);
    expect(readJson(p.next).n).toBe(nxt.n);
    expect(readFileSync(p.previous, "utf8")).toBe("OLD-PREVIOUS");
  });

  it("現行の鍵が無ければ中止する", async () => {
    const { p, nxt } = await seed({ current: false });
    await expect(activate(p)).rejects.toThrow(/key:keygen|keygen/);
    expect(readJson(p.next).n).toBe(nxt.n);
    expect(existsSync(p.previous)).toBe(false);
  });

  it("NEXT が RSA 秘密鍵 JWK として読めなければ中止する（壊れた鍵を現行にしない）", async () => {
    const { p, cur } = await seed({ next: false });
    writeFileSync(p.next, '{"kty":"RSA","n":"x","e":"AQAB"}', { mode: 0o600 }); // d が無い
    await expect(activate(p)).rejects.toThrow();
    expect(readJson(p.current).n).toBe(cur.n);
    expect(existsSync(p.previous)).toBe(false);
  });
});

describe("retire", () => {
  it("PREVIOUS を削除し、現行・NEXT は触らない", async () => {
    const d = tmp();
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: join(d, "k.json") });
    writeFileSync(p.current, "C");
    writeFileSync(p.next, "N");
    writeFileSync(p.previous, "P");
    const msg = (await retire(p)).join("\n");
    expect(existsSync(p.previous)).toBe(false);
    expect(readFileSync(p.current, "utf8")).toBe("C");
    expect(readFileSync(p.next, "utf8")).toBe("N");
    expect(msg).toContain("mise run secrets");
  });

  it("PREVIOUS が無ければ何もしない（エラーにしない）", async () => {
    const d = tmp();
    const p = rotationPaths({ AWSBRIDGE_KEY_FILE: join(d, "k.json") });
    writeFileSync(p.current, "C");
    const msg = (await retire(p)).join("\n");
    expect(msg).toContain("ありません");
    expect(readFileSync(p.current, "utf8")).toBe("C");
  });
});

describe("scripts/key-rotate.ts（CLI）", () => {
  const run = (d: string, cmd: string) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "scripts/key-rotate.ts"), cmd], {
      env: { PATH: process.env.PATH ?? "", AWSBRIDGE_KEY_FILE: join(d, "k.json") },
      encoding: "utf8",
    });

  it("prepare → activate → retire を通しで実行でき、中止条件は終了コード 1", async () => {
    const d = tmp();
    writeFileSync(join(d, "k.json"), JSON.stringify(await newPrivateJwk()), { mode: 0o600 });
    const a = run(d, "prepare");
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain("key:activate");
    expect(existsSync(join(d, "k.next.json"))).toBe(true);
    const again = run(d, "prepare");
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("既に");
    const b = run(d, "activate");
    expect(b.status, b.stderr).toBe(0);
    expect(existsSync(join(d, "k.previous.json"))).toBe(true);
    expect(run(d, "activate").status).toBe(1);
    const c = run(d, "retire");
    expect(c.status, c.stderr).toBe(0);
    expect(existsSync(join(d, "k.previous.json"))).toBe(false);
  });

  it("未知のサブコマンドは終了コード 1", () => {
    const r = run(tmp(), "nope");
    expect(r.status).toBe(1);
  });
});
