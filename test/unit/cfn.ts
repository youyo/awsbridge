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
    if (key === "Fn::Select") {
      const [index, list] = arg as [Json, Json];
      const items = evaluate(list, params) as Json[];
      const i = Number(evaluate(index, params));
      if (!Array.isArray(items) || i < 0 || i >= items.length)
        throw new Error(`Fn::Select の範囲外: ${i}`);
      return items[i];
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

/** Conditions の式（Fn::Equals / Fn::Not / Fn::And / Fn::Or / Condition）を、パラメーターで評価する。 */
export function evalCondition(tpl: Json, expr: Json, params: Record<string, string>): boolean {
  const [key] = Object.keys(expr);
  const arg = expr[key as string];
  if (key === "Condition") return evalCondition(tpl, tpl.Conditions[arg], params);
  if (key === "Fn::Equals") {
    const [a, b] = (arg as Json[]).map((v) => evaluate(v, params));
    return a === b;
  }
  if (key === "Fn::Not") return !evalCondition(tpl, arg[0], params);
  if (key === "Fn::And") return (arg as Json[]).every((e) => evalCondition(tpl, e, params));
  if (key === "Fn::Or") return (arg as Json[]).some((e) => evalCondition(tpl, e, params));
  throw new Error(`未対応の条件: ${key}`);
}

/** テンプレートのすべての Conditions を評価した値（"true" / "false"）。evaluate の Fn::If に渡す。 */
export function conditionValues(tpl: Json, params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tpl.Conditions ?? {}).map(([k, v]) => [
      k,
      String(evalCondition(tpl, v, params)),
    ]),
  );
}
