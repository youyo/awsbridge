// コンソールログイン: `POST <team-base>/login` の検査と発行（docs/specs/console-login-portal.md §9.3・§9.4・§10.3）。
// 発行の経路はこのモジュールに閉じる（ルーター・画面・入口の表示用の照合を import しない。§9.10 の U2 の条件）。
// 階層（Standard / Admin）に共通で、違いは署名の部品（signer）と Access JWT の経過時間の上限（Admin だけ）。
// Standard（境界ごと）も Admin も Workers の secret_key 型の取り出せない鍵（鍵が使えなければ 503 signing_unavailable）。
//
// 段の順（司令塔の決定。§9.3 の「本文の前に 1〜3、STS の前に 4〜8」は満たす）:
//   停止スイッチ → 要求の検査（Origin・Sec-Fetch-Site・Content-Type）→ Access JWT（aud ちょうど 1 つ・入口の AUD は受けない）
//   → 本文 → CSRF → 行（このチーム・この階層の行。7 段目）→ 身元（identity_unsupported）→ 回数の制限
//   → 署名 → STS → getSigninToken → 302
// どこかで失敗したら発行しない（fail-closed）。例外を握りつぶして続行しない。
import { decodeProtectedHeader, type JWTVerifyGetKey } from "jose";
import { assumeRoleWithWebIdentityDetailed, StsError } from "../../sts";
import { ACCOUNT_ID_RE, NAME_RE, rolePath, type Tier } from "../constants";
import { verifyConsoleAccess } from "../issue/access";
import { verifyCsrfToken } from "../issue/csrf";
import { IssueError, type IssueErrorCode, stsErrorKindToCode } from "../issue/errors";
import {
  consoleDestination,
  fetchSigninToken,
  loginUrl,
  resolveRegion,
  signinIssuer,
  stsEndpoint,
} from "../issue/federation";
import { type AccessIdentity, type ResolvedIdentity, resolveIdentity } from "../issue/identity";
import { createIssueRecord, issueLogRecord } from "../issue/record";
import { checkLoginRequest } from "../issue/request";
import type { IssueRow, TokenSigner } from "../issue/signer";
import type { WorkerConfig } from "../types";

/** Workers の Rate Limiting の binding（必要な形だけ）。 */
export type LoginRateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type LoginContext = {
  tier: Tier;
  /** 検証済みの発行用の生成物（readWorkerConfig を通したもの）。 */
  config: WorkerConfig;
  /** パス（ホスト）のチーム。設定にあるチームだけ（ルーターが確かめる）。AUD のチームと食い違えば拒否する。 */
  team: string;
  /** このチームのページのオリジン（検証済みの設定から作る。Host ヘッダーは使わない）。 */
  teamOrigin: string;
  accessTeamDomain: string;
  loginDisabled: boolean;
  csrfKey: CryptoKey;
  signer: TokenSigner;
  rateLimiter: LoginRateLimiter | undefined;
  stsRegion: string;
  fetch: typeof fetch;
  /** epoch ミリ秒。 */
  now: () => number;
  log: (line: string) => void;
  getAccessKey?: JWTVerifyGetKey | undefined;
  /** Access JWT の iat からの経過時間の上限（秒）。Admin だけが渡す（X1 の決裁 (f)）。 */
  accessMaxAgeSeconds?: number | undefined;
  /** 発行記録に残す Worker の版 ID（binding CF_VERSION_METADATA の id。取れなければ undefined）。 */
  workerVersionId?: string | undefined;
};

export type LoginOutcome =
  | { ok: true; location: string }
  | {
      ok: false;
      code: IssueErrorCode | "method_not_allowed" | "payload_too_large";
      status: number;
    };

/** POST の本文の上限（バイト）。フォームは entry・region・csrf だけなので十分に大きい。 */
export const MAX_BODY_BYTES = 8 * 1024;
const TOO_LARGE: LoginOutcome = { ok: false, code: "payload_too_large", status: 413 };

/** 本文を上限まで読む。超えたら undefined（Content-Length の申告によらず、読んだ量で止める）。 */
async function readBodyLimited(req: Request, max: number): Promise<string | undefined> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

const fail = (code: IssueErrorCode): LoginOutcome => ({
  ok: false,
  code,
  status: new IssueError(code).status,
});

const ENTRY_RE = /^(\d{12}):([a-z][a-z0-9-]{0,31})$/;

/** `entry`（`<account-id>:<role>`）を、このチーム・この階層の行に引く。なければ undefined（not_listed）。 */
export function findRow(
  config: WorkerConfig,
  tier: Tier,
  team: string,
  entry: string,
): IssueRow | undefined {
  const m = ENTRY_RE.exec(entry);
  if (!m) return undefined;
  const [, accountId, roleName] = m as unknown as [string, string, string];
  if (!ACCOUNT_ID_RE.test(accountId) || !NAME_RE.test(roleName)) return undefined;
  const account = config.accounts.find((a) => a.accountId === accountId);
  const accountRole = account?.roles.find((r) => r.role === roleName);
  const role = config.roles.find((r) => r.name === roleName);
  const boundary = config.boundaries.find((b) => b.name === account?.boundary);
  if (!account || !accountRole || !role || !boundary) return undefined;
  if (!accountRole.teams.includes(team)) return undefined;
  // 多重の防御: この階層のロールのパスと名前の ARN だけ（生成物の検査でも確かめている）
  if (accountRole.roleArn !== `arn:aws:iam::${accountId}:role${rolePath(tier)}${role.roleName}`)
    return undefined;
  return {
    team,
    boundary: boundary.name,
    issuer: boundary.issuer,
    accountId,
    role: role.name,
    roleArn: accountRole.roleArn,
    sessionSeconds: accountRole.sessionSeconds,
  };
}

/** フォームの値をちょうど 1 つだけ取る（重ねて送られたら undefined）。 */
function single(form: URLSearchParams, name: string): string | undefined {
  const v = form.getAll(name);
  return v.length === 1 ? v[0] : undefined;
}

export async function handleLogin(req: Request, ctx: LoginContext): Promise<LoginOutcome> {
  const log = (code: string, extra: Record<string, unknown> = {}) =>
    ctx.log(
      JSON.stringify({
        event: "console_login",
        tier: ctx.tier,
        team: ctx.team,
        result: code,
        ...extra,
      }),
    );

  // 停止スイッチ（Worker の変数）
  if (ctx.loginDisabled) {
    log("login_disabled");
    return fail("login_disabled");
  }

  // 要求の検査（本文を読む前）。比べる相手は検証済みの設定から作ったオリジン
  const bad = checkLoginRequest(req, ctx.teamOrigin);
  if (bad) {
    log(bad.code);
    return bad.code === "method_not_allowed"
      ? { ok: false, code: "method_not_allowed", status: 405 }
      : fail(bad.code);
  }

  // Access JWT（aud はちょうど 1 つで、このデプロイの階層のチームの AUD。入口の AUD は受けない）
  const access = await verifyConsoleAccess(
    req.headers.get("Cf-Access-Jwt-Assertion"),
    ctx.team,
    {
      teamDomain: ctx.accessTeamDomain,
      teams: ctx.config.teams,
      entryAud: ctx.config.portal.entryAud,
    },
    {
      ...(ctx.getAccessKey ? { getKey: ctx.getAccessKey } : {}),
      now: Math.floor(ctx.now() / 1000),
      ...(ctx.accessMaxAgeSeconds !== undefined ? { maxAgeSeconds: ctx.accessMaxAgeSeconds } : {}),
    },
  );
  if (!access.ok) {
    log(access.code, "reason" in access ? { reason: access.reason } : {});
    return fail(access.code);
  }

  // 本文（検査を通ったあとで読む）
  let form: URLSearchParams;
  try {
    const body = await readBodyLimited(req, MAX_BODY_BYTES);
    if (body === undefined) {
      log("payload_too_large");
      return TOO_LARGE;
    }
    form = new URLSearchParams(body);
  } catch {
    log("csrf_failed", { reason: "body" });
    return fail("csrf_failed");
  }

  // CSRF（検証済みの aud・sub に束縛）
  const csrf = await verifyCsrfToken(
    ctx.csrfKey,
    single(form, "csrf"),
    { aud: access.aud, sub: access.sub },
    Math.floor(ctx.now() / 1000),
  );
  if (!csrf.ok) {
    log(csrf.code, { reason: csrf.reason });
    return fail(csrf.code);
  }

  // 7 段目: このチーム・この階層の行（Admin の行は Standard の生成物にないので not_listed）
  const entry = single(form, "entry");
  const row = entry === undefined ? undefined : findRow(ctx.config, ctx.tier, ctx.team, entry);
  if (!row) {
    log("not_listed");
    return fail("not_listed");
  }
  const region = resolveRegion(single(form, "region"), ctx.config.portal.regions);

  // 身元（SourceIdentity・RoleSessionName の制約）。小文字化する前の生の email で検査する
  const custom = access.claims.custom;
  const customObj =
    typeof custom === "object" && custom !== null && !Array.isArray(custom)
      ? (custom as Record<string, unknown>)
      : undefined;
  const oid = customObj?.oid;
  const identity: AccessIdentity = {
    sub: access.sub,
    email: typeof access.claims.email === "string" ? access.claims.email : "",
    ...(typeof oid === "string" && oid !== "" ? { oid } : {}),
    ...(customObj ? { custom: customObj } : {}),
  };
  const resolvedResult = resolveIdentity(identity, ctx.config.identity.sourceIdentity);
  if (!resolvedResult.ok) {
    log("identity_unsupported");
    return fail("identity_unsupported");
  }
  const resolved = resolvedResult.value;

  // ここからは発行記録（issueLogRecord の形）を残す
  const record = (
    result: "ok" | IssueErrorCode,
    extra: {
      token?: { jti: string; iat: number; exp: number; kid?: string | undefined };
      sts?: { accessKeyId?: string; assumedRoleId?: string; requestId?: string };
    } = {},
  ) => {
    const r = createIssueRecord({
      tier: ctx.tier,
      result,
      now: ctx.now(),
      identity,
      resolved,
      row,
      token: extra.token,
      consoleRegion: region,
      sts: { region: ctx.stsRegion, ...(extra.sts ?? {}) },
      cfRay: req.headers.get("Cf-Ray") ?? undefined,
      list: {
        generatedAt: ctx.config.generatedAt,
        sourceRevision: ctx.config.sourceRevision,
      },
      workerVersionId: ctx.workerVersionId,
    });
    // jti・kid・アカウント ID・ロール ARN は秘密ではなく、CloudTrail との突き合わせのキーなので全桁で残す。email などは伏せ字
    // （cto の決裁 2026-11-13。突き合わせの道具 src/console/reconcile.ts がこの形を読む）
    ctx.log(JSON.stringify({ event: "console_issue", ...issueLogRecord(r) }));
  };
  return issue(ctx, { identity, resolved, row, region, record });
}

type IssueState = {
  identity: AccessIdentity;
  resolved: ResolvedIdentity;
  row: IssueRow;
  region: ReturnType<typeof resolveRegion>;
  record: (
    result: "ok" | IssueErrorCode,
    extra?: {
      token?: { jti: string; iat: number; exp: number; kid?: string | undefined };
      sts?: { accessKeyId?: string; assumedRoleId?: string; requestId?: string };
    },
  ) => void;
};

async function issue(ctx: LoginContext, s: IssueState): Promise<LoginOutcome> {
  const { identity, resolved, row, region, record } = s;

  // 回数の制限（利用者ごと。キーは検証済みの Access の sub）。binding がない・例外なら発行しない
  if (!ctx.rateLimiter || typeof ctx.rateLimiter.limit !== "function") {
    record("server_misconfigured");
    return fail("server_misconfigured");
  }
  let allowed: boolean;
  try {
    allowed =
      (await ctx.rateLimiter.limit({ key: `${ctx.tier}:${identity.sub}` })).success === true;
  } catch {
    record("temporarily_unavailable");
    return fail("temporarily_unavailable");
  }
  if (!allowed) {
    record("rate_limited");
    return fail("rate_limited");
  }

  // 署名（差し込み口）
  const signed = await ctx.signer.sign({
    identity,
    resolved,
    row,
    now: Math.floor(ctx.now() / 1000),
  });
  if (!signed.ok) {
    record(signed.code);
    return fail(signed.code);
  }
  const token = {
    jti: signed.token.jti,
    iat: signed.token.iat,
    exp: signed.token.exp,
    kid: kidOf(signed.token.jwt),
  };

  try {
    // STS（セッションの長さは行の値を必ず渡す。既定の 900 秒にしない）
    let details: Awaited<ReturnType<typeof assumeRoleWithWebIdentityDetailed>>;
    try {
      details = await assumeRoleWithWebIdentityDetailed({
        token: signed.token.jwt,
        roleArn: row.roleArn,
        sessionName: resolved.sessionName,
        durationSeconds: row.sessionSeconds,
        region: ctx.stsRegion,
        endpoint: stsEndpoint(ctx.stsRegion),
        fetch: ctx.fetch,
      });
    } catch (e) {
      const code = e instanceof StsError ? stsErrorKindToCode(e.kind) : "temporarily_unavailable";
      record(code, { token });
      return fail(code);
    }
    const sts = {
      accessKeyId: details.credentials.accessKeyId,
      ...(details.assumedRoleId !== undefined ? { assumedRoleId: details.assumedRoleId } : {}),
      ...(details.requestId !== undefined ? { requestId: details.requestId } : {}),
    };

    let signinToken: string;
    try {
      signinToken = await fetchSigninToken({
        credentials: details.credentials,
        sessionSeconds: row.sessionSeconds,
        fetch: ctx.fetch,
      });
    } catch (e) {
      const code = e instanceof IssueError ? e.code : "signin_failed";
      record(code, { token, sts });
      return fail(code);
    }

    const location = loginUrl({
      signinToken,
      issuer: signinIssuer(ctx.config.portal, row.team),
      destination: consoleDestination(region),
    });
    record("ok", { token, sts });
    return { ok: true, location };
  } catch (e) {
    // Issuer・Destination の組み立ての失敗など（設定の不整合）。詳細は画面に出さない
    const code = e instanceof IssueError ? e.code : "server_misconfigured";
    record(code, { token });
    return fail(code);
  }
}

/** 署名した鍵の kid（JWT の保護ヘッダー）。発行記録に残すだけで、検証には使わない。読めなければ undefined。 */
function kidOf(jwt: string): string | undefined {
  try {
    const kid = decodeProtectedHeader(jwt).kid;
    return typeof kid === "string" && kid !== "" ? kid : undefined;
  } catch {
    return undefined;
  }
}
