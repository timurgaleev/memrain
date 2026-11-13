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
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact, entityRecall } from "../src/core/facts.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";

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

  // The purge reads its doomed facts before it takes their row locks. A fact
  // forgotten by a transaction that commits while the purge waits on the row
  // must keep its own tombstone and stay out of the receipt.
  it("a fact forgotten while the purge waits on its row keeps the forget", async () => {
    const page = `notes/purge-forget-race-${run}`;
    await putPage(storage, { slug: page, markdown_body: "gone" });
    const id = (await addFact(storage, { entity_slug: `people/purge-forget-race-${run}`, fact: "Likes tea.", source_slug: page })).id!;
    await deletePage(storage, page);
    await pg.query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`, [page]);
    const forgetter = new PostgresEngine({ url: PG_URL!, max: 2 });
    try {
      let purge!: Promise<Awaited<ReturnType<typeof purgeDeletedPages>>>;
      await forgetter.transaction(async (tx) => {
        await tx.query(
          `UPDATE entity_facts SET forgotten_at = NOW(), forgotten_cause = 'forget', forgotten_reason = 'user' WHERE id = $1`, [id]);
        purge = purgeDeletedPages(pg, undefined, undefined, { slugs: [page] });
        const deadline = Date.now() + 5_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          await Bun.sleep(25);
          waiting = (await forgetter.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query ILIKE '%fact_purge_receipts%'`,
          )).rows.length > 0;
        }
        expect(waiting).toBe(true);
      });
      expect(await purge).toMatchObject({ slugs: [page], facts_retired: 0 });
      const row = await pg.query<{ forgotten_cause: string }>(`SELECT forgotten_cause FROM entity_facts WHERE id = $1`, [id]);
      expect(row.rows).toEqual([{ forgotten_cause: "forget" }]);
      expect((await pg.query(`SELECT 1 FROM fact_purge_receipts WHERE page_slug = $1`, [page])).rows).toEqual([]);
    } finally {
      await forgetter.close();
      await pg.query(`DELETE FROM entity_facts WHERE id = $1`, [id]);
    }
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

// A fact is written on a page when its fence row came from it, or, for a row
// with no fence origin, when it names the page as its source. Once the page row
// is gone nothing hides those facts any more, so the purge retires them. A
// page that states the same claim holds its own fact row, which stays.
for (const { name, open } of storageEngines(PG_URL)) describe(`purge retires facts written on the page (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => { db = await open(); });
  afterEach(async () => { await db.close(); });

  const fenced = (claim: string) => `## Facts\n\n${renderFactsFence([{ rowNum: 1, claim, confidence: 1, active: true }])}\n`;
  async function writeFenced(slug: string, claim: string): Promise<void> {
    const p = await putPage(db.storage, { slug, markdown_body: fenced(claim) });
    await reconcileFactsForPage(db.storage, slug, p.content_hash, "default");
  }
  async function expire(slug: string): Promise<void> {
    await deletePage(db.storage, slug);
    await db.storage.engine().query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`, [slug]);
  }
  async function addSource(id: string): Promise<void> {
    await db.storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING", [id, `/${id}`]);
  }
  const recalled = async (slug: string) => (await entityRecall(db.storage, slug)).facts.map((f) => f.fact).sort();
  const state = async (id: number) => (await db.storage.engine().query<{ forgotten_at: string | null; forgotten_cause: string | null }>(
    `SELECT forgotten_at::text AS forgotten_at, forgotten_cause FROM entity_facts WHERE id = $1`, [id])).rows[0]!;
  const LIVE = { forgotten_at: null, forgotten_cause: null };

  it("purged-page facts stay out of entity_recall after the purge and after the slug is reused", async () => {
    await writeFenced("people/gone", "Likes tea.");
    await putPage(db.storage, { slug: "notes/gone-src", markdown_body: "source" });
    const about = (await addFact(db.storage, { entity_slug: "people/other", fact: "Met at the gone page.", source_slug: "notes/gone-src" })).id!;
    await expire("people/gone");
    await expire("notes/gone-src");
    expect(await recalled("people/gone")).toEqual([]);
    expect(await recalled("people/other")).toEqual([]);

    const r = await purgeDeletedPages(db.storage.engine());
    expect(r).toMatchObject({ count: 2, facts_retired: 2 });
    expect(await recalled("people/gone")).toEqual([]);
    expect(await recalled("people/other")).toEqual([]);
    expect(await state(about)).toMatchObject({ forgotten_cause: "purge" });

    await putPage(db.storage, { slug: "people/gone", markdown_body: "A new person on the old slug." });
    await putPage(db.storage, { slug: "notes/gone-src", markdown_body: "A new note on the old slug." });
    expect(await recalled("people/gone")).toEqual([]);
    expect(await recalled("people/other")).toEqual([]);
  });

  it("a reused slug's own fence facts are not suppressed by the purge tombstones", async () => {
    await writeFenced("people/gone", "Likes tea.");
    await expire("people/gone");
    await purgeDeletedPages(db.storage.engine());
    await writeFenced("people/gone", "Likes tea.");
    expect(await recalled("people/gone")).toEqual(["Likes tea."]);
  });

  it("facts written on another live page, or naming no source, survive", async () => {
    await putPage(db.storage, { slug: "notes/gone", markdown_body: "gone" });
    await putPage(db.storage, { slug: "notes/kept", markdown_body: "kept" });
    await addFact(db.storage, { entity_slug: "people/x", fact: "Lives in Oslo.", source_slug: "notes/gone" });
    await addFact(db.storage, { entity_slug: "people/x", fact: "Works at Acme.", source_slug: "notes/kept" });
    await addFact(db.storage, { entity_slug: "notes/gone", fact: "Was a draft." });
    await expire("notes/gone");
    expect(await purgeDeletedPages(db.storage.engine())).toMatchObject({ count: 1, facts_retired: 1 });
    expect(await recalled("people/x")).toEqual(["Works at Acme."]);
    expect(await recalled("notes/gone")).toEqual(["Was a draft."]);
  });

  it("retires the purged page's copy of a claim and keeps the supporting page's own fact", async () => {
    await putPage(db.storage, { slug: "notes/gone", markdown_body: "gone" });
    await putPage(db.storage, { slug: "notes/kept", markdown_body: "kept" });
    const onGone = (await addFact(db.storage, { entity_slug: "people/x", fact: "Speaks Dutch.", source_slug: "notes/gone", written_by: "w1" })).id!;
    const onKept = (await addFact(db.storage, { entity_slug: "people/x", fact: "speaks  dutch.", source_slug: "notes/kept", written_by: "w2" })).id!;
    await expire("notes/gone");
    expect(await purgeDeletedPages(db.storage.engine())).toMatchObject({ count: 1, facts_retired: 1 });
    expect(await state(onGone)).toMatchObject({ forgotten_cause: "purge" });
    expect(await state(onKept)).toEqual(LIVE);
    expect(await recalled("people/x")).toEqual(["speaks  dutch."]);
  });

  it("purging both pages that state a claim, one after the other, leaves no visible copy", async () => {
    await putPage(db.storage, { slug: "notes/first", markdown_body: "first" });
    await putPage(db.storage, { slug: "notes/second", markdown_body: "second" });
    await addFact(db.storage, { entity_slug: "people/x", fact: "Speaks Dutch.", source_slug: "notes/first", written_by: "w1" });
    await addFact(db.storage, { entity_slug: "people/x", fact: "Speaks Dutch.", source_slug: "notes/second", written_by: "w2" });
    await expire("notes/first");
    expect(await purgeDeletedPages(db.storage.engine())).toMatchObject({ slugs: ["notes/first"], facts_retired: 1 });
    await expire("notes/second");
    expect(await purgeDeletedPages(db.storage.engine())).toMatchObject({ slugs: ["notes/second"], facts_retired: 1 });
    expect(await recalled("people/x")).toEqual([]);
    const live = await db.storage.engine().query(`SELECT id FROM entity_facts WHERE entity_slug = 'people/x' AND forgotten_at IS NULL`);
    expect(live.rows).toEqual([]);
  });

  it("the same claim on a quarantined, soft-deleted or other-source page does not keep it either", async () => {
    await addSource("other");
    await putPage(db.storage, { slug: "notes/gone", markdown_body: "gone" });
    await putPage(db.storage, { slug: "notes/held", markdown_body: "held" });
    await putPage(db.storage, { slug: "notes/deleted", markdown_body: "deleted" });
    await putPage(db.storage, { slug: "notes/foreign", markdown_body: "foreign", source_id: "other" });
    await db.storage.engine().query(
      `INSERT INTO documents (id, source_path, frontmatter) VALUES ('held-mirror', 'page://notes/held', '{"quarantine": {"detail": "x"}}'::jsonb)`);
    const ids: number[] = [];
    for (const fact of ["Owns a boat.", "Plays chess.", "Runs daily."])
      ids.push((await addFact(db.storage, { entity_slug: "people/x", fact, source_slug: "notes/gone", written_by: "w1" })).id!);
    await addFact(db.storage, { entity_slug: "people/x", fact: "Owns a boat.", source_slug: "notes/held", written_by: "w2" });
    await addFact(db.storage, { entity_slug: "people/x", fact: "Plays chess.", source_slug: "notes/deleted", written_by: "w2" });
    await deletePage(db.storage, "notes/deleted");
    await addFact(db.storage, { entity_slug: "people/x", fact: "Runs daily.", source_slug: "notes/foreign", written_by: "w2", source_id: "other" });
    await expire("notes/gone");
    expect(await purgeDeletedPages(db.storage.engine(), undefined, undefined, { slugs: ["notes/gone"] }))
      .toMatchObject({ count: 1, facts_retired: 3 });
    for (const id of ids) expect(await state(id)).toMatchObject({ forgotten_cause: "purge" });
  });

  it("leaves another source's fact that names the purged slug alone", async () => {
    await addSource("other");
    await putPage(db.storage, { slug: "notes/gone", markdown_body: "gone" });
    const foreign = (await addFact(db.storage, { entity_slug: "people/x", fact: "Cited elsewhere.", source_slug: "notes/gone", source_id: "other" })).id!;
    await expire("notes/gone");
    expect(await purgeDeletedPages(db.storage.engine())).toMatchObject({ count: 1, facts_retired: 0 });
    expect(await state(foreign)).toEqual(LIVE);
  });

  it("dry run counts the facts it would retire and changes nothing", async () => {
    const e = db.storage.engine();
    await writeFenced("people/gone", "Likes tea.");
    await expire("people/gone");
    const before = (await e.query(`SELECT * FROM entity_facts ORDER BY id`)).rows;
    const dry = await purgeDeletedPages(e, undefined, undefined, { dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, planned: ["people/gone"], facts_retired: 1 });
    expect((await e.query(`SELECT * FROM entity_facts ORDER BY id`)).rows).toEqual(before);
    expect((await e.query(`SELECT 1 FROM fact_purge_receipts`)).rows).toEqual([]);
  });

  it("records the retired ids in a receipt that is enough to undo the retirement", async () => {
    const e = db.storage.engine();
    await writeFenced("people/gone", "Likes tea.");
    await expire("people/gone");
    const id = Number((await e.query<{ id: number }>(`SELECT id FROM entity_facts WHERE source_markdown_slug = 'people/gone'`)).rows[0]!.id);
    await purgeDeletedPages(e);
    const receipts = await e.query<{ page_slug: string; source_id: string; fact_ids: Array<number | string> }>(
      `SELECT page_slug, source_id, fact_ids FROM fact_purge_receipts`);
    expect(receipts.rows.map((row) => ({ ...row, fact_ids: row.fact_ids.map(Number) }))).toEqual([
      { page_slug: "people/gone", source_id: "default", fact_ids: [id] },
    ]);
    // The documented recovery: clear the tombstone on exactly the receipt's ids.
    await e.query(
      `UPDATE entity_facts SET forgotten_at = NULL, forgotten_cause = NULL, forgotten_reason = NULL
        WHERE forgotten_cause = 'purge'
          AND id IN (SELECT unnest(fact_ids) FROM fact_purge_receipts WHERE page_slug = 'people/gone')`);
    expect(await state(id)).toEqual(LIVE);
  });

  it("a blocked page keeps its facts live while the rest are retired", async () => {
    const e = db.storage.engine();
    await writeFenced("people/stuck", "Stuck fact.");
    await writeFenced("people/free", "Free fact.");
    await expire("people/stuck");
    await expire("people/free");
    await e.exec(`CREATE TABLE purge_hold (slug TEXT REFERENCES pages(slug))`);
    await e.query(`INSERT INTO purge_hold (slug) VALUES ('people/stuck')`);
    const r = await purgeDeletedPages(e);
    expect(r).toMatchObject({ slugs: ["people/free"], facts_retired: 1 });
    expect(r.blocked.map((b) => b.slug)).toEqual(["people/stuck"]);
    const rows = await e.query<{ source_markdown_slug: string; forgotten_cause: string | null }>(
      `SELECT source_markdown_slug, forgotten_cause FROM entity_facts ORDER BY source_markdown_slug`);
    expect(rows.rows).toEqual([
      { source_markdown_slug: "people/free", forgotten_cause: "purge" },
      { source_markdown_slug: "people/stuck", forgotten_cause: null },
    ]);
    expect((await e.query<{ page_slug: string }>(`SELECT page_slug FROM fact_purge_receipts`)).rows).toEqual([{ page_slug: "people/free" }]);
  });
});
