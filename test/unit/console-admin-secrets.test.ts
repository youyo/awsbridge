// コンソールログイン（Admin）の CSRF の鍵の投入（scripts/console/secrets-lib.ts の runCsrfPut を Admin の宛先で。mise タスク console:secrets:admin）。
// 道具の中で 32 バイトの乱数を作り、Cloudflare API の PUT .../secrets（secret_text）で Admin の Worker に入れる。ファイルに書かない・出力しない。
// --yes が無ければ表示だけ。同じ名前が secret_text 以外（secret_key など）なら入れない。署名鍵は入れない（console:admin-key:put）。
// cto の決裁 G2 の論点 5（Admin の CSRF の鍵の道具）。Standard の道具（console:secrets:standard）の表示は変えない。
import { describe, expect, it } from "vitest";
import type { Deps } from "../../scripts/console/admin-key-lib";
import { CSRF_SECRET_NAME, type CsrfTarget, runCsrfPut } from "../../scripts/console/secrets-lib";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "awsbridge-console-admin";
const TOKEN = ["cf", "token", "a".repeat(32)].join("-");
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`;

const s: CsrfTarget = {
  wranglerConfigPath: "wrangler.console-admin.jsonc",
  scriptName: SCRIPT,
  accountId: ACCOUNT,
  apiBase: "https://api.cloudflare.com/client/v4",
};

type Call = { method: string; url: string; auth: string | null; body: string };
function fakeDeps(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const out: string[] = [];
  let tokenCalls = 0;
  const d: Deps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      return handler(call);
    }) as typeof fetch,
    token: async () => {
      tokenCalls++;
      return TOKEN;
    },
    print: (l) => out.push(l),
  };
  return { d, calls, out, tokenCalls: () => tokenCalls };
}
const cfJson = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe("console:secrets:admin（Admin の Worker の CONSOLE_CSRF_KEY だけ）", () => {
  it("--yes が無ければ表示だけ（API・トークンを使わない）。Admin のタスク名・署名鍵の道具・Standard と別の値を示す", async () => {
    const f = fakeDeps(() => cfJson({}));
    expect(await runCsrfPut(s, f.d, { yes: false, tier: "admin" })).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(f.tokenCalls()).toBe(0);
    const text = f.out.join("\n");
    expect(text).toContain("console:secrets:admin");
    expect(text).toContain(CSRF_SECRET_NAME);
    expect(text).toContain(SCRIPT);
    expect(text).toContain("--yes");
    expect(text).toContain("console:admin-key:put");
    expect(text).toContain("Standard");
    expect(text).not.toContain("console:secrets:standard");
    expect(text).not.toContain("console:standard-key:put");
  });

  it("--yes: Admin の Worker の一覧を確かめてから PUT（secret_text・32 バイトの乱数）。値とトークンは出力しない", async () => {
    let body: Record<string, string> = {};
    const f = fakeDeps((c) => {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      if (c.method === "GET") return cfJson({ success: true, result: [] });
      body = JSON.parse(c.body);
      return cfJson({ success: true, result: { name: CSRF_SECRET_NAME, type: "secret_text" } });
    });
    expect(await runCsrfPut(s, f.d, { yes: true, tier: "admin" })).toBe(0);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}`, `PUT ${API}`]);
    expect(Object.keys(body).sort()).toEqual(["name", "text", "type"]);
    expect(body).toMatchObject({ name: CSRF_SECRET_NAME, type: "secret_text" });
    expect(body.text).toMatch(/^[0-9a-f]{64}$/);
    const text = f.out.join("\n");
    expect(text).not.toContain(body.text as string);
    expect(text).not.toContain(TOKEN);
  });

  it("同じ名前が secret_text 以外（Admin の署名鍵と同じ secret_key など）なら入れない", async () => {
    const f = fakeDeps(() =>
      cfJson({ success: true, result: [{ name: CSRF_SECRET_NAME, type: "secret_key" }] }),
    );
    expect(await runCsrfPut(s, f.d, { yes: true, tier: "admin" })).toBe(1);
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("tier を省くと Standard の表示のまま（console:secrets:standard の出力を変えない）", async () => {
    const f = fakeDeps(() => cfJson({}));
    expect(await runCsrfPut(s, f.d, { yes: false })).toBe(0);
    const text = f.out.join("\n");
    expect(text).toContain("console:secrets:standard");
    expect(text).toContain("console:standard-key:put");
    expect(text).not.toContain("console:secrets:admin");
  });
});
