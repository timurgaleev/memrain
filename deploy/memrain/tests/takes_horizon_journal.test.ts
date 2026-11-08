import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getTakesScorecard } from "../src/core/synthesis/reads.ts";
import { registerSource } from "../src/core/sources.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`take horizon journal ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    for (const source of ["horizon-a", "horizon-b"]) {
      await registerSource(db.storage.engine(), { id: source, kind: "vault", pathPrefix: `/${source}` });
      await db.storage.engine().query("INSERT INTO documents (id, source_path, source_id) VALUES ($1, $1, $1)", [source]);
    }
    for (const [key, until, source, active, resolved] of [
      ["past-day", "2000-01-01", "horizon-a", true, false],
      ["past-month", "2000-02", "horizon-a", true, false],
      ["future-month", "2999-12", "horizon-a", true, false],
      ["undated", null, "horizon-a", true, false],
      ["bad-day", "2000-02-30", "horizon-a", true, false],
      ["bad-month", "2000-13", "horizon-a", true, false],
      ["vague", "eventually", "horizon-a", true, false],
      ["resolved", "2000-01-01", "horizon-a", true, true],
      ["inactive", "2000-01-01", "horizon-a", false, false],
      ["foreign", "2000-01-01", "horizon-b", true, false],
    ] as const) await db.storage.engine().query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, model_id, until_date, active, resolved_quality, resolved_outcome)
       VALUES ($1, $2, 'hash', 'test', $1, 'bet', 'test', $3, $4, $5, $6)`,
      [key, source, until, active, resolved ? "correct" : null, resolved ? true : null],
    );
  });
  afterAll(async () => { await db.close(); });
  it("counts active unresolved deadlines after the normal source filter without rewriting text", async () => {
    const before = await db.storage.engine().query("SELECT take_key, until_date, resolved_quality FROM synth_takes ORDER BY take_key");
    const card = await getTakesScorecard(db.storage.engine(), { sourceIds: ["horizon-a"] });
    expect(card.total_takes).toBe(9);
    expect(card.journal).toEqual({ active: 8, resolved: 1, unresolved: 7, overdue: 2, upcoming: 1, undated: 1, unparseable_horizon: 3 });
    expect((await getTakesScorecard(db.storage.engine(), { sourceIds: ["horizon-b"] })).journal.overdue).toBe(1);
    expect((await getTakesScorecard(db.storage.engine(), { sourceIds: [] })).journal.active).toBe(0);
    expect((await db.storage.engine().query("SELECT take_key, until_date, resolved_quality FROM synth_takes ORDER BY take_key")).rows).toEqual(before.rows);
  });
});
