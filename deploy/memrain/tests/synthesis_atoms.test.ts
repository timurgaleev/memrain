/**
 * extract_atoms phase tests — hermetic. The LLM is a MOCKED `llmFn` (no
 * Bedrock). Verifies: atoms land ONLY in synth_atoms, idempotency, fail-open,
 * and that authored content (documents/chunks) is never rewritten — the sole
 * write back to `documents` is the zero-yield `atoms_scan_hash` stamp.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  contentHash16,
  extractAtomsPhase,
  isWellFormedEmptyExtraction,
  parseAtomsResponse,
} from "../src/core/synthesis/atoms.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-synth-atoms-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string, effectiveDate?: string): Promise<void> {
  await engine.query(
    `INSERT INTO documents (id, source_path, title, effective_date) VALUES ($1, $2, $3, $4)`,
    [id, `/vault/${id}.md`, id, effectiveDate ?? null],
  );
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

/** A failed call parks the document (synth_failures); let that wait run out. */
async function expireBackoff(): Promise<void> {
  await engine.query(`UPDATE synth_failures SET next_eligible_at = now() - interval '1 second'`);
}

/** Rewrite a seeded document's body — a source edit, so a new content hash. */
async function editDoc(id: string, body: string): Promise<void> {
  await engine.query(`UPDATE chunks SET content = $1 WHERE id = $2`, [body, `${id}c0`]);
}

/** The zero-yield scan stamp on a document, or null when it was never stamped. */
async function scanStamp(id: string): Promise<string | null> {
  const { rows } = await engine.query<{ stamp: string | null }>(
    `SELECT frontmatter->>'atoms_scan_hash' AS stamp FROM documents WHERE id = $1`,
    [id],
  );
  return rows[0]?.stamp ?? null;
}

const atomJson = (title: string, body: string): string =>
  JSON.stringify([{ title, atom_type: "insight", body, concepts: ["topic-a"] }]);

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("parseAtomsResponse", () => {
  it("parses a clean JSON array", () => {
    const atoms = parseAtomsResponse(
      `[{"title":"T","atom_type":"insight","body":"B body.","concepts":["x"]}]`,
    );
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.atom_type).toBe("insight");
    expect(atoms[0]?.concepts).toEqual(["x"]);
  });
  it("strips markdown fences and caps at 3", () => {
    const arr = Array.from({ length: 5 }, (_, i) => `{"title":"t${i}","atom_type":"x","body":"b${i}."}`);
    const atoms = parseAtomsResponse("```json\n[" + arr.join(",") + "]\n```");
    expect(atoms.length).toBe(3);
    expect(atoms[0]?.atom_type).toBe("insight"); // invalid type → fallback
  });
  it("returns [] on garbage", () => {
    expect(parseAtomsResponse("not json at all")).toEqual([]);
  });
});

describe("isWellFormedEmptyExtraction", () => {
  it("accepts a clean empty array, fenced or bare", () => {
    expect(isWellFormedEmptyExtraction("[]")).toBe(true);
    expect(isWellFormedEmptyExtraction("  [ ]\n")).toBe(true);
    expect(isWellFormedEmptyExtraction("```json\n[]\n```")).toBe(true);
  });

  it("rejects malformed, truncated, prose and non-empty output", () => {
    expect(isWellFormedEmptyExtraction("")).toBe(false);
    expect(isWellFormedEmptyExtraction("This note has nothing worth distilling.")).toBe(false);
    expect(isWellFormedEmptyExtraction("[{")).toBe(false);
    expect(isWellFormedEmptyExtraction(`[{"title":"t","body":"b."`)).toBe(false);
    expect(isWellFormedEmptyExtraction("[] and here is why:")).toBe(false);
    // Prose BEFORE the array is the dangerous shape: a model announcing its
    // own failure and appending a fallback. Seeking to the first `[` reads
    // that as a clean extraction and stamps the failure into the document.
    expect(isWellFormedEmptyExtraction("Unable to parse source; returning fallback []")).toBe(
      false,
    );
    expect(isWellFormedEmptyExtraction("The note is a list of links [] no atoms")).toBe(false);
    expect(isWellFormedEmptyExtraction(`[{"title":"t","atom_type":"insight","body":"b."}]`)).toBe(
      false,
    );
  });
});

describe("extractAtomsPhase", () => {
  it("writes atoms only to synth_atoms and leaves the corpus untouched", async () => {
    await seedDoc("d1", "A".repeat(500));
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(`[{"title":"Insight one","atom_type":"insight","body":"The body.","concepts":["topic-a"]}]`),
    });
    expect(r.atomsWritten).toBe(1);
    expect(r.errors).toEqual([]);

    const { rows } = await engine.query<{ source_ref: string; model_id: string }>(
      `SELECT source_ref, model_id FROM synth_atoms`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.source_ref).toBe("d1");
    expect(rows[0]?.model_id).toBe("fake-nova");

    // Corpus untouched.
    const docs = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents`);
    const chunks = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks`);
    expect(Number(docs.rows[0]?.n)).toBe(1);
    expect(Number(chunks.rows[0]?.n)).toBe(1);
  });

  it("is idempotent — a second run on unchanged docs writes nothing new", async () => {
    await seedDoc("d1", "B".repeat(500));
    const llm = fakeLlm(`[{"title":"Same","atom_type":"insight","body":"Same body."}]`);
    const r1 = await extractAtomsPhase(engine, { llmFn: llm });
    const r2 = await extractAtomsPhase(engine, { llmFn: llm });
    expect(r1.atomsWritten).toBe(1);
    expect(r2.documentsScanned).toBe(0); // already extracted → not re-discovered
    const { rows } = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM synth_atoms`);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("skips short documents (budget/quality floor)", async () => {
    await seedDoc("d1", "too short");
    const r = await extractAtomsPhase(engine, { llmFn: fakeLlm("[]") });
    expect(r.documentsScanned).toBe(0);
    expect(r.atomsWritten).toBe(0);
  });

  it("fails open — an LLM error skips the doc, never throws", async () => {
    await seedDoc("d1", "C".repeat(500));
    const boom: LlmFn = async () => {
      throw new Error("bedrock down");
    };
    const r = await extractAtomsPhase(engine, { llmFn: boom });
    expect(r.errors.length).toBe(1);
    expect(r.atomsWritten).toBe(0);
  });

  it("idempotency matches on the (ref, hash) PAIR, not the cross-product", async () => {
    // Two docs with DIFFERENT content (different hashes). Extract atoms for d1
    // only by pre-seeding a synth_atoms row for d1's pair. d2 must still be
    // discovered even though d1's hash exists for d1 — a naive
    // ref=ANY AND hash=ANY filter would be fine here, but the regression we
    // guard is a stale row (d1_ref, d2_hash) wrongly skipping d2.
    await seedDoc("d1", "G".repeat(500));
    await seedDoc("d2", "H".repeat(500));
    // Insert a deliberately MISMATCHED stale pair: d1's ref with d2's hash.
    const d2Hash = (await import("../src/core/synthesis/atoms.ts")).contentHash16("H".repeat(500));
    await engine.query(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ('stale', 'd1', 'document', $1, 't', 'b', 'm')`,
      [d2Hash],
    );
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(`[{"title":"t","atom_type":"insight","body":"b."}]`),
    });
    // Both d1 and d2 must be discovered (the stale mismatched pair must NOT
    // suppress d2, whose real pair is (d2, d2Hash)).
    expect(r.documentsScanned).toBe(2);
  });

  it("tombstones a zero-yield document instead of re-paying for it every run", async () => {
    await seedDoc("d1", "Z".repeat(500));
    const llm = fakeLlm("[]"); // clean parse, no atoms — an un-atomizable note
    const r1 = await extractAtomsPhase(engine, { llmFn: llm });
    expect(r1.documentsScanned).toBe(1);
    expect(r1.atomsWritten).toBe(0);
    expect(r1.errors).toEqual([]);

    // The stamp carries the hash of the text that was scanned.
    expect(await scanStamp("d1")).toBe(contentHash16("Z".repeat(500)));

    // Second run must not rediscover it — no atom row exists, so only the
    // tombstone can keep it out of the (recency-ordered, maxDocs-capped) window.
    const r2 = await extractAtomsPhase(engine, { llmFn: llm });
    expect(r2.documentsScanned).toBe(0);
    expect(r2.documentsProcessed).toBe(0);
  });

  it("re-scans a tombstoned document once its content changes", async () => {
    await seedDoc("d1", "Z".repeat(500));
    await extractAtomsPhase(engine, { llmFn: fakeLlm("[]") });
    await editDoc("d1", "Y".repeat(500));
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(atomJson("Now it says something", "A real claim.")),
    });
    expect(r.documentsScanned).toBe(1);
    expect(r.atomsWritten).toBe(1);
  });

  it("never tombstones a truncated extraction — that document stays retryable", async () => {
    await seedDoc("d1", "T".repeat(500));
    // The model was cut off mid-object: parseAtomsResponse yields [] here just
    // as it does for a genuine empty extraction, but memoizing it would bury a
    // document that does carry atoms.
    const truncated = `[{"title":"Half an atom","atom_type":"insight","body":"The model stopped mid-`;
    const r1 = await extractAtomsPhase(engine, { llmFn: fakeLlm(truncated) });
    expect(r1.documentsProcessed).toBe(1);
    expect(r1.atomsWritten).toBe(0);
    expect(r1.errors.length).toBe(1);
    expect(await scanStamp("d1")).toBeNull();

    await expireBackoff();
    const r2 = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(atomJson("Recovered", "A real claim.")),
    });
    expect(r2.documentsScanned).toBe(1);
    expect(r2.atomsWritten).toBe(1);
  });

  it("never tombstones a prose-wrapped empty array — that document stays retryable", async () => {
    await seedDoc("d1", "W".repeat(500));
    // The model gave up and appended a fallback. It parses to [] exactly like a
    // genuine empty extraction, and the prose sits BEFORE the bracket — the one
    // shape that used to slip past the guard and bury the document for good.
    const excuse = "Unable to parse the source note; returning fallback []";
    const r1 = await extractAtomsPhase(engine, { llmFn: fakeLlm(excuse) });
    expect(r1.documentsProcessed).toBe(1);
    expect(r1.atomsWritten).toBe(0);
    expect(r1.errors.length).toBe(1);
    expect(await scanStamp("d1")).toBeNull();

    await expireBackoff();
    const r2 = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(atomJson("Recovered", "A real claim.")),
    });
    expect(r2.documentsScanned).toBe(1);
    expect(r2.atomsWritten).toBe(1);
  });

  it("gives two same-title atoms from one document their own pages", async () => {
    await seedDoc("d1", "P".repeat(500), "2024-05-01");
    const twins = (first: string, second: string): string =>
      JSON.stringify([
        { title: "One title, two claims", atom_type: "insight", body: first, concepts: ["a"] },
        { title: "One title, two claims", atom_type: "insight", body: second, concepts: ["b"] },
      ]);

    const r = await extractAtomsPhase(engine, {
      storage,
      llmFn: fakeLlm(twins("The first distinct claim.", "The second distinct claim.")),
    });
    expect(r.atomsWritten).toBe(2);
    expect(r.pagesWritten).toBe(2);

    const first = await engine.query<{ slug: string; markdown_body: string }>(
      `SELECT slug, markdown_body FROM pages WHERE slug LIKE 'atoms/%' ORDER BY slug`,
    );
    expect(first.rows.length).toBe(2);
    const bodies = first.rows.map((p) => p.markdown_body).join("\n");
    expect(bodies).toContain("The first distinct claim.");
    expect(bodies).toContain("The second distinct claim.");

    // The discriminator must be stable identity, not the body: a source edit
    // that rewords both atoms re-writes the same two pages, never four.
    await editDoc("d1", "Q".repeat(500));
    await extractAtomsPhase(engine, {
      storage,
      llmFn: fakeLlm(twins("Reworded first claim.", "Reworded second claim.")),
    });
    const second = await engine.query<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug LIKE 'atoms/%' ORDER BY slug`,
    );
    expect(second.rows.map((p) => p.slug)).toEqual(first.rows.map((p) => p.slug));
  });

  it("never tombstones on an LLM error — that document stays retryable", async () => {
    await seedDoc("d1", "C".repeat(500));
    const boom: LlmFn = async () => {
      throw new Error("bedrock down");
    };
    await extractAtomsPhase(engine, { llmFn: boom });
    expect(await scanStamp("d1")).toBeNull();
    await expireBackoff();
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(atomJson("Recovered", "The model came back.")),
    });
    expect(r.documentsScanned).toBe(1);
    expect(r.atomsWritten).toBe(1);
  });

  it("mirrors a re-extracted atom onto the SAME page slug after a source edit", async () => {
    await seedDoc("d1", "K".repeat(500));
    await extractAtomsPhase(engine, {
      storage,
      llmFn: fakeLlm(atomJson("Ship gates beat retro fixes", "First phrasing.")),
    });
    // Edit the note: new content hash → re-discovered → re-extracted. The atom
    // is the same claim, so it must land on the page it already owns.
    await editDoc("d1", "M".repeat(500));
    await extractAtomsPhase(engine, {
      storage,
      llmFn: fakeLlm(atomJson("Ship gates beat retro fixes", "Reworded phrasing.")),
    });

    const { rows } = await engine.query<{ slug: string; markdown_body: string }>(
      `SELECT slug, markdown_body FROM pages WHERE slug LIKE 'atoms/%'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.markdown_body).toContain("Reworded phrasing.");
  });

  it("dates the atom page from the source note, not the run date", async () => {
    await seedDoc("d1", "N".repeat(500), "2024-03-05");
    await extractAtomsPhase(engine, {
      storage,
      llmFn: fakeLlm(atomJson("Old note, fresh scan", "Body text.")),
    });
    const { rows } = await engine.query<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug LIKE 'atoms/%'`,
    );
    expect(rows[0]?.slug).toMatch(/^atoms\/2024-03-05\/old-note-fresh-scan-[0-9a-f]{8}$/);
  });

  it("tells the model the note's observation date", async () => {
    await seedDoc("d1", "N".repeat(500), "2024-03-05");
    let user = "";
    let system = "";
    await extractAtomsPhase(engine, {
      llmFn: async (req) => {
        user = req.user;
        system = req.system;
        return { text: "[]", modelId: "fake-nova" };
      },
    });
    expect(user).toContain("Observation date: 2024-03-05");
    // The rule is static so the system prompt stays cacheable across notes.
    expect(system).not.toContain("2024-03-05");
    expect(system).toContain("observation date");
  });

  it("drops a source_quote the note does not contain and keeps a real one", async () => {
    const note = `${"Filler sentence about nothing. ".repeat(15)}We decided to move the launch to the spring because the supplier slipped.`;
    await seedDoc("d1", note);
    const r = await extractAtomsPhase(engine, {
      llmFn: fakeLlm(JSON.stringify([
        { title: "Real", atom_type: "insight", body: "Launch moved.", source_quote: "we decided to move the  launch to the spring." },
        { title: "Made up", atom_type: "insight", body: "Budget doubled.", source_quote: "The board approved doubling the budget." },
      ])),
    });
    expect(r.atomsWritten).toBe(2);
    expect(r.quotesDropped).toBe(1);
    const { rows } = await engine.query<{ title: string; source_quote: string | null }>(
      `SELECT title, source_quote FROM synth_atoms ORDER BY title`,
    );
    expect(rows).toEqual([
      { title: "Made up", source_quote: null },
      { title: "Real", source_quote: "we decided to move the  launch to the spring." },
    ]);
  });

  it("respects maxDocs (cost guard)", async () => {
    await seedDoc("d1", "D".repeat(500));
    await seedDoc("d2", "E".repeat(500));
    await seedDoc("d3", "F".repeat(500));
    const r = await extractAtomsPhase(engine, {
      maxDocs: 2,
      llmFn: fakeLlm(`[{"title":"t","atom_type":"insight","body":"b."}]`),
    });
    expect(r.documentsScanned).toBe(2);
    expect(r.atomsWritten).toBe(2);
  });
});
