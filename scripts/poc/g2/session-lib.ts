// G2 のセッションの見張り（poc:g2:session-watch）の純粋関数。I/O は scripts/poc/g2/session-watch.ts。
// 手順書 §2.6・ii-1c・ii-5・追 1。既定の操作は s3api list-buckets（ii-1c の目印の Deny が s3:ListAllMyBuckets）。
// sts get-caller-identity は明示の Deny で止まらない（手順書 §2.6）ので既定にしない。

export const DEFAULT_OPERATION = "s3api list-buckets";

/** 読み取りの操作だけ（サービスと操作の 2 語。追加の引数は受け付けない）。 */
const READ_VERB_RE = /^(list|get|describe|head)-[a-z0-9-]+$/;

export function parseOperation(raw: string): { args: string[]; warning: string | undefined } {
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((p) => p !== "");
  const [service, op] = parts;
  if (
    parts.length !== 2 ||
    service === undefined ||
    op === undefined ||
    !/^[a-z0-9][a-z0-9-]*$/.test(service)
  )
    throw new Error(
      `--operation は「<サービス> <操作>」の 2 語（例 ${DEFAULT_OPERATION}）: '${raw}'`,
    );
  if (!READ_VERB_RE.test(op))
    throw new Error(`--operation は読み取りの操作（list-・get-・describe-・head-）だけ: '${raw}'`);
  const warning =
    service === "sts" && op === "get-caller-identity"
      ? "警告: sts get-caller-identity は明示の Deny でも通るので、停止の確認には使えない（成功が続いても止まっていないとは言えない）"
      : undefined;
  return { args: [service, op], warning };
}

const PROFILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function parseProfiles(raw: readonly string[]): string[] {
  if (raw.length === 0) throw new Error("--profile を 1 つ以上指定してください");
  const out: string[] = [];
  for (const p of raw) {
    if (!PROFILE_RE.test(p)) throw new Error(`不正なプロファイル名: '${p}'`);
    if (out.includes(p)) throw new Error(`プロファイルが重複しています: ${p}`);
    out.push(p);
  }
  return out;
}
