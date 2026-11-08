import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { putPage } from "../src/core/pages.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`forget retired fact (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });

    it("withdraws a retired claim, its live duplicate and its later fence projection", async () => {
      const a = await addFact(db.storage, { entity_slug: "people/alice", fact: "Plays chess" });
      await forgetFact(db.storage, a.id!, { cause: "supersede" });
      const b = await addFact(db.storage, { entity_slug: "people/alice", fact: "Plays chess" });
      const r = await forgetFact(db.storage, a.id!);
      expect(r).toMatchObject({ found: true, forgotten: false, withdrawn: true, reason: "already_retired", withdrawn_duplicates: 1 });
      const e = db.storage.engine();
      expect((await e.query("SELECT forgotten_cause FROM entity_facts WHERE id=$1", [b.id!])).rows).toEqual([{ forgotten_cause: "forget" }]);
      expect((await e.query("SELECT first_fact_id FROM fact_withdrawals")).rows).toEqual([{ first_fact_id: a.id! }]);
      const body = renderFactsFence([{ rowNum: 1, claim: "Plays chess", confidence: 1, active: true }]);
      const page = await putPage(db.storage, { slug: "people/alice", markdown_body: body });
      await reconcileFactsForPage(db.storage, "people/alice", page.content_hash);
      expect((await e.query("SELECT id FROM entity_facts WHERE forgotten_at IS NULL")).rows).toEqual([]);
    });

    it("does not reveal or withdraw a retired fact outside the caller scope", async () => {
      const a = await addFact(db.storage, { entity_slug: "people/alice", fact: "Plays chess" });
      await forgetFact(db.storage, a.id!, { cause: "supersede" });
      expect(await forgetFact(db.storage, a.id!, {}, [])).toMatchObject({ found: false, forgotten: false, withdrawn_duplicates: 0 });
      expect((await db.storage.engine().query("SELECT * FROM fact_withdrawals")).rows).toEqual([]);
    });

    it("retains the existing idempotent response after an ordinary forget", async () => {
      const a = await addFact(db.storage, { entity_slug: "people/alice", fact: "Plays chess" });
      await forgetFact(db.storage, a.id!);
      expect(await forgetFact(db.storage, a.id!)).toEqual({ id: a.id!, found: true, forgotten: false, withdrawn_duplicates: 0 });
    });
  });
}
