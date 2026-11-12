// コンソールログイン: 1 人停止（L3-1）の一覧と、予約名のインラインに書く文書の形（純粋な関数）。
// 設計: docs/specs/console-login.md §6.3・§4.8（cto の回答 U-15）。予約名は reserved.ts。
// 検査の道具（inspect.ts の stopValues で衝突と停止中を判定）と停止の道具（stop-plan.ts）が同じ形を使う。
// ファイルの読み込みは scripts 側に置く。node の API を使わない。値（email）はエラーの文に入れない。

export class StopsError extends Error {}

/** SourceIdentity の値の形（STS の制約: 2〜64 文字、英数字と +=,.@-_）。 */
export const SOURCE_IDENTITY_RE = /^[\w+=,.@-]{2,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 文字列か文字列の配列を、配列にする（それ以外の形は undefined）。IAM は 1 要素の配列を文字列で返しうる。 */
function asList(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

const onlyKeys = (o: Obj, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/**
 * 停止の一覧（`{ "sourceIdentities": [...] }`。検査の `--stops` と停止の道具の入力）を読む。重複を除き、値は変えない。
 * 空の一覧は受け付ける（だれも止めていない）。形の誤りは位置だけを示す（値を出さない）。
 */
export function parseStops(raw: unknown): string[] {
  const list = isObj(raw) ? raw.sourceIdentities : undefined;
  if (!Array.isArray(list)) throw new StopsError("stops.sourceIdentities: type");
  list.forEach((v, i) => {
    if (typeof v !== "string" || !SOURCE_IDENTITY_RE.test(v))
      throw new StopsError(`stops.sourceIdentities[${i}]: pattern`);
  });
  return [...new Set(list as string[])];
}

/** 予約名のインラインに書く文の Sid。 */
const STOP_SID = "DenyBySourceIdentity";

/**
 * 予約名のインラインに書く 1 人停止の Deny の文書。stopValues と往復で一致する（重複は除く）。
 * 空の一覧は拒否する（空の文書は stopValues で衝突になる。外すときは文書ごと消す）。
 */
export function stopPolicyDocument(values: string[]): {
  Version: "2012-10-17";
  Statement: [
    {
      Sid: string;
      Effect: "Deny";
      Action: "*";
      Resource: "*";
      Condition: { StringEquals: { "aws:SourceIdentity": string[] } };
    },
  ];
} {
  if (values.length === 0) throw new StopsError("stop document: empty");
  values.forEach((v, i) => {
    if (!SOURCE_IDENTITY_RE.test(v)) throw new StopsError(`stop document: values[${i}]: pattern`);
  });
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: STOP_SID,
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: { StringEquals: { "aws:SourceIdentity": [...new Set(values)] } },
      },
    ],
  };
}

/**
 * 1 人停止の Deny の形（予約名のインラインに書いてよい唯一の形）なら、止める値を返す。違えば undefined（衝突）。
 * 形: すべての文が Deny・Action "*"・Resource "*"・条件は StringEquals の aws:SourceIdentity だけ（値は 1 つ以上）。
 */
export function stopValues(doc: unknown): string[] | undefined {
  if (!isObj(doc) || doc.Version !== "2012-10-17") return undefined;
  if (!onlyKeys(doc, ["Version", "Statement", "Id"])) return undefined;
  const s = doc.Statement;
  const list = Array.isArray(s) ? s : isObj(s) ? [s] : undefined;
  if (!list?.every(isObj) || list.length === 0) return undefined;
  const values: string[] = [];
  for (const st of list as Obj[]) {
    if (!onlyKeys(st, ["Sid", "Effect", "Action", "Resource", "Condition"])) return undefined;
    if (st.Effect !== "Deny") return undefined;
    const a = asList(st.Action);
    const r = asList(st.Resource);
    if (!a || !sameSet(a, ["*"]) || !r || !sameSet(r, ["*"])) return undefined;
    const c = st.Condition;
    if (!isObj(c) || !sameSet(Object.keys(c), ["StringEquals"])) return undefined;
    const eq = c.StringEquals;
    if (!isObj(eq) || !sameSet(Object.keys(eq), ["aws:SourceIdentity"])) return undefined;
    const v = asList(eq["aws:SourceIdentity"]);
    if (!v || v.length === 0) return undefined;
    values.push(...v);
  }
  return [...new Set(values)];
}
