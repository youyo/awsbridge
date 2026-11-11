import { describe, expect, it } from "vitest";
import {
  audFromTerraformOutput,
  deployVars,
  rolesFromOutputs,
  workerSecrets,
} from "../../scripts/poc/human/portal/deploy-lib";
import { n9Cases, n9Issuer, n9RoleOutputKey } from "../../scripts/poc/human/portal/n9-cases";
import { portalSettings } from "../../scripts/poc/human/portal/settings";
import {
  classifyWhoami,
  cookieHeader,
  tokenRefreshes,
} from "../../scripts/poc/human/portal/watch-lib";

const BASE = "https://awsbridge-human-poc-portal.example.workers.dev";
const HOST = "awsbridge-human-poc-portal.example.workers.dev";
const ROOT = "/repo";

describe("portalSettings（AWSBRIDGE_HUMAN_POC_PORTAL_* だけを読む）", () => {
  it("既定値", () => {
    const s = portalSettings({}, ROOT);
    expect(s).toMatchObject({
      base: undefined,
      teamDomain: undefined,
      audience: "awsbridge-human-poc-portal",
      stackName: "awsbridge-human-poc-portal",
      awsProfile: "awsbridge",
      region: "ap-northeast-1",
      outDir: "/repo/.secrets/poc-human/portal",
      stdKeyFile: "/repo/.secrets/poc-human/portal/signing-key-std.json",
      adminKeyFile: "/repo/.secrets/poc-human/portal/signing-key-admin.json",
      secretsFile: "/repo/.secrets/poc-human/portal/worker-secrets.json",
      cookieFile: "/repo/.secrets/poc-human/portal/access-cookie.txt",
      accessDir: "/repo/scripts/poc/human/portal/access",
      sessionDuration: "3600",
      subject: "awsbridge-n9-check",
    });
  });
  it("URL は正規化し、MCP 用・既存の PoC の変数は読まない", () => {
    const s = portalSettings(
      {
        AWSBRIDGE_HUMAN_POC_PORTAL_URL: `${BASE}/`,
        AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com/",
        AWSBRIDGE_ISSUER: "https://awsbridge.example.workers.dev",
        AWSBRIDGE_HUMAN_POC_ISSUER: "https://awsbridge-human-poc.example.workers.dev",
        AWSBRIDGE_HUMAN_POC_STACK_NAME: "awsbridge-human-poc",
        AWS_PROFILE: "dev",
        AWS_REGION: "us-east-1",
      },
      ROOT,
    );
    expect(s.base).toBe(BASE);
    expect(s.teamDomain).toBe("https://example-team.cloudflareaccess.com");
    expect(s.stackName).toBe("awsbridge-human-poc-portal");
    expect(s.awsProfile).toBe("dev");
    expect(s.region).toBe("us-east-1");
  });
  it("PoC のポータル用でないスタック名・不正な URL・SessionDuration は例外", () => {
    expect(() =>
      portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_STACK_NAME: "awsbridge" }, ROOT),
    ).toThrow();
    expect(() =>
      portalSettings(
        { AWSBRIDGE_HUMAN_POC_PORTAL_URL: "https://awsbridge.example.workers.dev" },
        ROOT,
      ),
    ).toThrow();
    expect(() =>
      portalSettings(
        { AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN: "https://evil.example.com" },
        ROOT,
      ),
    ).toThrow();
    for (const v of ["899", "43201", "abc"])
      expect(() =>
        portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_SESSION_DURATION: v }, ROOT),
      ).toThrow();
    expect(
      portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_SESSION_DURATION: "none" }, ROOT).sessionDuration,
    ).toBe("");
  });
});

describe("portalSettings: 入口のホスト（AWSBRIDGE_HUMAN_POC_PORTAL_HOST）と B4 の設定", () => {
  const CUSTOM = "awsbridge-human-poc-portal.example.com";
  it("HOST から base（https://<HOST>）を作る。URL と両方あれば一致が必要", () => {
    expect(portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_HOST: CUSTOM }, ROOT).base).toBe(
      `https://${CUSTOM}`,
    );
    expect(
      portalSettings(
        {
          AWSBRIDGE_HUMAN_POC_PORTAL_HOST: CUSTOM,
          AWSBRIDGE_HUMAN_POC_PORTAL_URL: `https://${CUSTOM}/`,
        },
        ROOT,
      ).base,
    ).toBe(`https://${CUSTOM}`);
    expect(() =>
      portalSettings(
        { AWSBRIDGE_HUMAN_POC_PORTAL_HOST: CUSTOM, AWSBRIDGE_HUMAN_POC_PORTAL_URL: BASE },
        ROOT,
      ),
    ).toThrow();
  });
  it("HOST は awsbridge-console-poc.<zone> も受け付ける", () => {
    expect(
      portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_HOST: "awsbridge-console-poc.example.com" }, ROOT)
        .base,
    ).toBe("https://awsbridge-console-poc.example.com");
    expect(() =>
      portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_HOST: "awsbridge-console.example.com" }, ROOT),
    ).toThrow();
  });
  it("HOST は awsbridge-human-poc-portal.<zone> のホスト名だけ（スキーム・パス・workers.dev は不可）", () => {
    for (const bad of [
      `https://${CUSTOM}`,
      `${CUSTOM}/x`,
      "awsbridge.example.com",
      HOST, // workers.dev
    ])
      expect(() => portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_HOST: bad }, ROOT), bad).toThrow();
  });
  it("B4 のトークンのファイル（既定 <OUT_DIR>/access-jwt.txt）と workers.dev のサブドメイン（任意）", () => {
    const s = portalSettings({}, ROOT);
    expect(s.tokenFile).toBe("/repo/.secrets/poc-human/portal/access-jwt.txt");
    expect(s.workersDevSubdomain).toBeUndefined();
    const t = portalSettings(
      {
        AWSBRIDGE_HUMAN_POC_PORTAL_TOKEN_FILE: "/tmp/t.txt",
        AWSBRIDGE_HUMAN_POC_PORTAL_WORKERS_DEV_SUBDOMAIN: "my-sub",
      },
      ROOT,
    );
    expect(t.tokenFile).toBe("/tmp/t.txt");
    expect(t.workersDevSubdomain).toBe("my-sub");
    expect(() =>
      portalSettings({ AWSBRIDGE_HUMAN_POC_PORTAL_WORKERS_DEV_SUBDOMAIN: "a.b" }, ROOT),
    ).toThrow();
  });
});

describe("audFromTerraformOutput（terraform output -json → Worker の ACCESS_AUD_MAP）", () => {
  const out = (host = HOST) =>
    JSON.stringify({
      team_auds: { value: { infra: "a".repeat(64), dev: "b".repeat(64) } },
      entry_aud: { value: "c".repeat(64) },
      worker_host: { value: host },
      app_ids: { value: {} },
    });
  it("チーム → AUD を反転し、入口の AUD を返す", () => {
    expect(audFromTerraformOutput(out(), BASE)).toEqual({
      audMap: { ["a".repeat(64)]: "infra", ["b".repeat(64)]: "dev" },
      entryAud: "c".repeat(64),
    });
  });
  it("state が無い（{}）なら undefined", () => {
    expect(audFromTerraformOutput("{}", BASE)).toBeUndefined();
    expect(audFromTerraformOutput("", BASE)).toBeUndefined();
  });
  it("Terraform の worker_host がポータルの URL と違えば例外（別のホストの AUD を取り違えない）", () => {
    expect(() =>
      audFromTerraformOutput(out("awsbridge-human-poc-portal.other.workers.dev"), BASE),
    ).toThrow();
  });
});

describe("rolesFromOutputs（スタックの Outputs → Worker の ROLES）", () => {
  it("Shared と InfraOnly をログインの選択肢にする（Admin は admin の issuer 用なので入れない）", () => {
    expect(
      rolesFromOutputs({
        SharedRoleArn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalShared",
        InfraOnlyRoleArn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalInfraOnly",
        AdminRoleArn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalAdmin",
      }),
    ).toEqual([
      { label: "shared", arn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalShared" },
      {
        label: "infra-only",
        arn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalInfraOnly",
      },
    ]);
  });
  it("無ければ []、PoC のポータルのロールでなければ例外", () => {
    expect(rolesFromOutputs({})).toEqual([]);
    expect(() =>
      rolesFromOutputs({ SharedRoleArn: "arn:aws:iam::123456789012:role/FederatedMcpReadOnly" }),
    ).toThrow();
  });
});

describe("deployVars / workerSecrets", () => {
  it("--var に渡す KEY:VALUE（秘密は含めない。空の値は渡さない）", () => {
    const vars = deployVars({
      base: BASE,
      teamDomain: "https://example-team.cloudflareaccess.com",
      audMap: { aaa: "infra" },
      entryAud: undefined,
      roles: [],
      sessionDuration: "3600",
      audience: "awsbridge-human-poc-portal",
      region: "ap-northeast-1",
    });
    expect(vars).toEqual([
      `PORTAL_BASE:${BASE}`,
      "ACCESS_TEAM_DOMAIN:https://example-team.cloudflareaccess.com",
      'ACCESS_AUD_MAP:{"aaa":"infra"}',
      "ROLES:[]",
      "SESSION_DURATION:3600",
      "AUDIENCE:awsbridge-human-poc-portal",
      "REGION:ap-northeast-1",
    ]);
    expect(vars.join(" ")).not.toMatch(/SIGNING_JWK/);
  });
  it("PoC 専用の poc-token は pocToken: true のときだけ POC_TOKEN_ENDPOINT:enabled を渡す", () => {
    const p = {
      base: BASE,
      teamDomain: "https://example-team.cloudflareaccess.com",
      audMap: {},
      entryAud: undefined,
      roles: [],
      sessionDuration: "3600",
      audience: "awsbridge-human-poc-portal",
      region: "ap-northeast-1",
    };
    expect(deployVars(p).some((v) => v.startsWith("POC_TOKEN_ENDPOINT"))).toBe(false);
    expect(deployVars({ ...p, pocToken: false }).some((v) => v.startsWith("POC_TOKEN"))).toBe(
      false,
    );
    expect(deployVars({ ...p, pocToken: true })).toContain("POC_TOKEN_ENDPOINT:enabled");
  });
  it("secret は SIGNING_JWK_STD / SIGNING_JWK_ADMIN（--secrets-file に書く）", () => {
    const s = workerSecrets({ kty: "RSA", d: "x1" }, { kty: "RSA", d: "x2" });
    expect(Object.keys(s).sort()).toEqual(["SIGNING_JWK_ADMIN", "SIGNING_JWK_STD"]);
    expect(JSON.parse(s.SIGNING_JWK_STD as string)).toEqual({ kty: "RSA", d: "x1" });
  });
});

describe("N9 のケース表", () => {
  const cases = n9Cases();
  it("ID は一意で、対照と否定ケースがそろっている", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
    expect(byId["1"]).toMatchObject({
      signWith: "std",
      issuer: "std",
      role: "shared",
      expect: "ok",
    });
    expect(byId["2"]).toMatchObject({
      signWith: "admin",
      issuer: "admin",
      role: "admin",
      expect: "ok",
    });
    // 同じホストの別パスの issuer は別のプロバイダー: std の JWT で admin のロールに入れない
    expect(byId["3"]).toMatchObject({
      signWith: "std",
      issuer: "std",
      role: "admin",
      expect: "denied",
    });
    expect(byId["4"]).toMatchObject({
      signWith: "admin",
      issuer: "admin",
      role: "shared",
      expect: "denied",
    });
    // 鍵と issuer の食い違い（std の鍵で iss=admin）は署名の検証で落ちる
    expect(byId["5"]).toMatchObject({
      signWith: "std",
      issuer: "admin",
      role: "admin",
      expect: "error",
    });
    expect(byId["6"]).toMatchObject({ issuer: "std-slash", expect: "record" });
    expect(byId["7"]).toMatchObject({ issuer: "root", expect: "error" });
    expect(byId["8"]).toMatchObject({ role: "infra-only", team: "dev", expect: "denied" });
    expect(byId["9"]).toMatchObject({ role: "infra-only", team: "infra", expect: "ok" });
    expect(byId["10"]).toMatchObject({ role: "shared", sourceIdentity: false, expect: "denied" });
  });
  it("issuer の形", () => {
    expect(n9Issuer(BASE, "std")).toBe(`${BASE}/std`);
    expect(n9Issuer(BASE, "admin")).toBe(`${BASE}/admin`);
    expect(n9Issuer(BASE, "std-slash")).toBe(`${BASE}/std/`);
    expect(n9Issuer(BASE, "root")).toBe(BASE);
  });
  it("ロール → スタックの Output 名", () => {
    expect(n9RoleOutputKey("shared")).toBe("SharedRoleArn");
    expect(n9RoleOutputKey("infra-only")).toBe("InfraOnlyRoleArn");
    expect(n9RoleOutputKey("admin")).toBe("AdminRoleArn");
  });
});

describe("access-watch の小道具", () => {
  it("cookieHeader: トークンだけなら CF_Authorization= を付ける。Cookie 行ならそのまま。改行・空は例外", () => {
    expect(cookieHeader("eyJabc.def.ghi\n")).toBe("CF_Authorization=eyJabc.def.ghi");
    expect(cookieHeader("CF_Authorization=t1; CF_Binding=b1")).toBe(
      "CF_Authorization=t1; CF_Binding=b1",
    );
    expect(() => cookieHeader("")).toThrow();
    expect(() => cookieHeader("a=1\nb=2")).toThrow();
  });
  it("classifyWhoami: 200 でチームが一致すれば成功（iat を detail に）", () => {
    expect(
      classifyWhoami({
        status: 200,
        location: null,
        body: JSON.stringify({ verified: true, team_match: true, aud_team: "infra", iat: 100 }),
      }),
    ).toEqual({ ok: true, detail: "iat=100 aud_team=infra" });
  });
  it("classifyWhoami: Access のログインへのリダイレクト・403・Worker の 401・チームの食い違いを分ける", () => {
    expect(
      classifyWhoami({
        status: 302,
        location: "https://example-team.cloudflareaccess.com/cdn-cgi/access/login/x",
        body: "",
      }),
    ).toMatchObject({ ok: false, code: "access_login_redirect" });
    expect(classifyWhoami({ status: 403, location: null, body: "" })).toMatchObject({
      ok: false,
      code: "access_forbidden",
    });
    expect(
      classifyWhoami({ status: 401, location: null, body: JSON.stringify({ verified: false }) }),
    ).toMatchObject({ ok: false, code: "worker_unauthorized" });
    expect(
      classifyWhoami({
        status: 200,
        location: null,
        body: JSON.stringify({ verified: true, team_match: false, aud_team: "dev", iat: 1 }),
      }),
    ).toMatchObject({ ok: false, code: "team_mismatch" });
    expect(classifyWhoami({ status: 500, location: null, body: "" })).toMatchObject({
      ok: false,
      code: "http_500",
    });
  });
  it("tokenRefreshes: 対象ごとに Access JWT の iat が変わった時刻を出す", () => {
    const s = (at: string, target: string, ok: boolean, detail?: string) => ({
      at,
      target,
      ok,
      ...(detail ? { detail } : {}),
    });
    expect(
      tokenRefreshes([
        s("2026-01-01T00:00:00Z", "infra", true, "iat=100 aud_team=infra"),
        s("2026-01-01T00:00:05Z", "infra", true, "iat=100 aud_team=infra"),
        s("2026-01-01T00:00:10Z", "dev", true, "iat=50 aud_team=dev"),
        s("2026-01-01T00:00:15Z", "infra", false),
        s("2026-01-01T00:00:20Z", "infra", true, "iat=200 aud_team=infra"),
      ]),
    ).toEqual([
      { target: "infra", at: "2026-01-01T00:00:00Z", iat: 100 },
      { target: "dev", at: "2026-01-01T00:00:10Z", iat: 50 },
      { target: "infra", at: "2026-01-01T00:00:20Z", iat: 200 },
    ]);
  });
});
