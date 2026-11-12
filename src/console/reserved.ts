// コンソールログイン: 配ったあとに変えにくい IAM の名前（予約名）。必須のスタック（infra/aws/console/base.yaml）・
// ロールのテンプレート（PR8）・停止と検査の道具が同じ値を使う。設計: docs/specs/console-login.md §4.2・§4.8・§6.3。
// 副作用のない定数だけを置く（MCP 用 Worker からは import しない。cto の D2）。

/**
 * 1 人停止の Deny（L3-1。`aws:SourceIdentity` がその人の値のときの全操作の明示の Deny）を書く、
 * コンソールログイン用ロールの**インラインポリシーの予約名**。cto の回答（U-15）:
 * - 置き場所は CloudFormation の外のロールのインライン。停止の道具が、設定の全ロールにこの名前で書く
 * - 守りの部品（base.yaml）にもロールのテンプレートにも入れない。テンプレートはこの名前を管理しない
 * - 手作りのロールに求めるのは「この名前を別の用途に使わない」「テンプレートでこの名前を管理しない」の 2 つだけ
 * - 衝突は検査の道具で見る。停止中は「全ロールにこの名前の Deny があるか」を確かめる道具を、スタックの更新・ロールの追加のあとに回す
 * PoC の名前（AwsbridgeDenySourceIdentity。scripts/poc/human/ops.ts）とは分ける（PoC のスタックの片付けと混ざらないように）。
 */
export const STOP_USER_INLINE_POLICY_NAME = "AwsbridgeConsoleDenySourceIdentity";

/** 守りの部品（顧客管理ポリシー）の IAM パス。部品は自分への書き込みを `policy/awsbridge-console/*` で Deny する。 */
export const GUARD_POLICY_PATH = "/awsbridge-console/";

/** 守りの部品（顧客管理ポリシー）の名前。階層ごとに 1 つ。検査の道具が「付いていること」を名前で見る。 */
export const GUARD_POLICY_NAME = {
  standard: "AwsbridgeConsoleGuardStandard",
  admin: "AwsbridgeConsoleGuardAdmin",
} as const;

/**
 * 必須のスタックの Export 名（ロールのテンプレートが Fn::ImportValue で部品の ARN を読む）。
 * StackSets ではスタック名が自動で付くので、スタック名に依存しない固定の名前にする（1 アカウント・1 リージョンに 1 スタック）。
 */
export const BASE_EXPORT_NAME = {
  standardGuardPolicyArn: "awsbridge-console-guard-standard-arn",
  adminGuardPolicyArn: "awsbridge-console-guard-admin-arn",
} as const;

/** 管理ポリシーの大きさの上限（空白を除いた文字数）。部品はこれに収める。 */
export const MANAGED_POLICY_MAX_CHARS = 6144;
