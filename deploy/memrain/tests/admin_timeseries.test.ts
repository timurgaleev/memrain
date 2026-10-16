/**
 * adminTimeseries — the Overview chart rollup, called directly with an
 * injected clock. Offline (PGLite).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { adminTimeseries } from "../src/core/admin-timeseries.ts";
import { graphHubs } from "../src/core/links.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-admints-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("adminTimeseries", () => {
  it("buckets on the UTC day boundary of the injected clock", async () => {
    const e = storage.engine();
    const at = (iso: string) =>
      e.query(
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at)
         VALUES ('t', 'a', 'search', 'success', $1::timestamptz)`,
        [iso],
      );
    await at("2026-02-28T23:50:00Z");
    await at("2026-03-01T00:10:00Z");
    const ts = await adminTimeseries(e, { days: 7, now: new Date("2026-03-01T00:30:00Z") });
    expect(ts.buckets).toEqual([
      "2026-02-23", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01",
    ]);
    expect(ts.generated_at).toBe("2026-03-01T00:30:00.000Z");
    expect(ts.requests.find((r) => r.day === "2026-02-28")?.requests).toBe(1);
    expect(ts.requests.find((r) => r.day === "2026-03-01")?.requests).toBe(1);
  });

  it("throws on a days value outside the allowed set", async () => {
    for (const days of [0, 8, 14, 7.5, 365]) {
      await expect(adminTimeseries(storage.engine(), { days: days as 7 })).rejects.toThrow(/days must be 7, 30 or 90/);
    }
  });

  it("stays inside the performance budget on a seeded brain", async () => {
    const e = storage.engine();
    const spread = "now() - (random() * 180 || ' days')::interval";
    await e.query(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at)
       SELECT 'pat-' || (g % 9), 'pat', (ARRAY['search','query','page_get','page_put'])[1 + g % 4],
              CASE WHEN g % 17 = 0 THEN 'error' ELSE 'success' END, ${spread}
         FROM generate_series(1, 20000) g`,
    );
    await e.query(
      `INSERT INTO pages (slug, type, title, markdown_body, content_hash)
       SELECT 'notes/p' || g, 'note', 'P' || g, '', 'h' || g FROM generate_series(1, 2000) g`,
    );
    await e.query(
      `INSERT INTO page_versions (slug, version_n, hash_new, body_snapshot, compiled_truth_snapshot, written_at)
       SELECT 'notes/p' || (1 + g % 2000), 1 + g / 2000, 'h', 'b', '{}'::jsonb, ${spread}
         FROM generate_series(0, 49999) g`,
    );
    await e.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_at)
       SELECT 'people/e' || (g % 300), 'fact ' || g, ${spread} FROM generate_series(1, 20000) g`,
    );
    await e.query(
      `INSERT INTO links (source_slug, target_slug, type)
       SELECT 'notes/p' || (1 + g % 2000), 'notes/p' || (1 + (g * 7 + g / 2000) % 2000), 'mentions'
         FROM generate_series(1, 5000) g
       ON CONFLICT DO NOTHING`,
    );
    await e.query(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, outcome, created_at)
       SELECT 'c', 'think', g % 50, 'm' || (g % 7), 'ok', ${spread} FROM generate_series(1, 5000) g`,
    );

    let t = performance.now();
    const ts = await adminTimeseries(e, { days: 90 });
    const tsMs = performance.now() - t;
    t = performance.now();
    const hubs = await graphHubs(e, { limit: 20 });
    const hubsMs = performance.now() - t;
    console.log(`[perf] timeseries days=90 ${tsMs.toFixed(0)} ms; graph hubs ${hubsMs.toFixed(0)} ms`);

    expect(ts.totals.requests).toBeGreaterThan(0);
    expect(hubs.hubs).toHaveLength(20);
    expect(tsMs).toBeLessThan(1500);
    expect(hubsMs).toBeLessThan(1500);
  }, 60_000);
});
