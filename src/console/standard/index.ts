// コンソールログインの Standard の Worker のエントリ（wrangler.console-standard.jsonc の main）。
// 生成物（alias awsbridge:console-worker → worker.standard.json）を渡して工場を呼ぶだけ。試験用の差し替えは渡さない。
// MCP 用のエントリ（src/index.ts）・表示用の生成物・Admin の生成物は import しない（test/e2e/console-standard-bundle.test.ts）。
import config from "awsbridge:console-worker";
import { createStandardWorker, type StandardEnv } from "./worker";

export type { StandardEnv } from "./worker";

const worker = createStandardWorker(config);

export default {
  fetch: (request: Request, env: StandardEnv): Promise<Response> => worker.fetch(request, env),
} satisfies ExportedHandler<StandardEnv>;
