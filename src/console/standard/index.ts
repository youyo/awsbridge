// コンソールログインの Standard の Worker のエントリ（wrangler.console-standard.jsonc の main）。
// 生成物（alias awsbridge:console-worker → worker.standard.json）と表示用の生成物（alias awsbridge:console-display →
// display.standard.json。入口の一覧 S0 だけが読む）を渡して工場を呼ぶだけ。試験用の差し替えは渡さない。
// 身元のグループの取り方（identityGroups）は未確定なので渡さない（入口は全チームの S1 へのリンクに落ちる）。
// MCP 用のエントリ（src/index.ts）・Admin の生成物は import しない（test/e2e/console-isolation.test.ts）。
import display from "awsbridge:console-display";
import config from "awsbridge:console-worker";
import { createStandardWorker, type StandardEnv } from "./worker";

export type { StandardEnv } from "./worker";

const worker = createStandardWorker(config, {}, display);

export default {
  fetch: (request: Request, env: StandardEnv): Promise<Response> => worker.fetch(request, env),
} satisfies ExportedHandler<StandardEnv>;
