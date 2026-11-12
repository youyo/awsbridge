// コンソールログインの入口（S0。Standard の / ）: 1 つの一覧（U2）と落とし方。
// 設計: docs/specs/console-login-portal.md §4.1・§5.4・§5.6・§7、ADR の「一覧の統合（U2）」。
// 入口のアプリの Access JWT を確かめてから描く。身元の Entra グループは差し込み口（identityGroups）からサーバー側で取り、
// 表示用の対応表（display.standard.json の groups）と小文字で照合する。表示のためだけで、発行の認可には使わない。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityGroupsSource } from "../../src/console/display/groups";
import { createStandardWorker } from "../../src/console/standard/worker";
import { uuid } from "./console-fixtures";
import {
  AUDS,
  baseEnv,
  createHarness,
  displayConfig,
  ENTRY,
  type Harness,
  loginRequest,
  PORTAL_HOST,
  standardConfig,
} from "./console-standard-harness";

let h: Harness;
let logs: string[];

beforeEach(async () => {
  h = await createHarness();
  logs = [];
  for (const m of ["log", "error", "warn"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ENTRY_AUD = AUDS.entry.standard;

const failing: IdentityGroupsSource = async () => ({ ok: false, reason: "unavailable" });

/** 表示用の生成物は、引数を省いたときだけ既定（undefined を渡せば「無い」）。 */
function worker(identityGroups?: IdentityGroupsSource, ...display: [unknown?]) {
  return createStandardWorker(
    standardConfig(),
    { getAccessKey: h.getAccessKey, fetch: h.fetch, identityGroups },
    display.length > 0 ? display[0] : displayConfig(),
  );
}

async function entry(
  w: ReturnType<typeof worker>,
  opts: { jwt?: string | null; path?: string; method?: string } = {},
) {
  const headers = new Headers();
  const jwt = opts.jwt === undefined ? await h.accessJwt({ aud: ENTRY_AUD }) : opts.jwt;
  if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
  return w.fetch(
    new Request(`https://${PORTAL_HOST}${opts.path ?? "/"}`, {
      method: opts.method ?? "GET",
      headers,
    }),
    baseEnv(h),
  );
}

describe("S0 入口: 所属が分からないときの落とし方（最初の Red）", () => {
  it("グループの取得が失敗したら、行を出さず全チーム（Standard と Admin）の S1 へのリンクを出す", async () => {
    const res = await entry(worker(failing));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("所属を確かめられませんでした");
    // 全チームの S1 へのリンク（Standard はこのオリジンのパス、Admin は Admin のオリジン）
    for (const t of ["infra", "dev", "sa"]) expect(html).toContain(`href="/t/${t}/"`);
    for (const t of ["infra-elevated", "dev-elevated"])
      expect(html).toContain(`href="https://admin-portal.example.com/t/${t}/"`);
    expect(html).toContain("[ADMIN]");
    // 行（アカウント）は出さない
    expect(html).not.toContain("333333333333");
    expect(html).not.toContain("svc-a-prod");
    expect(html).not.toContain("/a/");
  });
});

const groupsOf =
  (...ids: string[]): IdentityGroupsSource =>
  async () => ({ ok: true, groups: ids });

describe("S0 入口: 所属するチームの行（U2。表示のためだけ）", () => {
  it("グループ（Object ID は大文字でも小文字で照合）のチームの行だけを出し、ロールはそのチームのパスの S2 へのリンク", async () => {
    const lower = "abcdef01-aaaa-4bbb-8ccc-ddddeeeeffff";
    const display = { ...displayConfig(), groups: [{ objectId: lower, teams: ["infra"] }] };
    const res = await entry(worker(groupsOf(lower.toUpperCase()), display));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("あなたが入れるもの");
    expect(html).toContain("svc-a-prod");
    expect(html).toContain('href="/t/infra/a/333333333333?role=readonly"');
    expect(html).toContain('href="/t/infra/a/222222222222?role=readonly"');
    // 所属しないチーム（dev・sa・Admin のチーム）の割り当ては出さない
    expect(html).not.toContain("/t/dev/");
    expect(html).not.toContain("/t/sa/");
    expect(html).not.toContain("admin-portal.example.com");
    expect(html).not.toContain("[ADMIN]");
  });

  it("Admin のチームのグループなら、Administrator の行は Admin のオリジンの S2 へのリンクで [ADMIN] の印", async () => {
    const html = await (await entry(worker(groupsOf(uuid(1), uuid(4))))).text();
    expect(html).toContain(
      'href="https://admin-portal.example.com/t/infra-elevated/a/333333333333?role=admin"',
    );
    expect(html).toContain("[ADMIN]");
    expect(html).toContain('href="/t/infra/a/333333333333?role=readonly"');
    // Admin のチームの S2 を Standard のオリジンに作らない
    expect(html).not.toContain('href="/t/infra-elevated/');
  });

  it("S0 にはアカウントの email・AUD・ロールの ARN を出さない", async () => {
    const html = await (await entry(worker(groupsOf(uuid(1), uuid(2), uuid(3), uuid(4))))).text();
    expect(html).toContain("svc-a-prod");
    expect(html).not.toMatch(/aws\+[a-z-]+@example\.(com|org)/);
    for (const aud of [...Object.values(AUDS.teams), AUDS.entry.standard, AUDS.entry.admin])
      expect(html).not.toContain(aud);
    expect(html).not.toContain("arn:aws:iam::");
    expect(html).not.toContain("/awsbridge-console/");
  });

  it("グループは取れたがどのチームにも当たらなければ「所属なし」（行もチームのリンクも出さない。分からないとは区別）", async () => {
    const html = await (await entry(worker(groupsOf(uuid(99))))).text();
    expect(html).toContain("所属しているチームがありません");
    expect(html).not.toContain("所属を確かめられませんでした");
    expect(html).not.toContain('href="/t/');
    expect(html).not.toContain("svc-a-prod");
  });

  it("グループが空の配列（どのグループにも属さない）も「所属なし」", async () => {
    const html = await (await entry(worker(groupsOf()))).text();
    expect(html).toContain("所属しているチームがありません");
  });
});

describe("S0 入口: 分からないときは全チームの S1 へのリンクに落とす", () => {
  const fallback = (html: string) => {
    expect(html).toContain("所属を確かめられませんでした");
    for (const t of ["infra", "dev", "sa"]) expect(html).toContain(`href="/t/${t}/"`);
    expect(html).not.toContain("/a/");
  };

  it("取り方が未設定（本番のエントリの既定）", async () => {
    fallback(await (await entry(worker(undefined))).text());
    expect(logs.join("\n")).toContain("membership unknown: not_configured");
  });

  it("溢れた・壊れている・例外を投げた・形が違う・数が上限を超えた", async () => {
    const sources: IdentityGroupsSource[] = [
      async () => ({ ok: false, reason: "overflow" }),
      async () => ({ ok: false, reason: "malformed" }),
      async () => {
        throw new Error("boom uuid-secret-value");
      },
      // biome-ignore lint/suspicious/noExplicitAny: 形の崩れた結果を試す
      (async () => ({ ok: true, groups: "x" })) as any,
      // biome-ignore lint/suspicious/noExplicitAny: 形の崩れた結果を試す
      (async () => ({ ok: true, groups: [uuid(1), 42] })) as any,
      // biome-ignore lint/suspicious/noExplicitAny: 形の崩れた結果を試す
      (async () => null) as any,
      groupsOf(...Array.from({ length: 1001 }, (_, i) => uuid(1000 + i))),
    ];
    for (const s of sources) fallback(await (await entry(worker(s))).text());
    // ログは種別だけ（例外の文・値を出さない）
    expect(logs.join("\n")).not.toContain("uuid-secret-value");
  });

  it("開発・個人の環境（対応表に Object ID が無い）は、グループが取れても「所属なし」ではなく落とし方の経路", async () => {
    const display = { ...displayConfig(), groups: [] };
    fallback(await (await entry(worker(groupsOf(uuid(1)), display))).text());
  });

  it("差し込み口には検証済みの入口の JWT と Access のチームドメインだけを渡す（要求のヘッダー・クエリのグループは使わない）", async () => {
    const seen: unknown[] = [];
    const src: IdentityGroupsSource = async (ctx) => {
      seen.push(ctx);
      return { ok: false, reason: "unavailable" };
    };
    const jwt = await h.accessJwt({ aud: ENTRY_AUD });
    const res = await worker(src).fetch(
      new Request(`https://${PORTAL_HOST}/?groups=${uuid(1)}`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt, "X-Groups": uuid(1) },
      }),
      baseEnv(h),
    );
    const html = await res.text();
    expect(html).toContain("所属を確かめられませんでした");
    expect(seen).toHaveLength(1);
    const ctx = seen[0] as { accessJwt: string; teamDomain: string; claims: { aud: unknown } };
    expect(ctx.accessJwt).toBe(jwt);
    expect(ctx.teamDomain).toBe("https://unit-team.cloudflareaccess.com");
    expect(Object.keys(ctx).sort()).toEqual(["accessJwt", "claims", "teamDomain"]);
  });
});

describe("S0 入口: 入口のアプリの Access JWT を確かめてから描く", () => {
  it("JWT が無ければ 401、チームの AUD・[入口, チーム] の aud なら 403 unknown_audience。差し込み口を呼ばない", async () => {
    let called = 0;
    const src: IdentityGroupsSource = async () => {
      called++;
      return { ok: true, groups: [uuid(1)] };
    };
    const w = worker(src);
    expect((await entry(w, { jwt: null })).status).toBe(401);
    const team = await entry(w, { jwt: await h.accessJwt({ aud: AUDS.teams.infra as string }) });
    expect(team.status).toBe(403);
    expect(await team.text()).toContain("unknown_audience");
    const both = await entry(w, {
      jwt: await h.accessJwt({ aud: [ENTRY_AUD, AUDS.teams.infra as string] }),
    });
    expect(both.status).toBe(403);
    expect(called).toBe(0);
  });

  it("入口の AUD が発行用の生成物に無ければ 500 server_misconfigured", async () => {
    const config = standardConfig();
    delete config.portal.entryAud;
    const w = createStandardWorker(
      config,
      { getAccessKey: h.getAccessKey, fetch: h.fetch, identityGroups: failing },
      displayConfig(),
    );
    expect((await entry(w)).status).toBe(500);
  });

  it("HEAD は GET と同じ（本文なし）、POST は 405", async () => {
    const w = worker(failing);
    const head = await entry(w, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await entry(w, { method: "POST" })).status).toBe(405);
  });
});

describe("S0 入口: 表示用の生成物の誤りは入口だけを止める", () => {
  it("表示用の生成物が無い・壊れている・発行用の生成物を取り違えた・オリジンが違えば / は 500（ログは種別だけ）", async () => {
    const broken: unknown[] = [
      undefined,
      { purpose: "display" },
      standardConfig(),
      {
        ...displayConfig(),
        portal: { ...displayConfig().portal, origin: "https://other.example.com" },
      },
      {
        ...displayConfig(),
        accounts: displayConfig().accounts.map((a) => ({ ...a, email: "x@example.com" })),
      },
    ];
    for (const [i, d] of broken.entries()) {
      const res = await entry(worker(failing, d));
      expect(res.status, `broken[${i}]`).toBe(500);
      expect(await res.text()).toContain("server_misconfigured");
    }
    expect(logs.join("\n")).toContain("config: invalid console display:");
  });

  it("表示用の生成物が壊れていても、チームのページ（S2）と発行（POST → 302）は動く", async () => {
    const w = worker(failing, { purpose: "display" });
    const jwt = await h.accessJwt({ aud: AUDS.teams.infra as string });
    const s2 = await w.fetch(
      new Request(`https://${PORTAL_HOST}/t/infra/a/333333333333`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      baseEnv(h),
    );
    expect(s2.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await s2.text())?.[1] as string;
    const res = await w.fetch(
      loginRequest({ jwt, form: { entry: ENTRY, region: "ap-northeast-1", csrf } }),
      baseEnv(h),
    );
    expect(res.status).toBe(302);
  });
});

describe("U2 の条件: 表示用の照合は発行の認可に使わない", () => {
  it("入口のアプリの JWT は、身元のグループにチームが入っていても POST で 403 unknown_audience（発行しない）", async () => {
    const w = worker(groupsOf(uuid(1)));
    // 表示では infra の行が出る
    expect(await (await entry(w)).text()).toContain('href="/t/infra/a/333333333333?role=readonly"');
    const res = await w.fetch(
      loginRequest({
        jwt: await h.accessJwt({ aud: ENTRY_AUD }),
        form: { entry: ENTRY, region: "ap-northeast-1", csrf: await h.csrf(ENTRY_AUD) },
      }),
      baseEnv(h),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unknown_audience");
    expect(h.seen.sts).toHaveLength(0);
  });

  it("表示では infra に所属していても、チームのアプリの JWT が別のチーム（dev）なら /t/infra/login は 403 team_mismatch", async () => {
    const w = worker(groupsOf(uuid(1)));
    const dev = AUDS.teams.dev as string;
    const res = await w.fetch(
      loginRequest({
        jwt: await h.accessJwt({ aud: dev }),
        form: { entry: ENTRY, region: "ap-northeast-1", csrf: await h.csrf(dev) },
      }),
      baseEnv(h),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("team_mismatch");
    expect(h.seen.sts).toHaveLength(0);
  });
});

describe("S0 入口: 画面の JS に渡すデータ", () => {
  it("inline の script を使わず、最近使ったもののためのチームの起点と Admin のチームを data-json で渡す（email・AUD・行は入れない）", async () => {
    const html = await (await entry(worker(groupsOf(uuid(1), uuid(4))))).text();
    for (const tag of html.match(/<script\b[^>]*>/g) ?? [])
      expect(tag).toMatch(/\ssrc="\/assets\/portal\.js"/);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
    const m = /<div id="portal-data" data-json="([^"]*)" hidden><\/div>/.exec(html);
    expect(m).not.toBeNull();
    const data = JSON.parse((m?.[1] as string).replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(data).toEqual({
      teams: {
        infra: "/t/infra",
        "infra-elevated": "https://admin-portal.example.com/t/infra-elevated",
      },
      adminTeams: ["infra-elevated"],
    });
  });
});
