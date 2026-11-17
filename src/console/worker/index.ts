// コンソールログインの Worker のエントリ（wrangler.console.jsonc の main。Standard と Admin の両方のチームを受ける 1 つの Worker）。
// 生成物（alias awsbridge:console-worker → worker.json）と表示用の生成物（alias awsbridge:console-display →
// display.json。入口の一覧 S0 だけが読む）を渡して工場を呼ぶだけ。試験用の差し替えは渡さない。
// 身元のグループの取り方（identityGroups）は未確定なので渡さない（入口は全チームの S1 へのリンクに落ちる）。
// MCP 用のエントリ（src/index.ts）は import しない（test/e2e/console-isolation.test.ts）。
import display from "awsbridge:console-display";
import config from "awsbridge:console-worker";
import { type ConsoleEnv, createConsoleWorker } from "./worker";

export type { ConsoleEnv } from "./worker";

const worker = createConsoleWorker(config, {}, display);

export default {
  fetch: (request: Request, env: ConsoleEnv): Promise<Response> => worker.fetch(request, env),
} satisfies ExportedHandler<ConsoleEnv>;
