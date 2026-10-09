/**
 * Migration 120 on a pre-rename brain (migrated through 119, legacy data
 * seeded): the manifest diff before/after is exactly the documented 120 set,
 * and nothing else — runtime_config, lock rows and every data table included —
 * changes. Runs on PGLite, and on Postgres with psql when
 * MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  changedKeys,
  ENGINES,
  migrateTo120,
  seedLegacy,
  withoutExpected,
  type Db,
} from "./helpers/migration-120.ts";

const LEGACY_FUNCTIONS = ["memex_fact_claim_key(text)", "memex_fact_withdrawn_on_insert()"];

async function functionDefs(db: Db): Promise<string[]> {
  const out: string[] = [];
  for (const sig of LEGACY_FUNCTIONS) {
    const r = await db.engine.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [sig]);
    out.push(r.rows[0]!.d);
  }
  return out;
}

for (const { name, open } of ENGINES) {
  describe(`migration 120 on a legacy fixture (${name})`, () => {
    let db: Db;
    let pre: string;
    let post: string;
    let legacyDefs: string[];

    beforeAll(async () => {
      db = await open();
      await seedLegacy(db.engine);
      pre = await db.manifest();
      legacyDefs = await functionDefs(db);
      const r = await migrateTo120(db.engine);
      expect(r.applied).toEqual([{ id: 120, name: "memrain_rename" }]);
      post = await db.manifest();
    });
    afterAll(async () => {
      await db.close();
    });

    it("changes exactly the migrations row, two new functions and the trigger", () => {
      expect(changedKeys(pre, post)).toEqual([
        "function\tmemrain_fact_claim_key(claim text)",
        "function\tmemrain_fact_withdrawn_on_insert()",
        "table\tmigrations",
        "trigger\tentity_facts.entity_facts_withdrawn_on_insert",
      ]);
      const preKeys = new Set(pre.split("\n").map((l) => l.split("\t").slice(0, 2).join("\t")));
      expect(preKeys.has("function\tmemrain_fact_claim_key(claim text)")).toBe(false);
      expect(preKeys.has("function\tmemrain_fact_withdrawn_on_insert()")).toBe(false);
    });

    it("leaves runtime_config, the lock tables and every other table line identical", () => {
      for (const t of ["runtime_config", "cycle_locks", "worker_lock", "entity_facts", "fact_withdrawals", "pages", "oauth_tokens"]) {
        const line = (out: string) => out.split("\n").find((l) => l.startsWith(`table\t${t}\t`));
        expect(line(post)).toBe(line(pre)!);
      }
    });

    it("the documented filtered diff is clean, and catches a change to one other row", async () => {
      expect(withoutExpected(post)).toBe(withoutExpected(pre));
      await db.engine.query(`UPDATE runtime_config SET value = '2' WHERE key = 'MEMEX_A'`);
      try {
        expect(withoutExpected(await db.manifest())).not.toBe(withoutExpected(pre));
      } finally {
        await db.engine.query(
          `UPDATE runtime_config SET value = '1', updated_at = '2026-01-01 00:00:00+00' WHERE key = 'MEMEX_A'`,
        );
      }
      expect(await db.manifest()).toBe(post);
    });

    it("keeps both legacy functions byte-identical", async () => {
      expect(await functionDefs(db)).toEqual(legacyDefs);
    });

    it("points the trigger at the new function and leaves the legacy one detached", async () => {
      const r = await db.engine.query<{ fn: string }>(
        `SELECT t.tgfoid::regproc::text AS fn FROM pg_trigger t
          WHERE t.tgname = 'entity_facts_withdrawn_on_insert' AND NOT t.tgisinternal`,
      );
      expect(r.rows).toEqual([{ fn: "memrain_fact_withdrawn_on_insert" }]);
    });
  });
}
