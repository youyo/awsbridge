// コンソールログイン（Standard）の CSRF の鍵の投入（scripts/console/secrets-lib.ts。mise タスク console:secrets:standard）。
// 署名鍵は secret_key（console:standard-key:put）に移ったので、この道具は CONSOLE_CSRF_KEY（secret_text のまま）だけを入れる。
// 鍵は道具の中で作り（32 バイトの乱数）、Cloudflare API の PUT .../secrets（secret_text）で入れる。ファイルに書かない・出力しない。
// --yes が無ければ表示だけ。同じ名前が secret_text 以外（secret_key など）なら入れない。トークンは Standard 用（standard-key と同じ）。
import { describe, expect, it } from "vitest";
import { CSRF_SECRET_NAME, runCsrfPut } from "../../scripts/console/secrets-lib";
import type { Deps, Settings } from "../../scripts/console/standard-key-lib";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCRIPT = "awsbridge-console-standard";
const TOKEN = ["cf", "token", "c".repeat(32)].join("-");
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`;

const s: Settings = {
  wranglerConfigPath: "wrangler.console-standard.jsonc",
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

describe("console:secrets:standard（CONSOLE_CSRF_KEY だけ）", () => {
  it("--yes が無ければ表示だけ（API・トークンを使わない）", async () => {
    const f = fakeDeps(() => cfJson({}));
    expect(await runCsrfPut(s, f.d, { yes: false })).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(f.tokenCalls()).toBe(0);
    const text = f.out.join("\n");
    expect(text).toContain(CSRF_SECRET_NAME);
    expect(text).toContain("--yes");
    expect(text).toContain("console:standard-key:put");
  });

  it("--yes: 一覧を確かめてから PUT（secret_text・32 バイトの乱数）。値とトークンは出力しない", async () => {
    let body: Record<string, string> = {};
    const f = fakeDeps((c) => {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      if (c.method === "GET")
        return cfJson({
          success: true,
          result: [{ name: "CONSOLE_CSRF_KEY", type: "secret_text" }],
        });
      body = JSON.parse(c.body);
      return cfJson({ success: true, result: { name: CSRF_SECRET_NAME, type: "secret_text" } });
    });
    expect(await runCsrfPut(s, f.d, { yes: true })).toBe(0);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}`, `PUT ${API}`]);
    expect(Object.keys(body).sort()).toEqual(["name", "text", "type"]);
    expect(body.name).toBe(CSRF_SECRET_NAME);
    expect(body.type).toBe("secret_text");
    expect(body.text).toMatch(/^[0-9a-f]{64}$/);
    const text = f.out.join("\n");
    expect(text).not.toContain(body.text as string);
    expect(text).not.toContain(TOKEN);
  });

  it("毎回別の値を作る（作り直すと出ている CSRF トークンは使えなくなる）", async () => {
    const texts: string[] = [];
    const f = fakeDeps((c) => {
      if (c.method === "GET") return cfJson({ success: true, result: [] });
      texts.push(JSON.parse(c.body).text);
      return cfJson({ success: true, result: { name: CSRF_SECRET_NAME, type: "secret_text" } });
    });
    await runCsrfPut(s, f.d, { yes: true });
    await runCsrfPut(s, f.d, { yes: true });
    expect(new Set(texts).size).toBe(2);
  });

  it("同じ名前が secret_text 以外（secret_key など）なら入れない", async () => {
    const f = fakeDeps(() =>
      cfJson({ success: true, result: [{ name: CSRF_SECRET_NAME, type: "secret_key" }] }),
    );
    expect(await runCsrfPut(s, f.d, { yes: true })).toBe(1);
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("一覧を読めなければ入れない。PUT の失敗は code と message だけを出す", async () => {
    const broken = fakeDeps(() => cfJson({ success: false }, 500));
    expect(await runCsrfPut(s, broken.d, { yes: true })).toBe(1);
    expect(broken.calls.map((c) => c.method)).toEqual(["GET"]);
    let sent = "";
    const failed = fakeDeps((c) => {
      if (c.method === "GET") return cfJson({ success: true, result: [] });
      sent = JSON.parse(c.body).text;
      return cfJson(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        403,
      );
    });
    expect(await runCsrfPut(s, failed.d, { yes: true })).toBe(1);
    expect(failed.out.join("\n")).toContain("10000");
    expect(failed.out.join("\n")).not.toContain(sent);
  });
});
