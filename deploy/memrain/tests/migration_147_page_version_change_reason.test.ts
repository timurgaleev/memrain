import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 147 ${engine.name}`, () => {
  it("preserves old rows through nullable up/down/up and refuses to discard populated reasons", async () => {
    const db = await engine.open();
    const e = db.storage.engine();
    try {
      expect((await e.query("SELECT column_name FROM information_schema.columns WHERE table_name='page_versions' AND column_name='change_reason'")).rows).toHaveLength(1);
      for (const id of discoverMigrations().map(m => m.id).filter(id => id > 147).sort((a, b) => b - a)) await revertMigration(e, id);
      await revertMigration(e, 147);
      await e.exec("INSERT INTO pages(slug,type,markdown_body,content_hash) VALUES ('notes/legacy-reason','note','history','hash'); INSERT INTO page_versions(slug,version_n,hash_new,body_snapshot,compiled_truth_snapshot) VALUES ('notes/legacy-reason',1,'hash','history','{}')");
      const before = (await e.query("SELECT row_to_json(v)::jsonb AS value FROM page_versions v WHERE slug='notes/legacy-reason'")).rows;
      await runMigrations(e);
      expect((await e.query("SELECT to_jsonb(v) - 'change_reason' AS value FROM page_versions v WHERE slug='notes/legacy-reason'")).rows).toEqual(before);
      expect((await e.query("SELECT change_reason FROM page_versions WHERE slug='notes/legacy-reason'")).rows).toEqual([{ change_reason: null }]);
      for (const id of discoverMigrations().map(m => m.id).filter(id => id > 147).sort((a, b) => b - a)) await revertMigration(e, id);
      await e.exec("UPDATE page_versions SET change_reason='preserve this metadata' WHERE slug='notes/legacy-reason'");
      await expect(revertMigration(e, 147)).rejects.toThrow("populated change_reason");
      expect((await e.query("SELECT change_reason FROM page_versions WHERE slug='notes/legacy-reason'")).rows).toEqual([{ change_reason: "preserve this metadata" }]);
      expect((await e.query("SELECT id FROM migrations WHERE id=147")).rows).toHaveLength(1);
    } finally { await db.close(); }
  });
});
