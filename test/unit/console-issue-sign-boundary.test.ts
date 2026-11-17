// コンソールログイン: Standard の署名（境界ごとの secret_key の取り出せない鍵。cto の決裁「Standard も secret_key に揃える」）と署名の差し込み口。
// 旧い形（境界 → 秘密鍵 JWK の文字列の secret を parseSigningKeys で読む）は外した。鍵の vars の検査は parseConsoleKeys。
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIENCE, UUID_RE } from "../../src/console/constants";
import { resolveIdentity } from "../../src/console/issue/identity";
import { type BoundaryKey, createBoundarySigner } from "../../src/console/issue/sign-boundary";
import {
  type IssueRow,
  type SigningRequest,
  type TokenSigner,
  unavailableSigner,
} from "../../src/console/issue/signer";
import { consoleBindingName, parseConsoleKeys } from "../../src/console/worker/key";
import { makeStandardKey, type TestKey } from "./console-worker-harness";

const NOW = 1_700_000_000;
const ISSUER = "https://idp.example.test/standard";
const P_ISSUER = "https://idp.example.test/p";
let managed: TestKey;
let partner: TestKey;
let logs: string[];

beforeAll(async () => {
  managed = await makeStandardKey();
  partner = await makeStandardKey();
});

const identity = { sub: "access-sub-1", email: "Alice@Example.com", oid: "oid-1" };
const row = (over: Partial<IssueRow> = {}): IssueRow => ({
  team: "infra",
  boundary: "managed",
  issuer: ISSUER,
  accountId: "123456789012",
  role: "viewer",
  roleArn: "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer",
  sessionSeconds: 3600,
  ...over,
});
const request = (over: Partial<SigningRequest> = {}): SigningRequest => {
  const r = resolveIdentity(identity, "email");
  if (!r.ok) throw new Error("fixture");
  return { identity, resolved: r.value, row: row(), now: NOW, ...over };
};
const material = (k: TestKey, issuer: string, key: unknown = k.privateKey): BoundaryKey => ({
  issuer,
  current: { binding: k.binding, kid: k.kid },
  publicJwk: k.publicJwk,
  key,
});
/** チーム → 階層（生成物の teams[].tier）。署名の部品が、タグのチームの階層と ARN のパスの階層を比べるのに使う。 */
const TEAM_TIERS = { infra: "standard", "infra-elevated": "admin" } as const;
const signerOf = (boundaries: Record<string, BoundaryKey>) => {
  logs = [];
  return createBoundarySigner({ boundaries, teamTiers: TEAM_TIERS, log: (l) => logs.push(l) });
};

describe("createBoundarySigner", () => {
  it("境界の鍵で RS256 の JWT に署名し、公開鍵で検証できる（kid は vars の今の鍵）", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER) });
    const r = await signer.sign(request());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pub = await importJWK(managed.publicJwk, "RS256");
    const { payload, protectedHeader } = await jwtVerify(r.token.jwt, pub, {
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: new Date((NOW + 10) * 1000),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe(managed.kid);
    // header は alg・kid・typ の 3 つだけ（旧い jose の Standard の署名は typ を持たなかった。Admin と同じ形にした）
    expect(protectedHeader).toEqual({ alg: "RS256", kid: managed.kid, typ: "JWT" });
    expect(payload).toMatchObject({
      sub: "alice@example.com",
      iat: NOW,
      exp: NOW + 300,
      "https://aws.amazon.com/source_identity": "alice@example.com",
      "https://aws.amazon.com/tags": { principal_tags: { awsbridge_team: ["infra"] } },
    });
    expect("azp" in payload).toBe(false);
    expect(payload.jti).toMatch(UUID_RE);
    expect(r.token).toMatchObject({ jti: payload.jti, iat: NOW, exp: NOW + 300, issuer: ISSUER });
  });

  it("境界ごとに別の鍵で署名する（別の境界の鍵では検証できない）", async () => {
    const signer = signerOf({
      managed: material(managed, ISSUER),
      "partner:acme": material(partner, P_ISSUER),
    });
    const r = await signer.sign(
      request({ row: row({ boundary: "partner:acme", issuer: P_ISSUER }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(decodeProtectedHeader(r.token.jwt).kid).toBe(partner.kid);
    const wrong = await importJWK(managed.publicJwk, "RS256");
    await expect(
      jwtVerify(r.token.jwt, wrong, { currentDate: new Date(NOW * 1000) }),
    ).rejects.toThrow();
  });

  it("その境界の鍵がなければ signing_unavailable（ほかの境界の鍵で代用しない）", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER) });
    expect(await signer.sign(request({ row: row({ boundary: "partner:acme" }) }))).toEqual({
      ok: false,
      code: "signing_unavailable",
    });
  });

  it("行の issuer がその境界の issuer と違えば signing_unavailable", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER) });
    expect(await signer.sign(request({ row: row({ issuer: P_ISSUER }) }))).toEqual({
      ok: false,
      code: "signing_unavailable",
    });
    expect(logs.join("\n")).toContain("console_issuer_mismatch");
  });

  it.each([
    ["文字列の秘密鍵 JWK", async (): Promise<unknown> => JSON.stringify({ kty: "RSA", d: "x" })],
    ["公開鍵の CryptoKey", async (): Promise<unknown> => importJWK(managed.publicJwk, "RS256")],
  ])(
    "鍵が CryptoKey の秘密鍵でない（%s）なら signing_unavailable（例外を出さず、鍵の内容を含めない）",
    async (_n, v) => {
      const signer = signerOf({ managed: material(managed, ISSUER, await v()) });
      expect(await signer.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
      expect(logs.join("\n")).toContain("console_key_unusable");
    },
  );

  it("取り出せる鍵は signing_unavailable", async () => {
    const x = await makeStandardKey(true);
    const signer = signerOf({ managed: material(x, ISSUER) });
    expect(await signer.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
  });

  it("公開鍵と合わない鍵（自己検証の失敗）は signing_unavailable", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER, partner.privateKey) });
    expect(await signer.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
    expect(logs.join("\n")).toContain("console_key_self_verify_failed");
  });

  it("入力が JWT の claim として不正（チーム名が規則に合わない）なら signing_unavailable に倒す", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER) });
    expect(await signer.sign(request({ row: row({ team: "Bad Team" }) }))).toEqual({
      ok: false,
      code: "signing_unavailable",
    });
  });

  it("now を省略すると現在時刻を使う", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER) });
    const before = Math.floor(Date.now() / 1000);
    const { now: _omit, ...withoutNow } = request();
    const r = await signer.sign(withoutNow);
    expect(r.ok && r.token.iat).toBeGreaterThanOrEqual(before);
  });

  it("status は境界ごとに鍵の性質と自己検証を返す（値は返さない）", async () => {
    const signer = signerOf({
      managed: material(managed, ISSUER),
      "partner:acme": material(partner, P_ISSUER, managed.privateKey),
    });
    const st = await signer.status();
    expect(st.managed).toMatchObject({
      usable: true,
      extractable: false,
      exportKey: "rejected",
      selfVerify: "ok",
    });
    expect(st["partner:acme"]).toMatchObject({ usable: true, selfVerify: "failed" });
  });

  it("TokenSigner として差し込める（unavailableSigner と同じ型）", async () => {
    const signers: TokenSigner[] = [
      signerOf({ managed: material(managed, ISSUER) }),
      unavailableSigner,
    ];
    expect(await signers[1]?.sign(request())).toEqual({ ok: false, code: "signing_unavailable" });
  });
});

describe("parseConsoleKeys（境界 → 今の鍵・境界 → 公開鍵の 2 つの vars）", () => {
  const cur = (m: Record<string, TestKey>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(m).map(([b, k]) => [b, { binding: k.binding, kid: k.kid }]),
      ),
    );
  const pub = (m: Record<string, TestKey[]>) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(m).map(([b, ks]) => [b, ks.map((k) => k.publicJwk)])),
    );

  it("読める。名前は CONSOLE_KEY_<kid の 16 進>", async () => {
    const r = await parseConsoleKeys(
      cur({ managed, "partner:acme": partner }),
      pub({ managed: [managed], "partner:acme": [partner] }),
    );
    expect(r.current.managed).toEqual({ binding: managed.binding, kid: managed.kid });
    expect(r.publicJwks["partner:acme"]).toEqual([partner.publicJwk]);
    expect(consoleBindingName(managed.kid)).toBe(managed.binding);
    expect(managed.binding).toMatch(/^CONSOLE_KEY_[0-9A-F]{16}$/);
  });

  it("公開鍵だけの境界（今の鍵なし）は読める", async () => {
    const r = await parseConsoleKeys(
      cur({ managed }),
      pub({ managed: [managed], "partner:acme": [partner] }),
    );
    expect(Object.keys(r.current)).toEqual(["managed"]);
  });

  it.each([
    ["今の鍵が無い", (): [unknown, unknown] => [undefined, pub({ managed: [managed] })]],
    ["公開鍵が無い", (): [unknown, unknown] => [cur({ managed }), ""]],
    ["JSON でない", (): [unknown, unknown] => ["not json", pub({ managed: [managed] })]],
    ["配列", (): [unknown, unknown] => ["[]", pub({ managed: [managed] })]],
    ["空のオブジェクト", (): [unknown, unknown] => ["{}", pub({ managed: [managed] })]],
    [
      "今の kid がその境界の公開鍵に無い",
      (): [unknown, unknown] => [cur({ managed }), pub({ managed: [partner] })],
    ],
    [
      "今の kid が別の境界の公開鍵にだけある",
      (): [unknown, unknown] => [cur({ managed }), pub({ x: [managed] })],
    ],
    [
      "同じ鍵が 2 つの境界にある",
      (): [unknown, unknown] => [
        cur({ managed, x: managed }),
        pub({ managed: [managed], x: [managed] }),
      ],
    ],
  ])("%s は例外", async (_n, f) => {
    const [c, p] = f();
    await expect(parseConsoleKeys(c, p)).rejects.toThrow();
  });

  it("例外の文に鍵の値を含めない", async () => {
    try {
      await parseConsoleKeys(
        cur({ managed }),
        JSON.stringify({ managed: [{ ...managed.publicJwk, d: "secret-d" }] }),
      );
      throw new Error("resolved unexpectedly");
    } catch (e) {
      expect(String(e)).not.toContain("secret-d");
      expect(String(e)).not.toContain(managed.publicJwk.n);
    }
  });
});

// P2（B）の設計メモ §7.1・§7.3 の X9: 署名の直前に、タグに入れるチームの階層と、ロールの ARN のパスの階層が同じことを
// 確かめる（行の検査と別の層の多重の防御）。違えば署名しない。行の検査（findRow）を通らない入力をここに直接渡して確かめる。
describe("createBoundarySigner: タグのチームの階層とロールの ARN のパスの階層（X9）", () => {
  const ADMIN_ARN =
    "arn:aws:iam::123456789012:role/awsbridge-console/admin/FederatedAwsBridgeAdministrator";
  const STD_ARN = "arn:aws:iam::123456789012:role/awsbridge-console/std/FederatedAwsBridgeViewer";

  it("陽性の対照: Admin の階層のチームで Admin のパスの ARN は署名する", async () => {
    const signer = signerOf({ managed: material(managed, ISSUER) });
    const r = await signer.sign(
      request({ row: row({ team: "infra-elevated", role: "administrator", roleArn: ADMIN_ARN }) }),
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    ["Standard の階層のチームで Admin のパスの ARN", "infra", ADMIN_ARN],
    ["Admin の階層のチームで Standard のパスの ARN", "infra-elevated", STD_ARN],
    ["階層の分からないチーム（生成物に無い）", "ghost", STD_ARN],
    [
      "コンソールのパスでない ARN",
      "infra",
      "arn:aws:iam::123456789012:role/FederatedAwsBridgeViewer",
    ],
    [
      "未知の階層のパスの ARN",
      "infra",
      "arn:aws:iam::123456789012:role/awsbridge-console/root/FederatedAwsBridgeViewer",
    ],
  ])(
    "%s は署名しない（signing_unavailable。ログは console_tier_mismatch）",
    async (_n, team, roleArn) => {
      const signer = signerOf({ managed: material(managed, ISSUER) });
      const r = await signer.sign(request({ row: row({ team, roleArn }) }));
      expect(r).toEqual({ ok: false, code: "signing_unavailable" });
      expect(logs.join("\n")).toContain("console_tier_mismatch");
      // 値（チーム名・ARN）はログに出さない
      expect(logs.join("\n")).not.toContain(roleArn);
    },
  );
});
