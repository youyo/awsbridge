// PoC のポータル Worker（awsbridge-human-poc-portal）のエントリ。処理は handler.ts。
// 設定は deploy.ts が --var（PORTAL_BASE など）と --secrets-file（SIGNING_JWK_STD / SIGNING_JWK_ADMIN）で渡す。
import { handlePortalRequest, type PortalEnv } from "./handler";

export default {
  fetch(request: Request, env: PortalEnv): Promise<Response> {
    return handlePortalRequest(request, env, { fetch: (input, init) => fetch(input, init) });
  },
};
