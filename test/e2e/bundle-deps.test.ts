// MCP の Worker のバンドルに入る外部パッケージが、package.json の dependencies（jose・aws4fetch）だけであることを、
// 実際のビルド（wrangler deploy --dry-run の esbuild のメタファイル）で確かめる。何もデプロイしない。
// 陽性の対照として、dependencies に無いパッケージ（devDependencies の yaml）を import する入口も同じ方法でビルドし、
// その混入を見つけられることを確かめる（検査が空振りで通らないように）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

type Bundle = {
  packages: string[]; // バンドルに入った外部パッケージ（名前の昇順・重複なし）
  local: string[]; // node_modules の外の入力（絶対パス）
  externals: string[]; // バンドルに入れず、実行時に import するもの
};

// node_modules/ の最後の出現の直後がパッケージ名（スコープつきなら 2 つ目の要素まで）
const packageOf = (p: string): string | undefined => {
  const i = p.lastIndexOf("node_modules/");
  if (i < 0) return undefined;
  const [a, b] = p.slice(i + "node_modules/".length).split("/");
  return a?.startsWith("@") ? `${a}/${b}` : a;
};

const dirs: string[] = [];
const work = (base: string, prefix: string) => {
  const d = mkdtempSync(join(base, prefix));
  dirs.push(d);
  return d;
};

// 一時的な wrangler の設定（下流と同じく alias をプロファイル一覧の JSON に向ける）で、入口 main をビルドする
function bundle(main: string): Bundle {
  const d = work(tmpdir(), "awsbridge-bundle-deps-");
  const config = join(d, "wrangler.jsonc");
  const meta = join(d, "meta.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "awsbridge-bundle-deps",
      main,
      compatibility_date: "2026-07-21",
      compatibility_flags: ["nodejs_compat"],
      alias: { "awsbridge:profiles": join(root, "config/profiles.example.json") },
    }),
  );
  const r = spawnSync(
    "pnpm",
    [
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      config,
      "--outdir",
      join(d, "out"),
      "--metafile",
      meta,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  const m = JSON.parse(readFileSync(meta, "utf8")) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  // メタファイルのパスは、設定ファイルのディレクトリからの相対
  const inputs = Object.keys(m.inputs).map((p) => resolve(d, p));
  const packages = new Set<string>();
  const local: string[] = [];
  for (const p of inputs) {
    const name = packageOf(p);
    if (name) packages.add(name);
    else local.push(p);
  }
  const externals = Object.values(m.outputs).flatMap((o) =>
    o.imports.filter((i) => i.external).map((i) => i.path),
  );
  return { packages: [...packages].sort(), local, externals };
}

let worker: Bundle;
let control: Bundle;

beforeAll(() => {
  worker = bundle(join(root, "src/index.ts"));
  // 対照の入口は、裸の import が作業ツリーの node_modules から解決されるよう、gitignore された .wrangler/ の下に置く
  mkdirSync(join(root, ".wrangler"), { recursive: true });
  const c = work(join(root, ".wrangler"), "bundle-deps-control-");
  const entry = join(c, "control.ts");
  writeFileSync(
    entry,
    [
      'import { Buffer } from "node:buffer";',
      'import { decodeJwt } from "jose";',
      'import { parse } from "yaml";',
      "export default {",
      '  fetch: () => new Response(typeof decodeJwt + JSON.stringify(parse("a: 1")) + Buffer.from("x").length),',
      "};",
      "",
    ].join("\n"),
  );
  control = bundle(entry);
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// バンドルの外部パッケージが dependencies とちょうど一致し、それ以外の入力がリポジトリの src/ かプロファイル一覧だけであること
const expectOnlyDependencies = (b: Bundle) => {
  expect(b.packages).toEqual(Object.keys(pkg.dependencies ?? {}).sort());
  for (const p of b.local) {
    expect(existsSync(p), p).toBe(true);
    expect(
      p.startsWith(`${join(root, "src")}/`) || p === join(root, "config/profiles.example.json"),
      p,
    ).toBe(true);
  }
};

describe("MCP の Worker のバンドルの依存（wrangler deploy --dry-run のメタファイル）", () => {
  it("陽性の対照: dependencies に無いパッケージ（yaml）を import すると、バンドルの外部パッケージに出て、検査が失敗する", () => {
    expect(control.packages).toEqual(["jose", "yaml"]);
    expect(() => expectOnlyDependencies(control)).toThrow();
  });

  it("陽性の対照: Workers の組み込み（node:buffer）の import は、バンドルに入れない import として取り出せる", () => {
    expect(control.externals).toContain("node:buffer");
  });

  it("dependencies は jose と aws4fetch の 2 つ", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["aws4fetch", "jose"]);
  });

  it("Worker のバンドルに入る外部パッケージは dependencies（aws4fetch・jose）だけで、ほかの入力は src/ とプロファイル一覧だけ", () => {
    expect(worker.packages).toEqual(["aws4fetch", "jose"]);
    expect(worker.local).toContain(join(root, "src/index.ts"));
    expectOnlyDependencies(worker);
  });

  it("バンドルに入れずに実行時に import するのは、Workers の組み込み（node:・cloudflare:）だけ", () => {
    for (const e of worker.externals) expect(e, e).toMatch(/^(node|cloudflare):/);
  });
});
