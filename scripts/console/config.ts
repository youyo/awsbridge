// コンソールログインの設定ファイルの検査と生成の CLI:
//   pnpm tsx scripts/console/config.ts check
//   pnpm tsx scripts/console/config.ts generate [--ledger-init] [--ledger-baseline <stacksets.json>]
// mise タスク console:config:check / console:config:generate から呼ぶ。検証と生成の本体は src/console/（純粋関数）。
// 入力と出力の場所は環境変数（mise.toml の「コンソールログイン」の節を参照）。AWS・Cloudflare・Terraform は呼ばない。
// 出力にはキーのパスと誤りの種別、ファイルのパスだけを出し、AUD・email・アカウント ID は出さない。
// generate は、種類ごとのロールのテンプレート（kind.<kind>.yaml。src/console/template.ts）も書く。下流のポリシー文書
// （roles[].permissions.inlinePolicyFiles）は作業ディレクトリからの相対パスで読む。
// 退役したチーム名の台帳（P2 の設計メモ §7.1、cto の決裁 2026-11-17）: 書く前に、出力先の前回の stacksets.json を読んで
// 生成器に渡す（台帳から名前を消していないか・消したチームを台帳へ移したか・階層を変えていないか）。
//   generate: 比べる台帳（前回か --ledger-baseline）が無ければ誤り。初めての生成と P2 より前の形からの移行だけは
//             --ledger-init で通し、その旨を標準出力と stacksets.json の meta（ledgerInit）に残す（次の生成で消える）。
//             --ledger-baseline <path> は保管しておいた stacksets.json で、前回と両方に通ることを要する。
//   check: 前回が無ければ黙り、あれば比べる（--ledger-init・--ledger-baseline は受けない）。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ConsoleConfig,
  ConsoleConfigError,
  type ConsoleConfigIssue,
  formatIssue,
  parseConsoleConfig,
  SCHEMA_VERSION_HINT,
} from "../../src/console/config";
import { type GenerateMode, generateConsoleArtifacts } from "../../src/console/generate";
import { buildKindTemplates, type KindTemplate } from "../../src/console/template";
import { templateYaml } from "./template-yaml";

const env = process.env;
const configPath = env.AWSBRIDGE_CONSOLE_CONFIG || "config/console.json";
const outDir = env.AWSBRIDGE_CONSOLE_OUT_DIR || ".generated/console";

class CliError extends Error {}

/** 任意の JSON の入力（AUD・インベントリ）。読めなければ "<label>: json" の誤り。 */
function readOptionalJson(path: string | undefined, label: string): unknown {
  if (!path) return undefined;
  if (!existsSync(path)) throw new CliError(`${label} のファイルがありません: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConsoleConfigError([{ path: label, code: "json" }]);
  }
}

function printWarnings(warnings: ConsoleConfigIssue[]): void {
  for (const w of warnings) console.error(`warning: ${formatIssue(w)}`);
}

function writePrivate(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600); // 既存のファイルを上書きしたときも権限をそろえる
}

/**
 * 種類ごとのロールのテンプレートを作る。下流のポリシー文書（roles[].permissions.inlinePolicyFiles）は
 * 作業ディレクトリからの相対パスで読む。ないファイルは渡さない（生成器が required にする）。
 * JSON として読めなければ json の誤り（生成器の誤りとまとめて出す）。
 */
function kindTemplates(config: ConsoleConfig): KindTemplate[] {
  const docs: Record<string, unknown> = {};
  const issues: ConsoleConfigIssue[] = [];
  config.roles.forEach((role, i) => {
    role.inlinePolicyFiles.forEach((file, j) => {
      if (!existsSync(file)) return;
      try {
        docs[file] = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        issues.push({ path: `roles[${i}].permissions.inlinePolicyFiles[${j}]`, code: "json" });
      }
    });
  });
  const bad = new Set(issues.map((x) => x.path));
  try {
    const result = buildKindTemplates(config, { inlinePolicies: docs });
    if (issues.length > 0) throw new ConsoleConfigError(issues);
    return result;
  } catch (e) {
    if (!(e instanceof ConsoleConfigError)) throw e;
    // 読めなかったファイルは、生成器から見ると「ない」（required）ので、json の誤りだけを残す
    const rest = e.issues.filter((x) => !bad.has(x.path));
    throw new ConsoleConfigError([...issues, ...rest].sort((a, b) => (a.path < b.path ? -1 : 1)));
  }
}

/** 種類のテンプレートのファイル名（kind.<kind>.yaml）。 */
const KIND_FILE_RE = /^kind\..+\.yaml$/;

type LedgerArgs = { init: boolean; baselinePath?: string };

/** 保管しておいた台帳（--ledger-baseline）。読めない・JSON でなければ null（生成器が ledger_baseline の誤りにする）。 */
function readBaseline(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function main(cmd: string, ledger: LedgerArgs): void {
  if (!existsSync(configPath)) throw new CliError(`設定ファイルがありません: ${configPath}`);
  const mode: GenerateMode = cmd === "generate" ? "deploy" : "check";
  const { config, warnings } = parseConsoleConfig(readFileSync(configPath, "utf8"));
  const auds = readOptionalJson(env.AWSBRIDGE_CONSOLE_AUD_FILE, "auds");
  const inventory = readOptionalJson(env.AWSBRIDGE_CONSOLE_INVENTORY_FILE, "inventory");
  // 前回の生成物の台帳（上書きの前に読む。読めなければ生成器が ledger_previous の誤りにする）
  const previousPath = join(outDir, "stacksets.json");
  let previous: unknown;
  if (existsSync(previousPath)) {
    try {
      previous = JSON.parse(readFileSync(previousPath, "utf8"));
    } catch {
      previous = null;
    }
  }
  const artifacts = generateConsoleArtifacts(config, {
    mode,
    generatedAt: new Date().toISOString(),
    ...(env.AWSBRIDGE_CONSOLE_SOURCE_REVISION
      ? { sourceRevision: env.AWSBRIDGE_CONSOLE_SOURCE_REVISION }
      : {}),
    ...(auds !== undefined ? { auds } : {}),
    ...(inventory !== undefined ? { inventory } : {}),
    ...(previous !== undefined ? { previous } : {}),
    ...(ledger.baselinePath !== undefined ? { baseline: readBaseline(ledger.baselinePath) } : {}),
    ...(ledger.init ? { ledgerInit: true } : {}),
  });
  // ロールのテンプレート（種類の StackSet。参考の形）。check でも作って、下流のポリシー文書の欠落などを誤りにする
  const kinds = kindTemplates(config);
  const allWarnings = [...warnings, ...artifacts.warnings];
  printWarnings(allWarnings);
  if (mode === "check") {
    console.log(`OK: ${configPath}（警告 ${allWarnings.length} 件）`);
    return;
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const files: [string, unknown][] = [
    ["worker.json", artifacts.worker],
    ["display.json", artifacts.display],
    ["stacksets.json", artifacts.stacksets],
    ["access.json", artifacts.access],
  ];
  // P2 より前の階層ごとの生成物を残さない（旧い Worker の設定に古い値が渡らないように）
  for (const old of ["worker.standard.json", "worker.admin.json", "display.standard.json"]) {
    const path = join(outDir, old);
    if (existsSync(path)) rmSync(path);
  }
  for (const [name, value] of files) {
    writePrivate(join(outDir, name), value);
    console.log(`書きました: ${join(outDir, name)}`);
  }
  if (artifacts.ledgerInit) {
    // 比べる台帳なしに通したことを残す（チーム名だけ。stacksets.json の meta にも ledgerInit）
    const { teams, retiredTeams } = artifacts.ledgerInit;
    console.log(
      `台帳: 初回の指定（--ledger-init）で、比べる台帳（前回の生成物・baseline）なしに通しました。今のチーム: ${teams.join(", ") || "なし"}。退役したチーム: ${retiredTeams.join(", ") || "なし"}`,
    );
    console.log(
      `台帳: デプロイの前に mise run console:inspect を回し、${join(outDir, "stacksets.json")} を保管してください（次からは前回か --ledger-baseline と比べます）`,
    );
  }
  // 設定から消えた種類のテンプレートを残さない（古いロールの定義が配られないように）
  const kindFiles = new Set(kinds.map((k) => `kind.${k.kind}.yaml`));
  for (const f of readdirSync(outDir))
    if (KIND_FILE_RE.test(f) && !kindFiles.has(f)) rmSync(join(outDir, f));
  for (const k of kinds) {
    const path = join(outDir, `kind.${k.kind}.yaml`);
    writeText(path, templateYaml(k.template));
    console.log(`書きました: ${path}（StackSet ${k.stackSetName}）`);
  }
}

const USAGE =
  "使い方: config.ts check | config.ts generate [--ledger-init] [--ledger-baseline <stacksets.json>]";

/** generate の台帳の引数。check には付けられない。分からない引数・値の無い --ledger-baseline は使い方の誤り。 */
function parseLedgerArgs(cmd: string, rest: string[]): LedgerArgs | undefined {
  const out: LedgerArgs = { init: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (cmd !== "generate") return undefined;
    if (a === "--ledger-init" && !out.init) out.init = true;
    else if (a === "--ledger-baseline" && out.baselinePath === undefined) {
      const v = rest[++i];
      if (v === undefined || v === "" || v.startsWith("--")) return undefined;
      out.baselinePath = v;
    } else return undefined;
  }
  return out;
}

const cmd = process.argv[2] ?? "";
const ledgerArgs = parseLedgerArgs(cmd, process.argv.slice(3));
if ((cmd !== "check" && cmd !== "generate") || ledgerArgs === undefined) {
  console.error(USAGE);
  process.exit(1);
}
try {
  main(cmd, ledgerArgs);
} catch (e) {
  if (e instanceof ConsoleConfigError) {
    for (const i of e.issues) console.error(`error: ${formatIssue(i)}`);
    // schemaVersion 1 の設定は黙って読み替えない。新しいキーを案内する（値を含めない固定の文）
    if (e.issues.some((i) => i.code === "schema_version")) console.error(SCHEMA_VERSION_HINT);
    console.error(`設定に誤りがあります（${e.issues.length} 件）: ${configPath}`);
  } else if (e instanceof CliError) {
    console.error(e.message);
  } else {
    console.error("設定の処理に失敗しました");
  }
  process.exit(1);
}
