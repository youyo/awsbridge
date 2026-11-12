// コンソールログインの鍵の道具が、トークンの変数が無いときに使う wrangler login の OAuth のトークン（メモリの中だけで使う）。
// Access 用などの CLOUDFLARE_API_TOKEN は外して wrangler を呼ぶ。トークンは出力しない・例外の文に入れない。
import { spawnSync } from "node:child_process";

export function wranglerOAuthToken(): string {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  delete env.CLOUDFLARE_API_TOKEN;
  const r = spawnSync("pnpm", ["exec", "wrangler", "auth", "token", "--json"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0)
    throw new Error("wrangler auth token が失敗した（pnpm exec wrangler login を確かめる）");
  let token: unknown;
  try {
    token = (JSON.parse(r.stdout) as { token?: unknown }).token;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || token === "")
    throw new Error("wrangler auth token の出力に token が無い");
  return token;
}
