import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch, reconcilePageMirrors } from "../src/core/page-index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { buildMirrorAdoptionPlan, applyMirrorAdoptionPlan } from "../src/core/page-mirror-adoption.ts";
import { currentDocumentClock } from "../src/core/generation.ts";

const embedFn = async (text: string) => deterministicEmbed(text);
for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`page mirror adoption (${name})`, () => {
  async function seed(storage: Awaited<ReturnType<typeof open>>["storage"], truth = false) {
    await putPage(storage, { slug: "notes/adopt", title: "Adoption", markdown_body: "Preserved adoption pineapple.",
      compiled_truth: truth ? { summary: "Preserved pineapple understanding." } : {} });
    await indexPageIntoSearch(storage, (await getPage(storage, "notes/adopt"))!, { embedFn });
    await storage.engine().exec("UPDATE documents SET source_id=NULL; UPDATE chunks SET source_id=NULL");
  }
  it("adopts current body and truth mirrors without rechunking or calling an embedder", async () => {
    const db = await open();
    try {
      await seed(db.storage, true);
      const e = db.storage.engine();
      const before = (await e.query("SELECT to_jsonb(c)-'source_id' AS row FROM chunks c ORDER BY id")).rows;
      const vectors = (await e.query("SELECT * FROM embeddings ORDER BY chunk_id, model")).rows;
      expect(await keywordSearch(e, "pineapple", 10, { sourceIds: ["default"] })).toEqual([]);
      let calls = 0;
      await reconcilePageMirrors(db.storage, { embedFn: async text => { calls++; return embedFn(text); } });
      expect(calls).toBe(0);
      expect((await e.query("SELECT source_id FROM documents ORDER BY id")).rows).toEqual([{ source_id: "default" }, { source_id: "default" }]);
      expect((await e.query<{ source_id: string | null }>("SELECT source_id FROM chunks ORDER BY id")).rows.every(row => row.source_id === "default")).toBe(true);
      expect((await e.query("SELECT to_jsonb(c)-'source_id' AS row FROM chunks c ORDER BY id")).rows).toEqual(before);
      expect((await e.query("SELECT * FROM embeddings ORDER BY chunk_id, model")).rows).toEqual(vectors);
      expect((await keywordSearch(e, "pineapple", 10, { sourceIds: ["default"] })).length).toBeGreaterThan(0);
      expect(await keywordSearch(e, "pineapple", 10, { sourceIds: ["foreign"] })).toEqual([]);
      expect(await keywordSearch(e, "pineapple", 10, { sourceIds: [] })).toEqual([]);
    } finally { await db.close(); }
  });
  it("holds stale unowned mirrors instead of replacing old derived text", async () => {
    const db = await open();
    try {
      await seed(db.storage);
      const e = db.storage.engine();
      await putPage(db.storage, { slug: "notes/adopt", markdown_body: "Changed canonical text." });
      const before = (await e.query("SELECT * FROM chunks ORDER BY id")).rows;
      let calls = 0;
      await reconcilePageMirrors(db.storage, { embedFn: async text => { calls++; return embedFn(text); } });
      expect(calls).toBe(0);
      expect((await e.query("SELECT * FROM chunks ORDER BY id")).rows).toEqual(before);
      expect((await e.query("SELECT source_id FROM documents")).rows).toEqual([{ source_id: null }]);
    } finally { await db.close(); }
  });
  it("holds an unowned orphan rather than deleting its bytes", async () => {
    const db = await open();
    try {
      await seed(db.storage);
      const e = db.storage.engine();
      await e.exec("UPDATE pages SET deleted_at=NOW()");
      const before = (await e.query("SELECT * FROM chunks ORDER BY id")).rows;
      await reconcilePageMirrors(db.storage, { embedFn });
      expect((await e.query("SELECT * FROM chunks ORDER BY id")).rows).toEqual(before);
    } finally { await db.close(); }
  });
  it("previews without writes and applies only pinned ownership and generation changes", async () => {
    const db = await open();
    try {
      await seed(db.storage, true);
      const e = db.storage.engine();
      await e.exec("UPDATE documents SET chunker_version=2");
      const snapshot = async () => ({ documents: (await e.query<Record<string, unknown>>("SELECT * FROM documents ORDER BY id")).rows.map(row => ({ ...row, generation: String(row.generation) })),
        chunks: (await e.query<Record<string, unknown> & { id: string; source_id: string | null }>("SELECT * FROM chunks ORDER BY id")).rows,
        pages: (await e.query("SELECT * FROM page_versions ORDER BY slug,version_n")).rows, clock: await currentDocumentClock(e) });
      const before = await snapshot();
      const plan = await buildMirrorAdoptionPlan(e, { source: "default" });
      expect(await snapshot()).toEqual(before);
      expect(plan.targets).toHaveLength(2);
      const result = await applyMirrorAdoptionPlan(db.storage, plan.selection, plan.plan_hash);
      expect(result).toMatchObject({ adopted: 2, document_clock: { before: before.clock, after: before.clock + 1 } });
      expect(result.receipt.flatMap(t => t.chunk_owners)).toEqual(before.chunks.map(c => ({ id: c.id, source_id: c.source_id })));
      const after = await snapshot();
      expect(after.documents).toEqual(before.documents.map(row => ({ ...row, source_id: "default", generation: String(BigInt(row.generation) + 1n) })));
      expect(after.chunks).toEqual(before.chunks.map(row => ({ ...row, source_id: "default" })));
      expect(after.pages).toEqual(before.pages);
      expect((await buildMirrorAdoptionPlan(e, { source: "default" })).targets).toEqual([]);
    } finally { await db.close(); }
  });
  it("rejects a chunk-owner drift after preview and refuses unproved direct mirroring before spend", async () => {
    const db = await open();
    try {
      await seed(db.storage);
      const e = db.storage.engine();
      const plan = await buildMirrorAdoptionPlan(e, { source: "default" });
      await e.exec("UPDATE chunks SET source_id='foreign'");
      await expect(applyMirrorAdoptionPlan(db.storage, plan.selection, plan.plan_hash)).rejects.toThrow("stale");
      expect((await buildMirrorAdoptionPlan(e, { source: "default" })).held).toEqual([{ document_id: plan.targets[0]!.document_id, reason: "foreign_chunk_owner" }]);
      let calls = 0;
      await expect(indexPageIntoSearch(db.storage, (await getPage(db.storage, "notes/adopt"))!,
        { embedFn: async text => { calls++; return embedFn(text); } })).rejects.toThrow("owned by another source");
      expect(calls).toBe(0);
      expect((await e.query("SELECT source_id FROM documents")).rows).toEqual([{ source_id: null }]);
      expect((await e.query("SELECT source_id FROM chunks")).rows).toEqual([{ source_id: "foreign" }]);
    } finally { await db.close(); }
  });
  it("pins embeddings as well as content and rejects stale page versions", async () => {
    const db = await open();
    try {
      await seed(db.storage);
      const e = db.storage.engine();
      const plan = await buildMirrorAdoptionPlan(e, { source: "default" });
      await e.query("UPDATE embeddings SET vector=$1::vector", [JSON.stringify(Array(1024).fill(0.01))]);
      await expect(applyMirrorAdoptionPlan(db.storage, plan.selection, plan.plan_hash)).rejects.toThrow("stale");
      const again = await buildMirrorAdoptionPlan(e, { source: "default" });
      await putPage(db.storage, { slug: "notes/adopt", compiled_truth: { reviewed: true } });
      await expect(applyMirrorAdoptionPlan(db.storage, again.selection, again.plan_hash)).rejects.toThrow("stale");
    } finally { await db.close(); }
  });
  it("rolls back every adoption when a later document cannot be updated", async () => {
    const db = await open();
    try {
      await seed(db.storage, true);
      const e = db.storage.engine();
      const plan = await buildMirrorAdoptionPlan(e, { source: "default" });
      const blocked = plan.targets.at(-1)!.document_id;
      expect(blocked).toMatch(/^doc_[a-f0-9]{16}$/);
      await e.exec(`ALTER TABLE documents ADD CONSTRAINT no_second_adoption CHECK (id <> '${blocked}' OR source_id IS NULL)`);
      const before = (await e.query("SELECT * FROM documents ORDER BY id")).rows;
      const chunks = (await e.query("SELECT * FROM chunks ORDER BY id")).rows;
      const clock = await currentDocumentClock(e);
      await expect(applyMirrorAdoptionPlan(db.storage, plan.selection, plan.plan_hash)).rejects.toThrow("no_second_adoption");
      expect((await e.query("SELECT * FROM documents ORDER BY id")).rows).toEqual(before);
      expect((await e.query("SELECT * FROM chunks ORDER BY id")).rows).toEqual(chunks);
      expect(await currentDocumentClock(e)).toBe(clock);
    } finally { await db.close(); }
  });
  it("holds a canonical path shared by two possible page owners", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await e.exec("INSERT INTO sources(id,kind,path_prefix) VALUES('tenant','other','tenant:fixture')");
      for (const [slug, source_id] of [["tenant/notes/shared", "default"], ["notes/shared", "tenant"]]) {
        await putPage(db.storage, { slug: slug!, source_id: source_id!, title: "Shared", markdown_body: "Ambiguous canonical path." });
      }
      await indexPageIntoSearch(db.storage, (await getPage(db.storage, "tenant/notes/shared"))!, { embedFn });
      await e.exec("UPDATE documents SET source_id=NULL; UPDATE chunks SET source_id=NULL");
      for (const source of ["default", "tenant"]) {
        const plan = await buildMirrorAdoptionPlan(e, { source });
        expect(plan.targets).toEqual([]);
        expect(plan.held.map(h => h.reason)).toEqual(["ambiguous_owner"]);
      }
      expect((await e.query("SELECT source_id FROM documents")).rows).toEqual([{ source_id: null }]);
    } finally { await db.close(); }
  });
});
