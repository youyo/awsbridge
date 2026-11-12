// コンソールログイン: ポータルのホストでの経路の振り分け（docs/specs/console-login-portal.md §3.1・§9.2）。
// パス方式（R-P。既定）: https://<host>/t/<team>/...。ホスト方式（R-H）: https://<team>.<host>/...（設定 portal.routing で切り替える）。
// チームは設定にあるこの階層のチームだけ。パス・ホストのチームは振り分けにだけ使い、発行のチームは AUD で決める（login.ts）。
// チームのページのオリジン（Origin の検査と Issuer に使う）は、検証済みの設定の値から作る。Host ヘッダーの値をそのまま使わない。
import { ACCOUNT_ID_RE } from "../constants";
import type { WorkerConfig } from "../types";

export type TeamPage = "list" | "account" | "cli" | "login" | "expired";

export type PortalRoute =
  | { kind: "entry" }
  | {
      kind: "team";
      team: string;
      /** 画面のリンク・フォームの送信先に使う起点（パス方式は /t/<team>、ホスト方式は空）。 */
      teamBase: string;
      /** このチームのページのオリジン（設定から作る）。 */
      teamOrigin: string;
      page: TeamPage;
      accountId?: string;
    }
  | { kind: "not_found" };

function teamRest(rest: string): { page: TeamPage; accountId?: string } | undefined {
  if (rest === "" || rest === "/") return { page: "list" };
  if (rest === "/login") return { page: "login" };
  if (rest === "/expired") return { page: "expired" };
  const m = /^\/a\/([^/]+)(\/cli)?$/.exec(rest);
  if (m && ACCOUNT_ID_RE.test(m[1] as string))
    return { page: m[2] ? "cli" : "account", accountId: m[1] as string };
  return undefined;
}

/**
 * ポータルのホストなら経路を返す。ポータルのホストでなければ undefined（呼び出し側が 404 にする）。
 * `url.host` は小文字（URL の正規化）で、設定のオリジンのホストと完全一致で比べる。
 */
export function matchPortal(url: URL, config: WorkerConfig): PortalRoute | undefined {
  const origin = new URL(config.portal.origin);
  const teams = new Set(config.teams.map((t) => t.name));

  if (config.portal.routing === "host") {
    if (url.host === origin.host)
      return url.pathname === "/" ? { kind: "entry" } : { kind: "not_found" };
    const suffix = `.${origin.host}`;
    if (!url.host.endsWith(suffix)) return undefined;
    const team = url.host.slice(0, -suffix.length);
    if (!teams.has(team)) return { kind: "not_found" };
    const rest = teamRest(url.pathname);
    if (!rest) return { kind: "not_found" };
    return {
      kind: "team",
      team,
      teamBase: "",
      teamOrigin: `${origin.protocol}//${team}.${origin.host}`,
      ...rest,
    };
  }

  if (url.host !== origin.host) return undefined;
  if (url.pathname === "/") return { kind: "entry" };
  const m = /^\/t\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return { kind: "not_found" };
  const team = m[1] as string;
  if (!teams.has(team)) return { kind: "not_found" };
  const rest = teamRest(m[2] ?? "");
  if (!rest) return { kind: "not_found" };
  return { kind: "team", team, teamBase: `/t/${team}`, teamOrigin: config.portal.origin, ...rest };
}
