// wrangler の alias で差し替える JSON モジュール（deploy-issuer.ts が作る issuer-documents.json）。
declare module "awsbridge-human-poc-documents" {
  const documents: unknown;
  export default documents;
}
