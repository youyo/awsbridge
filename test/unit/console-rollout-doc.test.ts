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
        "mise run console:key:check",
        "mise run console:config:generate -- --ledger-init",
        "mise run console:inspect",
        "mise run console:reconcile",
        "mise run console:exposure-check",
        "mise run console:access:inspect",
        "LOGIN_DISABLED",
        "ADMIN_LOGIN_DISABLED",
        "ADMIN_ACCESS_MAX_AGE_SECONDS",
        "503 login_disabled",
        "sts_denied",
        "not_listed",
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
        "wrangler.<name>-console.jsonc",
      ])
        expect(text, s).toContain(s);
      // P2（B）: Worker・issuer・鍵は 1 つ。階層ごとの Worker・鍵の道具・Admin の issuer のホストを書かない
      for (const s of [
        "console:standard-key:",
        "console:admin-key:",
        "console:secrets:standard",
        "console:secrets:admin",
        "AdminIssuerHost",
        "worker.admin.json",
        "wrangler.<name>-console-admin.jsonc",
        "awsbridge-oidc-admin-console.example.com",
      ])
        expect(text, s).not.toContain(s);
    });

    it(`${d}: 段 4 は弱い Admin ロール（Administrator なし）で、階層をまたぐ負の試験・inspect・照合で Admin の階層として出ることを見る`, () => {
      const text = read(d);
      const start = text.search(/^## (?:Step|段) 4:/m);
      const end = text.search(/^## (?:Step|段) 5:/m);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const s4 = text.slice(start, end);
      for (const s of [
        "team_mismatch",
        "sts_denied",
        "mise run console:inspect",
        "mise run console:reconcile",
        "admin issues",
        "ADMIN_LOGIN_DISABLED",
        "mise run console:key:check",
        "AdministratorTeams",
      ])
        expect(s4, s).toContain(s);
      // 段 5: 人の承認のあと、別スタックで Administrator（change set が Add だけ・作成直後の確認）。弱いロールは最初の発行のあとに消す
      const s5 = text.slice(end);
      for (const s of [
        "AdministratorRole",
        "aws iam get-role",
        "aws iam list-attached-role-policies",
        "mise run console:inspect",
        "awsbridge-console-admin-default",
      ])
        expect(s5, s).toContain(s);
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
        /\bM(?:[1-9]|1[01])\b/,
        /\bDN[1-8]\b/,
        /X1-\(/,
        /\b[KN]\d{1,2}\b/,
        /\bP2\b/,
      ])
        expect(text, String(re)).not.toMatch(re);
      // アカウント ID らしい 12 桁は例の 111111111111 だけ
      for (const m of text.matchAll(/\b\d{12}\b/g)) expect(m[0]).toBe("111111111111");
      // email は例のドメインだけ
      for (const m of text.matchAll(/[\w.+-]+@([\w-]+\.)+[\w-]+/g))
        expect(m[0]).toMatch(/@example\.(com|org)$/);
    });
  }
  // Sol の指摘（S1・S2・S3・S5）と照合の件数（S4）: 段 5 の最初に Admin の発行を止める、省けない確認、
  // Worker で止められないときの AWS 側への切り替え、段 4 の ADMIN_LOGIN_DISABLED の前後の順、admin issues を固定値にしない
  const MUST: Record<string, { how: string[]; step4: string[]; step5: string[]; gone: string[] }> =
    {
      [EN]: {
        how: [
          "**When the Worker cannot stop it:**",
          "Switch to the AWS side",
          "add revoke (L3) for sessions already issued",
          "../README.md#stopping-issuance-without-relying-on-cloudflare-l2-and-trust-policy-deny",
          "**Checks that cannot be waived:**",
          "None of them moves on without a passing re-run, even with a decision of your technical decision maker",
          "the record then holds the reason, the alternative evidence, and a deadline",
        ],
        step4: [
          "**Order around `ADMIN_LOGIN_DISABLED`:**",
          'set it back to `"true"`, deploy, and confirm `503 login_disabled`',
        ],
        step5: [
          'First set `ADMIN_LOGIN_DISABLED` to `"true"`, deploy, and confirm that a login on the Admin-tier team\'s path returns `503 login_disabled`',
          "Keep it there until every check right after the creation (below) has passed",
          "Present the results to your technical decision maker again and get their technical approval",
        ],
        gone: ["or after your technical decision maker decides"],
      },
      [JA]: {
        how: [
          "**Worker で止められないとき**",
          "AWS の側に切り替えます",
          "発行済みのセッションには revoke（L3）を足します",
          "../README_ja.md#発行を-cloudflare-に頼らずに止めるl2-と信頼ポリシーの拒否",
          "**省けない確認**",
          "技術の判断者が決めても、確認をやり直して通るまでは先へ進みません",
          "理由・代わりの証拠・期限を記録します",
        ],
        step4: [
          "**`ADMIN_LOGIN_DISABLED` の前後の順**",
          '`"true"` に戻してデプロイし、`503 login_disabled` を確かめてから調べる',
        ],
        step5: [
          'まず `ADMIN_LOGIN_DISABLED` を `"true"` にしてデプロイし、Admin の階層のチームのパスのログインが `503 login_disabled` になることを確かめます',
          "作成の直後の確認（下）がすべて通るまでそのままにします",
          "結果を技術の判断者に出し直し、技術の承認を取ります",
        ],
        gone: ["または技術の判断者が決めてから"],
      },
    };
  for (const d of DOCS) {
    it(`${d}: 段 5 の最初に Admin の発行を止め、省けない確認と AWS 側への切り替えを書き、admin issues を固定値にしない`, () => {
      const text = read(d);
      const m = MUST[d] as (typeof MUST)[string];
      const how = text.slice(text.search(/^## /m), text.search(/^## (?:Step|段) 0:/m));
      for (const s of m.how) expect(how, s).toContain(s);
      const s4 = text.slice(text.search(/^## (?:Step|段) 4:/m), text.search(/^## (?:Step|段) 5:/m));
      for (const s of m.step4) expect(s4, s).toContain(s);
      const s5 = text.slice(text.search(/^## (?:Step|段) 5:/m));
      for (const s of m.step5) expect(s5, s).toContain(s);
      // 段 5 で ADMIN_LOGIN_DISABLED を外すのは、作成の直後の確認のあと
      expect(s5.indexOf('"false"')).toBeGreaterThan(
        s5.indexOf("aws iam list-attached-role-policies"),
      );
      for (const s of m.gone) expect(text, s).not.toContain(s);
      expect(text).not.toContain("admin issues: 1");
    });
  }
});

// 毎日の照合: 読み始めは状態から決まる。毎日回す・空いた日数の限界・状態が進まないときの手順・状態のファイルの限界・--since 6d は監査用
describe("本番の導入の文書: 毎日の照合の読み始めと状態のファイル", () => {
  const PHRASES: Record<string, string[]> = {
    [JA]: [
      "`--since` を付けずに毎日回します",
      "`read start:`",
      "`from the state`",
      "間引かれずに読めると実測で確かめた期間",
      "今の道具の読み方では",
      "どの区間を検証できなかったかを記録し",
      "状態のファイルを黙って消しません",
      "その日のうちに所見（時刻・code・`jti` の先頭・ロール）を道具の外に記録します",
      "原因が分かるまで `--overlap-seconds` と `--since` を変えず、状態のファイルを作り直しません",
      "解決か受け入れを記録してから再開します",
      "検証して再開",
      "検証できないまま受け入れて再開",
      "アカウント・検証できなかった区間・未解決の所見・理由・判断した人と日時・状態のファイルの変更の前後",
      "終了コード 0 は、重なりの外に遅れて出た引き受けが無いことの証明ではありません",
      "状態のファイルを書ける者は",
      "`--since 6d`",
    ],
    [EN]: [
      "Run it every day without `--since`",
      "`read start:`",
      "`from the state`",
      "the period measured to read without sampling",
      "the current way the tool reads",
      "record which interval could not be verified",
      "Do not delete the state file silently",
      "record the findings (time, code, the start of the `jti`, role) outside the tool the day they appear",
      "Until the cause is known, do not change `--overlap-seconds` or `--since`, and do not rebuild the state file",
      "Resume only after recording the resolution or the acceptance",
      "resume after verification",
      "resume by accepting it unverified",
      "the account, the interval that could not be verified, the unresolved findings, the reason, who decided and when, and the state file before and after the change",
      "Exit code 0 does not prove that no assumption showed up late outside the overlap",
      "Anyone who can write the state file",
      "`--since 6d`",
    ],
  };
  for (const d of DOCS)
    it(`${d}: 段 3 に、毎日回すこと・読み始めの確かめ方・空いた日数の限界・状態が進まないときの手順・状態のファイルの限界・監査用の --since 6d を書く`, () => {
      const text = read(d);
      const i = text.indexOf(d === JA ? "## 段 3" : "## Step 3");
      const j = text.indexOf(d === JA ? "## 段 4" : "## Step 4");
      expect(i).toBeGreaterThan(0);
      const s3 = text.slice(i, j);
      for (const s of PHRASES[d] ?? []) expect(s3, s).toContain(s);
      expect(s3).not.toContain(
        d === JA ? "その間の発行は検証できなくなります" : "can no longer be verified",
      );
    });
  for (const d of DOCS)
    it(`${d}: 段 5 の判断に、CloudTrail の反映の遅れの実測と重なりの決め方を入れる。段 2 の当日に遅れを記録する`, () => {
      const text = read(d);
      const s5 = text.slice(text.indexOf(d === JA ? "## 段 5" : "## Step 5"));
      expect(s5).toContain(d === JA ? "反映の遅れの実測" : "measured CloudTrail delay");
      expect(s5).toContain("`--overlap-seconds`");
      const s2 = text.slice(
        text.indexOf(d === JA ? "### 最初の発行の当日" : "### On the day of the first issuance"),
        text.indexOf(d === JA ? "## 段 3" : "## Step 3"),
      );
      expect(s2).toContain(
        d === JA
          ? "引き受けが CloudTrail に初めて見えた時刻"
          : "the time the assumption first appeared in CloudTrail",
      );
    });
});
