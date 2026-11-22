/**
 * A purge takes with it what synthesis derived from the purged source: its
 * atoms, the atom pages published from them, takes, contradiction rows, and
 * the concepts narrated over them. A concept that keeps live members is
 * rebuilt from them; one left with none is retired. A page someone edited is
 * kept. The concepts phase ignores atoms whose source is gone or hidden, and
 * a concept hidden by a purge comes back once live atoms carry its tag again.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Storage } from "../src/core/storage.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { purgeExpiredDocuments } from "../src/core/destructive-guard.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";

let storage: Storage;
let engine: Engine;

let n = 0;
async function doc(id: string): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, source_id) VALUES ($1, $2, 'default')`, [id, `/vault/${id}.md`]);
}
async function atom(sourceRef: string, title: string, concepts: string[], kind = "document"): Promise<number> {
  n += 1;
  const r = await engine.query<{ id: number }>(
    `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, concepts, model_id)
     VALUES ($1, $2, $3, 'h', $4, $5, $6::text::jsonb, 'm') RETURNING id`,
    [`key-${n}`, sourceRef, kind, title, `body of ${title}`, JSON.stringify(concepts)],
  );
  return Number(r.rows[0]!.id);
}
async function concept(slug: string, narrative: string, atomIds: number[]): Promise<void> {
  await engine.query(`INSERT INTO synth_concepts (concept_slug, title, narrative, atom_count, model_id) VALUES ($1, $1, $2, $3, 'm')`,
    [slug, narrative, atomIds.length]);
  for (const id of atomIds) await engine.query(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) VALUES ($1, $2)`, [slug, id]);
  await putPage(storage, { slug: `concepts/${slug}`, type: "concept", title: slug, markdown_body: `${narrative}\n`,
    written_by: "synthesize-concepts", written_by_principal: "operator" });
}
async function take(sourceRef: string, claim: string): Promise<void> {
  n += 1;
  await engine.query(`INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
    VALUES ($1, $2, 'h', 'v1', $3, 'm')`, [`take-${n}`, sourceRef, claim]);
}
async function softDeleteDoc(id: string): Promise<void> {
  await engine.query(`UPDATE documents SET deleted_at = NOW() - interval '1 hour' WHERE id = $1`, [id]);
}
async function pageRow(slug: string): Promise<{ markdown_body: string; deleted_at: string | null } | undefined> {
  return (await engine.query<{ markdown_body: string; deleted_at: string | null }>(
    `SELECT markdown_body, deleted_at::text AS deleted_at FROM pages WHERE slug = $1`, [slug])).rows[0];
}
const ids = async (sql: string, params: unknown[] = []) => (await engine.query<{ id: string }>(sql, params)).rows.map(r => String(r.id));

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(name, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    db = await open();
    storage = db.storage;
    engine = storage.engine();
  });
  afterEach(async () => { await db.close(); });

describe("document purge retires what synthesis derived from it", () => {
  it("deletes the atoms and takes of the purged document and keeps the rest", async () => {
    await doc("doc_gone"); await doc("doc_live");
    const gone = await atom("doc_gone", "Gone claim", ["alpha"]);
    const live = await atom("doc_live", "Live claim", ["alpha"]);
    await take("doc_gone", "gone take"); await take("doc_live", "live take");
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    expect(await ids(`SELECT id FROM synth_atoms ORDER BY id`)).toEqual([String(live)]);
    expect(await ids(`SELECT claim_text AS id FROM synth_takes`)).toEqual(["live take"]);
    expect(gone).toBeGreaterThan(0);
  });

  it("rebuilds a concept from the members it keeps, without the purged atom's text", async () => {
    await doc("doc_gone"); await doc("doc_live");
    const gone = await atom("doc_gone", "Secret purged insight", ["alpha"]);
    const live1 = await atom("doc_live", "Kept insight one", ["alpha"]);
    const live2 = await atom("doc_live", "Kept insight two", ["alpha"]);
    await concept("alpha", "Narrative quoting Secret purged insight", [gone, live1, live2]);
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    const row = (await engine.query<{ narrative: string; atom_count: number; member_hash: string | null }>(
      `SELECT narrative, atom_count, member_hash FROM synth_concepts WHERE concept_slug = 'alpha'`)).rows[0]!;
    expect(row.narrative).not.toContain("Secret purged insight");
    expect(row.narrative).toContain("Kept insight one");
    expect(Number(row.atom_count)).toBe(2);
    expect(row.member_hash).toBeNull();
    expect(await ids(`SELECT atom_id AS id FROM synth_concept_atoms WHERE concept_slug = 'alpha' ORDER BY atom_id`))
      .toEqual([String(live1), String(live2)]);
    const page = await pageRow("concepts/alpha");
    expect(page?.deleted_at).toBeNull();
    expect(page?.markdown_body).not.toContain("Secret purged insight");
    expect(page?.markdown_body).toContain("Kept insight two");
  });

  it("rebuilds a concept left with a single member instead of deleting it", async () => {
    await doc("doc_gone"); await doc("doc_live");
    const gone = await atom("doc_gone", "Purged one", ["solo"]);
    const live = await atom("doc_live", "Survivor", ["solo"]);
    await concept("solo", "Purged one and Survivor", [gone, live]);
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    const row = (await engine.query<{ narrative: string }>(`SELECT narrative FROM synth_concepts WHERE concept_slug = 'solo'`)).rows[0];
    expect(row?.narrative).toContain("Survivor");
    expect(row?.narrative).not.toContain("Purged one");
    expect((await pageRow("concepts/solo"))?.deleted_at).toBeNull();
  });

  it("drops the links of members whose source is deleted, keeping them out of the rebuilt narrative", async () => {
    await doc("doc_gone"); await doc("doc_live"); await doc("doc_hidden");
    const gone = await atom("doc_gone", "Purged member", ["links"]);
    const live = await atom("doc_live", "Live member", ["links"]);
    const hidden = await atom("doc_hidden", "Hidden member", ["links"]);
    await concept("links", "Purged member, Live member, Hidden member", [gone, live, hidden]);
    await engine.query(`UPDATE documents SET deleted_at = NOW() - interval '48 hours' WHERE id = 'doc_gone'`);
    await engine.query(`UPDATE documents SET deleted_at = NOW() WHERE id = 'doc_hidden'`);
    await purgeExpiredDocuments(engine, 24);
    expect(await ids(`SELECT atom_id AS id FROM synth_concept_atoms WHERE concept_slug = 'links'`)).toEqual([String(live)]);
    expect(await ids(`SELECT id FROM synth_atoms ORDER BY id`)).toEqual([String(gone), String(live), String(hidden)].filter((id) => id !== String(gone)));
    const row = (await engine.query<{ narrative: string }>(`SELECT narrative FROM synth_concepts WHERE concept_slug = 'links'`)).rows[0]!;
    expect(row.narrative).not.toContain("Hidden member");
  });

  it("retires a concept whose members are all gone, hiding its page", async () => {
    await doc("doc_gone");
    const a = await atom("doc_gone", "Only purged one", ["empty"]);
    const b = await atom("doc_gone", "Only purged two", ["empty"]);
    await concept("empty", "Only purged one, Only purged two", [a, b]);
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    expect(await ids(`SELECT concept_slug AS id FROM synth_concepts`)).toEqual([]);
    expect((await pageRow("concepts/empty"))?.deleted_at).not.toBeNull();
    const mirrors = await engine.query(`SELECT 1 FROM documents WHERE source_path LIKE 'page%://concepts/empty'`);
    expect(mirrors.rows.length).toBe(0);
  });

  it("keeps a concept page someone edited, while still rebuilding the concept row", async () => {
    await doc("doc_gone"); await doc("doc_live");
    const gone = await atom("doc_gone", "Purged member", ["edited"]);
    const live = await atom("doc_live", "Live member", ["edited"]);
    await concept("edited", "Purged member and Live member", [gone, live]);
    await putPage(storage, { slug: "concepts/edited", markdown_body: "My own notes on this concept.\n", written_by: "mcp", written_by_principal: "alice" });
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    expect((await pageRow("concepts/edited"))?.markdown_body).toBe("My own notes on this concept.\n");
    const row = (await engine.query<{ narrative: string }>(`SELECT narrative FROM synth_concepts WHERE concept_slug = 'edited'`)).rows[0];
    expect(row?.narrative).not.toContain("Purged member");
  });

  it("retires the atom pages published from the purged document, legacy ones included", async () => {
    await doc("doc_gone");
    await atom("doc_gone", "Legacy atom", ["x"]);
    await putPage(storage, { slug: "atoms/2026-07-01/legacy-atom-aaaaaaaa", type: "atom", allowAdHocType: true, title: "Legacy atom",
      markdown_body: "body of Legacy atom\n\n---\nSource: doc_gone (0123456789abcdef)", written_by: "extract-atoms" });
    await putPage(storage, { slug: "atoms/2026-07-01/edited-atom-bbbbbbbb", type: "atom", allowAdHocType: true, title: "Edited atom",
      markdown_body: "body\n\n---\nSource: doc_gone (0123456789abcdef)", written_by: "extract-atoms" });
    await putPage(storage, { slug: "atoms/2026-07-01/edited-atom-bbbbbbbb", markdown_body: "rewritten by hand\n\n---\nSource: doc_gone (0123456789abcdef)",
      written_by: "mcp", written_by_principal: "alice" });
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    expect((await pageRow("atoms/2026-07-01/legacy-atom-aaaaaaaa"))?.deleted_at).not.toBeNull();
    expect((await pageRow("atoms/2026-07-01/edited-atom-bbbbbbbb"))?.deleted_at).toBeNull();
  });
});

describe("page purge retires what synthesis derived from the page", () => {
  async function purgeable(slug: string): Promise<void> {
    await putPage(storage, { slug, markdown_body: `about ${slug}\n` });
    await deletePage(storage, slug);
    await engine.query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`, [slug]);
  }

  it("deletes the page's own atoms and takes", async () => {
    await purgeable("notes/gone");
    await putPage(storage, { slug: "notes/live", markdown_body: "live\n" });
    await atom("notes/gone", "From the purged page", ["p"], "page");
    const keep = await atom("notes/live", "From a live page", ["p"], "page");
    await take("notes/gone", "take on the purged page");
    const r = await purgeDeletedPages(engine);
    expect(r.count).toBe(1);
    expect(await ids(`SELECT id FROM synth_atoms`)).toEqual([String(keep)]);
    expect(await ids(`SELECT claim_text AS id FROM synth_takes`)).toEqual([]);
  });

  it("retires the facts about the purged page whose source page is gone too, keeping stated and ontology rows", async () => {
    await purgeable("people/gone");
    await putPage(storage, { slug: "notes/other", markdown_body: "other\n" });
    await engine.query(`INSERT INTO entity_facts (entity_slug, fact, source_slug, source_id) VALUES
      ('people/gone', 'orphan claim about gone', 'notes/vanished', 'default'),
      ('people/gone', 'stated directly', NULL, 'default'),
      ('people/gone', 'claim held by another page', 'notes/other', 'default')`);
    await engine.query(`INSERT INTO entity_facts (entity_slug, fact, source_id, dimension, value) VALUES
      ('people/gone', 'works at Acme', 'default', 'employer', 'Acme')`);
    const r = await purgeDeletedPages(engine);
    expect(r.count).toBe(1);
    const live = await ids(`SELECT fact AS id FROM entity_facts WHERE forgotten_at IS NULL ORDER BY fact`);
    expect(live).toEqual(["claim held by another page", "stated directly", "works at Acme"]);
  });

  // Value: protects=the preview the operator approves counts the contradictions the purge deletes; fails_when=the dry run plans with no fact ids again.
  it("counts in its dry run the contradiction rows that snapshot a fact the purge retires", async () => {
    await purgeable("people/gone");
    const f = await engine.query<{ id: string }>(
      `INSERT INTO entity_facts (entity_slug, fact, source_slug, source_id) VALUES ('people/gone', 'orphan claim', 'notes/vanished', 'default') RETURNING id::text AS id`);
    await engine.query(`INSERT INTO synth_contradictions (pair_key, a_kind, a_ref, a_text, b_kind, b_ref, b_text, prompt_version, model_id)
      VALUES ('pk-1', 'fact', $1, 'orphan claim', 'fact', '999999', 'other claim', 'v1', 'm')`, [f.rows[0]!.id]);
    const dry = await purgeDeletedPages(engine, undefined, undefined, { dryRun: true });
    expect(dry.facts_retired).toBe(1);
    expect(dry.synthesis.contradictions).toBe(1);
    const real = await purgeDeletedPages(engine);
    expect(real.synthesis.contradictions).toBe(1);
  });
});

describe("concepts phase", () => {
  it("ignores atoms whose source document is gone or deleted, and keeps page atoms of live pages", async () => {
    await doc("doc_live"); await doc("doc_deleted");
    await putPage(storage, { slug: "notes/live", markdown_body: "live\n" });
    await atom("doc_live", "Doc atom", ["topic"]);
    await atom("notes/live", "Page atom", ["topic"], "page");
    await atom("doc_missing", "Missing source atom", ["topic"]);
    await atom("doc_deleted", "Deleted source atom", ["topic"]);
    await softDeleteDoc("doc_deleted");
    const r = await synthesizeConceptsPhase(engine);
    expect(r.atomsSeen).toBe(2);
    const row = (await engine.query<{ narrative: string; atom_count: number }>(`SELECT narrative, atom_count FROM synth_concepts WHERE concept_slug = 'topic'`)).rows[0]!;
    expect(Number(row.atom_count)).toBe(2);
    expect(row.narrative).not.toContain("Missing source atom");
    expect(row.narrative).not.toContain("Deleted source atom");
  });

  it("rebuilds a concept a purge hid once live atoms carry its tag again", async () => {
    await doc("doc_gone");
    const a = await atom("doc_gone", "Old one", ["back"]);
    const b = await atom("doc_gone", "Old two", ["back"]);
    await concept("back", "Old one and Old two", [a, b]);
    await softDeleteDoc("doc_gone");
    await purgeExpiredDocuments(engine, 0);
    expect((await pageRow("concepts/back"))?.deleted_at).not.toBeNull();
    await doc("doc_new");
    await atom("doc_new", "New one", ["back"]);
    await atom("doc_new", "New two", ["back"]);
    const r = await synthesizeConceptsPhase(engine, { storage });
    expect(r.skippedDeleted).toBe(0);
    const page = await pageRow("concepts/back");
    expect(page?.deleted_at).toBeNull();
    expect(page?.markdown_body).toContain("New one");
    expect(page?.markdown_body).not.toContain("Old one");
  });

  it("still skips a concept page a person deleted", async () => {
    await doc("doc_a");
    await atom("doc_a", "One", ["mine"]);
    await atom("doc_a", "Two", ["mine"]);
    await putPage(storage, { slug: "concepts/mine", type: "concept", markdown_body: "x\n", written_by: "synthesize-concepts", written_by_principal: "operator" });
    await deletePage(storage, "concepts/mine", "mcp", undefined, { writtenByPrincipal: "alice" });
    const r = await synthesizeConceptsPhase(engine, { storage });
    expect(r.skippedDeleted).toBe(1);
  });
});
});
