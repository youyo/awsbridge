// コンソールログイン（表示用）: 入口の一覧（S0。U2）のための、身元の Entra グループの取得の差し込み口と照合。
// 設計: docs/specs/console-login-portal.md §4.1・§7、ADR「一覧の統合（U2）」。
// 表示のためだけで、発行の認可には使わない。発行の経路（portal/login.ts・issue/*）はこのモジュールを import しない。
// グループはサーバー側の差し込み口からだけ取る（ブラウザが送る値・要求のヘッダーやクエリは使わない）。

/**
 * 身元のグループの取得の結果。
 *   ok: true    取れた（Entra グループの Object ID の一覧。空なら「どのグループにも属さない」）
 *   ok: false   取れない・溢れた・壊れている・取り方が未設定（どれも「分からない」として全チームのリンクに落とす）
 */
export type IdentityGroupsResult =
  | { ok: true; groups: readonly string[] }
  | { ok: false; reason: "not_configured" | "unavailable" | "overflow" | "malformed" };

/** 差し込み口に渡す文脈。検証済みの入口の Access JWT の claim と、Access のチームドメイン。 */
export type IdentityGroupsContext = {
  /** 検証済みの入口のアプリの Access JWT（get-identity を呼ぶときの資格）。 */
  accessJwt: string;
  /** 検証済みの JWT の claim（sub・email など）。 */
  claims: Readonly<Record<string, unknown>>;
  /** Access のチームドメイン（https://<team>.cloudflareaccess.com）。 */
  teamDomain: string;
};

/**
 * 身元の Entra グループを取る差し込み口。取り方（Access の get-identity など）は未確定で、本番のエントリは何も渡さない
 * （そのときは not_configured → 全チームのリンクに落とす）。例外を投げたら unavailable として扱う。
 */
export type IdentityGroupsSource = (ctx: IdentityGroupsContext) => Promise<IdentityGroupsResult>;

/** 身元のグループの数の上限。これを超えたら溢れたものとして扱う（全チームのリンクに落とす）。 */
export const MAX_IDENTITY_GROUPS = 1000;

/**
 * 照合の結果。
 *   member   所属するチームが 1 つ以上ある（表示用。発行の認可ではない）
 *   none     グループは取れたが、どのチームにも当たらない（所属なし。行を出さずに申請先を案内する）
 *   unknown  分からない（取れない・溢れた・壊れている・対応表が空）。全チームの S1 へのリンクに落とす
 */
export type Membership =
  | { status: "member"; teams: ReadonlySet<string> }
  | { status: "none" }
  | { status: "unknown"; reason: string };

/**
 * 身元のグループ（Object ID）を、表示用の対応表（Object ID は小文字）と照合する。Object ID は小文字にそろえて比べる。
 * 対応表が空（開発・個人の環境。Object ID を設定に持たない）なら、取れたグループに関係なく「分からない」にする
 * （「所属なし」と取り違えない）。
 */
export function resolveMembership(
  table: readonly { objectId: string; teams: readonly string[] }[],
  result: IdentityGroupsResult,
): Membership {
  if (!result.ok) return { status: "unknown", reason: result.reason };
  if (table.length === 0) return { status: "unknown", reason: "no_group_table" };
  const groups: unknown = result.groups;
  if (!Array.isArray(groups)) return { status: "unknown", reason: "malformed" };
  if (groups.length > MAX_IDENTITY_GROUPS) return { status: "unknown", reason: "overflow" };
  const byId = new Map(table.map((g) => [g.objectId.toLowerCase(), g.teams]));
  const teams = new Set<string>();
  for (const id of groups) {
    if (typeof id !== "string" || id === "") return { status: "unknown", reason: "malformed" };
    for (const t of byId.get(id.toLowerCase()) ?? []) teams.add(t);
  }
  return teams.size > 0 ? { status: "member", teams } : { status: "none" };
}

/** 差し込み口を呼ぶ。未設定なら not_configured、例外は unavailable（値は持たない）。 */
export async function fetchIdentityGroups(
  source: IdentityGroupsSource | undefined,
  ctx: IdentityGroupsContext,
): Promise<IdentityGroupsResult> {
  if (!source) return { ok: false, reason: "not_configured" };
  try {
    const r = await source(ctx);
    if (r && typeof r === "object" && (r.ok === true || r.ok === false)) return r;
    return { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
