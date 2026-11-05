import { describe, expect, it } from "vitest";
import {
  type AssumedCredentials,
  assumeRoleWithWebIdentity,
  createCredentialCache,
  StsError,
} from "../../src/sts";

const ROLE = "arn:aws:iam::123456789012:role/awsbridge";
const ARN = "arn:aws:sts::123456789012:assumed-role/awsbridge/gw-u@example.com";

const success = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <AssumedRoleUser>
      <Arn>${ARN}</Arn>
      <AssumedRoleId>AROAEXAMPLE:gw-u@example.com</AssumedRoleId>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
      <SecretAccessKey>sec/ret+a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;&#x41;&#66;</SecretAccessKey>
      <SessionToken>tok==</SessionToken>
      <Expiration>2026-11-05T10:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

const errXml = (code: string) =>
  `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>secret detail about 123456789012</Message></Error></ErrorResponse>`;

type Call = { url: string; init: RequestInit };
function fakeFetch(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return res();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const base = {
  token: "jwt.tok.en",
  roleArn: ROLE,
  sessionName: "gw-u@example.com",
  region: "us-east-1",
};

async function failure(p: Promise<unknown>): Promise<StsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StsError);
    return e as StsError;
  }
  throw new Error("resolved unexpectedly");
}

describe("assumeRoleWithWebIdentity", () => {
  it("成功 XML を認証情報に変換し、エンティティをデコードする", async () => {
    const { fn } = fakeFetch(() => new Response(success, { status: 200 }));
    const c = await assumeRoleWithWebIdentity({ ...base, fetch: fn });
    expect(c).toEqual({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: `sec/ret+a&b<c>"d"'e'AB`,
      sessionToken: "tok==",
      expiration: new Date("2026-11-05T10:00:00Z"),
      assumedRoleArn: ARN,
    });
  });

  it("リクエスト: リージョナル endpoint・署名なし POST・form body", async () => {
    const { fn, calls } = fakeFetch(() => new Response(success));
    await assumeRoleWithWebIdentity({ ...base, region: "ap-northeast-1", fetch: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("authorization")).toBeNull();
    const p = new URLSearchParams(String(calls[0]?.init.body));
    expect(p.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(p.get("Version")).toBe("2011-06-15");
    expect(p.get("RoleArn")).toBe(ROLE);
    expect(p.get("RoleSessionName")).toBe("gw-u@example.com");
    expect(p.get("WebIdentityToken")).toBe("jwt.tok.en");
    expect(p.get("DurationSeconds")).toBe("900");
  });

  it("durationSeconds と endpoint を上書きできる", async () => {
    const { fn, calls } = fakeFetch(() => new Response(success));
    await assumeRoleWithWebIdentity({
      ...base,
      durationSeconds: 3600,
      endpoint: "http://127.0.0.1:9999/sts",
      fetch: fn,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/sts");
    expect(new URLSearchParams(String(calls[0]?.init.body)).get("DurationSeconds")).toBe("3600");
  });

  it.each([
    ["InvalidIdentityToken", 400, "invalid_token"],
    ["ExpiredTokenException", 400, "invalid_token"],
    ["IDPRejectedClaim", 403, "invalid_token"],
    ["AccessDenied", 403, "forbidden"],
    ["MalformedPolicyDocument", 400, "forbidden"],
    ["PackedPolicyTooLarge", 400, "forbidden"],
    ["RegionDisabledException", 403, "forbidden"],
    ["IDPCommunicationError", 400, "transient"],
    ["Throttling", 400, "transient"],
    ["SomethingNew", 400, "transient"],
  ])("エラーコード %s (HTTP %i) は %s", async (code, status, kind) => {
    const { fn } = fakeFetch(() => new Response(errXml(code), { status }));
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe(kind);
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
    // 一般化した message に AWS 本文を含めない
    expect(e.message).not.toContain("secret detail");
    expect(e.message).not.toContain("123456789012");
    expect(e.awsMessage).toBe("secret detail about 123456789012");
  });

  it("HTTP 5xx は transient", async () => {
    const { fn } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe("transient");
    expect(e.status).toBe(502);
  });

  it("5xx で AccessDenied 風 XML でも transient", async () => {
    const { fn } = fakeFetch(() => new Response(errXml("AccessDenied"), { status: 503 }));
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe("transient");
  });

  it("壊れた XML (200) は transient", async () => {
    const { fn } = fakeFetch(() => new Response("<oops", { status: 200 }));
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe("transient");
  });

  it("Credentials の要素が欠けたら transient", async () => {
    const xml = success.replace(/<SessionToken>.*<\/SessionToken>/, "");
    const { fn } = fakeFetch(() => new Response(xml));
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe("transient");
  });

  it("Expiration が不正なら transient", async () => {
    const xml = success.replace("2026-11-05T10:00:00Z", "not-a-date");
    const { fn } = fakeFetch(() => new Response(xml));
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe("transient");
  });

  it("fetch 例外は transient", async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError("network down");
    });
    const e = await failure(assumeRoleWithWebIdentity({ ...base, fetch: fn }));
    expect(e.kind).toBe("transient");
    expect(e.message).not.toContain("network down");
  });
});

describe("createCredentialCache", () => {
  const mk = (n: number): AssumedCredentials => ({
    accessKeyId: `AKIAEXAMPLE${n}`,
    secretAccessKey: "s",
    sessionToken: "t",
    expiration: new Date(1_000_000_000_000 + 60 * 60_000),
    assumedRoleArn: ARN,
  });
  const T0 = 1_000_000_000_000;

  it("get/set/delete", () => {
    const cache = createCredentialCache({ now: () => T0 });
    const key = { identity: "u@example.com", roleArn: ROLE };
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, mk(1));
    expect(cache.get(key)?.accessKeyId).toBe("AKIAEXAMPLE1");
    cache.delete(key);
    expect(cache.get(key)).toBeUndefined();
  });

  it("キーは (identity, roleArn) の組", () => {
    const cache = createCredentialCache({ now: () => T0 });
    cache.set({ identity: "a", roleArn: "r1" }, mk(1));
    expect(cache.get({ identity: "a", roleArn: "r2" })).toBeUndefined();
    expect(cache.get({ identity: "b", roleArn: "r1" })).toBeUndefined();
    // 区切り文字の衝突で取り違えない
    cache.set({ identity: "a|b", roleArn: "c" }, mk(2));
    expect(cache.get({ identity: "a", roleArn: "b|c" })).toBeUndefined();
  });

  it("期限の 5 分前から失効扱い", () => {
    let now = T0;
    const cache = createCredentialCache({ now: () => now });
    const key = { identity: "a", roleArn: ROLE };
    cache.set(key, mk(1)); // 期限 T0 + 60 分
    now = T0 + 54 * 60_000 + 59_000;
    expect(cache.get(key)).toBeDefined();
    now = T0 + 55 * 60_000;
    expect(cache.get(key)).toBeUndefined();
  });

  it("上限を超えたら古いものから捨てる", () => {
    const cache = createCredentialCache({ now: () => T0, maxEntries: 3 });
    for (let i = 1; i <= 4; i++) cache.set({ identity: `u${i}`, roleArn: ROLE }, mk(i));
    expect(cache.get({ identity: "u1", roleArn: ROLE })).toBeUndefined();
    expect(cache.get({ identity: "u2", roleArn: ROLE })).toBeDefined();
    expect(cache.get({ identity: "u4", roleArn: ROLE })).toBeDefined();
  });

  it("同じキーの再 set は挿入順を更新する", () => {
    const cache = createCredentialCache({ now: () => T0, maxEntries: 2 });
    cache.set({ identity: "u1", roleArn: ROLE }, mk(1));
    cache.set({ identity: "u2", roleArn: ROLE }, mk(2));
    cache.set({ identity: "u1", roleArn: ROLE }, mk(3));
    cache.set({ identity: "u3", roleArn: ROLE }, mk(4));
    expect(cache.get({ identity: "u2", roleArn: ROLE })).toBeUndefined();
    expect(cache.get({ identity: "u1", roleArn: ROLE })?.accessKeyId).toBe("AKIAEXAMPLE3");
  });
});
