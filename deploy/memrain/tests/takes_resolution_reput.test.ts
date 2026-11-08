import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { syncTakesFromFence } from "../src/core/synthesis/takes-canon.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

const fence = (claim: string, quality = "") => [
  "<!--- memrain:takes:begin -->",
  "| # | claim | kind | who | weight | since | source | quality | by |",
  `| 1 | ${claim} | take | world | 0.8 | 2026-01 | notes | ${quality} | ${quality ? "operator" : ""} |`,
  "<!--- memrain:takes:end -->",
].join("\n");

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`take resolution re-put (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });
    const read = async () => (await db.storage.engine().query("SELECT resolved_at, resolved_quality, resolved_outcome, resolved_value::float8, resolved_unit, resolved_source, resolved_by, status FROM synth_takes")).rows;

    it("keeps DB-only resolution on a prose edit and clears it on a changed claim", async () => {
      const e = db.storage.engine();
      await syncTakesFromFence(e, "notes/x", fence("Claim"));
      await e.query(`UPDATE synth_takes SET resolved_at='2026-01-01', resolved_quality='correct',
        resolved_outcome=true, resolved_value=42, resolved_unit='USD', resolved_source='notes/evidence',
        resolved_by='memrain:grade_takes', status='graded'`);
      const before = await read();
      await syncTakesFromFence(e, "notes/x", "Prose\n" + fence("Claim"));
      expect(await read()).toEqual(before);
      await syncTakesFromFence(e, "notes/x", fence("Different claim"));
      expect(await read()).toEqual([{
        resolved_at: null, resolved_quality: null, resolved_outcome: null, resolved_value: null,
        resolved_unit: null, resolved_source: null, resolved_by: null, status: "accepted",
      }]);
    });

    it("accepts an explicit fence resolution and keeps it when its cell is cleared", async () => {
      const e = db.storage.engine();
      await syncTakesFromFence(e, "notes/x", fence("Claim", "correct"));
      await syncTakesFromFence(e, "notes/x", fence("Claim", "incorrect"));
      const resolved = await read();
      expect(resolved[0]).toMatchObject({ resolved_quality: "incorrect", resolved_by: "operator", resolved_outcome: false });
      await syncTakesFromFence(e, "notes/x", fence("Claim"));
      expect(await read()).toEqual(resolved);
    });
  });
}
