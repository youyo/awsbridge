import { createHandler, type Env } from "./handler";
import { createCredentialCache } from "./sts";

export type { Env } from "./handler";

// isolate 内のベストエフォートキャッシュ。isolate が変わればヒットしないだけで、動作は変わらない。
const handle = createHandler({ cache: createCredentialCache() });

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
} satisfies ExportedHandler<Env>;
