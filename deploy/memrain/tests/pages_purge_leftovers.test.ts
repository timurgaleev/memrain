/**
 * The hard purge of a page also removes its raw_data and tags rows (neither
 * table has a foreign key to pages), in the same transaction, so a later page
 * on the same slug does not inherit them. The orphans phase reports rows left
 * behind by older purges. The Postgres twin covers the transaction on the
 * real driver. Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch
 * database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { putRawData } from "../src/core/raw-data.ts";
import { addTag } from "../src/core/tags.ts";
import { orphansPurgePhase } from "../src/core/cycle/orphans-purge.ts";
import { PageNotFoundError } from "../src/core/operation-error.ts";

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;

async function seedPurgeable(storage: Storage, slug: string): Promise<void> {
  await putPage(storage, { slug, type: "person", source_id: "default" });
  await putRawData(storage, slug, "crm", { v: 1 });
  await addTag(storage, slug, "vip");
  await deletePage(storage, slug);
  await storage.engine().query(
    `UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`,
    [slug],
  );
}

async function leftovers(storage: Storage, slug: string): Promise<{ raw: number; tags: number }> {
  const raw = await storage.engine().query(`SELECT 1 FROM raw_data WHERE slug = $1`, [slug]);
  const tags = await storage.engine().query(`SELECT 1 FROM tags WHERE slug = $1`, [slug]);
  return { raw: raw.rows.length, tags: tags.rows.length };
}

describe("purge leftovers (PGLite)", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-purge-leftovers-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a purged page takes its raw_data and tags with it", async () => {
    await seedPurgeable(storage, "people/a");
    const r = await purgeDeletedPages(storage.engine());
    expect(r).toMatchObject({ count: 1, raw_data_rows: 1, tags_rows: 1 });
    expect(await leftovers(storage, "people/a")).toEqual({ raw: 0, tags: 0 });
  });

  it("a purged page takes the volunteer events that name it, and only those", async () => {
    await seedPurgeable(storage, "people/a");
    await storage.engine().query(`INSERT INTO context_volunteer_events (slug, rationale) VALUES ('people/a', 'about a'), ('people/keep', 'other')`);
    const dry = await purgeDeletedPages(storage.engine(), undefined, undefined, { dryRun: true });
    expect(dry).toMatchObject({ volunteer_event_rows: 1 });
    const r = await purgeDeletedPages(storage.engine());
    expect(r).toMatchObject({ count: 1, volunteer_event_rows: 1 });
    const left = await storage.engine().query<{ slug: string }>(`SELECT slug FROM context_volunteer_events ORDER BY slug`);
    expect(left.rows.map((row) => row.slug)).toEqual(["people/keep"]);
  });

  it("dry-run reports the leftovers it would remove without touching them", async () => {
    await seedPurgeable(storage, "people/a");
    const r = await purgeDeletedPages(storage.engine(), undefined, undefined, { dryRun: true });
    expect(r).toMatchObject({ dry_run: true, planned: ["people/a"], raw_data_rows: 1, tags_rows: 1 });
    expect(await leftovers(storage, "people/a")).toEqual({ raw: 1, tags: 1 });
  });

  it("the orphans phase reports raw_data and tags rows that have no page", async () => {
    await storage.engine().query(`INSERT INTO raw_data (slug, source, data) VALUES ('people/gone', 'crm', '{}')`);
    await storage.engine().query(`INSERT INTO tags (slug, tag, source_id) VALUES ('people/gone', 'vip', 'default')`);
    const r = await orphansPurgePhase(storage.engine());
    expect(r.flagged.raw_data_without_page).toBe(1);
    expect(r.flagged.tags_without_page).toBe(1);
    expect(await leftovers(storage, "people/gone")).toEqual({ raw: 1, tags: 1 });
  });
});

describe.skipIf(!PG_URL)("purge leftovers (Postgres)", () => {
  let pg: PostgresEngine;
  let storage: Storage;
  const run = crypto.randomUUID();
  const slug = `people/purge-leftovers-pg-${run}`;
  const raceSlug = `people/purge-race-pg-${run}`;

  beforeAll(async () => {
    pg = new PostgresEngine({ url: PG_URL! });
    storage = new Storage(pg);
    await storage.init();
  });

  afterAll(async () => {
    for (const s of [slug, raceSlug]) {
      await pg.query(`DELETE FROM raw_data WHERE slug = $1`, [s]);
      await pg.query(`DELETE FROM tags WHERE slug = $1`, [s]);
      await pg.query(`DELETE FROM pages WHERE slug = $1`, [s]);
    }
    await pg.close();
  });

  it("a purged page takes its raw_data and tags with it", async () => {
    await seedPurgeable(storage, slug);
    const r = await purgeDeletedPages(pg, undefined, undefined, { slugs: [slug] });
    expect(r).toMatchObject({ count: 1, slugs: [slug], raw_data_rows: 1, tags_rows: 1 });
    expect(await leftovers(storage, slug)).toEqual({ raw: 0, tags: 0 });
  });

  // The purge's transaction holds the page row from its DELETE to its COMMIT,
  // and its leftover DELETE has already run by then. A write that checked the
  // page without locking it would insert in that window and outlive the purge.
  const racers = [
    ["putRawData", (s: Storage) => putRawData(s, raceSlug, "crm", { v: 2 })],
    ["addTag", (s: Storage) => addTag(s, raceSlug, "vip")],
  ] as const;
  for (const [name, write] of racers) {
    it(`${name} racing an open purge leaves no orphan`, async () => {
      await putPage(storage, { slug: raceSlug, type: "person", source_id: "default" });
      const purger = new PostgresEngine({ url: PG_URL!, max: 2 });
      try {
        let settled!: Promise<unknown>;
        await purger.transaction(async (tx) => {
          await tx.query(`DELETE FROM pages WHERE slug = $1`, [raceSlug]);
          await tx.query(`DELETE FROM raw_data WHERE slug = $1`, [raceSlug]);
          await tx.query(`DELETE FROM tags WHERE slug = $1`, [raceSlug]);
          settled = write(storage).then(() => "written", (e: unknown) => e);
          // Keep the purge open until the write has finished or waits on the row.
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const done = await Promise.race([settled.then(() => true), Bun.sleep(50).then(() => false)]);
            if (done) break;
            const waiting = await purger.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock' AND query ILIKE '%FOR KEY SHARE%'`,
            );
            if (waiting.rows.length > 0) break;
          }
        });
        expect(await settled).toBeInstanceOf(PageNotFoundError);
        expect(await leftovers(storage, raceSlug)).toEqual({ raw: 0, tags: 0 });
      } finally {
        await purger.close();
      }
    });

    // Rename and merge move a page's sidecar rows under the page's slug lock.
    // A write that skipped that lock could insert on the old slug after the move.
    it(`${name} waits for the page's slug lock`, async () => {
      await putPage(storage, { slug: raceSlug, type: "person", source_id: "default" });
      const holder = new PostgresEngine({ url: PG_URL!, max: 2 });
      try {
        let settled!: Promise<unknown>;
        let finishedWhileLocked = false;
        await holder.transaction(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memrain:page:${raceSlug}`]);
          settled = write(storage).then(() => "written", (e: unknown) => e);
          finishedWhileLocked = await Promise.race([settled.then(() => true), Bun.sleep(500).then(() => false)]);
        });
        expect(finishedWhileLocked).toBe(false);
        expect(await settled).toBe("written");
      } finally {
        await holder.close();
        await pg.query(`DELETE FROM raw_data WHERE slug = $1`, [raceSlug]);
        await pg.query(`DELETE FROM tags WHERE slug = $1`, [raceSlug]);
      }
    });
  }
});
