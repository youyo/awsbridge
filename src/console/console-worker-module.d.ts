// wrangler の alias で差し替える JSON モジュール。実体は生成物 .generated/console/worker.<tier>.json（mise run console:config:generate）。
// 形は WorkerConfig（src/console/types.ts）だが、Worker は信用せずに最初の要求で検査する（src/console/portal/worker-config.ts）。
declare module "awsbridge:console-worker" {
  const config: unknown;
  export default config;
}

// Admin の Worker 用（実体は生成物 .generated/console/worker.admin.json）。Standard の alias とは別の名前にして、取り違えをバンドルの試験で見つける。
declare module "awsbridge:console-worker-admin" {
  const config: unknown;
  export default config;
}

// Standard の Worker の入口の一覧（S0）用の表示用の生成物（実体は .generated/console/display.standard.json）。
// 形は DisplayConfig（src/console/types.ts）。Standard のエントリだけが読み、発行の経路と Admin の Worker は読まない。
declare module "awsbridge:console-display" {
  const display: unknown;
  export default display;
}
