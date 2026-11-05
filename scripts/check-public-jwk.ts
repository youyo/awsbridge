// put-secrets.sh 用: 鍵ファイルから作る公開鍵が Worker と同じ検証（src/keys.ts の publicJwkOf）を通るか確かめる。
// 使い方: tsx scripts/check-public-jwk.ts <鍵ファイル>。通れば終了コード 0、通らなければ 1（鍵の中身は出さない）。
import { readFileSync } from "node:fs";
import { publicJwkOf } from "../src/keys";

const file = process.argv[2];
try {
  if (!file) throw new Error("no file");
  await publicJwkOf(JSON.parse(readFileSync(file, "utf8")));
} catch {
  process.exit(1);
}
