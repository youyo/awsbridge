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

describe("README の受容する限界（P2（B）の設計メモ §8.2。cto の決裁 2026-11-17）", () => {
  // 冒頭の受容の節: 「awsbridge でできること」の直後、「## 上流と下流」/「## Upstream and downstream」より前にあること（目立つ所）
  const top = (f: string, next: string) => {
    const text = read(f);
    const j = text.indexOf(next);
    expect(j, next).toBeGreaterThan(0);
    return text.slice(0, j);
  };
  it("README_ja.md: 警告の文・受容 a〜e・注記を、上流と下流の節より前に載せる", () => {
    const text = top("README_ja.md", "\n## 上流と下流");
    for (const s of [
      "## コンソールログインを使う前に（受容する限界）",
      "**コンソールの Worker をデプロイできる者と、その secret・依存物に触れる者は、Administrator を配った全アカウントの全権を持ちます。**",
      "a. コンソールの Worker 全体が Administrator の発行の権威です。",
      "Viewer のためだけの変更でも同じです",
      "b. Worker のデプロイと鍵の操作は、Administrator を発行してよい人だけが行います。",
      "c. 入口・一覧・画面のスクリプトは、Administrator の発行と同じオリジンで動きます",
      "確認画面はこれを止めません",
      "d. Viewer と Administrator を分けるのは、Worker が Access のアプリの AUD から決めたチームと、そのチームを入れたセッションタグ、ロールの信頼ポリシーのチームの条件だけです。",
      "チームの名前を階層をまたいで使い直さないでください",
      "e. OIDC プロバイダーを消すと、Viewer も Administrator も止まります。",
      "Administrator のロールの信頼ポリシーでの拒否と、Administrator のスタックの削除です",
      "発行記録はこの Worker 自身が書くので",
      "発行済みのセッションは止めません",
      "利用者が認証してからの時間ではありません",
      "Workers Logs を読める人",
      "`retiredTeams`",
    ])
      expect(text, s).toContain(s);
  });
  it("README.md: the warning, acceptances a-e and the notes come before the Upstream and downstream section", () => {
    const text = top("README.md", "\n## Upstream and downstream");
    for (const s of [
      "## Before using console login (accepted limits)",
      "**Anyone who can deploy the console Worker, or who can touch its secrets or dependencies, holds full control of every account where Administrator is deployed.**",
      "a. The whole console Worker is the authority that issues Administrator.",
      "This holds even for a change made only for Viewer",
      "b. Only people allowed to issue Administrator deploy the Worker and operate the keys.",
      "c. The scripts of the entry page, the lists, and the screens run on the same origin as Administrator issuance",
      "The confirmation screen does not stop this",
      "d. The only things that separate Viewer from Administrator are the team the Worker derives from the Access application's AUD, the session tag that carries that team, and the team condition in the role trust policy.",
      "Do not reuse a team name across tiers",
      "e. Deleting the OIDC provider stops both Viewer and Administrator.",
      "a Deny in the Administrator role's trust policy and deleting the Administrator stack",
      "The issue records are written by this Worker itself",
      "they do not stop sessions already issued",
      "not the time since the user authenticated",
      "Anyone who can read Workers Logs",
      "`retiredTeams`",
    ])
      expect(text, s).toContain(s);
  });
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: 1 つの Worker に揃え、Admin の Worker・Admin の鍵の道具・Admin の issuer のホストを載せない`, () => {
      const text = read(f);
      for (const s of [
        "ADMIN_LOGIN_DISABLED",
        "ADMIN_ACCESS_MAX_AGE_SECONDS",
        "`IssuerPath`",
        "team_tier_mismatch",
        "team_not_in_config",
        "trust_team_tier",
        "trust_team_retired",
      ])
        expect(text, s).toContain(s);
      for (const s of [
        "console:admin-key:",
        "console:secrets:admin",
        "AdminIssuerHost",
        "AdminPath",
        "StandardPath",
        "wrangler.console-admin.jsonc",
        "ADMIN_PUBLIC_JWKS",
        "ADMIN_CURRENT_KEY",
        "ADMIN_KEY_",
        "AWSBRIDGE_CONSOLE_ADMIN_",
        "worker.admin.json",
        "worker.standard.json",
        "awsbridge-console-admin`",
      ])
        expect(text, s).not.toContain(s);
    });
  }
  it("README_ja.md / README.md: 台帳の限界（cto の決裁 2026-11-17 の c8）を受容の節（上流と下流の節より前）に書く", () => {
    const ja = top("README_ja.md", "\n## 上流と下流");
    for (const x of [
      "台帳は運用者の取り違えを止める守りで、設定を書ける者への守りではありません",
      "生成物を消して初回の指定（`--ledger-init`）を付ければ外せます",
      "管理外に出たアカウントの古いロールは `mise run console:inspect` でも見えず、守りは台帳だけです",
    ])
      expect(ja, x).toContain(x);
    const en = top("README.md", "\n## Upstream and downstream");
    for (const x of [
      "The ledger guards against operator mistakes, not against anyone who can write the config",
      "deleting the artifacts and passing the first-run flag (`--ledger-init`) removes it",
      "old roles in an account that has left management are not visible to `mise run console:inspect` either; the ledger is the only guard",
    ])
      expect(en, x).toContain(x);
  });

  it("README_ja.md / README.md: 台帳の手順（c7）。--ledger-init のあとはデプロイの前に inspect、前回の生成物か baseline を保管する", () => {
    const ja = read("README_ja.md");
    for (const x of [
      "`mise run console:config:generate -- --ledger-init`",
      "`--ledger-init` を使ったら、デプロイの前に `mise run console:inspect` を回します",
      "`--ledger-baseline <path>`",
      "前回の生成物（`.generated/console/stacksets.json`）か baseline を保管します",
    ])
      expect(ja, x).toContain(x);
    expect(ja).not.toContain("前回が無いときは警告");
    const en = read("README.md");
    for (const x of [
      "`mise run console:config:generate -- --ledger-init`",
      "After using `--ledger-init`, run `mise run console:inspect` before you deploy",
      "`--ledger-baseline <path>`",
      "Keep the previous artifacts (`.generated/console/stacksets.json`) or a baseline",
    ])
      expect(en, x).toContain(x);
    expect(en).not.toContain("without previous artifacts it warns");
  });

  it("README_ja.md / README.md: inspect を回す時点（c1）。Administrator のロールを作った直後・チームかロールの設定を変えたあと・段 4", () => {
    expect(read("README_ja.md")).toContain(
      "**`mise run console:inspect` は、Administrator のロールを作った直後と、チームかロールの設定を変えたあとに必ず回します**",
    );
    expect(read("README.md")).toContain(
      "**Always run `mise run console:inspect` right after creating the Administrator role and after changing the team or role settings**",
    );
    expect(read("README_ja.md")).toContain("段 4（Admin の階層を入れる段）でも回します");
    expect(read("README.md")).toContain("also at step 4 (the step that adds the Admin tier)");
  });
});

describe("README のコンソールログインの Standard の署名鍵（cto の決裁「Standard も secret_key に揃える」）", () => {
  for (const f of ["README.md", "README_ja.md"]) {
    it(`${f}: 境界ごとの put（--boundary --yes）・check・retire、CSRF の鍵、secret_key、更新の経路（PoC X1-(h)）を載せ、「KMS 相当」と書かない`, () => {
      const text = read(f);
      for (const s of [
        "mise run console:key:put -- --boundary",
        "mise run console:key:check",
        "mise run console:key:retire -- --binding",
        "mise run console:secrets -- --yes",
        "CONSOLE_KEY_",
        "CONSOLE_CURRENT_KEYS",
        "CONSOLE_PUBLIC_JWKS",
        "AWSBRIDGE_CONSOLE_CF_API_TOKEN",
        "CONSOLE_CSRF_KEY",
        "secret bulk",
        "mise run console:build",
        "mise run console:dev",
      ])
        expect(text, s).toContain(s);
      expect(text).toContain("AWSBRIDGE_CONSOLE_WRANGLER_CONFIG");
      expect(text).not.toContain("AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG");
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
  it("README_ja.md: 時間・利用者・確認済みの区間の検査を書く（時間の検査は c5 で誤り）", () => {
    const text = read("README_ja.md");
    for (const s of [
      "assume_time_gap",
      "--clock-skew-seconds",
      "`assume_time_gap`（誤り",
      "identity_mismatch",
      "identity_not_compared",
      "coverage_gap",
      "--state",
      ".secrets/console-reconcile-state.json",
      "区間を進めるのは終了コード 0 の実行だけ",
    ])
      expect(text, s).toContain(s);
  });
  it("README.md: time, identity and confirmed-interval checks (the time check is an error since c5)", () => {
    const text = read("README.md");
    for (const s of [
      "assume_time_gap",
      "--clock-skew-seconds",
      "`assume_time_gap` (error",
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

// 読み始めを状態から決める（確認済みの区間の終わり − 重なり。--overlap-seconds）。原因は断定しない
describe("突き合わせの運用: 読み始めを状態から決める・状態のファイルの限界・状態が進まないときの手順", () => {
  it("README_ja.md: 読み始め・重なり（既定 24 時間・下限 1 時間・lag と別）・--since が勝つ・監査は --since 6d・read start の行・原因は未確認・限界・作り直しの手順・空いた日数の限界", () => {
    const text = read("README_ja.md");
    for (const s of [
      "「確認済みの区間の終わり − 重なり」と「今 − 6 日」の遅いほう",
      "`--overlap-seconds <n>`（既定 `86400` = 24 時間、下限 `3600` = 1 時間",
      "反映の遅れ（`--lag-seconds`）とは別の値",
      "`--since` を渡せばそれが勝ちます",
      "全部を読み直す監査には `--since 6d` を使います",
      "`read start:`",
      "間引かれたのが保存のときか照会のときかは確かめていません",
      "状態のファイルを書ける者は、確認済みの区間の終わりを先へ進めて",
      "どの区間を検証できなかったかを記録します",
      "状態のファイルを黙って消しません",
      "間引かれずに読めると実測で確かめた期間を超えると、今の道具の読み方では、その間を完全に読めたことを確かめられません",
      // 誤りのある実行は進めない、の保証の範囲（読んだ窓の中だけ）と、窓の外へ出た誤り
      "保証するのは、その実行で読んだ窓に誤りがあれば区間を進めないことまでです",
      "次の実行では読まれず、終了コード 0 で区間が進みます",
      "`oldest error finding:`",
      "その日のうちに、所見を道具の外に記録します",
      "原因が分かるまで `--overlap-seconds` と `--since` を変えず、状態のファイルを作り直しません",
      // 重なりの値の根拠と、正常終了の意味
      "終了コード 0 は、重なりの外に遅れて出た引き受けが無いことの証明ではありません",
      "安全を裏付けた値ではありません",
      "重なりを短くする条件は、実測（遅れの分布）で決めます",
      // 読めなくなったときの順序と、2 つの再開
      "保持の期限（7 日）の内に証拠を残します",
      "短い窓で読み直します",
      "検証して再開",
      "検証できないまま受け入れて再開",
      "判断した人と日時",
      // --until と --overlap-seconds の扱い
      "状態から決めた読み始めが `--until` 以後になると実行しません（終了コード 2）",
      "`--overlap-seconds` を使わないことを 1 行出します",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toMatch(/取り込み時に間引かれ/);
    expect(text).not.toContain("その間の発行は検証できなくなります");
    expect(text).not.toContain("誤りが埋もれるため");
  });
  it("README.md: same points in English", () => {
    const text = read("README.md");
    for (const s of [
      'the later of "the end of the confirmed interval minus the overlap" and "now minus 6 days"',
      "`--overlap-seconds <n>` (default `86400` = 24 hours, minimum `3600` = 1 hour",
      "a value separate from the propagation lag (`--lag-seconds`)",
      "`--since` always wins",
      "For an audit that reads everything again, use `--since 6d`",
      "`read start:`",
      "Whether the sampling happened at storage or at query time has not been confirmed",
      "anyone who can write the state file can move the end of the confirmed interval forward",
      "record which interval could not be verified",
      "Do not delete the state file silently",
      "If you skip more days than the period measured to read without sampling, the current way the tool reads cannot confirm that the interval in between was read completely",
      "What this guarantees is only that a run with an error in the window it read does not advance the interval",
      "the next run does not read it, and the interval advances with exit code 0",
      "`oldest error finding:`",
      "record the findings outside the tool the day they appear",
      "Until the cause is known, do not change `--overlap-seconds` or `--since`, and do not rebuild the state file",
      "Exit code 0 does not prove that no assumption showed up late outside the overlap",
      "not values shown to be safe",
      "The conditions for shortening the overlap are decided by measurement (the distribution of the delay",
      "keep the evidence within the retention (7 days)",
      "read it again in short windows",
      "resume after verification",
      "resume by accepting it unverified",
      "who decided and when",
      "the start taken from the state is at or after `--until`, the tool refuses to run (exit code 2)",
      "prints one line saying that `--overlap-seconds` is not used",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toMatch(/sampled at ingestion/i);
    expect(text).not.toContain("the issuances in between can no longer be verified");
    expect(text).not.toContain("and bury them");
  });
  it("README（英日）: 誤りが出た実行の項は「解決か受け入れを記録してから再開する」で終える（解決した日も記録を残す）。緩和の効果は言い切らない。--until の文は 1 文", () => {
    const bulletOf = (text: string, head: string) =>
      text.split("\n").find((l) => l.startsWith(head)) ?? "";
    const ja = read("README_ja.md");
    expect(bulletOf(ja, "- **誤りが出た実行は区間を進めません**")).toMatch(
      /解決か受け入れを記録してから再開します（解決した日も、解決の記録を残します）。$/,
    );
    expect(ja).toContain(
      "偽の API の試験では避けられました。実物で効くかは、導入の段 2 で確かめます",
    );
    expect(ja).not.toContain("それを避ける緩和策");
    const en = read("README.md");
    expect(bulletOf(en, "- **A run with errors does not advance the interval.**")).toMatch(
      /Resume only after recording the resolution or the acceptance \(on the day an error is resolved, too, keep a record of the resolution\)\.$/,
    );
    expect(en).toContain(
      "it was avoided in the tests against a fake API; whether it works against the real one is checked in step 2 of the rollout",
    );
    expect(en).not.toContain("a mitigation that avoids it");
    expect(en).not.toContain("If only `--until` is set in the past: If");
    expect(en).toContain(
      "If only `--until` is set in the past and the start taken from the state is at or after `--until`, the tool refuses to run (exit code 2)",
    );
  });
  it("docs/specs/console-login.md: 誤りのあとの運用・受け入れの記録・2 つの再開は README の節を正とする", () => {
    expect(read("docs/specs/console-login.md")).toContain(
      "誤りのあとの運用（所見の記録・受け入れの記録・「検証して再開」と「検証できないまま受け入れて再開」の書き分け）は、README の「コンソールログインの突き合わせ」の節を正とする",
    );
  });
  it("docs/specs/console-login.md: 読み始めを状態から決める（--overlap-seconds）・保証の範囲・原因は未確認。「既定のさかのぼりは 6 日で」と書かない", () => {
    const text = read("docs/specs/console-login.md");
    for (const s of [
      "確認済みの区間の終わり − 重なり",
      "`--overlap-seconds`",
      "保証するのは、その実行で読んだ窓に誤りがあれば区間を進めないことまで",
      "保存の間引きか照会の間引きかは未確認",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("既定のさかのぼりは 6 日で");
  });
  it("mise.toml: console:reconcile の説明に、読み始めは状態から（--overlap-seconds）・--since が勝つと書く", () => {
    const text = read("mise.toml");
    const i = text.indexOf('[tasks."console:reconcile"]');
    const section = text.slice(i, text.indexOf("\n", text.indexOf("description", i)));
    expect(section).toContain("--overlap-seconds");
    expect(section).toContain("--since が勝つ");
  });
});

// cto の決裁 G2-A 条件 c5（2026-11-17）: 照合の Q1・Q2・Q4・Q5、L2 と信頼ポリシーの拒否、Administrator の別スタック
describe("cto の決裁 G2-A 条件 c5 の文面", () => {
  const section = (text: string, heading: string, next = "\n## ") => {
    const i = text.indexOf(heading);
    expect(i, heading).toBeGreaterThanOrEqual(0);
    const j = text.indexOf(next, i + heading.length);
    return text.slice(i, j < 0 ? undefined : j);
  };

  it("README_ja.md: 照合（時間・利用者は誤り、Admin の比べ漏れは誤り、除外の件数、Admin の発行、受容、当たったときの扱い）", () => {
    const text = section(read("README_ja.md"), "### コンソールログインの突き合わせ", "\n### ");
    for (const s of [
      "`assume_time_gap`（誤り",
      "`identity_mismatch`（誤り",
      "`identity_not_compared_admin`（誤り",
      "見つかるのは別のドメインか別の頭文字だけ",
      "time from issue:",
      "excluded assumes (not console): <n>",
      "MCP を同じアカウントで使っていなければ 0",
      "admin issues: <n>",
      "発行記録はコンソールの Worker 自身が書きます。コンソールの Worker に書ける者（Viewer だけを扱う人を含む）に対しては、照合は独立の検知ではありません",
      "`ADMIN_LOGIN_DISABLED`",
      "`LOGIN_DISABLED`",
      "技術の判断者に上げます",
      "誤りが残る間、区間は進みません",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("しきい値は仮です");
    expect(text).not.toContain("誤りに上げる予定");
  });
  it("README.md: reconciliation (same points in English)", () => {
    const text = section(read("README.md"), "### Reconciling console logins", "\n### ");
    for (const s of [
      "`assume_time_gap` (error",
      "`identity_mismatch` (error",
      "`identity_not_compared_admin` (error",
      "it can only catch a different domain or a different first letter",
      "time from issue:",
      "excluded assumes (not console): <n>",
      "0 if you do not use MCP in the same account",
      "admin issues: <n>",
      "The issue records are written by the console Worker itself. Against anyone who can write to the console Worker (including people who handle only Viewer), the reconciliation is not independent detection",
      "`ADMIN_LOGIN_DISABLED`",
      "`LOGIN_DISABLED`",
      "escalate to your technical decision maker",
      "While an error remains, the interval does not advance",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("The thresholds are provisional");
    expect(text).not.toContain("then raised to errors");
  });

  it("README_ja.md: L2 は段階 2 の個人の環境で実測済み（内部の呼び名 G2-A は書かない）。L2 は Viewer も止める。信頼ポリシーの拒否は CloudFormation の外で、止めている間はロールのスタックを更新しない", () => {
    const text = section(
      read("README_ja.md"),
      "### 発行を Cloudflare に頼らずに止める（L2 と信頼ポリシーの拒否）",
    );
    for (const s of [
      "**Administrator だけを止める L2 はありません**",
      "プロバイダーの削除（L2）は Viewer も止めます",
      "下の削除と戻す手順は、段階 2 の個人の環境で",
      "`upstream_auth_failed`",
      "`sts_denied`",
      "作り直したプロバイダーはドリフトが残りません",
      "信頼ポリシーの Deny は CloudFormation の管理の外にあります",
      "止めている間はロールのスタックを更新しません",
      "戻しは手で行い、発行 1 回とドリフト検出で確かめます",
      "信頼ポリシー自体が変わる更新で Deny が消えるかは未測定",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("まだ実行していない例");
    expect(text).not.toContain("G2-A");
  });
  it("README.md: L2 measured in the personal environment of stage 2 (without the internal label); the trust policy Deny is outside CloudFormation", () => {
    const text = section(
      read("README.md"),
      "### Stopping issuance without relying on Cloudflare (L2 and trust policy Deny)",
    );
    for (const s of [
      "**There is no L2 that stops only Administrator**",
      "deleting the provider (L2) also stops Viewer",
      "The deletion and the restore procedure below were run in the personal environment of stage 2",
      "`upstream_auth_failed`",
      "`sts_denied`",
      "the recreated provider leaves no drift",
      "The trust policy Deny is outside CloudFormation's management",
      "While it is stopped, do not update the role stack",
      "Restore it by hand, and confirm with one issuance and drift detection",
      "whether an update that changes the trust policy itself removes the Deny has not been measured",
    ])
      expect(text, s).toContain(s);
    expect(text).not.toContain("have not been run yet");
    expect(text).not.toContain("G2-A");
  });

  it("README_ja.md / README.md: Administrator を別のスタックで置くときの条件（change set・作成直後の確認・kind-default・中断・スタック名）", () => {
    const ja = section(read("README_ja.md"), "### Admin の階層と Administrator を足す", "\n### ");
    for (const s of [
      "`AdministratorRole` の `Add` だけ",
      "aws iam get-role",
      "aws iam list-attached-role-policies",
      "`AdministratorTeams` は空のまま",
      "`AdministratorRole` が出たら実行しません",
      "Admin のスタックを消し、かつ設定から Administrator を外して生成し直します",
      "awsbridge-console-admin-default",
      "`awsbridge-console-kind-<kind>`",
      "Standard のチームは渡せません",
      "`mise run console:inspect` を回します",
    ])
      expect(ja, s).toContain(s);
    const en = section(
      read("README.md"),
      "### Adding the Admin tier and the Administrator role",
      "\n### ",
    );
    for (const s of [
      "only an `Add` of `AdministratorRole`",
      "aws iam get-role",
      "aws iam list-attached-role-policies",
      "keep `AdministratorTeams` empty",
      "if `AdministratorRole` appears, do not execute it",
      "delete the Admin stack, and remove Administrator from the config and regenerate",
      "awsbridge-console-admin-default",
      "`awsbridge-console-kind-<kind>`",
      "a Standard team cannot be passed",
      "run `mise run console:inspect`",
    ])
      expect(en, s).toContain(s);
  });

  it("docs/specs: 信頼ポリシーの Deny は「スタックの更新で戻る」と書かない（測った 2 通りでは戻らない）。受容の文と新しい所見", () => {
    for (const f of ["docs/specs/console-login.md", "docs/specs/console-login-admin.md"]) {
      const text = read(f);
      expect(text, f).not.toContain("スタックの更新で戻る");
      expect(text, f).toContain("信頼ポリシー自体が変わる更新は未測定");
    }
    const spec = read("docs/specs/console-login.md");
    for (const s of [
      "発行記録は Admin の Worker 自身が書く。Admin の Worker に書ける者に対しては、照合は独立の検知ではない",
      "`identity_not_compared_admin`",
      "`assume_time_gap`（誤り",
      "`identity_mismatch`（誤り",
      "awsbridge-console-admin-default",
    ])
      expect(spec, s).toContain(s);
    expect(spec).not.toContain("**まず警告**");
  });
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
    it(`${f}: コンソールのホストは 2 つ（ポータルと issuer）、issuer は /console、生成物は worker.json と display.json`, () => {
      const text = read(f);
      for (const s of [
        "wrangler.console.jsonc",
        "awsbridge-console.example.com",
        "awsbridge-oidc-console.example.com/console",
        "`worker.json`",
        "`display.json`",
        "`stacksets.json`",
        "`access.json`",
        "wrangler.<name>-console.jsonc",
        "](docs/console-production-rollout",
      ])
        expect(text, s).toContain(s);
      for (const s of [
        "awsbridge-admin-console.",
        "awsbridge-oidc-admin-console.",
        "wrangler.console-standard.jsonc",
        "wrangler.<name>-console-admin.jsonc",
        "display.standard.json",
        "console:standard-key:",
        "console:secrets:standard",
        "console:build:standard",
        "STANDARD_KEY_",
        "STANDARD_PUBLIC_JWKS",
        "STANDARD_CURRENT_KEYS",
        "AWSBRIDGE_CONSOLE_STANDARD_",
      ])
        expect(text, s).not.toContain(s);
      // Admin の Worker だけにあった vars（今は ADMIN_ACCESS_MAX_AGE_SECONDS）
      expect(text).not.toMatch(/(?<!ADMIN_)ACCESS_MAX_AGE_SECONDS/);
      // AUD のファイルの入口は 1 つ（{ teams, entry }）
      expect(text).toMatch(/"entry": <AUD>/);
      expect(text).not.toMatch(/"entry": \{ "standard"/);
    });

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
