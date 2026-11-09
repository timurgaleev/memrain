/**
 * Migration 120's functions are copies of 112/116's under new names: the
 * trigger function's definition equals the legacy one with only the claim-key
 * function renamed, and the two claim-key functions share volatility,
 * strictness, parallel safety and body; their settings differ exactly by the
 * new one's pinned search_path. Runs on PGLite, and on Postgres when
 * MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ENGINES, migrateTo120, type Db } from "./helpers/migration-120.ts";

interface ProcRow {
  def: string;
  src: string;
  volatile: string;
  strict: boolean;
  parallel: string;
  config: string[] | null;
}

async function proc(db: Db, sig: string): Promise<ProcRow> {
  const r = await db.engine.query<ProcRow>(
    `SELECT pg_get_functiondef(p.oid) AS def, p.prosrc AS src, p.provolatile AS volatile,
            p.proisstrict AS strict, p.proparallel AS parallel, p.proconfig AS config
       FROM pg_proc p WHERE p.oid = $1::regprocedure`,
    [sig],
  );
  return r.rows[0]!;
}

for (const { name, open } of ENGINES) {
  describe(`migration 120 function bodies (${name})`, () => {
    let db: Db;

    beforeAll(async () => {
      db = await open();
      await migrateTo120(db.engine);
    });
    afterAll(async () => {
      await db.close();
    });

    it("the trigger function is the legacy one with only the claim-key call renamed", async () => {
      const legacy = await proc(db, "memex_fact_withdrawn_on_insert()");
      const next = await proc(db, "memrain_fact_withdrawn_on_insert()");
      const normalise = (def: string) => def.replace(/memrain_fact_withdrawn_on_insert/g, "memex_fact_withdrawn_on_insert");
      expect(normalise(next.def)).toBe(legacy.def.replace("memex_fact_claim_key(", "memrain_fact_claim_key("));
      expect(next.src).toBe(legacy.src.replace("memex_fact_claim_key(", "memrain_fact_claim_key("));
      expect(next.src).toContain("hashtext('memex:fact-withdraw:' || NEW.source_id)");
      expect(next.config).toEqual(legacy.config);
    });

    it("the claim-key functions match in everything but the pinned search_path", async () => {
      const legacy = await proc(db, "memex_fact_claim_key(text)");
      const next = await proc(db, "memrain_fact_claim_key(text)");
      expect(next.src).toBe(legacy.src);
      expect([next.volatile, next.strict, next.parallel]).toEqual([legacy.volatile, legacy.strict, legacy.parallel]);
      expect([next.volatile, next.strict, next.parallel]).toEqual(["i", true, "s"]);
      expect(legacy.config).toBeNull();
      expect(next.config).toEqual(["search_path=pg_catalog, public"]);
    });
  });
}
