// wrangler の alias で差し替える JSON モジュール（probe.ts deploy が作る issuer-documents.json）。
declare module "awsbridge-g2-probe-documents" {
  const documents: unknown;
  export default documents;
}
