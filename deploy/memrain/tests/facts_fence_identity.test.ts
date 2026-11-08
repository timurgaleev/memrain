import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { putPage } from "../src/core/pages.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

const facts: ParsedFact[] = [
  { rowNum: 1, claim: "Works here", confidence: 0.9, active: true },
  { rowNum: 2, claim: "Revenue", confidence: 0.85, active: true, kind: "event", notability: "high", source: "notes/report", validFrom: "2026-01-01", validUntil: "2026-02-01", claimMetric: "mrr", claimValue: 44.26, claimUnit: "USD", claimPeriod: "2026-01", eventType: "meeting" },
  { rowNum: 3, claim: "Likes chess", confidence: 1, active: true },
];
for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`fence fact identity (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });
    async function put(rows = facts, prose = "") {
      const page = await putPage(db.storage, { slug: "people/alice", markdown_body: prose + "\n" + renderFactsFence(rows) });
      return reconcileFactsForPage(db.storage, page.slug, page.content_hash);
    }
    const read = async () => (await db.storage.engine().query<{ id: number; row_num: number }>(
      "SELECT id::int, row_num, written_at, embedding::text, consolidated FROM entity_facts WHERE source_markdown_slug='people/alice' AND forgotten_at IS NULL ORDER BY row_num",
    )).rows;

    it("keeps ids, timestamps, embeddings and consolidation after a prose-only edit", async () => {
      await put();
      await db.storage.engine().query("UPDATE entity_facts SET embedding=$1::vector, consolidated=true", [`[${Array.from({ length: 1024 }, () => 0.1).join(",")}]`]);
      const before = await read();
      expect(new Set(before.map(r => r.row_num)).size).toBe(3);
      expect(await put(facts, "New prose")).toMatchObject({ unchanged: 3, removed: 0, added: 0 });
      expect(await read()).toEqual(before);
    });

    it("replaces only the edited row, including numeric and dated fields", async () => {
      await put();
      const before = await read();
      const changed = facts.map(f => f.rowNum === 1 ? { ...f, claim: "Works elsewhere" } : f);
      expect(await put(changed)).toMatchObject({ unchanged: 2, removed: 1, added: 1 });
      const after = await read();
      expect(after[0]?.id).not.toBe(before[0]?.id);
      expect(after.slice(1)).toEqual(before.slice(1));
    });

    it("removes struck and omitted rows while keeping the unchanged survivor", async () => {
      await put();
      const before = await read();
      expect(await put([{ ...facts[0]!, active: false }, facts[1]!])).toMatchObject({ unchanged: 1, removed: 2, added: 0 });
      expect(await read()).toEqual([before[1]!]);
    });

    it("does not revive a withdrawn row during a later prose edit", async () => {
      await put();
      const before = await read();
      await forgetFact(db.storage, before[0]!.id);
      expect(await put(facts, "Prose")).toMatchObject({ unchanged: 2, added: 0 });
      expect(await read()).toEqual(before.slice(1));
    });

    it("does not apply a stale projection after a newer write and reconcile", async () => {
      await put();
      const page = await putPage(db.storage, { slug: "people/alice", markdown_body: "old prose\n" + renderFactsFence(facts) });
      const e = db.storage.engine();
      const original = e.transaction.bind(e);
      let interleaved = false;
      const newer = facts.map(f => f.rowNum === 1 ? { ...f, claim: "newer claim" } : f);
      const transaction = spyOn(e, "transaction").mockImplementation(async fn => {
        if (!interleaved) {
          interleaved = true;
          await put(newer);
        }
        return original(fn);
      });
      try {
        await reconcileFactsForPage(db.storage, page.slug, page.content_hash);
      } finally { transaction.mockRestore(); }
      expect((await e.query("SELECT fact FROM entity_facts WHERE source_markdown_slug='people/alice' AND row_num=1 AND forgotten_at IS NULL")).rows).toEqual([{ fact: "newer claim" }]);
    });
  });
}
