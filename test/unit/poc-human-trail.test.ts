import { describe, expect, it } from "vitest";
import {
  apiEventRow,
  assumeEventRow,
  formatApiRows,
  formatAssumeRows,
  formatSigninEvents,
  isPocSessionEvent,
  isPocSigninEvent,
  parseLookupEvents,
  signinEventFields,
  tagsLabel,
} from "../../scripts/poc/human/trail-lib";

// 形は https://docs.aws.amazon.com/IAM/latest/UserGuide/cloudtrail-integration.html の
// 「Example OIDC AWS STS API event in CloudTrail log file」に合わせる（値は例示用）。
const assumeEvent = {
  eventVersion: "1.08",
  userIdentity: {
    type: "WebIdentityUser",
    userName: "user@example.com",
    identityProvider:
      "arn:aws:iam::123456789012:oidc-provider/awsbridge-human-poc.example.workers.dev",
  },
  eventTime: "2026-11-11T01:00:00Z",
  eventSource: "sts.amazonaws.com",
  eventName: "AssumeRoleWithWebIdentity",
  awsRegion: "ap-northeast-1",
  requestParameters: {
    roleArn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocTagged",
    roleSessionName: "human-user@example.com",
    sourceIdentity: "user@example.com",
    principalTags: { access_profile: "poc-admin" },
  },
  responseElements: {
    credentials: {
      accessKeyId: "ASIA_TEST_KEY_EXAMPLE",
      sessionToken: "<encoded session token blob>",
      expiration: "Nov 11, 2026, 2:00:00 AM",
    },
    subjectFromWebIdentityToken: "user@example.com",
    sourceIdentity: "user@example.com",
    assumedRoleUser: {
      arn: "arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocTagged/human-user@example.com",
    },
    sessionTokenUtilization: 37,
  },
};

const apiEvent = {
  eventTime: "2026-11-11T01:00:05Z",
  eventSource: "s3.amazonaws.com",
  eventName: "ListBuckets",
  awsRegion: "us-east-1",
  errorCode: "AccessDenied",
  userIdentity: {
    type: "AssumedRole",
    arn: "arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocTagged/human-user@example.com",
    accessKeyId: "ASIA_TEST_KEY_EXAMPLE",
    sessionContext: {
      sessionIssuer: { arn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPocTagged" },
      sourceIdentity: "user@example.com",
    },
  },
};

const lookup = (events: unknown[]) =>
  JSON.stringify({
    Events: events.map((e) => ({
      EventName: "x",
      CloudTrailEvent: typeof e === "string" ? e : JSON.stringify(e),
    })),
  });

describe("parseLookupEvents", () => {
  it("lookup-events の出力から CloudTrailEvent（JSON 文字列）を取り出す。壊れたものは飛ばす", () => {
    const r = parseLookupEvents(lookup([assumeEvent, "{broken", apiEvent]));
    expect(r).toHaveLength(2);
    expect(r[0]?.eventName).toBe("AssumeRoleWithWebIdentity");
  });
  it("Events が無ければ空", () => {
    expect(parseLookupEvents("{}")).toEqual([]);
  });
});

describe("assumeEventRow", () => {
  it("時刻・リージョン・ロール名・セッション名・SourceIdentity（要求・応答）・タグ・アクセスキー ID・使用率", () => {
    expect(assumeEventRow(assumeEvent)).toEqual({
      time: "2026-11-11T01:00:00Z",
      region: "ap-northeast-1",
      role: "AwsbridgeHumanPocTagged",
      sessionName: "human-user@example.com",
      errorCode: "",
      sourceIdentityRequest: "user@example.com",
      sourceIdentityResponse: "user@example.com",
      tags: { access_profile: "poc-admin" },
      accessKeyId: "ASIA_TEST_KEY_EXAMPLE",
      tokenUtilization: 37,
    });
  });
  it("PoC 以外のロールは対象外（undefined）", () => {
    expect(
      assumeEventRow({
        ...assumeEvent,
        requestParameters: { roleArn: "arn:aws:iam::123456789012:role/FederatedMcpReadOnly" },
      }),
    ).toBeUndefined();
  });
  it("失敗したイベント（errorCode あり・responseElements なし）も行にする", () => {
    const r = assumeEventRow({
      ...assumeEvent,
      errorCode: "AccessDenied",
      responseElements: null,
    });
    expect(r?.errorCode).toBe("AccessDenied");
    expect(r?.accessKeyId).toBeUndefined();
    expect(r?.sourceIdentityResponse).toBe("");
  });
});

describe("apiEventRow", () => {
  it("userIdentity.sessionContext.sourceIdentity を取り出す", () => {
    expect(apiEventRow(apiEvent)).toEqual({
      key: "ASIA_TEST_KEY_EXAMPLE",
      time: "2026-11-11T01:00:05Z",
      region: "us-east-1",
      eventName: "ListBuckets",
      eventSource: "s3.amazonaws.com",
      sourceIdentity: "user@example.com",
      errorCode: "AccessDenied",
      arn: "arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocTagged/human-user@example.com",
    });
  });
  it("欠けた項目は空文字", () => {
    expect(apiEventRow({})).toEqual({
      key: "",
      time: "",
      region: "",
      eventName: "",
      eventSource: "",
      sourceIdentity: "",
      errorCode: "",
      arn: "",
    });
  });
});

describe("isPocSessionEvent（セッション名で引いたイベントの絞り込み）", () => {
  it("PoC のロール（sessionIssuer が AwsbridgeHumanPoc*）のセッションの API イベントだけ", () => {
    expect(isPocSessionEvent(apiEvent)).toBe(true);
    expect(
      isPocSessionEvent({
        ...apiEvent,
        userIdentity: {
          ...apiEvent.userIdentity,
          sessionContext: {
            sessionIssuer: { arn: "arn:aws:iam::123456789012:role/FederatedMcpReadOnly" },
          },
        },
      }),
    ).toBe(false);
    expect(isPocSessionEvent(assumeEvent)).toBe(false);
    expect(isPocSessionEvent({})).toBe(false);
  });
});

describe("tagsLabel", () => {
  it("少なければ k=v を並べる", () => {
    expect(tagsLabel({ access_profile: "poc-admin" })).toBe("access_profile=poc-admin");
    expect(tagsLabel({})).toBe("-");
  });
  it("長い値は切り詰め、多ければ個数を出す", () => {
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`t${i}`, "x".repeat(256)]),
    );
    const l = tagsLabel(many);
    expect(l.startsWith("50 個: ")).toBe(true);
    expect(l.length).toBeLessThan(120);
  });
});

describe("formatAssumeRows / formatApiRows", () => {
  it("email・アカウント ID・アクセスキー ID の全体を出さない", () => {
    const row = assumeEventRow(assumeEvent);
    if (!row) throw new Error("row");
    const out = `${formatAssumeRows([row])}\n${formatApiRows([apiEventRow(apiEvent)])}`;
    expect(out).not.toContain("user@example.com");
    expect(out).not.toContain("123456789012");
    expect(out).not.toContain("ASIA_TEST_KEY_EXAMPLE");
    expect(out).toContain("u***@***.com");
    expect(out).toContain("access_profile=poc-admin");
    expect(out).toContain("AccessDenied");
    expect(out).toContain("…MPLE");
  });
});

// ---- aws login（signin.amazonaws.com の AuthorizeOAuth2Access / CreateOAuth2Token）: remote と localhost を見分けるフィールド ----

describe("signinEventFields（aws login のイベントを平らにし、秘密は伏せる）", () => {
  const ev = {
    eventTime: "2026-11-12T00:00:00Z",
    eventSource: "signin.amazonaws.com",
    eventName: "CreateOAuth2Token",
    awsRegion: "ap-northeast-1",
    sourceIPAddress: "203.0.113.45",
    userAgent: "aws-cli/2.39.6 md/command#login",
    errorCode: "AccessDenied",
    errorMessage:
      "User arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocViewer/human-user@example.com is not authorized",
    userIdentity: {
      type: "AssumedRole",
      arn: "arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocViewer/human-user@example.com",
      accountId: "123456789012",
      sessionContext: { sourceIdentity: "user@example.com" },
    },
    requestParameters: {
      clientId: "arn:aws:signin:::devtools/cross-device",
      redirectUri: "https://ap-northeast-1.signin.aws.amazon.com/v1/sessions/confirmation",
      grantType: "authorization_code",
      code: "secret-code",
      codeVerifier: "secret-verifier",
      refreshToken: "secret-refresh",
    },
    responseElements: { accessToken: "secret-access", expiresIn: 900 },
    additionalEventData: { nested: { state: "secret-state", note: "ok" } },
    resources: [
      {
        ARN: "arn:aws:signin:ap-northeast-1:123456789012:oauth2/public-client/remote",
        type: "AWS::Signin::OAuth2PublicClient",
      },
    ],
  };
  it("全フィールドを key=value に平らにする（resources も）", () => {
    const f = signinEventFields(ev);
    expect(f["requestParameters.clientId"]).toBe("arn:aws:signin:::devtools/cross-device");
    expect(f["requestParameters.grantType"]).toBe("authorization_code");
    expect(f["requestParameters.redirectUri"]).toBe(
      "https://ap-northeast-1.signin.aws.amazon.com/v1/sessions/confirmation",
    );
    expect(f["resources.0.ARN"]).toBe(
      "arn:aws:signin:ap-northeast-1:<account>:oauth2/public-client/remote",
    );
    expect(f["responseElements.expiresIn"]).toBe("900");
    expect(f["additionalEventData.nested.note"]).toBe("ok");
    expect(f.eventName).toBe("CreateOAuth2Token");
    expect(f["userIdentity.sessionContext.sourceIdentity"]).toBe("u***@***.com");
  });
  it("トークン・コード・state・verifier・鍵の値、アカウント ID・email、IP の下位は出さない", () => {
    const text = JSON.stringify(signinEventFields(ev));
    for (const s of [
      "secret-code",
      "secret-verifier",
      "secret-refresh",
      "secret-access",
      "secret-state",
      "123456789012",
      "user@example.com",
      "203.0.113.45",
    ])
      expect(text, s).not.toContain(s);
    expect(signinEventFields(ev)["requestParameters.code"]).toBe("<redacted>");
    expect(signinEventFields(ev).sourceIPAddress).toBe("203.0.x.x");
  });
  it("秘密名のキーの値がオブジェクトや配列なら、子の値もすべて伏せる", () => {
    const nested = {
      requestParameters: {
        tokens: ["secret-a", { value: "secret-b" }],
        clientSecret: { value: "secret-c", inner: ["secret-d"] },
        state: { raw: "secret-e" },
        note: "ok",
      },
    };
    const f = signinEventFields(nested);
    const text = JSON.stringify(f);
    for (const s of ["secret-a", "secret-b", "secret-c", "secret-d", "secret-e"])
      expect(text, s).not.toContain(s);
    expect(f["requestParameters.tokens.0"]).toBe("<redacted>");
    expect(f["requestParameters.tokens.1.value"]).toBe("<redacted>");
    expect(f["requestParameters.clientSecret.inner.0"]).toBe("<redacted>");
    expect(f["requestParameters.state.raw"]).toBe("<redacted>");
    expect(f["requestParameters.note"]).toBe("ok");
  });
  it("formatSigninEvents: 1 イベントごとに見出しと key=value の行を出す（伏せ字のまま）", () => {
    const out = formatSigninEvents([ev]);
    expect(out).toContain("CreateOAuth2Token");
    expect(out).toContain("requestParameters.clientId = arn:aws:signin:::devtools/cross-device");
    expect(out).not.toContain("123456789012");
    expect(out).not.toContain("secret-");
  });
});

describe("isPocSigninEvent（trail --signin の既定は PoC のロールのセッションだけ）", () => {
  const mk = (issuer: string | undefined) => ({
    eventName: "CreateOAuth2Token",
    userIdentity:
      issuer === undefined
        ? undefined
        : {
            sessionContext: { sessionIssuer: { arn: `arn:aws:iam::123456789012:role/${issuer}` } },
          },
  });
  it("PoC のロール（AwsbridgeHumanPoc*）のセッションなら true、利用者の別のセッション（SSO など）なら false", () => {
    expect(isPocSigninEvent(mk("AwsbridgeHumanPocViewer"))).toBe(true);
    expect(
      isPocSigninEvent(mk("aws-reserved/sso.amazonaws.com/ap-northeast-1/AWSReservedSSO_Admin_x")),
    ).toBe(false);
  });
  it("userIdentity が無いイベント（主体が分からない）は落とさない", () => {
    expect(isPocSigninEvent(mk(undefined))).toBe(true);
  });
});
