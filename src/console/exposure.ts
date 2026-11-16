// コンソールログインの issuer の「外からの比較」の判定（純粋な関数）。scripts/console/exposure-check*.ts が使う。
// 外から取った issuer の discovery と JWKS が、設定の公開鍵（vars の STANDARD_PUBLIC_JWKS / ADMIN_PUBLIC_JWKS）と一致するかを確かめる。
// 目的: issuer のホストの応答を、Route などで差し替えられていないことの検知（AWS の OIDC プロバイダーはこの JWKS を信頼する）。
//
// 誤りにするもの（一致のときだけ ok）:
//   HTTP 200 以外 / リダイレクト（追わない） / 取得の失敗 / JSON でない / 形が違う / discovery の issuer・jwks_uri の違い /
//   JWKS の鍵の増減（kid の過不足・重複・kid なし）/ 鍵の中身（kty・n・e・alg・use・余分なメンバー）の違い
// 出力に応答の値（n・応答の kid・issuer の文字列）は入れない。出すのはメンバー名と、設定の側の kid だけ（応答由来の文字は英数字に絞って短くする）。
// 手元の道具（scripts/console/）だけが使う。Worker のバンドルには入れない。
import type { PublicJwk } from "./signing/key";

/** 取った 1 つの文書。error は取得の失敗（DNS・接続・TLS・タイムアウト・大きすぎる本文など）。json が undefined なら JSON として読めない。 */
export type DocResponse =
  | { kind: "error"; reason: string }
  | { kind: "response"; status: number; location?: string | undefined; json?: unknown };

export type Check = { ok: boolean; message: string };

export type TargetResult = { label: string; issuer: string; checks: Check[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 応答由来の文字を、端末に出して安全な短い形にする（英数字・_・-・. だけ。16 文字まで）。 */
function safe(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[^A-Za-z0-9_.-]/g, "") : "";
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

const ng = (message: string): Check => ({ ok: false, message });
const ok = (message: string): Check => ({ ok: true, message });

/** HTTP の状態（200 だけ通す。リダイレクトは追わずに誤り）。通らなければ誤りの Check、通れば undefined。 */
function statusProblem(what: string, res: DocResponse): Check | undefined {
  if (res.kind === "error") return ng(`${what}: 取得できない（${safe(res.reason) || "error"}）`);
  if (res.status >= 300 && res.status < 400)
    return ng(`${what}: リダイレクト（HTTP ${res.status}。追わない）`);
  if (res.status !== 200) return ng(`${what}: HTTP ${res.status}（200 でない）`);
  return undefined;
}

/** discovery の確認: HTTP 200・JSON のオブジェクト・issuer が期待と同じ・jwks_uri が <issuer>/.well-known/jwks.json。 */
export function judgeDiscovery(issuer: string, res: DocResponse): Check[] {
  const p = statusProblem("discovery", res);
  if (p) return [p];
  const body = (res as { json?: unknown }).json;
  if (!isObj(body)) return [ng("discovery: JSON のオブジェクトでない")];
  const checks: Check[] = [ok("discovery: HTTP 200")];
  checks.push(
    body.issuer === issuer
      ? ok("discovery: issuer が設定と同じ")
      : ng("discovery: issuer が設定と違う"),
  );
  checks.push(
    body.jwks_uri === `${issuer}/.well-known/jwks.json`
      ? ok("discovery: jwks_uri が <issuer>/.well-known/jwks.json")
      : ng("discovery: jwks_uri が <issuer>/.well-known/jwks.json と違う"),
  );
  return checks;
}

/** メンバーを名前の順に並べた JSON（鍵の中身の比較用）。 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}

/** JWKS の確認: HTTP 200・keys の配列・設定の公開鍵と kid が過不足なく同じで、鍵の中身も同じ。 */
export function judgeJwks(expected: readonly PublicJwk[], res: DocResponse): Check[] {
  // 期待の鍵が 0 本のときは、空の JWKS とも一致にしない（設定が空のまま「一致」にならないように）
  if (expected.length === 0) return [ng("JWKS: 設定の公開鍵が 0 本（比べる相手が無い）")];
  const p = statusProblem("JWKS", res);
  if (p) return [p];
  const body = (res as { json?: unknown }).json;
  if (!isObj(body)) return [ng("JWKS: JSON のオブジェクトでない")];
  if (!Array.isArray(body.keys)) return [ng("JWKS: keys が配列でない")];

  const checks: Check[] = [ok("JWKS: HTTP 200")];
  const served = new Map<string, Record<string, unknown>>();
  let problems = 0;
  const fail = (m: string) => {
    problems++;
    checks.push(ng(m));
  };
  for (const k of body.keys) {
    if (!isObj(k) || typeof k.kid !== "string" || k.kid === "") {
      fail("JWKS: kid の無い（または鍵でない）項目がある");
      continue;
    }
    if (served.has(k.kid)) {
      fail(`JWKS: 同じ kid が 2 つある（${safe(k.kid)}）`);
      continue;
    }
    served.set(k.kid, k);
  }
  const want = new Map(expected.map((k) => [k.kid, k as unknown as Record<string, unknown>]));
  for (const [kid, w] of want) {
    const s = served.get(kid);
    if (!s) {
      fail(`JWKS: 設定の鍵 ${safe(kid)} が無い（欠けている）`);
      continue;
    }
    if (canonical(s) !== canonical(w)) {
      const members = [...new Set([...Object.keys(w), ...Object.keys(s)])]
        .filter((m) => canonical(w[m]) !== canonical(s[m]))
        .map(safe)
        .join(",");
      fail(`JWKS: 設定の鍵 ${safe(kid)} と中身が違う（メンバー ${members}）`);
    }
  }
  for (const kid of served.keys())
    if (!want.has(kid)) fail(`JWKS: 設定に無い鍵がある（kid ${safe(kid)}）`);
  if (problems === 0) checks.push(ok(`JWKS: 設定の公開鍵 ${expected.length} 本と一致`));
  return checks;
}

/** 0 一致 / 1 誤りあり。対象が 0 件は一致にしない。 */
export function exposureExitCode(results: readonly TargetResult[]): 0 | 1 {
  if (results.length === 0) return 1;
  return results.every((r) => r.checks.length > 0 && r.checks.every((c) => c.ok)) ? 0 : 1;
}

/** アカウント ID（12 桁）と email を伏せる（IAM の検査の判定 inspect.ts は import しない。別の道具・別の許可リスト）。 */
export function redactExposure(text: string): string {
  return text
    .replace(/(?<!\d)\d{12}(?!\d)/g, "<account>")
    .replace(/[^\s@"'<>,;:()[\]]+@[^\s@"'<>,;:()[\]]+/g, "<email>");
}

/** 結果の表示（アカウント ID・email は伏せる）。 */
export function formatExposure(results: readonly TargetResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.label}  ${r.issuer}`);
    for (const c of r.checks) lines.push(`  ${c.ok ? "[OK]" : "[NG]"} ${c.message}`);
  }
  lines.push(
    exposureExitCode(results) === 0
      ? "結論: 外から取った issuer の文書は、設定の公開鍵と一致した"
      : "結論: 不一致あり（上の [NG]）。issuer のホストの応答が差し替えられている可能性がある",
  );
  return redactExposure(lines.join("\n"));
}
