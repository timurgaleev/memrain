import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { registerSource, SOURCE_KINDS } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";

/** Only the latest migration can be reverted, so later ones go first. */
async function revertLaterThan151(e: Engine): Promise<void> {
  for (const id of discoverMigrations().map(m => m.id).filter(id => id > 151).sort((a, b) => b - a)) await revertMigration(e, id);
}

const kindCheck = async (e: Engine) => (await e.query<{ def: string }>(
  `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname = 'sources_kind_check' AND conrelid = 'sources'::regclass`)).rows[0]?.def ?? "";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 151 (${name})`, () => {
  it("admits the chat and meeting source kinds the connectors write into", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(SOURCE_KINDS).toContain("chat");
      expect(SOURCE_KINDS).toContain("meeting");
      await registerSource(e, { id: "slack-team", kind: "chat", pathPrefix: "chat/team/" });
      await registerSource(e, { id: "meetings", kind: "meeting", pathPrefix: "meeting/acme/" });
      const kinds = (await e.query<{ kind: string }>("SELECT kind FROM sources WHERE id IN ('slack-team','meetings') ORDER BY id")).rows;
      expect(kinds.map(r => r.kind)).toEqual(["meeting", "chat"]);
    } finally { await db.close(); }
  });

  it("refuses its down while a chat or meeting source exists, and round-trips once they are gone", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan151(e);
      await registerSource(e, { id: "slack-team", kind: "chat", pathPrefix: "chat/team/" });
      await expect(revertMigration(e, 151)).rejects.toThrow("chat or meeting");
      expect(await kindCheck(e)).toContain("chat");

      await e.exec("DELETE FROM sources WHERE id = 'slack-team'");
      await revertMigration(e, 151);
      expect(await kindCheck(e)).not.toContain("chat");
      expect(await kindCheck(e)).toContain("github");
      await expect(e.exec("INSERT INTO sources (id, kind, path_prefix) VALUES ('m', 'meeting', 'meeting/x/')")).rejects.toThrow();

      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)[0]).toBe(151);
      expect(await kindCheck(e)).toContain("meeting");
    } finally { await db.close(); }
  });
});
