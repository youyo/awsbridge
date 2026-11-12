// コンソールログイン: Cloudflare Access のアプリの設定の検査の判定（純粋な関数）。設計: docs/specs/console-login.md §5.4。
// 読み取り（Cloudflare API）は scripts/console/access-inspect*.ts。node の API を使わない。
// どの Worker のエントリからも import しない（Worker は Cookie Path を強制しない。cto の決裁。test/unit/console-layout.test.ts で確かめる）。
//
// 要件: R-P（routing: path）では、Standard も Admin も、入口のアプリとすべてのチームのアプリで Cookie Path
// （path_cookie_attribute）が有効であること。無効（false か欠落）だと、同じホストの別のアプリの AUD が JWT の aud に混ざり、
// Worker の「aud はちょうど 1 つ」の検査で断られる（ログインができなくなる。破れるのは可用性）。
// R-H（routing: host）ではチームごとにホストが分かれ、Cookie もホストで分かれるので、警告に下げる。
//
// 結果（AccessFinding）は種別のコードと、対象（team:<名前> / entry:<階層>）だけを持つ。AUD の値は入れない。

import type { Tier } from "./constants";
import type { AccessSummary } from "./generate";

/** Cloudflare から読んだ Access アプリのうち、検査に使う項目。 */
export type AccessAppSnapshot = {
  aud: string;
  type: string;
  /** アプリの対象（destinations の uri。無ければ domain）。`host` か `host/path`。 */
  destinations: string[];
  /** path_cookie_attribute。欠落は undefined。 */
  pathCookie: boolean | undefined;
};

export type AccessSeverity = "error" | "warning";
export type AccessFinding = {
  severity: AccessSeverity;
  code: string;
  /** team:<名前> / entry:<階層>。設定に無いアプリは "-"。 */
  subject: string;
  detail?: string;
};

export type AccessInspectInput = { summary: AccessSummary; apps: AccessAppSnapshot[] };

/** スキーム・末尾の `/*` と `/` を外し、ホストを小文字にする（表記の揺れを同じとみなす）。 */
export function normalizeDestination(uri: string): string {
  const noScheme = uri.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = noScheme.indexOf("/");
  const host = (slash < 0 ? noScheme : noScheme.slice(0, slash)).toLowerCase();
  let path = slash < 0 ? "" : noScheme.slice(slash);
  path = path.replace(/\/\*$/, "").replace(/\/+$/, "");
  return `${host}${path}`;
}

/** origin（https://host[:port]）のホスト部分。 */
function originHost(origin: string): string {
  return normalizeDestination(origin);
}

type Subject = { subject: string; aud: string | undefined; expected: string | undefined };

/** 検査する対象（入口と、チーム）と、あるべき対象の場所。 */
function subjectsOf(summary: AccessSummary): Subject[] {
  const out: Subject[] = [];
  const byPath = summary.routing === "path";
  const hostOf = (tier: Tier): string | undefined => {
    const o = tier === "standard" ? summary.origins.standard : summary.origins.admin;
    return o === undefined ? undefined : originHost(o);
  };
  const tiersInUse = new Set<Tier>(["standard", ...summary.teams.map((t) => t.tier)]);
  for (const tier of ["standard", "admin"] as const) {
    if (!tiersInUse.has(tier)) continue;
    out.push({ subject: `entry:${tier}`, aud: summary.entryAud[tier], expected: hostOf(tier) });
  }
  for (const t of summary.teams) {
    const host = hostOf(t.tier);
    out.push({
      subject: `team:${t.name}`,
      aud: t.aud,
      expected:
        host === undefined ? undefined : byPath ? `${host}/t/${t.name}` : `${t.name}.${host}`,
    });
  }
  return out;
}

/** コンソールのホストの下の、チーム用の場所か（R-P: ホストの /t/ の下。R-H: ホストのサブドメイン）。 */
function isTeamPlace(dest: string, summary: AccessSummary, hosts: string[]): boolean {
  const slash = dest.indexOf("/");
  const host = slash < 0 ? dest : dest.slice(0, slash);
  const path = slash < 0 ? "" : dest.slice(slash);
  return summary.routing === "path"
    ? hosts.includes(host) && path.startsWith("/t/")
    : hosts.some((h) => host.endsWith(`.${h}`));
}

/**
 * Access アプリの設定を検査する。誤り（error）: アプリが無い・種類が違う・対象が違う・Cookie Path が無効（R-P）。
 * 警告（warning）: R-H の Cookie Path の無効、設定に無いチーム用のアプリ、AUD が分からず検査できない対象。
 */
export function inspectAccessApps(input: AccessInspectInput): AccessFinding[] {
  const { summary, apps } = input;
  const findings: AccessFinding[] = [];
  const add = (severity: AccessSeverity, code: string, subject: string, detail?: string) =>
    findings.push({ severity, code, subject, ...(detail !== undefined ? { detail } : {}) });
  const cookieSeverity: AccessSeverity = summary.routing === "path" ? "error" : "warning";

  const byAud = new Map(apps.map((a) => [a.aud, a]));
  const known = new Set<string>();
  for (const s of subjectsOf(summary)) {
    if (s.aud === undefined) {
      add("warning", "access_aud_unset", s.subject);
      continue;
    }
    known.add(s.aud);
    const found = byAud.get(s.aud);
    if (found === undefined) {
      add("error", "access_app_missing", s.subject);
      continue;
    }
    if (found.type !== "self_hosted") add("error", "access_app_type", s.subject, found.type);
    const actual = [...new Set(found.destinations.map(normalizeDestination))].sort();
    if (s.expected === undefined || actual.length !== 1 || actual[0] !== s.expected)
      add(
        "error",
        "access_app_destination_mismatch",
        s.subject,
        `expected ${s.expected ?? "(origin unset)"}, got ${actual.join(" ") || "(none)"}`,
      );
    if (found.pathCookie !== true) add(cookieSeverity, "path_cookie_disabled", s.subject);
  }

  // 設定に無い AUD のアプリが、コンソールのホストのチーム用の場所にある
  const hosts = [summary.origins.standard, summary.origins.admin]
    .filter((o): o is string => o !== undefined)
    .map(originHost);
  for (const a of apps) {
    if (known.has(a.aud)) continue;
    for (const d of new Set(a.destinations.map(normalizeDestination)))
      if (isTeamPlace(d, summary, hosts)) add("warning", "access_app_extra", "-", d);
  }
  return findings;
}

// ---- 出力 ----

/** email を伏せる（アカウント ID は扱わない）。 */
function redactEmail(text: string): string {
  return text.replace(/[^\s@"'<>,;:()[\]]+@[^\s@"'<>,;:()[\]]+/g, "<email>");
}

const LABEL: Record<AccessSeverity, string> = { error: "ERROR", warning: "WARN " };

/** 結果を 1 行ずつの文字列にする（誤り → 警告の順。最後に件数の行）。AUD は入れない。 */
export function formatAccessReport(findings: AccessFinding[]): string {
  const lines: string[] = [];
  for (const sev of ["error", "warning"] as const)
    for (const f of findings.filter((x) => x.severity === sev))
      lines.push([LABEL[sev], f.code, f.subject, f.detail ?? ""].join("  ").trimEnd());
  const n = (sev: AccessSeverity) => findings.filter((x) => x.severity === sev).length;
  lines.push(`errors: ${n("error")}, warnings: ${n("warning")}`);
  return redactEmail(lines.join("\n"));
}
