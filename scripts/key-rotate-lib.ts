// 署名鍵のローテーション（無停止）の各段。CLI は scripts/key-rotate.ts。手順は README「署名鍵のローテーション」。
// ファイルは 0600。上書きしない。各操作の前に存在確認をして、条件に合わなければ何も動かさず中止（例外）する。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { generateSigningJwk } from "../src/keys";
import { rotationKeyFiles } from "./poc/env";

export type RotationPaths = { current: string; next: string; previous: string };

/** 環境変数から 3 つの鍵ファイルのパスを決める（AWSBRIDGE_KEY_FILE / _NEXT_KEY_FILE / _PREVIOUS_KEY_FILE）。 */
export function rotationPaths(env: NodeJS.ProcessEnv = process.env): RotationPaths {
  return rotationKeyFiles(env);
}

/** 中止。メッセージは利用者に見せてよいもの（鍵の中身は含めない）。 */
export class RotateError extends Error {}

const SECRETS_LINE = "mise run secrets";

export async function prepare(p: RotationPaths): Promise<string[]> {
  if (existsSync(p.next)) {
    throw new RotateError(
      `次の鍵が既にあるため中止しました: ${p.next}\n` +
        "（前回の key:prepare の続きなら mise run secrets → 待つ → key:activate へ。やり直すなら、このファイルを自分で削除してください）",
    );
  }
  const jwk = await generateSigningJwk();
  mkdirSync(dirname(p.next), { recursive: true });
  writeFileSync(p.next, JSON.stringify(jwk), { mode: 0o600, flag: "wx" });
  chmodSync(p.next, 0o600);
  return [
    `次の鍵を生成しました: ${p.next} (kid=${jwk.kid})`,
    `次: ${SECRETS_LINE} で次の鍵の公開鍵を載せる（署名は現行の鍵のまま）。`,
    "STS が JWKS のキャッシュを更新するまで待つ（最低 1 時間、安全側に 24 時間）。そのあと mise run key:activate。",
  ];
}

function assertPrivateRsaJwk(file: string): void {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new RotateError(`次の鍵を JSON として読めないため中止しました: ${file}`);
  }
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e || !jwk.d) {
    throw new RotateError(`次の鍵が RSA の秘密鍵 JWK ではないため中止しました: ${file}`);
  }
}

export async function activate(p: RotationPaths): Promise<string[]> {
  if (!existsSync(p.next)) {
    throw new RotateError(
      `次の鍵がないため中止しました: ${p.next}\n先に mise run key:prepare を実行してください。`,
    );
  }
  if (existsSync(p.previous)) {
    throw new RotateError(
      `前の鍵が残っているため中止しました: ${p.previous}\n前回のローテーションを終わらせてください（mise run secrets のあと mise run key:retire）。`,
    );
  }
  if (!existsSync(p.current)) {
    throw new RotateError(
      `現行の鍵がないため中止しました: ${p.current}\n（mise run keygen で作るか、AWSBRIDGE_KEY_FILE を確認してください）`,
    );
  }
  assertPrivateRsaJwk(p.next);
  // 権限は入れ替えの前に整える（chmod が失敗しても何も動いていない状態で中止できる）
  chmodSync(p.next, 0o600);
  chmodSync(p.current, 0o600);
  // 現行 → PREVIOUS、NEXT → 現行。2 つ目が失敗したら 1 つ目を戻す
  renameSync(p.current, p.previous);
  try {
    renameSync(p.next, p.current);
  } catch (e) {
    renameSync(p.previous, p.current);
    throw e;
  }
  return [
    `現行の鍵を前の鍵にし、次の鍵を現行にしました: ${p.current}（前の鍵: ${p.previous}）`,
    `次: ${SECRETS_LINE} で署名を新しい鍵に切り替える（JWKS には前の鍵の公開鍵も残る）。`,
    "JWT の有効期限（5 分）以上経ってから mise run key:retire。",
  ];
}

export async function retire(p: RotationPaths): Promise<string[]> {
  if (!existsSync(p.previous)) {
    return [`前の鍵はありません（何もしませんでした）: ${p.previous}`];
  }
  unlinkSync(p.previous);
  return [
    `前の鍵を削除しました: ${p.previous}`,
    `次: ${SECRETS_LINE} で古い公開鍵を JWKS から外す。`,
  ];
}
