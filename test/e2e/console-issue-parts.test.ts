// コンソールログインの発行の部品（claim・署名・身元の制約・STS・getSigninToken・ログイン URL・発行記録）を、
// 実際の HTTP で通して確かめる。STS とサインインは手元のサーバー（擬似）で、JWT はその場で公開鍵を使って検証する。
// 実 AWS・Cloudflare は呼ばない。9 段のうち 8 段目と 9 段目の部品だけを順に呼ぶ（Worker 本体は PR4）。
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { importJWK, type JWK, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIENCE, UUID_RE } from "../../src/console/constants";
import { ISSUE_ERRORS, stsErrorKindToCode } from "../../src/console/issue/errors";
import {
  consoleDestination,
  fetchSigninToken,
  loginUrl,
  resolveRegion,
  signinIssuer,
  stsEndpoint,
} from "../../src/console/issue/federation";
import { resolveIdentity } from "../../src/console/issue/identity";
import { createIssueRecord, maskIssueRecord } from "../../src/console/issue/record";
import { createStandardSigner, parseSigningKeys } from "../../src/console/issue/sign-standard";
import { type IssueRow, unavailableSigner } from "../../src/console/issue/signer";
import { generateSigningJwk, publicJwkOf } from "../../src/keys";
import { assumeRoleWithWebIdentityDetailed, StsError } from "../../src/sts";

const ISSUER = "https://idp.example.test/std";
const ACCESS_KEY_ID = ["ASIA", "E".repeat(16)].join("");
const SECRET = ["sec", "ret", "-", "k".repeat(24)].join("");
const SESSION_TOKEN = ["tok", "en", "-", "t".repeat(48)].join("");
const SIGNIN_TOKEN = ["signin", "-", "s".repeat(24)].join("");
const REQUEST_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

type Seen = { sts: URLSearchParams[]; signin: URLSearchParams[] };
let seen: Seen;
let stsMode: "ok" | "denied";
let servers: Server[] = [];
let stsUrl = "";
let signinUrl = "";
let keyJwk: JWK;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b));
  });

const listen = (s: Server) =>
  new Promise<string>((resolve) => {
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`),
    );
  });

beforeAll(async () => {
  keyJwk = await generateSigningJwk();
  const sts = createServer(async (req, res) => {
    seen.sts.push(new URLSearchParams(await readBody(req)));
    if (stsMode === "denied") {
      res.writeHead(403, { "content-type": "text/xml" });
      res.end(
        "<ErrorResponse><Error><Code>AccessDenied</Code><Message>not allowed</Message></Error></ErrorResponse>",
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/xml", "x-amzn-RequestId": REQUEST_ID });
    res.end(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult>
<AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/Role/x</Arn><AssumedRoleId>AROAEXAMPLEID:console-alice@example.com</AssumedRoleId></AssumedRoleUser>
<Credentials><AccessKeyId>${ACCESS_KEY_ID}</AccessKeyId><SecretAccessKey>${SECRET}</SecretAccessKey><SessionToken>${SESSION_TOKEN}</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials>
</AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
  });
  const signin = createServer(async (req, res) => {
    seen.signin.push(new URLSearchParams(await readBody(req)));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ SigninToken: SIGNIN_TOKEN }));
  });
  servers = [sts, signin];
  stsUrl = await listen(sts);
  signinUrl = await listen(signin);
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

beforeEach(() => {
  seen = { sts: [], signin: [] };
  stsMode = "ok";
});

const row: IssueRow = {
  team: "infra",
  boundary: "managed",
  issuer: ISSUER,
  accountId: "123456789012",
  role: "viewer",
  roleArn: "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
  sessionSeconds: 3600,
};
const portal = { origin: "https://portal.example.test", routing: "path" as const };
const emailOfLength = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;

describe("発行の部品を通しで（擬似の STS・サインイン）", () => {
  it("身元 → 署名 → STS → getSigninToken → ログイン URL → 発行記録", async () => {
    const identity = { sub: "access-sub-1", email: "Alice@Example.com", oid: "oid-1" };
    const resolved = resolveIdentity(identity, "email");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const signer = createStandardSigner({
      keys: parseSigningKeys(JSON.stringify({ managed: keyJwk })),
    });
    const signed = await signer.sign({ identity, resolved: resolved.value, row });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;

    // STS: 呼び出しは本番の関数。endpoint だけ擬似のサーバーに向ける
    const sts = await assumeRoleWithWebIdentityDetailed({
      token: signed.token.jwt,
      roleArn: row.roleArn,
      sessionName: resolved.value.sessionName,
      durationSeconds: row.sessionSeconds,
      region: "ap-northeast-1",
      endpoint: stsUrl,
    });
    expect(seen.sts).toHaveLength(1);
    const form = seen.sts[0] as URLSearchParams;
    expect(form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(form.get("RoleArn")).toBe(row.roleArn);
    expect(form.get("RoleSessionName")).toBe("console-alice@example.com");
    expect(form.get("DurationSeconds")).toBe("3600");
    expect(stsEndpoint("ap-northeast-1")).toBe("https://sts.ap-northeast-1.amazonaws.com/");

    // 擬似の STS に届いた JWT を、公開鍵でその場で検証する（AWS が見る claim と同じ）
    const { payload } = await jwtVerify(
      form.get("WebIdentityToken") as string,
      await importJWK(await publicJwkOf(keyJwk), "RS256"),
      { issuer: ISSUER, audience: AUDIENCE },
    );
    expect("azp" in payload).toBe(false);
    expect(payload.jti).toMatch(UUID_RE);
    expect(payload.sub).toBe("alice@example.com");
    expect(payload["https://aws.amazon.com/source_identity"]).toBe("alice@example.com");
    expect(payload["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: { awsbridge_team: ["infra"] },
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);

    // 発行記録に使う ID
    expect(sts.requestId).toBe(REQUEST_ID);
    expect(sts.assumedRoleId).toBe("AROAEXAMPLEID:console-alice@example.com");
    expect(sts.credentials.accessKeyId).toBe(ACCESS_KEY_ID);

    // getSigninToken → ログイン URL
    const token = await fetchSigninToken({
      credentials: sts.credentials,
      sessionSeconds: row.sessionSeconds,
      endpoint: signinUrl,
    });
    expect(token).toBe(SIGNIN_TOKEN);
    expect(seen.signin).toHaveLength(1);
    expect(seen.signin[0]?.get("SessionDuration")).toBe("3600");
    expect(JSON.parse(seen.signin[0]?.get("Session") as string)).toEqual({
      sessionId: ACCESS_KEY_ID,
      sessionKey: SECRET,
      sessionToken: SESSION_TOKEN,
    });

    const region = resolveRegion("ap-northeast-1", {
      allowed: ["ap-northeast-1"],
      default: "ap-northeast-1",
    });
    const url = new URL(
      loginUrl({
        signinToken: token,
        issuer: signinIssuer(portal, "infra"),
        destination: consoleDestination(region),
        endpoint: signinUrl,
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      Action: "login",
      Issuer: "https://portal.example.test/t/infra/expired",
      Destination:
        "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
      SigninToken: SIGNIN_TOKEN,
    });

    // 発行記録: jti が JWT と一致し、STS の 3 つの ID を持ち、認証情報・URL は持たない。伏せ字の形に元の値が残らない
    const record = createIssueRecord({
      tier: "standard",
      result: "ok",
      now: Date.UTC(2026, 10, 12),
      identity,
      resolved: resolved.value,
      row,
      token: signed.token,
      consoleRegion: region,
      sts: {
        region: "ap-northeast-1",
        accessKeyId: sts.credentials.accessKeyId,
        ...(sts.assumedRoleId !== undefined ? { assumedRoleId: sts.assumedRoleId } : {}),
        ...(sts.requestId !== undefined ? { requestId: sts.requestId } : {}),
      },
    });
    expect(record.jwt?.jti).toBe(payload.jti);
    expect(record.sts).toMatchObject({ accessKeyId: ACCESS_KEY_ID, requestId: REQUEST_ID });
    const full = JSON.stringify(record);
    const masked = JSON.stringify(maskIssueRecord(record));
    for (const secret of [SECRET, SESSION_TOKEN, SIGNIN_TOKEN, signed.token.jwt, url.toString()]) {
      expect(full).not.toContain(secret);
      expect(masked).not.toContain(secret);
    }
    for (const v of [
      "alice@example.com",
      payload.jti as string,
      ACCESS_KEY_ID,
      "123456789012",
      REQUEST_ID,
    ])
      expect(masked, v).not.toContain(v);
  });

  it("57 文字の email は identity_unsupported で止まり、署名も STS も呼ばない", async () => {
    const r = resolveIdentity({ sub: "s", email: emailOfLength(57) }, "email");
    expect(r).toEqual({ ok: false, code: "identity_unsupported" });
    expect(ISSUE_ERRORS.identity_unsupported.status).toBe(403);
    expect(seen.sts).toHaveLength(0);
  });

  it("STS が AccessDenied のときは StsError（forbidden）→ sts_denied（403）", async () => {
    stsMode = "denied";
    const signer = createStandardSigner({ keys: { managed: keyJwk } });
    const identity = { sub: "s", email: "bob@example.com" };
    const resolved = resolveIdentity(identity, "email");
    if (!resolved.ok) throw new Error("fixture");
    const signed = await signer.sign({ identity, resolved: resolved.value, row });
    if (!signed.ok) throw new Error("fixture");
    const err = await assumeRoleWithWebIdentityDetailed({
      token: signed.token.jwt,
      roleArn: row.roleArn,
      sessionName: resolved.value.sessionName,
      region: "us-east-1",
      endpoint: stsUrl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StsError);
    const code = stsErrorKindToCode((err as StsError).kind);
    expect(code).toBe("sts_denied");
    expect(ISSUE_ERRORS[code].status).toBe(403);
  });

  it("署名の部品が未接続（Admin の本番の配線）なら signing_unavailable（503）で、STS を呼ばない", async () => {
    const identity = { sub: "s", email: "bob@example.com" };
    const resolved = resolveIdentity(identity, "email");
    if (!resolved.ok) throw new Error("fixture");
    const r = await unavailableSigner.sign({ identity, resolved: resolved.value, row });
    expect(r).toEqual({ ok: false, code: "signing_unavailable" });
    expect(ISSUE_ERRORS.signing_unavailable.status).toBe(503);
    expect(seen.sts).toHaveLength(0);
  });
});
