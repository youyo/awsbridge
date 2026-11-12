// コンソールログインの 3 方向のバンドルの分離（wrangler deploy --dry-run の実際の出力で確かめる。デプロイはしない）。
// esbuild の metafile の inputs（バンドルに読み込んだモジュール）と、出力の本文の両方を見る。どの試験にも陽性の対照がある:
// 「入らない」ことを確かめる値は、本来の置き場所（生成物・バンドル）に実際にある。
//
//   1. MCP（src/index.ts）     コンソールログインのコード（src/console/・scripts/・human）・固定の名前・生成物の値が入らない（cto の D2）
//   2. Standard                Admin の固有値（Admin の AUD・入口の AUD・issuer・ロールのパスと名前と ARN・Admin の鍵の参照）が入らない。
//                              表示用の Admin の情報（チーム名・Object ID）だけは入る（ADR の P1'・U2）。MCP のコード・設定の解析器と生成器・scripts/ も入らない。
//                              文字列の秘密鍵を読む経路（旧 parseSigningKeys・CONSOLE_SIGNING_KEYS・src/keys.ts・src/oidc.ts）と試験用の鍵を作るエントリも入らず、
//                              境界ごとの secret_key の署名（共通の signing/ と Standard の鍵の参照）は入る（cto の決裁「Standard も secret_key に揃える」）
//   3. Admin                   Standard の行・Standard の AUD・issuer・署名の実装（sign-standard・oidc・keys）・Standard の鍵の参照・
//                              文字列の鍵を読み込む経路・表示用（display）・試験用の鍵を作るエントリ（fixtures）が入らない。
//                              Admin の署名（secret_key の CryptoKey と WebCrypto）と Admin の issuer の文書は入る（X1 の決裁）
//
// 静的な import の分離（node の API・MCP 用の本体を読まない）は test/unit/console-layout.test.ts・console-standard-layout.test.ts。
// wrangler の設定の例は console-wrangler-config.test.ts。設計: docs/specs/console-login-portal.md §9.10。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConsoleConfig } from "../../src/console/config";
import { AUDIENCE, ROLE_PATH_PREFIX, rolePath, TEAM_TAG_KEY } from "../../src/console/constants";
import { generateConsoleArtifacts } from "../../src/console/generate";
import type { WorkerConfig } from "../../src/console/types";
import { readJsonc } from "./jsonc";

const root = new URL("../../", import.meta.url).pathname;

// 照合しやすい AUD（英数字 16〜128 文字）
const AUD = {
  infra: `stdinfraaud${"1".repeat(40)}`,
  dev: `stddevaud${"2".repeat(40)}`,
  sa: `stdsaaud${"3".repeat(40)}`,
  "infra-elevated": `admininfraaud${"4".repeat(40)}`,
  "dev-elevated": `admindevaud${"5".repeat(40)}`,
};
const ENTRY_STD = `stdentryaud${"6".repeat(40)}`;
const ENTRY_ADMIN = `adminentryaud${"7".repeat(40)}`;

// 表示用だけの Admin の情報（Standard のバンドルに入ってよい。表示用の生成物から入る）
const ADMIN_DISPLAY = ["infra-elevated", "dev-elevated", "00000000-0000-0000-0000-000000000004"];

const MCP_FILES = [
  "src/index.ts",
  "src/handler.ts",
  "src/proxy.ts",
  "src/access.ts",
  "src/toolslist.ts",
  "src/profiles.ts",
];

/** KMS の参照。X1 の決裁で Admin の署名は Cloudflare の中（secret_key）で完結するので、どちらのバンドルにも入らない。 */
const KEY_REFERENCE_RE = /\bkms\b/i;
/** Admin の鍵の参照（バインディングの名前の接頭辞と vars の名前）。Admin のバンドルにだけ入る。 */
const ADMIN_KEY_REFS = ["ADMIN_KEY_", "ADMIN_CURRENT_KEY", "ADMIN_PUBLIC_JWKS"];
/** 試験用の鍵を作るエントリ（E2E）にだけある文字列。本番の Admin のバンドルに入らない。 */
const TEST_KEY_ENTRY = "test/e2e/fixtures/console-admin-key-entry.ts";
const TEST_KEY_MARKERS = ["E2E_KEY_MODE", "generateKey"];
/** Standard の鍵の参照（バインディングの名前の接頭辞と vars の名前）。Standard のバンドルにだけ入る。 */
const STANDARD_KEY_REFS = ["STANDARD_KEY_", "STANDARD_CURRENT_KEYS", "STANDARD_PUBLIC_JWKS"];
/** Standard の試験用の鍵を作るエントリ（E2E。本物のエントリも含む）。 */
const STD_TEST_KEY_ENTRY = "test/e2e/fixtures/console-standard-entry.ts";
/** 文字列の秘密鍵（JWK）を署名鍵に読み込む経路の印（MCP 用の Worker だけが持つ）。 */
const STRING_KEY_PATHS = ["src/keys.ts", "src/oidc.ts"];
const STRING_KEY_MARKERS = [
  "parseSigningKeys",
  "CONSOLE_SIGNING_KEYS",
  "signing keys must be JSON",
];

type Built = { inputs: string[]; bundle: string };

let out = "";
let standardJson = "";
let adminJson = "";
let displayJson = "";
let stdConfig: WorkerConfig;
let adminConfig: WorkerConfig;
let mcp: Built;
let standard: Built;
let admin: Built;
let adminTestEntry: Built;
let standardTestEntry: Built;

/** 生成物の値のうち、片方の階層にだけあるもの。 */
let ADMIN_ONLY: string[] = [];
let STANDARD_ONLY: string[] = [];

/** wrangler の設定（main は絶対パスに、alias は差し替える）でバンドルだけ作り、読み込んだモジュールと出力の本文を返す。 */
function bundleOf(name: string, config: Record<string, unknown>): Built {
  const dir = join(out, name);
  const wranglerConfig = join(out, `wrangler.${name}.json`);
  writeFileSync(wranglerConfig, JSON.stringify({ ...config, $schema: undefined }));
  const r = spawnSync(
    join(root, "node_modules/.bin/wrangler"),
    [
      "deploy",
      "--dry-run",
      "--config",
      wranglerConfig,
      "--outdir",
      join(dir, "dist"),
      "--metafile",
      join(dir, "meta.json"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
    inputs: Record<string, unknown>;
  };
  // inputs のパスは cwd（リポジトリのルート）からの相対。チェックアウト先のパスに左右されないよう、ルートからの相対パスで照合する
  const inputs = Object.keys(meta.inputs).map((p) => relative(root, resolve(root, p)));
  const bundle = readdirSync(join(dir, "dist"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, "dist", f), "utf8"))
    .join("\n");
  return { inputs, bundle };
}

const rolesOf = (c: WorkerConfig) => c.roles.map((r) => r.roleName);
const arnsOf = (c: WorkerConfig) => c.accounts.flatMap((a) => a.roles.map((r) => r.roleArn));

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "awsbridge-console-isolation-"));

  // 会社用の例から、Standard・Admin・表示用の生成物を作る（比較のため。互いのバンドルには入らないこと）
  const { config: consoleConfig } = parseConsoleConfig(
    readFileSync(join(root, "config/console.company.example.json"), "utf8"),
  );
  const artifacts = generateConsoleArtifacts(consoleConfig, {
    mode: "deploy",
    generatedAt: "2026-11-12T00:00:00.000Z",
    auds: { teams: AUD, entry: { standard: ENTRY_STD, admin: ENTRY_ADMIN } },
    inventory: {
      "org-main": [
        { accountId: "111111111111", name: "svc-a-prod", ouPath: ["r-abcd", "ou-abcd-11111111"] },
        { accountId: "111111111112", name: "svc-c-dev", ouPath: ["r-abcd", "ou-abcd-33333333"] },
      ],
    },
  });
  if (!artifacts.worker.admin) throw new Error("admin config is missing");
  stdConfig = artifacts.worker.standard;
  adminConfig = artifacts.worker.admin;
  standardJson = join(out, "worker.standard.json");
  writeFileSync(standardJson, JSON.stringify(stdConfig));
  adminJson = join(out, "worker.admin.json");
  writeFileSync(adminJson, JSON.stringify(adminConfig));
  displayJson = join(out, "display.standard.json");
  writeFileSync(displayJson, JSON.stringify(artifacts.display));

  // 片方の階層にだけある値（生成物から求める。固定の文字列だけに頼らない）
  const stdIds = new Set(stdConfig.accounts.map((a) => a.accountId));
  const adminIds = new Set(adminConfig.accounts.map((a) => a.accountId));
  const adminIssuers = adminConfig.boundaries.map((b) => b.issuer);
  const stdIssuers = stdConfig.boundaries.map((b) => b.issuer);
  ADMIN_ONLY = [
    AUD["infra-elevated"],
    AUD["dev-elevated"],
    ENTRY_ADMIN,
    ...adminIssuers.filter((i) => !stdIssuers.includes(i)),
    rolePath("admin"),
    ...rolesOf(adminConfig).filter((n) => !rolesOf(stdConfig).includes(n)),
    ...arnsOf(adminConfig),
  ];
  STANDARD_ONLY = [
    AUD.infra,
    AUD.dev,
    AUD.sa,
    ENTRY_STD,
    ...stdIssuers.filter((i) => !adminIssuers.includes(i)),
    rolePath("standard"),
    ...rolesOf(stdConfig).filter((n) => !rolesOf(adminConfig).includes(n)),
    ...arnsOf(stdConfig),
    // Standard にだけある行のアカウント（管理外の先方など）
    ...stdConfig.accounts
      .filter((a) => !adminIds.has(a.accountId))
      .flatMap((a) => [a.accountId, a.name]),
  ];
  expect(
    [...stdIds].some((id) => !adminIds.has(id)),
    "Standard だけのアカウントが fixture にある",
  ).toBe(true);

  // MCP 用 Worker: リポジトリの wrangler.jsonc を読み、alias を例のファイルに差し替える
  // （config/profiles.json は gitignore。CLI の --alias は "awsbridge:profiles" のコロンで分かれてしまい効かない）
  const mcpConfig = readJsonc(join(root, "wrangler.jsonc"));
  expect(mcpConfig.main).toBe("src/index.ts");
  delete mcpConfig.env;
  mcp = bundleOf("mcp", {
    ...mcpConfig,
    main: join(root, "src/index.ts"),
    alias: { "awsbridge:profiles": join(root, "config/profiles.example.json") },
  });

  const stdWrangler = readJsonc(join(root, "wrangler.console-standard.jsonc"));
  standard = bundleOf("standard", {
    ...stdWrangler,
    main: join(root, stdWrangler.main as string),
    alias: { "awsbridge:console-worker": standardJson, "awsbridge:console-display": displayJson },
  });

  const adminWrangler = readJsonc(join(root, "wrangler.console-admin.jsonc"));
  admin = bundleOf("admin", {
    ...adminWrangler,
    main: join(root, adminWrangler.main as string),
    alias: { "awsbridge:console-worker-admin": adminJson },
  });
  // 陽性の対照: 試験用の鍵を作るエントリ（E2E 用）のバンドル。本番の Standard のバンドルとの差が見えることを確かめる
  standardTestEntry = bundleOf("standard-test-entry", {
    ...stdWrangler,
    main: join(root, STD_TEST_KEY_ENTRY),
    alias: { "awsbridge:console-worker": standardJson, "awsbridge:console-display": displayJson },
  });
  // 陽性の対照: 試験用の鍵を作るエントリ（E2E 用）のバンドル。本番の Admin のバンドルとの差が見えることを確かめる
  adminTestEntry = bundleOf("admin-test-entry", {
    ...adminWrangler,
    main: join(root, TEST_KEY_ENTRY),
    alias: { "awsbridge:console-worker-admin": adminJson },
  });
}, 180_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

const has = (inputs: string[], suffix: string) => inputs.filter((p) => p.endsWith(suffix));

describe("生成物の対照（以降の「入らない」の試験が空振りしていない証拠）", () => {
  it("Admin の固有値は Admin の生成物にだけあり、Standard の生成物（発行用・表示用）にない", () => {
    expect(ADMIN_ONLY.length).toBeGreaterThan(6);
    const admin = readFileSync(adminJson, "utf8");
    const std = readFileSync(standardJson, "utf8");
    const display = readFileSync(displayJson, "utf8");
    for (const s of ADMIN_ONLY) {
      expect(admin, s).toContain(s);
      expect(std, s).not.toContain(s);
      expect(display, s).not.toContain(s);
    }
  });

  it("Standard の固有値（AUD・issuer・ロールのパスと名前と ARN・Standard だけのアカウント）は Standard の生成物にだけあり、Admin の生成物にない", () => {
    expect(STANDARD_ONLY.length).toBeGreaterThan(8);
    const admin = readFileSync(adminJson, "utf8");
    const std = readFileSync(standardJson, "utf8");
    for (const s of STANDARD_ONLY) {
      expect(std, s).toContain(s);
      expect(admin, s).not.toContain(s);
    }
  });

  it("表示用の生成物（display.standard.json）は表示用の Admin の情報（チーム名・Object ID）を持ち、Administrator の行は email を持たない", () => {
    const text = readFileSync(displayJson, "utf8");
    for (const s of ADMIN_DISPLAY) expect(text, s).toContain(s);
    const display = JSON.parse(text) as { accounts: { tier: string; email?: string }[] };
    const admins = display.accounts.filter((a) => a.tier === "admin");
    expect(admins.length).toBeGreaterThan(0);
    for (const a of admins) expect(a).not.toHaveProperty("email");
  });
});

describe("1. MCP 用 Worker（src/index.ts）のバンドルにコンソールログインが入らない", () => {
  it("陽性の対照: MCP 用のモジュールとプロファイル一覧は入っている", () => {
    expect(mcp.inputs).toContain("src/index.ts");
    expect(mcp.inputs).toContain("src/handler.ts");
    expect(mcp.inputs).toContain("config/profiles.example.json");
    expect(mcp.bundle).toContain("list_aws_profiles");
  });

  it("コンソールログイン用のモジュール（src/console/・scripts/）と PoC（human）を読み込まない", () => {
    expect(mcp.inputs.filter((p) => p.startsWith("src/console/"))).toEqual([]);
    expect(mcp.inputs.filter((p) => p.startsWith("scripts/"))).toEqual([]);
    // パスの区切りで始まる console（node_modules の中も含め、console という名前のディレクトリ・ファイル）
    expect(mcp.inputs.filter((p) => /(^|\/)console([/.-]|$)/i.test(p))).toEqual([]);
    expect(mcp.inputs.filter((p) => /human/i.test(p))).toEqual([]);
    expect(
      mcp.inputs.filter((p) => /\.generated|worker\.(standard|admin)\.json|display\./.test(p)),
    ).toEqual([]);
  });

  it("コンソールログイン用の固定の名前（タグのキー・audience・ロールのパス・ポータルの経路）が本文にない", () => {
    expect(mcp.bundle).not.toContain(TEAM_TAG_KEY);
    expect(mcp.bundle).not.toContain(AUDIENCE);
    expect(mcp.bundle).not.toContain(ROLE_PATH_PREFIX);
    expect(mcp.bundle).not.toContain("awsbridge-console");
    expect(mcp.bundle).not.toContain("/t/");
  });

  it("コンソールログインの生成物の値（Standard・Admin の AUD・issuer・ロールの ARN）が本文にない", () => {
    // 12 桁だけのアカウント ID は jose のエラーコードなどの数字と偶然重なりうるので除く（ARN にはアカウント ID が入っている）
    for (const s of [...ADMIN_ONLY, ...STANDARD_ONLY].filter((v) => !/^\d{12}$/.test(v)))
      expect(mcp.bundle, s).not.toContain(s);
  });

  it("陽性の対照: 固定の名前の確認は、コンソールログインのバンドルでは見つかる（確認が空振りしていない）", () => {
    for (const b of [standard, admin]) {
      expect(b.bundle).toContain(TEAM_TAG_KEY);
      expect(b.bundle).toContain(AUDIENCE);
      expect(b.bundle).toContain("awsbridge-console");
    }
  });
});

describe("2. Standard の Worker のバンドルに Admin の固有値が入らない", () => {
  it("陽性の対照: エントリ・発行の経路・Standard の署名・Standard の生成物（Standard の AUD・issuer）は入っている", () => {
    expect(standard.inputs).toContain("src/console/standard/index.ts");
    expect(standard.inputs).toContain("src/console/portal/login.ts");
    expect(standard.inputs).toContain("src/console/issue/sign-standard.ts");
    // 生成物のパスは wrangler の設定のディレクトリからの相対で記録されるので、名前で照合する
    expect(has(standard.inputs, "worker.standard.json")).toHaveLength(1);
    for (const s of STANDARD_ONLY) expect(standard.bundle, s).toContain(s);
  });

  it("Admin の生成物・Admin のエントリ・Admin の Worker を読み込まない", () => {
    expect(has(standard.inputs, "worker.admin.json")).toEqual([]);
    expect(standard.inputs.filter((p) => p.startsWith("src/console/admin/"))).toEqual([]);
  });

  it("Admin の発行に使える値（Admin のチームの AUD・Admin の入口の AUD・Admin の issuer・Admin のロールのパスと名前と ARN）が入らない", () => {
    for (const s of ADMIN_ONLY) expect(standard.bundle, s).not.toContain(s);
    // 文字列の固定の確認（生成物の求め方が壊れても落ちるように）
    for (const s of [
      AUD["infra-elevated"],
      AUD["dev-elevated"],
      ENTRY_ADMIN,
      "https://awsbridge-oidc-admin-console.example.com/admin",
      "/awsbridge-console/admin/",
      "FederatedAwsBridgeAdministrator",
    ])
      expect(standard.bundle, s).not.toContain(s);
  });

  it("Admin の鍵の参照（バインディングの名前・vars）・Admin の署名の部品・KMS の参照を持たない", () => {
    expect(standard.bundle).not.toMatch(KEY_REFERENCE_RE);
    for (const s of ADMIN_KEY_REFS) expect(standard.bundle, s).not.toContain(s);
    expect(standard.inputs.filter((p) => p.startsWith("src/console/admin/"))).toEqual([]);
  });

  it("陽性の対照: 境界ごとの secret_key の署名（共通の signing/・Standard の鍵の参照）は入っている", () => {
    for (const p of [
      "src/console/signing/key.ts",
      "src/console/signing/jws.ts",
      "src/console/signing/signer.ts",
      "src/console/standard/key.ts",
    ])
      expect(standard.inputs, p).toContain(p);
    for (const s of STANDARD_KEY_REFS) expect(standard.bundle, s).toContain(s);
  });

  it("文字列の秘密鍵（JWK）を署名鍵に読み込む経路が入らない（陽性の対照: MCP 用の Worker のバンドルにはある）", () => {
    for (const p of STRING_KEY_PATHS) {
      expect(mcp.inputs, p).toContain(p);
      expect(standard.inputs, p).not.toContain(p);
    }
    expect(mcp.bundle).toContain("SIGNING_JWK");
    for (const s of STRING_KEY_MARKERS) expect(standard.bundle, s).not.toContain(s);
  });

  it("試験用の鍵を作るエントリ（fixtures）が入らない（陽性の対照: そのエントリのバンドルには入っている）", () => {
    expect(standardTestEntry.inputs).toContain(STD_TEST_KEY_ENTRY);
    expect(standardTestEntry.bundle).toContain("E2E_KEY_MODE");
    expect(standard.inputs.filter((p) => p.startsWith("test/"))).toEqual([]);
    expect(standard.bundle).not.toContain("E2E_KEY_MODE");
  });

  it("表示用の生成物（入口の一覧）は入っていて、表示用の Admin の情報（チーム名・Object ID）だけを持つ", () => {
    expect(has(standard.inputs, "display.standard.json")).toHaveLength(1);
    expect(standard.inputs).toContain("src/console/display/entry.ts");
    for (const s of ADMIN_DISPLAY) expect(standard.bundle, s).toContain(s);
    // Admin のバンドルの「表示用が無い」の試験の陽性の対照
    expect(standard.bundle).toContain("membership unknown");
    expect(standard.bundle).toContain("no_group_table");
    expect(standard.bundle).toContain("00000000-0000-0000-0000-000000000001");
  });

  it("静的なファイル（CSS・JS）はバンドルに埋め込まれ、外部の script を読まない", () => {
    expect(standard.inputs).toContain("src/console/portal/assets.ts");
    expect(standard.bundle).toContain("awsbridge.console.recent");
    expect(standard.bundle).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("MCP のコード・設定の解析器と生成器・scripts/ を読み込まない", () => {
    for (const p of [...MCP_FILES, "src/console/config.ts", "src/console/generate.ts"])
      expect(standard.inputs, p).not.toContain(p);
    expect(standard.inputs.filter((p) => p.startsWith("scripts/"))).toEqual([]);
    expect(standard.inputs.filter((p) => /profiles/.test(p))).toEqual([]);
    expect(standard.bundle).not.toContain("list_aws_profiles");
    expect(standard.bundle).not.toContain("awsbridge:profiles");
  });
});

describe("3. Admin の Worker のバンドルに Standard の行・署名の実装・oidc・display が入らない", () => {
  it("陽性の対照: エントリ・共通の工場・発行の経路・署名の差し込み口・Admin の生成物（Admin の AUD・issuer・ロール）は入っている", () => {
    expect(admin.inputs).toContain("src/console/admin/index.ts");
    expect(admin.inputs).toContain("src/console/portal/worker.ts");
    expect(admin.inputs).toContain("src/console/portal/login.ts");
    expect(admin.inputs).toContain("src/console/issue/signer.ts");
    expect(has(admin.inputs, "worker.admin.json")).toHaveLength(1);
    for (const s of ADMIN_ONLY) expect(admin.bundle, s).toContain(s);
    expect(admin.bundle).toContain("https://awsbridge-admin-console.example.com");
    expect(admin.bundle).toContain("signing_unavailable");
  });

  it("陽性の対照: Admin の署名の部品（secret_key の CryptoKey・WebCrypto の JWS）・鍵の参照・Admin の issuer の文書は入っている", () => {
    for (const p of [
      "src/console/admin/sign-admin.ts",
      "src/console/admin/key.ts",
      "src/console/admin/issuer.ts",
      "src/console/signing/jws.ts",
      "src/console/signing/signer.ts",
    ])
      expect(admin.inputs, p).toContain(p);
    for (const s of ADMIN_KEY_REFS) expect(admin.bundle, s).toContain(s);
    expect(admin.bundle).toContain("openid-configuration");
    expect(admin.bundle).toContain("jwks.json");
    expect(admin.bundle).toContain("https://awsbridge-oidc-admin-console.example.com/admin");
  });

  it("試験用の鍵を作るエントリ（fixtures）が入らない（陽性の対照: そのエントリのバンドルには入っている）", () => {
    expect(adminTestEntry.inputs).toContain(TEST_KEY_ENTRY);
    for (const s of TEST_KEY_MARKERS) expect(adminTestEntry.bundle, s).toContain(s);
    expect(admin.inputs.filter((p) => p.startsWith("test/"))).toEqual([]);
    for (const s of TEST_KEY_MARKERS) expect(admin.bundle, s).not.toContain(s);
  });

  it("文字列の鍵（JWK）を署名鍵に読み込む経路が入らない（陽性の対照: MCP 用の Worker のバンドルにはある）", () => {
    for (const p of STRING_KEY_PATHS) {
      expect(mcp.inputs, p).toContain(p);
      expect(admin.inputs, p).not.toContain(p);
    }
    for (const s of STRING_KEY_MARKERS) expect(admin.bundle, s).not.toContain(s);
  });

  it("Standard の鍵の参照（バインディングの名前・vars）が入らない（陽性の対照: Standard のバンドルにはある）", () => {
    for (const s of STANDARD_KEY_REFS) {
      expect(standard.bundle, s).toContain(s);
      expect(admin.bundle, s).not.toContain(s);
    }
    expect(admin.inputs).not.toContain("src/console/standard/key.ts");
  });

  it("実行時の外部の依存物は jose だけで、版は package.json で固定している", () => {
    const pkgs = new Set(
      admin.inputs
        .filter((p) => p.includes("node_modules/"))
        .map(
          (p) =>
            /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(p)?.[1],
        ),
    );
    // 陽性の対照: jose（Access JWT の検証）は入っていて、パッケージ名の取り出しが空振りしていない
    expect(pkgs.has("jose")).toBe(true);
    expect([...pkgs].filter((p) => p !== "jose")).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.jose).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("Standard の生成物（行・AUD・入口の AUD・issuer・ロールのパスと名前と ARN）が入らない。Standard のポータルのオリジンは peerOrigin（表示のリンク）としてだけ入る", () => {
    expect(has(admin.inputs, "worker.standard.json")).toEqual([]);
    for (const s of STANDARD_ONLY) expect(admin.bundle, s).not.toContain(s);
    for (const s of [
      AUD.infra,
      AUD.dev,
      AUD.sa,
      ENTRY_STD,
      "https://awsbridge-oidc-console.example.com/standard",
      "/awsbridge-console/std/",
      "FederatedAwsBridgeViewer",
    ])
      expect(admin.bundle, s).not.toContain(s);
  });

  it("Standard の署名の実装・OIDC・鍵の生成・旧い CONSOLE_SIGNING_KEYS の参照・Standard の issuer の文書が入らない", () => {
    for (const p of [
      "src/console/issue/sign-standard.ts",
      "src/oidc.ts",
      "src/keys.ts",
      "src/console/standard/index.ts",
      "src/console/standard/worker.ts",
      "src/console/standard/issuer.ts",
    ])
      expect(admin.inputs, p).not.toContain(p);
    expect(admin.bundle).not.toContain("CONSOLE_SIGNING_KEYS");
    expect(admin.bundle).not.toContain('awsbridge:console-worker"');
    // Admin の署名は Cloudflare の中（secret_key）で完結する。KMS の参照は無い
    expect(admin.bundle).not.toMatch(KEY_REFERENCE_RE);
  });

  it("表示用の生成物・照合のコード（入口の一覧）を持たない（display のモジュール・Object ID・照合のコードの文字列が無い）", () => {
    expect(admin.inputs.filter((p) => /display/.test(p))).toEqual([]);
    expect(admin.bundle).not.toContain("membership unknown");
    expect(admin.bundle).not.toContain("no_group_table");
    for (const n of [1, 2, 3, 4, 5]) {
      const id = `00000000-0000-0000-0000-00000000000${n}`;
      expect(admin.bundle, id).not.toContain(id);
    }
    // 陽性の対照: チームの画面の静的なファイルは入っている。Object ID・照合のコードは Standard のバンドルにある（上の describe 2）
    expect(admin.inputs).toContain("src/console/portal/assets.ts");
  });

  it("MCP のコード・設定の解析器と生成器・scripts/ を読み込まない", () => {
    for (const p of [...MCP_FILES, "src/console/config.ts", "src/console/generate.ts"])
      expect(admin.inputs, p).not.toContain(p);
    expect(admin.inputs.filter((p) => p.startsWith("scripts/"))).toEqual([]);
    expect(admin.inputs.filter((p) => /profiles/.test(p))).toEqual([]);
    expect(admin.bundle).not.toContain("list_aws_profiles");
    expect(admin.bundle).not.toContain("awsbridge:profiles");
  });
});

describe("鍵の参照の確認の対照", () => {
  it("KMS の参照の形（ARN・API の名前）には反応する", () => {
    for (const s of ["arn:aws:kms:us-east-1:111111111111:key/abc", "kms:Sign", "the kms key"])
      expect(s).toMatch(KEY_REFERENCE_RE);
  });
});
