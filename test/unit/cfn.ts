import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export const TEMPLATE_PATH = resolve(import.meta.dirname, "../../infra/aws/awsbridge.yaml");

// biome-ignore lint/suspicious/noExplicitAny: CloudFormation テンプレートは任意の形をとる
export type Json = any;

export function loadTemplate(): Json {
  return parse(readFileSync(TEMPLATE_PATH, "utf8"), { customTags: [] });
}

const NO_VALUE = Symbol("AWS::NoValue");

/** Fn::Sub / Fn::Join / Ref だけを擬似的に評価する（テスト用の小さな評価器）。 */
export function evaluate(node: Json, params: Record<string, string | string[]>): Json {
  if (Array.isArray(node))
    return node.map((n) => evaluate(n, params)).filter((n) => n !== NO_VALUE);
  if (node === null || typeof node !== "object") return node;
  const keys = Object.keys(node);
  if (keys.length === 1) {
    const key = keys[0] as string;
    const arg = node[key];
    if (key === "Ref") return arg === "AWS::NoValue" ? NO_VALUE : resolveRef(arg, params);
    if (key === "Fn::Join") {
      const [sep, list] = arg as [string, Json];
      const items = evaluate(list, params);
      return (Array.isArray(items) ? items : [items]).join(sep);
    }
    if (key === "Fn::Split") {
      const [sep, str] = arg as [string, Json];
      return (evaluate(str, params) as string).split(sep);
    }
    if (key === "Fn::If") {
      // 条件名は params に "true" / "false" で渡す
      const [cond, yes, no] = arg as [string, Json, Json];
      return evaluate(params[cond] === "true" ? yes : no, params);
    }
    if (key === "Fn::Sub") {
      const [template, vars] = Array.isArray(arg) ? arg : [arg, {}];
      const local: Record<string, string | string[]> = { ...params };
      for (const [k, v] of Object.entries(vars as Record<string, Json>))
        local[k] = evaluate(v, params);
      return (template as string).replace(/\$\{([^}]+)\}/g, (_, name: string) => {
        const v = resolveRef(name, local);
        return Array.isArray(v) ? v.join(",") : String(v);
      });
    }
  }
  return Object.fromEntries(
    keys.map((k) => [k, evaluate(node[k], params)]).filter(([, v]) => v !== NO_VALUE),
  );
}

function resolveRef(name: string, params: Record<string, string | string[]>): string | string[] {
  const v = params[name];
  if (v === undefined) throw new Error(`未解決の参照: ${name}`);
  return v;
}
