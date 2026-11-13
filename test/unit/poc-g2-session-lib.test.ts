// G2 のセッションの見張り（poc:g2:session-watch）の純粋関数: 呼ぶ操作とプロファイルの検査。
import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATION, parseOperation, parseProfiles } from "../../scripts/poc/g2/session-lib";

describe("parseOperation", () => {
  it("既定は s3api list-buckets（sts get-caller-identity は Deny で止まらないので既定にしない）", () => {
    expect(DEFAULT_OPERATION).toBe("s3api list-buckets");
    expect(parseOperation(DEFAULT_OPERATION)).toEqual({
      args: ["s3api", "list-buckets"],
      warning: undefined,
    });
  });

  it("読み取りの操作（list-・get-・describe-・head-）を受け付ける", () => {
    expect(parseOperation("ec2 describe-regions").args).toEqual(["ec2", "describe-regions"]);
    expect(parseOperation(" iam  list-roles ").args).toEqual(["iam", "list-roles"]);
  });

  it("sts get-caller-identity は受け付けるが、停止の確認に使えないと警告する", () => {
    expect(parseOperation("sts get-caller-identity").warning).toMatch(/停止の確認には使えない/);
  });

  it("書き込みの操作・引数つき・形の違う値は断る", () => {
    for (const op of [
      "s3api delete-bucket",
      "iam create-role",
      "iam put-role-policy",
      "s3api list-buckets --query x",
      "s3api",
      "S3api list-buckets",
      "s3api list-buckets;rm",
      "",
    ])
      expect(() => parseOperation(op), op).toThrow();
  });
});

describe("parseOperation: 秘密を返す読み取りの操作は断る", () => {
  it.each([
    "sts get-session-token",
    "sts get-federation-token",
    "secretsmanager get-secret-value",
    "secretsmanager list-secrets",
    "ssm get-parameter",
    "ssm get-parameters",
    "ssm get-parameters-by-path",
    "ssm get-parameter-history",
    "kms list-keys",
    "kms get-public-key",
    "ecr get-authorization-token",
    "ecr-public get-authorization-token",
    "codeartifact get-authorization-token",
    "redshift get-cluster-credentials",
    "eks get-token",
    "ec2 get-password-data",
    "lambda get-function",
    "cognito-identity get-credentials-for-identity",
    "sso get-role-credentials",
  ])("%s は断る", (op) => {
    expect(() => parseOperation(op)).toThrow(/秘密/);
  });

  it("ふつうの読み取りは通す", () => {
    for (const op of [
      "s3api list-buckets",
      "iam list-roles",
      "ec2 describe-regions",
      "ssm describe-parameters",
    ])
      expect(parseOperation(op).args.join(" ")).toBe(op);
  });
});

describe("parseProfiles", () => {
  it("プロファイル名の一覧（重複・形の違う名前・- で始まる名前は断る。空も断る）", () => {
    expect(parseProfiles(["g2-viewer", "g2-viewer-remote"])).toEqual([
      "g2-viewer",
      "g2-viewer-remote",
    ]);
    expect(() => parseProfiles([])).toThrow();
    expect(() => parseProfiles(["a", "a"])).toThrow();
    expect(() => parseProfiles(["--x"])).toThrow();
    expect(() => parseProfiles(["a b"])).toThrow();
  });
});
