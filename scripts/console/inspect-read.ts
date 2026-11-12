// 検査の道具の読み取り: aws CLI（IAM の読み取りだけ）の応答から、判定（src/console/inspect.ts）に渡す AccountSnapshot を作る。
// aws CLI の呼び出しは AwsRun として差し替えられる（試験は材料の応答で動かし、実際の AWS に接続しない）。
// 呼ぶのは READ_COMMANDS の 8 種類だけ（書き込みはしない）。設計: docs/specs/console-login.md §4.9。

import { ROLE_PATH_PREFIX } from "../../src/console/constants";
import type {
  AccountSnapshot,
  ManagedPolicySnapshot,
  RoleSnapshot,
} from "../../src/console/inspect";

/** aws CLI を `aws <args> --profile <p> --output json` で呼び、JSON を返す（失敗は例外）。 */
export type AwsRun = (args: string[]) => Promise<unknown>;

/** 使う読み取りの API（aws CLI の「サービス サブコマンド」）。これ以外は呼ばない。 */
export const READ_COMMANDS = [
  "iam list-open-id-connect-providers",
  "iam list-roles",
  "iam get-role",
  "iam list-attached-role-policies",
  "iam list-role-policies",
  "iam get-role-policy",
  "iam get-policy",
  "iam get-policy-version",
] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class ReadError extends Error {}

function field(o: unknown, key: string, where: string): unknown {
  if (!isObj(o) || !(key in o)) throw new ReadError(`unexpected response: ${where}.${key}`);
  return o[key];
}
function list(o: unknown, key: string, where: string): unknown[] {
  const v = field(o, key, where);
  if (!Array.isArray(v)) throw new ReadError(`unexpected response: ${where}.${key}`);
  return v;
}
function str(o: unknown, key: string, where: string): string {
  const v = field(o, key, where);
  if (typeof v !== "string") throw new ReadError(`unexpected response: ${where}.${key}`);
  return v;
}

/** ポリシーの文書（CLI は JSON に直して返す。文字列なら URL エンコードの JSON として読む）。 */
export function policyDocument(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    try {
      return JSON.parse(decodeURIComponent(v));
    } catch {
      return v; // 読めない文書は文字列のまま渡す（判定が形の誤りにする）
    }
  }
}

const ARN_RE = /^arn:([\w-]+):iam::(\d{12}):/;

export type ReadOptions = {
  /** 設定のロールの名前（詳細を読む対象。コンソール用のパスのロールも読む）。 */
  roleNames: string[];
  /** 渡せば、読んだ ARN のアカウントがこれと違うときに止まる。 */
  expectAccountId?: string;
};

export async function readAccountSnapshot(run: AwsRun, o: ReadOptions): Promise<AccountSnapshot> {
  const providers = list(
    await run(["iam", "list-open-id-connect-providers"]),
    "OpenIDConnectProviderList",
    "list-open-id-connect-providers",
  ).map((p) => str(p, "Arn", "OpenIDConnectProviderList[]"));

  const listed = list(await run(["iam", "list-roles"]), "Roles", "list-roles");
  const roles: RoleSnapshot[] = listed.map((r) => ({
    roleName: str(r, "RoleName", "Roles[]"),
    path: str(r, "Path", "Roles[]"),
    arn: str(r, "Arn", "Roles[]"),
    trustPolicy: policyDocument(field(r, "AssumeRolePolicyDocument", "Roles[]")),
    ...(isObj(r) && typeof r.MaxSessionDuration === "number"
      ? { maxSessionDuration: r.MaxSessionDuration }
      : {}),
  }));

  // アカウントとパーティション: 読んだ ARN がすべて同じアカウントであること（取り違えたプロファイルで通さない）
  const ids = new Set<string>();
  const partitions = new Set<string>();
  for (const arn of [...providers, ...roles.map((r) => r.arn)]) {
    const m = ARN_RE.exec(arn);
    if (!m?.[1] || !m[2]) throw new ReadError("unexpected ARN in response");
    partitions.add(m[1]);
    ids.add(m[2]);
  }
  const [accountId] = [...ids];
  const [partition] = [...partitions];
  if (ids.size !== 1 || partitions.size !== 1 || accountId === undefined || partition === undefined)
    throw new ReadError(`could not determine a single account from the responses (${ids.size})`);
  if (o.expectAccountId !== undefined && o.expectAccountId !== accountId)
    throw new ReadError("the profile's account differs from --account-id");

  // 設定のロールとコンソール用のパスのロールは、詳細（今の信頼ポリシー・管理ポリシー・インライン）を読む
  const customer = new Set<string>();
  for (const r of roles) {
    if (!o.roleNames.includes(r.roleName) && !r.path.startsWith(ROLE_PATH_PREFIX)) continue;
    const n = r.roleName;
    const got = field(await run(["iam", "get-role", `--role-name=${n}`]), "Role", "get-role");
    r.trustPolicy = policyDocument(field(got, "AssumeRolePolicyDocument", "Role"));
    r.path = str(got, "Path", "Role");
    if (isObj(got) && typeof got.MaxSessionDuration === "number")
      r.maxSessionDuration = got.MaxSessionDuration;
    r.attachedPolicies = list(
      await run(["iam", "list-attached-role-policies", `--role-name=${n}`]),
      "AttachedPolicies",
      "list-attached-role-policies",
    ).map((p) => ({
      policyName: str(p, "PolicyName", "AttachedPolicies[]"),
      policyArn: str(p, "PolicyArn", "AttachedPolicies[]"),
    }));
    for (const p of r.attachedPolicies)
      if (!/^arn:[\w-]+:iam::aws:policy\//.test(p.policyArn)) customer.add(p.policyArn);
    const names = list(
      await run(["iam", "list-role-policies", `--role-name=${n}`]),
      "PolicyNames",
      "list-role-policies",
    ).map((x) => {
      if (typeof x !== "string") throw new ReadError("unexpected response: PolicyNames[]");
      return x;
    });
    r.inlinePolicies = [];
    for (const name of names) {
      const doc = field(
        await run(["iam", "get-role-policy", `--role-name=${n}`, `--policy-name=${name}`]),
        "PolicyDocument",
        "get-role-policy",
      );
      r.inlinePolicies.push({ policyName: name, document: policyDocument(doc) });
    }
  }

  // 顧客管理ポリシー（守りの部品を含む）は、今の既定の版の中身まで読む
  const managedPolicies: ManagedPolicySnapshot[] = [];
  for (const arn of [...customer].sort()) {
    const policy = field(
      await run(["iam", "get-policy", "--policy-arn", arn]),
      "Policy",
      "get-policy",
    );
    const version = str(policy, "DefaultVersionId", "Policy");
    const pv = field(
      await run(["iam", "get-policy-version", "--policy-arn", arn, "--version-id", version]),
      "PolicyVersion",
      "get-policy-version",
    );
    managedPolicies.push({
      arn,
      defaultVersionId: version,
      document: policyDocument(field(pv, "Document", "PolicyVersion")),
    });
  }

  return { accountId, partition, providers, roles, managedPolicies };
}
