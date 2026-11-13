// G2 の開発環境の実測の道具（scripts/poc/g2/）が共有する純粋関数。I/O は呼び出し側で行う。
// 手順書: .claude/handover/g2-dev-measure-plan.md（§2.6・§3.7）。src/ と本番のバンドルには入れない（Worker から import しない）。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface G2Settings {
  /** 記録・鍵・Cookie の置き場所（既定 <repo>/.secrets/g2-dev。gitignore） */
  dir: string;
  /** 利用者が Access の Cookie を置く場所（issue-watch はこの下のファイルだけを読み、消す） */
  cookiesDir: string;
}

/** 設定（環境変数）。空文字は未設定扱い。試験は AWSBRIDGE_G2_DEV_DIR を一時ディレクトリにする。 */
export function g2Settings(env: Record<string, string | undefined>): G2Settings {
  const dir = env.AWSBRIDGE_G2_DEV_DIR || join(repoRoot, ".secrets/g2-dev");
  return { dir, cookiesDir: join(dir, "cookies") };
}

/** "90"・"90s"・"60m"・"24h" を秒にする。0 以上の整数だけ。 */
export function parseDuration(v: string, label: string): number {
  const m = /^(\d{1,6})([smh]?)$/.exec(v);
  if (!m) throw new Error(`${label} は秒数か <n>s・<n>m・<n>h（例 60、5m、24h）: '${v}'`);
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
}

/**
 * 見張りの予定。最初の区間（durationSeconds）は intervalSeconds おきに続ける。
 * 延長（extendIntervalSeconds と maxDurationSeconds の両方）を指定すると、最初の区間のあとは
 * extendIntervalSeconds おきに最長 maxDurationSeconds まで続け、見張る対象が stopAfterRefusedSeconds 以上
 * 続けて断られたら止める（手順書 §3.7: 1 分おきに 60 分、通り続ければ 5 分おきに最長 24 時間、断られて 30 分で止める）。
 */
export interface Schedule {
  intervalSeconds: number;
  durationSeconds: number;
  extendIntervalSeconds?: number | undefined;
  maxDurationSeconds?: number | undefined;
  stopAfterRefusedSeconds?: number | undefined;
}

export type Step =
  | { action: "wait"; delaySeconds: number }
  | { action: "stop"; reason: "duration" | "refused" | "max" };

/**
 * 次にどうするか。elapsedSeconds は見張りを始めてからの秒数、refusedSeconds は見張る対象が今まで続けて
 * 断られている秒数（断られていなければ undefined）。延長の区間でだけ refusedSeconds で止める。
 */
export function nextStep(
  s: Schedule,
  elapsedSeconds: number,
  refusedSeconds: number | undefined,
): Step {
  const extend = s.extendIntervalSeconds !== undefined;
  if (extend !== (s.maxDurationSeconds !== undefined))
    throw new Error("延長の間隔と最長は両方を指定する");
  if (extend && (s.maxDurationSeconds as number) < s.durationSeconds)
    throw new Error("最長は最初の区間より短くできない");
  if (elapsedSeconds < s.durationSeconds)
    return { action: "wait", delaySeconds: s.intervalSeconds };
  if (!extend) return { action: "stop", reason: "duration" };
  const max = s.maxDurationSeconds as number;
  if (elapsedSeconds >= max) return { action: "stop", reason: "max" };
  if (
    s.stopAfterRefusedSeconds !== undefined &&
    refusedSeconds !== undefined &&
    refusedSeconds >= s.stopAfterRefusedSeconds
  )
    return { action: "stop", reason: "refused" };
  return {
    action: "wait",
    delaySeconds: Math.min(s.extendIntervalSeconds as number, max - elapsedSeconds),
  };
}

/** 見張る対象の試行（時刻は見張りの始めからの秒数）から、末尾の失敗の連続の最初から nowSeconds までの秒数。 */
export function refusedForSeconds(
  attempts: readonly { atSeconds: number; ok: boolean }[],
  nowSeconds: number,
): number | undefined {
  const last = attempts.at(-1);
  if (last === undefined || last.ok) return undefined;
  let i = attempts.length - 1;
  while (i > 0 && !(attempts[i - 1] as { ok: boolean }).ok) i--;
  return nowSeconds - (attempts[i] as { atSeconds: number }).atSeconds;
}

// ---- 出力に秘密を出さないことの検査 ----

/** JWT の形（base64url の 3 つの部分。ヘッダーは {" で始まる = eyJ）。 */
export const JWT_RE = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/;
/** AWS のアクセスキー ID の形。 */
const AWS_KEY_RE = /(?<![A-Z0-9])(?:ASIA|AKIA)[A-Z0-9]{16}(?![A-Z0-9])/;

/** 文字列に秘密の形のもの・渡した値（Cookie・CSRF・認証情報など）が含まれていれば、その種類を返す。 */
export function findLeaks(text: string, values: readonly string[]): string[] {
  const out: string[] = [];
  if (JWT_RE.test(text)) out.push("jwt");
  if (AWS_KEY_RE.test(text)) out.push("aws_access_key_id");
  values.forEach((v, i) => {
    if (v !== "" && text.includes(v)) out.push(`value#${i + 1}`);
  });
  return out;
}

/** ISO 8601（UTC、ミリ秒まで）。 */
export const isoNow = (now: Date = new Date()): string => now.toISOString();

/** ファイル名に使う時刻（20261113T010203Z）。 */
export function fileStamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}
