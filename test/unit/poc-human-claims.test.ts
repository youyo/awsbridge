import { exportJWK, generateKeyPair, importJWK, type JWK, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AWS_SOURCE_IDENTITY_CLAIM,
  AWS_TAGS_CLAIM,
  consoleUrlFileName,
  credentialsFileName,
  humanTokenClaims,
  outputsMap,
  parseStsExtras,
  roleOutputKey,
  sessionTagClaims,
  signHumanToken,
  sourceIdentityClaim,
} from "../../scripts/poc/human/lib";

const ISSUER = "https://awsbridge-human-poc.example.workers.dev";
let privateJwk: JWK;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateJwk = await exportJWK(privateKey);
});

// 出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html
//   入れ子形式: "https://aws.amazon.com/tags": { "principal_tags": { "Project": ["Automation"] } }（値は 1 要素の配列）
//   平坦形式:   "https://aws.amazon.com/tags/principal_tags/Project": "Automation"（値は文字列）
describe("sessionTagClaims", () => {
  it("入れ子形式: https://aws.amazon.com/tags の principal_tags に、値を 1 要素の配列で入れる", () => {
    expect(sessionTagClaims({ access_profile: "poc-admin" }, "nested")).toEqual({
      "https://aws.amazon.com/tags": { principal_tags: { access_profile: ["poc-admin"] } },
    });
    expect(AWS_TAGS_CLAIM).toBe("https://aws.amazon.com/tags");
  });
  it("平坦形式: https://aws.amazon.com/tags/principal_tags/<key> に文字列で入れる", () => {
    expect(sessionTagClaims({ access_profile: "poc-admin", extra: "x" }, "flat")).toEqual({
      "https://aws.amazon.com/tags/principal_tags/access_profile": "poc-admin",
      "https://aws.amazon.com/tags/principal_tags/extra": "x",
    });
  });
  it("タグが空なら claim を足さない（どちらの形式でも）", () => {
    expect(sessionTagClaims({}, "nested")).toEqual({});
    expect(sessionTagClaims({}, "flat")).toEqual({});
  });
  it("キーの大文字・小文字はそのまま渡す（大文字違いのケースを試すため）", () => {
    expect(sessionTagClaims({ Access_Profile: "poc-admin" }, "nested")).toEqual({
      "https://aws.amazon.com/tags": { principal_tags: { Access_Profile: ["poc-admin"] } },
    });
  });
});

// 出典: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html
describe("sourceIdentityClaim", () => {
  it("https://aws.amazon.com/source_identity に入れる", () => {
    expect(sourceIdentityClaim("user@example.com")).toEqual({
      "https://aws.amazon.com/source_identity": "user@example.com",
    });
    expect(AWS_SOURCE_IDENTITY_CLAIM).toBe("https://aws.amazon.com/source_identity");
  });
  it("STS の制約（2〜64 文字、[\\w+=,.@-]）に合わないものは例外", () => {
    for (const bad of ["a", "a b", "a/b", "x".repeat(65), ""])
      expect(() => sourceIdentityClaim(bad), bad).toThrow();
  });
});

describe("humanTokenClaims / signHumanToken の追加 claim", () => {
  it("extraClaims をそのまま足す", () => {
    const c = humanTokenClaims({
      issuer: ISSUER,
      audience: "awsbridge-human-poc",
      subject: "user@example.com",
      now: 1000,
      extraClaims: {
        ...sessionTagClaims({ access_profile: "poc-admin" }, "nested"),
        ...sourceIdentityClaim("user@example.com"),
      },
    });
    expect(c).toMatchObject({
      iss: ISSUER,
      sub: "user@example.com",
      "https://aws.amazon.com/tags": { principal_tags: { access_profile: ["poc-admin"] } },
      "https://aws.amazon.com/source_identity": "user@example.com",
    });
  });
  it("extraClaims で iss・aud・sub・iat・exp は上書きできない（例外）", () => {
    for (const k of ["iss", "aud", "sub", "iat", "exp"])
      expect(
        () =>
          humanTokenClaims({
            issuer: ISSUER,
            audience: "a",
            subject: "s@example.com",
            now: 1,
            extraClaims: { [k]: "x" },
          }),
        k,
      ).toThrow();
  });
  it("署名した JWT に追加 claim が入る", async () => {
    const jwt = await signHumanToken({
      privateJwk,
      issuer: ISSUER,
      audience: "awsbridge-human-poc",
      subject: "user@example.com",
      extraClaims: sessionTagClaims({ access_profile: "poc-viewer" }, "flat"),
    });
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = privateJwk;
    const { payload } = await jwtVerify(jwt, await importJWK({ ...pub, alg: "RS256" }, "RS256"));
    expect(payload["https://aws.amazon.com/tags/principal_tags/access_profile"]).toBe("poc-viewer");
  });
});

describe("parseStsExtras", () => {
  it("SourceIdentity・PackedPolicySize・SessionTokenSize・SessionTokenUtilization を取り出す", () => {
    const xml = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
      <SourceIdentity>user@example.com</SourceIdentity>
      <PackedPolicySize>37</PackedPolicySize>
      <SessionTokenSize>1536</SessionTokenSize>
      <SessionTokenUtilization>38</SessionTokenUtilization>
    </AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
    expect(parseStsExtras(xml)).toEqual({
      sourceIdentity: "user@example.com",
      packedPolicySize: 37,
      sessionTokenSize: 1536,
      sessionTokenUtilization: 38,
    });
  });
  it("無い要素は undefined", () => {
    expect(parseStsExtras("<x/>")).toEqual({
      sourceIdentity: undefined,
      packedPolicySize: undefined,
      sessionTokenSize: undefined,
      sessionTokenUtilization: undefined,
    });
  });
});

describe("ロールの選択（base / tagged / notag）", () => {
  it("roleOutputKey はスタックの Output 名", () => {
    expect(roleOutputKey("base")).toBe("RoleArn");
    expect(roleOutputKey("tagged")).toBe("TaggedRoleArn");
    expect(roleOutputKey("notag")).toBe("NoTagRoleArn");
  });
  it("outputsMap は describe-stacks の Outputs（JSON）を OutputKey → OutputValue にする", () => {
    expect(
      outputsMap(
        JSON.stringify([
          { OutputKey: "RoleArn", OutputValue: "arn:aws:iam::123456789012:role/AwsbridgeHumanPoc" },
          { OutputKey: "X", OutputValue: "y" },
        ]),
      ),
    ).toEqual({ RoleArn: "arn:aws:iam::123456789012:role/AwsbridgeHumanPoc", X: "y" });
    expect(outputsMap("null")).toEqual({});
    expect(() => outputsMap("not json")).toThrow();
  });
  it("credentialsFileName: base は従来どおり credentials.json、ほかはロール名を入れる", () => {
    expect(credentialsFileName("base")).toBe("credentials.json");
    expect(credentialsFileName("tagged")).toBe("credentials-tagged.json");
    expect(credentialsFileName("notag")).toBe("credentials-notag.json");
  });
  it("consoleUrlFileName: base は従来どおり、ほかはロール名を入れる（console-url-*.txt に収まる）", () => {
    expect(consoleUrlFileName(undefined, 43200)).toBe("console-url-dur-default-sd-43200.txt");
    expect(consoleUrlFileName(undefined, 43200, "base")).toBe(
      "console-url-dur-default-sd-43200.txt",
    );
    expect(consoleUrlFileName(3600, undefined, "tagged")).toBe(
      "console-url-tagged-dur-3600-sd-none.txt",
    );
  });
});
