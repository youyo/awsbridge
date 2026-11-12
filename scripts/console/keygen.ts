// コンソールログインの署名鍵の生成: pnpm tsx scripts/console/keygen.ts [--boundary <名前>]... [--force]
// mise タスク console:keygen から呼ぶ。AWS・Cloudflare は呼ばない。
//   境界: --boundary（複数可）。省くと設定ファイル（AWSBRIDGE_CONSOLE_CONFIG、既定 config/console.json）の
//         Standard の issuer を持つ境界（boundaries[].issuers.standard があるもの）。
//   出力: AWSBRIDGE_CONSOLE_KEY_FILE（既定 .secrets/console/signing-keys.json。.secrets/ は gitignore）。0600。
//   既存のファイルは --force が無い限り上書きしない（上書きすると kid が変わり、公開鍵の文書も変わる）。
// 出力は境界の名前・kid・ファイルのパスだけ。秘密の値は出さない。
import { existsSync, readFileSync } from "node:fs";
import { parseConsoleConfig } from "../../src/console/config";
import { generateKeySet, writeKeyFile } from "./keygen-lib";

const env = process.env;
const keyFile = env.AWSBRIDGE_CONSOLE_KEY_FILE || ".secrets/console/signing-keys.json";
const configPath = env.AWSBRIDGE_CONSOLE_CONFIG || "config/console.json";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { boundaries: string[]; force: boolean } {
  const boundaries: string[] = [];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--boundary") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        fail("--boundary には境界の名前を指定してください");
      boundaries.push(v);
    } else fail(`使い方: keygen.ts [--boundary <名前>]... [--force]（不明な引数: ${a}）`);
  }
  return { boundaries, force };
}

function boundariesFromConfig(): string[] {
  if (!existsSync(configPath))
    fail(
      `境界を決められません。--boundary <名前> を指定するか、設定ファイルを用意してください: ${configPath}`,
    );
  try {
    const { config } = parseConsoleConfig(readFileSync(configPath, "utf8"));
    return config.boundaries.filter((b) => b.issuers.standard !== undefined).map((b) => b.name);
  } catch {
    return fail(
      `設定ファイルを読めません（mise run console:config:check で確かめてください）: ${configPath}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const boundaries = args.boundaries.length > 0 ? args.boundaries : boundariesFromConfig();
if (boundaries.length === 0) fail("Standard の境界が 1 つもありません");

if (existsSync(keyFile) && !args.force)
  fail(`既存の鍵があるため上書きしません: ${keyFile}（作り直すときだけ --force を付けます）`);

let set: Awaited<ReturnType<typeof generateKeySet>>;
try {
  set = await generateKeySet(boundaries);
} catch (e) {
  fail(`鍵を作れません: ${(e as Error).message}`);
}
const result = writeKeyFile(keyFile, set.json, args.force);
if (result === "symlink")
  fail(`シンボリックリンクは辿らないため書きません。実体のパスを指定してください: ${keyFile}`);
if (result === "exists") fail(`既存の鍵があるため上書きしません: ${keyFile}`);
console.log(
  `${result === "overwritten" ? "鍵を作り直しました" : "鍵を生成しました"}: ${keyFile} (0600)`,
);
for (const [b, kid] of Object.entries(set.kids)) console.log(`  ${b}\tkid=${kid}`);
