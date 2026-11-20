import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60_000);

const table = async (e: Engine, t: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t])).rows[0]!.n === 1;
const count = async (e: Engine, t: string) => (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const THREAD = "0f0f0f0f-0000-4000-8000-0000000000d1";
const HASH = "a".repeat(64);

async function page(e: Engine, slug: string, source: string): Promise<void> {
  await e.query(`INSERT INTO pages (slug, type, title, content_hash, source_id) VALUES ($1, 'note', $1, 'h1', $2)`, [slug, source]);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 174-175 (${name})`, () => {
  it("keeps feedback and weights per source and page, and drops them with the page or the source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "team", kind: "github", pathPrefix: "/team" });
      await page(e, "notes/a", "team");
      await page(e, "notes/b", "team");
      for (const slug of ["notes/a", "notes/b"]) {
        await e.query(`INSERT INTO retrieval_feedback (source_id, slug, principal_hash, tier, rating, signal) VALUES ('team', $1, $2, 'owner', 1, 'explicit')`, [slug, HASH]);
        await e.query(`INSERT INTO retrieval_weights (source_id, slug, weight, n, content_hash) VALUES ('team', $1, 0.6, 1, 'h1')`, [slug]);
      }
      await expect(e.query(`INSERT INTO retrieval_feedback (source_id, slug, principal_hash, tier, rating, signal) VALUES ('team', 'notes/a', $1, 'owner', 2, 'explicit')`, [HASH])).rejects.toThrow();
      await expect(e.query(`INSERT INTO retrieval_feedback (source_id, slug, principal_hash, tier, rating, signal) VALUES ('team', 'notes/a', $1, 'owner', 1, 'cited')`, [HASH])).rejects.toThrow();
      await expect(e.query(`INSERT INTO retrieval_feedback (source_id, slug, principal_hash, tier, rating, signal) VALUES ('team', 'notes/a', 'operator', 'owner', 1, 'explicit')`)).rejects.toThrow();
      await expect(e.query(`INSERT INTO retrieval_weights (source_id, slug, weight, n) VALUES ('team', 'notes/nope', 0.5, 0)`)).rejects.toThrow();
      await e.query(`DELETE FROM pages WHERE slug = 'notes/a'`);
      expect(await count(e, "retrieval_feedback")).toBe(1);
      expect(await count(e, "retrieval_weights")).toBe(1);
      await e.query(`DELETE FROM pages WHERE source_id = 'team'`);
      await e.query(`DELETE FROM sources WHERE id = 'team'`);
      expect(await count(e, "retrieval_feedback")).toBe(0);
      expect(await count(e, "retrieval_weights")).toBe(0);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("keeps a share per answer and drops it with the answer", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.query(`INSERT INTO chat_threads (id, owner_key, source_id, title) VALUES ($1, 'operator', 'default', 'First')`, [THREAD]);
      const m = await e.query<{ id: number }>(`INSERT INTO chat_messages (thread_id, role, content, status) VALUES ($1, 'assistant', 'hi', 'ok') RETURNING id`, [THREAD]);
      const id = Number(m.rows[0]!.id);
      await e.query(`INSERT INTO chat_shares (token_hash, message_id, owner_key, password_hash, expires_at) VALUES ($1, $2, 'operator', 'x', NOW() + interval '7 days')`, [HASH, id]);
      await expect(e.query(`INSERT INTO chat_shares (token_hash, message_id, owner_key, password_hash, expires_at) VALUES ('short', $1, 'operator', 'x', NOW())`, [id])).rejects.toThrow();
      await e.query(`DELETE FROM chat_threads WHERE id = $1`, [THREAD]);
      expect(await count(e, "chat_shares")).toBe(0);
    } finally { await db.close(); }
  });

  it("reverts and applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 174);
      expect(await table(e, "chat_shares")).toBe(false);
      await revertMigration(e, 174);
      expect(await table(e, "retrieval_feedback")).toBe(false);
      expect(await table(e, "retrieval_weights")).toBe(false);
      expect((await runMigrations(e)).applied.map(m => m.id).slice(0, 2)).toEqual([174, 175]);
      expect(await table(e, "retrieval_weights")).toBe(true);
      expect(await table(e, "chat_shares")).toBe(true);
    } finally { await db.close(); }
  });
});
