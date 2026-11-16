import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const REF = "0123456789abcdef";
const LOOP = `INSERT INTO open_loops (source_id, dedup_key, loop_type, detector, kind, thread_ref, page_slug, summary, opened_at, last_activity_at)
  VALUES ($1, $2, $3, 'deterministic', 'mail', '${REF}', $4, 'Reply owed', NOW(), NOW())`;
const THREAD = `INSERT INTO loop_threads (source_id, page_slug, kind, thread_ref, signals, last_activity_at)
  VALUES ($1, $2, 'mail', '${REF}', '{"v":1}'::jsonb, NOW())`;
const count = async (e: Engine, t: string) => (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;

async function seedPage(db: { storage: Parameters<typeof putPage>[0] }, slug: string, sourceId = "default"): Promise<void> {
  await putPage(db.storage, { slug, title: "Thread", markdown_body: "Mail thread.", source_id: sourceId });
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 161 (${name})`, () => {
  it("creates the loop tables with their constraints", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const t of ["open_loops", "loop_suppressions", "loop_threads"]) expect(await table(e, t)).toBe(t);
      await seedPage(db, "mail/acct/2026-11/thread");
      await e.query(LOOP, ["default", "mail:x:unanswered_inbound", "unanswered_inbound", "mail/acct/2026-11/thread"]);
      // One row per dedup key and source.
      await expect(e.query(LOOP, ["default", "mail:x:unanswered_inbound", "unanswered_inbound", null])).rejects.toThrow();
      // Unknown types, statuses and free-text closers are refused.
      await expect(e.query(LOOP, ["default", "k2", "gossip", null])).rejects.toThrow();
      await expect(e.query(`UPDATE open_loops SET status = 'snoozed'`)).rejects.toThrow();
      await expect(e.query(`UPDATE open_loops SET status = 'done', closed_at = NOW(), closed_by = 'Closed: see the body'`)).rejects.toThrow();
      // A closed loop carries its closing time; an open one does not.
      await expect(e.query(`UPDATE open_loops SET status = 'done'`)).rejects.toThrow();
      await expect(e.query(`UPDATE open_loops SET counterparty_key = 'bob@example.com'`)).rejects.toThrow();
      await expect(e.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ('default', 'sender', 'bob@example.com')`)).rejects.toThrow();
      await e.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ('default', 'sender', $1)`, [REF]);
      await expect(e.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ('default', 'sender', $1)`, [REF])).rejects.toThrow();
      await e.query(THREAD, ["default", "mail/acct/2026-11/thread"]);
      await expect(e.query(THREAD, ["default", "mail/acct/2026-11/thread"])).rejects.toThrow();
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("goes with its page and with its source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "acme", kind: "mailbox", pathPrefix: "acme/" });
      await seedPage(db, "acme/mail/t1", "acme");
      await seedPage(db, "acme/mail/t2", "acme");
      await e.query(LOOP, ["acme", "k1", "unanswered_inbound", "acme/mail/t1"]);
      await e.query(THREAD, ["acme", "acme/mail/t1"]);
      await e.query(`DELETE FROM pages WHERE slug = 'acme/mail/t1'`);
      expect(await count(e, "open_loops")).toBe(0);
      expect(await count(e, "loop_threads")).toBe(0);
      await e.query(LOOP, ["acme", "k2", "unanswered_inbound", "acme/mail/t2"]);
      await e.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ('acme', 'thread', $1)`, [REF]);
      await e.query(`DELETE FROM pages WHERE source_id = 'acme'`);
      await e.query(`DELETE FROM sources WHERE id = 'acme'`);
      expect(await count(e, "open_loops")).toBe(0);
      expect(await count(e, "loop_suppressions")).toBe(0);
    } finally { await db.close(); }
  });

  it("down refuses to forget the owner's decisions, then drops the tables, and up restores them", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 161);
      await e.query(`INSERT INTO loop_suppressions (source_id, kind, value_hash) VALUES ('default', 'thread', $1)`, [REF]);
      await expect(revertMigration(e, 161)).rejects.toThrow(/mute/);
      await e.query(`DELETE FROM loop_suppressions`);
      await e.query(LOOP, ["default", "k3", "unanswered_inbound", null]);
      await e.query(`UPDATE open_loops SET status = 'dropped', closed_at = NOW(), closed_by = 'owner'`);
      await expect(revertMigration(e, 161)).rejects.toThrow(/closed by the owner/);
      await e.query(`UPDATE open_loops SET closed_by = 'reply'`);
      await revertMigration(e, 161);
      for (const t of ["open_loops", "loop_suppressions", "loop_threads"]) expect(await table(e, t)).toBeNull();
      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)).toContain(161);
      expect(await table(e, "open_loops")).toBe("open_loops");
    } finally { await db.close(); }
  });
});
