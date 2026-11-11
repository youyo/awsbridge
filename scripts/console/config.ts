// コンソールログインの設定ファイルの検査と生成の CLI: pnpm tsx scripts/console/config.ts <check|generate>
// mise タスク console:config:check / console:config:generate から呼ぶ。検証と生成の本体は src/console/（純粋関数）。
// 入力と出力の場所は環境変数（mise.toml の「コンソールログイン」の節を参照）。AWS・Cloudflare・Terraform は呼ばない。
// 出力にはキーのパスと誤りの種別、ファイルのパスだけを出し、AUD・email・アカウント ID は出さない。
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConsoleConfigError,
  type ConsoleConfigIssue,
  formatIssue,
  parseConsoleConfig,
} from "../../src/console/config";
import { type GenerateMode, generateConsoleArtifacts } from "../../src/console/generate";

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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // 既存のファイルを上書きしたときも権限をそろえる
}

function main(cmd: string): void {
  if (!existsSync(configPath)) throw new CliError(`設定ファイルがありません: ${configPath}`);
  const mode: GenerateMode = cmd === "generate" ? "deploy" : "check";
  const { config, warnings } = parseConsoleConfig(readFileSync(configPath, "utf8"));
  const auds = readOptionalJson(env.AWSBRIDGE_CONSOLE_AUD_FILE, "auds");
  const inventory = readOptionalJson(env.AWSBRIDGE_CONSOLE_INVENTORY_FILE, "inventory");
  const artifacts = generateConsoleArtifacts(config, {
    mode,
    generatedAt: new Date().toISOString(),
    ...(env.AWSBRIDGE_CONSOLE_SOURCE_REVISION
      ? { sourceRevision: env.AWSBRIDGE_CONSOLE_SOURCE_REVISION }
      : {}),
    ...(auds !== undefined ? { auds } : {}),
    ...(inventory !== undefined ? { inventory } : {}),
  });
  const allWarnings = [...warnings, ...artifacts.warnings];
  printWarnings(allWarnings);
  if (mode === "check") {
    console.log(`OK: ${configPath}（警告 ${allWarnings.length} 件）`);
    return;
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const files: [string, unknown][] = [
    ["worker.standard.json", artifacts.worker.standard],
    ["stacksets.json", artifacts.stacksets],
    ["access.json", artifacts.access],
  ];
  const adminFile = join(outDir, "worker.admin.json");
  if (artifacts.worker.admin) files.push(["worker.admin.json", artifacts.worker.admin]);
  // Admin の階層がなくなったら、前回の Admin の生成物を残さない（別のデプロイに古い値が渡らないように）
  else if (existsSync(adminFile)) rmSync(adminFile);
  for (const [name, value] of files) {
    writePrivate(join(outDir, name), value);
    console.log(`書きました: ${join(outDir, name)}`);
  }
}

const cmd = process.argv[2] ?? "";
if (cmd !== "check" && cmd !== "generate") {
  console.error("使い方: config.ts <check|generate>");
  process.exit(1);
}
try {
  main(cmd);
} catch (e) {
  if (e instanceof ConsoleConfigError) {
    for (const i of e.issues) console.error(`error: ${formatIssue(i)}`);
    console.error(`設定に誤りがあります（${e.issues.length} 件）: ${configPath}`);
  } else if (e instanceof CliError) {
    console.error(e.message);
  } else {
    console.error("設定の処理に失敗しました");
  }
  process.exit(1);
}
