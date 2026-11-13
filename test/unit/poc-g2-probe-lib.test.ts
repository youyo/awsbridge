// G2 の試験用の issuer（poc:g2:probe:*）の純粋関数。隔離の条件（手順書 §2.6.1、adr の Q2）をコードで守ることを確かめる。
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { handleProbeRequest } from "../../scripts/poc/g2/probe-handler";
import {
  assertProbeAudience,
  assertProbeIssuer,
  assertProbeRoleArn,
  assumeProbe,
  headerLine,
  PROBE_DEFAULTS,
  parseKeyNames,
  probeDocuments,
  probeIssuer,
  probeSettings,
  probeWranglerConfig,
  realHostsFrom,
  refusalOf,
  signProbeToken,
  stsEndpointFrom,
} from "../../scripts/poc/g2/probe-lib";
import { securityHeaders } from "../../src/console/http/headers";
import { publicJwkOf } from "../../src/keys";

const ZONE = "dev.example.com";
const ISSUER = `https://awsbridge-g2-probe-kid.${ZONE}/p`;
const ROLE = "arn:aws:iam::123456789012:role/awsbridge-g2-probe/AwsbridgeG2ProbeKid";
let privateJwk: JWK;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateJwk = await exportJWK(privateKey);
});

describe("試験用の issuer の名前", () => {
  it("issuer は https://awsbridge-g2-probe-<label>.<zone>/p", () => {
    expect(probeIssuer("n5", ZONE)).toBe(`https://awsbridge-g2-probe-n5.${ZONE}/p`);
    expect(probeIssuer("kid", ZONE)).toBe(ISSUER);
  });

  it("label は英小文字と数字だけ。console を含む label・形の違うゾーンは断る", () => {
    for (const l of ["", "N5", "a-b", "console", "xconsolex", "a".repeat(17)])
      expect(() => probeIssuer(l, ZONE), l).toThrow();
    for (const z of ["", "example", "-x.example.com", "x.example.com/p", "x.example.com:443"])
      expect(() => probeIssuer("n5", z), z).toThrow();
  });

  it("設定: 鍵・文書・デプロイ用の設定は <dir>/probe/<label>/ の下、Worker 名は awsbridge-g2-probe-<label>", () => {
    const s = probeSettings(
      { AWSBRIDGE_G2_DEV_DIR: "/tmp/g2", AWSBRIDGE_G2_PROBE_ZONE: ZONE },
      "kid",
    );
    expect(s.issuer).toBe(ISSUER);
    expect(s.host).toBe(`awsbridge-g2-probe-kid.${ZONE}`);
    expect(s.workerName).toBe("awsbridge-g2-probe-kid");
    expect(s.dir).toBe("/tmp/g2/probe/kid");
    expect(s.documentsFile).toBe("/tmp/g2/probe/kid/issuer-documents.json");
    expect(s.audience).toBe("awsbridge-g2-probe");
    expect(s.subject).toBe("g2-probe");
    expect(s.region).toBe("ap-northeast-1");
  });
});

describe("隔離の条件: aud", () => {
  it("既定の aud は awsbridge-g2-probe", () => {
    expect(PROBE_DEFAULTS.audience).toBe("awsbridge-g2-probe");
    expect(assertProbeAudience("awsbridge-g2-probe")).toBe("awsbridge-g2-probe");
  });

  it("awsbridge-console（大文字・前後の空白も）と MCP の aud（awsbridge）は断る", () => {
    for (const a of ["awsbridge-console", "AWSBRIDGE-CONSOLE", " awsbridge-console ", "awsbridge"])
      expect(() => assertProbeAudience(a), a).toThrow(/aud/);
  });

  it("設定で aud を awsbridge-console にしても断る", () => {
    expect(() =>
      probeSettings(
        { AWSBRIDGE_G2_PROBE_ZONE: ZONE, AWSBRIDGE_G2_PROBE_AUDIENCE: "awsbridge-console" },
        "kid",
      ),
    ).toThrow(/aud/);
  });
});

describe("隔離の条件: 本物の issuer のホスト", () => {
  it("試験用の接頭辞のホストでなければ断る", () => {
    expect(assertProbeIssuer(ISSUER, new Set()).host).toBe(`awsbridge-g2-probe-kid.${ZONE}`);
    for (const i of [
      `https://awsbridge-oidc-console.${ZONE}/standard`,
      `https://awsbridge-oidc-admin-console.${ZONE}/admin`,
      `https://awsbridge-console.${ZONE}/p`,
      `https://x.awsbridge-g2-probe-kid.${ZONE}/p`,
      `http://awsbridge-g2-probe-kid.${ZONE}/p`,
      `https://awsbridge-g2-probe-kid.${ZONE}/p/`,
      `https://awsbridge-g2-probe-kid.${ZONE}:8443/p`,
      `https://awsbridge-g2-probe-kid.${ZONE}/p?x=1`,
    ])
      expect(() => assertProbeIssuer(i, new Set()), i).toThrow();
  });

  it("本物の issuer・ポータルのホストの一覧に当たれば断る", () => {
    const real = new Set([`awsbridge-g2-probe-kid.${ZONE}`]);
    expect(() => assertProbeIssuer(ISSUER, real)).toThrow(/本物/);
  });

  it("本物のホストの一覧: MCP の issuer・コンソールの設定のポータルと issuer・AWSBRIDGE_G2_PROBE_REAL_HOSTS", () => {
    const config = JSON.stringify({
      portal: {
        standardOrigin: "https://awsbridge-console.example.com",
        adminOrigin: "https://awsbridge-admin-console.example.com",
      },
      boundaries: [
        {
          name: "managed",
          issuers: {
            standard: "https://awsbridge-oidc-console.example.com/standard",
            admin: "https://awsbridge-oidc-admin-console.example.com/admin",
          },
        },
      ],
    });
    const hosts = realHostsFrom(
      {
        AWSBRIDGE_ISSUER: "https://awsbridge-oidc-mcp.example.com",
        AWSBRIDGE_G2_PROBE_REAL_HOSTS: "a.example.com, B.example.com",
      },
      config,
    );
    expect([...hosts].sort()).toEqual(
      [
        "a.example.com",
        "awsbridge-admin-console.example.com",
        "awsbridge-console.example.com",
        "awsbridge-oidc-admin-console.example.com",
        "awsbridge-oidc-console.example.com",
        "awsbridge-oidc-mcp.example.com",
        "b.example.com",
      ].sort(),
    );
    // 設定が読めなくても落ちない（その分は接頭辞の検査で守る）
    expect([...realHostsFrom({}, "{not json")]).toEqual([]);
  });
});

describe("隔離の条件: 引き受けるロール", () => {
  it("パスが /awsbridge-g2-probe/ のロールだけを受け付ける", () => {
    expect(assertProbeRoleArn(ROLE)).toBe(ROLE);
  });

  it("パスが /awsbridge-console/ の下なら断る（std・admin・深いパスも）", () => {
    for (const p of ["awsbridge-console/std", "awsbridge-console/admin", "awsbridge-console/x/y"])
      expect(
        () => assertProbeRoleArn(`arn:aws:iam::123456789012:role/${p}/FederatedAwsBridgeViewer`),
        p,
      ).toThrow(/awsbridge-console/);
  });

  it("試験用のパスでないロール・形の違う ARN も断る", () => {
    for (const a of [
      "arn:aws:iam::123456789012:role/FederatedAwsBridgeAdministrator",
      "arn:aws:iam::123456789012:role/awsbridge-g2-ctrl/AwsbridgeG2CtrlChain",
      "arn:aws:iam::123456789012:role/awsbridge-g2-probe-x/R",
      "arn:aws:iam::12345678901:role/awsbridge-g2-probe/R",
      "arn:aws:iam::123456789012:user/awsbridge-g2-probe/R",
      "",
    ])
      expect(() => assertProbeRoleArn(a), a).toThrow();
  });
});

describe("JWT（指定の鍵 = kid で署名。aud は awsbridge-g2-probe、exp = iat + 300）", () => {
  it("header の kid は鍵の thumbprint、claim は iss・aud・sub・iat・exp・jti", async () => {
    const pub = await publicJwkOf(privateJwk);
    const r = await signProbeToken({
      privateJwk,
      issuer: ISSUER,
      audience: "awsbridge-g2-probe",
      subject: "g2-probe",
      now: 1_800_000_000,
      realHosts: new Set(),
    });
    expect(r.kid).toBe(pub.kid);
    const h = decodeProtectedHeader(r.token);
    expect(h).toEqual({ alg: "RS256", kid: pub.kid, typ: "JWT" });
    const c = decodeJwt(r.token);
    expect(c).toEqual({
      iss: ISSUER,
      aud: "awsbridge-g2-probe",
      sub: "g2-probe",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      jti: r.jti,
    });
    expect(r.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("署名の前に隔離の条件を見る（aud・issuer）", async () => {
    const base = {
      privateJwk,
      issuer: ISSUER,
      audience: "awsbridge-g2-probe",
      subject: "g2-probe",
      realHosts: new Set<string>(),
    };
    await expect(signProbeToken({ ...base, audience: "awsbridge-console" })).rejects.toThrow(/aud/);
    await expect(
      signProbeToken({ ...base, issuer: `https://awsbridge-oidc-console.${ZONE}/standard` }),
    ).rejects.toThrow();
    await expect(
      signProbeToken({ ...base, realHosts: new Set([`awsbridge-g2-probe-kid.${ZONE}`]) }),
    ).rejects.toThrow(/本物/);
  });
});

describe("issuer の文書と鍵の選び方", () => {
  it("discovery は本物の issuer と同じ形、JWKS は選んだ鍵の公開鍵だけ（順も保つ）", async () => {
    const { privateKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });
    const other = await exportJWK(privateKey);
    const a = await publicJwkOf(privateJwk);
    const b = await publicJwkOf(other);
    const docs = probeDocuments(ISSUER, [b, a], new Set());
    expect(docs.discovery.issuer).toBe(ISSUER);
    expect(docs.discovery.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(docs.jwks.keys.map((k) => k.kid)).toEqual([b.kid, a.kid]);
    expect(JSON.stringify(docs)).not.toContain(privateJwk.d as string);
    expect(() => probeDocuments(ISSUER, [a, { ...a, d: "x" }], new Set())).toThrow(/秘密/);
    expect(() => probeDocuments(ISSUER, [], new Set())).toThrow();
  });

  it("鍵の名前の一覧（A,B）。知らない名前・重複・空は断る", () => {
    expect(parseKeyNames("A,B", ["A", "B", "C"])).toEqual(["A", "B"]);
    expect(parseKeyNames(" B , A ", ["A", "B"])).toEqual(["B", "A"]);
    expect(() => parseKeyNames("A,Z", ["A"])).toThrow(/Z/);
    expect(() => parseKeyNames("A,A", ["A"])).toThrow();
    expect(() => parseKeyNames("", ["A"])).toThrow();
  });
});

describe("デプロイ用の wrangler の設定", () => {
  const template = {
    $schema: "x",
    name: "awsbridge-g2-probe",
    main: "probe-worker.ts",
    compatibility_date: "2026-07-21",
    workers_dev: false,
    preview_urls: false,
    alias: { "awsbridge-g2-probe-documents": "x.json" },
  };

  it("Worker 名・Custom Domain は issuer ごと、workers.dev と Preview URL は無効", () => {
    const cfg = probeWranglerConfig(template, {
      templateDir: "/repo/scripts/poc/g2",
      workerName: "awsbridge-g2-probe-kid",
      host: `awsbridge-g2-probe-kid.${ZONE}`,
      documentsFile: "/tmp/g2/probe/kid/issuer-documents.json",
    });
    expect(cfg).toEqual({
      name: "awsbridge-g2-probe-kid",
      main: "/repo/scripts/poc/g2/probe-worker.ts",
      compatibility_date: "2026-07-21",
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: `awsbridge-g2-probe-kid.${ZONE}`, custom_domain: true }],
      alias: { "awsbridge-g2-probe-documents": "/tmp/g2/probe/kid/issuer-documents.json" },
    });
  });

  it("試験用の名前・ホストでなければ断る。テンプレートが workers.dev を開けていても断る", () => {
    const p = {
      templateDir: "/r",
      workerName: "awsbridge-g2-probe-kid",
      host: `awsbridge-g2-probe-kid.${ZONE}`,
      documentsFile: "/d.json",
    };
    expect(() =>
      probeWranglerConfig(template, { ...p, workerName: "awsbridge-console-admin" }),
    ).toThrow();
    expect(() =>
      probeWranglerConfig(template, { ...p, host: `awsbridge-oidc-admin-console.${ZONE}` }),
    ).toThrow();
    expect(() => probeWranglerConfig({ ...template, workers_dev: true }, p)).toThrow();
    expect(() => probeWranglerConfig({ ...template, preview_urls: true }, p)).toThrow();
  });
});

describe("STS の呼び出し（fetch を差し替える）", () => {
  const ok = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIAEXAMPLEEXAMPLE00</AccessKeyId><SecretAccessKey>s3cr3t</SecretAccessKey><SessionToken>tok</SessionToken><Expiration>2026-11-13T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/AwsbridgeG2ProbeKid/g2-probe-A</Arn><AssumedRoleId>AROAEXAMPLE:g2-probe-A</AssumedRoleId></AssumedRoleUser></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>rid-1</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`;
  const err = (code: string, msg: string) =>
    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${msg}</Message></Error><RequestId>rid-2</RequestId></ErrorResponse>`;

  it("成功は ok だけを返し、認証情報を返さない。送るのはフォームの AssumeRoleWithWebIdentity", async () => {
    const calls: { url: string; body: string }[] = [];
    const r = await assumeProbe({
      endpoint: "https://sts.ap-northeast-1.amazonaws.com/",
      roleArn: ROLE,
      token: "t.o.k",
      sessionName: "g2-probe-A",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(ok, { status: 200 });
      },
    });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(JSON.stringify(r)).not.toContain("s3cr3t");
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(body.get("RoleArn")).toBe(ROLE);
    expect(body.get("WebIdentityToken")).toBe("t.o.k");
  });

  it("失敗はエラーコードと伏せ字の要約（トークン・アカウント ID を出さない）", async () => {
    const r = await assumeProbe({
      endpoint: "https://sts.ap-northeast-1.amazonaws.com/",
      roleArn: ROLE,
      token: "t.o.k",
      sessionName: "s",
      fetch: async () =>
        new Response(err("InvalidIdentityToken", "bad t.o.k for arn:aws:iam::123456789012:x"), {
          status: 400,
        }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("InvalidIdentityToken");
    expect(r.status).toBe(400);
    expect(r.detail).not.toContain("t.o.k");
    expect(r.detail).not.toContain("123456789012");
  });

  it("通信の失敗は NetworkError", async () => {
    const r = await assumeProbe({
      endpoint: "https://sts.ap-northeast-1.amazonaws.com/",
      roleArn: ROLE,
      token: "x",
      sessionName: "s",
      fetch: async () => {
        throw new Error("boom");
      },
    });
    expect(r).toMatchObject({ ok: false, code: "NetworkError" });
  });

  it("コンソールのロールには STS を呼ばずに断る", async () => {
    let called = 0;
    await expect(
      assumeProbe({
        endpoint: "https://sts.ap-northeast-1.amazonaws.com/",
        roleArn:
          "arn:aws:iam::123456789012:role/awsbridge-console/admin/FederatedAwsBridgeAdministrator",
        token: "x",
        sessionName: "s",
        fetch: async () => {
          called++;
          return new Response(ok);
        },
      }),
    ).rejects.toThrow(/awsbridge-console/);
    expect(called).toBe(0);
  });

  it("STS の宛先: 既定はリージョンの STS、試験用の上書きは http://127.0.0.1:<port> だけ", () => {
    expect(stsEndpointFrom({}, "ap-northeast-1")).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(stsEndpointFrom({ AWSBRIDGE_G2_PROBE_STS_ENDPOINT: "http://127.0.0.1:8123" }, "x")).toBe(
      "http://127.0.0.1:8123/",
    );
    for (const v of ["https://sts.example.com", "http://localhost:1", "http://127.0.0.1"])
      expect(() => stsEndpointFrom({ AWSBRIDGE_G2_PROBE_STS_ENDPOINT: v }, "x"), v).toThrow();
  });
});

describe("試験用の issuer の Worker の応答（probe-handler）", () => {
  let docs: ReturnType<typeof probeDocuments>;
  beforeAll(async () => {
    docs = probeDocuments(ISSUER, [await publicJwkOf(privateJwk)], new Set());
  });
  const req = (path: string, method = "GET") =>
    new Request(`https://awsbridge-g2-probe-kid.${ZONE}${path}`, { method });

  it("<issuer のパス>/.well-known の 2 つを返す。ヘッダーは本物の issuer と同じ（JSON + セキュリティのヘッダー、no-store）", async () => {
    for (const [path, body] of [
      ["/p/.well-known/openid-configuration", docs.discovery],
      ["/p/.well-known/jwks.json", docs.jwks],
    ] as const) {
      const r = handleProbeRequest(req(path), docs);
      expect(r.status, path).toBe(200);
      expect(await r.json()).toEqual(body);
      const headers = Object.fromEntries(r.headers.entries());
      const expected = Object.fromEntries(
        Object.entries({ "Content-Type": "application/json", ...securityHeaders("page") }).map(
          ([k, v]) => [k.toLowerCase(), v],
        ),
      );
      expect(headers).toEqual(expected);
    }
  });

  it("ルートの .well-known・ほかのパスは 404、POST は 405、HEAD は本文なし", async () => {
    expect(handleProbeRequest(req("/.well-known/jwks.json"), docs).status).toBe(404);
    expect(handleProbeRequest(req("/p"), docs).status).toBe(404);
    expect(handleProbeRequest(req("/p/oauth/token"), docs).status).toBe(404);
    const post = handleProbeRequest(req("/p/.well-known/jwks.json", "POST"), docs);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const head = handleProbeRequest(req("/p/.well-known/jwks.json", "HEAD"), docs);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("refusalOf（延長の止め方に数える結果。通信の失敗は数えない）", () => {
  it("成功は false、STS の 4xx の拒否は true、通信の失敗・時間切れ・5xx は undefined（数えない）", () => {
    expect(refusalOf({ ok: true, status: 200 })).toBe(false);
    expect(refusalOf({ ok: false, code: "InvalidIdentityToken", status: 400, detail: "" })).toBe(
      true,
    );
    expect(refusalOf({ ok: false, code: "AccessDenied", status: 403, detail: "" })).toBe(true);
    expect(refusalOf({ ok: false, code: "NetworkError", status: 0, detail: "" })).toBeUndefined();
    expect(refusalOf({ ok: false, code: "Timeout", status: 0, detail: "" })).toBeUndefined();
    expect(
      refusalOf({ ok: false, code: "ServiceUnavailable", status: 503, detail: "" }),
    ).toBeUndefined();
  });
});

describe("headerLine（check が出す応答ヘッダーの 1 行）", () => {
  it("Set-Cookie の値は出さない。ほかはそのまま", () => {
    expect(headerLine("cache-control", "no-store")).toBe("cache-control: no-store");
    expect(headerLine("Set-Cookie", "__cf_bm=abc; Path=/")).toBe("Set-Cookie: (省略)");
  });
});
