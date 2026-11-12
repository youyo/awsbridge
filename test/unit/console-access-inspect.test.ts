// Access アプリの検査の判定（src/console/access-inspect.ts。純粋な関数）。
// 要件: R-P（routing: path）では、Standard も Admin も、入口のアプリとすべてのチームのアプリで Cookie Path（path_cookie_attribute）が
// 有効であること（無効・欠落は誤り）。R-H（routing: host）では警告に下げる。設計: docs/specs/console-login.md §5.4。
import { describe, expect, it } from "vitest";
import {
  type AccessFinding,
  formatAccessReport,
  inspectAccessApps,
} from "../../src/console/access-inspect";
import {
  ADMIN_ORIGIN,
  AUDS,
  accessSummary,
  app,
  aud,
  goodApps,
  STD_ORIGIN,
} from "./console-access-fixtures";

const run = (summary = accessSummary(), apps = goodApps()): AccessFinding[] =>
  inspectAccessApps({ summary, apps });
const errors = (f: AccessFinding[]) => f.filter((x) => x.severity === "error");
const codes = (f: AccessFinding[]) => f.map((x) => `${x.severity}:${x.code}:${x.subject}`);

/** 指定した AUD のアプリだけ差し替えた一覧。 */
const withApp = (audValue: string, patch: Partial<ReturnType<typeof app>>) =>
  goodApps().map((a) => (a.aud === audValue ? { ...a, ...patch } : a));

describe("inspectAccessApps（R-P）", () => {
  it("正しい形（入口 2 つ・Standard のチーム 2 つ（手書き AUD を含む）・Admin のチーム 1 つ）は、指摘が 0 件", () => {
    expect(run()).toEqual([]);
  });

  it("入口のアプリの並びや、関係のないアプリが混ざっていても、AUD で当てる", () => {
    const apps = [
      app(aud("f6"), "awsbridge-oidc-console.example.com/standard/.well-known/jwks.json"),
      ...goodApps().reverse(),
    ];
    expect(run(accessSummary(), apps)).toEqual([]);
  });

  describe("Cookie Path（path_cookie_attribute）", () => {
    it.each([
      ["Standard のチーム", AUDS.dev, "team:dev"],
      ["手書き AUD のチーム", AUDS.legacy, "team:legacy"],
      ["Admin のチーム", AUDS.sec, "team:sec"],
      ["Standard の入口", AUDS.entryStandard, "entry:standard"],
      ["Admin の入口", AUDS.entryAdmin, "entry:admin"],
    ])("%s のアプリで false なら誤り（path_cookie_disabled）", (_n, a, subject) => {
      const f = run(accessSummary(), withApp(a, { pathCookie: false }));
      expect(codes(f)).toEqual([`error:path_cookie_disabled:${subject}`]);
    });

    it("項目が無い（undefined）のも誤り", () => {
      const f = run(accessSummary(), withApp(AUDS.dev, { pathCookie: undefined }));
      expect(codes(f)).toEqual(["error:path_cookie_disabled:team:dev"]);
    });

    it("複数のアプリで無効なら、全件を出す", () => {
      const apps = goodApps().map((a) => ({ ...a, pathCookie: false }));
      const f = run(accessSummary(), apps);
      expect(
        errors(f)
          .map((x) => x.subject)
          .sort(),
      ).toEqual(["entry:admin", "entry:standard", "team:dev", "team:legacy", "team:sec"]);
    });
  });

  describe("アプリの有無・種類・対象", () => {
    it("AUD に当たるアプリが無ければ誤り（access_app_missing）。入口もチームも", () => {
      const apps = goodApps().filter((a) => a.aud !== AUDS.dev && a.aud !== AUDS.entryAdmin);
      expect(codes(run(accessSummary(), apps)).sort()).toEqual([
        "error:access_app_missing:entry:admin",
        "error:access_app_missing:team:dev",
      ]);
    });

    it("type が self_hosted でなければ誤り（access_app_type）", () => {
      const f = run(accessSummary(), withApp(AUDS.dev, { type: "saas" }));
      expect(codes(f)).toEqual(["error:access_app_type:team:dev"]);
    });

    it("チームの対象が <origin>/t/<team> でなければ誤り（access_app_destination_mismatch）", () => {
      const f = run(
        accessSummary(),
        withApp(AUDS.dev, { destinations: ["awsbridge-console.example.com/t/other"] }),
      );
      expect(codes(f)).toEqual(["error:access_app_destination_mismatch:team:dev"]);
    });

    it("Admin のチームが Standard のホストにあれば誤り（階層のホストを取り違えない）", () => {
      const f = run(
        accessSummary(),
        withApp(AUDS.sec, { destinations: ["awsbridge-console.example.com/t/sec"] }),
      );
      expect(codes(f)).toEqual(["error:access_app_destination_mismatch:team:sec"]);
    });

    it("対象が複数（余分な対象つき）なら誤り。入口がチームのパスを含んでも誤り", () => {
      const f = run(
        accessSummary(),
        withApp(AUDS.entryStandard, {
          destinations: ["awsbridge-console.example.com", "awsbridge-console.example.com/t/dev"],
        }),
      );
      expect(codes(f)).toEqual(["error:access_app_destination_mismatch:entry:standard"]);
    });

    it("入口の対象がホスト全体でなければ誤り", () => {
      const f = run(
        accessSummary(),
        withApp(AUDS.entryStandard, { destinations: ["awsbridge-console.example.com/portal"] }),
      );
      expect(codes(f)).toEqual(["error:access_app_destination_mismatch:entry:standard"]);
    });

    it("対象の表記の揺れ（スキーム・末尾の / と /*・ホストの大文字）は同じとみなす", () => {
      const apps = goodApps().map((a) => {
        if (a.aud === AUDS.dev)
          return { ...a, destinations: ["https://AwsBridge-Console.example.com/t/dev/*"] };
        if (a.aud === AUDS.entryStandard)
          return { ...a, destinations: ["awsbridge-console.example.com/"] };
        return a;
      });
      expect(run(accessSummary(), apps)).toEqual([]);
    });

    it("Cookie Path が無効で対象も違えば、両方を出す", () => {
      const f = run(
        accessSummary(),
        withApp(AUDS.dev, {
          pathCookie: false,
          destinations: ["awsbridge-console.example.com/t/x"],
        }),
      );
      expect(codes(f).sort()).toEqual([
        "error:access_app_destination_mismatch:team:dev",
        "error:path_cookie_disabled:team:dev",
      ]);
    });
  });

  describe("設定に無いアプリ（access_app_extra。警告）", () => {
    it("コンソールのホストの /t/ の下に、設定に無い AUD のアプリがあれば警告", () => {
      const apps = [...goodApps(), app(aud("f6"), "awsbridge-console.example.com/t/ghost")];
      expect(codes(run(accessSummary(), apps))).toEqual(["warning:access_app_extra:-"]);
    });

    it("Admin のホストの /t/ の下も見る", () => {
      const apps = [...goodApps(), app(aud("f6"), "awsbridge-admin-console.example.com/t/ghost")];
      expect(codes(run(accessSummary(), apps))).toEqual(["warning:access_app_extra:-"]);
    });

    it("コンソールのホストの外（issuer の文書・ほかのサービス）や /t/ の外は警告しない", () => {
      const apps = [
        ...goodApps(),
        app(aud("f6"), "awsbridge-oidc-console.example.com/standard/.well-known/jwks.json"),
        app(aud("a7"), "awsbridge-console.example.com/assets"),
        app(aud("b8"), "other.example.com/t/ghost"),
      ];
      expect(run(accessSummary(), apps)).toEqual([]);
    });

    it("警告には対象の場所を入れ、AUD を入れない", () => {
      const ghost = aud("f6");
      const apps = [...goodApps(), app(ghost, "awsbridge-console.example.com/t/ghost")];
      const f = run(accessSummary(), apps);
      expect(f[0]?.detail).toBe("awsbridge-console.example.com/t/ghost");
      expect(JSON.stringify(f)).not.toContain(ghost);
    });
  });

  describe("AUD が分からないもの", () => {
    it("チームの AUD が無ければ警告（検査できない）", () => {
      const s = accessSummary();
      s.teams = [{ name: "dev", tier: "standard", groupObjectIds: ["g-dev"] }, ...s.teams.slice(1)];
      expect(
        codes(
          run(
            s,
            goodApps().filter((a) => a.aud !== AUDS.dev),
          ),
        ),
      ).toEqual(["warning:access_aud_unset:team:dev"]);
    });

    it("入口の AUD が無ければ警告（Admin の入口の AUD は生成に要らない）", () => {
      const s = accessSummary({ entryAud: { standard: AUDS.entryStandard } });
      expect(
        codes(
          run(
            s,
            goodApps().filter((a) => a.aud !== AUDS.entryAdmin),
          ),
        ),
      ).toEqual(["warning:access_aud_unset:entry:admin"]);
    });

    it("Admin の階層が無い構成では、Admin の入口を検査対象にしない", () => {
      const s = accessSummary({
        origins: { standard: STD_ORIGIN },
        entryAud: { standard: AUDS.entryStandard },
        teams: accessSummary().teams.filter((t) => t.tier === "standard"),
      });
      const apps = goodApps().filter((a) => a.aud !== AUDS.entryAdmin && a.aud !== AUDS.sec);
      expect(run(s, apps)).toEqual([]);
    });
  });
});

describe("inspectAccessApps（R-H。ホストで分ける）", () => {
  const hostSummary = () => accessSummary({ routing: "host" });
  const hostApps = () => [
    app(AUDS.entryStandard, "awsbridge-console.example.com"),
    app(AUDS.entryAdmin, "awsbridge-admin-console.example.com"),
    app(AUDS.dev, "dev.awsbridge-console.example.com"),
    app(AUDS.legacy, "legacy.awsbridge-console.example.com"),
    app(AUDS.sec, "sec.awsbridge-admin-console.example.com"),
  ];

  it("正しい形（チームは <team>.<origin のホスト>）は、指摘が 0 件", () => {
    expect(run(hostSummary(), hostApps())).toEqual([]);
  });

  it("Cookie Path が無効でも、警告に下げる（誤りにしない）。入口も同じ", () => {
    const apps = hostApps().map((a) => ({ ...a, pathCookie: false }));
    const f = run(hostSummary(), apps);
    expect(errors(f)).toEqual([]);
    expect(f.map((x) => `${x.severity}:${x.code}`)).toEqual(
      Array(5).fill("warning:path_cookie_disabled"),
    );
  });

  it("対象が R-P の形（/t/<team>）のままなら誤り", () => {
    const apps = hostApps().map((a) =>
      a.aud === AUDS.dev ? { ...a, destinations: ["awsbridge-console.example.com/t/dev"] } : a,
    );
    expect(codes(run(hostSummary(), apps))).toEqual([
      "error:access_app_destination_mismatch:team:dev",
    ]);
  });

  it("コンソールのホストのサブドメインに、設定に無いアプリがあれば警告", () => {
    const apps = [...hostApps(), app(aud("f6"), "ghost.awsbridge-console.example.com")];
    expect(codes(run(hostSummary(), apps))).toEqual(["warning:access_app_extra:-"]);
  });
});

describe("formatAccessReport", () => {
  it("誤り → 警告の順に 1 行ずつ出し、最後に件数。AUD は出さない", () => {
    const apps = withApp(AUDS.dev, { pathCookie: false }).concat(
      app(aud("f6"), "awsbridge-console.example.com/t/ghost"),
    );
    const text = formatAccessReport(run(accessSummary(), apps));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^ERROR\s+path_cookie_disabled\s+team:dev/);
    expect(lines[1]).toMatch(/^WARN\s+access_app_extra/);
    expect(lines.at(-1)).toBe("errors: 1, warnings: 1");
    for (const v of Object.values(AUDS)) expect(text).not.toContain(v);
  });

  it("指摘が無ければ件数の行だけ", () => {
    expect(formatAccessReport([])).toBe("errors: 0, warnings: 0");
  });

  it("detail に email があれば伏せる", () => {
    const text = formatAccessReport([
      { severity: "warning", code: "access_app_extra", subject: "-", detail: "a/t/me@example.com" },
    ]);
    expect(text).not.toContain("me@example.com");
    expect(text).toContain("<email>");
  });
});

describe("定数", () => {
  it("試験の材料のホストは、ドキュメント用のドメイン", () => {
    expect(STD_ORIGIN).toContain("example.com");
    expect(ADMIN_ORIGIN).toContain("example.com");
  });
});
