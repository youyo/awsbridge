// PoC N6（K4）: 鍵を無効化（DisableKey）したとき、Worker の発行（KMS の Sign）が止まるまでの時間を測る。
// 1. --interval-ms ごとに Worker の /poc/sign（count 1）を呼ぶ（時刻は手元の時計。応答を受けた時刻）
// 2. 成功が --baseline 回続いたら aws kms disable-key（完了時刻を記録）
// 3. 最初の失敗のあと --after 回まで続け、aws kms enable-key（--no-enable なら戻さない）→ 成功に戻るまで続ける
// 4. stopSummary（無効化の完了から最初の失敗まで・有効化から最初の成功まで）を出し、<OUT_DIR>/disable-watch.jsonl に追記
// 止まるのは新しい署名（発行）だけ。発行済みの JWT（有効期限 5 分）と STS のセッションは止まらない。
// オプション: --key rsa（既定）、--baseline 5、--after 5、--interval-ms 1000、--max-seconds 180、--no-enable
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail } from "../human/io";
import { aws, callWorker, loadSettings, readCallerToken, requireIssuer, stackOutputs } from "./io";
import { keysFromOutputs, maskIds, stopSummary, type WatchEvent } from "./ops";

const { values } = parseArgs({
  options: {
    key: { type: "string", default: "rsa" },
    baseline: { type: "string", default: "5" },
    after: { type: "string", default: "5" },
    "interval-ms": { type: "string", default: "1000" },
    "max-seconds": { type: "string", default: "180" },
    "no-enable": { type: "boolean", default: false },
  },
});
const s = loadSettings();
const issuer = requireIssuer(s);
const token = readCallerToken(s);
const key = keysFromOutputs(stackOutputs(s)).find((k) => k.label === values.key);
if (!key) fail(`知らない鍵: ${values.key}`);
const baseline = Number(values.baseline);
const afterN = Number(values.after);
const interval = Number(values["interval-ms"]);
const deadline = Date.now() + Number(values["max-seconds"]) * 1000;
const log = join(s.outDir, "disable-watch.jsonl");
const runId = new Date().toISOString();

const events: WatchEvent[] = [];
let disabledAt: string | undefined;
let enabledAt: string | undefined;
let okStreak = 0;
let failuresAfterDisable = 0;

function stamp(phase: string, extra: Record<string, unknown> = {}) {
  appendFileSync(log, `${JSON.stringify({ runId, phase, key: values.key, ...extra })}\n`, {
    mode: 0o600,
  });
}

while (Date.now() < deadline) {
  const r = await callWorker(issuer, token, "/poc/sign", { key: values.key, count: 1 });
  const at = new Date().toISOString();
  const x = ((r.body.results as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
  const ev: WatchEvent = { at, ok: x.ok === true };
  if (!ev.ok) ev.code = String(x.code ?? `HTTP${r.status}`);
  events.push(ev);
  stamp("probe", {
    ...ev,
    kmsRequestId: x.kmsRequestId,
    workerAt: x.at,
    signMs: x.ms,
    clientMs: r.clientMs,
  });
  console.log(
    `${at} ${ev.ok ? "OK" : `NG ${ev.code}`} sign=${x.ms ?? "-"}ms client=${r.clientMs}ms`,
  );
  okStreak = ev.ok ? okStreak + 1 : 0;

  if (!disabledAt && okStreak >= baseline) {
    const t0 = new Date().toISOString();
    const d = aws(s, ["kms", "disable-key", "--key-id", key.keyId]);
    if (!d.ok) fail(`disable-key が失敗しました: ${d.stderr}`);
    disabledAt = new Date().toISOString();
    stamp("disabled", { requestedAt: t0, completedAt: disabledAt });
    console.log(`--- DisableKey（要求 ${t0} / 完了 ${disabledAt}）`);
  } else if (disabledAt && !enabledAt && !ev.ok) {
    failuresAfterDisable++;
    if (failuresAfterDisable > afterN) {
      if (values["no-enable"]) break;
      const t0 = new Date().toISOString();
      const e = aws(s, ["kms", "enable-key", "--key-id", key.keyId]);
      if (!e.ok) fail(`enable-key が失敗しました: ${e.stderr}`);
      enabledAt = new Date().toISOString();
      stamp("enabled", { requestedAt: t0, completedAt: enabledAt });
      console.log(`--- EnableKey（要求 ${t0} / 完了 ${enabledAt}）`);
    }
  } else if (enabledAt && ev.ok) {
    break;
  }
  await new Promise((res) => setTimeout(res, interval));
}

if (!disabledAt) fail("無効化の前に時間切れ（成功が続かない）");
const summary = stopSummary(events, disabledAt, enabledAt);
stamp("summary", { disabledAt, enabledAt, ...summary });
console.log(`\n集計: ${maskIds(JSON.stringify({ disabledAt, enabledAt, ...summary }, null, 2))}`);
const state = aws(s, [
  "kms",
  "describe-key",
  "--key-id",
  key.keyId,
  "--query",
  "KeyMetadata.KeyState",
  "--output",
  "text",
]);
console.log(`鍵の状態（いま）: ${state.stdout.trim()}`);
