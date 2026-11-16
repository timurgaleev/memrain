import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

const column = async (e: Engine, t: string, c: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const LABEL = `INSERT INTO eval_queries (id, query, tag, source, tags, lang, split, expected_doc_ids, candidate_id)
  VALUES ($1, 'who owns the ledger', 'good', 'labelled', $2::text[], $3, $4, $5::text::jsonb, $6)`;
const SHADOW = `INSERT INTO search_telemetry_shadow (date, flag, count, rank1_changed, sum_jaccard5) VALUES ($1, $2, 1, 0, 1)`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 165-166 (${name})`, () => {
  it("165 labels a live eval query with tags, language, split and every relevant document", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const c of ["tags", "lang", "split", "expected_doc_ids", "candidate_id"]) expect(await column(e, "eval_queries", c)).toBe(true);
      await e.query(LABEL, ["q1", ["kind:entity", "intent:topic"], "en", "dev", JSON.stringify(["doc-a", "doc-b"]), 7]);
      const row = (await e.query<{ tags: string[]; expected_doc_ids: string[] }>(`SELECT tags, expected_doc_ids FROM eval_queries WHERE id = 'q1'`)).rows[0]!;
      expect(row.tags).toEqual(["kind:entity", "intent:topic"]);
      expect(row.expected_doc_ids).toEqual(["doc-a", "doc-b"]);
      // A candidate is labelled once.
      await expect(e.query(LABEL, ["q2", [], "en", "dev", "[]", 7])).rejects.toThrow();
      // Only the two splits, a two-letter language and an array of ids.
      await expect(e.query(LABEL, ["q3", [], "en", "holdout", "[]", 8])).rejects.toThrow();
      await expect(e.query(LABEL, ["q4", [], "english", "dev", "[]", 9])).rejects.toThrow();
      await expect(e.query(LABEL, ["q5", [], "en", "dev", `{"a":1}`, 10])).rejects.toThrow();
      // Rows written before 165 keep working: every new column is optional.
      await e.query(`INSERT INTO eval_queries (id, query, tag) VALUES ('legacy', 'old query', 'bad')`);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("166 keeps one shadow rollup row per day and flag", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await table(e, "search_telemetry_shadow")).toBe("search_telemetry_shadow");
      await e.query(SHADOW, ["2026-11-15", "EXACT_LOOKUP"]);
      await expect(e.query(SHADOW, ["2026-11-15", "EXACT_LOOKUP"])).rejects.toThrow();
      await e.query(SHADOW, ["2026-11-15", "METADATA_GATE"]);
      // A flag name is an identifier, never query text.
      await expect(e.query(SHADOW, ["2026-11-15", "who owns the ledger"])).rejects.toThrow();
      await expect(e.query(`UPDATE search_telemetry_shadow SET rank1_changed = count + 1`)).rejects.toThrow();
    } finally { await db.close(); }
  });

  it("down reverts 166 then 165, and up restores both", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 166);
      await e.query(LABEL, ["q1", ["kind:entity"], "en", "dev", "[]", 1]);
      await revertMigration(e, 166);
      expect(await table(e, "search_telemetry_shadow")).toBeNull();
      await revertMigration(e, 165);
      expect(await column(e, "eval_queries", "tags")).toBe(false);
      expect(await column(e, "eval_queries", "candidate_id")).toBe(false);
      // The labelled query itself survives the down; only its labels go.
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM eval_queries WHERE id = 'q1'`)).rows[0]!.n).toBe(1);
      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)).toEqual(expect.arrayContaining([165, 166]));
      expect(await column(e, "eval_queries", "tags")).toBe(true);
      expect(await table(e, "search_telemetry_shadow")).toBe("search_telemetry_shadow");
    } finally { await db.close(); }
  });
});
