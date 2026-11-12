// コンソールログイン（表示用）: 入口（S0。Standard の GET /）の処理（docs/specs/console-login-portal.md §4.1・§7・§9.2、U2）。
//   1. 入口のアプリの Access JWT を確かめる（JWT 無し 401・aud が入口の AUD ちょうど 1 つでなければ 403。入口の AUD が無い設定は 500）
//      入口の静的なファイル（/assets/<name>）も、この検証のあとに返す
//   2. 身元の Entra グループを差し込み口からサーバー側で取る（ブラウザが送る値は使わない）
//   3. 表示用の対応表（Object ID → チーム）と小文字で照合し、所属するチームの行の 1 つの一覧を描く。分からなければ全チームの S1 へのリンク
// 表示のためだけで、発行の認可には使わない。発行の経路（portal/login.ts・issue/*）はこのモジュールを import しない。
// Standard のエントリだけがこの処理を作る（Admin のバンドルには表示用の照合のコードと生成物を入れない）。
import { verifyConsoleAccess } from "../issue/access";
import { assetResponse } from "../portal/assets";
import { errorPage, htmlResponse } from "../portal/pages";
import type { EntryHandler } from "../portal/worker";
import type { DisplayConfig } from "../types";
import { DisplayConfigError, readDisplayConfig } from "./display-config";
import { entryPage } from "./entry-page";
import { fetchIdentityGroups, type IdentityGroupsSource, resolveMembership } from "./groups";

/** 入口のアプリの AUD を、検証の表の上でだけ置くチーム名（どのチームの名前とも比べない）。 */
const ENTRY = "entry";

export type EntryOptions = {
  /** 身元のグループの取り方。渡さなければ「分からない」（全チームのリンクに落とす）。 */
  identityGroups?: IdentityGroupsSource | undefined;
};

export function createEntryHandler(rawDisplay: unknown, o: EntryOptions = {}): EntryHandler {
  let loaded: { ok: true; display: DisplayConfig } | { ok: false; kind: string } | undefined;
  const load = () => {
    if (!loaded) {
      try {
        loaded = { ok: true, display: readDisplayConfig(rawDisplay) };
      } catch (e) {
        loaded = { ok: false, kind: e instanceof DisplayConfigError ? e.kind : "unknown" };
      }
    }
    return loaded;
  };

  return async (req, ctx) => {
    const { config, requestId } = ctx;
    const errOpts = { requestId, supportUrl: config.portal.supportUrl };
    const misconfigured = (kind: string) => {
      console.error(`config: invalid console display: ${kind}`);
      return htmlResponse(errorPage("server_misconfigured", errOpts), 500);
    };

    const entryAud = config.portal.entryAud;
    if (entryAud === undefined) return misconfigured("entry_aud_missing");

    // 1. 入口のアプリの Access JWT（aud は入口の AUD ちょうど 1 つ。チームの AUD は入口では受けない）
    const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
    const access = await verifyConsoleAccess(
      jwt,
      ENTRY,
      { teamDomain: ctx.accessTeamDomain, teams: [{ name: ENTRY, aud: entryAud }] },
      {
        ...(ctx.getAccessKey ? { getKey: ctx.getAccessKey } : {}),
        now: Math.floor(ctx.now() / 1000),
      },
    );
    if (!access.ok) {
      // チームの AUD は検証の表に無いので unknown_audience（team_mismatch にはならない）
      return htmlResponse(errorPage(access.code, errOpts), access.status);
    }

    // 入口の静的なファイル（名前は呼び出し側で許可リストを確かめ済み）
    if (ctx.asset !== undefined) {
      return assetResponse(ctx.asset) ?? htmlResponse(errorPage("not_found", errOpts), 404);
    }

    // 表示用の生成物の誤りは入口の画面だけを止める（チームのページと発行は表示用の値に依存しない）
    const d = load();
    if (!d.ok) return misconfigured(d.kind);
    const { display } = d;
    // 発行用の生成物との取り違え（別の設定から作ったもの）を弾く
    if (
      display.portal.origin !== config.portal.origin ||
      display.portal.routing !== config.portal.routing ||
      (display.portal.adminOrigin !== undefined &&
        config.portal.peerOrigin !== undefined &&
        display.portal.adminOrigin !== config.portal.peerOrigin)
    )
      return misconfigured("portal_mismatch");

    // 2・3. 身元のグループ（サーバー側）→ 表示用の照合
    const groups = await fetchIdentityGroups(o.identityGroups, {
      accessJwt: jwt as string,
      claims: access.claims,
      teamDomain: ctx.accessTeamDomain,
    });
    const membership = resolveMembership(display.groups, groups);
    if (membership.status === "unknown")
      console.log(`entry: membership unknown: ${membership.reason}`);
    return htmlResponse(entryPage(display, membership));
  };
}
