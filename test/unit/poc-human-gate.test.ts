import { describe, expect, it } from "vitest";
import {
  assumeClaimsFor,
  consoleUrlFileName,
  credentialsFileName,
  humanPocSettings,
  isRoleKey,
  isWho,
  roleOutputKey,
  subjectFor,
} from "../../scripts/poc/human/lib";
import {
  DENY_SOURCE_IDENTITY_POLICY_NAME,
  denySourceIdentityPolicyDocument,
} from "../../scripts/poc/human/ops";
import {
  formatDriftReport,
  formatInlinePolicyReport,
  inlinePolicyReport,
  parseDriftDetection,
  parseResourceDrifts,
  parseRolePolicyNames,
} from "../../scripts/poc/human/persist-lib";
import { parseWatchTargets } from "../../scripts/poc/human/watch";

// 段階 1a の前に開発環境で確かめる条件（ADR-003 相当の (1) と (4)）の道具の純粋関数。

describe("(1) localhost だけのロール（localonly）", () => {
  it("localonly はロールの選択肢で、Output は LocalOnlyRoleArn", () => {
    expect(isRoleKey("localonly")).toBe(true);
    expect(roleOutputKey("localonly")).toBe("LocalOnlyRoleArn");
  });
  it("ファイル名にロールを入れる（credentials*.json・console-url-*.txt に収まる）", () => {
    expect(credentialsFileName("localonly")).toBe("credentials-localonly.json");
    expect(consoleUrlFileName(undefined, 43200, "localonly")).toBe(
      "console-url-localonly-dur-default-sd-43200.txt",
    );
  });
});

describe("Viewer と同じ形のロール（viewer。aws login --remote を許す）", () => {
  it("viewer はロールの選択肢で、Output は ViewerRoleArn", () => {
    expect(isRoleKey("viewer")).toBe(true);
    expect(roleOutputKey("viewer")).toBe("ViewerRoleArn");
    expect(credentialsFileName("viewer")).toBe("credentials-viewer.json");
  });
  it("引き受け直しの JWT のクレーム: viewer は SourceIdentity だけ、tagged はタグと SourceIdentity、ほかは何も足さない", () => {
    const si = "https://aws.amazon.com/source_identity";
    const tags = "https://aws.amazon.com/tags";
    expect(assumeClaimsFor("viewer", "user@example.com", "poc-admin")).toEqual({
      [si]: "user@example.com",
    });
    const tagged = assumeClaimsFor("tagged", "user@example.com", "poc-admin");
    expect(tagged[si]).toBe("user@example.com");
    expect(tagged[tags]).toEqual({ principal_tags: { access_profile: ["poc-admin"] } });
    for (const r of ["base", "notag", "localonly"] as const)
      expect(assumeClaimsFor(r, "user@example.com", "poc-admin")).toEqual({});
  });
});

describe("(4-b) 2 人目の利用者（AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT）", () => {
  it("2 人目の subject を小文字で読む。未設定は undefined", () => {
    expect(humanPocSettings({}).secondSubject).toBeUndefined();
    expect(
      humanPocSettings({ AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: "Second@Example.com" }).secondSubject,
    ).toBe("second@example.com");
  });
  it("isWho は primary / second だけ", () => {
    expect(isWho("primary")).toBe(true);
    expect(isWho("second")).toBe(true);
    expect(isWho("third")).toBe(false);
    expect(isWho("")).toBe(false);
  });
  it("subjectFor: primary は 1 人目、second は 2 人目", () => {
    const s = humanPocSettings({
      AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com",
      AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: "second@example.com",
    });
    expect(subjectFor(s, "primary")).toBe("user@example.com");
    expect(subjectFor(s, "second")).toBe("second@example.com");
  });
  it("subjectFor: 未設定、または 2 人目が 1 人目と同じなら例外（対照にならない）", () => {
    expect(() => subjectFor(humanPocSettings({}), "primary")).toThrow(
      /AWSBRIDGE_HUMAN_POC_SUBJECT/,
    );
    expect(() =>
      subjectFor(humanPocSettings({ AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com" }), "second"),
    ).toThrow(/AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT/);
    expect(() =>
      subjectFor(
        humanPocSettings({
          AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com",
          AWSBRIDGE_HUMAN_POC_SECOND_SUBJECT: "User@Example.com",
        }),
        "second",
      ),
    ).toThrow(/同じ/);
  });
  it("2 人目のファイル名には -second を付ける（1 人目は従来どおり）", () => {
    expect(credentialsFileName("tagged", "primary")).toBe("credentials-tagged.json");
    expect(credentialsFileName("tagged", "second")).toBe("credentials-tagged-second.json");
    expect(credentialsFileName("base", "second")).toBe("credentials-second.json");
    expect(consoleUrlFileName(undefined, 43200, "tagged", "second")).toBe(
      "console-url-tagged-second-dur-default-sd-43200.txt",
    );
    expect(consoleUrlFileName(undefined, 43200, "base", "second")).toBe(
      "console-url-second-dur-default-sd-43200.txt",
    );
  });
  it("stop-watch の --assume tagged:second は 2 人目で引き受け直す対象（名前で区別）", () => {
    expect(parseWatchTargets({ assume: ["tagged", "tagged:second"] })).toEqual([
      { kind: "assume", name: "assume:tagged", role: "tagged" },
      { kind: "assume", name: "assume:tagged:second", role: "tagged", who: "second" },
    ]);
    expect(parseWatchTargets({ assume: ["tagged:primary"] })).toEqual([
      { kind: "assume", name: "assume:tagged", role: "tagged" },
    ]);
    expect(() => parseWatchTargets({ assume: ["tagged:third"] })).toThrow();
    expect(() => parseWatchTargets({ assume: ["tagged", "tagged:primary"] })).toThrow(/重複/);
  });
});

describe("(4-b) SourceIdentity で 1 人だけ止める Deny", () => {
  it("名前は AwsbridgeDenySourceIdentity", () => {
    expect(DENY_SOURCE_IDENTITY_POLICY_NAME).toBe("AwsbridgeDenySourceIdentity");
  });
  it("aws:SourceIdentity が一致するセッションの全操作を Deny する", () => {
    expect(JSON.parse(denySourceIdentityPolicyDocument(["user@example.com"]))).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyBySourceIdentity",
          Effect: "Deny",
          Action: "*",
          Resource: "*",
          Condition: { StringEquals: { "aws:SourceIdentity": ["user@example.com"] } },
        },
      ],
    });
  });
  it("複数の利用者をまとめて止められる（重複は 1 つにする）", () => {
    const doc = JSON.parse(
      denySourceIdentityPolicyDocument(["a@example.com", "b@example.com", "a@example.com"]),
    );
    expect(doc.Statement[0].Condition.StringEquals["aws:SourceIdentity"]).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
  it("空・ワイルドカード・SourceIdentity に使えない文字は拒否する（全員を止めてしまわないように）", () => {
    for (const bad of [[], [""], ["*"], ["*@example.com"], ["a b@example.com"], ['a"@x.com']])
      expect(() => denySourceIdentityPolicyDocument(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("(4-a) CloudFormation の外のインラインポリシーが残るか", () => {
  it("parseRolePolicyNames は list-role-policies の出力から名前を取る", () => {
    expect(parseRolePolicyNames(JSON.stringify({ PolicyNames: ["A", "B"] }))).toEqual(["A", "B"]);
    expect(parseRolePolicyNames(JSON.stringify({ PolicyNames: [] }))).toEqual([]);
    expect(parseRolePolicyNames("{}")).toEqual([]);
    expect(() => parseRolePolicyNames("not json")).toThrow();
  });
  it("inlinePolicyReport は期待するポリシーがどのロールに残っているかを出す", () => {
    const r = inlinePolicyReport(
      [
        {
          role: "tagged",
          roleName: "AwsbridgeHumanPocTagged",
          policyNames: [
            "PrincipalTagPermissions",
            "AWSRevokeOlderSessions",
            "AwsbridgeDenySourceIdentity",
          ],
        },
        { role: "base", roleName: "AwsbridgeHumanPoc", policyNames: [] },
      ],
      ["AWSRevokeOlderSessions", "AwsbridgeDenySourceIdentity"],
      "tagged",
    );
    expect(r.missing).toEqual([]);
    expect(r.rows[0]).toEqual({
      role: "tagged",
      roleName: "AwsbridgeHumanPocTagged",
      policyNames: [
        "PrincipalTagPermissions",
        "AWSRevokeOlderSessions",
        "AwsbridgeDenySourceIdentity",
      ],
    });
    const text = formatInlinePolicyReport(r);
    expect(text).toContain("AwsbridgeHumanPocTagged");
    expect(text).toContain("AWSRevokeOlderSessions");
    expect(text).toMatch(/すべて残っている/);
  });
  it("inlinePolicyReport: 対象のロールに無いものは missing に入る", () => {
    const r = inlinePolicyReport(
      [{ role: "tagged", roleName: "AwsbridgeHumanPocTagged", policyNames: ["X"] }],
      ["AWSRevokeOlderSessions"],
      "tagged",
    );
    expect(r.missing).toEqual(["AWSRevokeOlderSessions"]);
    expect(formatInlinePolicyReport(r)).toMatch(/消えた.*AWSRevokeOlderSessions/);
  });
  it("期待が無ければ一覧だけ出す", () => {
    const r = inlinePolicyReport(
      [{ role: "tagged", roleName: "AwsbridgeHumanPocTagged", policyNames: [] }],
      [],
      "tagged",
    );
    expect(r.missing).toEqual([]);
    expect(formatInlinePolicyReport(r)).toContain("（なし）");
  });
  it("parseDriftDetection は detect の状態を読む", () => {
    expect(
      parseDriftDetection(
        JSON.stringify({
          StackDriftDetectionId: "id-1",
          DetectionStatus: "DETECTION_COMPLETE",
          StackDriftStatus: "DRIFTED",
          DriftedStackResourceCount: 1,
        }),
      ),
    ).toEqual({
      status: "DETECTION_COMPLETE",
      stackDriftStatus: "DRIFTED",
      driftedCount: 1,
      reason: undefined,
    });
  });
  it("parseResourceDrifts は論理 ID・状態・差分の場所と種類だけを出し、値は出さない（ポリシー名だけ拾う）", () => {
    const json = JSON.stringify({
      StackResourceDrifts: [
        {
          LogicalResourceId: "TaggedRole",
          ResourceType: "AWS::IAM::Role",
          StackResourceDriftStatus: "MODIFIED",
          PropertyDifferences: [
            {
              PropertyPath: "/Policies/1",
              DifferenceType: "ADD",
              ActualValue: JSON.stringify({
                PolicyName: "AwsbridgeDenySourceIdentity",
                PolicyDocument: {
                  Statement: [
                    { Condition: { StringEquals: { "aws:SourceIdentity": "user@example.com" } } },
                  ],
                },
              }),
              ExpectedValue: "null",
            },
            {
              PropertyPath: "/AssumeRolePolicyDocument/Statement/0/Principal/Federated",
              DifferenceType: "NOT_EQUAL",
              ActualValue: "arn:aws:iam::123456789012:oidc-provider/x",
              ExpectedValue: "arn:aws:iam::123456789012:oidc-provider/y",
            },
          ],
        },
        {
          LogicalResourceId: "HumanRole",
          ResourceType: "AWS::IAM::Role",
          StackResourceDriftStatus: "IN_SYNC",
        },
      ],
    });
    const rows = parseResourceDrifts(json);
    expect(rows).toEqual([
      {
        logicalId: "TaggedRole",
        type: "AWS::IAM::Role",
        status: "MODIFIED",
        differences: [
          { path: "/Policies/1", type: "ADD", policyName: "AwsbridgeDenySourceIdentity" },
          {
            path: "/AssumeRolePolicyDocument/Statement/0/Principal/Federated",
            type: "NOT_EQUAL",
          },
        ],
      },
      { logicalId: "HumanRole", type: "AWS::IAM::Role", status: "IN_SYNC", differences: [] },
    ]);
    const text = formatDriftReport(
      { status: "DETECTION_COMPLETE", stackDriftStatus: "DRIFTED", driftedCount: 1 },
      rows,
    );
    expect(text).toContain("TaggedRole");
    expect(text).toContain("/Policies/1 ADD（AwsbridgeDenySourceIdentity）");
    expect(text).toContain("DRIFTED");
    expect(text).not.toMatch(/user@example\.com|123456789012/);
  });
});
