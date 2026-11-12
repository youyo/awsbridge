// コンソールログイン: 生成物のうち Worker が読む 2 つの契約の型。型だけを置き、constants.ts 以外を import しない。
// 生成器（generate.ts）が作り、Worker が読む。形を変えるときは schemaVersion と設計書（console-login-portal.md §5.2・§11.4）を見直す。
//
//   WorkerConfig  worker.<tier>.json  発行用。その階層のチーム（AUD つき）・ロール・境界の issuer・一覧の行（roleArn つき）。
//                                     発行の経路（確認・検証・署名）が読む。
//   DisplayConfig display.standard.json  表示用。Standard のデプロイにだけ渡す。入口の一覧（S0。U2）の表示だけに使い、
//                                     発行の経路からは読まない（import しない）。Administrator の行（表示用だけ）と
//                                     Entra グループの Object ID → チームの対応表を持つ。
//                                     Admin のチームの AUD・Access のポリシー ID・Admin の issuer・鍵の参照・roleArn は持たない。
//
// 2 つのファイルは `purpose` で見分ける（取り違えて渡されたら Worker が起動時に止まれるように）。

import type { Routing, SourceIdentitySource, Tier } from "./constants";

export type Meta = { schemaVersion: 1; generatedAt: string; sourceRevision?: string };

// ---- 発行用 ----

export type WorkerTeam = { name: string; displayName: string; aud?: string };
export type WorkerRole = {
  name: string;
  roleName: string;
  displayName: string;
  sessionSeconds: number;
};
export type WorkerAccountRole = {
  role: string;
  roleArn: string;
  teams: string[];
  sessionSeconds: number;
};
export type WorkerAccount = {
  accountId: string;
  name: string;
  email?: string;
  orgLabel: string;
  boundary: string;
  kind: string;
  roles: WorkerAccountRole[];
};
export type WorkerConfig = Meta & {
  purpose: "issue";
  tier: Tier;
  tagKey: string;
  /** SourceIdentity の値の出どころ（設定の identity.sourceIdentity。既定 email）。 */
  identity: { sourceIdentity: SourceIdentitySource };
  portal: {
    origin: string;
    /** もう一方の階層のオリジン（Standard では Administrator の行の遷移先、Admin では一覧への戻り先。§8）。 */
    peerOrigin?: string;
    routing: Routing;
    regions?: { allowed: string[]; default: string };
    supportUrl?: string;
    entryAud?: string;
  };
  teams: WorkerTeam[];
  roles: WorkerRole[];
  boundaries: { name: string; issuer: string }[];
  organizations: { name: string; displayName: string }[];
  accounts: WorkerAccount[];
};

// ---- 表示用 ----

export type DisplayTeam = { name: string; displayName: string; tier: Tier };
export type DisplayRole = { name: string; displayName: string; tier: Tier; sessionSeconds: number };
export type DisplayAccountRole = { role: string; teams: string[]; sessionSeconds: number };
/**
 * 一覧の 1 行（アカウント × 階層）。`roleArn` を持たないので、発行には使えない。
 * `tier: "admin"` の行は表示用の Administrator の行で、email を持たない。
 */
export type DisplayAccount = {
  tier: Tier;
  accountId: string;
  name: string;
  email?: string;
  orgLabel: string;
  boundary: string;
  kind: string;
  roles: DisplayAccountRole[];
};
/** Entra グループの Object ID（小文字）→ そのグループを `access.groupObjectIds` に持つチーム（Standard・Admin の両方）。 */
export type DisplayGroup = { objectId: string; teams: string[] };
export type DisplayConfig = Meta & {
  purpose: "display";
  /** 表示用は Standard のデプロイにだけ渡す。 */
  tier: "standard";
  portal: {
    origin: string;
    /** Administrator の行の遷移先（Admin のオリジン）。Admin の階層がなければない。 */
    adminOrigin?: string;
    routing: Routing;
    supportUrl?: string;
  };
  teams: DisplayTeam[];
  roles: DisplayRole[];
  groups: DisplayGroup[];
  organizations: { name: string; displayName: string }[];
  accounts: DisplayAccount[];
};
