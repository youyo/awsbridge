// コンソールログイン PR2: エラーコードの表（portal §9.4 ＋ signing_unavailable）。
import { describe, expect, it } from "vitest";
import {
  ISSUE_ERRORS,
  IssueError,
  type IssueErrorCode,
  isIssueErrorCode,
  stsErrorKindToCode,
} from "../../src/console/issue/errors";

describe("エラーコードの表", () => {
  it("portal §9.4 の全コードと HTTP ステータスが一致する", () => {
    const expected: Record<string, number> = {
      unauthorized: 401,
      unknown_audience: 403,
      team_mismatch: 403,
      forbidden_origin: 403,
      unsupported_media_type: 415,
      csrf_failed: 403,
      login_disabled: 503,
      rate_limited: 429,
      not_listed: 404,
      identity_unsupported: 403,
      sts_denied: 403,
      upstream_auth_failed: 502,
      temporarily_unavailable: 503,
      signin_failed: 502,
      server_misconfigured: 500,
      // 設計書の表にない追加分: Admin の署名の部品が未接続・署名に失敗したとき（9 段目）
      signing_unavailable: 503,
    };
    expect(Object.fromEntries(Object.entries(ISSUE_ERRORS).map(([k, v]) => [k, v.status]))).toEqual(
      expected,
    );
  });

  it("isIssueErrorCode は表のコードだけを通す（prototype の名前も通さない）", () => {
    expect(isIssueErrorCode("sts_denied")).toBe(true);
    expect(isIssueErrorCode("signing_unavailable")).toBe(true);
    expect(isIssueErrorCode("nope")).toBe(false);
    expect(isIssueErrorCode("constructor")).toBe(false);
    expect(isIssueErrorCode(undefined)).toBe(false);
  });

  it("IssueError はコードから HTTP ステータスを決め、画面に出せる文言だけを message に持つ", () => {
    const e = new IssueError(
      "sts_denied",
      "AccessDenied: not authorized to perform sts:TagSession",
    );
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("sts_denied");
    expect(e.status).toBe(403);
    expect(e.message).toBe("sts_denied");
    expect(e.detail).toBe("AccessDenied: not authorized to perform sts:TagSession");
  });

  it("STS のエラー種別をコードに対応づける（forbidden→sts_denied、invalid_token→upstream_auth_failed、transient→temporarily_unavailable）", () => {
    const map: [Parameters<typeof stsErrorKindToCode>[0], IssueErrorCode][] = [
      ["forbidden", "sts_denied"],
      ["invalid_token", "upstream_auth_failed"],
      ["transient", "temporarily_unavailable"],
    ];
    for (const [kind, code] of map) expect(stsErrorKindToCode(kind)).toBe(code);
  });
});
