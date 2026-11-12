// ロールのテンプレート（src/console/template.ts の出力）を CloudFormation の YAML にする。
// 生成の CLI（scripts/console/config.ts）と参考のテンプレートの書き出し（scripts/console/kind-example.ts）が使う。
import { stringify } from "yaml";
import type { CfnTemplate } from "../../src/console/template";

const HEADER = [
  "# awsbridge のコンソールログイン: ロールのテンプレート（種類の StackSet。参考の形）。",
  "# 設定ファイルから生成したもの。手で書き換えない（設計: docs/specs/console-login.md §4.3）。",
  "",
].join("\n");

export function templateYaml(template: CfnTemplate): string {
  // 長い文字列（信頼ポリシーの JSON）を折り返さない。CloudFormation が受け付けない YAML のエイリアスを使わない。
  // YAML 1.1 の規則で書き、日付や真偽値に見える文字列（2012-10-17 など）は引用符で囲む
  return (
    HEADER + stringify(template, { version: "1.1", lineWidth: 0, aliasDuplicateObjects: false })
  );
}
