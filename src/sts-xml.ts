// STS (AssumeRoleWithWebIdentity) 応答 XML の最小パーサー。現在は PoC スクリプト（scripts/poc/sts.ts）専用で、Worker からは未使用。
export type StsResult =
  | { ok: true; assumedRoleArn: string; hasCredentials: boolean }
  | { ok: false; code: string; message: string };

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();
}

/** AssumeRoleWithWebIdentity の XML 応答から必要な値だけを取り出す。 */
export function parseStsResponse(xml: string): StsResult {
  const user = tag(xml, "AssumedRoleUser");
  const arn = user ? tag(user, "Arn") : undefined;
  if (arn) {
    return {
      ok: true,
      assumedRoleArn: arn,
      hasCredentials: /<Credentials>[\s\S]*<\/Credentials>/.test(xml),
    };
  }
  const err = tag(xml, "Error");
  return {
    ok: false,
    code: (err && tag(err, "Code")) || "Unknown",
    message: (err && tag(err, "Message")) || "unparseable STS response",
  };
}
