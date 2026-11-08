import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mergePage } from "../src/core/entity-merge.ts";
import { putPage } from "../src/core/pages.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`entity merge collisions (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => {
      db = await open();
      for (const slug of ["people/stub", "people/canon"]) await putPage(db.storage, { slug, markdown_body: "body" });
    });
    afterEach(async () => { await db.close(); });
    async function insert(slug: string, columns: string, values: string, params: unknown[] = []) {
      const r = await db.storage.engine().query<{ id: number }>(
        `INSERT INTO entity_facts (entity_slug, fact ${columns})
         VALUES ($1, 'claim' ${values}) RETURNING id`, [slug, ...params],
      );
      return r.rows[0]!.id;
    }

    it("tombstones colliding fence rows and permits a later canonical fence edit", async () => {
      const from = await insert("people/stub", ", source_markdown_slug, row_num", ", $1, 1");
      const to = await insert("people/canon", ", source_markdown_slug, row_num", ", $1, 1");
      const result = await mergePage(db.storage, "people/stub", "people/canon");
      expect(result.moved?.facts_retired).toBe(1);
      expect((await db.storage.engine().query("SELECT forgotten_cause, superseded_by FROM entity_facts WHERE id=$1", [from])).rows).toEqual([{ forgotten_cause: "supersede", superseded_by: to }]);
      const page = await putPage(db.storage, { slug: "people/canon", markdown_body: renderFactsFence([{ rowNum: 1, claim: "updated claim", confidence: 1, active: true }]) });
      await reconcileFactsForPage(db.storage, "people/canon", page.content_hash);
      expect((await db.storage.engine().query("SELECT fact FROM entity_facts WHERE source_markdown_slug='people/canon' AND forgotten_at IS NULL")).rows).toEqual([{ fact: "updated claim" }]);
    });

    it("tombstones a colliding open dimensional row including NULL source keys", async () => {
      const from = await insert("people/stub", ", dimension, value_hash", ", 'role', 'hash'");
      const to = await insert("people/canon", ", dimension, value_hash", ", 'role', 'hash'");
      await mergePage(db.storage, "people/stub", "people/canon");
      expect((await db.storage.engine().query("SELECT forgotten_cause, superseded_by FROM entity_facts WHERE id=$1", [from])).rows).toEqual([{ forgotten_cause: "supersede", superseded_by: to }]);
      expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE forgotten_at IS NULL")).rows).toEqual([{ id: to }]);
    });

    it("retains identical chunk claims attributed to different speakers", async () => {
      const from = await insert("people/stub", ", source_chunk_id, attributed_to", ", 'chunk', 'other'");
      const to = await insert("people/canon", ", source_chunk_id", ", 'chunk'");
      await mergePage(db.storage, "people/stub", "people/canon");
      expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE entity_slug='people/canon' ORDER BY id")).rows).toEqual([{ id: from }, { id: to }]);
    });

    it("clears a superseded_by pointer when an identical chunk duplicate is removed", async () => {
      const from = await insert("people/stub", ", source_chunk_id", ", 'chunk'");
      await insert("people/canon", ", source_chunk_id", ", 'chunk'");
      const historical = await insert("people/stub", ", superseded_by, forgotten_at", ", $2, NOW()", [from]);
      expect((await mergePage(db.storage, "people/stub", "people/canon")).merged).toBe(true);
      expect((await db.storage.engine().query("SELECT superseded_by FROM entity_facts WHERE id=$1", [historical])).rows).toEqual([{ superseded_by: null }]);
    });
  });
}
