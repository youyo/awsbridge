// コンソールログイン: Access JWT の検証（docs/specs/console-login-portal.md §9.3 の 1・2、§9.4）。
// aud はちょうど 1 つで、このデプロイの階層のチームの既知の AUD のときだけ通す。
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ConsoleAccessConfig,
  type ConsoleAccessResult,
  verifyConsoleAccess,
} from "../../src/console/issue/access";

// AUD は実行時に組み立てる（実在の値を直書きしない）
const randomAud = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const TEAM_DOMAIN = "https://team-a.example.cloudflareaccess.com";
const OTHER_DOMAIN = "https://team-b.example.cloudflareaccess.com";
const NOW = 1_800_000_000;
const SUB = "11111111-2222-3333-4444-555555555555";

const devAud = randomAud();
const opsAud = randomAud();
const entryAud = randomAud();
const unknownAud = randomAud();

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let good: KeyPair;
let other: KeyPair;

beforeAll(async () => {
  good = await generateKeyPair("RS256", { extractable: true });
  other = await generateKeyPair("RS256", { extractable: true });
});

const cfg = (over: Partial<ConsoleAccessConfig> = {}): ConsoleAccessConfig => ({
  teamDomain: TEAM_DOMAIN,
  teams: [
    { name: "dev", aud: devAud },
    { name: "ops", aud: opsAud },
  ],
  entryAud,
  ...over,
});
const opts = () => ({ getKey: async () => good.publicKey, now: NOW });

const user = { email: "User@Example.com", type: "app" };

async function sign(
  claims: JWTPayload,
  o: {
    key?: KeyPair;
    iss?: string;
    aud?: string | string[] | null;
    exp?: number | null;
    sub?: string | null;
    alg?: string;
  } = {},
) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "k1" })
    .setIssuer(o.iss ?? TEAM_DOMAIN)
    .setIssuedAt(NOW - 60);
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? NOW + 3600);
  if (o.aud !== null) jwt.setAudience(o.aud ?? [devAud]);
  if (o.sub !== null) jwt.setSubject(o.sub ?? SUB);
  return jwt.sign((o.key ?? good).privateKey);
}

const verify = (token: string | null, team = "dev", c = cfg()) =>
  verifyConsoleAccess(token, team, c, opts());

const codeOf = (r: ConsoleAccessResult) => (r.ok ? "ok" : r.code);

describe("aud はちょうど 1 つで既知のチームの AUD のときだけ通す（§9.3 の 2）", () => {
  it("aud=[devAud, unknown] は unknown_audience（既知と未知が 1 つずつでも通さない）", async () => {
    const r = await verify(await sign(user, { aud: [devAud, unknownAud] }));
    expect(r).toMatchObject({ ok: false, status: 403, code: "unknown_audience" });
  });

  it("aud=[unknown, devAud]（順序を変えても）は unknown_audience", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [unknownAud, devAud] })))).toBe(
      "unknown_audience",
    );
  });

  it("aud=[devAud, opsAud]（既知のチームが 2 つ）は unknown_audience", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [devAud, opsAud] })))).toBe(
      "unknown_audience",
    );
  });

  it("aud=[devAud, devAud]（同じ値の重複）は畳まずに unknown_audience", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [devAud, devAud] })))).toBe(
      "unknown_audience",
    );
  });

  it("aud が空の配列・ない は unknown_audience", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [] })))).toBe("unknown_audience");
    expect(codeOf(await verify(await sign(user, { aud: null })))).toBe("unknown_audience");
  });

  it("未知の AUD は unknown_audience", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [unknownAud] })))).toBe("unknown_audience");
  });

  it("入口の AUD は既知でも unknown_audience（入口の JWT で発行の経路を通れない）", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [entryAud] })))).toBe("unknown_audience");
    expect(codeOf(await verify(await sign(user, { aud: entryAud })))).toBe("unknown_audience");
  });

  it("aud の要素が文字列でない・空文字は unknown_audience", async () => {
    const forged = await new SignJWT({ ...user, aud: [42] as unknown as string[] })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(TEAM_DOMAIN)
      .setSubject(SUB)
      .setIssuedAt(NOW - 60)
      .setExpirationTime(NOW + 3600)
      .sign(good.privateKey);
    expect(codeOf(await verify(forged))).toBe("unknown_audience");
    expect(codeOf(await verify(await sign(user, { aud: [""] })))).toBe("unknown_audience");
  });

  it("パスのチームと AUD のチームが違えば team_mismatch", async () => {
    const r = await verify(await sign(user, { aud: [opsAud] }), "dev");
    expect(r).toMatchObject({ ok: false, status: 403, code: "team_mismatch" });
  });

  it("パスのチームが設定にない名前でも、AUD のチームと違えば team_mismatch", async () => {
    expect(codeOf(await verify(await sign(user, { aud: [devAud] }), "admin-team"))).toBe(
      "team_mismatch",
    );
  });

  it("このデプロイの階層にないチーム（AUD を持たないチーム）の AUD は未知として扱う", async () => {
    const c = cfg({ teams: [{ name: "dev", aud: devAud }, { name: "ops" }] });
    expect(codeOf(await verify(await sign(user, { aud: [opsAud] }), "ops", c))).toBe(
      "unknown_audience",
    );
  });
});

describe("正常系", () => {
  it("要素 1 つの配列の aud で、チーム・aud・sub・email（小文字）を返す", async () => {
    const r = await verify(await sign(user, { aud: [devAud] }));
    expect(r).toMatchObject({
      ok: true,
      team: "dev",
      aud: devAud,
      sub: SUB,
      email: "user@example.com",
    });
  });

  it("文字列の aud でも通る", async () => {
    const r = await verify(await sign(user, { aud: opsAud }), "ops");
    expect(r).toMatchObject({ ok: true, team: "ops", aud: opsAud });
  });

  it("チームドメインの末尾のスラッシュは無視する", async () => {
    const r = await verify(await sign(user), "dev", cfg({ teamDomain: `${TEAM_DOMAIN}/` }));
    expect(r.ok).toBe(true);
  });
});

describe("Access JWT の検証（§9.3 の 1。失敗は 401 unauthorized）", () => {
  const expect401 = async (p: Promise<ConsoleAccessResult>, reason: string) => {
    const r = await p;
    expect(r).toMatchObject({ ok: false, status: 401, code: "unauthorized", reason });
  };

  it("トークンがない・空は missing", async () => {
    await expect401(verify(null), "missing");
    await expect401(verify(""), "missing");
  });

  it("期限切れ（時計ずれの許容を超えたもの）は expired", async () => {
    await expect401(verify(await sign(user, { exp: NOW - 31 })), "expired");
  });

  it("時計ずれの許容（30 秒）の内なら通る", async () => {
    expect((await verify(await sign(user, { exp: NOW - 29 }))).ok).toBe(true);
  });

  it("別のチームドメイン（正しい鍵で違う iss）は invalid", async () => {
    await expect401(verify(await sign(user, { iss: OTHER_DOMAIN })), "invalid");
  });

  it("偽の署名（正しい iss で別の鍵）は invalid", async () => {
    await expect401(verify(await sign(user, { key: other })), "invalid");
  });

  it("偽の署名なら、aud が未知でも 401 を先に返す（署名の検証を aud の判定より先にする）", async () => {
    await expect401(verify(await sign(user, { key: other, aud: [unknownAud] })), "invalid");
    await expect401(verify(await sign(user, { key: other, aud: [devAud, unknownAud] })), "invalid");
  });

  it("壊れたトークンは invalid", async () => {
    await expect401(verify("not.a.jwt"), "invalid");
  });

  it("exp がないトークンは invalid（期限なしで通さない）", async () => {
    await expect401(verify(await sign(user, { exp: null })), "invalid");
  });

  it("alg が RS256 でなければ invalid（HS256 へのすり替え）", async () => {
    const jwk = await exportJWK(good.publicKey);
    const hs = await new SignJWT(user)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience([devAud])
      .setSubject(SUB)
      .setIssuedAt(NOW - 60)
      .setExpirationTime(NOW + 3600)
      .sign(new TextEncoder().encode(JSON.stringify(jwk)));
    await expect401(verify(hs), "invalid");
  });

  it("サービストークン（common_name があり sub が空）は service_token で断る", async () => {
    const svc = { type: "app", common_name: "0123abcd.access" };
    await expect401(verify(await sign(svc, { sub: "" })), "service_token");
  });

  it("common_name があれば、sub や email があっても断る", async () => {
    await expect401(verify(await sign({ ...user, common_name: "x.access" })), "service_token");
  });

  it("sub が空・ない は service_token で断る", async () => {
    await expect401(verify(await sign(user, { sub: "" })), "service_token");
    await expect401(verify(await sign(user, { sub: null })), "service_token");
  });

  it("type が app でない（org のグローバルセッションのトークンなど）は invalid", async () => {
    await expect401(verify(await sign({ ...user, type: "org" })), "invalid");
    await expect401(verify(await sign({ email: user.email })), "invalid");
  });

  it("email がない・空は identity_missing", async () => {
    await expect401(verify(await sign({ type: "app" })), "identity_missing");
    await expect401(verify(await sign({ type: "app", email: "" })), "identity_missing");
  });

  it("鍵の取得に失敗したら invalid（fail closed）", async () => {
    const r = await verifyConsoleAccess(await sign(user), "dev", cfg(), {
      now: NOW,
      getKey: async () => {
        throw new Error("JWKS を取得できない");
      },
    });
    expect(r).toMatchObject({ ok: false, status: 401, code: "unauthorized", reason: "invalid" });
  });
});

describe("設定が壊れていれば発行しない（fail closed: 500 server_misconfigured）", () => {
  const misconfigured = async (c: ConsoleAccessConfig) => {
    const r = await verify(await sign(user), "dev", c);
    expect(r).toMatchObject({ ok: false, status: 500, code: "server_misconfigured" });
  };

  it("チームドメインが https の URL でない・パスやクエリを持つ", async () => {
    await misconfigured(cfg({ teamDomain: "" }));
    await misconfigured(cfg({ teamDomain: "http://team-a.example.cloudflareaccess.com" }));
    await misconfigured(cfg({ teamDomain: `${TEAM_DOMAIN}/x` }));
    await misconfigured(cfg({ teamDomain: `${TEAM_DOMAIN}?q=1` }));
  });

  it("2 つのチームが同じ AUD を持つ", async () => {
    await misconfigured(
      cfg({
        teams: [
          { name: "dev", aud: devAud },
          { name: "ops", aud: devAud },
        ],
      }),
    );
  });

  it("入口の AUD がチームの AUD と同じ", async () => {
    await misconfigured(cfg({ entryAud: devAud }));
  });

  it("チーム名の重複・空の AUD", async () => {
    await misconfigured(
      cfg({
        teams: [
          { name: "dev", aud: devAud },
          { name: "dev", aud: opsAud },
        ],
      }),
    );
    await misconfigured(cfg({ teams: [{ name: "dev", aud: "" }] }));
  });

  it("設定が壊れていれば、トークンがなくても 500 を返す（設定の検査を先にする）", async () => {
    const r = await verifyConsoleAccess(null, "dev", cfg({ teamDomain: "" }), opts());
    expect(r).toMatchObject({ status: 500, code: "server_misconfigured" });
  });
});

// X1 の決裁 (f): Admin の Worker は Access JWT の iat からの経過時間に上限を置く（Admin の Access のセッションの長さ。既定 15 分）。
// 上限は maxAgeSeconds を渡したときだけ見る（Standard は渡さないので振る舞いは変わらない）。
describe("iat からの経過時間の上限（maxAgeSeconds。Admin だけが渡す）", () => {
  const MAX = 900;
  async function signAt(iat: number | null, exp = NOW + 3600) {
    const jwt = new SignJWT(user)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience([devAud])
      .setSubject(SUB)
      .setExpirationTime(exp);
    if (iat !== null) jwt.setIssuedAt(iat);
    return jwt.sign(good.privateKey);
  }
  const verifyAged = (token: string) =>
    verifyConsoleAccess(token, "dev", cfg(), { ...opts(), maxAgeSeconds: MAX });

  it("上限の内（iat が 15 分前ちょうど）なら通る", async () => {
    expect(codeOf(await verifyAged(await signAt(NOW - MAX)))).toBe("ok");
  });

  it("上限を超えた（15 分 1 秒前）なら 401 too_old", async () => {
    const r = await verifyAged(await signAt(NOW - MAX - 1));
    expect(r).toMatchObject({ ok: false, status: 401, code: "unauthorized", reason: "too_old" });
  });

  it("iat が未来（時計ずれの許容 30 秒を超える）なら 401 iat_future", async () => {
    expect(codeOf(await verifyAged(await signAt(NOW + 30)))).toBe("ok");
    const r = await verifyAged(await signAt(NOW + 31));
    expect(r).toMatchObject({ ok: false, status: 401, reason: "iat_future" });
  });

  it("iat が無ければ 401（経過時間を測れないので通さない）", async () => {
    const r = await verifyAged(await signAt(null));
    expect(r).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
  });

  it("上限は aud の判定より先（古いトークンは未知の AUD でも 401）", async () => {
    const jwt = await new SignJWT(user)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience([unknownAud])
      .setSubject(SUB)
      .setIssuedAt(NOW - MAX - 60)
      .setExpirationTime(NOW + 3600)
      .sign(good.privateKey);
    expect(await verifyAged(jwt)).toMatchObject({ status: 401, reason: "too_old" });
  });

  it("nbf が未来（許容を超える）なら 401", async () => {
    const jwt = await new SignJWT({ ...user, nbf: NOW + 120 })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience([devAud])
      .setSubject(SUB)
      .setIssuedAt(NOW - 60)
      .setExpirationTime(NOW + 3600)
      .sign(good.privateKey);
    expect(await verifyAged(jwt)).toMatchObject({ ok: false, status: 401 });
  });

  it("maxAgeSeconds を渡さなければ（Standard）古い iat・iat なしでも従来どおり通る", async () => {
    expect(codeOf(await verify(await signAt(NOW - 86_400)))).toBe("ok");
    expect(codeOf(await verify(await signAt(null)))).toBe("ok");
  });

  it.each([0, -1, 1.5, Number.NaN])("maxAgeSeconds が正の整数でない（%s）なら 500", async (m) => {
    const r = await verifyConsoleAccess(await signAt(NOW - 60), "dev", cfg(), {
      ...opts(),
      maxAgeSeconds: m,
    });
    expect(r).toMatchObject({ ok: false, status: 500, code: "server_misconfigured" });
  });
});
