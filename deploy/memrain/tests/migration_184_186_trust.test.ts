import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { putPage } from "../src/core/pages.ts";

const hasColumn = async (e: Engine, table: string, col: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, col])).rows[0]!.n === 1;

async function revertDownTo(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m >= id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 184-186 (${name})`, () => {
  it("leave every existing row's tier as it was, and revert and reapply cleanly", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertDownTo(e, 184);
      expect(await hasColumn(e, "synth_atoms", "trust_tier")).toBe(false);
      await putPage(db.storage, { slug: "notes/agent", markdown_body: "Agent text", written_by_principal: "client:bot" });
      await e.query(`INSERT INTO synth_atoms (atom_key, source_ref, source_hash, title, body, model_id) VALUES ('k1', 'notes/agent', 'h', 't', 'b', 'm')`);
      const fact = (await e.query<{ id: number }>(
        `INSERT INTO entity_facts (entity_slug, fact, source_slug) VALUES ('notes/agent', 'Drawn from it', 'notes/agent') RETURNING id`)).rows[0]!.id;
      const factBefore = (await e.query<{ trust_tier: string }>(`SELECT trust_tier FROM entity_facts WHERE id = $1`, [fact])).rows[0]!.trust_tier;
      expect(factBefore).toBe("owner");
      const applied = (await runMigrations(e)).applied.map(m => m.id);
      expect(applied.slice(0, 3)).toEqual([184, 185, 186]);
      // Additive: no backfill. The older atom has no tier and the older fact keeps its own.
      expect((await e.query<{ trust_tier: string | null }>(`SELECT trust_tier FROM synth_atoms WHERE atom_key = 'k1'`)).rows[0]!.trust_tier).toBeNull();
      expect((await e.query<{ trust_tier: string }>(`SELECT trust_tier FROM entity_facts WHERE id = $1`, [fact])).rows[0]!.trust_tier).toBe("owner");
      for (const [t, c] of [["synth_atoms", "trust_tier"], ["synth_takes", "trust_tier"], ["timeline_events", "trust_tier"], ["access_tokens", "min_trust"], ["oauth_clients", "min_trust"]] as const) {
        expect(await hasColumn(e, t, c)).toBe(true);
      }
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("refuse to drop a read floor or a pending proposal", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertDownTo(e, 187);
      await e.query(`INSERT INTO access_tokens (name, token_hash, scopes, min_trust) VALUES ('floored', 'h', ARRAY['read'], 'owner')`);
      await expect(revertMigration(e, 186)).rejects.toThrow("read floor");
      await e.query(`UPDATE access_tokens SET min_trust = NULL`);
      await revertMigration(e, 186);
      expect(await hasColumn(e, "access_tokens", "min_trust")).toBe(false);
      const a = (await e.query<{ id: number }>(`INSERT INTO entity_facts (entity_slug, fact) VALUES ('p/x', 'a') RETURNING id`)).rows[0]!.id;
      const b = (await e.query<{ id: number }>(`INSERT INTO entity_facts (entity_slug, fact) VALUES ('p/x', 'b') RETURNING id`)).rows[0]!.id;
      await e.query(`INSERT INTO trust_proposals (action, guard, source_id, target_id, related_id, before_state) VALUES ('supersede_fact', 'replaces', 'default', $1, $2, '{}')`, [a, b]);
      await expect(revertMigration(e, 185)).rejects.toThrow("await a decision");
      await e.query(`UPDATE trust_proposals SET status = 'rejected', decided_at = NOW(), decided_by = 'operator'`);
      await revertMigration(e, 185);
      await revertMigration(e, 184);
      expect(await hasColumn(e, "timeline_events", "trust_tier")).toBe(false);
      expect((await runMigrations(e)).applied.map(m => m.id).slice(0, 3)).toEqual([184, 185, 186]);
    } finally { await db.close(); }
  });
});
