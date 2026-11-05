// 複数 AWS アカウントの切り替え（aws_profile）。設計: docs/specs/architecture.md「マルチアカウント（aws_profile）」。
// 設定は環境変数 AWS_PROFILES（オブジェクトまたは JSON 文字列）。ここは副作用のない純粋関数だけを置く。

export type ProfileEntry = { roleArn: string; description?: string };

export type ProfilesConfig = {
  default: string;
  profiles: Record<string, ProfileEntry>;
  /** aws_profile の対象ツール。省略時は全ツール。 */
  tools?: string[];
};

export type ProfilesConfigErrorKind =
  | "missing"
  | "json"
  | "shape"
  | "profiles_empty"
  | "profile_name"
  | "role_arn"
  | "tools"
  | "default";

/** 設定不正。メッセージは種別のみで、設定値は含めない（ログに出してよい）。 */
export class ProfilesConfigError extends Error {
  readonly kind: ProfilesConfigErrorKind;
  constructor(kind: ProfilesConfigErrorKind) {
    super(`invalid AWS_PROFILES: ${kind}`);
    this.name = "ProfilesConfigError";
    this.kind = kind;
  }
}

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/; // RoleSessionName（64 文字）に -<name> を収めるため 32 文字まで
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,128}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.hasOwn(o, k);

function validate(raw: unknown): ProfilesConfig {
  if (!isObj(raw) || !isObj(raw.profiles)) throw new ProfilesConfigError("shape");
  const names = Object.keys(raw.profiles);
  if (names.length === 0) throw new ProfilesConfigError("profiles_empty");
  const profiles: Record<string, ProfileEntry> = Object.create(null);
  for (const name of names) {
    if (!NAME_RE.test(name)) throw new ProfilesConfigError("profile_name");
    const e = (raw.profiles as Record<string, unknown>)[name];
    if (!isObj(e)) throw new ProfilesConfigError("shape");
    if (typeof e.roleArn !== "string" || !ROLE_ARN_RE.test(e.roleArn))
      throw new ProfilesConfigError("role_arn");
    if (e.description !== undefined && typeof e.description !== "string")
      throw new ProfilesConfigError("shape");
    profiles[name] = {
      roleArn: e.roleArn,
      ...(e.description !== undefined ? { description: e.description } : {}),
    };
  }
  let tools: string[] | undefined;
  if (raw.tools !== undefined) {
    if (
      !Array.isArray(raw.tools) ||
      raw.tools.length === 0 ||
      !raw.tools.every((t) => typeof t === "string" && t !== "")
    )
      throw new ProfilesConfigError("tools");
    tools = [...(raw.tools as string[])];
  }
  if (typeof raw.default !== "string" || !has(profiles, raw.default))
    throw new ProfilesConfigError("default");
  return { default: raw.default, profiles, ...(tools ? { tools } : {}) };
}

// isolate 内キャッシュ（オブジェクトは同一参照、文字列は直近の 1 件）
const objCache = new WeakMap<object, ProfilesConfig>();
let strCache: { raw: string; config: ProfilesConfig } | undefined;

/** AWS_PROFILES（wrangler vars のオブジェクト、または secret の JSON 文字列）を検証して返す。不正・未設定は ProfilesConfigError。 */
export function parseProfilesConfig(raw: unknown): ProfilesConfig {
  if (raw === undefined || raw === "") throw new ProfilesConfigError("missing");
  if (typeof raw === "string") {
    if (strCache?.raw === raw) return strCache.config;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProfilesConfigError("json");
    }
    const config = validate(parsed);
    strCache = { raw, config };
    return config;
  }
  if (isObj(raw)) {
    const hit = objCache.get(raw);
    if (hit) return hit;
    const config = validate(raw);
    objCache.set(raw, config);
    return config;
  }
  throw new ProfilesConfigError("shape");
}

export type Selection =
  | { kind: "profile"; name: string; roleArn: string }
  | { kind: "error"; code: "unknown_aws_profile" | "invalid_aws_profile" | "batch_not_supported" };

const err = (code: Extract<Selection, { kind: "error" }>["code"]): Selection => ({
  kind: "error",
  code,
});

type ToolsCall = { params: Record<string, unknown>; name: string | undefined };

/** tools/call なら params を返す。name が文字列でなければ undefined（対象外ツール扱い、aws_profile は取り除く）。 */
function toolsCall(rpc: unknown): ToolsCall | undefined {
  if (!isObj(rpc) || rpc.method !== "tools/call" || !isObj(rpc.params)) return undefined;
  const name = rpc.params.name;
  return { params: rpc.params, name: typeof name === "string" ? name : undefined };
}

const isTargetTool = (config: ProfilesConfig, name: string | undefined) =>
  name !== undefined && (config.tools === undefined || config.tools.includes(name));

type Pick = { name: string } | { error: Extract<Selection, { kind: "error" }>["code"] };

/** 1 件の tools/call について aws_profile を読み、arguments から取り除く。 */
function pickAndStrip(config: ProfilesConfig, call: ToolsCall): Pick {
  const args = call.params.arguments;
  const present = isObj(args) && has(args, "aws_profile");
  const value = present ? (args as Record<string, unknown>).aws_profile : undefined;
  if (present) delete (args as Record<string, unknown>).aws_profile;
  if (!isTargetTool(config, call.name) || !present) return { name: config.default };
  if (typeof value !== "string") return { error: "invalid_aws_profile" };
  if (!has(config.profiles, value)) return { error: "unknown_aws_profile" };
  return { name: value };
}

/**
 * リクエスト本文（パース済み JSON-RPC）から使うプロファイルを決める。
 * 副作用: tools/call の arguments から aws_profile を取り除く（上流へ送らないため）。
 */
export function selectProfile(config: ProfilesConfig, rpc: unknown): Selection {
  const calls = (Array.isArray(rpc) ? rpc : [rpc]).map(toolsCall);
  const names = new Set<string>();
  for (const call of calls) {
    if (!call) continue;
    const pick = pickAndStrip(config, call);
    if ("error" in pick) return err(pick.error);
    if (isTargetTool(config, call.name)) names.add(pick.name);
  }
  if (names.size > 1) return err("batch_not_supported");
  const name = names.size === 1 ? ([...names][0] as string) : config.default;
  return { kind: "profile", name, roleArn: (config.profiles[name] as ProfileEntry).roleArn };
}
