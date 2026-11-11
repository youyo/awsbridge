// deploy.ts（ポータル Worker のデプロイ）の純粋関数。
import type { JWK } from "jose";
import { assertPortalRoleArn, type PortalRole, parseAudMap } from "./lib";

/**
 * `terraform output -json` から、Worker に渡す AUD → チームの対応と入口の AUD を作る。
 * state が無い（出力が空）なら undefined。Terraform の worker_host がポータルの URL のホストと違えば例外。
 */
export function audFromTerraformOutput(
  json: string,
  base: string,
): { audMap: Record<string, string>; entryAud: string } | undefined {
  if (json.trim() === "") return undefined;
  const v = JSON.parse(json) as Record<string, { value?: unknown } | undefined>;
  const teamAuds = v.team_auds?.value;
  const entryAud = v.entry_aud?.value;
  const host = v.worker_host?.value;
  if (teamAuds === undefined && entryAud === undefined) return undefined;
  if (host !== new URL(base).host)
    throw new Error(
      `Terraform の worker_host（${String(host)}）が AWSBRIDGE_HUMAN_POC_PORTAL_URL のホストと違う`,
    );
  if (typeof teamAuds !== "object" || teamAuds === null || typeof entryAud !== "string")
    throw new Error("terraform output の team_auds / entry_aud の形が違う");
  const inverted = Object.fromEntries(
    Object.entries(teamAuds as Record<string, unknown>).map(([team, aud]) => [String(aud), team]),
  );
  return { audMap: parseAudMap(JSON.stringify(inverted)), entryAud };
}

/** スタックの Outputs から、ログインで選べるロール（Shared と InfraOnly）を作る。無ければ []。 */
export function rolesFromOutputs(outputs: Record<string, string>): PortalRole[] {
  const out: PortalRole[] = [];
  for (const [label, key] of [
    ["shared", "SharedRoleArn"],
    ["infra-only", "InfraOnlyRoleArn"],
  ] as const) {
    const arn = outputs[key];
    if (arn === undefined) continue;
    assertPortalRoleArn(arn);
    out.push({ label, arn });
  }
  return out;
}

/** wrangler deploy の --var に渡す KEY:VALUE（秘密は含めない。値が無いものは渡さない）。 */
export function deployVars(p: {
  base: string;
  teamDomain: string;
  audMap: Record<string, string>;
  entryAud: string | undefined;
  roles: PortalRole[];
  sessionDuration: string;
  audience: string;
  region: string;
  /** PoC 専用の GET /t/<team>/poc-token を開ける（bypass-check の B4 の準備。既定は閉じる） */
  pocToken?: boolean;
}): string[] {
  const pairs: [string, string | undefined][] = [
    ["PORTAL_BASE", p.base],
    ["ACCESS_TEAM_DOMAIN", p.teamDomain],
    ["ACCESS_AUD_MAP", JSON.stringify(p.audMap)],
    ["ACCESS_ENTRY_AUD", p.entryAud],
    ["ROLES", JSON.stringify(p.roles)],
    ["SESSION_DURATION", p.sessionDuration],
    ["AUDIENCE", p.audience],
    ["REGION", p.region],
    ["POC_TOKEN_ENDPOINT", p.pocToken === true ? "enabled" : undefined],
  ];
  return pairs.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}:${v}`);
}

/** Worker の secret（--secrets-file に JSON で書く）。 */
export function workerSecrets(std: JWK, admin: JWK): Record<string, string> {
  return { SIGNING_JWK_STD: JSON.stringify(std), SIGNING_JWK_ADMIN: JSON.stringify(admin) };
}
