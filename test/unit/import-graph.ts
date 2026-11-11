// 静的な import をたどって、エントリから届くモジュールの一覧を作る（テスト用）。
// 相対パスの import（拡張子なし・.ts・/index.ts）だけを解決してたどり、パッケージ名などはそのまま記録する。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SPECIFIER_RE =
  /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export type ImportGraph = { files: string[]; bare: string[] };

function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}/index.ts`].find(
    (p) => existsSync(p) && statSync(p).isFile(),
  );
}

export function importGraph(entry: string): ImportGraph {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(SPECIFIER_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const target = resolveRelative(file, spec);
        if (!target) throw new Error(`import を解決できません: ${spec}（${file}）`);
        queue.push(target);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files: [...files].sort(), bare: [...bare].sort() };
}
