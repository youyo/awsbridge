// console:secrets:standard の本体（CLI は secrets.ts）。CONSOLE_SIGNING_KEYS と CONSOLE_CSRF_KEY を Worker secret に入れる。
// wrangler の呼び出し（SecretPutter）は引数で差し替えられる。確認（confirm）が無ければ SecretPutter を呼ばない。
// 秘密の値は戻り値の lines にも入れない。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseSigningKeys } from "../../src/console/issue/sign-standard";
import { thumbprintOf } from "../../src/keys";

/** CSRF の鍵の最小バイト数（src/console/issue/csrf.ts の MIN_KEY_BYTES と同じ）。 */
const MIN_CSRF_BYTES = 32;

export type PutResult = { ok: true } | { ok: false; message?: string };
/** Worker secret を 1 つ入れる。値は標準入力で渡す実装にする（引数に載せない）。 */
export type SecretPutter = (name: string, value: string) => PutResult;

export type SecretsOptions = {
  keyFile: string;
  csrfKeyFile: string;
  /** false（既定）なら何を入れるかを表示するだけ。 */
  confirm: boolean;
};
export type SecretsResult = { ok: boolean; lines: string[] };

function readPrivateFile(
  path: string,
  what: string,
): { ok: true; value: string } | { ok: false; line: string } {
  if (!existsSync(path)) return { ok: false, line: `${what}がありません: ${path}` };
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077)
    return {
      ok: false,
      line: `${what}の権限が広すぎます（${mode.toString(8)}）。0600 にしてください: ${path}`,
    };
  return { ok: true, value: readFileSync(path, "utf8") };
}

export async function runSecrets(opts: SecretsOptions, put: SecretPutter): Promise<SecretsResult> {
  const lines: string[] = [];
  const bad = (line: string): SecretsResult => ({ ok: false, lines: [...lines, line] });

  // 署名鍵: 読み、Worker と同じ検証（parseSigningKeys）を通す
  const keys = readPrivateFile(opts.keyFile, "署名鍵のファイル");
  if (!keys.ok) return bad(`${keys.line}（mise run console:keygen で作ります）`);
  const signingJson = keys.value.trim();
  let boundaries: [string, string][];
  try {
    const parsed = parseSigningKeys(signingJson);
    boundaries = await Promise.all(
      Object.entries(parsed).map(
        async ([b, jwk]) => [b, await thumbprintOf(jwk)] as [string, string],
      ),
    );
  } catch (e) {
    return bad(`署名鍵のファイルが使えません: ${(e as Error).message}（${opts.keyFile}）`);
  }

  // CSRF の鍵: あれば検査して使う。無ければ、確認があるときだけ作る
  let csrf: string | undefined;
  let csrfNew = false;
  if (existsSync(opts.csrfKeyFile)) {
    const f = readPrivateFile(opts.csrfKeyFile, "CSRF の鍵のファイル");
    if (!f.ok) return bad(f.line);
    csrf = f.value.trim();
    if (Buffer.byteLength(csrf) < MIN_CSRF_BYTES)
      return bad(`CSRF の鍵が短すぎます（${MIN_CSRF_BYTES} バイト以上）: ${opts.csrfKeyFile}`);
  } else {
    csrfNew = true;
  }

  lines.push("入れる Worker secret（値は表示しません）:");
  lines.push(`  CONSOLE_SIGNING_KEYS  ${opts.keyFile}`);
  for (const [b, kid] of boundaries) lines.push(`    境界 ${b}\tkid=${kid}`);
  lines.push(
    `  CONSOLE_CSRF_KEY      ${opts.csrfKeyFile}${csrfNew ? `（無いので ${MIN_CSRF_BYTES} バイトのランダムを作る）` : ""}`,
  );

  if (!opts.confirm) {
    lines.push("確認のオプション --yes が無いので、何も入れていません（dry-run）。");
    lines.push("入れるときは: mise run console:secrets:standard -- --yes");
    return { ok: true, lines };
  }

  if (csrf === undefined) {
    csrf = Array.from(randomBytes(MIN_CSRF_BYTES), (b) => b.toString(16).padStart(2, "0")).join(""); // 32 バイトの乱数を 16 進で（64 文字）
    mkdirSync(dirname(opts.csrfKeyFile), { recursive: true, mode: 0o700 });
    writeFileSync(opts.csrfKeyFile, `${csrf}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(opts.csrfKeyFile, 0o600);
    lines.push(`CSRF の鍵を作りました: ${opts.csrfKeyFile} (0600)`);
  }

  for (const [name, value] of [
    ["CONSOLE_SIGNING_KEYS", signingJson],
    ["CONSOLE_CSRF_KEY", csrf],
  ] as const) {
    const r = put(name, value);
    if (!r.ok) {
      const detail = r.message ? `: ${r.message.split(value).join("[REDACTED]")}` : "";
      return bad(`${name} を入れられませんでした${detail}`);
    }
    lines.push(`入れました: ${name}`);
  }
  return { ok: true, lines };
}
