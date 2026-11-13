// G2 の片付けの確認（poc:g2:clean-check）の判定。手順書 §4.2 の表のうち、道具で読めるもの。読み取りだけ。
// aws CLI と Cloudflare の API は差し替えられる（AwsRun・CfGet）。試験は材料の応答で動かす。
// 出す名前はロール・ポリシー・スタック・Worker の名前と件数だけ（アカウント ID・ARN は出さない）。
// 道具で見ないもの（手で見る）: IAM の全体（get-account-authorization-details の前後比較）、開発ゾーンの DNS、Access のポリシー・
// サービストークン・IdP、API トークン、手元の secrets:scan。
import type { AwsRun } from "../../console/aws-cli";
import { markdownTable } from "../human/cases";

/** 呼んでよい aws のコマンド（読み取りだけ）。 */
export const CLEAN_CHECK_AWS_COMMANDS = [
  "iam list-roles",
  "iam get-role",
  "iam list-open-id-connect-providers",
  "iam list-policies",
  "cloudformation describe-stacks",
] as const;

/** 手順書 §1.3 のロール（Viewer・弱い Admin ロール・Administrator・ii-3 の対照のロールチェーン）。 */
export const DEFAULT_ROLE_NAMES = [
  "FederatedAwsBridgeViewer",
  "AwsbridgeG2AdminProbe",
  "FederatedAwsBridgeAdministrator",
  "AwsbridgeG2CtrlChain",
];
const ROLE_PATHS = ["/awsbridge-console/", "/awsbridge-g2-ctrl/", "/awsbridge-g2-probe/"];
const POLICY_PATHS = ["/awsbridge-console/", "/awsbridge-g2-ctrl/"];
/** 開発環境で作るホストの接頭辞（ポータル・issuer・試験用の issuer）。 */
const HOST_PREFIXES = [
  "awsbridge-console.",
  "awsbridge-admin-console.",
  "awsbridge-oidc-console.",
  "awsbridge-oidc-admin-console.",
  "awsbridge-g2-probe-",
];
const WORKER_PREFIXES = ["awsbridge-console-", "awsbridge-g2-"];

export type CfGet = (path: string) => Promise<{ status: number; json: unknown }>;

export interface CleanCheckDeps {
  aws: AwsRun;
  /** 無ければ Cloudflare は SKIP */
  cf?: CfGet | undefined;
}

export interface CleanCheckOptions {
  roleNames: readonly string[];
  stacks: readonly string[];
  /** ベースラインのプロバイダーの ARN（§2.1 で取った list-open-id-connect-providers）。無ければ試験の名前だけを見る */
  baselineProviders: readonly string[] | undefined;
  /** Cloudflare のアカウント ID（cf があるときに要る） */
  cfAccountId?: string | undefined;
}

export interface CheckResult {
  name: string;
  status: "OK" | "NG" | "ERR" | "SKIP";
  /** 残っているものの名前か、件数・理由 */
  detail: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown, key: string): Obj[] => {
  const l = isObj(v) ? v[key] : undefined;
  if (!Array.isArray(l)) throw new Error(`unexpected response (${key})`);
  return l.filter(isObj);
};
const names = (items: Obj[], key: string) => items.map((i) => String(i[key] ?? "?"));
const errCode = (e: unknown) => /\(([A-Za-z0-9_.]+)\)/.exec((e as Error).message)?.[1] ?? "error";

function verdict(name: string, leftovers: string[]): CheckResult {
  return leftovers.length === 0
    ? { name, status: "OK", detail: "0" }
    : { name, status: "NG", detail: leftovers.join(", ") };
}

/** プロバイダーの ARN からホストとパス（アカウント ID を含まない部分）。 */
const providerId = (arn: string) => arn.replace(/^arn:aws[a-z-]*:iam::\d{12}:oidc-provider\//, "");
const isTestHost = (host: string) => HOST_PREFIXES.some((p) => host.startsWith(p));

export async function runCleanCheck(
  d: CleanCheckDeps,
  o: CleanCheckOptions,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const guarded: AwsRun = (args) => {
    const cmd = `${args[0]} ${args[1]}`;
    if (!(CLEAN_CHECK_AWS_COMMANDS as readonly string[]).includes(cmd))
      return Promise.reject(new Error(`aws ${cmd}: not allowed (clean-check reads only)`));
    return d.aws(args);
  };
  const attempt = async (name: string, f: () => Promise<CheckResult>) => {
    try {
      out.push(await f());
    } catch (e) {
      out.push({ name, status: "ERR", detail: errCode(e) });
    }
  };

  for (const path of ROLE_PATHS) {
    const name = `iam list-roles ${path}`;
    await attempt(name, async () =>
      verdict(
        name,
        names(
          list(await guarded(["iam", "list-roles", "--path-prefix", path]), "Roles"),
          "RoleName",
        ),
      ),
    );
  }
  for (const role of o.roleNames) {
    const name = `iam get-role ${role}`;
    try {
      await guarded(["iam", "get-role", "--role-name", role]);
      out.push({ name, status: "NG", detail: "exists" });
    } catch (e) {
      const code = errCode(e);
      out.push(
        code === "NoSuchEntity"
          ? { name, status: "OK", detail: "NoSuchEntity" }
          : { name, status: "ERR", detail: code },
      );
    }
  }
  await attempt("iam oidc providers", async () => {
    const arns = names(
      list(await guarded(["iam", "list-open-id-connect-providers"]), "OpenIDConnectProviderList"),
      "Arn",
    );
    const ids = arns.map(providerId);
    const leftovers = ids.filter((id) => isTestHost(id));
    if (o.baselineProviders !== undefined) {
      const base = new Set(o.baselineProviders.map(providerId));
      for (const id of ids)
        if (!base.has(id) && !leftovers.includes(id)) leftovers.push(`${id}（ベースラインに無い）`);
      for (const id of base)
        if (!ids.includes(id)) leftovers.push(`${id}（ベースラインから消えた）`);
    }
    return verdict("iam oidc providers", leftovers);
  });
  for (const path of POLICY_PATHS) {
    const name = `iam list-policies ${path}`;
    await attempt(name, async () =>
      verdict(
        name,
        names(
          list(
            await guarded(["iam", "list-policies", "--scope", "Local", "--path-prefix", path]),
            "Policies",
          ),
          "PolicyName",
        ),
      ),
    );
  }
  for (const stack of o.stacks) {
    const name = `cloudformation ${stack}`;
    try {
      await guarded(["cloudformation", "describe-stacks", "--stack-name", stack]);
      out.push({ name, status: "NG", detail: "exists" });
    } catch (e) {
      const msg = (e as Error).message;
      out.push(
        /does not exist/.test(msg)
          ? { name, status: "OK", detail: "does not exist" }
          : { name, status: "ERR", detail: errCode(e) },
      );
    }
  }

  const cfChecks: [string, string, (r: Obj) => string | undefined][] = [
    [
      "cloudflare workers",
      "/workers/scripts",
      (r) => {
        const id = String(r.id ?? "");
        return WORKER_PREFIXES.some((p) => id.startsWith(p)) ? id : undefined;
      },
    ],
    [
      "cloudflare custom domains",
      "/workers/domains",
      (r) => {
        const h = String(r.hostname ?? "");
        return isTestHost(h) ? h : undefined;
      },
    ],
    [
      "cloudflare access apps",
      "/access/apps?per_page=1000",
      (r) => {
        const dom = String(r.domain ?? "");
        return isTestHost(dom) ? dom : undefined;
      },
    ],
  ];
  for (const [name, suffix, pick] of cfChecks) {
    if (d.cf === undefined) {
      out.push({ name, status: "SKIP", detail: "Cloudflare の読み取りのトークンが無い" });
      continue;
    }
    const cf = d.cf;
    await attempt(name, async () => {
      const r = await cf(`/accounts/${o.cfAccountId ?? ""}${suffix}`);
      if (r.status !== 200) throw new Error(`(http_${r.status})`);
      if (!isObj(r.json) || r.json.success !== true) throw new Error("(not_success)");
      // 続きのページがあれば、全部を読めていないので「残っていない」とは言わない
      const info = isObj(r.json.result_info) ? r.json.result_info : undefined;
      const page = Number(info?.page ?? 1);
      const pages = Number(info?.total_pages ?? 1);
      const total = info?.total_count;
      const items = list(r.json, "result");
      if (pages > page || (typeof total === "number" && total > items.length))
        throw new Error("(truncated)");
      return verdict(
        name,
        items.map(pick).filter((x): x is string => x !== undefined),
      );
    });
  }
  return out;
}

export function formatCleanCheck(results: readonly CheckResult[]): string {
  return markdownTable(
    ["確認", "結果", "詳細"],
    results.map((r) => [r.name, r.status, r.detail.replace(/(?<!\d)\d{12}(?!\d)/g, "<account>")]),
  );
}
