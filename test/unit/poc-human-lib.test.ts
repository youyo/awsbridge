import { exportJWK, generateKeyPair, importJWK, type JWK, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assumeRoleWithWebIdentityParams,
  consoleDestination,
  consoleUrlFileName,
  FEDERATION_ENDPOINT,
  getSigninTokenParams,
  humanPocSettings,
  humanSessionName,
  humanTokenClaims,
  issuerDocuments,
  issuerHost,
  loginUrl,
  normalizeIssuer,
  parseSessionDurations,
  parseSigninTokenResponse,
  sessionDurationLabel,
  signHumanToken,
  stsEndpoint,
  summarizeBody,
} from "../../scripts/poc/human/lib";

const ISSUER = "https://awsbridge-human-poc.example.workers.dev";
let privateJwk: JWK;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateJwk = await exportJWK(privateKey);
});

describe("normalizeIssuer / issuerHost", () => {
  it("末尾スラッシュを落とす", () => {
    expect(normalizeIssuer(`${ISSUER}/`)).toBe(ISSUER);
    expect(normalizeIssuer(`${ISSUER}//`)).toBe(ISSUER);
    expect(normalizeIssuer(ISSUER)).toBe(ISSUER);
  });
  it("https のホストだけを受け付ける（パス・クエリ・http・空は例外）", () => {
    for (const bad of [
      "",
      "http://awsbridge-human-poc.example.workers.dev",
      `${ISSUER}/path`,
      `${ISSUER}?a=b`,
      "awsbridge-human-poc.example.workers.dev",
      'https://a"b.example.com',
    ])
      expect(() => normalizeIssuer(bad), bad).toThrow();
  });
  it("issuerHost は https:// と末尾スラッシュを除いたホスト", () => {
    expect(issuerHost(`${ISSUER}/`)).toBe("awsbridge-human-poc.example.workers.dev");
  });
});

describe("humanPocSettings", () => {
  it("既定値（MCP 用の awsbridge とは別の名前）", () => {
    const s = humanPocSettings({});
    expect(s.audience).toBe("awsbridge-human-poc");
    expect(s.stackName).toBe("awsbridge-human-poc");
    expect(s.awsProfile).toBe("awsbridge");
    expect(s.region).toBe("ap-northeast-1");
    expect(s.keyFile.endsWith("/.secrets/poc-human/signing-key.json")).toBe(true);
    expect(s.outDir.endsWith("/.secrets/poc-human")).toBe(true);
    expect(s.documentsFile.endsWith("/.secrets/poc-human/issuer-documents.json")).toBe(true);
    expect(s.issuer).toBeUndefined();
    expect(s.subject).toBeUndefined();
  });
  it("MCP 経路の変数（AWSBRIDGE_ISSUER など）は読まない", () => {
    const s = humanPocSettings({
      AWSBRIDGE_ISSUER: "https://awsbridge.example.workers.dev",
      AWSBRIDGE_AUDIENCE: "awsbridge",
      AWSBRIDGE_STACK_NAME: "awsbridge",
      AWSBRIDGE_KEY_FILE: "/k/mcp.json",
      AWSBRIDGE_POC_SUBJECT: "mcp@example.com",
    });
    expect(s.issuer).toBeUndefined();
    expect(s.subject).toBeUndefined();
    expect(s.audience).toBe("awsbridge-human-poc");
    expect(s.stackName).toBe("awsbridge-human-poc");
    expect(s.keyFile).not.toBe("/k/mcp.json");
  });
  it("AWSBRIDGE_HUMAN_POC_* と AWS_PROFILE / AWS_REGION で上書きできる", () => {
    const s = humanPocSettings({
      AWSBRIDGE_HUMAN_POC_ISSUER: `${ISSUER}/`,
      AWSBRIDGE_HUMAN_POC_SUBJECT: "User@Example.com",
      AWSBRIDGE_HUMAN_POC_AUDIENCE: "aud-x",
      AWSBRIDGE_HUMAN_POC_STACK_NAME: "stack-x",
      AWSBRIDGE_HUMAN_POC_KEY_FILE: "/k/human.json",
      AWS_PROFILE: "prof-x",
      AWS_REGION: "us-west-2",
    });
    expect(s.issuer).toBe(ISSUER);
    expect(s.subject).toBe("user@example.com");
    expect(s.audience).toBe("aud-x");
    expect(s.stackName).toBe("stack-x");
    expect(s.keyFile).toBe("/k/human.json");
    expect(s.awsProfile).toBe("prof-x");
    expect(s.region).toBe("us-west-2");
  });
  it("AWSBRIDGE_HUMAN_POC_OUT_DIR で出力先（鍵の既定・issuer の文書）を変えられる", () => {
    const s = humanPocSettings({ AWSBRIDGE_HUMAN_POC_OUT_DIR: "/o/poc" });
    expect(s.outDir).toBe("/o/poc");
    expect(s.keyFile).toBe("/o/poc/signing-key.json");
    expect(s.documentsFile).toBe("/o/poc/issuer-documents.json");
  });
  it("空文字は未設定として既定値を使う", () => {
    const s = humanPocSettings({ AWSBRIDGE_HUMAN_POC_AUDIENCE: "", AWS_REGION: "" });
    expect(s.audience).toBe("awsbridge-human-poc");
    expect(s.region).toBe("ap-northeast-1");
  });
});

describe("humanTokenClaims / signHumanToken", () => {
  it("iss・aud・sub・iat・exp（既定 300 秒）", () => {
    expect(
      humanTokenClaims({
        issuer: `${ISSUER}/`,
        audience: "awsbridge-human-poc",
        subject: "user@example.com",
        now: 1000,
      }),
    ).toEqual({
      iss: ISSUER,
      aud: "awsbridge-human-poc",
      sub: "user@example.com",
      iat: 1000,
      exp: 1300,
    });
  });
  it("ttlSeconds を指定できる", () => {
    const c = humanTokenClaims({
      issuer: ISSUER,
      audience: "a",
      subject: "s@example.com",
      now: 10,
      ttlSeconds: 60,
    });
    expect(c.exp).toBe(70);
  });
  it("署名した JWT は公開鍵で検証でき、kid は JWKS の kid と一致する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signHumanToken({
      privateJwk,
      issuer: `${ISSUER}/`,
      audience: "awsbridge-human-poc",
      subject: "user@example.com",
      now,
    });
    const docs = await issuerDocuments(ISSUER, privateJwk);
    const pub = docs.jwks.keys[0] as JWK;
    const { payload, protectedHeader } = await jwtVerify(token, await importJWK(pub, "RS256"), {
      issuer: ISSUER,
      audience: "awsbridge-human-poc",
    });
    expect(payload.sub).toBe("user@example.com");
    expect(payload.exp).toBe(now + 300);
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe(pub.kid);
  });
});

describe("issuerDocuments", () => {
  it("discovery は src/oidc.ts と同じ必須項目を持つ", async () => {
    const { discovery } = await issuerDocuments(`${ISSUER}/`, privateJwk);
    expect(discovery).toEqual({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: ["sub", "aud", "exp", "iat", "iss", "email"],
    });
  });
  it("JWKS は公開成分だけ（秘密成分を含まない）", async () => {
    const { jwks } = await issuerDocuments(ISSUER, privateJwk);
    expect(jwks.keys).toHaveLength(1);
    const k = jwks.keys[0] as Record<string, unknown>;
    expect(Object.keys(k).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    for (const p of ["d", "p", "q", "dp", "dq", "qi"]) expect(k[p], p).toBeUndefined();
    expect(JSON.stringify(jwks)).not.toContain(privateJwk.d as string);
  });
  it("壊れた鍵は例外", async () => {
    await expect(issuerDocuments(ISSUER, { kty: "RSA", n: "abc", e: "AQAB" })).rejects.toThrow();
  });
});

describe("STS", () => {
  it("stsEndpoint はリージョンのエンドポイント", () => {
    expect(stsEndpoint("ap-northeast-1")).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(() => stsEndpoint("bad region")).toThrow();
  });
  it("humanSessionName は human- 接頭辞で 64 文字以内、許可文字だけ", () => {
    expect(humanSessionName("user@example.com")).toBe("human-user@example.com");
    const long = humanSessionName(`${"a".repeat(100)}@example.com`);
    expect(long.length).toBe(64);
    expect(humanSessionName("a b/c@example.com")).toBe("human-abc@example.com");
  });
  it("AssumeRoleWithWebIdentity のパラメーター（DurationSeconds は指定したときだけ）", () => {
    const base = {
      roleArn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPoc",
      roleSessionName: "human-user@example.com",
      webIdentityToken: "jwt",
    };
    const p = assumeRoleWithWebIdentityParams(base);
    expect(Object.fromEntries(p)).toEqual({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: base.roleArn,
      RoleSessionName: base.roleSessionName,
      WebIdentityToken: "jwt",
    });
    expect(
      assumeRoleWithWebIdentityParams({ ...base, durationSeconds: 43200 }).get("DurationSeconds"),
    ).toBe("43200");
  });
});

describe("Federation エンドポイント", () => {
  const creds = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret/+=key",
    sessionToken: "token+/=",
  };
  it("FEDERATION_ENDPOINT", () => {
    expect(FEDERATION_ENDPOINT).toBe("https://signin.aws.amazon.com/federation");
  });
  it("getSigninToken: Session は sessionId / sessionKey / sessionToken の JSON、SessionDuration なし", () => {
    const p = getSigninTokenParams(creds);
    expect(p.get("Action")).toBe("getSigninToken");
    expect(p.has("SessionDuration")).toBe(false);
    expect(JSON.parse(p.get("Session") as string)).toEqual({
      sessionId: "ASIAEXAMPLE",
      sessionKey: "secret/+=key",
      sessionToken: "token+/=",
    });
    // フォームエンコードで + や / がエスケープされる
    expect(p.toString()).toContain("secret%2F%2B%3Dkey");
  });
  it("getSigninToken: SessionDuration あり", () => {
    expect(getSigninTokenParams(creds, 43200).get("SessionDuration")).toBe("43200");
  });
  it("parseSigninTokenResponse は SigninToken を取り出す。無い・壊れていれば undefined", () => {
    expect(parseSigninTokenResponse('{"SigninToken":"abc"}')).toBe("abc");
    expect(parseSigninTokenResponse("{}")).toBeUndefined();
    expect(parseSigninTokenResponse('{"SigninToken":""}')).toBeUndefined();
    expect(parseSigninTokenResponse("<html>error</html>")).toBeUndefined();
  });
  it("loginUrl は Action=login・Issuer・Destination・SigninToken", () => {
    const u = new URL(
      loginUrl({
        signinToken: "tok-en_123",
        issuer: ISSUER,
        destination: consoleDestination("ap-northeast-1"),
      }),
    );
    expect(`${u.origin}${u.pathname}`).toBe(FEDERATION_ENDPOINT);
    expect(u.searchParams.get("Action")).toBe("login");
    expect(u.searchParams.get("Issuer")).toBe(ISSUER);
    expect(u.searchParams.get("Destination")).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
    );
    expect(u.searchParams.get("SigninToken")).toBe("tok-en_123");
  });
});

describe("parseSessionDurations / sessionDurationLabel", () => {
  it("none は指定なし、数値は 900〜43200", () => {
    expect(parseSessionDurations("none,43200,43199")).toEqual([undefined, 43200, 43199]);
    expect(parseSessionDurations(" none , 900 ")).toEqual([undefined, 900]);
  });
  it("範囲外・数値でない・空は例外", () => {
    for (const bad of ["", "899", "43201", "abc", "none,,43200", "1.5"])
      expect(() => parseSessionDurations(bad), bad).toThrow();
  });
  it("重複は 1 つにまとめる", () => {
    expect(parseSessionDurations("43200,43200,none,none")).toEqual([43200, undefined]);
  });
  it("ラベル", () => {
    expect(sessionDurationLabel(undefined)).toBe("none");
    expect(sessionDurationLabel(43200)).toBe("43200");
  });
});

describe("consoleUrlFileName", () => {
  it("STS の DurationSeconds と SessionDuration の両方を名前に入れる（別の回の URL と取り違えない）", () => {
    expect(consoleUrlFileName(undefined, undefined)).toBe("console-url-dur-default-sd-none.txt");
    expect(consoleUrlFileName(undefined, 43200)).toBe("console-url-dur-default-sd-43200.txt");
    expect(consoleUrlFileName(43200, undefined)).toBe("console-url-dur-43200-sd-none.txt");
    expect(consoleUrlFileName(43200, 43199)).toBe("console-url-dur-43200-sd-43199.txt");
  });
});

describe("summarizeBody", () => {
  it("タグを除き、空白を詰め、長さを切り詰める", () => {
    expect(summarizeBody("<html><body>Bad   request\n here</body></html>", [])).toBe(
      "Bad request here",
    );
    expect(summarizeBody("x".repeat(500), []).length).toBeLessThanOrEqual(201);
  });
  it("機密値は伏せる", () => {
    const s = summarizeBody("error for ASIAEXAMPLE token+/= end", ["ASIAEXAMPLE", "token+/=", ""]);
    expect(s).not.toContain("ASIAEXAMPLE");
    expect(s).not.toContain("token+/=");
    expect(s).toContain("[REDACTED]");
  });
});
