import { exportJWK, generateKeyPair, importJWK, type JWK, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertPortalName,
  assertPortalProviderArn,
  assertPortalRoleArn,
  checkLoginRequest,
  escapeHtml,
  issuerFor,
  maskEmail,
  normalizePortalBase,
  parseAudMap,
  parseRoles,
  portalTokenClaims,
  providerIdOf,
  signPortalToken,
  TEAM_TAG_KEY,
  teamFromAud,
  teamFromPath,
} from "../../scripts/poc/human/portal/lib";

const BASE = "https://awsbridge-human-poc-portal.example.workers.dev";
const HOST = "awsbridge-human-poc-portal.example.workers.dev";
let privateJwk: JWK;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateJwk = await exportJWK(privateKey);
});

describe("normalizePortalBase（ポータル Worker の URL。issuer の土台）", () => {
  it("https://<host> を受け付け、末尾スラッシュは落とす", () => {
    expect(normalizePortalBase(`${BASE}/`)).toBe(BASE);
    expect(normalizePortalBase(BASE)).toBe(BASE);
  });
  it("PoC のポータルの名前（awsbridge-human-poc-portal.）で始まるホストだけ", () => {
    expect(() => normalizePortalBase("https://awsbridge.example.workers.dev")).toThrow();
    expect(() => normalizePortalBase("https://awsbridge-human-poc.example.workers.dev")).toThrow();
  });
  it("パス・ポート・http・クエリは不可", () => {
    for (const bad of [`${BASE}/std`, `http://${HOST}`, `https://${HOST}:8443`, `${BASE}?a=1`, ""])
      expect(() => normalizePortalBase(bad), bad).toThrow();
  });
});

describe("issuerFor / providerIdOf（N9: 1 つのホストのパスごとに issuer を分ける）", () => {
  it("issuer は <base>/std と <base>/admin（末尾スラッシュなし）", () => {
    expect(issuerFor(BASE, "std")).toBe(`${BASE}/std`);
    expect(issuerFor(BASE, "admin")).toBe(`${BASE}/admin`);
  });
  it("IAM の条件キーと ARN に使う名前は <host>/<path>", () => {
    expect(providerIdOf(`${BASE}/std`)).toBe(`${HOST}/std`);
    expect(providerIdOf(`${BASE}/admin`)).toBe(`${HOST}/admin`);
  });
  it("パスのない issuer・末尾スラッシュつきは providerIdOf で例外（取り違え防止）", () => {
    expect(() => providerIdOf(BASE)).toThrow();
    expect(() => providerIdOf(`${BASE}/std/`)).toThrow();
  });
});

describe("ホスト名の接頭辞（利用者が承認した awsbridge-console-poc も PoC 用として受け付ける）", () => {
  it("normalizePortalBase は awsbridge-console-poc.<zone> も受け付け、似た名前は拒否する", () => {
    expect(normalizePortalBase("https://awsbridge-console-poc.example.com/")).toBe(
      "https://awsbridge-console-poc.example.com",
    );
    for (const bad of [
      "https://awsbridge-console.example.com",
      "https://awsbridge-console-pocx.example.com",
      "https://x-awsbridge-console-poc.example.com",
    ])
      expect(() => normalizePortalBase(bad), bad).toThrow();
  });
  it("OIDC プロバイダーのガードも awsbridge-console-poc.<zone>/<path> を受け付ける", () => {
    const arn = "arn:aws:iam::123456789012:oidc-provider/awsbridge-console-poc.example.com/std";
    expect(assertPortalProviderArn(arn, "awsbridge-console-poc.example.com/std")).toBe(arn);
    expect(() =>
      assertPortalProviderArn(
        "arn:aws:iam::123456789012:oidc-provider/awsbridge-console.example.com/std",
        "awsbridge-console.example.com/std",
      ),
    ).toThrow();
  });
});

describe("ガード（破壊的な操作は PoC のポータルの名前にだけ効かせる）", () => {
  const ARN = (id: string) => `arn:aws:iam::123456789012:oidc-provider/${id}`;
  it("OIDC プロバイダー: ARN の末尾が providerId と一致し、ホストが PoC のポータル", () => {
    expect(assertPortalProviderArn(ARN(`${HOST}/std`), `${HOST}/std`)).toBe(ARN(`${HOST}/std`));
    expect(() => assertPortalProviderArn(ARN(`${HOST}/admin`), `${HOST}/std`)).toThrow();
    expect(() =>
      assertPortalProviderArn(
        ARN("awsbridge.example.workers.dev"),
        "awsbridge.example.workers.dev",
      ),
    ).toThrow();
    expect(() =>
      assertPortalProviderArn(
        ARN("awsbridge-human-poc.example.workers.dev"),
        "awsbridge-human-poc.example.workers.dev",
      ),
    ).toThrow();
  });
  it("ロール: 名前が AwsbridgeHumanPocPortal で始まる ARN だけ（既存の PoC・MCP のロールは不可）", () => {
    expect(
      assertPortalRoleArn("arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalShared"),
    ).toBe("AwsbridgeHumanPocPortalShared");
    for (const bad of [
      "arn:aws:iam::123456789012:role/AwsbridgeHumanPocTagged",
      "arn:aws:iam::123456789012:role/FederatedMcpReadOnly",
      "arn:aws:iam::123456789012:role/x/AwsbridgeHumanPocPortalShared",
    ])
      expect(() => assertPortalRoleArn(bad), bad).toThrow();
  });
  it("スタック・Worker・Access アプリの名前は awsbridge-human-poc-portal で始まるものだけ", () => {
    expect(() => assertPortalName("awsbridge-human-poc-portal")).not.toThrow();
    expect(() => assertPortalName("awsbridge-human-poc-portal-infra")).not.toThrow();
    for (const bad of ["awsbridge", "awsbridge-human-poc", "awsbridge-human-poc-portalx", ""])
      expect(() => assertPortalName(bad), bad).toThrow();
  });
});

describe("parseAudMap（Access アプリの AUD → チーム。Terraform の出力から作る）", () => {
  const aud1 = "a".repeat(64);
  const aud2 = "b".repeat(64);
  it("{aud: team} の JSON を読む", () => {
    expect(parseAudMap(JSON.stringify({ [aud1]: "infra", [aud2]: "dev" }))).toEqual({
      [aud1]: "infra",
      [aud2]: "dev",
    });
  });
  it("チーム名は小文字英数字とハイフン、AUD は空でない英数字。重複するチームは不可", () => {
    for (const bad of [
      "",
      "[]",
      "not json",
      JSON.stringify({ [aud1]: "Infra" }),
      JSON.stringify({ [aud1]: "" }),
      JSON.stringify({ "": "infra" }),
      JSON.stringify({ [aud1]: "infra", [aud2]: "infra" }),
      JSON.stringify({ [aud1]: 1 }),
    ])
      expect(() => parseAudMap(bad), bad).toThrow();
  });
});

describe("teamFromAud（チームは検証した Access JWT の AUD だけから決める）", () => {
  const map = { aaa: "infra", bbb: "dev" };
  it("文字列・配列のどちらでも、既知の AUD にちょうど 1 つ一致すればそのチーム", () => {
    expect(teamFromAud("aaa", map)).toEqual({ ok: true, team: "infra" });
    expect(teamFromAud(["zzz", "bbb"], map)).toEqual({ ok: true, team: "dev" });
  });
  it("未知・空・型違いは unknown_audience、2 つのチームに一致すれば ambiguous_audience", () => {
    expect(teamFromAud("zzz", map)).toEqual({ ok: false, code: "unknown_audience" });
    expect(teamFromAud([], map)).toEqual({ ok: false, code: "unknown_audience" });
    expect(teamFromAud(undefined, map)).toEqual({ ok: false, code: "unknown_audience" });
    expect(teamFromAud(["aaa", "bbb"], map)).toEqual({ ok: false, code: "ambiguous_audience" });
  });
  it("Object.prototype の名前は AUD として扱わない", () => {
    expect(teamFromAud("constructor", map)).toEqual({ ok: false, code: "unknown_audience" });
  });
});

describe("teamFromPath（パスのチームは経路の振り分けと食い違いの検出にだけ使う）", () => {
  it("/t/<team> と /t/<team>/... からチーム名", () => {
    expect(teamFromPath("/t/infra")).toBe("infra");
    expect(teamFromPath("/t/infra/")).toBe("infra");
    expect(teamFromPath("/t/dev/login")).toBe("dev");
  });
  it("それ以外は undefined", () => {
    for (const p of ["/", "/t/", "/t/Infra/", "/x/infra/", "/t/../infra", "/tt/infra"])
      expect(teamFromPath(p), p).toBeUndefined();
  });
});

describe("parseRoles（ログインで選べるロール。Worker はチームで絞らず、信頼ポリシーに判断させる）", () => {
  it("[{label, arn}] を読む", () => {
    const roles = [
      { label: "shared", arn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalShared" },
    ];
    expect(parseRoles(JSON.stringify(roles))).toEqual(roles);
  });
  it("空でも可（AWS のスタックを作る前のデプロイ）", () => {
    expect(parseRoles("")).toEqual([]);
    expect(parseRoles(undefined)).toEqual([]);
  });
  it("PoC のポータルのロールでない ARN・ラベルの重複は不可", () => {
    expect(() =>
      parseRoles(
        JSON.stringify([{ label: "x", arn: "arn:aws:iam::1:role/AwsbridgeHumanPocPortalX" }]),
      ),
    ).toThrow();
    expect(() =>
      parseRoles(
        JSON.stringify([
          { label: "x", arn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocTagged" },
        ]),
      ),
    ).toThrow();
    const r = { label: "x", arn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocPortalX" };
    expect(() => parseRoles(JSON.stringify([r, r]))).toThrow();
  });
});

describe("portalTokenClaims / signPortalToken（ポータルが STS に渡す JWT）", () => {
  it("タグ awsbridge_team（入れ子形式・単一値）と SourceIdentity（= email）を入れる", () => {
    const c = portalTokenClaims({
      issuer: `${BASE}/std`,
      audience: "awsbridge-human-poc-portal",
      subject: "user@example.com",
      team: "infra",
      sourceIdentity: "user@example.com",
      now: 1000,
    });
    expect(TEAM_TAG_KEY).toBe("awsbridge_team");
    expect(c).toEqual({
      iss: `${BASE}/std`,
      aud: "awsbridge-human-poc-portal",
      sub: "user@example.com",
      iat: 1000,
      exp: 1300,
      "https://aws.amazon.com/tags": { principal_tags: { awsbridge_team: ["infra"] } },
      "https://aws.amazon.com/source_identity": "user@example.com",
    });
  });
  it("チームと SourceIdentity は省略できる（N9 の否定ケース用）", () => {
    const c = portalTokenClaims({
      issuer: `${BASE}/std/`,
      audience: "a",
      subject: "s1",
      now: 0,
      ttlSeconds: 60,
    });
    expect(c).toEqual({ iss: `${BASE}/std/`, aud: "a", sub: "s1", iat: 0, exp: 60 });
  });
  it("iss は https の URL だけ（N9 で末尾スラッシュつきも試すので、それは通す）", () => {
    expect(() =>
      portalTokenClaims({ issuer: "http://x/std", audience: "a", subject: "s", now: 0 }),
    ).toThrow();
  });
  it("署名した JWT は公開鍵で検証でき、kid は thumbprint", async () => {
    const token = await signPortalToken({
      privateJwk,
      issuer: `${BASE}/admin`,
      audience: "awsbridge-human-poc-portal",
      subject: "user@example.com",
      team: "infra",
      sourceIdentity: "user@example.com",
    });
    const pub = await importJWK(
      { kty: "RSA", n: privateJwk.n as string, e: privateJwk.e as string },
      "RS256",
    );
    const { payload, protectedHeader } = await jwtVerify(token, pub, {
      issuer: `${BASE}/admin`,
      audience: "awsbridge-human-poc-portal",
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(typeof protectedHeader.kid).toBe("string");
    expect(payload["https://aws.amazon.com/source_identity"]).toBe("user@example.com");
  });
});

describe("checkLoginRequest（POST /t/<team>/login の Origin・Content-Type）", () => {
  const ok = {
    origin: BASE,
    secFetchSite: "same-origin",
    contentType: "application/x-www-form-urlencoded",
    expectedOrigin: BASE,
  };
  it("同じオリジンのフォーム送信は通す（Sec-Fetch-Site がなくても可）", () => {
    expect(checkLoginRequest(ok)).toBeUndefined();
    expect(checkLoginRequest({ ...ok, secFetchSite: null })).toBeUndefined();
    expect(
      checkLoginRequest({ ...ok, contentType: "application/x-www-form-urlencoded; charset=UTF-8" }),
    ).toBeUndefined();
  });
  it("Origin がない・違う、Sec-Fetch-Site が same-origin でなければ 403 forbidden_origin", () => {
    for (const v of [
      { ...ok, origin: null },
      { ...ok, origin: "null" },
      { ...ok, origin: "https://evil.example.com" },
      { ...ok, secFetchSite: "cross-site" },
    ])
      expect(checkLoginRequest(v)).toEqual({ status: 403, code: "forbidden_origin" });
  });
  it("Content-Type がフォームでなければ 415", () => {
    expect(checkLoginRequest({ ...ok, contentType: "application/json" })).toEqual({
      status: 415,
      code: "unsupported_media_type",
    });
  });
});

describe("表示の小道具", () => {
  it("maskEmail は u***@***.com の形", () => {
    expect(maskEmail("user@example.com")).toBe("u***@***.com");
    expect(maskEmail("not-an-email")).toBe("***");
  });
  it("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">'&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;",
    );
  });
});
