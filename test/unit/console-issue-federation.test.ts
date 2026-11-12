// コンソールログイン PR2: getSigninToken・ログイン URL・Issuer・Destination（portal §6.1〜§6.3）。
import { describe, expect, it } from "vitest";
import { IssueError } from "../../src/console/issue/errors";
import {
  consoleDestination,
  DEFAULT_REGIONS,
  FEDERATION_ENDPOINT,
  fetchSigninToken,
  getSigninTokenParams,
  loginUrl,
  parseSigninTokenResponse,
  resolveRegion,
  signinIssuer,
  stsEndpoint,
} from "../../src/console/issue/federation";

// 秘密に見える値はソースに直書きせず、実行時に組み立てる
const creds = {
  accessKeyId: ["ASIA", "X".repeat(16)].join(""),
  secretAccessKey: ["sec", "ret", "/+=", "k".repeat(20)].join(""),
  sessionToken: ["tok", "en", "/+==", "t".repeat(40)].join(""),
};

describe("signinIssuer（<team-base>/expired）", () => {
  it("パス方式: <origin>/t/<team>/expired", () => {
    expect(signinIssuer({ origin: "https://portal.example.test", routing: "path" }, "infra")).toBe(
      "https://portal.example.test/t/infra/expired",
    );
  });

  it("ホスト方式: https://<team>.<host>/expired", () => {
    expect(signinIssuer({ origin: "https://portal.example.test", routing: "host" }, "infra")).toBe(
      "https://infra.portal.example.test/expired",
    );
  });

  it.each([
    ["チーム名が規則に合わない", "https://portal.example.test", "Infra/../x"],
    ["origin が https でない", "http://portal.example.test", "infra"],
    ["origin にパスがある", "https://portal.example.test/p", "infra"],
    ["origin が URL でない", "portal", "infra"],
  ])(
    "%s は server_misconfigured（要求の値を使わない。Host ヘッダーも使わない）",
    (_n, origin, team) => {
      const f = () => signinIssuer({ origin, routing: "path" }, team);
      expect(f).toThrow(IssueError);
      try {
        f();
      } catch (e) {
        expect((e as IssueError).code).toBe("server_misconfigured");
      }
    },
  );
});

describe("Destination（許可リストのリージョンだけ）", () => {
  const regions = { allowed: ["ap-northeast-1", "us-east-1"], default: "ap-northeast-1" };

  it("許可リストのリージョンはそのまま使う", () => {
    expect(resolveRegion("us-east-1", regions)).toBe("us-east-1");
    expect(consoleDestination(resolveRegion("us-east-1", regions))).toBe(
      "https://us-east-1.console.aws.amazon.com/console/home?region=us-east-1",
    );
  });

  it.each([
    "eu-west-1", // リストにない
    "", // 空
    undefined,
    null,
    "us-east-1.evil.test/", // URL を差し込もうとする
    "US-EAST-1",
    "us-east-1 ",
  ])("リストにない値 %j は既定のリージョンに置き換える", (v) => {
    expect(resolveRegion(v as string, regions)).toBe("ap-northeast-1");
  });

  it("regions を設定していないときは us-east-1 だけを許可する", () => {
    expect(DEFAULT_REGIONS).toEqual({ allowed: ["us-east-1"], default: "us-east-1" });
    expect(resolveRegion("ap-northeast-1", undefined)).toBe("us-east-1");
  });

  it("consoleDestination は resolveRegion を通した値だけを受ける（型）。形が崩れた値は実行時も拒否する", () => {
    // @ts-expect-error 素の string（許可リストを通していない値）は渡せない
    consoleDestination("us-east-1");
    // @ts-expect-error 素の string は渡せない
    expect(() => consoleDestination("evil.test/x#")).toThrow(IssueError);
  });
});

describe("getSigninToken", () => {
  it("パラメーター: Action・SessionDuration・Session（JSON）。SessionDuration は 900〜43200", () => {
    const p = getSigninTokenParams(creds, 3600);
    expect(p.get("Action")).toBe("getSigninToken");
    expect(p.get("SessionDuration")).toBe("3600");
    expect(JSON.parse(p.get("Session") as string)).toEqual({
      sessionId: creds.accessKeyId,
      sessionKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
    for (const bad of [899, 43201, 1.5, Number.NaN]) {
      expect(() => getSigninTokenParams(creds, bad)).toThrow(IssueError);
    }
  });

  it("応答から SigninToken を取り出す。取れなければ undefined", () => {
    expect(parseSigninTokenResponse('{"SigninToken":"abc"}')).toBe("abc");
    for (const bad of [
      "",
      "not json",
      "[]",
      "null",
      '{"SigninToken":""}',
      '{"SigninToken":1}',
      "{}",
    ])
      expect(parseSigninTokenResponse(bad)).toBeUndefined();
  });

  type Call = { url: string; init: RequestInit };
  const fakeFetch = (res: () => Response | Promise<Response>) => {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it("federation エンドポイントに POST（認証情報は URL に出さない）して SigninToken を返す", async () => {
    const { fn, calls } = fakeFetch(() => new Response('{"SigninToken":"signin-token-1"}'));
    const t = await fetchSigninToken({ credentials: creds, sessionSeconds: 3600, fetch: fn });
    expect(t).toBe("signin-token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FEDERATION_ENDPOINT);
    expect(calls[0]?.url).not.toContain(creds.sessionToken);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new URLSearchParams(String(calls[0]?.init.body)).get("Action")).toBe("getSigninToken");
  });

  const codeOf = async (p: Promise<unknown>) => {
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(IssueError);
    return e as IssueError;
  };
  const run = (fn: typeof fetch) =>
    fetchSigninToken({ credentials: creds, sessionSeconds: 3600, fetch: fn });

  it("redirect: manual で呼び、リダイレクト（3xx）は失敗として扱う", async () => {
    const { fn, calls } = fakeFetch(
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }),
    );
    const e = await fetchSigninToken({ credentials: creds, sessionSeconds: 3600, fetch: fn }).catch(
      (x) => x,
    );
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(e).toBeInstanceOf(IssueError);
    expect((e as IssueError).code).toBe("signin_failed");
  });

  it("4xx・壊れた応答は signin_failed（502）。詳細に本文・認証情報を入れない", async () => {
    for (const make of [
      () => new Response(`denied ${creds.secretAccessKey}`, { status: 400 }),
      () => new Response("{}", { status: 200 }),
      () => new Response("<html>", { status: 200 }),
    ]) {
      const e = await codeOf(run(fakeFetch(make).fn));
      expect(e.code).toBe("signin_failed");
      expect(e.status).toBe(502);
      expect(JSON.stringify([e.message, e.detail])).not.toContain(creds.secretAccessKey);
    }
  });

  it("5xx・ネットワークエラーは temporarily_unavailable（503）", async () => {
    expect((await codeOf(run(fakeFetch(() => new Response("x", { status: 503 })).fn))).code).toBe(
      "temporarily_unavailable",
    );
    const boom = fakeFetch(() => {
      throw new Error(`network ${creds.sessionToken}`);
    });
    const e = await codeOf(run(boom.fn));
    expect(e.code).toBe("temporarily_unavailable");
    expect(JSON.stringify([e.message, e.detail])).not.toContain(creds.sessionToken);
  });
});

describe("loginUrl", () => {
  it("Action=login・Issuer・Destination・SigninToken を持つ URL（既定は federation エンドポイント）", () => {
    const u = new URL(
      loginUrl({
        signinToken: "tok-1",
        issuer: "https://portal.example.test/t/infra/expired",
        destination: consoleDestination(resolveRegion("us-east-1")),
      }),
    );
    expect(`${u.origin}${u.pathname}`).toBe(FEDERATION_ENDPOINT);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      Action: "login",
      Issuer: "https://portal.example.test/t/infra/expired",
      Destination: "https://us-east-1.console.aws.amazon.com/console/home?region=us-east-1",
      SigninToken: "tok-1",
    });
  });

  it("endpoint を差し替えられる（E2E で擬似のエンドポイントを指すとき）", () => {
    expect(
      loginUrl({
        signinToken: "t",
        issuer: "https://a.test/e",
        destination: "https://b.test/",
        endpoint: "http://127.0.0.1:1/federation",
      }),
    ).toMatch(/^http:\/\/127\.0\.0\.1:1\/federation\?/);
  });
});

describe("stsEndpoint（STS のリージョンは設定で選ぶ）", () => {
  it("地域の endpoint を作る", () => {
    expect(stsEndpoint("ap-northeast-1")).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(stsEndpoint("us-east-1")).toBe("https://sts.us-east-1.amazonaws.com/");
  });
  it("リージョンの形でなければ server_misconfigured", () => {
    for (const bad of ["", "evil.test/", "US-EAST-1", "us-east-1.evil"])
      expect(() => stsEndpoint(bad)).toThrow(IssueError);
  });
});
