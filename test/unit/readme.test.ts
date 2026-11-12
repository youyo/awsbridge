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

describe("README の突き合わせの間隔（cto の決裁 G2 の前回の訂正）", () => {
  it("README_ja.md: Administrator の発行があった日は当日中、それ以外も 3 日以内。7 日の文は残し、週 1 回とは書かない", () => {
    const text = read("README_ja.md");
    expect(text).toContain("Administrator の発行があった日は当日中");
    expect(text).toContain("3 日以内");
    expect(text).toContain("7 日以内に突き合わせなかった発行は、あとから検証できません");
    expect(text).not.toContain("週 1 回");
  });
  it("README.md: same day after an Administrator issuance, otherwise within 3 days. Keeps the 7-day sentence, no weekly", () => {
    const text = read("README.md");
    expect(text).toContain("on the same day");
    expect(text).toContain("within 3 days");
    expect(text).toContain("an issuance not reconciled within 7 days cannot be verified later");
    expect(text).not.toMatch(/once a week/i);
  });
});
