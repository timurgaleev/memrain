/**
 * `search stats` and the shadow rollup: a read that fails must say so, not
 * print the same "no shadow data" as a flag that has not been seen yet.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { runSearchStats } from "../src/commands/search-stats.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-stats-shadow-"));
const dbPath = join(tmp, "brain.pglite");
const configPath = join(tmp, "config.json");
writeFileSync(configPath, JSON.stringify({
  database: { type: "pglite", path: dbPath },
  embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
  storage: {},
}));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function stats(json: boolean): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const code = await runSearchStats({ json, configPath });
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("search stats with an unreadable shadow rollup", () => {
  it("reports the failure instead of an empty rollup", async () => {
    const s = new Storage({ dbPath });
    await s.init();
    try {
      await s.engine().query(`DROP TABLE search_telemetry_shadow`);
    } finally {
      await s.close();
    }
    const j = await stats(true);
    expect(j.code).toBe(0);
    const body = JSON.parse(j.out) as { shadow: unknown[]; shadow_error?: string };
    expect(body.shadow).toEqual([]);
    expect(body.shadow_error).toContain("search_telemetry_shadow");
    expect((await stats(false)).out).toContain("Shadow ranking: could not read");
  });
});
