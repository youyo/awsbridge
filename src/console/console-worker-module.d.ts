// wrangler の alias で差し替える JSON モジュール。実体は生成物 .generated/console/worker.json（mise run console:config:generate）。
// 形は WorkerConfig（src/console/types.ts）だが、Worker は信用せずに最初の要求で検査する（src/console/portal/worker-config.ts）。
declare module "awsbridge:console-worker" {
  const config: unknown;
  export default config;
}

// 入口の一覧（S0）用の表示用の生成物（実体は .generated/console/display.json）。
// 形は DisplayConfig（src/console/types.ts）。エントリの入口の処理だけが読み、発行の経路は読まない。
declare module "awsbridge:console-display" {
  const display: unknown;
  export default display;
}
