/**
 * Migration 120 up → down → up keeps a forgotten claim forgotten at every step,
 * running 120 twice is harmless, and the down refuses — changing nothing — when
 * its preconditions fail, both through `apply-migrations --down` and through
 * the down file alone (`psql -1 -f`). Runs on PGLite, and on Postgres with
 * psql when MEMRAIN_TEST_POSTGRES_URL is set (the open-session case is
 * Postgres-only; PGLite has no second session).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { Storage } from "../src/core/storage.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { runApplyMigrations } from "../src/commands/apply-migrations.ts";
import { ENGINES, migrateTo120, seedLegacy, UP_120_SQL, type Db } from "./helpers/migration-120.ts";

/** Re-assert the seeded forgotten claim ("Owns a  Boat"), restated. */
async function readd(db: Db): Promise<boolean> {
  const r = await db.engine.query<{ forgotten: boolean }>(
    `INSERT INTO entity_facts (entity_slug, fact, source_id)
     VALUES ('people/alice', $1, 'tenant-a') RETURNING forgotten_at IS NOT NULL AS forgotten`,
    [`  owns A   BOAT `],
  );
  return r.rows[0]!.forgotten;
}

async function down(db: Db): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try {
    await runApplyMigrations({ down: 120, yes: true, storage: new Storage(db.engine) });
  } finally {
    console.log = log;
  }
}

async function topId(db: Db): Promise<number> {
  const r = await db.engine.query<{ id: number }>(`SELECT max(id) AS id FROM migrations`);
  return Number(r.rows[0]!.id);
}

for (const { name, open } of ENGINES) {
  describe(`migration 120 up/down/up (${name})`, () => {
    let db: Db;

    beforeEach(async () => {
      db = await open();
      await seedLegacy(db.engine);
    });
    afterEach(async () => {
      await db.close();
    });

    it("a forgotten claim stays forgotten across up, down and up again", async () => {
      await migrateTo120(db.engine);
      expect(await readd(db)).toBe(true);
      await down(db);
      expect(await topId(db)).toBe(119);
      expect(await readd(db)).toBe(true);
      const again = await migrateTo120(db.engine);
      expect(again.applied.map((m) => m.id)).toEqual([120]);
      expect(await readd(db)).toBe(true);
    });

    it("running the 120 file a second time changes nothing", async () => {
      await migrateTo120(db.engine);
      const first = await db.manifest();
      await db.engine.transaction(async (tx) => tx.exec(UP_120_SQL));
      expect(await db.manifest()).toBe(first);
    });

    it("--down refuses a missing --yes and a non-latest id, before touching the database", async () => {
      await migrateTo120(db.engine);
      const before = await db.manifest();
      const storage = new Storage(db.engine);
      await expect(runApplyMigrations({ down: 120, storage })).rejects.toThrow(/--yes/);
      await expect(runApplyMigrations({ down: 119, yes: true, storage })).rejects.toThrow(
        /no down file|not the latest/,
      );
      expect(await db.manifest()).toBe(before);
    });

    describe("the down file's own preconditions", () => {
      const refusals: Array<{ why: string; setup: (db: Db) => Promise<void>; message: RegExp }> = [
        {
          why: "a later migration row",
          setup: async (d) => {
            await d.engine.query(`INSERT INTO migrations (id, name) VALUES (121, 'fake')`);
          },
          message: /not the latest applied migration/,
        },
        {
          why: "a page with a memrain facts fence",
          setup: async (d) => {
            await d.engine.query(
              `INSERT INTO pages (slug, type, content_hash, markdown_body)
               VALUES ('people/bob', 'person', 'h', E'<!--- memrain:facts:begin -->\\n<!--- memrain:facts:end -->')`,
            );
          },
          message: /memrain fence/,
        },
        {
          why: "a page with a memrain takes fence",
          setup: async (d) => {
            await d.engine.query(
              `INSERT INTO pages (slug, type, content_hash, markdown_body)
               VALUES ('notes/new', 'note', 'h', E'x\\n<!--- memrain:takes:begin -->\\n<!--- memrain:takes:end -->')`,
            );
          },
          message: /memrain fence/,
        },
      ];

      for (const r of refusals) {
        it(`refuses with ${r.why}, through --down and through the file alone`, async () => {
          await migrateTo120(db.engine);
          await r.setup(db);
          const before = await db.manifest();
          await expect(db.runDownFile()).rejects.toThrow(r.message);
          expect(await db.manifest()).toBe(before);
          await expect(down(db)).rejects.toThrow(/not the latest|memrain fence/);
          expect(await db.manifest()).toBe(before);
        });
      }

      it("refuses on a database without 120 (nothing to undo)", async () => {
        const before = await db.manifest();
        await expect(db.runDownFile()).rejects.toThrow(/not the latest applied migration/);
        await expect(down(db)).rejects.toThrow(/not the latest applied migration/);
        expect(await db.manifest()).toBe(before);
      });

      it.skipIf(name !== "Postgres")("refuses while another client is connected", async () => {
        await migrateTo120(db.engine);
        const before = await db.manifest();
        const other = postgres((db as Db & { url: string }).url, { max: 1, onnotice: () => {} });
        try {
          await other`SELECT 1`;
          await expect(db.runDownFile()).rejects.toThrow(/other client sessions/);
          await expect(down(db)).rejects.toThrow(/other client sessions/);
          expect(await db.manifest()).toBe(before);
        } finally {
          await other.end({ timeout: 5 });
        }
        // The command's own engine is a pool (default size); it must not count
        // as a second session against itself.
        await db.engine.close();
        const cli = new Storage(new PostgresEngine({ url: (db as Db & { url: string }).url }));
        const log = console.log;
        console.log = () => {};
        try {
          await runApplyMigrations({ down: 120, yes: true, storage: cli });
        } finally {
          console.log = log;
          await cli.close();
        }
        await db.reopen();
        expect(await topId(db)).toBe(119);
      });
    });
  });
}
