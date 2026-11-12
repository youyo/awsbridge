// PoC N6（K2）: Worker が KMS を呼ぶ IAM ユーザーのアクセスキーを作る・消す。
//   create: 既存のキーが無いことを確かめて作り、権限 600 の一時ファイル経由で Worker の secret
//           （AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY・CALLER_TOKEN）に入れ、一時ファイルを消す。
//           CALLER_TOKEN（/poc/* の bearer）は <OUT_DIR>/caller-token.txt（権限 600）に置き、無ければ作る。
//   delete: その IAM ユーザーのアクセスキーをすべて消す（PoC の終わりに必ず実行。destroy も先に消す）。
// アクセスキーはテンプレート（CloudFormation）では作らない（秘密をスタックに残さない）。キーの ID・秘密は画面に出さない。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fail, writeSecret } from "../human/io";
import { aws, awsJson, loadSettings, repoRoot, stackOutputs } from "./io";

const cmd = process.argv[2];
if (cmd !== "create" && cmd !== "delete") fail("使い方: access-key.ts create|delete");
const s = loadSettings();
const outputs = stackOutputs(s);
const user = outputs.WorkerUserName;
if (!user || !user.startsWith("awsbridge-admin-kms-poc"))
  fail("スタックの Output WorkerUserName が PoC のユーザーでない");

const list = awsJson<{ AccessKeyMetadata: { AccessKeyId: string; CreateDate: string }[] }>(s, [
  "iam",
  "list-access-keys",
  "--user-name",
  user,
]);

if (cmd === "delete") {
  for (const k of list.AccessKeyMetadata) {
    const r = aws(s, [
      "iam",
      "delete-access-key",
      "--user-name",
      user,
      "--access-key-id",
      k.AccessKeyId,
    ]);
    if (!r.ok) fail(`アクセスキーを消せません: ${r.stderr}`);
  }
  const after = awsJson<{ AccessKeyMetadata: unknown[] }>(s, [
    "iam",
    "list-access-keys",
    "--user-name",
    user,
  ]);
  console.log(
    `アクセスキーを ${list.AccessKeyMetadata.length} 個消しました。残り ${after.AccessKeyMetadata.length} 個（${new Date().toISOString()}）`,
  );
  process.exit(after.AccessKeyMetadata.length === 0 ? 0 : 1);
}

if (list.AccessKeyMetadata.length > 0)
  fail("アクセスキーが既にあります。作り直すなら先に mise run poc:admin-kms:access-key -- delete");

if (!existsSync(s.callerTokenFile))
  writeSecret(s.callerTokenFile, Buffer.from(randomBytes(32)).toString("base64url"));
const callerToken = readFileSync(s.callerTokenFile, "utf8").trim();

const created = awsJson<{
  AccessKey: { AccessKeyId: string; SecretAccessKey: string; CreateDate: string };
}>(s, ["iam", "create-access-key", "--user-name", user]);
const tmp = join(s.outDir, `worker-secrets.${process.pid}.json`);
try {
  writeSecret(
    tmp,
    JSON.stringify({
      AWS_ACCESS_KEY_ID: created.AccessKey.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: created.AccessKey.SecretAccessKey,
      CALLER_TOKEN: callerToken,
    }),
  );
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const r = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", tmp, "--name", s.workerName], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  if (r.status !== 0) {
    // 秘密を Worker に入れられなかったキーは残さない
    aws(s, [
      "iam",
      "delete-access-key",
      "--user-name",
      user,
      "--access-key-id",
      created.AccessKey.AccessKeyId,
    ]);
    fail(
      `wrangler secret bulk が失敗しました（終了コード ${r.status}）。作ったアクセスキーは消しました`,
    );
  }
} finally {
  rmSync(tmp, { force: true });
}
console.log(
  `アクセスキーを作り Worker ${s.workerName} の secret に入れました（作成 ${created.AccessKey.CreateDate}。ID と秘密は出さない）`,
);
