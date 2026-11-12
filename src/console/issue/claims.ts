// コンソールログインの発行: STS（AssumeRoleWithWebIdentity）に渡す JWT の claim を組む。
// 流用元は scripts/poc/human/claims.ts と portal/lib.ts（import せずに写して直した）。Worker に入るので node:* を import しない。
// 設計: docs/specs/console-login.md §3.4。
//   iss・aud・sub・タグ（入れ子形式で awsbridge_team の 1 つだけ。transitive_tag_keys は入れない）・SourceIdentity・jti・iat・exp（5 分）。
//   azp は入れない。
import { AUDIENCE, NAME_RE, TEAM_TAG_KEY } from "../constants";
import { isValidSourceIdentity } from "./identity";

export const AWS_TAGS_CLAIM = "https://aws.amazon.com/tags";
export const AWS_SOURCE_IDENTITY_CLAIM = "https://aws.amazon.com/source_identity";
/** JWT の有効期間（秒）。 */
export const TOKEN_TTL_SECONDS = 300;

export type ClaimParams = {
  /** 境界の issuer（https の URL。そのまま iss に入れる）。 */
  issuer: string;
  /** 利用者の email（小文字）。 */
  sub: string;
  /** セッションタグ awsbridge_team の値。 */
  team: string;
  sourceIdentity: string;
  /** epoch 秒。 */
  now: number;
  /** 試験用。省略すると UUID を作る。 */
  jti?: string;
};

export type Claims = {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  [AWS_TAGS_CLAIM]: { principal_tags: Record<string, string[]> };
  [AWS_SOURCE_IDENTITY_CLAIM]: string;
};

const ISSUER_RE = /^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/;

/** 引数が不正なら例外（呼び出し側で fail-closed にする）。 */
export function buildClaims(p: ClaimParams): Claims {
  if (!ISSUER_RE.test(p.issuer)) throw new Error("iss must be an https URL");
  if (!NAME_RE.test(p.team)) throw new Error("team name is invalid");
  if (!isValidSourceIdentity(p.sourceIdentity)) throw new Error("SourceIdentity is invalid");
  if (p.sub === "") throw new Error("sub is empty");
  return {
    iss: p.issuer,
    aud: AUDIENCE,
    sub: p.sub,
    jti: p.jti ?? crypto.randomUUID(),
    iat: p.now,
    exp: p.now + TOKEN_TTL_SECONDS,
    [AWS_TAGS_CLAIM]: { principal_tags: { [TEAM_TAG_KEY]: [p.team] } },
    [AWS_SOURCE_IDENTITY_CLAIM]: p.sourceIdentity,
  };
}
