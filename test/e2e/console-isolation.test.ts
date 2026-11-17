// コンソールログインのバンドルの分離（wrangler deploy --dry-run の実際の出力で確かめる。デプロイはしない）。
// esbuild の metafile の inputs（バンドルに読み込んだモジュール）と、出力の本文の両方を見る。どの試験にも陽性の対照がある:
// 「入らない」ことを確かめる値は、本来の置き場所（生成物・バンドル）に実際にある。
// P2（B）の設計メモ §2.7・§4.2: Worker は 1 つになったので、分離は 2 方向（MCP ↔ コンソール）と、
// 「発行の経路が表示の照合を import しない」（test/unit/console-worker-layout.test.ts）。Admin の Worker のバンドルの試験は、
// 対象の無いもの（Admin の固有値が Standard に入らない など）を消し、残りを 1 つの Worker のバンドルに移した。
//
//   1. MCP（src/index.ts）     コンソールログインのコード（src/console/・scripts/・human）・固定の名前・生成物の値が入らない（cto の D2）
//   2. コンソールの Worker      両階層の生成物の値は入る。文字列の秘密鍵を読む経路（src/keys.ts・src/oidc.ts）・試験用の鍵を作るエントリ・
//                              MCP のコード・設定の解析器と生成器・scripts/・外部の script は入らない。実行時の外部の依存物は jose だけ
//                              （X1 の決裁 (d) を Worker 全体に）。境界ごとの secret_key の署名は入る
//
// 静的な import の分離（node の API・MCP 用の本体を読まない）は test/unit/console-layout.test.ts・console-worker-layout.test.ts。
// wrangler の設定の例は console-wrangler-config.test.ts。設計: docs/specs/console-login-portal.md §9.10。
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
const ENTRY = `entryaud${"6".repeat(40)}`;

// 表示用の Admin の情報（バンドルに入ってよい。表示用の生成物から入る）
const ADMIN_DISPLAY = ["infra-elevated", "dev-elevated", "00000000-0000-0000-0000-000000000004"];

const MCP_FILES = [
  "src/index.ts",
  "src/handler.ts",
  "src/proxy.ts",
  "src/access.ts",
  "src/toolslist.ts",
  "src/profiles.ts",
];

/** KMS の参照。X1 の決裁で署名は Cloudflare の中（secret_key）で完結するので、バンドルに入らない。 */
const KEY_REFERENCE_RE = /\bkms\b/i;
/** P2 より前の Admin の Worker の鍵の参照（バインディングの名前の接頭辞と vars の名前）。今のバンドルに入らない。 */
const OLD_ADMIN_KEY_REFS = ["ADMIN_KEY_", "ADMIN_CURRENT_KEY", "ADMIN_PUBLIC_JWKS"];
/** 試験用の鍵を作るエントリ（E2E）にだけある文字列。本番のバンドルに入らない。 */
const TEST_KEY_MARKERS = ["E2E_KEY_MODE", "generateKey"];
/** コンソールの鍵の参照（バインディングの名前の接頭辞と vars の名前）。 */
const CONSOLE_KEY_REFS = ["CONSOLE_KEY_", "CONSOLE_CURRENT_KEYS", "CONSOLE_PUBLIC_JWKS"];
/** 試験用の鍵を作るエントリ（E2E。本物のエントリも含む）。 */
const STD_TEST_KEY_ENTRY = "test/e2e/fixtures/console-entry.ts";
/** 文字列の秘密鍵（JWK）を署名鍵に読み込む経路の印（MCP 用の Worker だけが持つ）。 */
const STRING_KEY_PATHS = ["src/keys.ts", "src/oidc.ts"];
const STRING_KEY_MARKERS = [
  "parseSigningKeys",
  "CONSOLE_SIGNING_KEYS",
  "signing keys must be JSON",
];

type Built = { inputs: string[]; bundle: string };

let out = "";
let workerJson = "";
let displayJson = "";
let workerConfig: WorkerConfig;
let mcp: Built;
let standard: Built;
let standardTestEntry: Built;

/** 発行用の生成物の値（両階層の AUD・入口の AUD・issuer・ロールのパスと名前と ARN）。コンソールのバンドルにだけ入る。 */
let CONSOLE_VALUES: string[] = [];

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
  // inputs のパスは wrangler の設定ファイルのあるディレクトリからの相対（tmpdir が symlink のとき wrangler は実体のパスを基点にする）。
  // チェックアウト先のパスに左右されないよう、実体のパスに直してルートからの相対パスで照合する
  const base = realpathSync(dirname(wranglerConfig));
  const realRoot = realpathSync(root);
  const inputs = Object.keys(meta.inputs).map((p) =>
    relative(realRoot, realpathSync(resolve(base, p))),
  );
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

  // 会社用の例から、発行用・表示用の生成物を作る（比較のため。MCP のバンドルには入らないこと）
  const { config: consoleConfig } = parseConsoleConfig(
    readFileSync(join(root, "config/console.company.example.json"), "utf8"),
  );
  const artifacts = generateConsoleArtifacts(consoleConfig, {
    mode: "deploy",
    generatedAt: "2026-11-12T00:00:00.000Z",
    auds: { teams: AUD, entry: ENTRY },
    inventory: {
      "org-main": [
        { accountId: "111111111111", name: "svc-a-prod", ouPath: ["r-abcd", "ou-abcd-11111111"] },
        { accountId: "111111111112", name: "svc-c-dev", ouPath: ["r-abcd", "ou-abcd-33333333"] },
      ],
    },
  });
  workerConfig = artifacts.worker;
  workerJson = join(out, "worker.json");
  writeFileSync(workerJson, JSON.stringify(workerConfig));
  displayJson = join(out, "display.json");
  writeFileSync(displayJson, JSON.stringify(artifacts.display));

  CONSOLE_VALUES = [
    ...Object.values(AUD),
    ENTRY,
    ...workerConfig.boundaries.map((b) => b.issuer),
    rolePath("admin"),
    rolePath("standard"),
    ...rolesOf(workerConfig),
    ...arnsOf(workerConfig),
  ];

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

  const stdWrangler = readJsonc(join(root, "wrangler.console.jsonc"));
  standard = bundleOf("console", {
    ...stdWrangler,
    main: join(root, stdWrangler.main as string),
    alias: { "awsbridge:console-worker": workerJson, "awsbridge:console-display": displayJson },
  });
  // 陽性の対照: 試験用の鍵を作るエントリ（E2E 用）のバンドル。本番のバンドルとの差が見えることを確かめる
  standardTestEntry = bundleOf("console-test-entry", {
    ...stdWrangler,
    main: join(root, STD_TEST_KEY_ENTRY),
    alias: { "awsbridge:console-worker": workerJson, "awsbridge:console-display": displayJson },
  });
}, 180_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

const has = (inputs: string[], suffix: string) => inputs.filter((p) => p.endsWith(suffix));

describe("生成物の対照（以降の「入らない」の試験が空振りしていない証拠）", () => {
  it("発行用の生成物（worker.json）は両階層の値（AUD・issuer・ロールのパスと名前と ARN）を持ち、表示用の生成物（display.json）は持たない", () => {
    expect(CONSOLE_VALUES.length).toBeGreaterThan(10);
    const worker = readFileSync(workerJson, "utf8");
    const display = readFileSync(displayJson, "utf8");
    for (const s of CONSOLE_VALUES) expect(worker, s).toContain(s);
    // 表示用はチーム名・ロールの name・表示名を持つが、AUD・issuer・ARN・ロールのパスは持たない
    for (const s of [
      ...Object.values(AUD),
      ENTRY,
      ...workerConfig.boundaries.map((b) => b.issuer),
      ...arnsOf(workerConfig),
      rolePath("admin"),
      rolePath("standard"),
    ])
      expect(display, s).not.toContain(s);
  });

  it("表示用の生成物は表示用の Admin の情報（チーム名・Object ID）を持ち、Administrator の行は email を持たない", () => {
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
      mcp.inputs.filter((p) => /\.generated|worker(\.(standard|admin))?\.json|display\./.test(p)),
    ).toEqual([]);
  });

  it("コンソールログイン用の固定の名前（タグのキー・audience・ロールのパス・ポータルの経路）が本文にない", () => {
    expect(mcp.bundle).not.toContain(TEAM_TAG_KEY);
    expect(mcp.bundle).not.toContain(AUDIENCE);
    expect(mcp.bundle).not.toContain(ROLE_PATH_PREFIX);
    expect(mcp.bundle).not.toContain("awsbridge-console");
    expect(mcp.bundle).not.toContain("/t/");
  });

  it("コンソールログインの生成物の値（両階層の AUD・issuer・ロールの ARN）が本文にない", () => {
    for (const s of CONSOLE_VALUES) expect(mcp.bundle, s).not.toContain(s);
  });

  it("陽性の対照: 固定の名前・生成物の値の確認は、コンソールログインのバンドルでは見つかる（確認が空振りしていない）", () => {
    expect(standard.bundle).toContain(TEAM_TAG_KEY);
    expect(standard.bundle).toContain(AUDIENCE);
    expect(standard.bundle).toContain("awsbridge-console");
    for (const s of CONSOLE_VALUES) expect(standard.bundle, s).toContain(s);
  });
});

describe("2. コンソールの Worker（1 つ）のバンドル", () => {
  it("陽性の対照: エントリ・工場・発行の経路・境界の署名・発行用の生成物（両階層の AUD・issuer・ロール）は入っている", () => {
    expect(standard.inputs).toContain("src/console/worker/index.ts");
    expect(standard.inputs).toContain("src/console/portal/worker.ts");
    expect(standard.inputs).toContain("src/console/portal/login.ts");
    expect(standard.inputs).toContain("src/console/issue/sign-boundary.ts");
    // 生成物のパスは wrangler の設定のディレクトリからの相対で記録されるので、名前で照合する
    expect(has(standard.inputs, "worker.json")).toHaveLength(1);
    for (const s of CONSOLE_VALUES) expect(standard.bundle, s).toContain(s);
    expect(standard.bundle).toContain("signing_unavailable");
  });

  it("P2 より前の Admin の Worker（src/console/admin/）・Admin の生成物・Admin の鍵の参照・KMS の参照を持たない", () => {
    expect(standard.inputs.filter((p) => p.startsWith("src/console/admin/"))).toEqual([]);
    expect(has(standard.inputs, "worker.admin.json")).toEqual([]);
    for (const s of OLD_ADMIN_KEY_REFS) expect(standard.bundle, s).not.toContain(s);
    expect(standard.bundle).not.toMatch(KEY_REFERENCE_RE);
  });

  it("陽性の対照: 境界ごとの secret_key の署名（共通の signing/・鍵の参照）と issuer の文書は入っている", () => {
    for (const p of [
      "src/console/signing/key.ts",
      "src/console/signing/jws.ts",
      "src/console/signing/signer.ts",
      "src/console/worker/key.ts",
      "src/console/worker/issuer.ts",
    ])
      expect(standard.inputs, p).toContain(p);
    for (const s of CONSOLE_KEY_REFS) expect(standard.bundle, s).toContain(s);
    expect(standard.bundle).toContain("openid-configuration");
    expect(standard.bundle).toContain("jwks.json");
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
    for (const s of TEST_KEY_MARKERS) expect(standardTestEntry.bundle, s).toContain(s);
    expect(standard.inputs.filter((p) => p.startsWith("test/"))).toEqual([]);
    for (const s of TEST_KEY_MARKERS) expect(standard.bundle, s).not.toContain(s);
  });

  it("表示用の生成物（入口の一覧）は入っていて、表示用の Admin の情報（チーム名・Object ID）を持つ", () => {
    expect(has(standard.inputs, "display.json")).toHaveLength(1);
    expect(standard.inputs).toContain("src/console/display/entry.ts");
    for (const s of ADMIN_DISPLAY) expect(standard.bundle, s).toContain(s);
    expect(standard.bundle).toContain("membership unknown");
    expect(standard.bundle).toContain("no_group_table");
    expect(standard.bundle).toContain("00000000-0000-0000-0000-000000000001");
  });

  it("静的なファイル（CSS・JS）はバンドルに埋め込まれ、外部の script を読まない", () => {
    expect(standard.inputs).toContain("src/console/portal/assets.ts");
    expect(standard.bundle).toContain("awsbridge.console.recent");
    expect(standard.bundle).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("実行時の外部の依存物は jose だけで、版は package.json で固定している（X1 の決裁 (d) を Worker 全体に。§4.2）", () => {
    const pkgs = new Set(
      standard.inputs
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

  it("補助の検査: 本文に現れる URL のホストは許可リストだけ（通信先の制限ではない。宛先の制限は issue/egress.ts と console-egress.test.ts）", () => {
    // 文字列の結合・vars の値・リダイレクトは見えないので補助。amazonaws.com 全体は許さず、STS は地域の endpoint の形だけ
    const allowed = [
      /^sts\.\$\{[A-Za-z.]+\}\.amazonaws\.com$/, // STS の地域の endpoint（テンプレート）
      /^signin\.aws\.amazon\.com$/, // getSigninToken・ログイン URL
      /^\*\.signin\.aws\.amazon\.com$/, // CSP の form-action
      /^console\.aws\.amazon\.com$/, // CSP・コンソールの行き先
      /^\*\.console\.aws\.amazon\.com$/,
      /^\$\{region\}\.console\.aws\.amazon\.com$/,
      /^aws\.amazon\.com$/, // STS の JWT の claim の名前（https://aws.amazon.com/tags など。通信しない）
    ];
    const configHosts = new Set(
      [
        workerConfig.portal.origin,
        ...(workerConfig.portal.supportUrl ? [workerConfig.portal.supportUrl] : []),
        ...workerConfig.boundaries.map((b) => b.issuer),
      ].map((u) => new URL(u).host),
    );
    const hosts = [
      ...new Set(
        [...standard.bundle.matchAll(/https?:\/\/([A-Za-z0-9.*{}$_-]+)/g)].map((m) => m[1] ?? ""),
      ),
    ];
    // 陽性の対照: STS の宛先と設定のホストは見つかっている（取り出しが空振りしていない）
    expect(hosts.some((h) => /^sts\./.test(h))).toBe(true);
    expect(hosts.some((h) => configHosts.has(h))).toBe(true);
    const unexpected = hosts.filter(
      (h) => !configHosts.has(h) && !allowed.some((re) => re.test(h)),
    );
    expect(unexpected).toEqual([]);
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

describe("鍵の参照の確認の対照", () => {
  it("KMS の参照の形（ARN・API の名前）には反応する", () => {
    for (const s of ["arn:aws:kms:us-east-1:111111111111:key/abc", "kms:Sign", "the kms key"])
      expect(s).toMatch(KEY_REFERENCE_RE);
  });
});
