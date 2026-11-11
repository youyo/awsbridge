// PoC のポータルの手順（scripts/poc/human/portal/*.ts）の設定。AWSBRIDGE_HUMAN_POC_PORTAL_* だけを読む
// （MCP 用の AWSBRIDGE_* も、既存の PoC の AWSBRIDGE_HUMAN_POC_* も読まない。AWS_PROFILE / AWS_REGION は共通）。
// 既定値はここで補う（mise.toml の [env] には置かない）。
import { join } from "node:path";
import { assertCustomHost } from "./bypass-lib";
import { assertPortalName, normalizePortalBase, PORTAL_DEFAULTS } from "./lib";

/** ポータルの土台の URL を決める変数（エラーの案内に使う）。 */
export const BASE_VARS = "AWSBRIDGE_HUMAN_POC_PORTAL_HOST（または AWSBRIDGE_HUMAN_POC_PORTAL_URL）";

export interface PortalSettings {
  /**
   * ポータルの土台の URL。https://<AWSBRIDGE_HUMAN_POC_PORTAL_HOST>（自社ドメインの Custom Domain）。
   * HOST が無ければ AWSBRIDGE_HUMAN_POC_PORTAL_URL（以前の workers.dev の形。deploy は受け付けない）
   */
  base: string | undefined;
  /** https://<team>.cloudflareaccess.com */
  teamDomain: string | undefined;
  audience: string;
  stackName: string;
  awsProfile: string;
  region: string;
  outDir: string;
  stdKeyFile: string;
  adminKeyFile: string;
  /** wrangler deploy --secrets-file に渡すファイル（権限 600） */
  secretsFile: string;
  /** access-watch が読む Cookie（ブラウザの CF_Authorization。権限 600） */
  cookieFile: string;
  /** Access アプリの Terraform のディレクトリ */
  accessDir: string;
  /** getSigninToken の SessionDuration（秒の文字列。空なら付けない） */
  sessionDuration: string;
  /** N9 の checks が JWT の sub と SourceIdentity に入れる値（信頼ポリシーは sub を照合しない） */
  subject: string;
  /** bypass-check の B4 が持ち込む Access JWT（poc-token で取ったもの。権限 600） */
  tokenFile: string;
  /** bypass-check の B1 が使う workers.dev のアカウントのサブドメイン（無ければ API で読む） */
  workersDevSubdomain: string | undefined;
}

export function portalSettings(
  env: Record<string, string | undefined>,
  repoRoot: string,
): PortalSettings {
  const get = (k: string) => env[`AWSBRIDGE_HUMAN_POC_PORTAL_${k}`] || undefined;
  const outDir = get("OUT_DIR") ?? join(repoRoot, ".secrets/poc-human/portal");
  const url = get("URL");
  const hostRaw = get("HOST");
  let base = url === undefined ? undefined : normalizePortalBase(url);
  if (hostRaw !== undefined) {
    const fromHost = normalizePortalBase(`https://${assertCustomHost(hostRaw)}`);
    if (base !== undefined && base !== fromHost)
      throw new Error(
        "AWSBRIDGE_HUMAN_POC_PORTAL_HOST と AWSBRIDGE_HUMAN_POC_PORTAL_URL が食い違う（HOST だけにする）",
      );
    base = fromHost;
  }
  const workersDevSubdomain = get("WORKERS_DEV_SUBDOMAIN");
  if (workersDevSubdomain !== undefined && !/^[a-z0-9-]+$/.test(workersDevSubdomain))
    throw new Error(
      "AWSBRIDGE_HUMAN_POC_PORTAL_WORKERS_DEV_SUBDOMAIN は <subdomain>.workers.dev の <subdomain> だけ",
    );
  const domainRaw = get("ACCESS_TEAM_DOMAIN")?.replace(/\/+$/, "");
  if (domainRaw !== undefined && !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(domainRaw))
    throw new Error(
      "AWSBRIDGE_HUMAN_POC_PORTAL_ACCESS_TEAM_DOMAIN は https://<team>.cloudflareaccess.com の形",
    );
  const stackName = get("STACK_NAME") ?? PORTAL_DEFAULTS.stackName;
  assertPortalName(stackName);
  const sdRaw = get("SESSION_DURATION") ?? "3600";
  let sessionDuration = "";
  if (sdRaw !== "none") {
    if (!/^\d+$/.test(sdRaw) || Number(sdRaw) < 900 || Number(sdRaw) > 43200)
      throw new Error("AWSBRIDGE_HUMAN_POC_PORTAL_SESSION_DURATION は 900〜43200 か none");
    sessionDuration = sdRaw;
  }
  const subject = get("SUBJECT") ?? "awsbridge-n9-check";
  if (!/^[\w+=,.@-]{2,64}$/.test(subject))
    throw new Error("AWSBRIDGE_HUMAN_POC_PORTAL_SUBJECT は 2〜64 文字の [A-Za-z0-9_+=,.@-]");
  return {
    base,
    teamDomain: domainRaw,
    audience: get("AUDIENCE") ?? PORTAL_DEFAULTS.audience,
    stackName,
    awsProfile: env.AWS_PROFILE || PORTAL_DEFAULTS.awsProfile,
    region: env.AWS_REGION || PORTAL_DEFAULTS.region,
    outDir,
    stdKeyFile: join(outDir, "signing-key-std.json"),
    adminKeyFile: join(outDir, "signing-key-admin.json"),
    secretsFile: join(outDir, "worker-secrets.json"),
    cookieFile: get("COOKIE_FILE") ?? join(outDir, "access-cookie.txt"),
    accessDir: get("ACCESS_DIR") ?? join(repoRoot, "scripts/poc/human/portal/access"),
    sessionDuration,
    subject,
    tokenFile: get("TOKEN_FILE") ?? join(outDir, "access-jwt.txt"),
    workersDevSubdomain,
  };
}
