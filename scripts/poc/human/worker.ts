// PoC 用 issuer Worker（awsbridge-human-poc）のエントリ。
// 文書（discovery と JWKS）は deploy-issuer.ts が手元で作り、wrangler の alias（wrangler.jsonc または --alias）でこのモジュール名に差し込む。
import documents from "awsbridge-human-poc-documents";
import { handleIssuerRequest, type StaticIssuerDocuments } from "./worker-handler";

export default {
  fetch(request: Request): Response {
    return handleIssuerRequest(request, documents as StaticIssuerDocuments);
  },
};
