/**
 * What older purges left behind: synthesis rows whose source no longer
 * exists, the atom and concept pages over them, and facts written on a page
 * that is gone. Doctor reports them read-only; the repair plans every row with
 * its lineage, action and reason, refuses an apply whose reviewed hash is
 * stale, exports every row it changes before changing it, and a restore from
 * that export puts the brain back as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage } from "../src/core/storage.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { putPage } from "../src/core/pages.ts";
import { planDerivedCleanup } from "../src/core/synthesis/derived-cleanup.ts";
import { applyPurgeLeftovers, checkPurgeLeftovers, restorePurgeLeftovers } from "../src/core/purge-leftovers.ts";
import { pageSourcePath } from "../src/core/page-index.ts";
import { deterministicEmbed } from "./det-embed.ts";

let storage: Storage;
let engine: Engine;

let n = 0;
async function atom(sourceRef: string, title: string, concepts: string[]): Promise<number> {
  n += 1;
  const r = await engine.query<{ id: number }>(
    `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, concepts, model_id)
     VALUES ($1, $2, 'document', 'h', $3, 'b', $4::text::jsonb, 'm') RETURNING id`, [`key-${n}`, sourceRef, title, JSON.stringify(concepts)]);
  return Number(r.rows[0]!.id);
}
async function concept(slug: string, atomIds: number[]): Promise<void> {
  await engine.query(`INSERT INTO synth_concepts (concept_slug, title, narrative, atom_count, model_id, member_hash) VALUES ($1, $1, $2, $3, 'haiku', 'mh')`,
    [slug, `LLM narrative of ${slug}`, atomIds.length]);
  for (const id of atomIds) await engine.query(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) VALUES ($1, $2)`, [slug, id]);
  await putPage(storage, { slug: `concepts/${slug}`, type: "concept", markdown_body: `LLM narrative of ${slug}\n`, written_by: "synthesize-concepts", written_by_principal: "operator" });
}

/** A brain holding what an older purge of doc_gone and notes/gone left behind. */
async function seedLeftovers(): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, source_id) VALUES ('doc_live', '/vault/live.md', 'default')`);
  const gone1 = await atom("doc_0123456789abcdef", "Gone one", ["mixed", "allgone"]);
  const gone2 = await atom("doc_0123456789abcdef", "Gone two", ["allgone"]);
  const live = await atom("doc_live", "Live one", ["mixed"]);
  await concept("mixed", [gone1, live]);
  await concept("allgone", [gone1, gone2]);
  await putPage(storage, { slug: "atoms/2026-07-01/gone-one-aaaaaaaa", type: "atom", allowAdHocType: true,
    markdown_body: "b\n\n---\nSource: doc_0123456789abcdef (0123456789abcdef)", written_by: "extract-atoms" });
  await engine.query(`INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id) VALUES
    ('t-gone', 'doc_0123456789abcdef', 'h', 'v1', 'gone take', 'm'), ('t-live', 'doc_live', 'h', 'v1', 'live take', 'm'),
    ('t-renamed', 'notes/renamed-away', 'h', 'v1', 'take on a page renamed since', 'm')`);
  await engine.query(`UPDATE synth_takes SET embedding = array_fill(0.25::real, ARRAY[1024])::vector WHERE take_key = 't-gone'`);
  await engine.query(`INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, model_id)
    SELECT id, 'v1', 'sig', 'correct', 'm' FROM synth_takes WHERE take_key = 't-gone'`);
  await engine.query(`INSERT INTO entity_facts (entity_slug, fact, source_markdown_slug, source_slug, source_id) VALUES
    ('people/x', 'fenced on a gone page', 'notes/gone', 'notes/gone', 'default'),
    ('people/y', 'names a gone source only', NULL, 'voice/gone', 'default'),
    ('people/z', 'healthy fact', NULL, NULL, 'default')`);
  await engine.query(`UPDATE entity_facts SET embedding = array_fill(0.5::real, ARRAY[1024])::vector WHERE fact = 'fenced on a gone page'`);
}

async function snapshot(): Promise<unknown> {
  const q = async (sql: string) => (await engine.query(sql)).rows;
  return {
    atoms: await q(`SELECT id, atom_key, source_ref, title, concepts FROM synth_atoms ORDER BY id`),
    concepts: await q(`SELECT concept_slug, narrative, atom_count, tier, model_id, member_hash FROM synth_concepts ORDER BY concept_slug`),
    links: await q(`SELECT concept_slug, atom_id FROM synth_concept_atoms ORDER BY concept_slug, atom_id`),
    takes: await q(`SELECT id, take_key, claim_text, status, md5(embedding::text) AS emb FROM synth_takes ORDER BY id`),
    grades: await q(`SELECT take_id, verdict FROM synth_take_grades ORDER BY take_id`),
    facts: await q(`SELECT id, fact, forgotten_at IS NULL AS live, forgotten_cause, md5(embedding::text) AS emb FROM entity_facts ORDER BY id`),
    pages: await q(`SELECT slug, markdown_body, content_hash, deleted_at IS NULL AS live FROM pages ORDER BY slug`),
  };
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(name, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    db = await open();
    storage = db.storage;
    engine = storage.engine();
  });
  afterEach(async () => { await db.close(); });
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "memrain-purge-leftovers-export-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("purge leftovers", () => {
  it("doctor reports them read-only, and is quiet on a clean brain", async () => {
    expect((await checkPurgeLeftovers(engine)).status).toBe("ok");
    await seedLeftovers();
    const before = await snapshot();
    const r = await checkPurgeLeftovers(engine);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("2 atom(s)");
    expect(r.detail).toContain("memrain purge-leftovers");
    expect(await snapshot()).toEqual(before);
  });

  it("plans every row with its action and reason", async () => {
    await seedLeftovers();
    const plan = await planDerivedCleanup(engine, { orphans: true });
    expect(plan.source_refs).toEqual(["doc_0123456789abcdef"]);
    expect(plan.atoms.map((a) => a.title)).toEqual(["Gone one", "Gone two"]);
    expect(plan.atom_pages.map((p) => [p.slug, p.action])).toEqual([["atoms/2026-07-01/gone-one-aaaaaaaa", "retire"]]);
    expect(plan.concepts.map((c) => [c.concept_slug, c.action, c.page?.action])).toEqual([["allgone", "retire", "retire"], ["mixed", "regenerate", "regenerate"]]);
    expect(plan.takes.map((t) => t.take_key)).toEqual(["t-gone"]);
    expect(plan.facts.map((f) => [f.page_slug, f.action])).toEqual([["notes/gone", "retire"], ["voice/gone", "keep"]]);
    expect(plan.retire_total).toBe(2 + 1 + 1 + 1 + 1 + 1);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a stale plan hash and changes nothing", async () => {
    await seedLeftovers();
    const before = await snapshot();
    await expect(applyPurgeLeftovers(engine, { planHash: "0".repeat(64), exportPath: join(tmp, "export.json") })).rejects.toThrow(/plan/);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a plan whose concept was re-narrated after the preview", async () => {
    await seedLeftovers();
    const plan = await planDerivedCleanup(engine, { orphans: true });
    await engine.query(`UPDATE synth_concepts SET narrative = 'newer narrative' WHERE concept_slug = 'mixed'`);
    await expect(applyPurgeLeftovers(engine, { planHash: plan.plan_hash, exportPath: join(tmp, "export.json") })).rejects.toThrow(/plan/);
  });

  it("restore refuses, and changes nothing, when a page was edited after the apply", async () => {
    await seedLeftovers();
    const plan = await planDerivedCleanup(engine, { orphans: true });
    const exportPath = join(tmp, "export.json");
    await applyPurgeLeftovers(engine, { planHash: plan.plan_hash, exportPath });
    await putPage(storage, { slug: "concepts/mixed", markdown_body: "my edit after the cleanup\n", written_by: "mcp", written_by_principal: "alice" });
    const after = await snapshot();
    await expect(restorePurgeLeftovers(engine, exportPath)).rejects.toThrow(/concepts\/mixed/);
    expect(await snapshot()).toEqual(after);
  });

  it("rebuilds the search mirrors of the pages it rewrites, and of the pages a restore brings back", async () => {
    await seedLeftovers();
    const embedFn = async (text: string) => deterministicEmbed(text);
    const mirror = async (slug: string) => (await engine.query<{ chunks: number; embedded: number }>(
      `SELECT count(c.id)::int AS chunks, count(e.chunk_id)::int AS embedded FROM documents d
         JOIN chunks c ON c.document_id = d.id LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE d.source_path = $1`, [pageSourcePath(slug, "default")])).rows[0]!;
    const plan = await planDerivedCleanup(engine, { orphans: true });
    const exportPath = join(tmp, "export.json");
    const applied = await applyPurgeLeftovers(engine, { planHash: plan.plan_hash, exportPath, storage, embedFn });
    expect(applied.mirrors).toEqual({ mirrored: ["concepts/mixed"], failed: [] });
    expect((await mirror("concepts/mixed")).embedded).toBeGreaterThan(0);
    expect((await mirror("concepts/allgone")).chunks).toBe(0);
    const restored = await restorePurgeLeftovers(engine, exportPath, { storage, embedFn });
    expect(restored.mirrors.failed).toEqual([]);
    expect(restored.mirrors.mirrored.sort()).toEqual(["atoms/2026-07-01/gone-one-aaaaaaaa", "concepts/allgone", "concepts/mixed"]);
    for (const slug of restored.mirrors.mirrored) expect((await mirror(slug)).embedded).toBeGreaterThan(0);
  });

  it("exports, applies exactly the plan, and restores from the export", async () => {
    await seedLeftovers();
    const before = await snapshot();
    const plan = await planDerivedCleanup(engine, { orphans: true });
    const exportPath = join(tmp, "export.json");
    const r = await applyPurgeLeftovers(engine, { planHash: plan.plan_hash, exportPath });
    expect(r.result).toMatchObject({ atoms: 2, takes: 1, concepts: 1, concepts_regenerated: 1, atom_pages: 1, concept_pages: 2, facts: 1 });
    expect((statSync(exportPath).mode & 0o777).toString(8)).toBe("600");
    const exported = JSON.parse(readFileSync(exportPath, "utf8"));
    expect(exported.plan_hash).toBe(plan.plan_hash);
    expect(exported.rows.synth_atoms).toHaveLength(2);
    expect((await checkPurgeLeftovers(engine)).status).toBe("ok");
    const mixed = (await engine.query<{ narrative: string }>(`SELECT narrative FROM synth_concepts WHERE concept_slug = 'mixed'`)).rows[0]!;
    expect(mixed.narrative).toContain("Live one");
    expect(mixed.narrative).not.toContain("Gone one");

    const restored = await restorePurgeLeftovers(engine, exportPath);
    expect(restored.atoms).toBe(2);
    expect(await snapshot()).toEqual(before);
  });
});
});
