import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60_000);

const table = async (e: Engine, t: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const THREAD = "0f0f0f0f-0000-4000-8000-0000000000c1";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 170 (${name})`, () => {
  it("keeps chat threads per owner, messages per thread, and drops both with the source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "team", kind: "github", pathPrefix: "/team" });
      await e.query(`INSERT INTO chat_threads (id, owner_key, source_id, title) VALUES ($1, 'operator', 'team', 'First')`, [THREAD]);
      await e.query(`INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'user', 'hello')`, [THREAD]);
      await e.query(`INSERT INTO chat_messages (thread_id, role, content, status, cost_usd, saved_slug)
                     VALUES ($1, 'assistant', 'hi', 'ok', 0.0012, 'chats/2026-11-18-first')`, [THREAD]);
      await expect(e.query(`INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'system', 'x')`, [THREAD])).rejects.toThrow();
      await expect(e.query(`INSERT INTO chat_messages (thread_id, role, content, status) VALUES ($1, 'assistant', 'x', 'maybe')`, [THREAD])).rejects.toThrow();
      await e.query(`DELETE FROM sources WHERE id = 'team'`);
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_messages`)).rows[0]!.n).toBe(0);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("reverts and applies again", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 170);
      await revertMigration(e, 170);
      expect(await table(e, "chat_threads")).toBe(false);
      expect(await table(e, "chat_messages")).toBe(false);
      expect((await runMigrations(e)).applied.map(m => m.id)).toContain(170);
      expect(await table(e, "chat_messages")).toBe(true);
    } finally { await db.close(); }
  });
});
