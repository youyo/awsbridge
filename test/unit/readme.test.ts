import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const path = (p: string) => join(root, p);
const read = (p: string) => readFileSync(path(p), "utf8");
const head = (p: string) => read(p).split("\n").slice(0, 6).join("\n");

// コードブロック内の `#` 行（シェルのコメントなど）を除いた見出し行を返す
const headings = (p: string): string[] => {
  let inFence = false;
  const out: string[] = [];
  for (const line of read(p).split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,6}\s/.test(line)) out.push(line);
  }
  return out;
};
const levels = (p: string) => headings(p).map((h) => /^#+/.exec(h)?.[0].length);

describe("README の 2 言語化", () => {
  it("README.md（英語）と README_ja.md（日本語）が両方ある", () => {
    expect(existsSync(path("README.md"))).toBe(true);
    expect(existsSync(path("README_ja.md"))).toBe(true);
  });

  it("先頭付近に互いへの切替リンクがある", () => {
    expect(head("README.md")).toContain("](README_ja.md)");
    expect(head("README_ja.md")).toContain("](README.md)");
  });

  it("README_ja.md が日本語、README.md が英語で書かれている", () => {
    expect(read("README_ja.md")).toMatch(/[぀-ヿ]/);
    expect(read("README.md")).not.toMatch(/[぀-ヿ]/);
  });

  it("見出しの数とレベルの並びが一致する", () => {
    expect(headings("README.md").length).toBeGreaterThan(0);
    expect(levels("README.md")).toEqual(levels("README_ja.md"));
  });

  it("コードブロックの数が一致する", () => {
    const fences = (p: string) => (read(p).match(/^```/gm) ?? []).length;
    expect(fences("README.md")).toBe(fences("README_ja.md"));
  });
});

describe("README のプロファイル一覧（alias でバンドル）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: example のコピー手順・alias・移行時の secret delete を載せ、AWSBRIDGE_PROFILES を設定例に残さない`, () => {
      const text = read(f);
      expect(text).toContain("cp config/profiles.example.json config/profiles.json");
      expect(text).toContain("awsbridge:profiles");
      expect(text).toContain("secret delete AWS_PROFILES");
      // 設定例（mise.local.toml のコードブロック）に AWSBRIDGE_PROFILES = ... が無い
      expect(text).not.toMatch(/^AWSBRIDGE_PROFILES\s*=/m);
      // 下流の wrangler 設定例が vars.AWS_PROFILES を使っていない
      expect(text).not.toMatch(/"AWS_PROFILES"\s*:/);
    });
  }
});

// README の並び（MCP の中継だけ。コンソールログインの節はタグ console-login-final の版にある）
describe("README の並び（MCP の中継だけ）", () => {
  // 「## 」の見出し（コードブロックの外）が、この並びとちょうど一致する（足りないものも余分なものも無い）
  const order = (f: string, hs: string[]) =>
    expect(headings(f).filter((h) => h.startsWith("## "))).toEqual(hs);
  it("README.md: できること → 廃止と片付け → 上流と下流 → 構成 → 下流 → デプロイの経路 → MCP → 鍵の差し替え → 移行 → 開発", () =>
    order("README.md", [
      "## What awsbridge does",
      "## Retiring console login and cleaning up",
      "## Upstream and downstream",
      "## Architecture",
      "## Operating in a downstream repository",
      "## How the Worker is deployed (default route and explicit route)",
      "## MCP relay setup",
      "## Key rotation",
      "## Migrating an existing MCP deployment",
      "## Development",
    ]));
  it("README_ja.md: 同じ並び", () =>
    order("README_ja.md", [
      "## awsbridge でできること",
      "## コンソールログインの廃止と片付け",
      "## 上流と下流",
      "## 構成",
      "## 下流リポジトリでの運用",
      "## Worker のデプロイの経路（既定と明示）",
      "## MCP の中継のセットアップ",
      "## 鍵の差し替え",
      "## MCP の中継の既存のデプロイの移行",
      "## 開発",
    ]));

  // 他のファイル（SKILL.md・scripts・wrangler.jsonc のコメント）や下流のリンクが参照する見出し
  const kept: [string, string[]][] = [
    [
      "README.md",
      [
        "## Operating in a downstream repository",
        "## How the Worker is deployed (default route and explicit route)",
        "### How to create the token for daily deploys",
        "## MCP relay setup",
        "### Multi-account",
        "### Signing key rotation (MCP relay)",
      ],
    ],
    [
      "README_ja.md",
      [
        "## 下流リポジトリでの運用",
        "## Worker のデプロイの経路（既定と明示）",
        "### 日常のデプロイ用のトークンの作り方",
        "## MCP の中継のセットアップ",
        "### マルチアカウント",
        "### 署名鍵のローテーション（MCP の中継）",
      ],
    ],
  ];
  for (const [f, hs] of kept)
    it(`${f}: 参照される MCP の見出しが残る`, () => {
      for (const h of hs) expect(headings(f), h).toContain(h);
    });

  // 廃止と片付けの節の外には、コンソールログインのことを書かない
  const consoleWords =
    /console[-_ ]?login|コンソールログイン|src\/console|console:|wrangler\.console|-console\.jsonc|console-production-rollout|Console Worker|コンソール Worker|コンソールの Worker/i;
  const outsideRetirement: [string, string, string][] = [
    ["README.md", "## Retiring console login and cleaning up", "## Upstream and downstream"],
    ["README_ja.md", "## コンソールログインの廃止と片付け", "## 上流と下流"],
  ];
  for (const [f, start, end] of outsideRetirement)
    it(`${f}: 「${start}」の節の外にコンソールログインの記述が無い`, () => {
      const text = read(f);
      const i = text.indexOf(`\n${start}\n`);
      const j = text.indexOf(`\n${end}\n`, i + 1);
      expect(i, start).toBeGreaterThan(0);
      expect(j, end).toBeGreaterThan(i);
      const outside = (text.slice(0, i) + text.slice(j)).split("\n");
      expect(outside.filter((l) => consoleWords.test(l))).toEqual([]);
    });

  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: 初回のデプロイは明示の経路（AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy）、Access のアプリができるまで AWSBRIDGE_ACCESS_AUD は仮の値`, () => {
      const text = read(f);
      expect(text).toContain("AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker");
      expect(text).toContain("AWSBRIDGE_ACCESS_AUD");
      expect(text).toMatch(/`pending`/);
    });

    it(`${f}: 内部の呼び名を書かない`, () => {
      const text = read(f);
      for (const re of [
        /G2-/,
        /②|③/,
        /\bpt4\b|private-test4/,
        /X1-\(/,
        /\bcto\b/i,
        /\bSol\b/,
        /\b[KN]\d{1,2}\b/,
        /\bP2\b/,
      ])
        expect(text, String(re)).not.toMatch(re);
    });
  }

  it("英日でバッククォートの語の多重集合が一致する（コードブロックの外）", () => {
    const spans = (p: string) => {
      let inFence = false;
      const lines: string[] = [];
      for (const line of read(p).split("\n")) {
        if (/^\s*```/.test(line)) inFence = !inFence;
        else if (!inFence) lines.push(line);
      }
      // プレースホルダー（<…>）や日本語を含む語は訳すので比べない
      return [...lines.join("\n").matchAll(/`([^`\n]+)`/g)]
        .map((m) => m[1] as string)
        .filter((s) => !/[<>…]|[^ -~]/.test(s))
        .sort();
    };
    expect(spans("README_ja.md")).toEqual(spans("README.md"));
  });
});

describe("README の構成の節の全体図（Mermaid）", () => {
  // 見出しの節の本文のうち、最初の「### 」より前の部分
  const intro = (f: string, h: string): string => {
    const text = read(f);
    const i = text.indexOf(`\n${h}\n`);
    expect(i, h).toBeGreaterThan(0);
    const rest = text.slice(i + h.length + 2);
    const j = rest.indexOf("\n### ");
    expect(j, `### after ${h}`).toBeGreaterThan(0);
    return rest.slice(0, j);
  };
  const mermaid = (s: string) => /```mermaid\n([\s\S]*?)\n```/.exec(s)?.[1];
  const cases: [string, string, string[]][] = [
    ["README.md", "## Architecture", ["MCP Worker", "STS", "AWS MCP Server"]],
    ["README_ja.md", "## 構成", ["MCP Worker", "STS", "AWS MCP Server"]],
  ];
  for (const [f, h, words] of cases)
    it(`${f}: ${h} の冒頭（最初の「### 」より前）に Mermaid の全体図があり、MCP の中継の主な要素を含み、コンソールの要素を含まない`, () => {
      const diagram = mermaid(intro(f, h));
      expect(diagram, "mermaid block").toBeDefined();
      for (const w of words) expect(diagram, w).toContain(w);
      expect(diagram).not.toMatch(/console|コンソール|getSigninToken|Workers Logs/i);
    });
});

// コンソールログインを上流から外したことの案内と、使っていた下流の片付けの順序と決まり。
// 片付けの骨子と各段のコマンドは、タグ console-login-final の版の README にある。
describe("README のコンソールログインの廃止の案内と片付け", () => {
  const section = (f: string, heading: string, next: string) => {
    const text = read(f);
    const i = text.indexOf(`\n${heading}\n`);
    expect(i, heading).toBeGreaterThan(0);
    const j = text.indexOf(`\n${next}\n`, i + 1);
    expect(j, next).toBeGreaterThan(i);
    return { text: text.slice(i, j), before: text.slice(0, i) };
  };
  const cases: [string, string, string, string, string[]][] = [
    [
      "README.md",
      "## What awsbridge does",
      "## Retiring console login and cleaning up",
      "## Upstream and downstream",
      [
        // 1. 外したことと、MCP の中継が変わらないこと
        "Console login has been removed from upstream.",
        "The MCP relay does not change",
        // 2. コンソールの節と片付けの手順はタグの版にある
        "the README and the specs of the version at the tag `console-login-final`",
        "git show console-login-final:README.md",
        "the cleanup outline and the commands of each step are in the README of the tag version",
        // 3. 順序の 4 段
        "do not pull upstream `main`",
        "git fetch upstream --tags && git merge console-login-final",
        "Make your own backup tag",
        "Clean up on that version",
        "Only after the cleanup is done, merge upstream `main`",
        "in your downstream repository, not in a checkout of the upstream tag",
        // 4. 不変条件・決まり
        "Do not give up the issuer host (the Worker, the Custom Domain, and the DNS records) until you have deleted the IAM OIDC provider and confirmed it is gone.",
        "Do not wait a fixed time",
        "the wait before the revoke in step 2 is only a margin",
        "`DeleteConflict`",
        "Do not remove the stop policies (the revoke and the one-person-stop Deny) until the longest session of that role (`MaxSessionDuration`) has expired, counted from the later of the time you confirmed that new issuance is stopped (`503 login_disabled`) and the time of the last revoke (if you revoked again, the time of that one)",
        "Just before you remove them, confirm again that new issuance is not possible (`503 login_disabled`)",
        "retry the stack deletion right away and confirm the role is gone",
        "leave the role whose deletion stopped in place with its stop policies attached",
        "the cleanup is not finished",
        "Deny of `sts:AssumeRoleWithWebIdentity` to that role's trust policy",
        "whether such a role can keep the base StackSet from being deleted",
        // 5. 確かめたことと未確認
        "once in one personal test environment",
        "Not confirmed",
        "has not been run end to end",
      ],
    ],
    [
      "README_ja.md",
      "## awsbridge でできること",
      "## コンソールログインの廃止と片付け",
      "## 上流と下流",
      [
        "コンソールログインは上流から外しました。",
        "MCP の中継は変わりません",
        "タグ `console-login-final` の版の README と仕様",
        "git show console-login-final:README_ja.md",
        "片付けの骨子と各段のコマンドは、タグの版の README にあります",
        "upstream の `main` を pull せず",
        "git fetch upstream --tags && git merge console-login-final",
        "自分の退避タグを打ちます",
        "その版で片付けます",
        "片付けが終わってから、upstream の `main` を取り込みます",
        "上流のタグの作業ツリーではなく、下流のリポジトリで行います",
        "IAM の OIDC プロバイダーを消して、不在を確かめるまで、issuer のホスト（Worker・Custom Domain・DNS のレコード）を手放しません。",
        "固定の時間を待たず",
        "2 段目の revoke の前の待ちは目安です",
        "`DeleteConflict`",
        "停止のためのインラインポリシー（revoke と 1 人停止の Deny）は、そのロールの最長のセッション（`MaxSessionDuration`）が切れるまで外しません。起点は、新しい発行の停止を確かめた時刻（`503 login_disabled` の確認）と、最後の revoke の時刻（やり直したなら、やり直したときの時刻）の、遅いほうです",
        "外す直前に、新しい発行ができないこと（`503 login_disabled`）をもう一度確かめます",
        "すぐにスタックの削除をやり直して、ロールが無いことを確かめます",
        "削除が止まったロールは、停止のポリシーを付けたまま残します",
        "片付けは未完了です",
        "そのロールの信頼ポリシーに `sts:AssumeRoleWithWebIdentity` の Deny を足し",
        "そのロールのせいで base の StackSet が消せない場合があるかは未確認です",
        "個人の検証環境で 1 回",
        "未確認",
        "通しでは試していません",
      ],
    ],
  ];
  for (const [f, prev, heading, next, phrases] of cases) {
    it(`${f}: 「${heading}」が「${prev}」の直後・上流と下流の節の前にあり、外したこと・タグ名・タグの版への案内・順序の 4 段・決まり・未確認を載せる`, () => {
      const { text, before } = section(f, heading, next);
      // 直前の節は「できること」: その節の見出しが、この節より前で最後の「## 」
      expect(before.split("\n## ").pop()?.startsWith(prev.slice(3))).toBe(true);
      expect(text).toContain("`console-login-final`");
      expect(text).toContain("`archive/console-login`");
      for (const p of phrases) expect(text, p).toContain(p);
      // 外す「予定」の書き方は残さない
      expect(text).not.toMatch(/will be removed|外す予定/);
    });
  }
});
