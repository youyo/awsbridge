// wrangler の alias で差し替える JSON モジュール。実体は生成物 .generated/console/worker.<tier>.json（mise run console:config:generate）。
// 形は WorkerConfig（src/console/types.ts）だが、Worker は信用せずに最初の要求で検査する（src/console/portal/worker-config.ts）。
declare module "awsbridge:console-worker" {
  const config: unknown;
  export default config;
}
