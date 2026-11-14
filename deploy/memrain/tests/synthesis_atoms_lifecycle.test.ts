import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { atomPageSlug, contentHash16, extractAtomsPhase } from "../src/core/synthesis/atoms.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";
import { putPage, deletePage, renamePage } from "../src/core/pages.ts";
import type { LlmCallResult } from "../src/core/llm/haiku.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { planAtomRetirement, applyAtomRetirement } from "../src/core/synthesis/atoms-lifecycle.ts";
import { runAtomsRetire } from "../src/commands/atoms-retire.ts";

const H1 = "A source account with enough context to distill. ".repeat(12);
const H2 = "A revised source account with enough context to distill. ".repeat(12);
const output = (titles: string[]) => JSON.stringify(titles.map((title) => ({
  title, atom_type: "insight", body: `${title} from this account.`, concepts: ["shared-topic"],
})));

for (const spec of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`completed atoms ${spec.name}`, () => {
  let db: Awaited<ReturnType<typeof spec.open>>;
  beforeAll(async () => { db = await spec.open(); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.storage.engine().exec(`DELETE FROM synth_concept_atoms; DELETE FROM synth_concepts;
      DELETE FROM synth_atoms; DELETE FROM synth_failures; DELETE FROM pages; DELETE FROM documents;`);
    await db.storage.engine().query(`INSERT INTO documents (id,source_path,source_id,effective_date,frontmatter)
      VALUES ('source','/vault/source.md','default','2026-11-01','{"authored":"preserve"}')`);
    await db.storage.engine().query("INSERT INTO chunks (id,document_id,chunk_index,content) VALUES ('chunk','source',0,$1)", [H1]);
  });

  const engine = () => db.storage.engine();
  const slug = (title: string) => atomPageSlug("source", "2026-11-01", title);
  const run = (titles: string[]) => extractAtomsPhase(engine(), {
    storage: db.storage, llmFn: async () => ({ text: output(titles), modelId: "fake" }),
  });
  async function edit(text = H2) {
    await engine().query("UPDATE chunks SET content = $1 WHERE id = 'chunk'", [text]);
  }
  async function state() {
    return {
      documents: (await engine().query("SELECT frontmatter FROM documents ORDER BY id")).rows,
      pages: (await engine().query("SELECT slug,markdown_body,compiled_truth,deleted_at::text FROM pages ORDER BY slug")).rows,
      versions: (await engine().query("SELECT slug,version_n,body_snapshot,compiled_truth_snapshot FROM page_versions ORDER BY slug,version_n")).rows,
      atoms: (await engine().query("SELECT atom_key,source_hash,body FROM synth_atoms ORDER BY atom_key")).rows,
    };
  }
  async function watermark() {
    return (await engine().query<{ frontmatter: Record<string, unknown> }>("SELECT frontmatter FROM documents WHERE id = 'source'"))
      .rows[0]!.frontmatter;
  }

  it("publishes complete source manifests, retires only obsolete pages and keeps all historical rows", async () => {
    expect((await run(["A", "B"])).errors).toEqual([]);
    expect((await engine().query("SELECT DISTINCT written_by_principal FROM page_versions")).rows)
      .toEqual([{ written_by_principal: "operator" }]);
    expect(await watermark()).toMatchObject({ authored: "preserve", atoms_completed_hash: contentHash16(H1) });
    const first = await state();
    await edit();
    expect((await run(["A", "C"])).errors).toEqual([]);
    expect(await watermark()).toMatchObject({ authored: "preserve", atoms_completed_hash: contentHash16(H2) });
    const rows = await engine().query<{ slug: string; deleted: boolean }>("SELECT slug,deleted_at IS NOT NULL AS deleted FROM pages ORDER BY slug");
    expect(rows.rows).toEqual([
      { slug: slug("A"), deleted: false }, { slug: slug("B"), deleted: true }, { slug: slug("C"), deleted: false },
    ]);
    const second = await state();
    expect(second.atoms).toHaveLength(4);
    expect(second.versions).toHaveLength(5);
    for (const row of first.atoms) expect(second.atoms).toContainEqual(row);
    for (const row of first.versions) expect(second.versions).toContainEqual(row);
    expect((await synthesizeConceptsPhase(engine(), { storage: db.storage })).atomsSeen).toBe(2);
    expect((await engine().query("SELECT written_by_principal FROM page_versions WHERE slug = 'concepts/shared-topic'")).rows)
      .toEqual([{ written_by_principal: "operator" }]);
    expect((await engine().query<{ atom_count: number }>("SELECT atom_count FROM synth_concepts")).rows[0]!.atom_count).toBe(2);
    let calls = 0;
    const unchanged = await extractAtomsPhase(engine(), { storage: db.storage, llmFn: async () => {
      calls++; return { text: output(["Unexpected"]), modelId: "fake" };
    } });
    expect(unchanged.documentsScanned).toBe(0);
    expect(calls).toBe(0);
  });

  for (const [label, response] of Object.entries<Record<string, unknown>>({
    empty: { text: "[]" }, shrink: { text: output(["A"]) }, malformed: { text: '[{"title":"Partial"' },
    partial_element: { text: JSON.stringify([{ title: "A", body: "valid" }, { title: "broken" }]) },
    duplicate_identity: { text: JSON.stringify([{ title: "A", body: "same" }, { title: "B", body: "same" }]) },
    over_cap: { text: output(["A", "B", "C", "D"]) }, prose: { text: `Fallback ${output(["A", "B"])}` },
    unclosed_fence: { text: `\`\`\`json\n${output(["A", "B"])}` },
    truncated: { text: output(["A", "B"]), stopReason: "max_tokens" },
  })) it(`preserves prior pages, rows and completion after ${label}`, async () => {
    await run(["A", "B", "C"]);
    const before = await state();
    await edit();
    const result = await extractAtomsPhase(engine(), { storage: db.storage,
      llmFn: async () => ({ ...response, modelId: "fake" } as LlmCallResult) });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await state()).toEqual(before);
    expect((await engine().query("SELECT doc_id FROM synth_failures WHERE phase = 'extract_atoms'")).rows).toHaveLength(1);
  });

  it("does not pay for capped input or overwrite the prior completion", async () => {
    await run(["A", "B"]);
    const before = await state();
    await edit("L".repeat(50_001));
    let calls = 0;
    const result = await extractAtomsPhase(engine(), { storage: db.storage, llmFn: async () => {
      calls++; return { text: output(["A", "C"]), modelId: "fake" };
    } });
    expect(calls).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await state()).toEqual(before);
  });

  it("preserves completed pages when the source becomes too short to extract", async () => {
    await run(["A", "B"]);
    const before = await state();
    await edit("");
    let calls = 0;
    await extractAtomsPhase(engine(), { storage: db.storage, llmFn: async () => {
      calls++; return { text: "[]", modelId: "fake" };
    } });
    expect(calls).toBe(0);
    expect(await state()).toEqual(before);
  });

  for (const change of ["hash", "owner", "quarantine", "deleted"] as const) it(`refuses source ${change} drift while the model runs`, async () => {
    await run(["A", "B"]);
    await edit();
    const before = await state();
    const result = await extractAtomsPhase(engine(), { storage: db.storage, llmFn: async () => {
      if (change === "hash") await edit("Another changed source with different evidence. ".repeat(15));
      if (change === "owner") await engine().query("UPDATE documents SET source_id = NULL WHERE id = 'source'");
      if (change === "quarantine") await engine().query(`UPDATE documents SET frontmatter = frontmatter || '{"quarantine":{}}' WHERE id = 'source'`);
      if (change === "deleted") await engine().query("UPDATE documents SET deleted_at = now() WHERE id = 'source'");
      return { text: output(["A", "C"]), modelId: "fake" };
    } });
    expect(result.errors.length).toBeGreaterThan(0);
    const after = await state();
    expect(after.pages).toEqual(before.pages);
    expect(after.versions).toEqual(before.versions);
    expect(after.atoms).toEqual(before.atoms);
    expect((await watermark()).atoms_completed_hash).toBe(contentHash16(H1));
  });

  it("holds a manually edited obsolete page while completing its source", async () => {
    await run(["A", "B"]);
    await putPage(db.storage, { slug: slug("B"), markdown_body: "Authored correction", written_by: "operator" });
    await edit();
    await run(["A", "C"]);
    expect((await engine().query("SELECT markdown_body,deleted_at FROM pages WHERE slug = $1", [slug("B")])).rows)
      .toEqual([{ markdown_body: "Authored correction", deleted_at: null }]);
    expect((await watermark()).atoms_completed_hash).toBe(contentHash16(H2));
  });

  it("never maps a NULL source owner to a default-owned atom page", async () => {
    await engine().query("UPDATE documents SET source_id = NULL WHERE id = 'source'");
    const result = await run(["A", "B"]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect((await state()).pages).toEqual([]);
    expect((await watermark()).atoms_completed_hash).toBeUndefined();
  });

  it("rolls back all new atom rows when a later insert fails and retains completion", async () => {
    await run(["A", "B"]);
    await edit();
    await engine().exec(`CREATE FUNCTION reject_second_atom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title = 'Fail' THEN RAISE EXCEPTION 'injected row failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_atom BEFORE INSERT ON synth_atoms FOR EACH ROW EXECUTE FUNCTION reject_second_atom();`);
    try {
      const before = (await state()).atoms;
      expect((await run(["A", "Fail"])).errors.length).toBeGreaterThan(0);
      expect((await state()).atoms).toEqual(before);
      expect((await watermark()).atoms_completed_hash).toBe(contentHash16(H1));
      expect((await engine().query("SELECT slug FROM pages WHERE deleted_at IS NOT NULL")).rows).toEqual([]);
    } finally {
      await engine().exec("DROP TRIGGER reject_second_atom ON synth_atoms; DROP FUNCTION reject_second_atom();");
    }
  });

  it("leaves earlier successful page versions auditable and retries an incomplete run", async () => {
    await run(["A", "B"]);
    await edit();
    await engine().exec(`CREATE FUNCTION reject_atom_page() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title = 'Fail' THEN RAISE EXCEPTION 'injected page failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_atom_page BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION reject_atom_page();`);
    try {
      expect((await run(["A", "Fail"])).errors.length).toBeGreaterThan(0);
      expect((await watermark()).atoms_completed_hash).toBe(contentHash16(H1));
      expect((await state()).atoms).toHaveLength(2);
      expect((await engine().query("SELECT slug FROM pages WHERE deleted_at IS NOT NULL")).rows).toEqual([]);
    } finally {
      await engine().exec("DROP TRIGGER reject_atom_page ON pages; DROP FUNCTION reject_atom_page();");
    }
    await engine().query("UPDATE synth_failures SET next_eligible_at = now() - interval '1 second'");
    expect((await run(["A", "Fail"])).errors).toEqual([]);
    expect((await watermark()).atoms_completed_hash).toBe(contentHash16(H2));
    expect((await state()).atoms).toHaveLength(4);
  });

  it("keeps legacy same-hash skip and includes legacy atoms in concepts", async () => {
    await engine().query(`INSERT INTO synth_atoms (atom_key,source_ref,source_kind,source_hash,title,body,atom_type,concepts,model_id)
      VALUES ('legacy','source','document',$1,'Legacy','Legacy body','insight','["shared-topic"]','fake')`, [contentHash16(H1)]);
    let calls = 0;
    await extractAtomsPhase(engine(), { llmFn: async () => { calls++; return { text: "[]", modelId: "fake" }; } });
    expect(calls).toBe(0);
    expect((await watermark()).atoms_completed_hash).toBeUndefined();
    expect((await synthesizeConceptsPhase(engine())).atomsSeen).toBe(1);
  });

  it("does not let an invalid completion manifest hide legacy concept evidence", async () => {
    await engine().query(`INSERT INTO synth_atoms (atom_key,source_ref,source_kind,source_hash,title,body,atom_type,concepts,model_id)
      VALUES ('legacy','source','document','old','Legacy','Legacy body','insight','["shared-topic"]','fake')`);
    await engine().query(`UPDATE documents SET frontmatter = '{"atoms_completed_hash":"0000000000000000",
      "atoms_completed_pages":[{"slug":"invalid"}]}' WHERE id = 'source'`);
    expect((await synthesizeConceptsPhase(engine())).atomsSeen).toBe(1);
  });

  it("preserves completion on real reindex and rejects caller-supplied completion keys", async () => {
    await run(["A", "B"]);
    const previous = await watermark();
    await writeDocumentTransaction(db.storage, {
      documentId: "source", sourcePath: "/vault/source.md", sourceId: "default", title: "Source",
      frontmatter: { authored: "updated", atoms_completed_hash: "0000000000000000", atoms_completed_pages: [] },
    }, [{ text: H2, entities: [] }]);
    expect(await watermark()).toEqual({ ...previous, authored: "updated" });
    expect((await run(["A", "C"])).errors).toEqual([]);
    expect((await watermark()).atoms_completed_hash).toBe(contentHash16(H2));
    await writeDocumentTransaction(db.storage, {
      documentId: "untrusted", sourcePath: "/vault/untrusted.md", sourceId: "default", title: "Untrusted",
      frontmatter: { atoms_completed_hash: contentHash16(H1), atoms_completed_pages: [] },
    }, [{ text: H1, entities: [] }]);
    expect((await engine().query<{ frontmatter: unknown }>("SELECT frontmatter FROM documents WHERE id = 'untrusted'")).rows[0]!.frontmatter)
      .toEqual({});
  });

  it("publishes rows-only completion without retiring any existing pages", async () => {
    await run(["A", "B"]);
    const pages = (await state()).pages;
    await edit();
    expect((await extractAtomsPhase(engine(), { llmFn: async () => ({ text: output(["A", "C"]), modelId: "fake" }) })).errors).toEqual([]);
    expect((await state()).pages).toEqual(pages);
    expect(await watermark()).toMatchObject({ atoms_completed_hash: contentHash16(H2), atoms_completed_pages: [] });
    expect((await synthesizeConceptsPhase(engine())).atomsSeen).toBe(2);
  });

  it("does not retire pages when synthesis pages are disabled", async () => {
    await run(["A", "B"]);
    const before = (await state()).pages;
    await edit();
    const prior = process.env.MEMRAIN_SYNTH_PAGES;
    process.env.MEMRAIN_SYNTH_PAGES = "0";
    try { expect((await run(["A", "C"])).errors).toEqual([]); }
    finally {
      if (prior === undefined) delete process.env.MEMRAIN_SYNTH_PAGES;
      else process.env.MEMRAIN_SYNTH_PAGES = prior;
    }
    expect((await state()).pages).toEqual(before);
  });

  it("holds unproven legacy pages and never treats a spoofed writer as automatic", async () => {
    await putPage(db.storage, { slug: slug("A"), type: "atom", allowAdHocType: true,
      title: "A", markdown_body: "Manually supplied content", written_by: "extract-atoms" });
    const result = await run(["A", "B"]);
    const current = await engine().query("SELECT markdown_body FROM pages WHERE slug = $1", [slug("A")]);
    expect(current.rows).toEqual([{ markdown_body: "Manually supplied content" }]);
    expect((await watermark()).atoms_completed_pages).toHaveLength(1);
    expect(result.heldPages).toEqual([{ slug: slug("A"), reason: "held_legacy" }]);
  });

  for (const change of ["edit", "delete", "rename"] as const) it(`holds a stale canonical source after page ${change}`, async () => {
    const page = await putPage(db.storage, { slug: "notes/origin", title: "Origin", markdown_body: H1 });
    await engine().query(`UPDATE documents SET source_path = 'page://notes/origin',
      frontmatter = jsonb_build_object('page_content_hash',$1::text,'page_title','Origin') WHERE id = 'source'`, [page.content_hash]);
    const result = await extractAtomsPhase(engine(), { storage: db.storage, llmFn: async () => {
      if (change === "edit") await putPage(db.storage, { slug: "notes/origin", markdown_body: H2 });
      if (change === "delete") await deletePage(db.storage, "notes/origin");
      if (change === "rename") await renamePage(db.storage, "notes/origin", "notes/moved", { manual: true });
      return { text: output(["A", "B"]), modelId: "fake" };
    } });
    expect(result.errors.length).toBeGreaterThan(0);
    expect((await engine().query("SELECT slug FROM pages WHERE type = 'atom'")).rows).toEqual([]);
    expect((await engine().query("SELECT atom_key FROM synth_atoms")).rows).toEqual([]);
  });

  it("pins explicit retirement previews and refuses stale target versions", async () => {
    await run(["A", "B"]);
    await edit();
    await extractAtomsPhase(engine(), { llmFn: async () => ({ text: output(["A", "C"]), modelId: "fake" }) });
    const before = await state();
    const plan = await planAtomRetirement(engine(), "source", contentHash16(H2));
    expect(plan.eligible.map((p) => p.slug)).toEqual([slug("A"), slug("B")]);
    expect(await state()).toEqual(before);
    await putPage(db.storage, { slug: slug("B"), markdown_body: "Manual edit", written_by: "operator" });
    await expect(applyAtomRetirement(db.storage, plan)).rejects.toThrow("plan changed");
    expect((await engine().query("SELECT slug FROM pages WHERE deleted_at IS NOT NULL")).rows).toEqual([]);
    const fresh = await planAtomRetirement(engine(), "source", contentHash16(H2));
    expect(fresh.held).toEqual([{ slug: slug("B"), reason: "authored_or_unproven" }]);
    expect(await applyAtomRetirement(db.storage, fresh)).toMatchObject({ retired: 1, held: 1,
      targets: [{ slug: slug("A"), status: "retired" }, { slug: slug("B"), status: "held" }] });
    expect((await state()).atoms).toHaveLength(4);
  });

  it("bounds explicit retirement previews to one hundred proven targets", async () => {
    await run(["A", "B"]);
    await engine().query(`INSERT INTO pages (slug,type,title,compiled_truth,markdown_body,content_hash,source_id)
      SELECT 'atoms/extra/' || i::text,p.type,p.title,p.compiled_truth,p.markdown_body,p.content_hash,p.source_id
      FROM pages p CROSS JOIN generate_series(1,101) i WHERE p.slug = $1`, [slug("A")]);
    await engine().query(`INSERT INTO page_versions
      (slug,version_n,hash_new,body_snapshot,compiled_truth_snapshot,written_by,written_by_principal,source_id)
      SELECT p.slug,1,p.content_hash,p.markdown_body,p.compiled_truth,'extract-atoms','operator',p.source_id
      FROM pages p WHERE p.slug LIKE 'atoms/extra/%'`);
    await edit();
    await extractAtomsPhase(engine(), { llmFn: async () => ({ text: output(["A", "C"]), modelId: "fake" }) });
    const before = await state();
    const plan = await planAtomRetirement(engine(), "source", contentHash16(H2));
    expect(plan.eligible).toHaveLength(100);
    expect(plan.truncated).toBe(true);
    expect(await state()).toEqual(before);
  });

  it("retires at most one hundred pages across an entire extraction phase", async () => {
    await engine().query(`INSERT INTO documents (id,source_path,source_id,effective_date)
      SELECT 'source-' || i::text,'/vault/source-' || i::text || '.md','default','2026-11-01' FROM generate_series(1,50) i`);
    await engine().query(`INSERT INTO chunks (id,document_id,chunk_index,content)
      SELECT id || '-chunk',id,0,$1 FROM documents WHERE id <> 'source'`, [H1]);
    const options = { storage: db.storage, maxDocs: 60 };
    await extractAtomsPhase(engine(), { ...options, llmFn: async () => ({ text: output(["A", "B"]), modelId: "fake" }) });
    await engine().query("UPDATE chunks SET content = $1", [H2]);
    const result = await extractAtomsPhase(engine(), { ...options,
      llmFn: async () => ({ text: output(["C", "D"]), modelId: "fake" }) });
    expect(result.errors).toEqual([]);
    expect(result.pagesRetired).toBe(100);
    expect(result.pagesHeld).toBe(2);
    expect((await engine().query("SELECT slug FROM pages WHERE deleted_at IS NOT NULL")).rows).toHaveLength(100);
    expect((await state()).atoms).toHaveLength(204);
  }, 30_000);

  it("defaults the operator command to a write-free preview and requires its exact hash to apply", async () => {
    await run(["A", "B"]);
    await edit();
    await extractAtomsPhase(engine(), { llmFn: async () => ({ text: output(["A", "C"]), modelId: "fake" }) });
    const opts = { sourceRef: "source", completedHash: contentHash16(H2), storage: db.storage };
    const before = await state();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runAtomsRetire({ ...opts, apply: true })).rejects.toThrow("plan hash");
      expect(await runAtomsRetire(opts)).toBe(0);
      const preview = JSON.parse(log.mock.calls.at(-1)![0]);
      expect(preview).toMatchObject({ dry_run: true, eligible: [{ slug: slug("A") }, { slug: slug("B") }] });
      expect(await state()).toEqual(before);
      await expect(runAtomsRetire({ ...opts, apply: true, planHash: "0".repeat(64) })).rejects.toThrow("stale plan");
      expect(await state()).toEqual(before);
      expect(await runAtomsRetire({ ...opts, apply: true, planHash: preview.plan_hash })).toBe(0);
      expect((await engine().query("SELECT slug FROM pages WHERE deleted_at IS NOT NULL")).rows).toHaveLength(2);
      expect((await state()).atoms).toEqual(before.atoms);
    } finally { log.mockRestore(); }
  });

  if (spec.name === "Postgres") it("never waits for a busy slug while holding the source document", async () => {
    await run(["A", "B"]);
    await edit();
    const before = await state();
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = engine().transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memrain:page:${slug("A")}`]);
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    try {
      const result = await run(["A", "C"]);
      expect(result.errors.join(" ")).toContain("source_busy");
      expect(await state()).toEqual(before);
    } finally { release.resolve(); await lock; }
  });
});
