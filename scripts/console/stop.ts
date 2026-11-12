// 停止の道具の CLI（1 人停止の予約名 AwsbridgeConsoleDenySourceIdentity のインラインの Deny）。
//   pnpm tsx scripts/console/stop.ts show  --profile <p> [--stops <file>] [--account-id <id>]
//   pnpm tsx scripts/console/stop.ts apply --profile <p> --stops <file> --reason <text> [--yes] [--allow-remove] [--account-id <id>]
// mise タスク console:stop:show / console:stop:apply から呼ぶ。本体は stop-lib.ts、計画は src/console/stop-plan.ts。
// 設計: docs/specs/console-login.md §6.3・§4.8。cto の決裁 2026-11-13（★4・★5）と同日の司令塔の判断（値ごとに方向を分ける）。
//
// - show: 読み取りだけ。ロールごとに予約名の有無・止めている値の件数・衝突を出す（--stops で足りない・余分も）
// - apply: 対象の全ロールの予約名の中身を、--stops のファイルの一覧に合わせる。
//   --allow-remove なしは足すだけ（今の値 ∪ 一覧。一覧に無い値は消さず、余分として件数を出す）。
//   --allow-remove ありは一覧にそろえる（全ロールに足し終えてから外す）。足す値が無く外す値だけの実行は --allow-remove が要る。
//   どちらでも 1 つのロールのために全体を止めない（書けないロールは報告して終了コード 1）。
//   --yes が無ければ計画の表示だけ（ただし今の状態との差を出すため IAM の読み取りと sts get-caller-identity は呼ぶ）。
//   --reason は必須（記録の 1 行の JSON に入る）。
//   書き込みは iam put-role-policy・iam delete-role-policy の 2 種類だけ（--yes のときだけ許可リストに入れる）。
//   呼び出し元がコンソール用のロールなら実行しない（守りの部品の Deny で途中から失敗するため）。
// 停止の一覧（--stops のファイル）は email を含む。.secrets/ か下流のリポジトリに置き、公開リポジトリにコミットしない。
// 終了コード:
//   0 書き終えた（または変更なし。余分の値が残っているだけなら 0）
//   1 書けなかったロールがある（予約名の衝突・名前の大文字小文字の違い・容量超え・未読・書き込みの失敗）、
//     show で停止の誤り（stop_missing・stop_reserved_conflict）がある
//   2 実行しなかった（入力の誤り・aws の読み取りの失敗・呼び出し元・--allow-remove が無い解除だけの実行）
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConsoleConfigError, formatIssue, parseConsoleConfig } from "../../src/console/config";
import { redact } from "../../src/console/inspect";
import { parseStops, StopsError } from "../../src/console/stops";
import { awsRunner } from "./aws-cli";
import { runApply, runShow, STOP_READ_COMMANDS, STOP_WRITE_COMMANDS } from "./stop-lib";

class InputError extends Error {}

const PROFILE_RE = /^[\w.+@][\w.+@-]{0,63}$/;
const ACCOUNT_RE = /^\d{12}$/;
const USAGE =
  "使い方: stop.ts show --profile <p> [--stops <file>] [--account-id <12 桁>]\n" +
  "        stop.ts apply --profile <p> --stops <file> --reason <text> [--yes] [--allow-remove] [--account-id <12 桁>]";

const OPTIONS = {
  profile: { type: "string" },
  stops: { type: "string" },
  reason: { type: "string" },
  "account-id": { type: "string" },
  yes: { type: "boolean", default: false },
  "allow-remove": { type: "boolean", default: false },
} as const;

function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) throw new InputError(`${label} のファイルがありません: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new InputError(`${label}: json`);
  }
}

function readStops(path: string): string[] {
  try {
    return parseStops(readJson(path, "stops"));
  } catch (e) {
    if (e instanceof StopsError) throw new InputError(e.message);
    throw e;
  }
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ allowPositionals: true; options: typeof OPTIONS }>>;
  try {
    parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw new InputError(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0];
  if ((cmd !== "show" && cmd !== "apply") || positionals.length !== 1) throw new InputError(USAGE);
  const profile = values.profile;
  if (!profile || !PROFILE_RE.test(profile)) throw new InputError(USAGE);
  const expectAccountId = values["account-id"];
  if (expectAccountId !== undefined && !ACCOUNT_RE.test(expectAccountId))
    throw new InputError("--account-id は 12 桁の数字");
  if (cmd === "show" && (values.yes || values["allow-remove"] || values.reason !== undefined))
    throw new InputError(
      `show は読み取りだけ（--yes・--allow-remove・--reason を取らない）\n${USAGE}`,
    );

  let reason = "";
  if (cmd === "apply") {
    if (values.stops === undefined) throw new InputError(`apply は --stops が要る\n${USAGE}`);
    reason = (values.reason ?? "").trim();
    // 記録の 1 行に入るので、1 行・500 文字まで
    if (reason === "" || reason.length > 500 || /[\p{Cc}]/u.test(reason))
      throw new InputError(`apply は --reason <理由。1 行・500 文字まで> が要る\n${USAGE}`);
  }

  const configPath = process.env.AWSBRIDGE_CONSOLE_CONFIG || "config/console.json";
  if (!existsSync(configPath)) throw new InputError(`設定ファイルがありません: ${configPath}`);
  const { config } = parseConsoleConfig(readFileSync(configPath, "utf8"));
  const invPath = process.env.AWSBRIDGE_CONSOLE_INVENTORY_FILE;
  const inventory = invPath ? readJson(invPath, "inventory") : undefined;
  const stops = values.stops !== undefined ? readStops(values.stops) : undefined;
  const common = {
    config,
    profile,
    ...(inventory !== undefined ? { inventory } : {}),
    ...(expectAccountId !== undefined ? { expectAccountId } : {}),
  };
  const print = (line: string) => console.log(line);

  if (cmd === "show")
    return runShow(
      { ...common, ...(stops !== undefined ? { stops } : {}) },
      { run: awsRunner(profile, STOP_READ_COMMANDS), print },
    );

  // --yes が無ければ、書き込みのコマンドを runner の許可リストに入れない
  const allowed = values.yes ? [...STOP_READ_COMMANDS, ...STOP_WRITE_COMMANDS] : STOP_READ_COMMANDS;
  return runApply(
    {
      ...common,
      stops: stops ?? [],
      stopsPath: values.stops ?? "",
      reason,
      yes: values.yes === true,
      allowRemove: values["allow-remove"] === true,
    },
    { run: awsRunner(profile, allowed), print, now: () => new Date() },
  );
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const message =
      e instanceof ConsoleConfigError
        ? `設定の誤り:\n${e.issues.map((i) => `  ${formatIssue(i)}`).join("\n")}`
        : e instanceof Error
          ? e.message
          : String(e);
    console.error(redact(message));
    process.exit(2);
  },
);
