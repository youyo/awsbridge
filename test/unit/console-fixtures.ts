// コンソールログインの設定ファイル（src/console/config.ts）のテスト用の設定。値はすべてダミー（example.com・111111111111 など）。
// 呼ぶたびに新しいオブジェクトを返すので、テストの中で書き換えてよい。

// biome-ignore lint/suspicious/noExplicitAny: 誤りの入った設定を作るために書き換えるので any にする
export type Raw = any;

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** 会社用を想定した設定（設計書 §11.3 の例に合わせる。Standard 3 チーム・Admin 2 チーム、管理外の先方 1 つ）。 */
export function companyConfig(): Raw {
  return {
    schemaVersion: 1,
    portal: {
      standardOrigin: "https://portal.example.com",
      adminOrigin: "https://admin-portal.example.com",
      routing: "path",
      regions: { allowed: ["ap-northeast-1", "us-east-1"], default: "ap-northeast-1" },
      supportUrl: "https://support.example.com/aws",
    },
    teams: [
      { name: "infra", displayName: "インフラ", access: { groupObjectIds: [uuid(1)] } },
      { name: "dev", displayName: "開発", access: { groupObjectIds: [uuid(2)] } },
      { name: "sa", access: { groupObjectIds: [uuid(3)] } },
      { name: "infra-elevated", tier: "admin", access: { groupObjectIds: [uuid(4)] } },
      { name: "dev-elevated", tier: "admin", access: { groupObjectIds: [uuid(5)] } },
    ],
    roles: [
      {
        name: "admin",
        roleName: "FederatedAdministrator",
        displayName: "Admin",
        tier: "admin",
        sessionSeconds: 3600,
        permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"] },
      },
      {
        name: "developer",
        roleName: "FederatedDeveloper",
        sessionSeconds: 28800,
        permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/PowerUserAccess"] },
      },
      {
        name: "readonly",
        roleName: "FederatedViewer",
        sessionSeconds: 43200,
        permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"] },
      },
    ],
    kinds: [
      { name: "A", assign: { admin: ["infra-elevated"], readonly: ["sa", "infra"] } },
      {
        name: "B",
        assign: { admin: ["infra-elevated", "dev-elevated"], readonly: ["sa", "infra"] },
      },
      {
        name: "C",
        assign: { admin: ["infra-elevated"], developer: ["dev"], readonly: ["sa", "infra"] },
      },
      {
        name: "P",
        displayName: "管理外の先方",
        assign: { developer: ["dev"], readonly: ["sa", "infra"] },
      },
    ],
    boundaries: [
      {
        name: "managed",
        issuers: {
          standard: "https://id.example.com/standard",
          admin: "https://id.example.com/admin",
        },
      },
      { name: "partner:partner-x", issuers: { standard: "https://id.example.com/partner-x" } },
    ],
    organizations: [
      {
        name: "org-main",
        displayName: "本体",
        boundary: "managed",
        placement: "ou",
        inventoryRoleArn: "arn:aws:iam::111111111111:role/awsbridge-inventory",
        kindOus: {
          A: ["ou-abcd-11111111"],
          B: ["ou-abcd-22222222"],
          C: ["ou-abcd-33333333"],
        },
      },
      {
        name: "partner-x",
        displayName: "先方 X",
        boundary: "partner:partner-x",
        placement: "accounts",
        accounts: [
          {
            accountId: "222222222222",
            name: "partner-x-dev",
            kind: "P",
            email: "aws+partner-x-dev@example.org",
          },
        ],
      },
    ],
  };
}

/** 個人用の最小構成（設計書 §11.7）。 */
export function personalConfig(): Raw {
  return {
    schemaVersion: 1,
    portal: { standardOrigin: "https://aws.example.com" },
    teams: [{ name: "me", displayName: "自分", access: { aud: "a".repeat(64) } }],
    roles: [
      {
        name: "readonly",
        roleName: "FederatedViewer",
        sessionSeconds: 43200,
        permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"] },
      },
      {
        name: "developer",
        roleName: "FederatedDeveloper",
        sessionSeconds: 14400,
        permissions: { managedPolicyArns: ["arn:aws:iam::aws:policy/PowerUserAccess"] },
      },
    ],
    kinds: [{ name: "default", assign: { readonly: ["me"], developer: ["me"] } }],
    boundaries: [{ name: "managed", issuers: { standard: "https://id.example.com/standard" } }],
    organizations: [
      {
        name: "personal",
        boundary: "managed",
        placement: "accounts",
        accounts: [
          {
            accountId: "111111111111",
            name: "my-sandbox",
            kind: "default",
            email: "aws+sandbox@example.com",
          },
        ],
      },
    ],
  };
}

/** 会社用の設定に対応する Terraform の出力（チーム → AUD）と入口の AUD。 */
export function companyAuds(): Raw {
  return {
    teams: {
      infra: "1".repeat(64),
      dev: "2".repeat(64),
      sa: "3".repeat(64),
      "infra-elevated": "4".repeat(64),
      "dev-elevated": "5".repeat(64),
    },
    entry: { standard: "6".repeat(64), admin: "7".repeat(64) },
  };
}

/** 会社用の設定の org-main（placement: ou）のインベントリ（ListAccounts の結果を種類の OU で引ける形にしたもの）。 */
export function companyInventory(): Raw {
  return {
    "org-main": [
      {
        accountId: "333333333333",
        name: "svc-a-prod",
        email: "aws+svc-a-prod@example.com",
        ouPath: ["r-abcd", "ou-abcd-11111111"],
      },
      {
        accountId: "444444444444",
        name: "svc-c-dev",
        email: "aws+svc-c-dev@example.com",
        ouPath: ["r-abcd", "ou-abcd-33333333", "ou-abcd-99999999"],
      },
      {
        accountId: "555555555555",
        name: "suspended",
        ouPath: ["r-abcd", "ou-abcd-33333333"],
        status: "SUSPENDED",
      },
      { accountId: "666666666666", name: "sandbox", ouPath: ["r-abcd", "ou-abcd-00000000"] },
    ],
  };
}
