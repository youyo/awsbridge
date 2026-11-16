// 外からの比較の取得（scripts/console/exposure-check-net.ts）: 公開の DNS（DoH）で引いた IP に、SNI つきで接続して GET する。
// 手元の DNS の否定のキャッシュに左右されないため、名前の解決は DoH（既定 https://cloudflare-dns.com/dns-query）で行う。
// ここでは DoH の応答の読み方・宛先の上書きの制限・IP の試し方を、fetch と GET の差し替えで試す。TLS を含む実接続は e2e。
import { describe, expect, it } from "vitest";
import {
  connectPortFrom,
  DEFAULT_DOH_URL,
  dohUrlFrom,
  makeFetchDoc,
  resolveViaDoh,
} from "../../scripts/console/exposure-check-net";
import type { DocResponse } from "../../src/console/exposure";

const dohJson = (answers: { type: number; data: string }[], Status = 0) =>
  new Response(JSON.stringify({ Status, Answer: answers }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });

describe("dohUrlFrom・connectPortFrom", () => {
  it("既定は cloudflare-dns.com。上書きは手元（127.0.0.1）の http だけ", () => {
    expect(dohUrlFrom({})).toBe(DEFAULT_DOH_URL);
    expect(DEFAULT_DOH_URL).toBe("https://cloudflare-dns.com/dns-query");
    expect(
      dohUrlFrom({ AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL: "http://127.0.0.1:8053/dns-query" }),
    ).toBe("http://127.0.0.1:8053/dns-query");
    for (const v of [
      "https://evil.example.com/dns-query",
      "http://localhost:80/x",
      "http://10.0.0.1:80/",
    ])
      expect(() => dohUrlFrom({ AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL: v })).toThrow();
  });

  it("接続先のポートの上書きは、DoH も上書きしている（試験の）ときだけ", () => {
    expect(connectPortFrom({})).toBe(443);
    expect(connectPortFrom({ AWSBRIDGE_CONSOLE_EXPOSURE_CONNECT_PORT: "8443" })).toBe(443);
    expect(
      connectPortFrom({
        AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL: "http://127.0.0.1:8053/dns-query",
        AWSBRIDGE_CONSOLE_EXPOSURE_CONNECT_PORT: "8443",
      }),
    ).toBe(8443);
    expect(() =>
      connectPortFrom({
        AWSBRIDGE_CONSOLE_EXPOSURE_DOH_URL: "http://127.0.0.1:8053/dns-query",
        AWSBRIDGE_CONSOLE_EXPOSURE_CONNECT_PORT: "abc",
      }),
    ).toThrow();
  });
});

describe("resolveViaDoh", () => {
  it("A と AAAA を引いて IP を返す（CNAME は読み飛ばす）。dns-json で、名前と種類をクエリに入れる", async () => {
    const seen: string[] = [];
    const ips = await resolveViaDoh(
      "id.example.com",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        seen.push(`${u.searchParams.get("name")}/${u.searchParams.get("type")}`);
        expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
        return u.searchParams.get("type") === "A"
          ? dohJson([
              { type: 5, data: "x.example.net." },
              { type: 1, data: "192.0.2.10" },
            ])
          : dohJson([{ type: 28, data: "2001:db8::10" }]);
      }) as typeof fetch,
      "https://doh.example/dns-query",
    );
    expect(ips).toEqual(["192.0.2.10", "2001:db8::10"]);
    expect(seen.sort()).toEqual(["id.example.com/A", "id.example.com/AAAA"]);
  });

  it("IP の形でない答えは捨てる。1 つも無ければ例外", async () => {
    await expect(
      resolveViaDoh(
        "id.example.com",
        (async () => dohJson([{ type: 1, data: "not-an-ip" }])) as typeof fetch,
        "https://doh.example/dns-query",
      ),
    ).rejects.toThrow();
  });

  it("NXDOMAIN（Status 3）・HTTP 500・JSON でない・fetch の失敗は例外", async () => {
    for (const f of [
      async () => dohJson([], 3),
      async () => new Response("x", { status: 500 }),
      async () => new Response("<html>", { status: 200 }),
      async () => {
        throw new Error("net");
      },
    ])
      await expect(
        resolveViaDoh(
          "id.example.com",
          f as unknown as typeof fetch,
          "https://doh.example/dns-query",
        ),
      ).rejects.toThrow();
  });

  it("DoH の応答の本文が上限（256KB）を超えたら例外（IP は取れない）", async () => {
    const big = JSON.stringify({
      Status: 0,
      Answer: [{ type: 1, data: "192.0.2.10" }],
      pad: "x".repeat(300 * 1024),
    });
    await expect(
      resolveViaDoh(
        "id.example.com",
        (async () => new Response(big, { status: 200 })) as unknown as typeof fetch,
        "https://doh.example/dns-query",
      ),
    ).rejects.toThrow();
  });

  it("片方（AAAA）が失敗しても、もう片方で IP が取れればよい", async () => {
    const ips = await resolveViaDoh(
      "id.example.com",
      (async (input: RequestInfo | URL) =>
        new URL(String(input)).searchParams.get("type") === "A"
          ? dohJson([{ type: 1, data: "192.0.2.10" }])
          : new Response("x", { status: 500 })) as typeof fetch,
      "https://doh.example/dns-query",
    );
    expect(ips).toEqual(["192.0.2.10"]);
  });
});

describe("makeFetchDoc", () => {
  const resp = (status = 200): DocResponse => ({ kind: "response", status, json: { ok: 1 } });

  it("ホストごとに 1 回だけ引き、IP・ホスト名・パス・ポートを GET に渡す。文書ごとに GET は 1 回", async () => {
    const dns: string[] = [];
    const gets: { ip: string; host: string; path: string; port: number }[] = [];
    const f = makeFetchDoc({
      resolve: async (h) => {
        dns.push(h);
        return ["192.0.2.10"];
      },
      get: async (o) => {
        gets.push({ ip: o.ip, host: o.host, path: o.path, port: o.port });
        return resp();
      },
      port: 443,
    });
    await f("https://id.example.com/standard/.well-known/jwks.json");
    await f("https://id.example.com/standard/.well-known/openid-configuration");
    expect(dns).toEqual(["id.example.com"]);
    expect(gets).toEqual([
      {
        ip: "192.0.2.10",
        host: "id.example.com",
        path: "/standard/.well-known/jwks.json",
        port: 443,
      },
      {
        ip: "192.0.2.10",
        host: "id.example.com",
        path: "/standard/.well-known/openid-configuration",
        port: 443,
      },
    ]);
  });

  it("接続できなければ次の IP を試す。応答が返れば（404 でも）そこで止める", async () => {
    const tried: string[] = [];
    const f = makeFetchDoc({
      resolve: async () => ["192.0.2.10", "192.0.2.11", "192.0.2.12"],
      get: async (o) => {
        tried.push(o.ip);
        return o.ip === "192.0.2.10"
          ? { kind: "error", reason: "connect" }
          : { kind: "response", status: 404 };
      },
      port: 443,
    });
    expect(await f("https://id.example.com/a")).toEqual({ kind: "response", status: 404 });
    expect(tried).toEqual(["192.0.2.10", "192.0.2.11"]);
  });

  it("次の IP へ進むのは connect と timeout だけ。tls（証明書の不正）は次の IP を試さず即エラー", async () => {
    for (const reason of ["connect", "timeout"]) {
      const tried: string[] = [];
      const f = makeFetchDoc({
        resolve: async () => ["192.0.2.10", "192.0.2.11"],
        get: async (o) => {
          tried.push(o.ip);
          return o.ip === "192.0.2.10" ? { kind: "error", reason } : resp();
        },
        port: 443,
      });
      expect((await f("https://id.example.com/a")).kind).toBe("response");
      expect(tried).toEqual(["192.0.2.10", "192.0.2.11"]);
    }
    for (const reason of ["tls", "too_large", "error"]) {
      const tried: string[] = [];
      const f = makeFetchDoc({
        resolve: async () => ["192.0.2.10", "192.0.2.11"],
        get: async (o) => {
          tried.push(o.ip);
          return o.ip === "192.0.2.10" ? { kind: "error", reason } : resp();
        },
        port: 443,
      });
      expect(await f("https://id.example.com/a")).toEqual({ kind: "error", reason });
      expect(tried).toEqual(["192.0.2.10"]);
    }
  });

  it("すべての IP に接続できなければ error。名前を引けなければ error（一致にしない）", async () => {
    const f = makeFetchDoc({
      resolve: async () => ["192.0.2.10"],
      get: async () => ({ kind: "error", reason: "timeout" }),
      port: 443,
    });
    expect(await f("https://id.example.com/a")).toEqual({ kind: "error", reason: "timeout" });
    const g = makeFetchDoc({
      resolve: async () => {
        throw new Error("dns");
      },
      get: async () => resp(),
      port: 443,
    });
    expect(await g("https://id.example.com/a")).toMatchObject({ kind: "error", reason: "dns" });
  });

  it("https 以外の URL は取らない", async () => {
    const f = makeFetchDoc({
      resolve: async () => ["192.0.2.10"],
      get: async () => resp(),
      port: 443,
    });
    expect(await f("http://id.example.com/a")).toMatchObject({ kind: "error" });
  });
});
