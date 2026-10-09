/**
 * The SQL a pre-rename (v1.163) binary runs against the facts and config
 * tables — recall's withdrawal probe, forget with its single-key lock and
 * sweeps, the merge carry, the fence reconcile probe, config set/unset — copied
 * verbatim, gives the same results on a 119 database, after migration 120 and
 * after 120's down. Each run is rolled back, so the three states see the same
 * data. Runs on PGLite, and on Postgres when MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Engine } from "../src/core/engine/interface.ts";
import { revertMigration } from "../src/core/migrate.ts";
import { ENGINES, migrateTo120, rolledBack, seedLegacy, type Db } from "./helpers/migration-120.ts";

async function v1163Paths(tx: Engine): Promise<unknown> {
  const out: Record<string, unknown> = {};

  // facts.ts isClaimWithdrawn
  out.recall = (
    await tx.query(
      `SELECT 1 AS hit FROM fact_withdrawals
      WHERE source_id = $1 AND visibility = $2 AND entity_slug = $3
        AND claim_key = memex_fact_claim_key($4)`,
      ["tenant-a", "private", "people/alice", "owns a boat"],
    )
  ).rows;

  // facts-recall.ts forgetFact: flip, withdraw, lock, sweep
  const id = (
    await tx.query<{ id: number }>(`SELECT id FROM entity_facts WHERE fact = 'Plays chess'`)
  ).rows[0]!.id;
  await tx.query(`INSERT INTO entity_facts (entity_slug, fact) VALUES ('people/alice', 'plays   CHESS')`);
  const upd = await tx.query<{ source_id: string; visibility: string; entity_slug: string; claim_key: string }>(
    `UPDATE entity_facts
          SET forgotten_at = NOW(), forgotten_reason = $2, forgotten_cause = $3
        WHERE id = $1 AND forgotten_at IS NULL
        RETURNING source_id, visibility, entity_slug, dimension,
                  memex_fact_claim_key(fact) AS claim_key`,
    [id, "user", "forget"],
  );
  const hit = upd.rows[0]!;
  await tx.query(
    `INSERT INTO fact_withdrawals
         (source_id, visibility, entity_slug, claim_key, first_fact_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
    [hit.source_id, hit.visibility, hit.entity_slug, hit.claim_key, id, "user"],
  );
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memex:fact-withdraw:${hit.source_id}`]);
  const swept = await tx.query(
    `UPDATE entity_facts
            SET forgotten_at = NOW(), forgotten_cause = 'forget',
                forgotten_reason = $6
          WHERE source_id = $1 AND visibility = $2 AND entity_slug = $3
            AND memex_fact_claim_key(fact) = $4
            AND id <> $5
            AND forgotten_at IS NULL
            AND dimension IS NULL
          RETURNING id`,
    [hit.source_id, hit.visibility, hit.entity_slug, hit.claim_key, id, `withdrawn with fact ${id}`],
  );
  const readd = await tx.query<{ f: boolean }>(
    `INSERT INTO entity_facts (entity_slug, fact) VALUES ('people/alice', 'Plays chess ')
     RETURNING forgotten_at IS NOT NULL AS f`,
  );
  out.forget = { claim_key: hit.claim_key, swept: swept.rows.length, readdForgotten: readd.rows[0]!.f };

  // fact-withdrawals.ts carryFactWithdrawals (every source)
  await tx.query(
    `INSERT INTO entity_facts (entity_slug, fact, source_id) VALUES ('people/alicia', 'OWNS A BOAT', 'tenant-a')`,
  );
  await tx.query(
    `INSERT INTO fact_withdrawals
       (source_id, visibility, entity_slug, claim_key, first_fact_id, reason)
     SELECT source_id, visibility, $2, claim_key, first_fact_id, reason
       FROM fact_withdrawals
      WHERE entity_slug = $1
     ON CONFLICT DO NOTHING`,
    ["people/alice", "people/alicia"],
  );
  const carried = await tx.query(
    `UPDATE entity_facts ef
          SET forgotten_at = NOW(), forgotten_cause = 'forget',
              forgotten_reason = 'withdrawn (moved from ' || $1 || ')'
         FROM fact_withdrawals w
        WHERE ef.entity_slug = $2
          AND ef.forgotten_at IS NULL
          AND ef.dimension IS NULL
          AND w.source_id = ef.source_id
          AND w.visibility = ef.visibility
          AND w.entity_slug = ef.entity_slug
          AND w.claim_key = memex_fact_claim_key(ef.fact)
        RETURNING ef.id`,
    ["people/alice", "people/alicia"],
  );
  out.carry = carried.rows.length;

  // facts-reconcile.ts withdrawn-claim probe
  out.reconcile = (
    await tx.query(
      `SELECT c.claim FROM unnest($1::text[]) AS c(claim)
          WHERE EXISTS (
            SELECT 1 FROM fact_withdrawals w
             WHERE w.source_id = $2 AND w.visibility = 'private'
               AND w.entity_slug = $3
               AND w.claim_key = memex_fact_claim_key(c.claim))`,
      [["Owns a boat", "Lives in Paris"], "tenant-a", "people/alice"],
    )
  ).rows;

  // runtime-config.ts setRuntimeConfig / unsetRuntimeConfig
  await tx.query(
    `INSERT INTO runtime_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    ["MEMEX_A", "7"],
  );
  out.configGet = (await tx.query(`SELECT value FROM runtime_config WHERE key = $1`, ["MEMEX_A"])).rows;
  out.configUnset = (
    await tx.query(`DELETE FROM runtime_config WHERE key = $1 RETURNING key`, ["MEMEX_A"])
  ).rows;
  return out;
}

for (const { name, open } of ENGINES) {
  describe(`v1.163 SQL paths around migration 120 (${name})`, () => {
    let db: Db;
    let at119: unknown;

    beforeAll(async () => {
      db = await open();
      await seedLegacy(db.engine);
      at119 = await rolledBack(db.engine, v1163Paths);
    });
    afterAll(async () => {
      await db.close();
    });

    it("the baseline exercises every path", () => {
      expect(at119).toMatchObject({
        recall: [{ hit: 1 }],
        forget: { swept: 1, readdForgotten: true },
        carry: 1,
        reconcile: [{ claim: "Owns a boat" }],
        configGet: [{ value: "7" }],
        configUnset: [{ key: "MEMEX_A" }],
      });
    });

    it("gives the same results after 120 and after 120's down", async () => {
      await migrateTo120(db.engine);
      expect(await rolledBack(db.engine, v1163Paths)).toEqual(at119);
      await revertMigration(db.engine, 120);
      expect(await rolledBack(db.engine, v1163Paths)).toEqual(at119);
    });
  });
}
