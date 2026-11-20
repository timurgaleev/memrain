/**
 * Migration 177 — release the facts-backfill pages parked on a truncated
 * reply: they were decided by a parser that threw a cut reply away whole, so
 * they are asked again, keeping their attempt count; every other backoff row
 * waits as before. Up, down and up again.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

async function seed(e: Engine): Promise<void> {
  await e.query(
    `INSERT INTO synth_failures (doc_id, phase, content_hash, model, attempts, kind, next_eligible_at, last_at)
     VALUES ('page://notes/cut', 'facts-backfill', 'h1', 'm', 4, 'truncated', now() + interval '7 days', now()),
            ('page://notes/garbled', 'facts-backfill', 'h2', 'm', 3, 'unparseable', now() + interval '4 days', now()),
            ('page://notes/down', 'facts-backfill', 'h3', 'm', 3, 'llm_error', now() + interval '4 days', now()),
            ('doc://atoms', 'extract_atoms', 'h4', 'm', 3, 'truncated', now() + interval '4 days', now())`,
  );
}

async function held(e: Engine): Promise<{ doc_id: string; attempts: number; waiting: boolean }[]> {
  const r = await e.query<{ doc_id: string; attempts: number; waiting: boolean }>(
    `SELECT doc_id, attempts, next_eligible_at > now() AS waiting FROM synth_failures ORDER BY doc_id`,
  );
  return r.rows;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 177 (${name})`, () => {
  // Value: protects=pages parked on a cut reply become eligible for the next scheduled backfill with their attempt count, other holds stay;
  // fails_when=the release widens to other kinds or phases, misses the truncated facts rows, or resets attempts; why_new=no test covered it; seam=none
  it("ends only the facts-backfill waits left by a truncated reply, reverts, and re-applies", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const later = discoverMigrations().map((m) => m.id).filter((id) => id > 177).sort((a, b) => b - a);
      for (const id of later) await revertMigration(e, id);
      await revertMigration(e, 177);
      await seed(e);
      const again = await runMigrations(e);
      expect(again.applied.map((m) => m.id)).toEqual([177, ...later.reverse()]);
      expect(await held(e)).toEqual([
        { doc_id: "doc://atoms", attempts: 3, waiting: true },
        { doc_id: "page://notes/cut", attempts: 4, waiting: false },
        { doc_id: "page://notes/down", attempts: 3, waiting: true },
        { doc_id: "page://notes/garbled", attempts: 3, waiting: true },
      ]);
    } finally { await db.close(); }
  });
});
