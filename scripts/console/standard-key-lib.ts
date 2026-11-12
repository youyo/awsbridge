// コンソールログインの Standard の署名鍵（Workers の secret_key 型。境界ごと）の運用の道具の本体。CLI は scripts/console/standard-key.ts。
// cto の決裁「Standard も secret_key に揃える」の (d)・(e)・(g)。Admin の道具（admin-key-lib.ts）と同じ形で、境界ごとに鍵を持つ:
//   put     --boundary の鍵（RSA 2048、RS256）を道具の中でメモリ上に作り、Cloudflare API の PUT .../workers/scripts/<script>/secrets で
//           secret_key（format jwk・RSASSA-PKCS1-v1_5/SHA-256・usages sign）として入れる。ファイルに書かない・出力しない。
//           名前は kid から決まる（STANDARD_KEY_<16 進>）。同じ名前が既にあれば PUT しない（同じ名前への PUT は即座に置き換わるため）。
//           確認のオプション（--yes）が無ければ、何をするかの表示だけ（API・トークン・鍵の生成を使わない）
//   retire  旧い鍵のバインディングを消す（DELETE）。どれかの境界の今の鍵・公開鍵の vars・デプロイ済みの JWKS に残っている鍵は断る。
//           STANDARD_KEY_<16 進> の形以外（CSRF の鍵・Admin の鍵など）は断る
//   check   デプロイ後の確認: 境界ごとに今の鍵のバインディングが secret_key か、境界の issuer の discovery と JWKS が vars と合うか、
//           key-check（Access の検証の後ろ。取り出せない・exportKey が失敗する・自己検証が通る）
// トークンは Standard 用の変数（AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN）だけを読み、Admin 用のトークンは読まない（決裁 (e): トークンを分ける）。
// トークン（Cloudflare API・Access）と鍵の値は出力しない。

import { readWorkerConfig } from "../../src/console/portal/worker-config";
import { jwkThumbprint, MAX_PUBLIC_KEYS, type PublicJwk } from "../../src/console/signing/key";
import {
  parseStandardKeys,
  STANDARD_KEY_BINDING_PREFIX,
  type StandardKeys,
  standardBindingName,
} from "../../src/console/standard/key";
import type { WorkerConfig } from "../../src/console/types";
import {
  ACCOUNT_RE,
  apiBaseFromVar,
  cfApi,
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

const BINDING_RE = new RegExp(`^${STANDARD_KEY_BINDING_PREFIX}[0-9A-F]{16}$`);
const TOKEN_VAR = "AWSBRIDGE_CONSOLE_STANDARD_CF_API_TOKEN";

export type Settings = {
  wranglerConfigPath: string;
  scriptName: string;
  accountId: string;
  apiBase: string;
  /** vars の鍵（両方とも空なら undefined）。 */
  keys?: StandardKeys | undefined;
  /** 生成物（worker.standard.json）。境界と issuer・ポータルを知るのに使う。無ければ undefined。 */
  stdConfig?: WorkerConfig | undefined;
};

export type Deps = ToolDeps;

/** Cloudflare API の宛先。上書きは手元（http://127.0.0.1:<port>）の試験用だけ。 */
export function standardApiBaseFrom(env: Record<string, string | undefined>): string {
  return apiBaseFromVar(env, "AWSBRIDGE_CONSOLE_STANDARD_CF_API_BASE");
}

/** Standard 用のトークン（無ければ undefined。呼び出し側が wrangler の OAuth に落とす）。Admin 用・ほかの変数は読まない。 */
export function standardToken(env: Record<string, string | undefined>): string | undefined {
  return env[TOKEN_VAR] || undefined;
}

const blank = (v: unknown) => v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * 設定を読む。wrangler の設定（既定 wrangler.console-standard.jsonc。AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG）の name・account_id・vars、
 * アカウント ID（AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID か account_id）、生成物（AWSBRIDGE_CONSOLE_OUT_DIR/worker.standard.json。任意）。
 */
export async function standardKeySettings(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): Promise<Settings> {
  const wranglerConfigPath =
    env.AWSBRIDGE_CONSOLE_STANDARD_WRANGLER_CONFIG || "wrangler.console-standard.jsonc";
  const cfg = readJsonc(readFile(wranglerConfigPath));
  const scriptName = cfg.name;
  if (typeof scriptName !== "string" || !SCRIPT_RE.test(scriptName))
    throw new Error(`${wranglerConfigPath} の name が Worker の名前の形でない`);
  const accountId =
    env.AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID ||
    (typeof cfg.account_id === "string" ? cfg.account_id : undefined);
  if (accountId === undefined)
    throw new Error(
      "AWSBRIDGE_CONSOLE_STANDARD_CF_ACCOUNT_ID（Cloudflare のアカウント ID）を mise.local.toml などに設定してください",
    );
  if (!ACCOUNT_RE.test(accountId)) throw new Error("Cloudflare のアカウント ID は 32 桁の 16 進");
  const vars = isObj(cfg.vars) ? cfg.vars : {};
  let keys: StandardKeys | undefined;
  if (!(blank(vars.STANDARD_CURRENT_KEYS) && blank(vars.STANDARD_PUBLIC_JWKS))) {
    try {
      keys = await parseStandardKeys(vars.STANDARD_CURRENT_KEYS, vars.STANDARD_PUBLIC_JWKS);
    } catch (e) {
      throw new Error(`${wranglerConfigPath} の vars: ${(e as Error).message}`);
    }
  }
  let stdConfig: WorkerConfig | undefined;
  const outDir = env.AWSBRIDGE_CONSOLE_OUT_DIR || ".generated/console";
  try {
    stdConfig = readWorkerConfig(
      JSON.parse(readFile(`${outDir}/worker.standard.json`)),
      "standard",
    );
  } catch {
    stdConfig = undefined;
  }
  return {
    wranglerConfigPath,
    scriptName,
    accountId,
    apiBase: standardApiBaseFrom(env),
    keys,
    stdConfig,
  };
}

const secretsUrl = (s: Settings, name?: string) =>
  `${s.apiBase}/accounts/${s.accountId}/workers/scripts/${s.scriptName}/secrets${
    name === undefined ? "" : `/${name}`
  }`;

const NEXT_STEPS = [
  "次の手順（README の「コンソールログインの Standard の署名鍵」）:",
  "  1. wrangler の設定の vars STANDARD_PUBLIC_JWKS を上の値にしてデプロイする（その境界の JWKS に新旧を並べる）。",
  "     差し替えなら、STS の JWKS のキャッシュが切れるまで最低 1 時間（安全側に 24 時間）待つ",
  "  2. vars STANDARD_CURRENT_KEYS を上の値にしてデプロイする（その境界の署名を新しい鍵に切り替える）。mise run console:standard-key:check",
  "  3. JWT の有効期限（5 分）より長く待ってから、旧い公開鍵を STANDARD_PUBLIC_JWKS から外してデプロイし、",
  "     mise run console:standard-key:retire -- --binding <旧い名前> --yes で旧い鍵を消す",
];

export async function runPut(
  s: Settings,
  d: Deps,
  o: { yes: boolean; boundary: string },
): Promise<number> {
  const target = `Worker ${s.scriptName}（${s.wranglerConfigPath}）`;
  const boundary = o.boundary;
  if (!o.yes) {
    d.print(`put（表示だけ。--yes を付けると実行する）: 境界 ${boundary} の署名鍵`);
    d.print("  1. RSA 2048 の鍵をこの道具のメモリの中で作る（ファイルに書かない）");
    d.print(
      "  2. 名前を kid から決める: STANDARD_KEY_<kid の先頭 8 バイトの 16 進>。同じ名前が既にあれば止める",
    );
    d.print(
      `  3. Cloudflare API で ${target} に secret_key（format jwk・RSASSA-PKCS1-v1_5/SHA-256・usages sign）として入れる`,
    );
    d.print(
      "  4. 名前・kid・公開鍵と、次に入れる vars（その境界だけを入れ替えたもの）を表示する（秘密の成分は表示しない）",
    );
    d.print(
      `トークン: ${TOKEN_VAR}（Standard の Worker だけを書けるトークン。Admin と分ける）か wrangler の OAuth`,
    );
    return 0;
  }
  if (!s.stdConfig) {
    d.print(
      "[NG] 生成物（worker.standard.json）が無く、境界の名前を確かめられない。何もしていない（mise run console:config:generate）",
    );
    return 1;
  }
  if (!s.stdConfig.boundaries.some((b) => b.name === boundary)) {
    d.print(`[NG] 境界 ${boundary} は生成物（worker.standard.json）に無い。何もしていない`);
    return 1;
  }
  const existing = s.keys?.publicJwks[boundary] ?? [];
  if (existing.length >= MAX_PUBLIC_KEYS) {
    d.print(
      `[NG] STANDARD_PUBLIC_JWKS の境界 ${boundary} に既に ${MAX_PUBLIC_KEYS} つの公開鍵がある。旧い鍵を外してデプロイしてから入れる`,
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
    const name = standardBindingName(kid);
    const publicJwk: PublicJwk = { kty: "RSA", n, e: "AQAB", kid, alg: "RS256", use: "sig" };
    const secrets = PRIVATE_MEMBERS.map(
      (m) => (jwk as unknown as Record<string, string>)[m] as string,
    );
    const leaks = (v: unknown) => {
      const text = JSON.stringify(v ?? "");
      return secrets.some((x) => text.includes(x));
    };

    // 同じ名前が無いことを secret の一覧で確かめる（読めなければ入れない）
    const list = await cfApi(d, token, "GET", secretsUrl(s));
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
    const put = await cfApi(d, token, "PUT", secretsUrl(s), body);
    if (!putSucceeded(put, name)) {
      if (leaks(put.json))
        d.print(`[NG] PUT の応答に想定外の項目がある（HTTP ${put.status}。本文は出さない）`);
      else d.print(`[NG] PUT が失敗した（HTTP ${put.status}）: ${cfErrors(put.json)}`);
      return 1;
    }
    const publicVars = { ...(s.keys?.publicJwks ?? {}), [boundary]: [...existing, publicJwk] };
    const currentVars = { ...(s.keys?.current ?? {}), [boundary]: { binding: name, kid } };
    d.print(
      `[OK] ${target} に境界 ${boundary} の secret_key ${name} を入れた（kid ${kid}）。手元に鍵の写しは残らない`,
    );
    d.print("公開鍵:");
    d.print(`  ${JSON.stringify(publicJwk)}`);
    d.print("vars STANDARD_PUBLIC_JWKS（この境界に新旧を並べる。ほかの境界はそのまま）:");
    d.print(`  ${JSON.stringify(publicVars)}`);
    d.print("vars STANDARD_CURRENT_KEYS（この境界の署名を切り替えるとき）:");
    d.print(`  ${JSON.stringify(currentVars)}`);
    for (const l of NEXT_STEPS) d.print(l);
    return 0;
  } finally {
    // 秘密の成分の参照を外す（手元の写しを残さない）
    forgetPrivate(jwk, body);
    jwk = undefined;
  }
}

/** kid からバインディングの名前を作る（形の違う kid は undefined）。 */
function safeBindingName(kid: unknown): string | undefined {
  try {
    return typeof kid === "string" ? standardBindingName(kid) : undefined;
  } catch {
    return undefined;
  }
}

export async function runRetire(
  s: Settings,
  d: Deps,
  o: { yes: boolean; binding: string },
): Promise<number> {
  const name = o.binding;
  if (!BINDING_RE.test(name)) {
    d.print(
      "[NG] --binding は STANDARD_KEY_<16 進 16 桁> の名前（CSRF の鍵・Admin の鍵は消さない）",
    );
    return 1;
  }
  const current = Object.entries(s.keys?.current ?? {}).find(([, c]) => c.binding === name);
  if (current) {
    d.print(
      `[NG] ${name} は境界 ${current[0]} の今の署名鍵（STANDARD_CURRENT_KEYS）。先に別の鍵へ切り替えてデプロイする`,
    );
    return 1;
  }
  const listed = Object.entries(s.keys?.publicJwks ?? {}).find(([, ks]) =>
    ks.some((k) => safeBindingName(k.kid) === name),
  );
  if (listed) {
    d.print(
      `[NG] ${name} の公開鍵が STANDARD_PUBLIC_JWKS の境界 ${listed[0]} に残っている。先に JWKS から外してデプロイする（kid を外すのが停止）`,
    );
    return 1;
  }
  if (!o.yes) {
    d.print(
      `retire（表示だけ。--yes を付けると実行する）: Worker ${s.scriptName} の ${name} を消す`,
    );
    return 0;
  }
  // デプロイ済みのどの境界の issuer の JWKS（公開の URL）にも、消す鍵の kid が残っていないこと（取れなければ消さない）
  if (!s.stdConfig || s.stdConfig.boundaries.length === 0) {
    d.print(
      "[NG] 生成物（worker.standard.json）が無い。デプロイ済みの JWKS を確かめられないので消さない（mise run console:config:generate）",
    );
    return 1;
  }
  for (const b of s.stdConfig.boundaries) {
    const url = `${b.issuer}/.well-known/jwks.json`;
    const kids = jwksKids(await getJson(d, url));
    if (!kids) {
      d.print(`[NG] デプロイ済みの JWKS（${url}）を取れない。消さない`);
      return 1;
    }
    if (kids.some((k) => safeBindingName(k) === name)) {
      d.print(
        `[NG] ${name} の kid が境界 ${b.name} のデプロイ済みの JWKS にまだある。JWKS から外してデプロイしてから消す`,
      );
      return 1;
    }
  }
  const token = await d.token();
  const r = await cfApi(d, token, "DELETE", secretsUrl(s, name));
  if (r.status < 200 || r.status >= 300 || !isObj(r.json) || r.json.success !== true) {
    d.print(`[NG] DELETE が失敗した（HTTP ${r.status}）: ${cfErrors(r.json)}`);
    return 1;
  }
  d.print(`[OK] Worker ${s.scriptName} の ${name} を消した`);
  return 0;
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
  const keys = s.keys;
  if (!keys) {
    bad(
      `${s.wranglerConfigPath} の vars STANDARD_CURRENT_KEYS・STANDARD_PUBLIC_JWKS が空（署名鍵が無い）`,
    );
    return 1;
  }
  const config = s.stdConfig;
  if (!config) {
    bad("生成物（worker.standard.json）が無い。mise run console:config:generate");
    return 1;
  }

  // 1. バインディング（Cloudflare API）
  const token = await d.token();
  const list = await cfApi(d, token, "GET", secretsUrl(s));
  const items = isObj(list.json) && Array.isArray(list.json.result) ? list.json.result : undefined;
  if (!items) bad(`secret の一覧を読めない（HTTP ${list.status}）: ${cfErrors(list.json)}`);
  else {
    for (const b of config.boundaries) {
      const current = keys.current[b.name];
      if (!current) {
        bad(`境界 ${b.name} の今の署名鍵が STANDARD_CURRENT_KEYS に無い`);
        continue;
      }
      const found = items.find((x) => isObj(x) && x.name === current.binding) as
        | Record<string, unknown>
        | undefined;
      if (!found) bad(`境界 ${b.name} の今の署名鍵 ${current.binding} のバインディングが無い`);
      else if (found.type !== "secret_key")
        bad(`${current.binding} の型が secret_key でない（${String(found.type)}）`);
      else ok(`境界 ${b.name}: ${current.binding} は secret_key`);
    }
    const inJwks = new Set(
      Object.values(keys.publicJwks).flatMap((ks) => ks.map((k) => standardBindingName(k.kid))),
    );
    for (const x of items) {
      if (isObj(x) && typeof x.name === "string" && BINDING_RE.test(x.name) && !inJwks.has(x.name))
        d.print(
          `[--] ${x.name} はどの境界の JWKS にも無い旧い鍵。不要なら console:standard-key:retire で消す`,
        );
    }
  }

  // 2. 境界ごとの issuer の discovery と JWKS（公開。トークンを送らない）
  for (const b of config.boundaries) {
    const issuer = b.issuer;
    const disc = await getJson(d, `${issuer}/.well-known/openid-configuration`);
    if (
      disc.status === 200 &&
      isObj(disc.json) &&
      disc.json.issuer === issuer &&
      disc.json.jwks_uri === `${issuer}/.well-known/jwks.json`
    )
      ok(`境界 ${b.name}: discovery（${issuer}）`);
    else bad(`境界 ${b.name}: discovery が issuer と合わない（HTTP ${disc.status}）`);
    const kids = (keys.publicJwks[b.name] ?? []).map((k) => k.kid);
    const jwks = await getJson(d, `${issuer}/.well-known/jwks.json`);
    const served = jwksKids(jwks);
    if (served && JSON.stringify(served) === JSON.stringify(kids))
      ok(`境界 ${b.name}: JWKS の kid が vars と同じ（${kids.length} つ）`);
    else
      bad(
        `境界 ${b.name}: JWKS の kid が vars STANDARD_PUBLIC_JWKS と違う（HTTP ${jwks.status}。デプロイ済みか確かめる）`,
      );
  }

  // 3. key-check（Access の検証の後ろ。Access のトークンは cf-access-token で送る）
  const team =
    o.team ?? config.teams.find((t) => t.aud !== undefined)?.name ?? config.teams[0]?.name;
  if (!team) {
    bad("生成物に Standard のチームが無い");
    return 1;
  }
  const url = keyCheckUrl(config, team);
  if (!o.accessToken) {
    d.print(
      `[--] key-check は飛ばした。ブラウザ（Standard のチームの Access）で ${url} を開き、境界ごとに extractable false・exportKey rejected・selfVerify ok を確かめる`,
    );
    d.print(
      "     （または AWSBRIDGE_CONSOLE_STANDARD_ACCESS_TOKEN に cloudflared access token の値を入れて実行する）",
    );
  } else {
    const kc = await getJson(d, url, { "cf-access-token": o.accessToken });
    const all = isObj(kc.json) && isObj(kc.json.boundaries) ? kc.json.boundaries : undefined;
    if (kc.status !== 200 || !all) bad(`key-check が HTTP ${kc.status}`);
    else
      for (const b of config.boundaries) {
        const v = isObj(all[b.name]) ? (all[b.name] as Record<string, unknown>) : {};
        const current = keys.current[b.name];
        if (v.configured !== true || !current) {
          bad(`key-check: 境界 ${b.name} の署名鍵が設定されていない（configured false）`);
          continue;
        }
        const checks: [boolean, string][] = [
          [v.kid === current.kid, "kid が今の鍵（vars）と同じ"],
          [v.extractable === false, "extractable false（取り出せない）"],
          [v.exportKey === "rejected", "Worker の中の exportKey が失敗する"],
          [v.usable === true, "CryptoKey・usages sign だけ・RS256"],
          [v.selfVerify === "ok", "vars の公開鍵で自己検証が通る"],
        ];
        for (const [pass, m] of checks) (pass ? ok : bad)(`key-check: 境界 ${b.name}: ${m}`);
      }
  }
  return ng === 0 ? 0 : 1;
}
