/**
 * Failure backoff for propose_takes and extract_atoms (`synth_failures`).
 *
 * A document whose call throws, or whose answer never parses, used to be paid
 * for on every cycle — and, discovery being recency-ordered, could hold the
 * run's slots for good. These tests pin the parking, the doubling wait, the
 * reset on an edit or a model switch, and the clear on a clean answer.
 * Hermetic: every model is an injected fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { proposeTakesPhase } from "../src/core/synthesis/takes.ts";
import { extractAtomsPhase } from "../src/core/synthesis/atoms.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
} from "../src/core/synthesis/synth-failures.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-synth-failures-"));
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

/** Model fake that answers per document (by the `Source:` line) and counts calls. */
function perDocLlm(answer: (docId: string) => string | Error) {
  const calls: string[] = [];
  const fn: LlmFn = async (input) => {
    const docId = /^Source: (\S+)/.exec(input.user)?.[1] ?? "?";
    calls.push(docId);
    const a = answer(docId);
    if (a instanceof Error) throw a;
    return { text: a, modelId: "fake-nova" };
  };
  return { fn, calls };
}

async function failureRow(docId: string, phase: string) {
  const { rows } = await engine.query<{
    attempts: number;
    kind: string;
    model: string;
    wait_ms: number;
  }>(
    `SELECT attempts, kind, model,
            (EXTRACT(EPOCH FROM (next_eligible_at - last_at)) * 1000)::float8 AS wait_ms
       FROM synth_failures WHERE doc_id = $1 AND phase = $2`,
    [docId, phase],
  );
  return rows[0] ?? null;
}

/** Let every parked document's wait run out. */
async function expireBackoff(): Promise<void> {
  await engine.query(`UPDATE synth_failures SET next_eligible_at = now() - interval '1 second'`);
}

const TAKE = `[{"claim_text":"the bet will pay","kind":"prediction","weight":0.6}]`;
const ATOM = JSON.stringify([{ title: "T", atom_type: "insight", body: "A claim.", concepts: ["a"] }]);

describe("backoffMs", () => {
  it("doubles from 24h and stops at 7 days", () => {
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(3)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffMs(4)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(50)).toBe(BACKOFF_CAP_MS);
  });
});

describe("propose_takes backoff", () => {
  it("a failing document gives its slot to the next one instead of holding it", async () => {
    await seedDoc("older", "O".repeat(500));
    await seedDoc("newer", "N".repeat(500));
    const llm = perDocLlm((id) => (id === "newer" ? new Error("bedrock down") : TAKE));

    const r1 = await proposeTakesPhase(engine, { llmFn: llm.fn, maxDocs: 1 });
    expect(llm.calls).toEqual(["newer"]);
    expect(r1.errors.length).toBe(1);
    expect((await failureRow("newer", "propose_takes"))?.kind).toBe("llm_error");

    const r2 = await proposeTakesPhase(engine, { llmFn: llm.fn, maxDocs: 1 });
    expect(llm.calls).toEqual(["newer", "older"]);
    expect(r2.takesQueued).toBe(1);

    // Nothing left that is eligible: the parked document is not paid for again.
    const r3 = await proposeTakesPhase(engine, { llmFn: llm.fn, maxDocs: 1 });
    expect(r3.documentsScanned).toBe(0);
    expect(llm.calls.length).toBe(2);
  });

  it("parks an unparseable answer and doubles the wait on a repeat", async () => {
    await seedDoc("d1", "S".repeat(500));
    const llm = perDocLlm(() => "Sorry, I could not find any claims.");

    await proposeTakesPhase(engine, { llmFn: llm.fn });
    const first = await failureRow("d1", "propose_takes");
    expect(first?.kind).toBe("unparseable");
    expect(first?.attempts).toBe(1);
    expect(first?.wait_ms).toBeCloseTo(BACKOFF_BASE_MS, -3);

    await expireBackoff();
    await proposeTakesPhase(engine, { llmFn: llm.fn });
    const second = await failureRow("d1", "propose_takes");
    expect(second?.attempts).toBe(2);
    expect(second?.wait_ms).toBeCloseTo(2 * BACKOFF_BASE_MS, -3);
    expect(llm.calls.length).toBe(2);
  });

  it("an edited document is eligible at once, and its count starts over", async () => {
    await seedDoc("d1", "S".repeat(500));
    const llm = perDocLlm(() => new Error("down"));
    await proposeTakesPhase(engine, { llmFn: llm.fn });

    await engine.query(`UPDATE chunks SET content = $1 WHERE id = 'd1c0'`, ["E".repeat(600)]);
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r.documentsScanned).toBe(1);
    expect((await failureRow("d1", "propose_takes"))?.attempts).toBe(1);
  });

  it("a model switch makes a parked document eligible", async () => {
    await seedDoc("d1", "S".repeat(500));
    const llm = perDocLlm(() => new Error("down"));
    await proposeTakesPhase(engine, { llmFn: llm.fn, modelId: "model-a" });
    expect((await proposeTakesPhase(engine, { llmFn: llm.fn, modelId: "model-a" })).documentsScanned).toBe(0);

    const r = await proposeTakesPhase(engine, { llmFn: llm.fn, modelId: "model-b" });
    expect(r.documentsScanned).toBe(1);
    const row = await failureRow("d1", "propose_takes");
    expect(row?.model).toBe("model-b");
    expect(row?.attempts).toBe(1);
  });

  it("a clean answer clears the failure", async () => {
    await seedDoc("d1", "S".repeat(500));
    await proposeTakesPhase(engine, { llmFn: perDocLlm(() => new Error("down")).fn });
    await expireBackoff();
    const r = await proposeTakesPhase(engine, { llmFn: perDocLlm(() => TAKE).fn });
    expect(r.takesQueued).toBe(1);
    expect(await failureRow("d1", "propose_takes")).toBeNull();
  });
});

describe("extract_atoms backoff", () => {
  it("parks an LLM error and lets the next document through", async () => {
    await seedDoc("older", "O".repeat(500));
    await seedDoc("newer", "N".repeat(500));
    const llm = perDocLlm((id) => (id === "newer" ? new Error("bedrock down") : ATOM));

    await extractAtomsPhase(engine, { llmFn: llm.fn, maxDocs: 1 });
    const r2 = await extractAtomsPhase(engine, { llmFn: llm.fn, maxDocs: 1 });
    expect(llm.calls).toEqual(["newer", "older"]);
    expect(r2.atomsWritten).toBe(1);
    expect((await failureRow("newer", "extract_atoms"))?.kind).toBe("llm_error");
  });

  it("parks an unparseable answer and clears it on a clean one", async () => {
    await seedDoc("d1", "S".repeat(500));
    await extractAtomsPhase(engine, { llmFn: perDocLlm(() => "no atoms, sorry").fn });
    expect((await failureRow("d1", "extract_atoms"))?.kind).toBe("unparseable");
    expect((await extractAtomsPhase(engine, { llmFn: perDocLlm(() => ATOM).fn })).documentsScanned).toBe(0);

    await expireBackoff();
    const r = await extractAtomsPhase(engine, { llmFn: perDocLlm(() => ATOM).fn });
    expect(r.atomsWritten).toBe(1);
    expect(await failureRow("d1", "extract_atoms")).toBeNull();
  });

  it("keeps the two phases' failures apart", async () => {
    await seedDoc("d1", "S".repeat(500));
    await extractAtomsPhase(engine, { llmFn: perDocLlm(() => new Error("down")).fn });
    const r = await proposeTakesPhase(engine, { llmFn: perDocLlm(() => TAKE).fn });
    expect(r.takesQueued).toBe(1);
  });
});
