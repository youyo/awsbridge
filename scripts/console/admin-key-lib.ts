// コンソールログインの Admin の署名鍵（Workers の secret_key 型）の運用の道具の本体。CLI は scripts/console/admin-key.ts。
// X1 の決裁 (c)・(e) と追加の条件 (d)・(e)・(g):
//   put     鍵（RSA 2048、RS256）を道具の中でメモリ上に作り、Cloudflare API の PUT .../workers/scripts/<script>/secrets で
//           secret_key（format jwk・RSASSA-PKCS1-v1_5/SHA-256・usages sign）として入れる。ファイルに書かない・出力しない。
//           名前は kid から決まる（ADMIN_KEY_<16 進>）。同じ名前が既にあれば PUT しない（同じ名前への PUT は即座に置き換わるため）。
//           確認のオプション（--yes）が無ければ、何をするかの表示だけ（API・トークン・鍵の生成を使わない）
//   retire  旧い鍵のバインディングを消す（DELETE）。今の署名鍵と、公開鍵の vars に残っている鍵は断る
//   check   デプロイ後の確認: 今の鍵のバインディングが secret_key か、Admin の issuer の discovery と JWKS が vars と合うか、
//           key-check（Access の検証の後ろ。取り出せない・exportKey が失敗する・自己検証が通る）
// トークン（Cloudflare API・Access）と鍵の値は出力しない。Cloudflare API の宛先の上書きは手元（127.0.0.1）の試験用だけ。

import { adminIssuerOf } from "../../src/console/admin/issuer";
import {
  bindingNameForKid,
  type CurrentKey,
  jwkThumbprint,
  MAX_PUBLIC_KEYS,
  type PublicJwk,
  parseCurrentKey,
  parsePublicJwks,
} from "../../src/console/admin/key";
import { readWorkerConfig } from "../../src/console/portal/worker-config";
import type { WorkerConfig } from "../../src/console/types";
import {
  ACCOUNT_RE,
  apiBaseFromVar,
  cfApi as cfApiCommon,
  cfErrors,
  forgetPrivate,
  generateRsa,
  getJson,
  isObj,
  jwksKids,
  keyCheckUrl,
  PRIVATE_MEMBERS,
  putSucceeded,
  readJsonc,
  SCRIPT_RE,
  secretKeyBody,
  secretNames,
  type ToolDeps,
} from "./key-tool-common";

export { CF_API_BASE, readJsonc } from "./key-tool-common";

const BINDING_RE = /^ADMIN_KEY_[0-9A-F]{16}$/;

export type Settings = {
  wranglerConfigPath: string;
  scriptName: string;
  accountId: string;
  apiBase: string;
  current?: CurrentKey | undefined;
  publicJwks?: PublicJwk[] | undefined;
  /** 生成物（worker.admin.json）。check で Admin の issuer とポータルを知るのに使う。無ければ undefined。 */
  adminConfig?: WorkerConfig | undefined;
};

export type Deps = ToolDeps;

/** Cloudflare API の宛先。上書きは手元（http://127.0.0.1:<port>）の試験用だけ（トークンを外へ送らない）。 */
export function apiBaseFrom(env: Record<string, string | undefined>): string {
  return apiBaseFromVar(env, "AWSBRIDGE_CONSOLE_ADMIN_CF_API_BASE");
}

/**
 * 設定を読む。wrangler の設定（既定 wrangler.console-admin.jsonc。AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG）の name・account_id・vars、
 * アカウント ID（AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID か account_id）、生成物（AWSBRIDGE_CONSOLE_OUT_DIR/worker.admin.json。任意）。
 */
export async function adminKeySettings(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): Promise<Settings> {
  const wranglerConfigPath =
    env.AWSBRIDGE_CONSOLE_ADMIN_WRANGLER_CONFIG || "wrangler.console-admin.jsonc";
  const cfg = readJsonc(readFile(wranglerConfigPath));
  const scriptName = cfg.name;
  if (typeof scriptName !== "string" || !SCRIPT_RE.test(scriptName))
    throw new Error(`${wranglerConfigPath} の name が Worker の名前の形でない`);
  const accountId =
    env.AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID ||
    (typeof cfg.account_id === "string" ? cfg.account_id : undefined);
  if (accountId === undefined)
    throw new Error(
      "AWSBRIDGE_CONSOLE_ADMIN_CF_ACCOUNT_ID（Cloudflare のアカウント ID）を mise.local.toml などに設定してください",
    );
  if (!ACCOUNT_RE.test(accountId)) throw new Error("Cloudflare のアカウント ID は 32 桁の 16 進");
  const vars = (typeof cfg.vars === "object" && cfg.vars !== null ? cfg.vars : {}) as Record<
    string,
    unknown
  >;
  let current: CurrentKey | undefined;
  let publicJwks: PublicJwk[] | undefined;
  try {
    current = parseCurrentKey(vars.ADMIN_CURRENT_KEY);
    publicJwks = await parsePublicJwks(vars.ADMIN_PUBLIC_JWKS);
  } catch (e) {
    throw new Error(`${wranglerConfigPath} の vars: ${(e as Error).message}`);
  }
  if (current && !publicJwks?.some((k) => k.kid === current?.kid))
    throw new Error(
      `${wranglerConfigPath} の vars: ADMIN_CURRENT_KEY の kid が ADMIN_PUBLIC_JWKS に無い`,
    );
  let adminConfig: WorkerConfig | undefined;
  const outDir = env.AWSBRIDGE_CONSOLE_OUT_DIR || ".generated/console";
  try {
    adminConfig = readWorkerConfig(JSON.parse(readFile(`${outDir}/worker.admin.json`)), "admin");
  } catch {
    adminConfig = undefined;
  }
  return {
    wranglerConfigPath,
    scriptName,
    accountId,
    apiBase: apiBaseFrom(env),
    current,
    publicJwks,
    adminConfig,
  };
}

const secretsUrl = (s: Settings, name?: string) =>
  `${s.apiBase}/accounts/${s.accountId}/workers/scripts/${s.scriptName}/secrets${
    name === undefined ? "" : `/${name}`
  }`;

const cfApi = (_s: Settings, d: Deps, token: string, method: string, url: string, body?: unknown) =>
  cfApiCommon(d, token, method, url, body);

const NEXT_STEPS = [
  "次の手順（README の「コンソールログインの Admin の署名鍵」）:",
  "  1. wrangler の設定の vars ADMIN_PUBLIC_JWKS を上の値にしてデプロイする（JWKS に新旧を並べる）。",
  "     差し替えなら、STS の JWKS のキャッシュが切れるまで最低 1 時間（安全側に 24 時間）待つ",
  "  2. vars ADMIN_CURRENT_KEY を上の値にしてデプロイする（署名を新しい鍵に切り替える）。mise run console:admin-key:check",
  "  3. JWT の有効期限（5 分）より長く待ってから、旧い公開鍵を ADMIN_PUBLIC_JWKS から外してデプロイし、",
  "     mise run console:admin-key:retire -- --binding <旧い名前> --yes で旧い鍵を消す",
];

export async function runPut(s: Settings, d: Deps, o: { yes: boolean }): Promise<number> {
  const target = `Worker ${s.scriptName}（${s.wranglerConfigPath}）`;
  if (!o.yes) {
    d.print("put（表示だけ。--yes を付けると実行する）:");
    d.print(`  1. RSA 2048 の鍵をこの道具のメモリの中で作る（ファイルに書かない）`);
    d.print(
      `  2. 名前を kid から決める: ADMIN_KEY_<kid の先頭 8 バイトの 16 進>。同じ名前が既にあれば止める`,
    );
    d.print(
      `  3. Cloudflare API で ${target} に secret_key（format jwk・RSASSA-PKCS1-v1_5/SHA-256・usages sign）として入れる`,
    );
    d.print("  4. 名前・kid・公開鍵と、次に入れる vars を表示する（秘密の成分は表示しない）");
    d.print(
      "トークン: AWSBRIDGE_CONSOLE_ADMIN_CF_API_TOKEN（Admin の Worker だけを書けるトークン。Standard と分ける）か wrangler の OAuth",
    );
    return 0;
  }
  if ((s.publicJwks?.length ?? 0) >= MAX_PUBLIC_KEYS) {
    d.print(
      `[NG] ADMIN_PUBLIC_JWKS に既に ${MAX_PUBLIC_KEYS} つの公開鍵がある。旧い鍵を外してデプロイしてから入れる`,
    );
    return 1;
  }
  const token = await d.token();
  let jwk: JsonWebKey | undefined;
  let body: ReturnType<typeof secretKeyBody> | undefined;
  try {
    const pair = await (d.generateKeyPair ?? generateRsa)();
    jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const n = jwk.n as string;
    const kid = await jwkThumbprint({ n, e: jwk.e as string });
    const name = bindingNameForKid(kid);
    const publicJwk: PublicJwk = { kty: "RSA", n, e: "AQAB", kid, alg: "RS256", use: "sig" };
    const secrets = PRIVATE_MEMBERS.map(
      (m) => (jwk as unknown as Record<string, string>)[m] as string,
    );
    const leaks = (v: unknown) => {
      const text = JSON.stringify(v ?? "");
      return secrets.some((x) => text.includes(x));
    };

    // 同じ名前が無いことを secret の一覧で確かめる（読めなければ入れない）
    const list = await cfApi(s, d, token, "GET", secretsUrl(s));
    const names = secretNames(list);
    if (!names) {
      d.print(
        `[NG] secret の一覧を読めず、名前の有無を確かめられない（HTTP ${list.status}）。何もしていない`,
      );
      return 1;
    }
    if (names.includes(name)) {
      d.print(`[NG] ${name} は既にある。同じ名前には入れない（入れると今の鍵が即座に置き換わる）`);
      return 1;
    }

    body = secretKeyBody(name, jwk);
    const put = await cfApi(s, d, token, "PUT", secretsUrl(s), body);
    if (!putSucceeded(put, name)) {
      if (leaks(put.json))
        d.print(`[NG] PUT の応答に想定外の項目がある（HTTP ${put.status}。本文は出さない）`);
      else d.print(`[NG] PUT が失敗した（HTTP ${put.status}）: ${cfErrors(put.json)}`);
      return 1;
    }
    const jwks = [...(s.publicJwks ?? []), publicJwk];
    d.print(
      `[OK] ${target} に secret_key ${name} を入れた（kid ${kid}）。手元に鍵の写しは残らない`,
    );
    d.print("公開鍵:");
    d.print(`  ${JSON.stringify(publicJwk)}`);
    d.print("vars ADMIN_PUBLIC_JWKS（新旧を並べる）:");
    d.print(`  ${JSON.stringify(jwks)}`);
    d.print("vars ADMIN_CURRENT_KEY（署名を切り替えるとき）:");
    d.print(`  ${JSON.stringify({ binding: name, kid })}`);
    for (const l of NEXT_STEPS) d.print(l);
    return 0;
  } finally {
    // 秘密の成分の参照を外す（手元の写しを残さない）
    forgetPrivate(jwk, body);
    jwk = undefined;
  }
}

export async function runRetire(
  s: Settings,
  d: Deps,
  o: { yes: boolean; binding: string },
): Promise<number> {
  const name = o.binding;
  if (!BINDING_RE.test(name)) {
    d.print("[NG] --binding は ADMIN_KEY_<16 進 16 桁> の名前");
    return 1;
  }
  if (s.current?.binding === name) {
    d.print(`[NG] ${name} は今の署名鍵（ADMIN_CURRENT_KEY）。先に別の鍵へ切り替えてデプロイする`);
    return 1;
  }
  if (s.publicJwks?.some((k) => bindingNameForKid(k.kid) === name)) {
    d.print(
      `[NG] ${name} の公開鍵が ADMIN_PUBLIC_JWKS に残っている。先に JWKS から外してデプロイする（kid を外すのが停止）`,
    );
    return 1;
  }
  if (!o.yes) {
    d.print(
      `retire（表示だけ。--yes を付けると実行する）: Worker ${s.scriptName} の ${name} を消す`,
    );
    return 0;
  }
  // デプロイ済みの Admin の issuer の JWKS（公開の URL）に、消す鍵の kid が残っていないこと（取れなければ消さない）
  const issuer = s.adminConfig ? adminIssuerOf(s.adminConfig) : undefined;
  if (!issuer) {
    d.print(
      "[NG] 生成物（worker.admin.json）が無いか Admin の issuer が無い。デプロイ済みの JWKS を確かめられないので消さない（mise run console:config:generate）",
    );
    return 1;
  }
  const served = await getJson(d, `${issuer}/.well-known/jwks.json`);
  const servedKids = jwksKids(served);
  if (!servedKids) {
    d.print(
      `[NG] デプロイ済みの JWKS（${issuer}/.well-known/jwks.json）を取れない（HTTP ${served.status}）。消さない`,
    );
    return 1;
  }
  if (servedKids.some((k: unknown) => typeof k === "string" && safeBindingName(k) === name)) {
    d.print(
      `[NG] ${name} の kid がデプロイ済みの JWKS にまだある。JWKS から外してデプロイしてから消す`,
    );
    return 1;
  }
  const token = await d.token();
  const r = await cfApi(s, d, token, "DELETE", secretsUrl(s, name));
  if (r.status < 200 || r.status >= 300 || !isObj(r.json) || r.json.success !== true) {
    d.print(`[NG] DELETE が失敗した（HTTP ${r.status}）: ${cfErrors(r.json)}`);
    return 1;
  }
  d.print(`[OK] Worker ${s.scriptName} の ${name} を消した`);
  return 0;
}

/** kid からバインディングの名前を作る（形の違う kid は undefined）。 */
function safeBindingName(kid: string): string | undefined {
  try {
    return bindingNameForKid(kid);
  } catch {
    return undefined;
  }
}

export async function runCheck(
  s: Settings,
  d: Deps,
  o: { accessToken?: string | undefined; team?: string | undefined },
): Promise<number> {
  let ng = 0;
  const ok = (m: string) => d.print(`[OK] ${m}`);
  const bad = (m: string) => {
    ng++;
    d.print(`[NG] ${m}`);
  };
  const current = s.current;
  if (!current) {
    bad(`${s.wranglerConfigPath} の vars ADMIN_CURRENT_KEY が空（署名鍵が無い）`);
    return 1;
  }
  const kids = (s.publicJwks ?? []).map((k) => k.kid);

  // 1. バインディング（Cloudflare API）
  const token = await d.token();
  const list = await cfApi(s, d, token, "GET", secretsUrl(s));
  const items = isObj(list.json) && Array.isArray(list.json.result) ? list.json.result : undefined;
  if (!items) bad(`secret の一覧を読めない（HTTP ${list.status}）: ${cfErrors(list.json)}`);
  else {
    const found = items.find((x) => isObj(x) && x.name === current.binding) as
      | Record<string, unknown>
      | undefined;
    if (!found) bad(`今の署名鍵 ${current.binding} のバインディングが無い`);
    else if (found.type !== "secret_key")
      bad(`${current.binding} の型が secret_key でない（${String(found.type)}）`);
    else ok(`${current.binding} は secret_key`);
    const inJwks = new Set(kids.map((k) => bindingNameForKid(k)));
    for (const x of items) {
      if (isObj(x) && typeof x.name === "string" && BINDING_RE.test(x.name) && !inJwks.has(x.name))
        d.print(`[--] ${x.name} は JWKS に無い旧い鍵。不要なら console:admin-key:retire で消す`);
    }
  }

  // 2. Admin の issuer の discovery と JWKS（公開。トークンを送らない）
  const config = s.adminConfig;
  const issuer = config ? adminIssuerOf(config) : undefined;
  if (!config || !issuer) {
    bad(
      "生成物（worker.admin.json）が無いか Admin の issuer が無い。mise run console:config:generate",
    );
    return 1;
  }
  const disc = await getJson(d, `${issuer}/.well-known/openid-configuration`);
  if (
    disc.status === 200 &&
    isObj(disc.json) &&
    disc.json.issuer === issuer &&
    disc.json.jwks_uri === `${issuer}/.well-known/jwks.json`
  )
    ok(`discovery（${issuer}）`);
  else bad(`discovery が Admin の issuer と合わない（HTTP ${disc.status}）`);
  const jwks = await getJson(d, `${issuer}/.well-known/jwks.json`);
  const served =
    isObj(jwks.json) && Array.isArray(jwks.json.keys)
      ? jwks.json.keys.map((k: unknown) => (isObj(k) ? k.kid : undefined))
      : undefined;
  if (jwks.status === 200 && served && JSON.stringify(served) === JSON.stringify(kids))
    ok(`JWKS の kid が vars と同じ（${kids.length} つ）`);
  else
    bad(
      `JWKS の kid が vars ADMIN_PUBLIC_JWKS と違う（HTTP ${jwks.status}。デプロイ済みか確かめる）`,
    );

  // 3. key-check（Access の検証の後ろ。Access のトークンは cf-access-token で送る）
  const team =
    o.team ?? config.teams.find((t) => t.aud !== undefined)?.name ?? config.teams[0]?.name;
  if (!team) {
    bad("生成物に Admin のチームが無い");
    return 1;
  }
  const url = keyCheckUrl(config, team);
  if (!o.accessToken) {
    d.print(
      `[--] key-check は飛ばした。ブラウザ（Admin のチームの Access）で ${url} を開き、extractable false・exportKey rejected・selfVerify ok を確かめる`,
    );
    d.print(
      "     （または AWSBRIDGE_CONSOLE_ADMIN_ACCESS_TOKEN に cloudflared access token の値を入れて実行する）",
    );
  } else {
    const kc = await getJson(d, url, { "cf-access-token": o.accessToken });
    const v = isObj(kc.json) ? kc.json : {};
    if (kc.status !== 200) bad(`key-check が HTTP ${kc.status}`);
    else if (v.configured !== true) bad("key-check: 署名鍵が設定されていない（configured false）");
    else {
      const checks: [boolean, string][] = [
        [v.kid === current.kid, `kid が今の鍵（vars）と同じ`],
        [v.extractable === false, "extractable false（取り出せない）"],
        [v.exportKey === "rejected", "Worker の中の exportKey が失敗する"],
        [v.usable === true, "CryptoKey・usages sign だけ・RS256"],
        [v.selfVerify === "ok", "vars の公開鍵で自己検証が通る"],
      ];
      for (const [pass, m] of checks) (pass ? ok : bad)(`key-check: ${m}`);
    }
  }
  return ng === 0 ? 0 : 1;
}
