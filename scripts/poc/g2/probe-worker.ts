// G2 の試験用の issuer の Worker（awsbridge-g2-probe-<label>）のエントリ。discovery と JWKS を静的に返すだけ。
// 文書は probe.ts deploy が手元で作り、wrangler の alias でこのモジュール名に差し込む（デプロイ用の設定は issuer ごとに作る）。
import documents from "awsbridge-g2-probe-documents";
import { handleProbeRequest, type ProbeDocuments } from "./probe-handler";

export default {
  fetch(request: Request): Response {
    return handleProbeRequest(request, documents as ProbeDocuments);
  },
};
