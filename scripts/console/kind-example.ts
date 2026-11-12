// 参考のロールのテンプレート infra/aws/console/kind.example.yaml を、会社用の設定の例
// （config/console.company.example.json）の種類 C から書き出す: pnpm tsx scripts/console/kind-example.ts
// mise タスク console:template:example から呼ぶ。内容が生成器と一致することは test/unit/console-role-template.test.ts で確かめる。
import { readFileSync, writeFileSync } from "node:fs";
import { parseConsoleConfig } from "../../src/console/config";
import { buildKindTemplate } from "../../src/console/template";
import { templateYaml } from "./template-yaml";

const EXAMPLE_CONFIG = "config/console.company.example.json";
const EXAMPLE_KIND = "C";
const EXAMPLE_OUT = "infra/aws/console/kind.example.yaml";

const { config } = parseConsoleConfig(readFileSync(EXAMPLE_CONFIG, "utf8"));
writeFileSync(EXAMPLE_OUT, templateYaml(buildKindTemplate(config, EXAMPLE_KIND)));
console.log(`書きました: ${EXAMPLE_OUT}`);
