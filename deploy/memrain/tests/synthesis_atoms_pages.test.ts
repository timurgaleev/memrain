/**
 * G33 retrievable atoms/concepts — provenance fields (source_quote/lesson) and
 * the page mirrors written via putPage. Hermetic (injected LlmFn).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  extractAtomsPhase,
  parseAtomsResponse,
  slugifyTitle,
  synthPagesEnabled,
} from "../src/core/synthesis/atoms.ts";
import { synthesizeConceptsPhase } from "../src/core/synthesis/concepts.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-atoms-pages-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)`, [
    id,
    `/vault/${id}.md`,
    id,
  ]);
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

const ATOM = JSON.stringify([
  {
    title: "Ship gates beat retro fixes",
    atom_type: "insight",
    body: "Catching a regression at the ship gate is 10x cheaper than in prod.",
    concepts: ["shipping"],
    source_quote: "we caught it at the gate, not in prod",
    lesson: "Put the check where the mistake happens.",
  },
]);

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-haiku" });

describe("provenance parsing + flags", () => {
  it("parseAtomsResponse keeps source_quote and lesson, clamped", () => {
    const atoms = parseAtomsResponse(ATOM);
    expect(atoms[0]?.source_quote).toBe("we caught it at the gate, not in prod");
    expect(atoms[0]?.lesson).toBe("Put the check where the mistake happens.");
  });
  it("slugifyTitle produces a valid kebab segment", () => {
    expect(slugifyTitle("Ship gates beat retro fixes!")).toBe("ship-gates-beat-retro-fixes");
    expect(slugifyTitle("???")).toBe("atom");
  });
  it("synthPagesEnabled is default-ON with a =0 escape hatch", () => {
    expect(synthPagesEnabled(undefined)).toBe(true);
    expect(synthPagesEnabled("0")).toBe(false);
    expect(synthPagesEnabled("1")).toBe(true);
  });
});

describe("extractAtomsPhase provenance + page mirror", () => {
  it("persists source_quote/lesson and writes an atoms/<date>/<slug> page", async () => {
    // The quote has to be in the note: a source_quote the note lacks is dropped.
    await seedDoc("d1", `${"X".repeat(500)}\nWe caught it at the gate, not in prod.`);
    const r = await extractAtomsPhase(engine, { llmFn: fakeLlm(ATOM), storage });
    expect(r.atomsWritten).toBe(1);
    expect(r.pagesWritten).toBe(1);

    const { rows } = await engine.query<{ source_quote: string; lesson: string }>(
      `SELECT source_quote, lesson FROM synth_atoms`,
    );
    expect(rows[0]?.source_quote).toBe("we caught it at the gate, not in prod");
    expect(rows[0]?.lesson).toBe("Put the check where the mistake happens.");

    const day = new Date().toISOString().slice(0, 10);
    const { rows: pages } = await engine.query<{ slug: string; markdown_body: string; type: string }>(
      `SELECT slug, markdown_body, type FROM pages WHERE slug LIKE 'atoms/%'`,
    );
    expect(pages.length).toBe(1);
    // Slug carries an 8-char atom_key suffix so same-title/same-day atoms
    // don't collide on the pages PK.
    expect(pages[0]?.slug).toMatch(
      new RegExp(`^atoms/${day}/ship-gates-beat-retro-fixes-[0-9a-f]{8}$`),
    );
    expect(pages[0]?.type).toBe("atom");
    expect(pages[0]?.markdown_body).toContain("we caught it at the gate");
    expect(pages[0]?.markdown_body).toContain("Lesson:");
  });

  it("writes no pages without a storage handle (rows only)", async () => {
    await seedDoc("d2", "Y".repeat(500));
    const r = await extractAtomsPhase(engine, { llmFn: fakeLlm(ATOM) });
    expect(r.atomsWritten).toBe(1);
    expect(r.pagesWritten).toBe(0);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'atoms/%'`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe("synthesizeConceptsPhase page mirror", () => {
  it("writes a concepts/<slug> page per synthesized concept", async () => {
    // Two atoms sharing a concept tag → one T3 group.
    for (let i = 0; i < 2; i++) {
      await engine.query(
        `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, atom_type, concepts, model_id)
         VALUES ($1, 'd1', 'document', 'h', $2, 'body', 'insight', '["shipping"]'::jsonb, 'm')`,
        [`ak-${i}`, `Atom ${i}`],
      );
    }
    const r = await synthesizeConceptsPhase(engine, { llmFn: fakeLlm("narrative"), storage });
    expect(r.conceptsWritten).toBe(1);
    expect(r.pagesWritten).toBe(1);
    const { rows } = await engine.query<{ slug: string; type: string; markdown_body: string }>(
      `SELECT slug, type, markdown_body FROM pages WHERE slug LIKE 'concepts/%'`,
    );
    expect(rows[0]?.slug).toBe("concepts/shipping");
    expect(rows[0]?.type).toBe("concept");
    expect(rows[0]?.markdown_body).toContain("Atom 0");
  });
});
