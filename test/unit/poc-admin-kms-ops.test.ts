// PoC N6 の手順（deploy・run・disable-watch・trail）の純粋関数。
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adminKmsSettings,
  correlateTrail,
  deployWranglerConfig,
  keysFromOutputs,
  maskIds,
  matchJti,
  parseLabels,
  publicKeyFromGetPublicKey,
  stopSummary,
  type TrailEvent,
} from "../../scripts/poc/admin-kms/ops";

const ROOT = "/repo";
const ACCT = "123456789012";
const arn = (id: string) => `arn:aws:kms:ap-northeast-1:${ACCT}:key/${id}`;
const RSA = arn("11111111-1111-4111-8111-111111111111");
const EC = arn("22222222-2222-4222-8222-222222222222");
const NEXT = arn("33333333-3333-4333-8333-333333333333");

describe("adminKmsSettings", () => {
  it("既定値（スタック・audience・sub・出力先・プロファイル・リージョン）", () => {
    const s = adminKmsSettings(
      { AWSBRIDGE_ADMIN_KMS_POC_ISSUER: "https://awsbridge-admin-kms-poc.sub.workers.dev/" },
      ROOT,
    );
    expect(s).toEqual({
      issuer: "https://awsbridge-admin-kms-poc.sub.workers.dev",
      stackName: "awsbridge-admin-kms-poc",
      workerName: "awsbridge-admin-kms-poc",
      audience: "awsbridge-admin-kms-poc",
      subject: "awsbridge-kms-check",
      awsProfile: "awsbridge",
      region: "ap-northeast-1",
      outDir: "/repo/.secrets/poc-admin-kms",
      documentsFile: "/repo/.secrets/poc-admin-kms/issuer-documents.json",
      deployConfigFile: "/repo/.secrets/poc-admin-kms/wrangler.deploy.json",
      callerTokenFile: "/repo/.secrets/poc-admin-kms/caller-token.txt",
    });
  });
  it("MCP 用・既存の PoC の変数は読まない", () => {
    const s = adminKmsSettings(
      {
        AWSBRIDGE_ISSUER: "https://awsbridge.example.workers.dev",
        AWSBRIDGE_HUMAN_POC_ISSUER: "https://awsbridge-human-poc.example.workers.dev",
        AWSBRIDGE_STACK_NAME: "awsbridge",
      },
      ROOT,
    );
    expect(s.issuer).toBeUndefined();
    expect(s.stackName).toBe("awsbridge-admin-kms-poc");
  });
  it.each([
    ["AWSBRIDGE_ADMIN_KMS_POC_ISSUER", "https://awsbridge-mcp.sub.workers.dev"],
    ["AWSBRIDGE_ADMIN_KMS_POC_ISSUER", "http://awsbridge-admin-kms-poc.sub.workers.dev"],
    ["AWSBRIDGE_ADMIN_KMS_POC_ISSUER", "https://awsbridge-admin-kms-poc.sub.workers.dev/x"],
    ["AWSBRIDGE_ADMIN_KMS_POC_STACK_NAME", "awsbridge"],
  ])("%s=%s は例外（PoC の名前に限る）", (k, v) => {
    expect(() => adminKmsSettings({ [k]: v }, ROOT)).toThrow();
  });
});

describe("keysFromOutputs", () => {
  it("スタックの Outputs から rsa・ec・rsa-next の鍵（label・ARN・alg）を作る", () => {
    expect(
      keysFromOutputs({ RsaKeyArn: RSA, EcKeyArn: EC, RsaNextKeyArn: NEXT, RoleArn: "x" }),
    ).toEqual([
      { label: "rsa", keyId: RSA, alg: "RS256" },
      { label: "ec", keyId: EC, alg: "ES256" },
      { label: "rsa-next", keyId: NEXT, alg: "RS256" },
    ]);
  });
  it("欠けている・形が違えば例外", () => {
    expect(() => keysFromOutputs({ RsaKeyArn: RSA, EcKeyArn: EC })).toThrow();
    expect(() => keysFromOutputs({ RsaKeyArn: "x", EcKeyArn: EC, RsaNextKeyArn: NEXT })).toThrow();
  });
});

describe("publicKeyFromGetPublicKey（aws kms get-public-key の JSON）", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64");
  it("KeySpec・KeyUsage・SigningAlgorithms が alg と合えば PublicKey のバイト列", () => {
    const out = publicKeyFromGetPublicKey(
      JSON.stringify({
        KeyId: RSA,
        PublicKey: spki,
        KeySpec: "RSA_2048",
        KeyUsage: "SIGN_VERIFY",
        SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256", "RSASSA_PSS_SHA_256"],
      }),
      "RS256",
    );
    expect(Buffer.from(out).toString("base64")).toBe(spki);
  });
  it.each([
    ["KeySpec が違う", { KeySpec: "ECC_NIST_P256" }],
    ["KeyUsage が違う", { KeyUsage: "ENCRYPT_DECRYPT" }],
    ["アルゴリズムが無い", { SigningAlgorithms: ["RSASSA_PSS_SHA_256"] }],
    ["PublicKey が無い", { PublicKey: undefined }],
  ])("%s なら例外", (_, over) => {
    const base = {
      PublicKey: spki,
      KeySpec: "RSA_2048",
      KeyUsage: "SIGN_VERIFY",
      SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256"],
    };
    expect(() =>
      publicKeyFromGetPublicKey(JSON.stringify({ ...base, ...over }), "RS256"),
    ).toThrow();
  });
});

describe("parseLabels（--jwks rsa,ec）", () => {
  it("カンマ区切り。重複は 1 つに、知らない label は例外、空は例外", () => {
    expect(parseLabels("rsa, ec,rsa", ["rsa", "ec", "rsa-next"])).toEqual(["rsa", "ec"]);
    expect(() => parseLabels("rsa,x", ["rsa"])).toThrow();
    expect(() => parseLabels("", ["rsa"])).toThrow();
  });
});

describe("deployWranglerConfig", () => {
  const cfg = {
    name: "awsbridge-admin-kms-poc",
    main: "worker.ts",
    compatibility_date: "2026-07-21",
    workers_dev: true,
    preview_urls: false,
    alias: {
      "awsbridge-admin-kms-poc-documents": "../../../.secrets/poc-admin-kms/issuer-documents.json",
    },
  };
  it("main と alias を絶対パスにし、vars を入れる（$schema は外す）", () => {
    const out = deployWranglerConfig(
      { $schema: "x", ...cfg },
      { dir: "/repo/scripts/poc/admin-kms", documentsFile: "/o/docs.json", vars: { A: "1" } },
    );
    expect(out).toEqual({
      ...cfg,
      main: "/repo/scripts/poc/admin-kms/worker.ts",
      alias: { "awsbridge-admin-kms-poc-documents": "/o/docs.json" },
      vars: { A: "1" },
    });
  });
  it("Worker 名が PoC のものでない・preview_urls が有効なら例外", () => {
    const opts = { dir: "/d", documentsFile: "/o", vars: {} };
    expect(() => deployWranglerConfig({ ...cfg, name: "awsbridge" }, opts)).toThrow();
    expect(() => deployWranglerConfig({ ...cfg, preview_urls: true }, opts)).toThrow();
  });
});

describe("stopSummary（K4 DisableKey から発行が止まるまで）", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 10, 12, 0, 0, s)).toISOString();
  it("無効化の完了から最初の失敗まで・有効化から最初の成功までの秒数とエラーコード", () => {
    const events = [
      { at: t(0), ok: true },
      { at: t(1), ok: true },
      { at: t(3), ok: true },
      { at: t(4), ok: false, code: "DisabledException" },
      { at: t(5), ok: false, code: "DisabledException" },
      { at: t(9), ok: false, code: "DisabledException" },
      { at: t(11), ok: true },
    ];
    expect(stopSummary(events, t(2), t(10))).toEqual({
      lastOkBeforeDisable: t(1),
      lastOkAfterDisable: t(3),
      firstFailure: t(4),
      failureCodes: ["DisabledException"],
      secondsToStop: 2,
      firstOkAfterEnable: t(11),
      secondsToResume: 1,
      okAfterDisableCount: 1,
    });
  });
  it("止まらなければ firstFailure も secondsToStop も無い", () => {
    const s = stopSummary([{ at: t(5), ok: true }], t(2), undefined);
    expect(s.firstFailure).toBeUndefined();
    expect(s.secondsToStop).toBeUndefined();
    expect(s.okAfterDisableCount).toBe(1);
  });
});

describe("correlateTrail（K4 CloudTrail の突き合わせ）", () => {
  const kmsId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const sign: TrailEvent = {
    eventName: "Sign",
    eventSource: "kms.amazonaws.com",
    eventTime: "2026-11-12T00:00:01Z",
    requestID: kmsId,
    sourceIPAddress: "198.51.100.1",
    requestParameters: {
      keyId: RSA,
      signingAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      messageType: "RAW",
    },
  };
  const assume: TrailEvent = {
    eventName: "AssumeRoleWithWebIdentity",
    eventSource: "sts.amazonaws.com",
    eventTime: "2026-11-12T00:00:02Z",
    requestID: "sts-1",
    sourceIPAddress: "198.51.100.1",
    requestParameters: { roleSessionName: `kms-${kmsId}`, roleArn: "arn:aws:iam::1:role/x" },
  };
  it("RoleSessionName の kms-<RequestId> と Sign の requestID で対にし、時刻差と送信元 IP の一致を出す", () => {
    expect(correlateTrail([sign], [assume])).toEqual([
      {
        kmsRequestId: kmsId,
        signTime: sign.eventTime,
        assumeTime: assume.eventTime,
        secondsBetween: 1,
        sameSourceIp: true,
        signingAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
        keyId: RSA,
      },
    ]);
  });
  it("対になる Sign が無ければ signTime は undefined", () => {
    expect(correlateTrail([], [assume])[0]).toMatchObject({
      kmsRequestId: kmsId,
      signTime: undefined,
    });
  });
  it("kms- で始まらない RoleSessionName は対象外", () => {
    expect(
      correlateTrail([sign], [{ ...assume, requestParameters: { roleSessionName: "human-x" } }]),
    ).toEqual([]);
  });
});

describe("maskIds", () => {
  it("アカウント ID・KMS の鍵 ID・アクセスキー ID・email・workers.dev のサブドメインを伏せる", () => {
    // 偽のアクセスキー ID は実行時に組み立てる（秘密の検査に実物と見なされないように）
    const AKID = `${"AKIA"}ABCDEFGHIJKLMNOP`;
    const ASID = `${"ASIA"}ABCDEFGHIJKLMNOP`;
    const s = `arn:aws:kms:ap-northeast-1:${ACCT}:key/11111111-1111-4111-8111-111111111111 ${AKID} ${ASID} user@example.com awsbridge-admin-kms-poc.mysub.workers.dev`;
    const m = maskIds(s);
    expect(m).not.toContain(ACCT);
    expect(m).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(m).not.toContain(AKID);
    expect(m).not.toContain(ASID);
    expect(m).not.toContain("user@example.com");
    expect(m).not.toContain("mysub");
    expect(m).toContain("awsbridge-admin-kms-poc.<sub>.workers.dev");
  });
  it("KMS の RequestId（UUID だが鍵 ID ではない）は伏せない", () => {
    expect(maskIds("kms-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")).toBe(
      "kms-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    );
  });
});

describe("matchJti（JWT の jti ↔ AssumeRoleWithWebIdentity の webIdentityTokenId）", () => {
  it("runs.jsonl の jti と CloudTrail の requestParameters.webIdentityTokenId が一致した数・一致しない数・記録の無い数", () => {
    const runs = [
      { jti: "j1", kmsRequestId: "k1", ok: true },
      { jti: "j2", kmsRequestId: "k2", ok: true },
      { jti: "j3", kmsRequestId: "k3", ok: false, stage: "sts" },
    ];
    const assumes = [
      {
        eventName: "AssumeRoleWithWebIdentity",
        eventSource: "sts",
        eventTime: "t",
        requestParameters: { webIdentityTokenId: "j1", roleSessionName: "kms-k1" },
      },
      {
        eventName: "AssumeRoleWithWebIdentity",
        eventSource: "sts",
        eventTime: "t",
        requestParameters: { webIdentityTokenId: "jX", roleSessionName: "kms-k2" },
      },
      {
        eventName: "AssumeRoleWithWebIdentity",
        eventSource: "sts",
        eventTime: "t",
        requestParameters: { roleSessionName: "kms-kZ" },
      },
    ];
    expect(matchJti(runs, assumes)).toEqual({ matched: 1, mismatched: 1, unknown: 1 });
  });
});
