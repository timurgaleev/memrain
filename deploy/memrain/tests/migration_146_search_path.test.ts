import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const signatures = ["chunks_update_search_vector()", "auto_enable_rls()", "memex_fact_claim_key(text)",
  "memrain_fact_claim_key(text)", "memex_fact_withdrawn_on_insert()", "memrain_fact_withdrawn_on_insert()"];
async function functions(e: Engine) {
  return (await e.query<{ signature: string; config: string[] | null; body: string; owner: string; grants: unknown }>(
    `SELECT p.oid::regprocedure::text AS signature, p.proconfig AS config, p.prosrc AS body,
            p.proowner::text AS owner, p.proacl AS grants, p.provolatile, p.proisstrict, p.proparallel, p.prosecdef
       FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY p.oid::regprocedure::text`, [signatures])).rows;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 146 (${name})`, () => {
  it("pins exactly six signatures and restores their baseline without changing bodies, grants or data", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const after = await functions(e);
      expect(after).toHaveLength(6);
      for (const row of after) expect(row.config).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      await e.query("INSERT INTO entity_facts(entity_slug,fact) VALUES('people/migration-probe','Retained fact')");
      const data = (await e.query("SELECT * FROM entity_facts ORDER BY id")).rows;
      const rls = (await e.query("SELECT oid::text, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid")).rows;
      for (const id of discoverMigrations().map(m => m.id).filter(id => id > 146).sort((a,b) => b-a)) await revertMigration(e, id);
      await revertMigration(e, 146);
      const before = await functions(e);
      for (const row of before) expect(row.config).toEqual(row.signature === "memex_fact_claim_key(text)" ? null : ["search_path=pg_catalog, public"]);
      expect(before.map(({ config, ...row }) => row)).toEqual(after.map(({ config, ...row }) => row));
      await runMigrations(e);
      expect(await functions(e)).toEqual(after);
      expect((await e.query("SELECT * FROM entity_facts ORDER BY id")).rows).toEqual(data);
      expect((await e.query("SELECT oid::text, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid")).rows).toEqual(rls);
    } finally { await db.close(); }
  });

  it("both withdrawal triggers ignore a temporary shadow table", async () => {
    const db = await open();
    try {
      await db.storage.engine().transaction(async e => {
        await e.query("INSERT INTO public.fact_withdrawals(source_id,visibility,entity_slug,claim_key) VALUES('default','private','people/shadow',public.memrain_fact_claim_key('Keep retired'))");
        await e.exec("CREATE TEMP TABLE fact_withdrawals (LIKE public.fact_withdrawals INCLUDING DEFAULTS)");
        for (const brand of ["memex", "memrain"]) {
          await e.exec(`CREATE TEMP TABLE probe_${brand} (LIKE public.entity_facts INCLUDING DEFAULTS);
            CREATE TRIGGER withdrawn BEFORE INSERT ON probe_${brand} FOR EACH ROW EXECUTE FUNCTION public.${brand}_fact_withdrawn_on_insert()`);
          const rows = (await e.query<{ forgotten_cause: string | null }>(`INSERT INTO probe_${brand}(entity_slug,fact) VALUES('people/shadow','Keep retired') RETURNING forgotten_cause`)).rows;
          expect(rows).toEqual([{ forgotten_cause: "forget" }]);
        }
      });
    } finally { await db.close(); }
  });

  if (name === "Postgres") it("a non-owner application is a no-op rather than a partial privilege escalation", async () => {
    const db = await open();
    const role = `mig146_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
    try {
      const e = db.storage.engine();
      const baseline = await functions(e);
      await e.exec(`CREATE ROLE ${role} NOLOGIN`);
      await e.transaction(async tx => {
        await tx.exec(`SET LOCAL ROLE ${role}`);
        await tx.exec(readFileSync(join(import.meta.dir, "../src/core/migrations/146_function_search_path.sql"), "utf8"));
      });
      expect(await functions(e)).toEqual(baseline);
    } finally {
      await db.storage.engine().exec(`DROP ROLE IF EXISTS ${role}`);
      await db.close();
    }
  });
});
