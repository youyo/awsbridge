// コンソールログインの Admin の Worker のエントリ（wrangler.console-admin.jsonc の main）。
// 生成物（alias awsbridge:console-worker-admin → worker.admin.json）を渡して工場を呼ぶだけ。試験用の差し替えは渡さない。
// MCP 用のエントリ（src/index.ts）・Standard の生成物・表示用の生成物は import しない（test/e2e/console-admin-bundle.test.ts）。
import config from "awsbridge:console-worker-admin";
import { type AdminEnv, createAdminWorker } from "./worker";

export type { AdminEnv } from "./worker";

const worker = createAdminWorker(config);

export default {
  fetch: (request: Request, env: AdminEnv): Promise<Response> => worker.fetch(request, env),
} satisfies ExportedHandler<AdminEnv>;
