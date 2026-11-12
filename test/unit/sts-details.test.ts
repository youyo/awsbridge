// STS の応答から AssumedRoleId と RequestId も取り出す（コンソールログインの発行記録用。足しただけで、既存の返り値は変えない）。
import { describe, expect, it } from "vitest";
import {
  assumeRoleWithWebIdentity,
  assumeRoleWithWebIdentityDetailed,
  StsError,
} from "../../src/sts";
import { parseAssumedRoleId, parseRequestId } from "../../src/sts-xml";

const ARN = "arn:aws:sts::123456789012:assumed-role/Role/console-u@example.com";
const xml = (opts: { roleId?: string; requestId?: string } = {}) =>
  `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <AssumedRoleUser>
      <Arn>${ARN}</Arn>${opts.roleId === undefined ? "" : `\n      <AssumedRoleId>${opts.roleId}</AssumedRoleId>`}
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
      <SecretAccessKey>secret</SecretAccessKey>
      <SessionToken>token</SessionToken>
      <Expiration>2026-11-05T10:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>${opts.requestId === undefined ? "" : `\n  <ResponseMetadata><RequestId>${opts.requestId}</RequestId></ResponseMetadata>`}
</AssumeRoleWithWebIdentityResponse>`;

const base = {
  token: "jwt.tok.en",
  roleArn: "arn:aws:iam::123456789012:role/Role",
  sessionName: "console-u@example.com",
  region: "us-east-1",
};
const fetchOf = (body: string, headers: Record<string, string> = {}, status = 200) =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

describe("parseAssumedRoleId / parseRequestId", () => {
  it("AssumedRoleUser の AssumedRoleId を取り出す。なければ undefined", () => {
    expect(parseAssumedRoleId(xml({ roleId: "AROAEXAMPLE:console-u@example.com" }))).toBe(
      "AROAEXAMPLE:console-u@example.com",
    );
    expect(parseAssumedRoleId(xml())).toBeUndefined();
  });

  it("ResponseMetadata の RequestId を取り出す。なければ undefined", () => {
    expect(parseRequestId(xml({ requestId: "11111111-2222-3333-4444-555555555555" }))).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(parseRequestId(xml())).toBeUndefined();
  });
});

describe("assumeRoleWithWebIdentityDetailed", () => {
  it("認証情報に加えて AssumedRoleId と、x-amzn-RequestId ヘッダーの値を返す", async () => {
    const r = await assumeRoleWithWebIdentityDetailed({
      ...base,
      fetch: fetchOf(xml({ roleId: "AROAEXAMPLE:s", requestId: "from-body" }), {
        "x-amzn-RequestId": "from-header",
      }),
    });
    expect(r.assumedRoleId).toBe("AROAEXAMPLE:s");
    expect(r.requestId).toBe("from-header");
    expect(r.credentials).toMatchObject({ accessKeyId: "ASIAEXAMPLE", assumedRoleArn: ARN });
  });

  it("ヘッダーがなければ本文の RequestId を使う。どちらもなければ undefined", async () => {
    const a = await assumeRoleWithWebIdentityDetailed({
      ...base,
      fetch: fetchOf(xml({ roleId: "AROAEXAMPLE:s", requestId: "from-body" })),
    });
    expect(a.requestId).toBe("from-body");
    const b = await assumeRoleWithWebIdentityDetailed({ ...base, fetch: fetchOf(xml()) });
    expect(b.requestId).toBeUndefined();
    expect(b.assumedRoleId).toBeUndefined();
  });

  it("エラーは既存の関数と同じ StsError", async () => {
    const f = fetchOf(
      "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>",
      {},
      403,
    );
    const e = await assumeRoleWithWebIdentityDetailed({ ...base, fetch: f }).catch((x) => x);
    expect(e).toBeInstanceOf(StsError);
    expect((e as StsError).kind).toBe("forbidden");
  });

  it("既存の assumeRoleWithWebIdentity の返り値には新しい項目を足さない", async () => {
    const c = await assumeRoleWithWebIdentity({
      ...base,
      fetch: fetchOf(xml({ roleId: "AROAEXAMPLE:s", requestId: "r" }), { "x-amzn-RequestId": "h" }),
    });
    expect(Object.keys(c).sort()).toEqual(
      ["accessKeyId", "assumedRoleArn", "expiration", "secretAccessKey", "sessionToken"].sort(),
    );
  });
});
