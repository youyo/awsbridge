// cto の条件 (2)（ADR-003 相当の 3-B の 2）: 「Access を経由しない入口」を閉じたことを実環境で確かめる。
//   B1 workers.dev の URL と Version URL に直接リクエスト → Worker に届かない（Cloudflare のエラー。1042 など）
//   B2 Cloudflare API（読み取りだけ）でスクリプトの workers.dev・Preview URL の有効/無効、Custom Domain、
//      Custom Domain のゾーンの Worker のルートを読み、入口が Custom Domain 1 つだけか
//   B3 自社ドメインのホストに、Cookie なしで偽の Cf-Access-Jwt-Assertion（手元の鍵で署名、aud はチームのアプリ）を付けて
//      GET /t/<team>/whoami と POST /t/<team>/login → Access がログインへリダイレクトし、Worker の応答は返らない
//   B4 失効済みで期限内の Access JWT の持ち込み: poc-token で取った JWT（AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE）を
//      Cookie（CF_Authorization）・Cf-Access-Jwt-Assertion・cf-access-token で送る → 失効前は Cookie で通る →
//      --revoke で access-revoke.ts（infra のアプリ）を呼ぶ → 同じトークンで、どの送り方でもログインへ送られるまでリトライし、
//      最初に拒否された時刻を出す
//   --after-destroy 片付けのあと: このスクリプトとホストの Custom Domain、スクリプトが残っていないか（API）
// 判定: PASS は積極的な証拠があるときだけ（Access のログインへのリダイレクト・Cloudflare のエラー）。Worker の応答は FAIL。
//       判断できないもの（1010・5xx・ネットワークのエラーなど）は「記録」。FAIL が 1 つでもあれば終了コード 1。
// 出力にトークン・Cookie・Location・本文・ホスト・サブドメイン・アカウント ID・ゾーン ID を出さない（<host> などと書く）。
// 必要: AWSBRIDGE_HUMAN_POC_PORTAL_HOST、_ACCESS_TEAM_DOMAIN（B3・B4）、CLOUDFLARE_API_TOKEN と _CF_ACCOUNT_ID（B1 のサブドメインと
//       Version URL・B2・B4 の失効・--after-destroy）。トークンの権限は Workers Scripts Read（アカウント）と
//       Workers Routes Read（Custom Domain のゾーン）、B4 の失効には Access: Apps and Policies Revoke。
// オプション: --case B1,B2,B3,B4（既定 B1,B2,B3）--team <チーム>（既定 infra）--revoke | --revoked-at <ISO>
//            --interval <秒>（既定 10）--timeout <秒>（既定 300）--after-destroy
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { markdownTable } from "../cases";
import { fail, required } from "../io";
import {
  assertCustomHost,
  type Classified,
  classifyEdgeResponse,
  type Expectation,
  firstRejections,
  judge,
  judgeAfterDestroy,
  judgeRouting,
  latestVersionId,
  type ProbeSample,
  type RoutingRow,
  signForgedAccessJwt,
  tokenWindow,
  type Verdict,
  versionUrlHost,
} from "./bypass-lib";
import { loadSettings, localOverride, portalDir, repoRoot, terraformOutputJson } from "./io";
import { PORTAL_PREFIX, teamFromPath } from "./lib";
import { BASE_VARS } from "./settings";

const USER_AGENT = "awsbridge-poc-bypass-check/1.0";
const CASES = ["B1", "B2", "B3", "B4"] as const;
type CaseId = (typeof CASES)[number];

let values: {
  case?: string | undefined;
  team?: string | undefined;
  revoke?: boolean | undefined;
  "revoked-at"?: string | undefined;
  interval?: string | undefined;
  timeout?: string | undefined;
  "after-destroy"?: boolean | undefined;
};
try {
  values = parseArgs({
    options: {
      case: { type: "string" },
      team: { type: "string", default: "infra" },
      revoke: { type: "boolean", default: false },
      "revoked-at": { type: "string" },
      interval: { type: "string", default: "10" },
      timeout: { type: "string", default: "300" },
      "after-destroy": { type: "boolean", default: false },
    },
  }).values;
} catch (e) {
  fail((e as Error).message);
}

const cases = (values.case ?? "B1,B2,B3").split(",").map((c) => c.trim().toUpperCase());
for (const c of cases) if (!(CASES as readonly string[]).includes(c)) fail(`不正な --case: ${c}`);
const team = values.team ?? "infra";
if (teamFromPath(`/t/${team}`) !== team) fail(`不正なチーム名: '${team}'`);
const interval = Number(values.interval);
const timeout = Number(values.timeout);
if (!(interval > 0) || !(timeout > 0)) fail("--interval / --timeout は正の数");
if (values.revoke && values["revoked-at"] !== undefined)
  fail("--revoke と --revoked-at は同時に使えない");

const s = loadSettings();
const base = required(s.base, BASE_VARS);
let host: string;
try {
  host = assertCustomHost(new URL(base).host);
} catch (e) {
  fail((e as Error).message);
}
// テスト用の宛先の差し替え（127.0.0.1 / localhost だけ）
const portalBase = localOverride("AWSBRIDGE_HUMAN_POC_PORTAL_BYPASS_PORTAL_BASE") ?? base;
const workersDevOverride = localOverride("AWSBRIDGE_HUMAN_POC_PORTAL_BYPASS_WORKERS_DEV_BASE");
const apiBase =
  localOverride("AWSBRIDGE_HUMAN_POC_PORTAL_CF_API_BASE") ?? "https://api.cloudflare.com/client/v4";
const teamDomain = s.teamDomain ?? "";

// ---- Cloudflare API（読み取りだけ）----

const PERMISSION_HINT =
  "必要な権限（読み取りだけ）: アカウントの Workers Scripts Read（スクリプトの subdomain・Custom Domain・バージョン・アカウントのサブドメイン）と、" +
  "Custom Domain のゾーンの Workers Routes Read（ゾーンのルート）";

function account(): string {
  const a = required(
    process.env.AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID,
    "AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID",
  );
  if (!/^[A-Za-z0-9]+$/.test(a)) fail("AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID が不正です");
  return a;
}

async function cfGet(path: string): Promise<{ status: number; result: unknown }> {
  const token = required(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    fail(`Cloudflare API を呼べません（${(e as Error).name}）`);
  }
  const body = (await res.json().catch(() => ({}))) as { result?: unknown };
  return { status: res.status, result: body.result };
}

/** 200 以外で止まる。401・403 は権限不足として必要な権限を出す。label にアカウント ID などを入れない。 */
async function cfRead(path: string, label: string): Promise<unknown> {
  const r = await cfGet(path);
  if (r.status === 401 || r.status === 403)
    fail(
      `CLOUDFLARE_API_TOKEN の権限が足りません（${label}: HTTP ${r.status}）。${PERMISSION_HINT}`,
    );
  if (r.status !== 200)
    fail(`Cloudflare API の呼び出しが失敗しました（${label}: HTTP ${r.status}）`);
  return r.result;
}

const asList = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

const scriptPath = (a: string) => `/accounts/${a}/workers/scripts/${PORTAL_PREFIX}`;
const domainsBy = (a: string, key: "service" | "hostname", value: string) =>
  `/accounts/${a}/workers/domains?${key}=${encodeURIComponent(value)}`;

// ---- HTTP の確認 ----

interface ProbeRow {
  id: string;
  target: string;
  transport: string;
  c: Classified;
  expect: Expectation;
  verdict: Verdict;
  note?: string;
}

async function probe(url: string, init: RequestInit = {}): Promise<Classified> {
  const headers = new Headers(init.headers);
  headers.set("user-agent", USER_AGENT);
  try {
    const res = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return classifyEdgeResponse({
      status: res.status,
      headers: res.headers,
      body,
      teamDomain,
      portalHost: host,
    });
  } catch {
    return { kind: "network_error", status: 0 };
  }
}

const rows: ProbeRow[] = [];
const routingTables: { title: string; rows: RoutingRow[] }[] = [];
let failed = false;

function add(r: Omit<ProbeRow, "verdict"> & { verdict?: Verdict }): ProbeRow {
  const row = { ...r, verdict: r.verdict ?? judge(r.expect, r.c) };
  if (row.verdict === "FAIL") failed = true;
  rows.push(row);
  return row;
}

function teamAud(): string {
  let auds: Record<string, unknown> | undefined;
  try {
    auds = (
      JSON.parse(terraformOutputJson(s) || "{}") as {
        team_auds?: { value?: Record<string, unknown> };
      }
    ).team_auds?.value;
  } catch {}
  const aud = auds?.[team];
  if (typeof aud !== "string" || !/^[A-Za-z0-9]+$/.test(aud))
    fail(`Terraform の出力 team_auds に ${team} の AUD がありません（先に access-apply）`);
  return aud;
}

async function caseB1(): Promise<void> {
  let sub = s.workersDevSubdomain;
  if (sub === undefined) {
    const r = await cfGet(`/accounts/${account()}/workers/subdomain`);
    const v = (r.result as { subdomain?: unknown } | undefined)?.subdomain;
    if (r.status !== 200 || typeof v !== "string" || !/^[a-z0-9-]+$/.test(v))
      fail(
        `workers.dev のサブドメインを API で読めません（HTTP ${r.status}）。${PERMISSION_HINT}。` +
          "または AWSBRIDGE_HUMAN_POC_PORTAL_WORKERS_DEV_SUBDOMAIN を設定してください",
      );
    sub = v;
  }
  const url = (h: string, path: string) =>
    workersDevOverride ? `${workersDevOverride}${path}` : `https://${h}${path}`;
  const scriptHost = `${PORTAL_PREFIX}.${sub}.workers.dev`;
  for (const [id, path] of [
    ["B1-1", "/std/.well-known/jwks.json"],
    ["B1-2", `/t/${team}/whoami`],
  ] as const)
    add({
      id,
      target: `<workers.dev>${path}`,
      transport: "直接（Cookie なし）",
      c: await probe(url(scriptHost, path)),
      expect: "not_worker",
    });

  // Version URL（Preview URL）。最新のバージョンの URL に直接
  const v =
    process.env.AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN
      ? await cfGet(`${scriptPath(account())}/versions`)
      : { status: 0, result: undefined };
  const id = latestVersionId(
    asList((v.result as { items?: unknown } | undefined)?.items) as {
      id?: unknown;
      number?: unknown;
    }[],
  );
  if (v.status !== 200 || id === undefined) {
    add({
      id: "B1-3",
      target: "<version>-<workers.dev>（Version URL）",
      transport: "直接（Cookie なし）",
      c: { kind: "other", status: 0 },
      expect: "not_worker",
      verdict: "記録",
      note: `未実施（バージョンを読めない: HTTP ${v.status}）`,
    });
    return;
  }
  add({
    id: "B1-3",
    target: "<version>-<workers.dev>/std/.well-known/jwks.json（Version URL）",
    transport: "直接（Cookie なし）",
    c: await probe(url(versionUrlHost(id, PORTAL_PREFIX, sub), "/std/.well-known/jwks.json")),
    expect: "not_worker",
  });
}

async function caseB2(): Promise<void> {
  const a = account();
  const subdomain = (await cfRead(`${scriptPath(a)}/subdomain`, "スクリプトの subdomain")) as {
    enabled?: unknown;
    previews_enabled?: unknown;
  };
  const byService = asList(
    await cfRead(domainsBy(a, "service", PORTAL_PREFIX), "Custom Domain（service）"),
  );
  const byHost = asList(await cfRead(domainsBy(a, "hostname", host), "Custom Domain（hostname）"));
  const zones = [
    ...new Set(
      [...byService, ...byHost]
        .map((d) => d.zone_id)
        .filter((z): z is string => typeof z === "string" && /^[A-Za-z0-9]+$/.test(z)),
    ),
  ];
  const routes: Record<string, unknown>[] = [];
  for (const z of zones)
    routes.push(...asList(await cfRead(`/zones/${z}/workers/routes`, "ゾーンのルート")));
  const t = judgeRouting({
    host,
    script: PORTAL_PREFIX,
    subdomain: { enabled: subdomain?.enabled, previews_enabled: subdomain?.previews_enabled },
    domainsByService: byService,
    domainsByHost: byHost,
    routes,
  });
  if (t.some((r) => r.result === "FAIL")) failed = true;
  routingTables.push({
    title: `B2: API で読んだ入口（ゾーンのルートは Custom Domain のゾーン ${zones.length} つだけを見た）`,
    rows: t,
  });
}

async function caseB3(): Promise<void> {
  const td = required(s.teamDomain, "AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN");
  const forged = await signForgedAccessJwt({ teamDomain: td, aud: teamAud() });
  add({
    id: "B3-1",
    target: `<host>/t/${team}/whoami`,
    transport: "偽の Cf-Access-Jwt-Assertion（Cookie なし）",
    c: await probe(`${portalBase}/t/${team}/whoami`, {
      headers: { "cf-access-jwt-assertion": forged, accept: "application/json" },
    }),
    expect: "access_login",
  });
  add({
    id: "B3-2",
    target: `POST <host>/t/${team}/login`,
    transport: "偽の Cf-Access-Jwt-Assertion（Cookie なし）",
    c: await probe(`${portalBase}/t/${team}/login`, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": forged,
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "role=shared",
    }),
    expect: "access_login",
  });
}

const TRANSPORTS = [
  { key: "cookie", label: "Cookie（CF_Authorization）" },
  { key: "header", label: "ヘッダー Cf-Access-Jwt-Assertion" },
  { key: "token", label: "ヘッダー cf-access-token" },
] as const;

function transportHeaders(key: string, token: string): Record<string, string> {
  if (key === "cookie") return { cookie: `CF_Authorization=${token}` };
  if (key === "header") return { "cf-access-jwt-assertion": token };
  return { "cf-access-token": token };
}

let b4Summary: string | undefined;

async function caseB4(): Promise<void> {
  required(s.teamDomain, "AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN");
  let token: string;
  try {
    const mode = statSync(s.tokenFile).mode & 0o777;
    if (mode & 0o077)
      console.warn(
        `警告: トークンのファイルの権限が ${mode.toString(8)} です（600 にしてください）`,
      );
    token = readFileSync(s.tokenFile, "utf8").trim();
  } catch {
    fail(
      `Access JWT のファイルを読めません: AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE（${s.tokenFile}）。README の B4 の手順で poc-token から保存してください`,
    );
  }
  let w: ReturnType<typeof tokenWindow>;
  try {
    w = tokenWindow(token);
  } catch (e) {
    fail(`トークンのファイルの中身: ${(e as Error).message}`);
  }
  const left = w.exp - Math.floor(Date.now() / 1000);
  const need = timeout + 120;
  if (left < need)
    fail(
      `Access JWT の期限が足りません（残り ${left} 秒、必要 ${need} 秒 = --timeout + 120）。` +
        "期限切れで拒否されたのか失効で拒否されたのかを分けられないため、取り直してください",
    );
  let audMatch = "不明（Terraform の出力なし）";
  try {
    const auds = (
      JSON.parse(terraformOutputJson(s) || "{}") as {
        team_auds?: { value?: Record<string, unknown> };
      }
    ).team_auds?.value;
    const a = auds?.[team];
    if (typeof a === "string") audMatch = String(w.aud.includes(a));
  } catch {}
  console.error(
    `B4: トークンの残りの期限 ${left} 秒、aud が ${team} のアプリと一致: ${audMatch}（値は出さない）`,
  );

  const target = `${portalBase}/t/${team}/whoami`;
  const probeAll = async () =>
    Promise.all(
      TRANSPORTS.map(async (t) => ({
        t,
        c: await probe(target, {
          headers: { ...transportHeaders(t.key, token), accept: "application/json" },
        }),
      })),
    );

  let revokedAt: Date | undefined;
  const before = new Map<string, Classified>();
  if (values["revoked-at"] !== undefined) {
    revokedAt = new Date(values["revoked-at"]);
    if (Number.isNaN(revokedAt.getTime())) fail("--revoked-at は ISO 8601 の時刻");
  } else {
    // (b) 失効前: Cookie で通ること（通らなければ失効の効果を測れないので止まる）。ヘッダーは記録
    let i = 1;
    for (const { t, c } of await probeAll()) {
      before.set(t.key, c);
      add({
        id: `B4-${i++}`,
        target: `<host>/t/${team}/whoami（失効前）`,
        transport: t.label,
        c,
        expect: t.key === "cookie" ? "worker_ok" : "record",
      });
    }
    if (rows.some((r) => r.id === "B4-1" && r.verdict !== "PASS")) {
      printReport();
      fail(
        "失効前に Cookie で通らないため、失効させずに止めます（トークンを取り直すか、ログインし直す）",
      );
    }
    if (!values.revoke) {
      b4Summary =
        "失効と失効後の確認は未実施（--revoke で access-revoke を呼ぶ。ダッシュボードで失効させたなら --revoked-at <時刻>）";
      return;
    }
    // (c) access-revoke.ts で infra のアプリのトークンを失効させる（ガードはそちらに任せる）
    const app = `${PORTAL_PREFIX}-${team}`;
    const r = spawnSync(
      join(repoRoot, "node_modules/.bin/tsx"),
      [join(portalDir, "access-revoke.ts"), "--app", app],
      { cwd: repoRoot, env: process.env, encoding: "utf8", timeout: 120_000 },
    );
    if (r.status !== 0)
      fail(`access-revoke が失敗しました（終了コード ${r.status}）: ${(r.stderr ?? "").trim()}`);
    const done = /完了: (\S+Z)/.exec(r.stdout ?? "")?.[1];
    revokedAt = done ? new Date(done) : new Date();
    console.error(`B4: 失効の完了 ${revokedAt.toISOString()}（アプリ ${app}）`);
  }

  // (d) 失効後: どの送り方でも Access のログインへ送られるまでリトライする（判断できない応答では止まらない）
  const samples: ProbeSample[] = [];
  const last = new Map<string, Classified>();
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const at = new Date().toISOString();
    for (const { t, c } of await probeAll()) {
      samples.push({
        at,
        transport: t.key,
        kind: c.kind,
        rejected: c.kind === "access_login_redirect",
      });
      last.set(t.key, c);
      console.error(`${at} ${t.key} ${c.kind}${c.cfCode ? ` ${c.cfCode}` : ""} HTTP ${c.status}`);
    }
    const allRejected = TRANSPORTS.every((t) => last.get(t.key)?.kind === "access_login_redirect");
    if (allRejected || Date.now() + interval * 1000 > deadline) break;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
  const fr = firstRejections(samples, revokedAt);
  const summaryRows = TRANSPORTS.map((t) => {
    const f = fr.find((x) => x.transport === t.key);
    const c = last.get(t.key) as Classified;
    const verdict: Verdict = judge("worker_ok", c) === "PASS" ? "FAIL" : judge("access_login", c);
    if (verdict === "FAIL") failed = true;
    return [
      t.label,
      before.get(t.key)?.kind ?? "-",
      f?.firstRejectedAt ?? "-",
      f?.seconds === undefined ? "-" : String(f.seconds),
      f?.lastKind ?? "-",
      verdict,
    ];
  });
  b4Summary = [
    `B4: 失効後（失効の完了 ${revokedAt.toISOString()}、${interval} 秒おき、最大 ${timeout} 秒）`,
    markdownTable(
      ["送り方", "失効前", "最初に拒否された時刻（UTC）", "失効から（秒）", "最後の分類", "判定"],
      summaryRows,
    ),
  ].join("\n");
}

async function afterDestroy(): Promise<void> {
  const a = account();
  const byService = asList(
    await cfRead(domainsBy(a, "service", PORTAL_PREFIX), "Custom Domain（service）"),
  );
  const byHost = asList(await cfRead(domainsBy(a, "hostname", host), "Custom Domain（hostname）"));
  const sub = await cfGet(`${scriptPath(a)}/subdomain`);
  if (sub.status === 401 || sub.status === 403)
    fail(
      `CLOUDFLARE_API_TOKEN の権限が足りません（スクリプトの subdomain: HTTP ${sub.status}）。${PERMISSION_HINT}`,
    );
  const t = judgeAfterDestroy({
    domainsByService: byService,
    domainsByHost: byHost,
    scriptStatus: sub.status,
  });
  if (t.some((r) => r.result === "FAIL")) failed = true;
  routingTables.push({ title: "片付けのあと（API）", rows: t });
}

function printReport(): void {
  console.log(
    `bypass-check（${new Date().toISOString()}）。<host> = AWSBRIDGE_HUMAN_POC_PORTAL_HOST、<workers.dev> = ${PORTAL_PREFIX}.<アカウントのサブドメイン>.workers.dev`,
  );
  if (rows.length > 0) {
    console.log("");
    console.log(
      markdownTable(
        ["ID", "対象", "送り方", "HTTP", "分類", "CF コード", "期待", "判定"],
        rows.map((r) => [
          r.id,
          r.target,
          r.transport,
          r.c.status === 0 ? "-" : String(r.c.status),
          r.note ?? r.c.kind,
          r.c.cfCode ?? "-",
          r.expect,
          r.verdict,
        ]),
      ),
    );
  }
  for (const t of routingTables) {
    console.log("");
    console.log(t.title);
    console.log(
      markdownTable(
        ["項目", "期待", "実際", "判定"],
        t.rows.map((r) => [r.item, r.expected, r.actual, r.result]),
      ),
    );
  }
  if (b4Summary) {
    console.log("");
    console.log(b4Summary);
  }
}

if (values["after-destroy"]) {
  await afterDestroy();
} else {
  const run: Record<CaseId, () => Promise<void>> = {
    B1: caseB1,
    B2: caseB2,
    B3: caseB3,
    B4: caseB4,
  };
  for (const c of CASES) if (cases.includes(c)) await run[c]();
}
printReport();
process.exit(failed ? 1 : 0);
