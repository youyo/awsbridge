// E2E 専用のエントリ: 本物のエントリ（src/console/standard/index.ts）をそのまま使い、外向きの通信だけを手元の擬似サーバーへ向ける。
// Access の certs（https://<チームドメイン>/cdn-cgi/access/certs）・STS の地域の endpoint・getSigninToken の 3 つだけを書き換え、
// それ以外の外向きの通信は 502 で止める（実 AWS・Cloudflare を呼ばない）。宛先は変数 E2E_FAKE_BASE（http://127.0.0.1:<port>）。
// 入口の一覧（S0。U2）の身元のグループの取り方は未確定で、本物のエントリは渡さない（全チームのリンクに落ちる）。
// 変数 E2E_IDENTITY_GROUPS（Object ID のカンマ区切り）があるときだけ、同じ生成物で工場を呼び、その値を返す差し込み口を渡す
// （試験用。要求から値を読まない）。本番のバンドルには入らない（wrangler.console-standard.jsonc の main は src/console/standard/index.ts）。
import display from "awsbridge:console-display";
import config from "awsbridge:console-worker";
import worker, { type StandardEnv } from "../../../src/console/standard/index";
import { createStandardWorker } from "../../../src/console/standard/worker";

type E2EEnv = StandardEnv & { E2E_FAKE_BASE: string; E2E_IDENTITY_GROUPS?: string };

const REWRITES: Record<string, string> = {
  "https://e2e-team.cloudflareaccess.com/cdn-cgi/access/certs": "/certs",
  "https://sts.us-east-1.amazonaws.com/": "/sts",
  "https://signin.aws.amazon.com/federation": "/federation",
};

let fakeBase = "";
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const path = REWRITES[url];
  if (path !== undefined && fakeBase !== "") return realFetch(`${fakeBase}${path}`, init);
  return new Response("blocked by e2e entry", { status: 502 });
}) as typeof fetch;

let grouped: ReturnType<typeof createStandardWorker> | undefined;

export default {
  fetch(request: Request, env: E2EEnv): Promise<Response> {
    fakeBase = env.E2E_FAKE_BASE;
    if (env.E2E_IDENTITY_GROUPS) {
      const groups = env.E2E_IDENTITY_GROUPS.split(",");
      grouped ??= createStandardWorker(
        config,
        { identityGroups: async () => ({ ok: true, groups }) },
        display,
      );
      return grouped.fetch(request, env);
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<E2EEnv>;
