// 外への通信の関数（src/console/issue/egress.ts の createEgress が作る関数）への呼び出しを数える spy。
// 「STS を呼ばない」を、擬似の STS が受けた数（egress の下の fetch）だけでなく、egress への呼び出しそのもので確かめる
// （egress が断った宛先・別のリージョンの STS への試みも数える）。照合のイベント（ログ）には頼らない。
// 使い方（試験のファイルの先頭。vi.mock は巻き上げられるので、このモジュールは動的に読む）:
//   vi.mock("../../src/console/issue/egress", async (orig) =>
//     (await import("./console-egress-spy")).spyEgressModule(await orig()));
// このファイルは src を静的に import しない（mock の循環を避ける）。

export type EgressCall = {
  url: string;
  method: string;
  kind: "sts" | "federation" | "certs" | "other";
};

/** これまでの egress への呼び出し（試験ごとに reset する）。 */
export const egressCalls: EgressCall[] = [];

export function resetEgressCalls(): void {
  egressCalls.length = 0;
}

function kindOf(url: string): EgressCall["kind"] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === "sts.amazonaws.com" || /^sts\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return "sts";
  if (host === "signin.aws.amazon.com") return "federation";
  if (url.includes("/cdn-cgi/access/certs")) return "certs";
  return "other";
}

/** STS（どのリージョンでも）と getSigninToken への egress の呼び出しの数。 */
export function issueEgressCalls(): { sts: number; federation: number } {
  return {
    sts: egressCalls.filter((c) => c.kind === "sts").length,
    federation: egressCalls.filter((c) => c.kind === "federation").length,
  };
}

type EgressModule = { createEgress: (...a: never[]) => typeof fetch };

/** egress のモジュールの createEgress を、呼び出しを記録してから本物に渡す形に包む。 */
export function spyEgressModule<M extends EgressModule>(orig: M): M {
  const real = orig.createEgress as unknown as (...a: unknown[]) => typeof fetch;
  return {
    ...orig,
    createEgress: (...args: unknown[]) => {
      const egress = real(...args);
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        egressCalls.push({ url, method, kind: kindOf(url) });
        return egress(input, init);
      }) as typeof fetch;
    },
  };
}
