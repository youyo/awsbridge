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

describe("README のコンソールログインの Admin の署名鍵（X1 の決裁）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: put（--yes）・check・retire の手順、secret_key、別の名前での差し替えを載せ、「KMS 相当」と書かない`, () => {
      const text = read(f);
      for (const s of [
        "mise run console:admin-key:put -- --yes",
        "mise run console:admin-key:check",
        "mise run console:admin-key:retire -- --binding",
        "secret_key",
        "ADMIN_KEY_",
        "ADMIN_CURRENT_KEY",
        "ADMIN_PUBLIC_JWKS",
        "AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN",
      ])
        expect(text, s).toContain(s);
      expect(text).not.toMatch(/KMS 相当|equivalent to KMS|KMS-equivalent/i);
    });
  }
});

describe("README のコンソールログインの Admin の CSRF の鍵と初回のデプロイの順（cto の決裁 G2 の論点 5）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: console:secrets:admin（--yes）と、Admin の初回のデプロイの順を載せる`, () => {
      const text = read(f);
      for (const s of [
        "mise run console:secrets:admin -- --yes",
        "mise run console:admin-key:put -- --yes",
        "mise run console:admin-key:check",
        "AdminIssuerHost",
        "wrangler.console-admin.jsonc",
      ])
        expect(text, s).toContain(s);
    });
  }
});

describe("README のコンソールログインの Standard の署名鍵（cto の決裁「Standard も secret_key に揃える」）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: 境界ごとの put（--boundary --yes）・check・retire、CSRF の鍵、secret_key、更新の経路（PoC X1-(h)）を載せ、「KMS 相当」と書かない`, () => {
      const text = read(f);
      for (const s of [
        "mise run console:standard-key:put -- --boundary",
        "mise run console:standard-key:check",
        "mise run console:standard-key:retire -- --binding",
        "mise run console:secrets:standard -- --yes",
        "STANDARD_KEY_",
        "STANDARD_CURRENT_KEYS",
        "STANDARD_PUBLIC_JWKS",
        "AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN",
        "CONSOLE_CSRF_KEY",
        "secret bulk",
        "mise run console:build:standard",
        "mise run console:dev",
      ])
        expect(text, s).toContain(s);
      expect(text).toContain("AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG");
      expect(text).not.toContain("AWSBRIDGE_CONSOLE_WRANGLER_CONFIG");
      expect(text).not.toContain("console:keygen");
      expect(text).not.toContain("CONSOLE_SIGNING_KEYS");
      expect(text).not.toMatch(/KMS 相当|equivalent to KMS|KMS-equivalent/i);
    });
  }
});

describe("README の Administrator の残った権限の棚卸し（cto の決裁 G2 の論点 5）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: ロールの管理ポリシー・インラインポリシー・信頼ポリシー、プロバイダー、CloudTrail を SourceIdentity で拾う例を載せる`, () => {
      const text = read(f);
      for (const s of [
        "aws iam get-role",
        "aws iam list-attached-role-policies",
        "aws iam list-role-policies",
        "aws iam get-role-policy",
        "aws iam list-open-id-connect-providers",
        "aws iam get-open-id-connect-provider",
        "aws cloudtrail lookup-events",
        "sourceIdentity",
        "mise run console:inspect",
      ])
        expect(text, s).toContain(s);
    });
  }
});

describe("README の突き合わせの間隔（毎日回す。利用者の判断 2026-11-13）", () => {
  it("README_ja.md: 毎日回す・発行の有無に関係なく・6 日以内なら穴はできない・7 日の文は残す・外で行う。3 日以内・当日中・週 1 回とは書かない", () => {
    const text = read("README_ja.md");
    for (const s of [
      "突き合わせは毎日回します。Administrator の発行の有無に関係なく回します",
      "回せない日があっても、6 日以内に回せば検証の穴はできません",
      "7 日以内に突き合わせなかった発行は、あとから検証できません",
      "`coverage_gap`（誤り。終了コード 1）",
      "毎日の実行は awsbridge の外（MCP 経由のエージェントなど）で行います",
      "awsbridge には定期の実行の仕組みを入れません",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("3 日以内");
    expect(text).not.toContain("当日中");
    expect(text).not.toContain("週 1 回");
  });
  it("README.md: run it every day regardless of issuance, no gap within 6 days, keeps the 7-day sentence, done outside awsbridge. No 3 days, same day, or weekly", () => {
    const text = read("README.md");
    for (const s of [
      "Run the reconciliation every day, whether or not an Administrator issued anything",
      "if you cannot run it on some day, no verification gap opens as long as you run it within 6 days",
      "an issuance not reconciled within 7 days cannot be verified later",
      "`coverage_gap` (error, exit code 1)",
      "outside awsbridge (for example an agent over MCP)",
      "awsbridge has no scheduler",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("within 3 days");
    expect(text).not.toContain("on the same day");
    expect(text).not.toMatch(/once a week/i);
  });
  it("mise.toml: console:reconcile の説明と注記は毎日回すと書き、3 日以内・当日中とは書かない", () => {
    const text = read("mise.toml");
    const i = text.indexOf('[tasks."console:reconcile"]');
    expect(i).toBeGreaterThan(0);
    const from = text.lastIndexOf(
      "# ---- コンソールログイン: 発行記録と CloudTrail の突き合わせ",
      i,
    );
    const section = text.slice(from, i + 1200);
    expect(section).toContain("毎日回す");
    expect(section).toContain("6 日以内");
    expect(section).toContain("7 日以内に回さなかった発行はあとから検証できない");
    expect(section).not.toContain("3 日以内");
    expect(section).not.toContain("当日中");
  });
});

describe("突き合わせの運用と検査の文面（cto の決裁 G2 の途中経過 2026-11-13）", () => {
  it("README_ja.md: 時間・利用者・確認済みの区間の検査と仮のしきい値を書く", () => {
    const text = read("README_ja.md");
    for (const s of [
      "assume_time_gap",
      "--clock-skew-seconds",
      "しきい値は仮です",
      "identity_mismatch",
      "identity_not_compared",
      "coverage_gap",
      "--state",
      ".secrets/console-reconcile-state.json",
      "区間を進めるのは終了コード 0 の実行だけ",
    ])
      expect(text, s).toContain(s);
  });
  it("README.md: time, identity and confirmed-interval checks with provisional thresholds", () => {
    const text = read("README.md");
    for (const s of [
      "assume_time_gap",
      "--clock-skew-seconds",
      "The thresholds are provisional",
      "identity_mismatch",
      "identity_not_compared",
      "coverage_gap",
      "--state",
      ".secrets/console-reconcile-state.json",
      "Only a run with exit code 0 advances the interval",
    ])
      expect(text, s).toContain(s);
  });
  for (const f of ["docs/specs/console-login.md", "docs/specs/console-login-admin.md"]) {
    it(`${f}: 「Cloudflare に頼らない停止は L2 だけ」とは書かず、発行の停止は L2 と信頼ポリシーの拒否、revoke は発行の停止に数えない`, () => {
      const text = read(f);
      expect(text).not.toMatch(/Cloudflare に頼らない停止は、(全アカウントの L2 だけ|これだけ)/);
      expect(text).toMatch(/Cloudflare に頼らない発行の停止は、.*L2.*信頼ポリシー/);
      expect(text).toContain("revoke は");
      expect(text).toContain("突き合わせは毎日回す");
      expect(text).not.toContain("3 日以内");
      expect(text).not.toContain("当日中");
      expect(text).not.toContain("主は固定の間隔");
    });
  }
  it("docs/specs/console-login.md: 記録で捕まらないものに、発行から 5 分以内に使う同じ jti の作り直し（Workers Logs を読める必要）を挙げる", () => {
    const text = read("docs/specs/console-login.md");
    const i = text.indexOf("記録で捕まるもの・捕まらないもの");
    expect(i).toBeGreaterThan(0);
    const section = text.slice(i, i + 1500);
    expect(section).toContain("捕まらない");
    expect(section).toContain("発行から 5 分以内に使う、同じ `jti` の作り直し");
    expect(section).toContain("Workers Logs を読める必要がある");
  });
});

describe("突き合わせの運用: 誤りのあとの回し直しと --since の長さ", () => {
  it("README_ja.md: 誤りが出た実行は区間を進めない・決着したら --since を前回の終わり以前に戻して回し直す・7 日を過ぎると検証できない・放置すると coverage_gap が重なる・--since は間隔より 5 分以上長く", () => {
    const text = read("README_ja.md");
    for (const s of [
      "誤りが出た実行は区間を進めません",
      "`--since` を前回の終わり以前に戻して回し直し、区間を進めます",
      "記録の保持の 7 日を過ぎた分は検証できません",
      "`coverage_gap` が重なって出ます",
      "`--since` は回す間隔より 5 分以上長くします",
      "毎日回すなら既定の 6 日のままにします",
    ])
      expect(text, s).toContain(s);
  });
  it("README.md: same points in English", () => {
    const text = read("README.md");
    for (const s of [
      "A run with errors does not advance the interval.",
      "re-run with `--since` set at or before the previous end",
      "Anything past the 7-day record retention can no longer be verified",
      "`coverage_gap` errors pile up",
      "Make `--since` at least 5 minutes longer than your run interval",
      "if you run it every day, keep the default of 6 days",
    ])
      expect(text, s).toContain(s);
  });
});
