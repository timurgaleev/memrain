import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { diagnosePageIndex } from "../src/core/page-index-state.ts";
import { putPage } from "../src/core/pages.ts";
import { MARKDOWN_CHUNKER_VERSION } from "../src/core/chunkers/recursive.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`page index state ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("orders states by severity, reports gaps and ignores failures older than a successful mirror", async () => {
    const e = db.storage.engine();
    const result = () => diagnosePageIndex(e, "notes/state", "default");
    expect((await result()).verdict).toBe("missing");
    await putPage(db.storage, { slug: "notes/state", title: "State", markdown_body: "PRIVATE BODY" });
    expect((await result()).verdict).toBe("mirror_missing");
    await e.query(`INSERT INTO documents (id, source_path, source_id, frontmatter, chunker_version)
      VALUES ('state-doc', 'page://notes/state', 'default', '{"embed_skip":true,"quarantine":true}', $1)`, [MARKDOWN_CHUNKER_VERSION]);
    await e.query(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/state'`);
    expect((await result()).verdict).toBe("soft-deleted");
    await e.query(`UPDATE pages SET deleted_at = NULL WHERE slug = 'notes/state'`);
    expect((await result()).verdict).toBe("quarantined");
    await e.query(`UPDATE documents SET frontmatter = frontmatter - 'quarantine' WHERE id = 'state-doc'`);
    expect((await result()).verdict).toBe("embed_skip");
    await e.query(`UPDATE documents SET frontmatter = '{}' WHERE id = 'state-doc'`);
    expect((await result()).verdict).toBe("mirror_stale");
    await e.query(`UPDATE documents SET frontmatter = (SELECT jsonb_build_object('page_content_hash', content_hash, 'page_title', title) FROM pages WHERE slug = 'notes/state') WHERE id = 'state-doc'`);
    await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('state-chunk', 'state-doc', 0, 'PRIVATE CHUNK')`);
    expect((await result()).verdict).toBe("chunks_without_vector");
    expect((await result()).sources[0]!.chunks_without_vector).toBe(1);
    await e.query(`INSERT INTO embeddings (chunk_id, vector, model) VALUES ('state-chunk', $1::vector, 'test')`, [JSON.stringify(Array(1024).fill(0.01))]);
    expect((await result()).verdict).toBe("ok");
    await e.query(`INSERT INTO ingest_log (source_type, source_ref, summary, created_at)
      VALUES ('page-mirror-failed', 'notes/state', 'PRIVATE ERROR', now() + interval '1 second')`);
    expect((await result()).verdict).toBe("page-mirror-failed");
    await e.query(`UPDATE documents SET updated_at = now() + interval '2 seconds' WHERE id = 'state-doc'`);
    const recovered = await result();
    expect(recovered.verdict).toBe("ok");
    expect(recovered.sources[0]!.last_mirror_failure_at).not.toBeNull();
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    expect((await diagnosePageIndex(e, "notes/state", "another-source")).verdict).toBe("missing");
  });
});
