import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { checkEmbedBacklog } from "../src/core/doctor-embed.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact backlog ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("counts only live eligible facts and warns only when the backlog is old and large", async () => {
    const e = db.storage.engine();
    await e.query(`INSERT INTO pages (slug, type, title, markdown_body, content_hash, deleted_at)
      VALUES ('notes/deleted', 'note', 'Deleted', '', 'h', now())`);
    await e.query(`INSERT INTO entity_facts (entity_slug, fact, written_at)
      SELECT 'people/example', 'fact ' || g, now() FROM generate_series(1, 1001) g`);
    await e.query(`INSERT INTO entity_facts (entity_slug, fact, written_at, forgotten_at, source_slug)
      VALUES ('people/example', 'retired', now() - interval '48 hours', now(), NULL),
             ('people/example', 'deleted origin', now() - interval '48 hours', NULL, 'notes/deleted')`);
    const young = await checkEmbedBacklog(e);
    expect(young.status).toBe("ok");
    expect(young.detail).toContain("1001 of 1001 eligible live fact(s)");
    await e.query(`UPDATE entity_facts SET written_at = now() - interval '48 hours'`);
    const old = await checkEmbedBacklog(e);
    expect(old).toMatchObject({ ok: true, status: "warn" });
    expect(old.detail).toContain("1001 of 1001 eligible live fact(s)");
    expect(old.detail).toContain("memrain cycle --phases embed-facts");
    await e.query(`UPDATE entity_facts SET forgotten_at = now() WHERE fact = 'fact 1'`);
    expect((await checkEmbedBacklog(e)).status).toBe("ok");
  });
});
