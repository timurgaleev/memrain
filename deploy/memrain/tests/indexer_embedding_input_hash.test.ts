/**
 * Embedding reuse keyed on what the vector was embedded from (migration 187).
 * Under contextual wrapping the embed input is `<context>title + synopsis</context>`
 * plus the chunk, so a retitle must re-embed every wrapped chunk; text-keyed
 * reuse kept the stale vectors. Vectors written before the hash existed keep the
 * text rule, so deploying it re-embeds nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
let embedCalls: string[];
let prevLlm: string | undefined;
let prevWrap: string | undefined;

const SRC = "/notes/input-hash.md";
const section = (n: number) =>
  `## Section ${n}\n\nSection ${n} discusses topic number ${n} in some depth. It covers the ` +
  `background, the core argument, and a few supporting details that run long enough to keep ` +
  `this section on its own as a distinct retrievable chunk well past the minimum chunk size floor.`;
const doc = (title: string) => [`# ${title}`, section(1), section(2), section(3)].join("\n\n");

const embedFn = async (text: string): Promise<number[]> => {
  embedCalls.push(text);
  return deterministicEmbed(text);
};
const situating: LlmFn = async () => ({ text: "Situates the chunk.", modelId: "fake" });
const failing: LlmFn = async () => ({ text: "", modelId: "fake" });

beforeEach(async () => {
  prevLlm = process.env.MEMRAIN_CONTEXTUAL_LLM;
  prevWrap = process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL;
  delete process.env.MEMRAIN_CONTEXTUAL_LLM;
  delete process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL;
  tmp = mkdtempSync(join(tmpdir(), "memrain-input-hash-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  embedCalls = [];
});
afterEach(async () => {
  if (prevLlm === undefined) delete process.env.MEMRAIN_CONTEXTUAL_LLM;
  else process.env.MEMRAIN_CONTEXTUAL_LLM = prevLlm;
  if (prevWrap === undefined) delete process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL;
  else process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL = prevWrap;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function chunkTexts(): Promise<string[]> {
  const r = await storage.engine().query<{ content: string }>(
    `SELECT c.content FROM chunks c
      WHERE c.document_id = (SELECT id FROM documents WHERE source_path = $1)
      ORDER BY c.chunk_index`,
    [SRC],
  );
  return r.rows.map((row) => row.content);
}

/** Chunks whose text the retitle itself changed (the H1 may sit in the first chunk). */
async function textChangedByRetitle(before: string[]): Promise<number> {
  const after = await chunkTexts();
  return after.filter((t) => !before.includes(t)).length;
}

describe("embedding input hash", () => {
  // Value: protects=a retitle re-embeds wrapped chunks; fails_when=reuse goes back to raw text only.
  it("re-embeds every wrapped chunk when the title changes", async () => {
    process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL = "1";
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    const chunks = (await chunkTexts()).length;
    expect(chunks).toBeGreaterThanOrEqual(3);

    embedCalls = [];
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    expect(embedCalls).toHaveLength(0);

    await indexDocument(storage, { sourcePath: SRC, text: doc("Bravo plan") }, { embedFn });
    expect(embedCalls).toHaveLength(chunks);
    expect(embedCalls.every((t) => t.includes("Bravo plan"))).toBe(true);
  });

  // Value: protects=no mass re-embed on deploy; fails_when=a NULL hash stops matching by text.
  it("keeps reusing vectors stored without a hash by their text", async () => {
    process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL = "1";
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    const before = await chunkTexts();
    await storage.engine().query(`UPDATE embeddings SET input_hash = NULL`);

    embedCalls = [];
    await indexDocument(storage, { sourcePath: SRC, text: doc("Bravo plan") }, { embedFn });
    expect(embedCalls).toHaveLength(await textChangedByRetitle(before));
    expect(embedCalls.length).toBeLessThan(before.length);
  });

  // Value: protects=raw-tier reuse is untouched by the title; fails_when=the title leaks into the raw hash.
  it("does not re-embed raw chunks for a title change", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    const before = await chunkTexts();
    embedCalls = [];
    await indexDocument(storage, { sourcePath: SRC, text: doc("Bravo plan") }, { embedFn });
    expect(embedCalls).toHaveLength(await textChangedByRetitle(before));
    expect(embedCalls.length).toBeLessThan(before.length);
  });

  // Value: protects=a deterministic fallback is retried once the LLM tier answers; fails_when=reuse
  // accepts any wrapped hash while the paid tier is on.
  it("retries the LLM context for chunks that fell back, and keeps situated ones", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn, contextualLlmFn: failing });
    const chunks = (await chunkTexts()).length;

    embedCalls = [];
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn, contextualLlmFn: situating });
    expect(embedCalls).toHaveLength(chunks);
    expect(embedCalls.every((t) => t.includes("Situates the chunk."))).toBe(true);

    embedCalls = [];
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn, contextualLlmFn: situating });
    expect(embedCalls).toHaveLength(0);

    // With the paid tier off but wrapping on, a situated vector is not traded down.
    process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL = "1";
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    expect(embedCalls).toHaveLength(0);
  });

  // Value: protects=an LLM outage does not re-pay the embedder for fallback chunks on every write;
  // fails_when=a still-current deterministic fallback vector is re-embedded after the LLM fails again.
  it("keeps a fallback vector when the LLM tier falls back again", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn, contextualLlmFn: failing });
    embedCalls = [];
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn, contextualLlmFn: failing });
    expect(embedCalls).toHaveLength(0);
    // A retitle moves the deterministic input, so the fallback vectors are rebuilt.
    await indexDocument(storage, { sourcePath: SRC, text: doc("Bravo plan") }, { embedFn, contextualLlmFn: failing });
    expect(embedCalls.length).toBe((await chunkTexts()).length);
  });

  // Value: protects=keyword-only mode never drops a stored vector it cannot replace; fails_when=a
  // hash mismatch under keyword-only writes the unchanged chunks with null vectors.
  it("keeps stored vectors of unchanged text in keyword-only mode after a retitle", async () => {
    process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL = "1";
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    const before = await chunkTexts();
    const prevKw = process.env.MEMRAIN_KEYWORD_ONLY;
    process.env.MEMRAIN_KEYWORD_ONLY = "1";
    try {
      await indexDocument(storage, { sourcePath: SRC, text: doc("Bravo plan") }, { embedFn });
    } finally {
      if (prevKw === undefined) delete process.env.MEMRAIN_KEYWORD_ONLY;
      else process.env.MEMRAIN_KEYWORD_ONLY = prevKw;
    }
    const r = await storage.engine().query<{ content: string; has: boolean }>(
      `SELECT c.content, e.chunk_id IS NOT NULL AS has FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE c.document_id = (SELECT id FROM documents WHERE source_path = $1)`,
      [SRC],
    );
    const unchanged = r.rows.filter((row) => before.includes(row.content));
    expect(unchanged.length).toBeGreaterThan(0);
    expect(unchanged.every((row) => row.has)).toBe(true);
  });

  // Value: protects=a vector stamped by an earlier write is checked against the current input;
  // fails_when=the indexer stops writing the hash.
  it("stamps every vector it embeds", async () => {
    process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL = "1";
    await indexDocument(storage, { sourcePath: SRC, text: doc("Alpha plan") }, { embedFn });
    const r = await storage.engine().query<{ missing: number }>(
      `SELECT count(*)::int AS missing FROM embeddings WHERE input_hash IS NULL`,
    );
    expect(Number(r.rows[0]!.missing)).toBe(0);
  });
});
