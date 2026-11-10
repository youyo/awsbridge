import { describe, expect, it } from "vitest";
import {
  assertPocProviderArn,
  assertPocRoleArn,
  assertPocStackName,
  credentialsEnv,
  maskSensitive,
  parseCliErrorCode,
  REVOKE_POLICY_NAME,
  revokeCutoff,
  revokePolicyDocument,
} from "../../scripts/poc/human/ops";

// 出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html
describe("revokePolicyDocument（AWSRevokeOlderSessions 相当）", () => {
  it("aws:TokenIssueTime が基準時刻より前のセッションの全操作を Deny する", () => {
    const doc = JSON.parse(revokePolicyDocument(new Date("2026-11-11T01:02:03.456Z")));
    expect(doc).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: ["*"],
          Resource: ["*"],
          Condition: { DateLessThan: { "aws:TokenIssueTime": "2026-11-11T01:02:03Z" } },
        },
      ],
    });
  });
  it("ポリシー名はコンソールの Revoke sessions と同じ AWSRevokeOlderSessions", () => {
    expect(REVOKE_POLICY_NAME).toBe("AWSRevokeOlderSessions");
  });
  it("revokeCutoff は現在時刻 + futureSeconds（コンソールは約 30 秒先）", () => {
    expect(revokeCutoff(new Date("2026-11-11T00:00:00Z"), 30).toISOString()).toBe(
      "2026-11-11T00:00:30.000Z",
    );
    expect(() => revokeCutoff(new Date(), -1)).toThrow();
    expect(() => revokeCutoff(new Date(), 3601)).toThrow();
  });
});

describe("PoC 用リソースのガード", () => {
  it("ロール: 名前が AwsbridgeHumanPoc で始まるものだけ。ロール名を返す", () => {
    expect(assertPocRoleArn("arn:aws:iam::123456789012:role/AwsbridgeHumanPocTagged")).toBe(
      "AwsbridgeHumanPocTagged",
    );
    expect(assertPocRoleArn("arn:aws:iam::123456789012:role/AwsbridgeHumanPoc")).toBe(
      "AwsbridgeHumanPoc",
    );
    for (const bad of [
      "arn:aws:iam::123456789012:role/FederatedMcpReadOnly",
      "arn:aws:iam::123456789012:role/path/AwsbridgeHumanPoc",
      "arn:aws:iam::123456789012:role/XAwsbridgeHumanPoc",
      "AwsbridgeHumanPoc",
      "",
    ])
      expect(() => assertPocRoleArn(bad), bad).toThrow();
  });
  it("OIDC プロバイダー: ホストが awsbridge-human-poc. で始まり、PoC の issuer と一致するものだけ", () => {
    const host = "awsbridge-human-poc.example.workers.dev";
    const arn = `arn:aws:iam::123456789012:oidc-provider/${host}`;
    expect(assertPocProviderArn(arn, host)).toBe(arn);
    expect(() =>
      assertPocProviderArn(
        "arn:aws:iam::123456789012:oidc-provider/awsbridge.example.workers.dev",
        "awsbridge.example.workers.dev",
      ),
    ).toThrow();
    expect(() =>
      assertPocProviderArn(
        "arn:aws:iam::123456789012:oidc-provider/awsbridge-human-poc.other.workers.dev",
        host,
      ),
    ).toThrow();
    expect(() => assertPocProviderArn("", host)).toThrow();
  });
  it("スタック: awsbridge-human-poc で始まる名前だけ（destroy.sh と同じ）", () => {
    expect(() => assertPocStackName("awsbridge-human-poc")).not.toThrow();
    expect(() => assertPocStackName("awsbridge-human-poc-x")).not.toThrow();
    expect(() => assertPocStackName("awsbridge")).toThrow();
  });
});

describe("maskSensitive", () => {
  it("email とアカウント ID を伏せる（ARN・セッション名の中も）", () => {
    const s =
      "arn:aws:sts::123456789012:assumed-role/AwsbridgeHumanPocTagged/human-user@example.com si=user@example.com";
    const m = maskSensitive(s);
    expect(m).not.toContain("user@example.com");
    expect(m).not.toContain("123456789012");
    expect(m).toContain("assumed-role/AwsbridgeHumanPocTagged/human-u***@***.com");
    expect(m).toContain("arn:aws:sts::<account>:");
  });
  it("email でない文字列は変えない", () => {
    expect(maskSensitive("poc-admin AccessDenied")).toBe("poc-admin AccessDenied");
  });
});

describe("parseCliErrorCode", () => {
  it("AWS CLI のエラー文からコードを取り出す", () => {
    expect(
      parseCliErrorCode(
        "\nAn error occurred (AccessDenied) when calling the ListBuckets operation: User: ... is not authorized",
      ),
    ).toBe("AccessDenied");
    expect(
      parseCliErrorCode(
        "An error occurred (ExpiredToken) when calling the ListRoles operation: The security token included in the request is expired",
      ),
    ).toBe("ExpiredToken");
  });
  it("認証情報が無い・その他は分類だけ返す", () => {
    expect(parseCliErrorCode("Unable to locate credentials. You can configure ...")).toBe(
      "NoCredentials",
    );
    expect(parseCliErrorCode("Error when retrieving token from sso: Token has expired")).toBe(
      "Unknown",
    );
  });
});

describe("credentialsEnv", () => {
  it("プロファイル系の変数を外し、認証情報を環境変数で渡す（引数には載せない）", () => {
    const env = credentialsEnv(
      {
        PATH: "/bin",
        AWS_PROFILE: "awsbridge",
        AWS_DEFAULT_PROFILE: "x",
        AWS_CONFIG_FILE: "/tmp/c",
      },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" },
      "ap-northeast-1",
    );
    expect(env).toEqual({
      PATH: "/bin",
      AWS_CONFIG_FILE: "/tmp/c",
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "ap-northeast-1",
    });
  });
});
