// access-watch.ts（所属を外したときに拒否されるまでの時間を測る見張り）の純粋関数。
// 記録の形と集計は stop-watch と同じ（../watch.ts の Sample・summarizeSamples）。
import type { Sample } from "../watch";

/** Cookie のファイルの中身から Cookie ヘッダーを作る。トークンだけなら CF_Authorization= を付ける。 */
export function cookieHeader(fileContent: string): string {
  const s = fileContent.trim();
  if (s === "" || /[\r\n]/.test(s))
    throw new Error("Cookie のファイルは 1 行（トークンか Cookie 行）");
  return s.includes("=") ? s : `CF_Authorization=${s}`;
}

export type Classified = Omit<Sample, "at" | "target">;

/**
 * whoami の応答を分類する。成功は「Worker が Access JWT を検証でき、AUD のチームがパスのチームと一致」だけ。
 * 失敗のコード: access_login_redirect（Access がログインへ送った = セッション切れ・失効）/ access_forbidden（Access の拒否）/
 * worker_unauthorized（Worker が JWT を検証できない）/ team_mismatch / http_<status>
 */
export function classifyWhoami(r: {
  status: number;
  location: string | null;
  body: string;
}): Classified {
  if (r.status >= 300 && r.status < 400) {
    const loc = r.location ?? "";
    return {
      ok: false,
      code:
        /\.cloudflareaccess\.com\//.test(loc) || loc.includes("/cdn-cgi/access/")
          ? "access_login_redirect"
          : `http_${r.status}`,
    };
  }
  if (r.status === 403) return { ok: false, code: "access_forbidden" };
  if (r.status === 401) return { ok: false, code: "worker_unauthorized" };
  if (r.status !== 200) return { ok: false, code: `http_${r.status}` };
  let b: { verified?: unknown; team_match?: unknown; aud_team?: unknown; iat?: unknown };
  try {
    b = JSON.parse(r.body);
  } catch {
    return { ok: false, code: "not_json" };
  }
  const detail = `iat=${String(b.iat)} aud_team=${String(b.aud_team)}`;
  if (b.verified !== true) return { ok: false, code: "worker_unauthorized", detail };
  if (b.team_match !== true) return { ok: false, code: "team_mismatch", detail };
  return { ok: true, detail };
}

/** 対象ごとに、Access JWT の iat が変わった（= Access がトークンを取り直した）時刻を出す。最初の観測も含める。 */
export function tokenRefreshes(samples: Sample[]): { target: string; at: string; iat: number }[] {
  const last = new Map<string, number>();
  const out: { target: string; at: string; iat: number }[] = [];
  const sorted = [...samples].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const s of sorted) {
    const m = /iat=(\d+)/.exec(s.detail ?? "");
    if (!s.ok || !m) continue;
    const iat = Number(m[1]);
    if (last.get(s.target) !== iat) out.push({ target: s.target, at: s.at, iat });
    last.set(s.target, iat);
  }
  return out;
}
