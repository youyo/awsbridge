// wrangler の alias で差し替える JSON モジュール（deploy.ts が作る issuer-documents.json）。
declare module "awsbridge-admin-kms-poc-documents" {
  const documents: unknown;
  export default documents;
}
