// 署名鍵のローテーション CLI: pnpm tsx scripts/key-rotate.ts <prepare|activate|retire>
// mise タスク key:prepare / key:activate / key:retire から呼ぶ。実装は key-rotate-lib.ts。
import { activate, prepare, RotateError, retire, rotationPaths } from "./key-rotate-lib";

const commands = { prepare, activate, retire } as const;
const name = process.argv[2];

if (!name || !Object.hasOwn(commands, name)) {
  console.error("使い方: key-rotate.ts <prepare|activate|retire>");
  process.exit(1);
}
try {
  const lines = await commands[name as keyof typeof commands](rotationPaths());
  for (const l of lines) console.log(l);
} catch (e) {
  console.error(e instanceof RotateError ? e.message : "鍵の操作に失敗しました");
  process.exit(1);
}
