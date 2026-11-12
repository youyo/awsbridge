// PoC N6 の issuer Worker（awsbridge-admin-kms-poc）のエントリ。処理は handler.ts。
// 文書（discovery と JWKS）は deploy.ts が KMS の GetPublicKey から作り、wrangler の alias でこのモジュール名に差し込む。
// 設定は deploy.ts が vars（ISSUER・ROLE_ARN・KMS_KEYS・AWS_REGION）で、秘密は access-key.ts が secret
// （AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY・CALLER_TOKEN）で渡す。
import documents from "awsbridge-admin-kms-poc-documents";
import type { StaticIssuerDocuments } from "../human/worker-handler";
import { type AdminKmsEnv, handleAdminKmsRequest } from "./handler";

export default {
  fetch(request: Request, env: AdminKmsEnv): Promise<Response> {
    const colo = (request as { cf?: { colo?: unknown } }).cf?.colo;
    return handleAdminKmsRequest(request, env, documents as StaticIssuerDocuments, {
      ...(typeof colo === "string" ? { colo } : {}),
    });
  },
};
