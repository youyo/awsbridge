// コンソールログインの発行: エラーコードの表。設計: docs/specs/console-login-portal.md §9.4。
// 表にある 15 個に、`signing_unavailable`（署名の部品が未接続・署名に失敗。503）を足した。
// 内部の詳細（STS の本文・例外の文）は `detail` に持つだけで、画面には出さない（message はコードだけ）。

export const ISSUE_ERRORS = {
  unauthorized: { status: 401 },
  unknown_audience: { status: 403 },
  team_mismatch: { status: 403 },
  forbidden_origin: { status: 403 },
  unsupported_media_type: { status: 415 },
  csrf_failed: { status: 403 },
  login_disabled: { status: 503 },
  rate_limited: { status: 429 },
  not_listed: { status: 404 },
  identity_unsupported: { status: 403 },
  sts_denied: { status: 403 },
  upstream_auth_failed: { status: 502 },
  temporarily_unavailable: { status: 503 },
  signin_failed: { status: 502 },
  server_misconfigured: { status: 500 },
  signing_unavailable: { status: 503 },
} as const satisfies Record<string, { status: number }>;

export type IssueErrorCode = keyof typeof ISSUE_ERRORS;

export const isIssueErrorCode = (v: unknown): v is IssueErrorCode =>
  typeof v === "string" && Object.hasOwn(ISSUE_ERRORS, v);

export class IssueError extends Error {
  readonly code: IssueErrorCode;
  readonly status: number;
  /** ログ用の詳細（画面に出さない）。 */
  readonly detail?: string;

  constructor(code: IssueErrorCode, detail?: string) {
    super(code);
    this.name = "IssueError";
    this.code = code;
    this.status = ISSUE_ERRORS[code].status;
    if (detail !== undefined) this.detail = detail;
  }
}

/** src/sts.ts の StsErrorKind を発行のエラーコードに対応づける（9 段目）。 */
export function stsErrorKindToCode(
  kind: "invalid_token" | "forbidden" | "transient",
): IssueErrorCode {
  switch (kind) {
    case "forbidden":
      return "sts_denied";
    case "invalid_token":
      return "upstream_auth_failed";
    case "transient":
      return "temporarily_unavailable";
  }
}
