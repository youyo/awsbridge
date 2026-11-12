// PoC X1-(h) の片付けの確認: Worker awsbridge-x1h-poc が残っていないかを Cloudflare API で数える（読み取りだけ）。
// 出すのは HTTP の状態と件数だけ（アカウント ID・ホスト名は出さない）。
import { spawnSync } from "node:child_process";
import { X1H_WORKER, x1hSettings } from "./lib";

const s = x1hSettings(process.env);
const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
delete env.CLOUDFLARE_API_TOKEN;
const r = spawnSync("pnpm", ["exec", "wrangler", "auth", "token", "--json"], {
  env,
  encoding: "utf8",
});
const out = r.stdout ?? "";
const token = (JSON.parse(out.slice(out.indexOf("{"))) as { token?: string }).token ?? "";
const get = async (path: string) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {}
  return { status: res.status, json: json as { result?: unknown } | undefined };
};
const settings = await get(`/accounts/${s.accountId}/workers/scripts/${X1H_WORKER}/settings`);
const secrets = await get(`/accounts/${s.accountId}/workers/scripts/${X1H_WORKER}/secrets`);
const list = await get(`/accounts/${s.accountId}/workers/scripts`);
const scripts = ((list.json?.result as { id?: string }[] | undefined) ?? []).filter((x) =>
  (x.id ?? "").startsWith("awsbridge-x1h-poc"),
);
const result = {
  workerSettingsHttp: settings.status,
  workerSecretsHttp: secrets.status,
  workerListHttp: list.status,
  pocWorkers: scripts.length,
};
console.log(JSON.stringify(result, null, 2));
const clean =
  settings.status === 404 && secrets.status === 404 && list.status === 200 && scripts.length === 0;
console.log(
  clean
    ? "[OK] PoC X1-(h) の Worker は残っていない"
    : "[NG] PoC X1-(h) の Worker が残っている（または確認できない）",
);
process.exitCode = clean ? 0 : 1;
