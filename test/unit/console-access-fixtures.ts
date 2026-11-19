// Access アプリの検査（src/console/access-inspect.ts）の試験の材料。値はすべてダミー（ドキュメント用のドメイン・桁だけ合わせた AUD）。

import type { AccessAppSnapshot } from "../../src/console/access-inspect";
import type { AccessSummary } from "../../src/console/generate";

export const STD_ORIGIN = "https://awsbridge-console.example.com";
/** P2 より前の Admin のホスト（今は使わない。取り違えの試験だけに使う）。 */
export const ADMIN_ORIGIN = "https://awsbridge-admin-console.example.com";

/** 試験用の AUD（16 進 64 桁。実在しない値）。 */
export const aud = (n: string): string => n.repeat(64).slice(0, 64);

export const AUDS = {
  entry: aud("a1"),
  dev: aud("c3"),
  legacy: aud("d4"),
  sec: aud("e5"),
};

/** R-P（パスで分ける）の正しい access.json。dev・legacy（手書き AUD）は Standard、sec は Admin。ホストは 1 つ（P2）。 */
export function accessSummary(over: Partial<AccessSummary> = {}): AccessSummary {
  return {
    schemaVersion: 2,
    generatedAt: "2026-01-01T00:00:00.000Z",
    routing: "path",
    origin: STD_ORIGIN,
    entryAud: AUDS.entry,
    teams: [
      { name: "dev", tier: "standard", groupObjectIds: ["g-dev"], aud: AUDS.dev },
      { name: "legacy", tier: "standard", manualAud: true, aud: AUDS.legacy },
      { name: "sec", tier: "admin", policyIds: ["p-sec"], aud: AUDS.sec },
    ],
    ...over,
  };
}

export function app(
  audValue: string,
  destination: string,
  over: Partial<AccessAppSnapshot> = {},
): AccessAppSnapshot {
  return {
    aud: audValue,
    type: "self_hosted",
    destinations: [destination],
    pathCookie: true,
    ...over,
  };
}

/** accessSummary() に合う、正しい Access アプリ（Cloudflare から読んだ形）。 */
export function goodApps(): AccessAppSnapshot[] {
  return [
    app(AUDS.entry, "awsbridge-console.example.com"),
    app(AUDS.dev, "awsbridge-console.example.com/t/dev"),
    app(AUDS.legacy, "awsbridge-console.example.com/t/legacy"),
    app(AUDS.sec, "awsbridge-console.example.com/t/sec"),
  ];
}
