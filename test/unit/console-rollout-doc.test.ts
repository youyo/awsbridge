import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 本番でのコンソールログインの導入の順序とチェックリスト（docs/console-production-rollout*.md）。
// 下流の運用者が読む文書なので、リンク先・タスク名が実在すること、内部の呼び名や実値を書かないことを確かめる。

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const path = (p: string) => join(root, p);
const read = (p: string) => readFileSync(path(p), "utf8");

const EN = "docs/console-production-rollout.md";
const JA = "docs/console-production-rollout_ja.md";
const DOCS = [EN, JA];

// コードブロックの外の行だけ
const outsideFences = (text: string): string[] => {
  let inFence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence) out.push(line);
  }
  return out;
};
const headings = (p: string) => outsideFences(read(p)).filter((l) => /^#{1,6}\s/.test(l));
const levels = (p: string) => headings(p).map((h) => /^#+/.exec(h)?.[0].length);

// GitHub の見出しのアンカーの規則（github-slugger と同じ考え方）: 小文字にし、文字・数字・結合文字・
// 連結の句読点・空白・ハイフン以外を消し、空白をハイフンにする。同じものが続けば -1, -2 を付ける。
const slug = (heading: string) =>
  heading
    .replace(/^#+\s+/, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
const anchors = (p: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(p)) {
    const base = slug(h);
    const n = seen.get(base) ?? 0;
    out.add(n === 0 ? base : `${base}-${n}`);
    seen.set(base, n + 1);
  }
  return out;
};

// Markdown のリンク（相対のものだけ）
const relativeLinks = (p: string): string[] =>
  [
    ...outsideFences(read(p))
      .join("\n")
      .matchAll(/\]\(([^)\s]+)\)/g),
  ]
    .map((m) => m[1] as string)
    .filter((href) => !/^[a-z]+:/i.test(href));

const miseTasks = (): Set<string> =>
  new Set(
    [...read("mise.toml").matchAll(/^\[tasks\.(?:"([^"]+)"|([\w:-]+))\]/gm)].map(
      (m) => (m[1] ?? m[2]) as string,
    ),
  );

describe("本番でのコンソールログインの導入の文書（英・日）", () => {
  it("英語と日本語の 2 つがあり、先頭に互いへの切替リンクがある", () => {
    for (const d of DOCS) expect(existsSync(path(d)), d).toBe(true);
    const head = (p: string) => read(p).split("\n").slice(0, 6).join("\n");
    expect(head(EN)).toContain("](console-production-rollout_ja.md)");
    expect(head(JA)).toContain("](console-production-rollout.md)");
  });

  it("英語の文書にかなが無く、日本語の文書は日本語", () => {
    expect(read(EN)).not.toMatch(/[぀-ヿ]/);
    expect(read(JA)).toMatch(/[぀-ヿ]/);
  });

  it("見出しの数とレベルの並び、コードブロックの数が英日で一致する", () => {
    expect(headings(EN).length).toBeGreaterThan(5);
    expect(levels(EN)).toEqual(levels(JA));
    const fences = (p: string) => (read(p).match(/^\s*```/gm) ?? []).length;
    expect(fences(EN)).toBe(fences(JA));
  });

  it("段 0〜5 の見出しが順に並ぶ（英日とも）", () => {
    const steps = (p: string) =>
      headings(p)
        .map((h) => /^## (?:Step|段) (\d):/.exec(h)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
    expect(steps(EN)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(steps(JA)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("英日でバッククォートの語の多重集合が一致する（コードブロックの外）", () => {
    const spans = (p: string) =>
      [
        ...outsideFences(read(p))
          .join("\n")
          .matchAll(/`([^`\n]+)`/g),
      ]
        .map((m) => m[1] as string)
        .sort();
    expect(spans(JA)).toEqual(spans(EN));
  });

  it("README（英・日）から、それぞれの言語の文書へリンクする", () => {
    expect(read("README.md")).toContain("](docs/console-production-rollout.md)");
    expect(read("README_ja.md")).toContain("](docs/console-production-rollout_ja.md)");
  });

  for (const d of DOCS) {
    it(`${d}: 相対リンクのファイルとアンカーが実在する`, () => {
      const links = relativeLinks(d);
      expect(links.length).toBeGreaterThan(5);
      for (const href of links) {
        const [file, anchor] = href.split("#") as [string, string | undefined];
        const target = file === "" ? d : normalize(join(dirname(d), file));
        expect(existsSync(path(target)), `${href} -> ${target}`).toBe(true);
        if (anchor !== undefined)
          expect([...anchors(target)], `${href} (#${anchor} in ${target})`).toContain(
            decodeURIComponent(anchor),
          );
      }
    });

    it(`${d}: mise run のタスクがすべて mise.toml に実在する`, () => {
      const tasks = miseTasks();
      const used = [...read(d).matchAll(/mise run ([\w:-]+)/g)].map((m) => m[1] as string);
      expect(used.length).toBeGreaterThan(5);
      for (const t of used) expect(tasks.has(t), t).toBe(true);
    });

    it(`${d}: 順序の段と、止める条件・人の承認を載せる`, () => {
      const text = read(d);
      for (const s of [
        "mise run console:standard-key:check",
        "mise run console:admin-key:check",
        "mise run console:reconcile",
        "mise run console:exposure-check",
        "mise run console:access:inspect",
        "LOGIN_DISABLED",
        "503 login_disabled",
        "role_missing",
        "team_mismatch",
        "unknown_audience",
        "console:stop:apply",
        "AWSBRIDGE_CONSOLE_LOGS_WORKERS",
        "excluded assumes (not console)",
        "admin issues",
        "AdministratorTeams",
        "AdministratorRole",
        "awsbridge-console-kind-<kind>",
        "aws iam get-role",
        "aws iam list-attached-role-policies",
        "git pull --no-rebase upstream main",
        "workers_dev",
        "preview_urls",
      ])
        expect(text, s).toContain(s);
    });

    it(`${d}: 内部の呼び名・実値を書かない`, () => {
      const text = read(d);
      for (const re of [
        /②|③/,
        /\bc[1-5](-[a-d])?\b/,
        /G2-/,
        /\bpt4\b|private-test4/,
        /\bcto\b/i,
        /\bSol\b/,
        /\blead\b/,
        /handover/i,
      ])
        expect(text, String(re)).not.toMatch(re);
      // アカウント ID らしい 12 桁は例の 111111111111 だけ
      for (const m of text.matchAll(/\b\d{12}\b/g)) expect(m[0]).toBe("111111111111");
      // email は例のドメインだけ
      for (const m of text.matchAll(/[\w.+-]+@([\w-]+\.)+[\w-]+/g))
        expect(m[0]).toMatch(/@example\.(com|org)$/);
    });
  }
});
