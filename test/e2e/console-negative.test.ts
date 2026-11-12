// コンソールログインの負の試験（Standard・Admin の Worker を wrangler dev で起動し、実プロセスに HTTP を送る）。
// 擬似の Access（certs）・STS・getSigninToken を相手にし、どのケースでも「STS も getSigninToken も呼ばれない」ことを
// 擬似サーバーの受信数で確かめる（afterEach）。ケースの一覧は describe と it の名前がそのまま一覧になる:
//
//   1. 陽性の対照            同じ道具で正しい要求を送ると発行の段まで進む（Standard は 302、Admin は鍵があれば 302・無ければ 9 段目の 503）。
//                            受信数の確認が空振りしていない証拠。Admin の負の試験は鍵のある Worker に送る（断られなければ 302 になる）
//   2. 両階層に共通           Access JWT（偽・別のチームドメイン・期限切れ・aud の形・入口の AUD・チームの食い違い・大きさの上限）、Origin・Sec-Fetch-Site・
//                             Content-Type、CSRF（別チーム・期限切れ・改ざん・別の利用者）、行（entry）、本文の大きさ、GET・HEAD・OPTIONS・PUT など
//   3. Standard 固有          Admin の行（not_listed）、Admin の AUD、issuer のホストからポータルの経路に届かない、チーム以外のパス、
//                            鍵が vars の公開鍵と合わなければ 503・鍵が無ければ 500、デプロイ後の確認（key-check）は Access の検証の後ろ
//   4. Admin 固有             チームのパス以外は 404（処理の最初。JWT・入口の AUD によらない）、Standard の AUD は 403、
//                            issuer の文書は Admin の issuer のホストの 2 つのパスだけ、Access JWT の iat が古ければ 401、
//                            鍵が vars の公開鍵と合わなければ 503、デプロイ後の確認（key-check）は Access の検証の後ろ
//   5. 停止スイッチ           両階層（LOGIN_DISABLED=true）
//   6. Access アプリの無いチーム  AUD が設定にないチームのパスは必ず断る（JWT 無しは 401、ほかは 403）
//   7. secret が壊れている    CSRF の鍵が短いとき、発行しない（500 server_misconfigured）。Admin はチームのパス以外を env を読む前に 404
//
// 設計: docs/specs/console-login-portal.md §9.3・§9.4・§10、cto の G-6（Admin はチームのパス以外を 404、入口の AUD は発行に受けない）。
// 設定はリポジトリの wrangler.console-{standard,admin}.jsonc を読み、main を E2E 用のエントリ（fixtures/。外向きの通信だけを擬似に向ける）にし、
// routes を外し（手元では Host ヘッダーで振り分ける）、alias を試験用の生成物に、vars に鍵と擬似の宛先を足した一時ファイルで起動する。
// 試験用の生成物は、会社用の fixture の生成物にチーム noapp（Access アプリが無い。aud なし）を足したもの。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_JWT_MAX_LENGTH } from "../../src/console/issue/access";
import { createCsrfToken, importCsrfKey } from "../../src/console/issue/csrf";
import { MAX_BODY_BYTES } from "../../src/console/portal/login";
import type { WorkerConfig } from "../../src/console/types";
import {
  ADMIN_ENTRY,
  ADMIN_HOST,
  ADMIN_ISSUER_HOST,
  ADMIN_PORTAL,
  AUDS,
  adminConfig,
  displayConfig,
  ENTRY,
  ISSUER_HOST,
  PORTAL,
  PORTAL_HOST,
  standardConfig,
  stsXml,
} from "../unit/console-standard-harness";
import {
  type FakeServer,
  type HttpResult,
  type Instance,
  root,
  send,
  startFakeServer,
  startWrangler,
  stopWrangler,
} from "./console-e2e-kit";
import { readJsonc } from "./jsonc";

const TEAM_DOMAIN = "https://e2e-team.cloudflareaccess.com";
const OTHER_TEAM_DOMAIN = "https://other-team.cloudflareaccess.com";
const EMAIL = "user@example.com";
const SUB = "e2e00000-0000-4000-8000-0000000000aa";
const OTHER_SUB = "e2e00000-0000-4000-8000-0000000000bb";
const NOAPP = "noapp";
/** Access アプリが無いチームの、設定にない AUD（形だけ正しい。どのチームにも対応しない）。 */
const UNKNOWN_AUD = `unknownaud${"9".repeat(40)}`;
// 鍵・トークンの形の文字列は実行時に組む（gitleaks の誤検知を避ける）
const CSRF_SECRET = ["e2e", "csrf", "n".repeat(40)].join("-");
const ACCESS_KEY_ID = ["ASIA", "N".repeat(16)].join("");
const SIGNIN_TOKEN = ["signin", "n".repeat(24)].join("-");

let std: Instance;
let stdStopped: Instance;
let admin: Instance;
let adminNoKey: Instance;
let adminMismatch: Instance;
let adminStopped: Instance;
let stdBroken: Instance;
let stdMismatch: Instance;
let stdNoKey: Instance;
let adminBroken: Instance;
// Access JWT の大きさの上限の試験の送り先（大きなヘッダーの要求を、ほかの試験と同じ wrangler dev に通さない。
// 同じインスタンスに通すと、あとの「Content-Length つきの大きな本文」の試験が wrangler dev のプロキシの 503 で揺れた）
let stdBig: Instance;
let adminBig: Instance;
let fake: FakeServer;
let tmp = "";
let accessKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let attackerKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let csrfKey: CryptoKey;
const csrfs = new Map<string, string>();

// ---- Access JWT ----

type JwtOptions = {
  /** iat を今より何秒前にするか（既定 0）。 */
  iatAgo?: number;
  aud?: string | string[] | null;
  iss?: string;
  sub?: string;
  type?: string;
  /** 有効期限までの秒数（負なら期限切れ）。 */
  expIn?: number;
  kid?: string;
  /** 署名に使う鍵（既定は擬似の Access の鍵）。 */
  key?: CryptoKey;
  extra?: Record<string, unknown>;
};

async function accessJwt(aud: string | string[] | null, o: JwtOptions = {}): Promise<string> {
  const jwt = new SignJWT({ email: EMAIL, type: o.type ?? "app", ...(o.extra ?? {}) })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "e2e-access" })
    .setIssuer(o.iss ?? TEAM_DOMAIN)
    .setSubject(o.sub ?? SUB)
    .setIssuedAt(Math.floor(Date.now() / 1000) - (o.iatAgo ?? 0))
    .setExpirationTime(Math.floor(Date.now() / 1000) + (o.expIn ?? 600));
  if (aud !== null) jwt.setAudience(aud);
  return jwt.sign(o.key ?? accessKeys.privateKey);
}

/** 大きさの上限の試験の送り先（その階層の、ほかの試験と分けたインスタンス）。 */
const bigOf = (t: Target): Instance => (t === stdT ? stdBig : adminBig);

/** 正しく署名した JWT を、余分な claim で長さ length 前後まで水増しする（base64url で 4/3 倍になる）。 */
async function paddedJwt(aud: string, length: number): Promise<string> {
  const base = await accessJwt(aud);
  const pad = Math.max(0, Math.floor(((length - base.length) * 3) / 4));
  return accessJwt(aud, { extra: { pad: "x".repeat(pad) } });
}

const b64url = (v: string) => Buffer.from(v).toString("base64url");

/** alg=none の署名なしトークン。 */
function unsignedJwt(aud: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: TEAM_DOMAIN,
    aud,
    sub: SUB,
    email: EMAIL,
    type: "app",
    iat: now,
    exp: now + 600,
  };
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.`;
}

/** 擬似の Access の公開鍵を HMAC の鍵に見立てた HS256（alg のすり替え）。 */
async function hs256Jwt(aud: string): Promise<string> {
  return new SignJWT({ email: EMAIL, type: "app" })
    .setProtectedHeader({ alg: "HS256", kid: "e2e-access" })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(aud)
    .setSubject(SUB)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode("x".repeat(48)));
}

// ---- 階層ごとの対象 ----

type Target = {
  label: string;
  inst: () => Instance;
  stopped: () => Instance;
  host: string;
  origin: string;
  /** もう一方の階層のポータルのオリジン。 */
  otherOrigin: string;
  team: string;
  aud: string;
  /** 同じ階層の別のチーム（AUD あり）。 */
  peerTeam: string;
  peerAud: string;
  /** この階層の正しい行。 */
  entry: string;
  /** この階層のチームの行として存在しない entry（もう一方の階層の行・他チームの行）。 */
  foreignRows: [string, string][];
  /** 入口のアプリの AUD（この階層のもの・もう一方のもの）。発行には受けない。 */
  entryAuds: [string, string][];
  /** もう一方の階層のチームの AUD。 */
  otherTierAuds: [string, string][];
  s2: string;
};

const stdT: Target = {
  label: "Standard",
  inst: () => std,
  stopped: () => stdStopped,
  host: PORTAL_HOST,
  origin: PORTAL,
  otherOrigin: ADMIN_PORTAL,
  team: "infra",
  aud: AUDS.teams.infra as string,
  peerTeam: "dev",
  peerAud: AUDS.teams.dev as string,
  entry: ENTRY,
  foreignRows: [
    ["Admin の行（333333333333:admin）", ADMIN_ENTRY],
    ["他チームの行（dev の 444444444444:developer）", "444444444444:developer"],
  ],
  entryAuds: [
    ["Standard の入口の AUD", AUDS.entry.standard],
    ["Admin の入口の AUD", AUDS.entry.admin],
  ],
  otherTierAuds: [
    ["Admin のチーム（infra-elevated）の AUD", AUDS.teams["infra-elevated"] as string],
    ["Admin のチーム（dev-elevated）の AUD", AUDS.teams["dev-elevated"] as string],
  ],
  s2: "/t/infra/a/333333333333",
};

const adminT: Target = {
  label: "Admin",
  inst: () => admin,
  stopped: () => adminStopped,
  host: ADMIN_HOST,
  origin: ADMIN_PORTAL,
  otherOrigin: PORTAL,
  team: "infra-elevated",
  aud: AUDS.teams["infra-elevated"] as string,
  peerTeam: "dev-elevated",
  peerAud: AUDS.teams["dev-elevated"] as string,
  entry: ADMIN_ENTRY,
  foreignRows: [
    ["Standard の行（333333333333:readonly）", ENTRY],
    ["他階層の他チームの行（444444444444:developer）", "444444444444:developer"],
  ],
  entryAuds: [
    ["Admin の入口の AUD", AUDS.entry.admin],
    ["Standard の入口の AUD", AUDS.entry.standard],
  ],
  otherTierAuds: [
    ["Standard のチーム（infra）の AUD", AUDS.teams.infra as string],
    ["Standard のチーム（dev）の AUD", AUDS.teams.dev as string],
  ],
  s2: "/t/infra-elevated/a/333333333333",
};

const teamBase = (team: string) => `/t/${team}`;

type PostOptions = {
  jwt?: string | null;
  origin?: string | null;
  host?: string;
  path?: string;
  method?: string;
  contentType?: string | null;
  secFetchSite?: string;
  entry?: string | null;
  csrf?: string | null;
  /** フォームの項目を直接指定する（重ねて送る試験用）。 */
  fields?: [string, string][];
  /** 本文をそのまま送る。 */
  rawBody?: string;
  headers?: Record<string, string>;
  inst?: Instance;
};

/** POST /t/<team>/login。既定は正しい要求（JWT・Origin・Content-Type・CSRF・行）で、上書きした項目だけを崩す。 */
function post(t: Target, o: PostOptions = {}): Promise<HttpResult> {
  const fields: [string, string][] = o.fields ?? [
    ...(o.entry === null ? [] : [["entry", o.entry ?? t.entry] as [string, string]]),
    ["region", "ap-northeast-1"],
    ...(o.csrf === null ? [] : [["csrf", o.csrf ?? csrfs.get(t.team) ?? ""] as [string, string]]),
  ];
  return (async () => {
    const jwt = o.jwt === undefined ? await accessJwt(t.aud) : o.jwt;
    const headers: Record<string, string> = {
      ...(jwt === null ? {} : { "Cf-Access-Jwt-Assertion": jwt }),
      ...(o.contentType === null
        ? {}
        : { "Content-Type": o.contentType ?? "application/x-www-form-urlencoded" }),
      ...(o.origin === null ? {} : { Origin: o.origin ?? t.origin }),
      ...(o.secFetchSite === undefined ? {} : { "Sec-Fetch-Site": o.secFetchSite }),
      ...(o.headers ?? {}),
    };
    return send(o.inst ?? t.inst(), {
      method: o.method ?? "POST",
      host: o.host ?? t.host,
      path: o.path ?? `${teamBase(t.team)}/login`,
      headers,
      body: o.rawBody ?? new URLSearchParams(fields).toString(),
    });
  })();
}

/** 画面などの GET（JWT は既定で付けない）。 */
function get(
  t: Target,
  path: string,
  o: { jwt?: string | null; method?: string; host?: string; inst?: Instance } = {},
): Promise<HttpResult> {
  return send(o.inst ?? t.inst(), {
    method: o.method ?? "GET",
    host: o.host ?? t.host,
    path,
    headers: o.jwt ? { "Cf-Access-Jwt-Assertion": o.jwt } : {},
  });
}

/** 断られた応答の共通の確認: 状態・エラーコード・リダイレクトしない・キャッシュしない。 */
function denied(r: HttpResult, status: number, code: string) {
  expect(r.status, r.body).toBe(status);
  expect(r.body).toContain(code);
  expect(r.headers.location).toBeUndefined();
  expect(r.headers["cache-control"]).toBe("no-store");
}

/** S2 を開いて CSRF トークンを取り出す。 */
async function csrfFrom(t: Target, team: string, aud: string): Promise<string> {
  const r = await send(t.inst(), {
    host: t.host,
    path: `${teamBase(team)}/a/333333333333`,
    headers: { "Cf-Access-Jwt-Assertion": await accessJwt(aud) },
  });
  expect(r.status, r.body).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1];
  expect(csrf).toBeDefined();
  return csrf as string;
}

// ---- 起動 ----

function withNoappTeam(c: WorkerConfig): WorkerConfig {
  return { ...c, teams: [...c.teams, { name: NOAPP, displayName: "アプリなし" }] };
}

beforeAll(async () => {
  accessKeys = await generateKeyPair("RS256", { extractable: true });
  attackerKeys = await generateKeyPair("RS256", { extractable: true });
  const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "e2e-access", alg: "RS256" };
  csrfKey = await importCsrfKey(CSRF_SECRET);
  fake = await startFakeServer({
    accessJwk,
    stsBody: stsXml(ACCESS_KEY_ID),
    signinToken: SIGNIN_TOKEN,
  });

  tmp = mkdtempSync(join(tmpdir(), "awsbridge-console-negative-e2e-"));
  const write = (name: string, v: unknown) => {
    const p = join(tmp, name);
    writeFileSync(p, JSON.stringify(v));
    return p;
  };
  const stdJson = write("worker.standard.json", withNoappTeam(standardConfig()));
  const displayJson = write("display.standard.json", displayConfig());
  const adminJson = write("worker.admin.json", withNoappTeam(adminConfig()));

  const wranglerConfig = (kind: "standard" | "admin", entry = `console-${kind}-entry.ts`) => {
    const config = readJsonc(join(root, `wrangler.console-${kind}.jsonc`));
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    delete config.routes; // 手元では Host ヘッダーで振り分ける（routes があると wrangler dev が Host を書き換える）
    const ratelimits = (config.ratelimits as { simple: { limit: number } }[]).map((r) => ({
      ...r,
      simple: { ...r.simple, limit: 100000 },
    }));
    return write(`wrangler.${kind}.${entry}.json`, {
      ...config,
      $schema: undefined,
      main: join(root, `test/e2e/fixtures/${entry}`),
      alias:
        kind === "standard"
          ? { "awsbridge:console-worker": stdJson, "awsbridge:console-display": displayJson }
          : { "awsbridge:console-worker-admin": adminJson },
      ratelimits,
      vars: {
        ...(config.vars as Record<string, string>),
        ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
        // 署名鍵は E2E 用のエントリが Worker の中で作る（Standard は境界ごと、Admin は鍵ありのエントリだけ。どちらも取り出せない CryptoKey）
        CONSOLE_CSRF_KEY: CSRF_SECRET,
        E2E_FAKE_BASE: fake.base,
      },
    });
  };
  const stdConfig = wranglerConfig("standard");
  const adminConfigPath = wranglerConfig("admin");
  const adminKeyConfigPath = wranglerConfig("admin", "console-admin-key-entry.ts");
  const stdReady = async (i: Instance) =>
    (await send(i, { host: ISSUER_HOST, path: "/standard/.well-known/jwks.json" })).status === 200;
  const adminReady = async (i: Instance) =>
    // Access の JWT が無いチームのパスは 401（Worker が応答している印）
    (await send(i, { host: ADMIN_HOST, path: "/t/infra-elevated/" })).status === 401;
  [
    std,
    stdStopped,
    admin,
    adminNoKey,
    adminMismatch,
    adminStopped,
    stdBroken,
    adminBroken,
    stdMismatch,
    stdNoKey,
    stdBig,
    adminBig,
  ] = await Promise.all([
    startWrangler({ name: "std", configPath: stdConfig, stateDir: tmp, ready: stdReady }),
    startWrangler({
      name: "std-stopped",
      configPath: stdConfig,
      stateDir: tmp,
      vars: { LOGIN_DISABLED: "true" },
      ready: stdReady,
    }),
    // 鍵あり（Admin の負の試験の送り先）・鍵なし（503 の対照）・鍵と公開鍵が合わない
    startWrangler({
      name: "admin",
      configPath: adminKeyConfigPath,
      stateDir: tmp,
      ready: adminReady,
    }),
    startWrangler({
      name: "admin-nokey",
      configPath: adminConfigPath,
      stateDir: tmp,
      ready: adminReady,
    }),
    startWrangler({
      name: "admin-mismatch",
      configPath: adminKeyConfigPath,
      stateDir: tmp,
      vars: { E2E_KEY_MODE: "mismatch" },
      ready: adminReady,
    }),
    startWrangler({
      name: "admin-stopped",
      configPath: adminConfigPath,
      stateDir: tmp,
      vars: { LOGIN_DISABLED: "true" },
      ready: adminReady,
    }),
    // CSRF の鍵が短い（secret が壊れている）。どの経路も 500 になる印で起動を待つ
    startWrangler({
      name: "std-broken",
      configPath: stdConfig,
      stateDir: tmp,
      vars: { CONSOLE_CSRF_KEY: "short" },
      ready: async (i) =>
        (await send(i, { host: ISSUER_HOST, path: "/standard/.well-known/jwks.json" })).status ===
        500,
    }),
    startWrangler({
      name: "admin-broken",
      configPath: adminConfigPath,
      stateDir: tmp,
      vars: { CONSOLE_CSRF_KEY: "short" },
      ready: async (i) =>
        (await send(i, { host: ADMIN_HOST, path: "/t/infra-elevated/" })).status === 500,
    }),
    // Standard: managed のバインディングの鍵が公開鍵と合わない（鍵だけ替えて vars を替え忘れた）
    startWrangler({
      name: "std-mismatch",
      configPath: stdConfig,
      stateDir: tmp,
      vars: { E2E_KEY_MODE: "mismatch" },
      ready: stdReady,
    }),
    // Standard: 鍵の vars もバインディングも無い（鍵の投入前）。どの経路も 500 になる印で起動を待つ
    startWrangler({
      name: "std-nokey",
      configPath: stdConfig,
      stateDir: tmp,
      vars: { E2E_KEY_MODE: "none" },
      ready: async (i) =>
        (await send(i, { host: ISSUER_HOST, path: "/standard/.well-known/jwks.json" })).status ===
        500,
    }),
    startWrangler({ name: "std-big", configPath: stdConfig, stateDir: tmp, ready: stdReady }),
    startWrangler({
      name: "admin-big",
      configPath: adminKeyConfigPath,
      stateDir: tmp,
      ready: adminReady,
    }),
  ]);

  // 正しい CSRF トークン（画面から取る。同じ利用者・10 分の有効期限の中で使い回す）
  for (const t of [stdT, adminT]) {
    csrfs.set(t.team, await csrfFrom(t, t.team, t.aud));
    // 同じ階層の別のチームのページの CSRF（そのチームの AUD に束縛。同じ利用者・同じ鍵）
    csrfs.set(t.peerTeam, await createCsrfToken(csrfKey, { aud: t.peerAud, sub: SUB }));
  }
}, 120_000);

afterAll(() => {
  for (const i of [
    std,
    stdStopped,
    admin,
    adminNoKey,
    adminMismatch,
    adminStopped,
    stdBroken,
    adminBroken,
    stdMismatch,
    stdNoKey,
    stdBig,
    adminBig,
  ])
    stopWrangler(i);
  fake?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fake.reset();
});

/** どのケースでも STS も getSigninToken も呼ばれない。 */
const noIssue = () => {
  expect(fake.seen.sts, "STS が呼ばれた").toHaveLength(0);
  expect(fake.seen.signin, "getSigninToken が呼ばれた").toHaveLength(0);
};

// ---- 1. 陽性の対照 ----

describe("陽性の対照（同じ道具で正しい要求を送ると、発行の段まで進む。以降の負の試験の確認が空振りしていない証拠）", () => {
  it("Standard: 正しい POST は 302 で、STS と getSigninToken が 1 回ずつ呼ばれる", async () => {
    const r = await post(stdT);
    expect(r.status, r.body).toBe(302);
    expect(String(r.headers.location)).toContain("https://signin.aws.amazon.com/federation");
    expect(fake.seen.sts).toHaveLength(1);
    expect(fake.seen.signin).toHaveLength(1);
  });

  it("Admin（鍵あり）: 正しい POST は 302 で、STS と getSigninToken が 1 回ずつ呼ばれる（Admin の負の試験の送り先）", async () => {
    const r = await post(adminT);
    expect(r.status, r.body).toBe(302);
    expect(String(r.headers.location)).toContain("https://signin.aws.amazon.com/federation");
    expect(fake.seen.sts).toHaveLength(1);
    expect(fake.seen.signin).toHaveLength(1);
  });

  it("Admin（鍵なし）: 正しい POST は 9 段目の 503 signing_unavailable まで進む（STS は呼ばない）", async () => {
    const r = await post(adminT, { inst: adminNoKey });
    denied(r, 503, "signing_unavailable");
    noIssue();
  });

  it("両階層: 大きさの上限の内側の、正しく署名した大きな JWT なら 302 まで進む（上限の試験が手前で断られていない証拠）", async () => {
    for (const t of [stdT, adminT]) {
      fake.reset();
      const jwt = await paddedJwt(t.aud, ACCESS_JWT_MAX_LENGTH - 200);
      expect(jwt.length).toBeLessThanOrEqual(ACCESS_JWT_MAX_LENGTH);
      expect(jwt.length).toBeGreaterThan(ACCESS_JWT_MAX_LENGTH - 400);
      const r = await post(t, { jwt, inst: bigOf(t) });
      expect(r.status, `${t.label}: ${r.body}`).toBe(302);
      expect(fake.seen.sts).toHaveLength(1);
    }
  });

  it("両階層: 擬似の Access の certs を実際に取りにきている（JWT の検証まで進む）", () => {
    expect(fake.certsHits()).toBeGreaterThan(0);
  });
});

// ---- 2. 両階層に共通 ----

describe.each([stdT, adminT])("$label の Worker: 負の試験（両階層に共通）", (t) => {
  afterEach(noIssue);

  describe("Access JWT", () => {
    const cases: [string, () => Promise<string | null>, number, string][] = [
      ["JWT が無い", async () => null, 401, "unauthorized"],
      [
        "JWT の形でない文字列（偽の Cf-Access-Jwt-Assertion）",
        async () => "not-a-jwt",
        401,
        "unauthorized",
      ],
      [
        "別の鍵で署名した偽の JWT（kid・iss・aud・exp は正しい）",
        () => accessJwt(t.aud, { key: attackerKeys.privateKey }),
        401,
        "unauthorized",
      ],
      [
        "kid が擬似の Access の鍵にない JWT",
        () => accessJwt(t.aud, { kid: "unknown-kid" }),
        401,
        "unauthorized",
      ],
      ["alg=none の署名なしの JWT", async () => unsignedJwt(t.aud), 401, "unauthorized"],
      ["alg を HS256 にすり替えた JWT", () => hs256Jwt(t.aud), 401, "unauthorized"],
      [
        "別のチームドメインが発行した JWT（iss が違う。署名・aud は正しい）",
        () => accessJwt(t.aud, { iss: OTHER_TEAM_DOMAIN }),
        401,
        "unauthorized",
      ],
      [
        "期限切れの JWT（許容の 30 秒を超えて過ぎている）",
        () => accessJwt(t.aud, { expIn: -120 }),
        401,
        "unauthorized",
      ],
      [
        "アプリのトークンでない JWT（type が org）",
        () => accessJwt(t.aud, { type: "org" }),
        401,
        "unauthorized",
      ],
      [
        "サービストークンの JWT（common_name があり sub が空）",
        () => accessJwt(t.aud, { sub: "", extra: { common_name: "e2e-client-id" } }),
        401,
        "unauthorized",
      ],
      [
        "aud が配列で 2 つ（既知のチーム 2 つ）",
        () => accessJwt([t.aud, t.peerAud]),
        403,
        "unknown_audience",
      ],
      [
        "aud が配列で 2 つ（既知と未知）",
        () => accessJwt([t.aud, UNKNOWN_AUD]),
        403,
        "unknown_audience",
      ],
      [
        "aud が配列で重複（同じ値が 2 つ）",
        () => accessJwt([t.aud, t.aud]),
        403,
        "unknown_audience",
      ],
      ["aud が空の配列", () => accessJwt([]), 403, "unknown_audience"],
      ["aud が無い", () => accessJwt(null), 403, "unknown_audience"],
      ["aud が空文字", () => accessJwt(""), 403, "unknown_audience"],
      ["aud が未知の値", () => accessJwt(UNKNOWN_AUD), 403, "unknown_audience"],
      ...t.entryAuds.map(
        ([name, aud]) =>
          [
            `${name}での POST（入口の AUD は発行に受けない）`,
            () => accessJwt(aud),
            403,
            "unknown_audience",
          ] as [string, () => Promise<string | null>, number, string],
      ),
      ...t.otherTierAuds.map(
        ([name, aud]) =>
          [`もう一方の階層の ${name}`, () => accessJwt(aud), 403, "unknown_audience"] as [
            string,
            () => Promise<string | null>,
            number,
            string,
          ],
      ),
    ];
    for (const [name, make, status, code] of cases) {
      it(`${name} → ${status} ${code}`, async () => {
        denied(await post(t, { jwt: await make() }), status, code);
      });
    }

    it(`大きさの上限（${ACCESS_JWT_MAX_LENGTH} 文字）を超える、正しく署名した JWT → 401 unauthorized（POST も画面も）`, async () => {
      const big = await paddedJwt(t.aud, ACCESS_JWT_MAX_LENGTH + 100);
      expect(big.length).toBeGreaterThan(ACCESS_JWT_MAX_LENGTH);
      denied(await post(t, { jwt: big, inst: bigOf(t) }), 401, "unauthorized");
      expect((await get(t, `${teamBase(t.team)}/`, { jwt: big, inst: bigOf(t) })).status).toBe(401);
    });

    it("チームの食い違い: 別のチームのパスに自分のチームの JWT を送ると 403 team_mismatch（そのチームの CSRF でも）", async () => {
      denied(
        await post(t, {
          path: `${teamBase(t.peerTeam)}/login`,
          csrf: csrfs.get(t.peerTeam) ?? "",
        }),
        403,
        "team_mismatch",
      );
    });
  });

  describe("Origin・Sec-Fetch-Site・Content-Type（本文を読む前に断る）", () => {
    const origins: [string, string | null][] = [
      ["Origin が無い", null],
      ['Origin が "null"（sandbox の iframe・リダイレクトの経由）', "null"],
      ["Origin が別のオリジン（攻撃者のサイト）", "https://evil.example.com"],
      ["Origin が もう一方の階層のオリジン", t.otherOrigin],
      ["Origin の末尾にスラッシュ", `${t.origin}/`],
      ["Origin が空", ""],
    ];
    for (const [name, origin] of origins) {
      it(`${name} → 403 forbidden_origin`, async () => {
        const r =
          origin === ""
            ? await post(t, { origin: null, headers: { Origin: "" } })
            : await post(t, { origin });
        denied(r, 403, "forbidden_origin");
      });
    }

    for (const site of ["cross-site", "same-site", "none"]) {
      it(`Sec-Fetch-Site が ${site}（Origin は正しい）→ 403 forbidden_origin`, async () => {
        denied(await post(t, { secFetchSite: site }), 403, "forbidden_origin");
      });
    }

    for (const [name, contentType] of [
      ["text/plain", "text/plain"],
      ["application/json", "application/json"],
      ["multipart/form-data", "multipart/form-data; boundary=x"],
      ["Content-Type が無い", null],
    ] as const) {
      it(`${name} → 415 unsupported_media_type`, async () => {
        denied(await post(t, { contentType }), 415, "unsupported_media_type");
      });
    }
  });

  describe("CSRF", () => {
    const mint = (aud: string, sub: string, now: number) =>
      createCsrfToken(csrfKey, { aud, sub }, now);
    const nowSec = () => Math.floor(Date.now() / 1000);
    const cases: [string, () => Promise<string | null>][] = [
      ["CSRF が無い", async () => null],
      ["CSRF が空", async () => ""],
      ["CSRF の形でない文字列", async () => "not-a-token"],
      [
        "同じ階層の別のチームのページの CSRF（aud が違う）",
        async () => csrfs.get(t.peerTeam) ?? "",
      ],
      ["期限切れの CSRF（発行から 11 分）", () => mint(t.aud, SUB, nowSec() - 660)],
      ["未来の時刻で発行された CSRF（1 時間先）", () => mint(t.aud, SUB, nowSec() + 3600)],
      ["別の利用者（sub が違う）に発行された CSRF", () => mint(t.aud, OTHER_SUB, nowSec())],
      [
        "改ざんした CSRF（末尾の 1 文字を変えた）",
        async () => {
          const v = csrfs.get(t.team) ?? "";
          return `${v.slice(0, -1)}${v.endsWith("A") ? "B" : "A"}`;
        },
      ],
      [
        "発行時刻だけ書き換えて延命した CSRF",
        async () => {
          const parts = (csrfs.get(t.team) ?? "").split(".");
          return [parts[0], nowSec() + 5, parts[2]].join(".");
        },
      ],
    ];
    for (const [name, make] of cases) {
      it(`${name} → 403 csrf_failed`, async () => {
        const csrf = await make();
        denied(await post(t, { csrf }), 403, "csrf_failed");
      });
    }

    it("CSRF の項目が重ねて送られたら（正しい値が 2 つ）403 csrf_failed", async () => {
      const csrf = csrfs.get(t.team) ?? "";
      denied(
        await post(t, {
          fields: [
            ["entry", t.entry],
            ["csrf", csrf],
            ["csrf", csrf],
          ],
        }),
        403,
        "csrf_failed",
      );
    });

    it("CSRF をクエリ文字列に付けても本文の代わりにならない（本文に無ければ 403 csrf_failed）", async () => {
      const csrf = csrfs.get(t.team) ?? "";
      denied(
        await post(t, {
          csrf: null,
          path: `${teamBase(t.team)}/login?csrf=${encodeURIComponent(csrf)}`,
        }),
        403,
        "csrf_failed",
      );
    });
  });

  describe("行（entry）", () => {
    it("entry が無い → 404 not_listed", async () => {
      denied(await post(t, { entry: null }), 404, "not_listed");
    });
    it("entry が重ねて送られた → 404 not_listed", async () => {
      denied(
        await post(t, {
          fields: [
            ["entry", t.entry],
            ["entry", t.entry],
            ["csrf", csrfs.get(t.team) ?? ""],
          ],
        }),
        404,
        "not_listed",
      );
    });
    for (const [name, entry] of [
      ["存在しないアカウント", "999999999999:readonly"],
      ["アカウント ID の桁が違う", "33333333333:readonly"],
      ["区切りが無い", "333333333333"],
      ["ロールが存在しない", "333333333333:nosuchrole"],
      ["ロールの名前の形が不正", "333333333333:Admin!"],
      [
        "ARN そのもの",
        "arn:aws:iam::333333333333:role/awsbridge-console/admin/FederatedAdministrator",
      ],
      ["空", ""],
    ] as const) {
      it(`entry が${name} → 404 not_listed`, async () => {
        denied(await post(t, { entry }), 404, "not_listed");
      });
    }
    for (const [name, entry] of t.foreignRows) {
      it(`entry が${name} → 404 not_listed`, async () => {
        denied(await post(t, { entry }), 404, "not_listed");
      });
    }
  });

  describe("本文の大きさ", () => {
    const big = `entry=${encodeURIComponent(t.entry)}&pad=${"a".repeat(MAX_BODY_BYTES + 1)}`;
    it(`本文が上限（${MAX_BODY_BYTES} バイト）を超える → 413 payload_too_large`, async () => {
      denied(await post(t, { rawBody: big }), 413, "payload_too_large");
    });
    it("Content-Length つきで上限を超える（チャンク転送でない）→ 413 payload_too_large", async () => {
      denied(
        await post(t, {
          rawBody: big,
          headers: { "Content-Length": String(Buffer.byteLength(big)) },
        }),
        413,
        "payload_too_large",
      );
    });
    it("検査が先: 本文が大きくても Origin が不正なら本文を読まずに 403 forbidden_origin", async () => {
      denied(
        await post(t, { rawBody: big, origin: "https://evil.example.com" }),
        403,
        "forbidden_origin",
      );
    });
  });

  describe("メソッド（GET で発行されない。HEAD・OPTIONS・PUT なども）", () => {
    it("GET /login は案内だけで発行しない（JWT あり。クエリに entry・csrf を付けても同じ）", async () => {
      const csrf = encodeURIComponent(csrfs.get(t.team) ?? "");
      for (const q of ["", `?entry=${encodeURIComponent(t.entry)}&csrf=${csrf}`]) {
        const r = await get(t, `${teamBase(t.team)}/login${q}`, { jwt: await accessJwt(t.aud) });
        expect(r.status, r.body).toBe(200);
        expect(r.headers.location).toBeUndefined();
      }
    });
    it("画面（S1: GET <チームのパス>/）も JWT が無ければ 401（Admin の本物のチームのパスを含む）", async () => {
      denied(await get(t, `${teamBase(t.team)}/`), 401, "unauthorized");
    });
    it("GET /login も JWT が無ければ 401", async () => {
      denied(await get(t, `${teamBase(t.team)}/login`), 401, "unauthorized");
    });
    it("HEAD /login は発行せず、本文もない（JWT あり）。JWT が無ければ 401", async () => {
      const r = await get(t, `${teamBase(t.team)}/login`, {
        method: "HEAD",
        jwt: await accessJwt(t.aud),
      });
      expect(r.status).toBe(200);
      expect(r.headers.location).toBeUndefined();
      expect(r.body).toBe("");
      const noJwt = await get(t, `${teamBase(t.team)}/login`, { method: "HEAD" });
      expect(noJwt.status).toBe(401);
      expect(noJwt.body).toBe("");
    });

    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      it(`${method} /login は 405 method_not_allowed（正しい JWT・Origin・本文でも発行しない。Allow は GET, HEAD, POST）`, async () => {
        const r = await post(t, { method });
        denied(r, 405, "method_not_allowed");
        expect(r.headers.allow).toBe("GET, HEAD, POST");
      });
    }

    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const rest of [
        "/",
        t.s2.replace(teamBase(t.team), ""),
        `${t.s2.replace(teamBase(t.team), "")}/cli`,
      ]) {
        it(`${method} ${teamBase(t.team)}${rest} は 405 method_not_allowed（画面は GET・HEAD だけ）`, async () => {
          const r = await post(t, { method, path: `${teamBase(t.team)}${rest}` });
          denied(r, 405, "method_not_allowed");
          expect(r.headers.allow).toBe("GET, HEAD");
        });
      }
    }
  });
});

// ---- 3. Standard 固有 ----

describe("Standard の Worker: 負の試験（Standard 固有）", () => {
  afterEach(noIssue);
  const t = stdT;

  it("Admin の行（333333333333:admin）は 404 not_listed（Standard は Admin の行を発行しない。7 段目）", async () => {
    denied(await post(t, { entry: ADMIN_ENTRY }), 404, "not_listed");
  });

  it("Admin のチーム（infra-elevated）のパスは Standard にない（404）。Admin のチームの AUD でも同じ", async () => {
    const aud = AUDS.teams["infra-elevated"] as string;
    for (const method of ["GET", "POST"]) {
      const r = await send(std, {
        method,
        host: PORTAL_HOST,
        path: "/t/infra-elevated/login",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessJwt(aud),
          Origin: PORTAL,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        ...(method === "POST" ? { body: "entry=333333333333%3Aadmin" } : {}),
      });
      denied(r, 404, "not_found");
    }
  });

  it("鍵だけ替えて公開鍵（vars）を替え忘れた（managed のバインディングの鍵が公開鍵と合わない）Worker は、正しい POST でも 503 signing_unavailable", async () => {
    denied(await post(t, { inst: stdMismatch }), 503, "signing_unavailable");
  });

  it("署名鍵（vars とバインディング）が無い Worker は、正しい POST・issuer の JWKS・画面とも 500 server_misconfigured", async () => {
    denied(await post(t, { inst: stdNoKey }), 500, "server_misconfigured");
    denied(
      await get(t, "/standard/.well-known/jwks.json", { host: ISSUER_HOST, inst: stdNoKey }),
      500,
      "server_misconfigured",
    );
    denied(
      await get(t, t.s2, { inst: stdNoKey, jwt: await accessJwt(t.aud) }),
      500,
      "server_misconfigured",
    );
  });

  describe("デプロイ後の確認（key-check）は Access の検証の後ろ（外から叩けない）", () => {
    const path = `${teamBase(t.team)}/key-check`;
    it("JWT なし 401、偽の JWT 401、Admin のチーム・入口の AUD 403、別の Standard のチーム 403", async () => {
      denied(await get(t, path), 401, "unauthorized");
      denied(
        await get(t, path, { jwt: await accessJwt(t.aud, { key: attackerKeys.privateKey }) }),
        401,
        "unauthorized",
      );
      for (const aud of [
        AUDS.teams["infra-elevated"] as string,
        AUDS.entry.admin,
        AUDS.entry.standard,
      ])
        denied(await get(t, path, { jwt: await accessJwt(aud) }), 403, "unknown_audience");
      denied(await get(t, path, { jwt: await accessJwt(t.peerAud) }), 403, "team_mismatch");
    });
    it("POST は 405、issuer のホストは 404", async () => {
      expect((await get(t, path, { method: "POST", jwt: await accessJwt(t.aud) })).status).toBe(
        405,
      );
      denied(
        await get(t, path, { host: ISSUER_HOST, jwt: await accessJwt(t.aud) }),
        404,
        "not_found",
      );
    });
    it("陽性の対照: Standard のチームの JWT なら 200 で、境界ごとの鍵の性質だけを返す（鍵の中身は返さない）", async () => {
      const r = await get(t, path, { jwt: await accessJwt(t.aud) });
      expect(r.status, r.body).toBe(200);
      const body = JSON.parse(r.body) as { boundaries: Record<string, unknown> };
      for (const b of ["managed", "partner:partner-x"])
        expect(body.boundaries[b]).toMatchObject({
          configured: true,
          usable: true,
          extractable: false,
          exportKey: "rejected",
          selfVerify: "ok",
        });
      expect(r.body).not.toMatch(/[A-Za-z0-9_-]{100,}/);
      const mismatch = await get(t, path, { inst: stdMismatch, jwt: await accessJwt(t.aud) });
      expect(JSON.parse(mismatch.body).boundaries.managed).toMatchObject({ selfVerify: "failed" });
    });
  });

  describe("issuer のホストからポータルの経路に届かない（discovery と JWKS だけ）", () => {
    const hostCases: [string, string, string][] = [
      ["GET", "/", "入口の一覧"],
      ["GET", "/assets/portal.js", "入口の静的なファイル"],
      ["GET", "/t/infra/", "チームの一覧（S1）"],
      ["GET", "/t/infra/a/333333333333", "S2"],
      ["GET", "/t/infra/a/333333333333/cli", "S3"],
      ["GET", "/t/infra/login", "GET /login"],
      ["GET", "/t/infra/assets/portal.css", "チームの静的なファイル"],
      ["GET", "/admin/.well-known/jwks.json", "Admin の issuer の JWKS（Standard は出さない）"],
      ["GET", "/admin/.well-known/openid-configuration", "Admin の issuer の discovery"],
      ["GET", "/standard/", "issuer のパスの直下"],
      ["GET", "/standard/.well-known/other.json", "issuer のパスの下の別の文書"],
      ["GET", "/standard/.well-known/jwks.json/", "末尾にスラッシュ"],
      ["GET", "/.well-known/jwks.json", "パスの接頭辞がない"],
    ];
    for (const [method, path, what] of hostCases) {
      it(`issuer のホストの ${method} ${path}（${what}）→ 404`, async () => {
        const r = await get(t, path, { host: ISSUER_HOST, jwt: await accessJwt(t.aud) });
        denied(r, 404, "not_found");
      });
    }

    it("issuer のホストの POST /t/infra/login は、正しい JWT・Origin・CSRF・行でも 404（発行しない）", async () => {
      denied(await post(t, { host: ISSUER_HOST }), 404, "not_found");
      denied(await post(t, { host: ISSUER_HOST, origin: PORTAL }), 404, "not_found");
    });

    it("issuer の文書は GET・HEAD だけ（POST・PUT・OPTIONS は 405）", async () => {
      for (const method of ["POST", "PUT", "OPTIONS", "DELETE"]) {
        for (const doc of ["jwks.json", "openid-configuration"]) {
          const r = await get(t, `/standard/.well-known/${doc}`, { host: ISSUER_HOST, method });
          denied(r, 405, "method_not_allowed");
          expect(r.headers.allow).toBe("GET, HEAD");
        }
      }
    });

    it("未知のホスト・Admin のポータルのホストは、どの経路も 404（Host ヘッダーで振り分ける）", async () => {
      for (const host of ["evil.example.com", ADMIN_HOST, "portal.example.com.evil.example.com"]) {
        for (const path of ["/", "/t/infra/", "/standard/.well-known/jwks.json"]) {
          const r = await get(t, path, { host, jwt: await accessJwt(t.aud) });
          denied(r, 404, "not_found");
        }
        denied(await post(t, { host }), 404, "not_found");
      }
    });
  });

  describe("チーム以外のパス・未知のチーム（Standard）", () => {
    const paths = [
      "/t",
      "/t/nosuch/",
      "/t/nosuch/login",
      "/t/infra/nosuch",
      "/t/infra/a/abc",
      "/t/infra/a/33333333333",
      "/t/infra/a/333333333333/extra",
      "/t/infra/assets/other.js",
      "/assets/other.js",
      "/x",
    ];
    for (const path of paths) {
      it(`GET ${path} は JWT があっても 404`, async () => {
        denied(await get(t, path, { jwt: await accessJwt(t.aud) }), 404, "not_found");
      });
    }
    it("POST /t/nosuch/login は正しい JWT・Origin でも 404", async () => {
      denied(await post(t, { path: "/t/nosuch/login" }), 404, "not_found");
    });
  });

  describe("入口の一覧（S0）の負の試験", () => {
    it("入口は GET・HEAD だけ（POST・PUT・OPTIONS は 405）", async () => {
      for (const method of ["POST", "PUT", "OPTIONS", "DELETE"]) {
        const r = await post(t, { method, path: "/", jwt: await accessJwt(AUDS.entry.standard) });
        denied(r, 405, "method_not_allowed");
        expect(r.headers.allow).toBe("GET, HEAD");
      }
    });
    it("入口は入口のアプリの JWT が必要（JWT 無しは 401、チームの AUD は 403、Admin の入口の AUD は 403）", async () => {
      expect((await get(t, "/")).status).toBe(401);
      expect((await get(t, "/", { jwt: await accessJwt(t.aud) })).status).toBe(403);
      expect((await get(t, "/", { jwt: await accessJwt(AUDS.entry.admin) })).status).toBe(403);
      expect((await get(t, "/", { jwt: await accessJwt(UNKNOWN_AUD) })).status).toBe(403);
    });
    it("入口も、大きさの上限を超える入口の AUD の JWT は 401（上限の内側なら 200）", async () => {
      const entry = AUDS.entry.standard;
      const over = await paddedJwt(entry, ACCESS_JWT_MAX_LENGTH + 100);
      const under = await paddedJwt(entry, ACCESS_JWT_MAX_LENGTH - 200);
      expect((await get(t, "/", { jwt: over, inst: stdBig })).status).toBe(401);
      expect((await get(t, "/", { jwt: under, inst: stdBig })).status).toBe(200);
    });
  });
});

// ---- 4. Admin 固有 ----

describe("Admin の Worker: 負の試験（Admin 固有。チームのパス以外は 404 を処理の最初に返す）", () => {
  afterEach(noIssue);
  const t = adminT;

  it("Standard のチームの AUD（infra・dev）は、Admin のチームのパスでも 403 unknown_audience", async () => {
    for (const aud of [AUDS.teams.infra as string, AUDS.teams.dev as string]) {
      denied(await post(t, { jwt: await accessJwt(aud) }), 403, "unknown_audience");
    }
  });

  it("Origin が Standard のオリジンなら 403 forbidden_origin", async () => {
    denied(await post(t, { origin: PORTAL }), 403, "forbidden_origin");
  });

  describe("チームのパス以外は、JWT・入口の AUD・メソッドによらず 404（env も JWT も見ない）", () => {
    const paths = [
      "/",
      "/x",
      "/t",
      "/t/",
      "/t/infra/",
      "/t/infra/login",
      "/t/nosuch/",
      "/assets/portal.js",
      "/assets/other.js",
      "/login",
      "/admin/.well-known/jwks.json",
      "/admin/.well-known/openid-configuration",
      "/standard/.well-known/jwks.json",
      "/.well-known/openid-configuration",
    ];
    for (const path of paths) {
      it(`${path}: JWT なし・チームの JWT・入口の AUD の JWT・各メソッドのどれでも 404 not_found`, async () => {
        for (const jwt of [
          null,
          await accessJwt(t.aud),
          await accessJwt(AUDS.entry.admin),
          await accessJwt(AUDS.entry.standard),
        ]) {
          denied(await get(t, path, { jwt }), 404, "not_found");
        }
        for (const method of ["POST", "PUT", "OPTIONS", "HEAD"]) {
          const r = await post(t, { method, path });
          expect(r.status, `${method} ${path}`).toBe(404);
          expect(r.headers.location).toBeUndefined();
        }
      });
    }
  });

  it("鍵だけ替えて公開鍵（vars）を替え忘れた（バインディングの鍵が公開鍵と合わない）Worker は、正しい POST でも 503 signing_unavailable", async () => {
    denied(await post(t, { inst: adminMismatch }), 503, "signing_unavailable");
  });

  it("Access JWT の iat が 15 分より前なら、POST も画面も 401（Access の exp の内でも）", async () => {
    const old = await accessJwt(t.aud, { iatAgo: 901, expIn: 600 });
    denied(await post(t, { jwt: old }), 401, "unauthorized");
    denied(await get(t, t.s2, { jwt: old }), 401, "unauthorized");
    denied(await get(t, `${teamBase(t.team)}/key-check`, { jwt: old }), 401, "unauthorized");
  });

  it("Access JWT の iat が未来（30 秒を超える）なら 401", async () => {
    denied(await post(t, { jwt: await accessJwt(t.aud, { iatAgo: -120 }) }), 401, "unauthorized");
  });

  describe("デプロイ後の確認（key-check）は Access の検証の後ろ（外から叩けない）", () => {
    const path = `${teamBase(t.team)}/key-check`;
    it("JWT なし 401、偽の JWT 401、Standard のチーム・入口の AUD 403、別の Admin のチーム 403", async () => {
      denied(await get(t, path), 401, "unauthorized");
      denied(
        await get(t, path, { jwt: await accessJwt(t.aud, { key: attackerKeys.privateKey }) }),
        401,
        "unauthorized",
      );
      for (const aud of [AUDS.teams.infra as string, AUDS.entry.admin, AUDS.entry.standard])
        denied(await get(t, path, { jwt: await accessJwt(aud) }), 403, "unknown_audience");
      denied(await get(t, path, { jwt: await accessJwt(t.peerAud) }), 403, "team_mismatch");
    });
    it("POST は 405、ポータル以外のホストは 404", async () => {
      expect((await get(t, path, { method: "POST", jwt: await accessJwt(t.aud) })).status).toBe(
        405,
      );
      for (const host of [ADMIN_ISSUER_HOST, ISSUER_HOST, PORTAL_HOST])
        denied(await get(t, path, { host, jwt: await accessJwt(t.aud) }), 404, "not_found");
    });
    it("陽性の対照: Admin のチームの JWT なら 200 で、鍵の中身は返さない", async () => {
      const r = await get(t, path, { jwt: await accessJwt(t.aud) });
      expect(r.status, r.body).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ usable: true, exportKey: "rejected" });
      expect(r.body).not.toMatch(/[A-Za-z0-9_-]{100,}/);
    });
  });

  describe("Admin の issuer のホストは 2 つの文書のパスだけ（A-3 = I-B）", () => {
    it("陽性の対照: /admin/.well-known/openid-configuration と jwks.json は 200（GET・HEAD）", async () => {
      for (const doc of ["openid-configuration", "jwks.json"]) {
        for (const method of ["GET", "HEAD"]) {
          const r = await get(t, `/admin/.well-known/${doc}`, { host: ADMIN_ISSUER_HOST, method });
          expect(r.status, `${method} ${doc}`).toBe(200);
        }
      }
    });
    const paths = [
      "/",
      "/admin",
      "/admin/x",
      "/.well-known/jwks.json",
      "/standard/.well-known/jwks.json",
      "/t/infra-elevated/",
      "/t/infra-elevated/login",
      "/t/infra-elevated/key-check",
      "/t/infra-elevated/a/333333333333",
    ];
    for (const path of paths) {
      it(`${ADMIN_ISSUER_HOST}${path} は JWT があっても 404`, async () => {
        denied(
          await get(t, path, { host: ADMIN_ISSUER_HOST, jwt: await accessJwt(t.aud) }),
          404,
          "not_found",
        );
      });
    }
    it("文書のパスへの POST は 405、正しい要求の POST /t/infra-elevated/login も 404", async () => {
      const r = await post(t, { host: ADMIN_ISSUER_HOST, path: "/admin/.well-known/jwks.json" });
      expect(r.status).toBe(405);
      denied(await post(t, { host: ADMIN_ISSUER_HOST }), 404, "not_found");
    });
  });

  describe("Admin の issuer の文書はポータルのホスト・Standard の issuer のホストでは出さない（404）", () => {
    const targets: [string, string][] = [
      [ADMIN_HOST, "/admin/.well-known/jwks.json"],
      [ADMIN_HOST, "/admin/.well-known/openid-configuration"],
      [ISSUER_HOST, "/admin/.well-known/jwks.json"],
      [ISSUER_HOST, "/admin/.well-known/openid-configuration"],
      [ISSUER_HOST, "/standard/.well-known/jwks.json"],
      [ISSUER_HOST, "/standard/.well-known/openid-configuration"],
      [ISSUER_HOST, "/t/infra-elevated/"],
      [PORTAL_HOST, "/t/infra-elevated/"],
      ["evil.example.com", "/t/infra-elevated/"],
      [`${ADMIN_HOST}.evil.example.com`, "/t/infra-elevated/"],
    ];
    for (const [host, path] of targets) {
      it(`${host}${path} → 404`, async () => {
        denied(await get(t, path, { host, jwt: await accessJwt(t.aud) }), 404, "not_found");
      });
    }
    it("issuer のホスト・Standard のホストへの POST /t/infra-elevated/login は、正しい JWT・Origin・CSRF・行でも 404", async () => {
      denied(await post(t, { host: ISSUER_HOST }), 404, "not_found");
      denied(await post(t, { host: PORTAL_HOST }), 404, "not_found");
      denied(await post(t, { host: PORTAL_HOST, origin: PORTAL }), 404, "not_found");
    });
  });
});

// ---- 5. 停止スイッチ ----

describe.each([stdT, adminT])("$label の Worker: 停止スイッチ（LOGIN_DISABLED=true）", (t) => {
  afterEach(noIssue);

  it("正しい POST は 503 login_disabled（STS を呼ばない）", async () => {
    const r = await post(t, { inst: t.stopped() });
    denied(r, 503, "login_disabled");
  });

  it("要求が不正でも（JWT が偽・Origin が別）503 login_disabled を返し、発行の段に進まない", async () => {
    denied(await post(t, { inst: t.stopped(), jwt: "not-a-jwt" }), 503, "login_disabled");
    denied(
      await post(t, { inst: t.stopped(), origin: "https://evil.example.com" }),
      503,
      "login_disabled",
    );
  });

  it("S2 に停止中の案内を出す（画面は引き続き開ける）", async () => {
    const r = await get(t, t.s2, { inst: t.stopped(), jwt: await accessJwt(t.aud) });
    expect(r.status, r.body).toBe(200);
    expect(r.body).toContain("一時停止");
  });

  it("停止中でも GET /login は発行しない", async () => {
    const r = await get(t, `${teamBase(t.team)}/login`, {
      inst: t.stopped(),
      jwt: await accessJwt(t.aud),
    });
    expect(r.status).toBe(200);
    expect(r.headers.location).toBeUndefined();
  });
});

// ---- 6. Access アプリの無いチーム ----

describe.each([stdT, adminT])(
  "$label の Worker: Access アプリの無いチームのパス（チーム noapp は AUD が設定にない）",
  (t) => {
    afterEach(noIssue);
    const base = teamBase(NOAPP);

    it("JWT が無ければ 401（S1・S2・S3・GET /login・静的なファイル）", async () => {
      for (const path of [
        `${base}/`,
        `${base}/a/333333333333`,
        `${base}/a/333333333333/cli`,
        `${base}/login`,
        `${base}/assets/portal.css`,
      ]) {
        denied(await get(t, path), 401, "unauthorized");
      }
    });

    it("どのチームの JWT でも断る（設定にある AUD は別のチームなので 403 team_mismatch、設定にない AUD は 403 unknown_audience）", async () => {
      for (const path of [`${base}/`, `${base}/a/333333333333`, `${base}/login`]) {
        denied(await get(t, path, { jwt: await accessJwt(t.aud) }), 403, "team_mismatch");
        denied(await get(t, path, { jwt: await accessJwt(t.peerAud) }), 403, "team_mismatch");
        denied(await get(t, path, { jwt: await accessJwt(UNKNOWN_AUD) }), 403, "unknown_audience");
        for (const [, aud] of t.entryAuds)
          denied(await get(t, path, { jwt: await accessJwt(aud) }), 403, "unknown_audience");
      }
    });

    it("POST /login は、JWT 無しなら 401、ほかの JWT なら 403（CSRF・行が正しくても発行しない）", async () => {
      const path = `${base}/login`;
      denied(await post(t, { path, jwt: null }), 401, "unauthorized");
      denied(await post(t, { path }), 403, "team_mismatch");
      denied(await post(t, { path, jwt: await accessJwt(UNKNOWN_AUD) }), 403, "unknown_audience");
      for (const [, aud] of t.entryAuds)
        denied(await post(t, { path, jwt: await accessJwt(aud) }), 403, "unknown_audience");
    });
  },
);

// ---- 7. secret が壊れている ----

describe("secret が壊れているとき（CSRF の鍵が短い）は発行せず、500 server_misconfigured を返す（fail-closed）", () => {
  afterEach(noIssue);

  it("Standard: 正しい POST でも 500 server_misconfigured（STS を呼ばない）。issuer の文書・画面も 500", async () => {
    denied(await post(stdT, { inst: stdBroken }), 500, "server_misconfigured");
    denied(
      await get(stdT, "/standard/.well-known/jwks.json", { host: ISSUER_HOST, inst: stdBroken }),
      500,
      "server_misconfigured",
    );
    denied(
      await get(stdT, stdT.s2, { inst: stdBroken, jwt: await accessJwt(stdT.aud) }),
      500,
      "server_misconfigured",
    );
  });

  it("Admin: チームのパスは 500 server_misconfigured（正しい POST でも発行しない）", async () => {
    denied(await post(adminT, { inst: adminBroken }), 500, "server_misconfigured");
    denied(
      await get(adminT, adminT.s2, { inst: adminBroken, jwt: await accessJwt(adminT.aud) }),
      500,
      "server_misconfigured",
    );
  });

  it("Admin: チームのパス以外は、env が壊れていても 404（処理の最初に返し、env を読まない。G-6）", async () => {
    for (const path of ["/", "/x", "/t/infra/", "/t/nosuch/", "/assets/portal.js"]) {
      denied(await get(adminT, path, { inst: adminBroken }), 404, "not_found");
    }
    denied(await post(adminT, { inst: adminBroken, path: "/login" }), 404, "not_found");
  });
});
