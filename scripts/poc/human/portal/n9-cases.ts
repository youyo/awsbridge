// N9（パス付き issuer）のケース表。I/O は checks.ts で行う。
// 否定ケースは対照と 1 点だけ違うようにする（信頼ポリシーの拒否は AccessDenied で、理由が返らないため）。
//   3・4 は 1・2 とロールだけ、5 は 2 と鍵だけ、6・7 は 1 と iss だけ、8 は 9 とチームだけ、10 は 1 と SI だけ違う。
import type { Expect } from "../cases";
import type { Tier } from "./lib";

/** std / admin = <base>/<tier>、std-slash = <base>/std/（末尾スラッシュ）、root = <base>（パスなし） */
export type IssuerKind = Tier | "std-slash" | "root";
export type N9Role = "shared" | "infra-only" | "admin";

export interface N9Case {
  id: string;
  title: string;
  /** 署名に使う鍵 */
  signWith: Tier;
  issuer: IssuerKind;
  role: N9Role;
  /** タグ awsbridge_team の値（既定 infra） */
  team: string;
  sourceIdentity: boolean;
  expect: Expect;
}

export function n9Cases(): N9Case[] {
  const base = { team: "infra", sourceIdentity: true };
  return [
    {
      id: "1",
      ...base,
      title: "std の鍵・iss=/std → Shared",
      signWith: "std",
      issuer: "std",
      role: "shared",
      expect: "ok",
    },
    {
      id: "2",
      ...base,
      title: "admin の鍵・iss=/admin → Admin",
      signWith: "admin",
      issuer: "admin",
      role: "admin",
      expect: "ok",
    },
    {
      id: "3",
      ...base,
      title: "iss=/std の JWT で admin のプロバイダーのロール",
      signWith: "std",
      issuer: "std",
      role: "admin",
      expect: "denied",
    },
    {
      id: "4",
      ...base,
      title: "iss=/admin の JWT で std のプロバイダーのロール",
      signWith: "admin",
      issuer: "admin",
      role: "shared",
      expect: "denied",
    },
    {
      id: "5",
      ...base,
      title: "std の鍵で iss=/admin（鍵と issuer の食い違い）",
      signWith: "std",
      issuer: "admin",
      role: "admin",
      expect: "error",
    },
    {
      id: "6",
      ...base,
      title: "iss=/std/（末尾スラッシュ）→ Shared",
      signWith: "std",
      issuer: "std-slash",
      role: "shared",
      expect: "record",
    },
    {
      id: "7",
      ...base,
      title: "iss=ホストだけ（プロバイダーなし）→ Shared",
      signWith: "std",
      issuer: "root",
      role: "shared",
      expect: "error",
    },
    {
      id: "8",
      ...base,
      team: "dev",
      title: "チーム dev → InfraOnly",
      signWith: "std",
      issuer: "std",
      role: "infra-only",
      expect: "denied",
    },
    {
      id: "9",
      ...base,
      title: "チーム infra → InfraOnly（8 の対照）",
      signWith: "std",
      issuer: "std",
      role: "infra-only",
      expect: "ok",
    },
    {
      id: "10",
      ...base,
      sourceIdentity: false,
      title: "SI なし → Shared",
      signWith: "std",
      issuer: "std",
      role: "shared",
      expect: "denied",
    },
  ];
}

export function n9Issuer(base: string, kind: IssuerKind): string {
  switch (kind) {
    case "std":
    case "admin":
      return `${base}/${kind}`;
    case "std-slash":
      return `${base}/std/`;
    case "root":
      return base;
  }
}

export function n9RoleOutputKey(role: N9Role): string {
  return { shared: "SharedRoleArn", "infra-only": "InfraOnlyRoleArn", admin: "AdminRoleArn" }[role];
}
