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

// README の作り直し（#51 の並び）を P2（B）の構成（1 つの Worker・1 つの issuer・1 つのプロバイダー）に合わせたもの
describe("README の並びと P2（B）の構成", () => {
  const order = (f: string, hs: string[]) => {
    const text = read(f);
    let at = -1;
    for (const h of hs) {
      const i = text.indexOf(`\n${h}\n`);
      expect(i, h).toBeGreaterThan(at);
      at = i;
    }
  };
  it("README.md: できること → 受容 → 上流と下流 → 構成 → 下流 → デプロイの経路 → MCP → コンソール → 日々の運用 → 停止 → 棚卸し → 移行 → 開発", () =>
    order("README.md", [
      "## What awsbridge does",
      "## Before using console login (accepted limits)",
      "## Upstream and downstream",
      "## Architecture",
      "## Operating in a downstream repository",
      "## How the Worker is deployed (default route and explicit route)",
      "## MCP relay setup",
      "## Console login setup",
      "## Daily operations",
      "## Stopping issuance (console login)",
      "## Inventory of what an Administrator left behind (console login)",
      "## Migrating an existing MCP deployment",
      "## Development",
    ]));
  it("README_ja.md: 同じ並び", () =>
    order("README_ja.md", [
      "## awsbridge でできること",
      "## コンソールログインを使う前に（受容する限界）",
      "## 上流と下流",
      "## 構成",
      "## 下流リポジトリでの運用",
      "## Worker のデプロイの経路（既定と明示）",
      "## MCP の中継のセットアップ",
      "## コンソールログインのセットアップ",
      "## 日々の運用",
      "## 発行を止める（コンソールログイン）",
      "## コンソールログインの Administrator の残った権限の棚卸し",
      "## MCP の中継の既存のデプロイの移行",
      "## 開発",
    ]));

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
    ["README.md", "## Architecture", ["MCP Worker", "Console Worker", "STS", "AWS MCP Server"]],
    ["README_ja.md", "## 構成", ["MCP Worker", "コンソール Worker", "STS", "AWS MCP Server"]],
  ];
  for (const [f, h, words] of cases)
    it(`${f}: ${h} の冒頭（最初の「### 」より前）に Mermaid の全体図があり、主な要素を含む`, () => {
      const diagram = mermaid(intro(f, h));
      expect(diagram, "mermaid block").toBeDefined();
      for (const w of words) expect(diagram, w).toContain(w);
    });
});

// コンソールログインを上流から外す予定の案内と、使っていた下流の片付けの手順（コンソールログインの廃止の案内）。
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
      "## Before using console login (accepted limits)",
      [
        // 1. 外す予定と、MCP の中継が変わらないこと
        "Console login will be removed from upstream.",
        "The MCP relay does not change",
        // 2. 順序の 4 段
        "do not pull upstream `main`",
        "git fetch upstream --tags && git merge console-login-final",
        "Make your own backup tag",
        "Clean up on that version",
        "Only after the cleanup is done, merge upstream `main`",
        "in your downstream repository, not in a checkout of the upstream tag",
        // 3. 片付けの骨子（8 段）
        "`LOGIN_DISABLED`",
        "then wait at least the JWT lifetime (300 seconds) plus the clock skew (60 seconds, the default of the reconciliation)",
        "is not accepted by STS after that (`exp` = `iat` + 300)",
        "This is a margin, not a guarantee",
        "step 3 gives the guarantee",
        "the wait before the revoke in step 2 is only a margin",
        "revoke the sessions already issued, before deleting anything on the AWS side",
        "no `AssumeRoleWithWebIdentity` of a console role in CloudTrail after the time of the last revoke",
        "revoke again for that role and run the reconciliation again",
        "last reconciliation and the external check",
        // 3 段目の完了の条件（照合の確認済みの区間の終わりは反映の遅れだけ手前になる）
        "at least the reflection delay (300 seconds by default) after the time you stopped new issuance",
        "the end of the confirmed interval is past the time you stopped issuance",
        "no unresolved findings (resolved, or explicitly accepted)",
        "Take inventory of the permissions left",
        "the separate Administrator stacks, then the role stacks of each kind, then the base StackSet",
        "first delete the stack instances in every target account without retaining the stacks",
        "and only then delete the StackSet itself",
        "all the console IAM OIDC providers are gone and that providers for other uses, such as the MCP one, are unchanged",
        "Delete the console Worker",
        "Delete the Access applications and the DNS records",
        "Clean up the generated files, state files, and tokens",
        // 4. 不変条件・決まり
        "Do not give up the issuer host (the Worker, the Custom Domain, and the DNS records) until you have deleted the IAM OIDC provider and confirmed it is gone.",
        "Do not wait a fixed time",
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
      "## コンソールログインを使う前に（受容する限界）",
      [
        "コンソールログインは上流から外す予定です。",
        "MCP の中継は変わりません",
        "upstream の `main` を pull せず",
        "git fetch upstream --tags && git merge console-login-final",
        "自分の退避タグを打ちます",
        "その版で片付けます",
        "片付けが終わってから、upstream の `main` を取り込みます",
        "上流のタグの作業ツリーではなく、下流のリポジトリで行います",
        "`LOGIN_DISABLED`",
        "JWT の寿命 300 秒と時計のずれ（照合の既定 60 秒）を足した長さ以上待ち",
        "その長さを過ぎると STS が受け付けません（`exp` = `iat` + 300）",
        "目安であって保証ではありません",
        "保証は次の段の最後の照合が担います",
        "2 段目の revoke の前の待ちは目安です",
        "AWS 側の削除の前に、発行済みのセッションを revoke し",
        "最後の revoke の時刻より後に、コンソール用のロールの `AssumeRoleWithWebIdentity` が CloudTrail に無いこと",
        "そのロールで revoke をやり直し、照合をやり直します",
        "最後の照合と外からの確認",
        "新しい発行を止めた時刻から、反映の遅れ（既定 300 秒）以上たってから",
        "確認済みの区間の終わりが、停止の時刻を越えた",
        "未解決の所見が無い（解決するか、明示して受け入れる）",
        "残った権限の棚卸し",
        "Administrator の別スタック → 種類のロールのスタック → base の StackSet",
        "スタックインスタンスを、スタックを残さない形で消し",
        "StackSet 本体を消します",
        "コンソール用の OIDC プロバイダーがすべて無くなり、MCP 用など他の用途のプロバイダーは変わっていないことを確かめます",
        "コンソールの Worker を消します",
        "Access のアプリと DNS のレコードを消します",
        "生成物・状態ファイル・トークンを片付けます",
        "IAM の OIDC プロバイダーを消して、不在を確かめるまで、issuer のホスト（Worker・Custom Domain・DNS のレコード）を手放しません。",
        "固定の時間を待たず",
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
    it(`${f}: 「${heading}」が「${prev}」の直後・受容の節の前にあり、タグ名・順序の 4 段・片付けの骨子・決まり・未確認を載せる`, () => {
      const { text, before } = section(f, heading, next);
      // 直前の節は「できること」: その節の見出しが、この節より前で最後の「## 」
      expect(before.split("\n## ").pop()?.startsWith(prev.slice(3))).toBe(true);
      expect(text).toContain("`console-login-final`");
      expect(text).toContain("`archive/console-login`");
      for (const p of phrases) expect(text, p).toContain(p);
    });
  }
});
