// wrangler の alias で差し替える JSON モジュール。実体は config/profiles.json（または下流が alias で指す自前のファイル）。
// 形は ProfilesConfig の入力（実行時に parseProfilesConfig が検証する）。
declare module "awsbridge:profiles" {
  const profiles: unknown;
  export default profiles;
}
