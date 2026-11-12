// E2E 専用のエントリ（Admin）: 本物のエントリ（src/console/admin/index.ts）をそのまま使い、外向きの通信だけを手元の擬似サーバーへ向ける。
// Access の certs（https://<チームドメイン>/cdn-cgi/access/certs）・STS の地域の endpoint・getSigninToken の 3 つだけを書き換え、
// それ以外の外向きの通信は 502 で止める（実 AWS・Cloudflare を呼ばない）。宛先は変数 E2E_FAKE_BASE（http://127.0.0.1:<port>）。
// 本番のバンドルには入らない（wrangler.console-admin.jsonc の main は src/console/admin/index.ts）。
import worker, { type AdminEnv } from "../../../src/console/admin/index";

type E2EEnv = AdminEnv & { E2E_FAKE_BASE: string };

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

export default {
  fetch(request: Request, env: E2EEnv): Promise<Response> {
    fakeBase = env.E2E_FAKE_BASE;
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<E2EEnv>;
