// STS (AssumeRoleWithWebIdentity) 応答 XML の最小パーサー（正規表現ベース）。
// 本番では src/sts.ts が parseAssumeRoleResponse / parseStsError を使う。parseStsResponse は PoC スクリプト（scripts/poc/sts.ts）用の簡易版。
export type StsResult =
  | { ok: true; assumedRoleArn: string; hasCredentials: boolean }
  | { ok: false; code: string; message: string };

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** XML のエンティティ（名前付き・数値）をデコードする。 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith("#")) {
      const cp = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

function text(xml: string, name: string): string | undefined {
  const v = tag(xml, name);
  return v === undefined ? undefined : decodeXmlEntities(v);
}

export type ParsedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
  assumedRoleArn: string;
};

/** 成功応答から認証情報と AssumedRoleUser/Arn を取り出す。要素が欠けている・Expiration が不正なら undefined。 */
export function parseAssumeRoleResponse(xml: string): ParsedCredentials | undefined {
  const creds = tag(xml, "Credentials");
  const user = tag(xml, "AssumedRoleUser");
  if (!creds || !user) return undefined;
  const accessKeyId = text(creds, "AccessKeyId");
  const secretAccessKey = text(creds, "SecretAccessKey");
  const sessionToken = text(creds, "SessionToken");
  const exp = text(creds, "Expiration");
  const assumedRoleArn = text(user, "Arn");
  if (!accessKeyId || !secretAccessKey || !sessionToken || !exp || !assumedRoleArn)
    return undefined;
  const expiration = new Date(exp);
  if (Number.isNaN(expiration.getTime())) return undefined;
  return { accessKeyId, secretAccessKey, sessionToken, expiration, assumedRoleArn };
}

/** エラー応答（<Error>）から Code と Message を取り出す。<Error> が無ければ undefined。 */
export function parseStsError(xml: string): { code: string; message: string } | undefined {
  const err = tag(xml, "Error");
  if (!err) return undefined;
  const code = text(err, "Code");
  if (!code) return undefined;
  return { code, message: text(err, "Message") ?? "" };
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
