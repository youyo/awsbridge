// N10: Access のアプリの既存のトークンを失効させ（ダッシュボードの「Revoke existing tokens」と同じ考え方）、完了時刻（UTC）を出す。
// access-watch の --since に渡して、拒否されるまでの秒数を測る。
// ガード: アプリ名が awsbridge-human-poc-portal で始まり、このディレクトリの Terraform の出力 app_ids にあり、
//         API で読んだアプリの名前も一致するときだけ失効させる。
// 必要: CLOUDFLARE_API_TOKEN（Access: Apps and Policies Revoke 以上）、AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID
// API のパス（POST /accounts/{account_id}/access/apps/{app_id}/revoke_tokens）は未確認（文書の検索で確かめたのは、ダッシュボードの
// 「Revoke existing tokens」と API トークンの権限「Access: Apps and Policies Revoke」まで）。初回は結果（HTTP ステータス）を記録し、
// 失敗したらダッシュボードで代える。
// 実測（2026-11-11）: revoke_tokens は HTTP 202 を返す。2xx を成功として扱う。
// 使い方: access-revoke.ts --app awsbridge-human-poc-portal-infra
import { parseArgs } from "node:util";
import { fail, required } from "../io";
import { loadSettings, localOverride, terraformOutputJson } from "./io";
import { assertPortalName } from "./lib";

let app: string | undefined;
try {
  app = parseArgs({ options: { app: { type: "string" } } }).values.app;
} catch (e) {
  fail((e as Error).message);
}
const name = required(app, "--app");
try {
  assertPortalName(name);
} catch (e) {
  fail((e as Error).message);
}
const s = loadSettings();
const token = required(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
const account = required(
  process.env.AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID,
  "AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID",
);
if (!/^[A-Za-z0-9]+$/.test(account)) fail("AWSBRIDGE_HUMAN_POC_PORTAL_CF_ACCOUNT_ID が不正です");
const apiBase =
  localOverride("AWSBRIDGE_HUMAN_POC_PORTAL_CF_API_BASE") ?? "https://api.cloudflare.com/client/v4";

let appIds: Record<string, unknown> = {};
try {
  const out = terraformOutputJson(s);
  appIds =
    (JSON.parse(out || "{}") as { app_ids?: { value?: Record<string, unknown> } }).app_ids?.value ??
    {};
} catch {
  fail("Terraform の出力 app_ids を読めません（先に access の apply）");
}
const id = appIds[name];
if (typeof id !== "string" || !/^[A-Za-z0-9-]+$/.test(id))
  fail(
    `Terraform の出力 app_ids に ${name} がありません（${Object.keys(appIds).join(", ") || "なし"}）`,
  );

const headers = { authorization: `Bearer ${token}` };
const appUrl = `${apiBase}/accounts/${account}/access/apps/${id}`;
const got = await fetch(appUrl, { headers });
const body = (await got.json().catch(() => ({}))) as { result?: { name?: unknown } };
if (got.status !== 200 || body.result?.name !== name)
  fail(`API で読んだアプリの名前が ${name} と一致しないため失効させません（HTTP ${got.status}）`);

const res = await fetch(`${appUrl}/revoke_tokens`, { method: "POST", headers });
const done = new Date().toISOString();
if (res.status < 200 || res.status >= 300)
  fail(`revoke_tokens が失敗しました（HTTP ${res.status}）`);
console.log(`完了: ${done}（アプリ ${name} のトークンを失効させました）`);
