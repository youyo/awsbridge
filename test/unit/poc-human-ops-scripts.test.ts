import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// PoC P2〜P4 の道具（checks / stop-watch / revoke / trail / console-url の追加オプション / destroy の片付け）。
// 実 AWS は呼ばない: aws は引数と一部の環境変数を記録し、決まった応答を返すダミーに差し替える。
// ネットワークに出る処理（STS・Federation）の手前のガードだけを確かめる。

const root = new URL("../../", import.meta.url).pathname;
const toml = readFileSync(join(root, "mise.toml"), "utf8");
const tsx = join(root, "node_modules/.bin/tsx");

function section(name: string): string {
  const start = toml.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = toml.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const ACCOUNT = "123456789012";
const HOST = "awsbridge-human-poc.example.workers.dev";
const OUTPUTS = [
  { OutputKey: "RoleArn", OutputValue: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPoc` },
  {
    OutputKey: "TaggedRoleArn",
    OutputValue: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPocTagged`,
  },
  { OutputKey: "NoTagRoleArn", OutputValue: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPocNoTag` },
  { OutputKey: "OidcProviderArn", OutputValue: `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}` },
];

interface Fake {
  outputs?: unknown;
  lookup?: unknown;
}

// aws のダミー（並列に呼ばれる）。呼ばれるたびに "aws <引数をタブ区切り> PROFILE=.. KEY=.." を log に追記する。
// describe-stacks / lookup-events には用意した JSON を返す。list-buckets は AWS_PROFILE=denied のとき AccessDenied で失敗する。
function fakeAws(fake: Fake): { dir: string; log: string } {
  const dir = tmp("awsbridge-human-ops-fakebin-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "outputs.json"), JSON.stringify(fake.outputs ?? OUTPUTS));
  writeFileSync(join(dir, "lookup.json"), JSON.stringify(fake.lookup ?? { Events: [] }));
  const f = join(dir, "aws");
  writeFileSync(
    f,
    `#!/bin/bash
# 並列に呼ばれても行が混ざらないよう、1 行を組み立ててから 1 回で追記する
line='aws'; for a in "$@"; do line+=$'\\t'"$a"; done
line+=$'\\t'"PROFILE=\${AWS_PROFILE-UNSET}"$'\\t'"KEY=\${AWS_ACCESS_KEY_ID-UNSET}"$'\\t'"REGION=\${AWS_REGION-UNSET}"
printf '%s\\n' "$line" >> "${log}"
case "$*" in
  *describe-stacks*) cat "${dir}/outputs.json" ;;
  *lookup-events*) cat "${dir}/lookup.json" ;;
  *list-buckets*)
    if [ "\${AWS_PROFILE-}" = "slow" ]; then sleep 5; fi
    if [ "\${AWS_PROFILE-}" = "weird" ]; then
      echo "Error when retrieving credentials from login: token for user@example.com expired" >&2
      exit 255
    fi
    if [ "\${AWS_PROFILE-}" = "denied" ]; then
      echo "An error occurred (AccessDenied) when calling the ListBuckets operation: denied" >&2
      exit 254
    fi
    echo 3 ;;
esac
exit 0
`,
  );
  chmodSync(f, 0o755);
  return { dir, log };
}

function runTs(script: string, args: string[], env: Record<string, string>, fake: Fake = {}) {
  const { dir, log } = fakeAws(fake);
  const r = spawnSync(tsx, [join(root, script), ...args], {
    cwd: root,
    env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
    : [];
  return { ...r, calls };
}

const argOf = (c: string[], name: string) => c[c.indexOf(name) + 1];

describe("mise タスク（P2〜P4）", () => {
  const tasks: Record<string, string> = {
    "poc:human:checks": "scripts/poc/human/checks.ts",
    "poc:human:stop-watch": "scripts/poc/human/stop-watch.ts",
    "poc:human:revoke": "scripts/poc/human/revoke.ts revoke",
    "poc:human:unrevoke": "scripts/poc/human/revoke.ts unrevoke",
    "poc:human:delete-provider": "scripts/poc/human/revoke.ts delete-provider",
    "poc:human:recreate-provider": "scripts/poc/human/revoke.ts recreate-provider",
    "poc:human:trail": "scripts/poc/human/trail.ts",
  };
  for (const [name, script] of Object.entries(tasks)) {
    it(`${name} は ${script} を呼ぶ`, () => {
      const s = section(`tasks."${name}"`);
      expect(s, name).toContain(script);
      expect(s).toMatch(/^description\s*=/m);
    });
  }
});

describe("revoke.ts", () => {
  it("revoke: Tagged ロールに AWSRevokeOlderSessions（aws:TokenIssueTime の Deny）を付け、UTC の時刻を出す", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["revoke"], {});
    expect(r.status, r.stderr).toBe(0);
    const put = r.calls.find((c) => c[2] === "put-role-policy");
    expect(put).toBeDefined();
    const c = put as string[];
    expect(argOf(c, "--role-name")).toBe("AwsbridgeHumanPocTagged");
    expect(argOf(c, "--policy-name")).toBe("AWSRevokeOlderSessions");
    const doc = JSON.parse(argOf(c, "--policy-document") as string);
    expect(doc.Statement[0].Effect).toBe("Deny");
    expect(doc.Statement[0].Condition.DateLessThan["aws:TokenIssueTime"]).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
    );
    expect(c).toContain("PROFILE=awsbridge");
    expect(r.stdout).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/);
    const ds = r.calls.find((x) => x[2] === "describe-stacks") as string[];
    expect(argOf(ds, "--stack-name")).toBe("awsbridge-human-poc");
  });
  it("revoke --role base で既存ロールにも付けられる", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["revoke", "--role", "base"], {});
    expect(r.status, r.stderr).toBe(0);
    const put = r.calls.find((c) => c[2] === "put-role-policy") as string[];
    expect(argOf(put, "--role-name")).toBe("AwsbridgeHumanPoc");
  });
  it("unrevoke: インラインポリシーを外す", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["unrevoke"], {});
    expect(r.status, r.stderr).toBe(0);
    const del = r.calls.find((c) => c[2] === "delete-role-policy") as string[];
    expect(argOf(del, "--role-name")).toBe("AwsbridgeHumanPocTagged");
    expect(argOf(del, "--policy-name")).toBe("AWSRevokeOlderSessions");
  });
  it("Output のロールが PoC 用（AwsbridgeHumanPoc*）でなければ何も変えない", () => {
    const r = runTs(
      "scripts/poc/human/revoke.ts",
      ["revoke"],
      {},
      {
        outputs: [
          {
            OutputKey: "TaggedRoleArn",
            OutputValue: `arn:aws:iam::${ACCOUNT}:role/FederatedMcpDebug`,
          },
        ],
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c[2] === "put-role-policy")).toBe(false);
  });
  it("PoC 用でないスタック名は拒否し、aws を呼ばない", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["revoke"], {
      AWSBRIDGE_HUMAN_POC_STACK_NAME: "awsbridge",
    });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
  it("不明なサブコマンド・ロールは拒否し、aws を呼ばない", () => {
    for (const args of [["nope"], [], ["revoke", "--role", "admin"]]) {
      const r = runTs("scripts/poc/human/revoke.ts", args, {});
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.calls).toEqual([]);
    }
  });
  it("delete-provider: Output の OIDC プロバイダーが PoC の issuer と一致するときだけ消す", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["delete-provider"], {
      AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}`,
    });
    expect(r.status, r.stderr).toBe(0);
    const del = r.calls.find((c) => c[2] === "delete-open-id-connect-provider") as string[];
    expect(argOf(del, "--open-id-connect-provider-arn")).toBe(
      `arn:aws:iam::${ACCOUNT}:oidc-provider/${HOST}`,
    );
    expect(r.stdout).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/);
  });
  it("delete-provider: issuer が一致しない・未設定なら消さない", () => {
    for (const env of [
      { AWSBRIDGE_HUMAN_POC_ISSUER: "https://awsbridge-human-poc.other.workers.dev" },
      {} as Record<string, string>,
    ]) {
      const r = runTs("scripts/poc/human/revoke.ts", ["delete-provider"], env);
      expect(r.status).not.toBe(0);
      expect(r.calls.some((c) => c[2] === "delete-open-id-connect-provider")).toBe(false);
    }
  });
  it("recreate-provider: 同じ URL・client ID・タグで作り直す（ARN が同じになりロールの信頼ポリシーがそのまま使える）", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["recreate-provider"], {
      AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}/`,
    });
    expect(r.status, r.stderr).toBe(0);
    const c = r.calls.find((x) => x[2] === "create-open-id-connect-provider") as string[];
    expect(argOf(c, "--url")).toBe(`https://${HOST}`);
    expect(argOf(c, "--client-id-list")).toBe("awsbridge-human-poc");
    expect(argOf(c, "--tags")).toBe("Key=project,Value=awsbridge-human-poc");
  });
  it("recreate-provider: PoC 用でない issuer は拒否する", () => {
    const r = runTs("scripts/poc/human/revoke.ts", ["recreate-provider"], {
      AWSBRIDGE_HUMAN_POC_ISSUER: "https://awsbridge.example.workers.dev",
    });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c[2] === "create-open-id-connect-provider")).toBe(false);
  });
});

describe("stop-watch.ts", () => {
  function credsFile(dir: string): string {
    const f = join(dir, "credentials-tagged.json");
    writeFileSync(
      f,
      JSON.stringify({
        AccessKeyId: "ASIAFAKEKEYEXAMPLE",
        SecretAccessKey: "fake-secret-value",
        SessionToken: "fake-session-token",
      }),
    );
    return f;
  }
  it("認証情報ファイルとプロファイルを並べて s3:ListBuckets で見張り、記録と要約を出す（秘密は出さない）", () => {
    const out = tmp("awsbridge-human-watch-");
    const f = credsFile(out);
    const r = runTs(
      "scripts/poc/human/stop-watch.ts",
      ["--credentials", f, "--profile", "denied", "--count", "2", "--interval", "0"],
      { AWSBRIDGE_HUMAN_POC_OUT_DIR: out, AWS_PROFILE: "awsbridge" },
    );
    expect(r.status, r.stderr).toBe(0);
    const lb = r.calls.filter((c) => c.includes("list-buckets"));
    expect(lb).toHaveLength(4);
    const byFile = lb.filter((c) => c.includes("KEY=ASIAFAKEKEYEXAMPLE"));
    expect(byFile).toHaveLength(2);
    for (const c of byFile) expect(c).toContain("PROFILE=UNSET");
    const byProfile = lb.filter((c) => c.includes("PROFILE=denied"));
    expect(byProfile).toHaveLength(2);
    for (const c of byProfile) expect(c).toContain("KEY=UNSET");
    for (const c of lb) expect(c.join(" ")).not.toMatch(/fake-secret-value|fake-session-token/);
    expect(r.stdout).toContain("file:credentials-tagged.json");
    expect(r.stdout).toContain("profile:denied");
    expect(r.stdout).toContain("AccessDenied");
    expect(r.stdout).not.toMatch(/fake-secret-value|fake-session-token|ASIAFAKEKEYEXAMPLE/);
    const logs = readdirSync(out).filter((n) => /^stop-watch-.*\.jsonl$/.test(n));
    expect(logs).toHaveLength(1);
    const lines = readFileSync(join(out, logs[0] as string), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(4);
    const rec = lines.map((l) => JSON.parse(l));
    expect(rec.filter((x) => x.target === "profile:denied").every((x) => x.ok === false)).toBe(
      true,
    );
    expect(rec.filter((x) => x.target === "file:credentials-tagged.json").every((x) => x.ok)).toBe(
      true,
    );
    expect(readFileSync(join(out, logs[0] as string), "utf8")).not.toMatch(
      /fake-secret-value|ASIAFAKEKEYEXAMPLE/,
    );
  });
  it("失敗の要約（伏せ字）を記録し、時間切れは Timeout として記録する", () => {
    const out = tmp("awsbridge-human-watch-");
    const r = runTs(
      "scripts/poc/human/stop-watch.ts",
      [
        "--profile",
        "weird",
        "--profile",
        "slow",
        "--count",
        "1",
        "--interval",
        "0",
        "--timeout",
        "1",
      ],
      { AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
    );
    expect(r.status, r.stderr).toBe(0);
    const log = readdirSync(out).find((n) => n.endsWith(".jsonl")) as string;
    const rec = readFileSync(join(out, log), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const weird = rec.find((x) => x.target === "profile:weird");
    expect(weird.code).toBe("Unknown");
    expect(weird.detail).toContain("Error when retrieving credentials from login");
    expect(weird.detail).not.toContain("user@example.com");
    expect(rec.find((x) => x.target === "profile:slow").code).toBe("Timeout");
  });
  it("--summarize: 記録を読み直して --since から最初の失敗までの秒数を出す（aws は呼ばない）", () => {
    const out = tmp("awsbridge-human-watch-");
    const f = join(out, "stop-watch-x.jsonl");
    writeFileSync(
      f,
      [
        { at: "2026-11-11T00:00:00Z", target: "profile:p", ok: false, code: "Timeout" },
        { at: "2026-11-11T00:00:05Z", target: "profile:p", ok: true },
        { at: "2026-11-11T00:00:40Z", target: "profile:p", ok: false, code: "AccessDenied" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const r = runTs(
      "scripts/poc/human/stop-watch.ts",
      ["--summarize", f, "--since", "2026-11-11T00:00:10Z"],
      { AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([]);
    const row = r.stdout.split("\n").find((l) => l.includes("profile:p")) as string;
    expect(row).toContain("2026-11-11T00:00:40Z");
    expect(row).toContain("AccessDenied");
    expect(row).toContain("| 30 |");
    expect(readdirSync(out).filter((n) => n.endsWith(".jsonl"))).toEqual(["stop-watch-x.jsonl"]);
  });
  it("--since（revoke の時刻）を受け取る。不正な値は拒否", () => {
    const out = tmp("awsbridge-human-watch-");
    const ok = runTs(
      "scripts/poc/human/stop-watch.ts",
      ["--profile", "p", "--count", "1", "--interval", "0", "--since", "2026-11-11T00:00:00Z"],
      { AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
    );
    expect(ok.status, ok.stderr).toBe(0);
    const bad = runTs(
      "scripts/poc/human/stop-watch.ts",
      ["--profile", "p", "--count", "1", "--interval", "0", "--since", "yesterday"],
      { AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
    );
    expect(bad.status).not.toBe(0);
  });
  it("対象が無い・ファイルが読めないときは終了コード 1 で aws を呼ばない", () => {
    const out = tmp("awsbridge-human-watch-");
    for (const args of [[], ["--credentials", join(out, "missing.json")]]) {
      const r = runTs("scripts/poc/human/stop-watch.ts", [...args, "--count", "1"], {
        AWSBRIDGE_HUMAN_POC_OUT_DIR: out,
      });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });
});

describe("trail.ts", () => {
  const assume = {
    eventTime: "2026-11-11T01:00:00Z",
    eventName: "AssumeRoleWithWebIdentity",
    awsRegion: "ap-northeast-1",
    requestParameters: {
      roleArn: `arn:aws:iam::${ACCOUNT}:role/AwsbridgeHumanPocTagged`,
      roleSessionName: "human-user@example.com",
      sourceIdentity: "user@example.com",
      principalTags: { access_profile: "poc-admin" },
    },
    responseElements: {
      credentials: { accessKeyId: "ASIA_TEST_KEY_EXAMPLE" },
      sourceIdentity: "user@example.com",
    },
  };
  const api = {
    eventTime: "2026-11-11T01:00:05Z",
    eventName: "ListBuckets",
    eventSource: "s3.amazonaws.com",
    awsRegion: "us-east-1",
    userIdentity: {
      arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AwsbridgeHumanPocTagged/human-user@example.com`,
      accessKeyId: "ASIA_TEST_KEY_EXAMPLE",
      sessionContext: { sourceIdentity: "user@example.com" },
    },
  };
  const lookup = {
    Events: [assume, api].map((e) => ({ CloudTrailEvent: JSON.stringify(e) })),
  };
  it("リージョンごとに AssumeRoleWithWebIdentity を引き、そのアクセスキーの API イベントを追う。email・アカウント ID は伏せる", () => {
    const r = runTs("scripts/poc/human/trail.ts", ["--minutes", "30"], {}, { lookup });
    expect(r.status, r.stderr).toBe(0);
    const byName = r.calls.filter(
      (c) =>
        c[2] === "lookup-events" &&
        c.includes("AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity"),
    );
    expect(byName.map((c) => argOf(c, "--region")).sort()).toEqual(["ap-northeast-1", "us-east-1"]);
    for (const c of byName) expect(c).toContain("PROFILE=awsbridge");
    const byKey = r.calls.filter(
      (c) =>
        c[2] === "lookup-events" &&
        c.includes("AttributeKey=AccessKeyId,AttributeValue=ASIA_TEST_KEY_EXAMPLE"),
    );
    expect(byKey.length).toBeGreaterThan(0);
    expect(r.stdout).toContain("AssumeRoleWithWebIdentity");
    expect(r.stdout).toContain("ListBuckets");
    expect(r.stdout).toContain("access_profile=poc-admin");
    expect(r.stdout).toContain("u***@***.com");
    expect(r.stdout).not.toContain("user@example.com");
    expect(r.stdout).not.toContain(ACCOUNT);
  });
  it("セッション名（Username）でも引き、コンソール・aws login の別のアクセスキーの API イベントも出す", () => {
    const r = runTs("scripts/poc/human/trail.ts", [], {}, { lookup });
    expect(r.status, r.stderr).toBe(0);
    const byUser = r.calls.filter(
      (c) =>
        c[2] === "lookup-events" &&
        c.includes("AttributeKey=Username,AttributeValue=human-user@example.com"),
    );
    expect(byUser.map((c) => argOf(c, "--region")).sort()).toEqual(["ap-northeast-1", "us-east-1"]);
    expect(r.stdout).toContain("セッション名");
  });
  it("--follow 0 なら API イベントを追わない", () => {
    const r = runTs("scripts/poc/human/trail.ts", ["--follow", "0"], {}, { lookup });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.join(" ").includes("AttributeKey=Username"))).toBe(false);
    expect(r.calls.some((c) => c.join(" ").includes("AttributeKey=AccessKeyId"))).toBe(false);
  });
  it("--regions で引くリージョンを変えられる。不正な値は拒否", () => {
    const r = runTs("scripts/poc/human/trail.ts", ["--regions", "us-west-2"], {}, { lookup });
    expect(r.status, r.stderr).toBe(0);
    const regions = new Set(
      r.calls.filter((c) => c[2] === "lookup-events").map((c) => argOf(c, "--region")),
    );
    expect([...regions]).toEqual(["us-west-2"]);
    const bad = runTs("scripts/poc/human/trail.ts", ["--regions", "nowhere"], {});
    expect(bad.status).not.toBe(0);
    expect(bad.calls).toEqual([]);
  });
});

describe("checks.ts / console-url.ts のガード（ネットワークに出る前に止まる）", () => {
  it("checks: AWSBRIDGE_HUMAN_POC_ISSUER / SUBJECT が無ければ終了コード 1 で aws を呼ばない", () => {
    for (const env of [
      { AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com" },
      { AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}` },
    ]) {
      const r = runTs("scripts/poc/human/checks.ts", [], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("mise.local.toml");
      expect(r.calls).toEqual([]);
    }
  });
  it("checks: 不明なケース ID（--only）は拒否する", () => {
    const r = runTs("scripts/poc/human/checks.ts", ["--only", "1,99"], {
      AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}`,
      AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com",
    });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
  const full = {
    AWSBRIDGE_HUMAN_POC_ISSUER: `https://${HOST}`,
    AWSBRIDGE_HUMAN_POC_SUBJECT: "user@example.com",
  };
  for (const args of [
    ["--role", "admin"],
    ["--tag-format", "xml"],
    ["--role", "tagged", "--access-profile", "bad value!"],
  ]) {
    it(`console-url: ${args.join(" ")} は拒否し、aws を呼ばない`, () => {
      const r = runTs("scripts/poc/human/console-url.ts", args, full);
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
    });
  }
});

describe("destroy.sh（P2〜P4 のファイルも消す）", () => {
  it("ロールごとの認証情報・ログイン URL を消し、署名鍵と見張りの記録は残す", () => {
    const out = tmp("awsbridge-human-out-");
    mkdirSync(out, { recursive: true });
    const files = [
      "credentials.json",
      "credentials-tagged.json",
      "credentials-notag.json",
      "console-url-tagged-dur-default-sd-43200.txt",
      "signing-key.json",
      "stop-watch-20261111T000000Z.jsonl",
    ];
    for (const f of files) writeFileSync(join(out, f), "x");
    const bin = tmp("awsbridge-human-fakebin-");
    for (const cmd of ["aws", "pnpm"]) {
      writeFileSync(join(bin, cmd), "#!/bin/bash\nexit 0\n");
      chmodSync(join(bin, cmd), 0o755);
    }
    const r = spawnSync("bash", [join(root, "scripts/poc/human/destroy.sh")], {
      env: { PATH: `${bin}:/usr/bin:/bin`, AWSBRIDGE_HUMAN_POC_OUT_DIR: out },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    for (const f of files.slice(0, 4)) expect(existsSync(join(out, f)), f).toBe(false);
    expect(existsSync(join(out, "signing-key.json"))).toBe(true);
    expect(existsSync(join(out, "stop-watch-20261111T000000Z.jsonl"))).toBe(true);
  });
});
