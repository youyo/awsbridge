// コンソールログインの Worker が外に出す通信を 1 つの関数に集める（P2（B）の設計メモ §4.2、cto の決裁 2026-11-17 の c3）。
// P2 では 1 つの Worker が Viewer と Administrator の両方を発行するので、Worker 全体の宛先を 3 つに固定して用途ごとに検証する:
//   GET  <ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs   Access JWT の署名の検証の鍵（jose の createRemoteJWKSet の customFetch）
//   POST https://sts.<STS_REGION>.amazonaws.com/       AssumeRoleWithWebIdentity
//   POST https://signin.aws.amazon.com/federation      getSigninToken
// オリジン・パス・メソッドの完全一致だけを通す（クエリ・ユーザー情報・別のリージョン・別のチームドメインは断る）。
// どれもリダイレクトを追わない（redirect: manual を強制し、3xx は失敗）。断ったときは送らずに例外（EgressError）を投げ、
// 呼び出し側は通信の失敗として扱う（Access の検証は 401、STS・getSigninToken は発行しない）。
// 入口の身元のグループ（get-identity）はつながない（つなぐなら新しい宛先になるので別に上申する。§4.2）。
// base を渡さなければ、呼ぶ時点の globalThis.fetch を使う（E2E のエントリが外向きの通信を後から差し替えるため）。node:* を import しない。

/** 外への通信を断った理由（種別だけ。URL などの値は持たない）。 */
export class EgressError extends Error {
  readonly kind: "egress_denied" | "egress_redirect";
  constructor(kind: "egress_denied" | "egress_redirect") {
    super(`console egress: ${kind}`);
    this.name = "EgressError";
    this.kind = kind;
  }
}

export type EgressTargets = {
  /** `https://<team>.cloudflareaccess.com`（検証済みのオリジン）。 */
  accessTeamDomain: string;
  /** STS の地域の endpoint のリージョン（検証済み）。 */
  stsRegion: string;
};

/** 3 つの宛先（メソッドと URL の完全一致）。 */
export function egressTargets(t: EgressTargets): { method: string; url: string }[] {
  return [
    { method: "GET", url: `${t.accessTeamDomain}/cdn-cgi/access/certs` },
    { method: "POST", url: `https://sts.${t.stsRegion}.amazonaws.com/` },
    { method: "POST", url: "https://signin.aws.amazon.com/federation" },
  ];
}

/** 外への通信の関数を作る。3 つの宛先のどれかに完全一致するときだけ送り、リダイレクトを追わない。 */
export function createEgress(t: EgressTargets, base?: typeof fetch): typeof fetch {
  const allowed = egressTargets(t);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (!allowed.some((a) => a.url === url && a.method === method))
      throw new EgressError("egress_denied");
    const doFetch = base ?? globalThis.fetch;
    const res = await doFetch(input, { ...init, method, redirect: "manual" });
    // redirect: manual でも、Workers は 3xx をそのまま返す（ブラウザの opaqueredirect は status 0）。どちらも失敗
    if ((res.status >= 300 && res.status < 400) || (res.type as string) === "opaqueredirect")
      throw new EgressError("egress_redirect");
    return res;
  }) as typeof fetch;
}
