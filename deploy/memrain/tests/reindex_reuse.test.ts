/**
 * Unchanged-chunk embedding reuse. Re-indexing a doc with one chunk changed must
 * re-embed ONLY that chunk (the rest reuse their stored vectors), so a one-line
 * edit no longer pays Bedrock for the whole document.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
let embedCalls: string[];

// Counting deterministic embedder — records every input it was asked to embed.
const countingEmbed = async (text: string): Promise<number[]> => {
  embedCalls.push(text);
  return deterministicEmbed(text);
};

// Three headed sections → three stable chunks (the recursive chunker splits on
// headings first, and never applies sliding overlap across a heading boundary),
// so editing one section's body changes exactly one chunk.
// Each body is padded past the ~200-char min-chunk floor so the sections don't
// get merged back together into one chunk.
const section = (n: number, extra = "") =>
  `## Section ${n}\n\nSection ${n} discusses topic number ${n} in some depth ${extra}. ` +
  `It covers the background, the core argument, and a few supporting details that ` +
  `run long enough to keep this section on its own as a distinct retrievable chunk ` +
  `well past the minimum chunk size floor used by the recursive markdown chunker.`;
const docText = (s2extra = "") =>
  [section(1), section(2, s2extra), section(3)].join("\n\n");

const SRC = "/notes/reuse.md";

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-reindex-reuse-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  embedCalls = [];
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function vectors(): Promise<Map<number, string>> {
  const r = await storage.engine().query<{ chunk_index: number; vec: string }>(
    `SELECT c.chunk_index, e.vector::text AS vec
       FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.document_id = (SELECT id FROM documents WHERE source_path = $1)
      ORDER BY c.chunk_index`,
    [SRC],
  );
  return new Map(r.rows.map((row) => [Number(row.chunk_index), row.vec]));
}

describe("unchanged-chunk embedding reuse", () => {
  it("re-embeds only the changed chunk on re-index", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: docText() }, { embedFn: countingEmbed });
    const firstPass = embedCalls.length;
    expect(firstPass).toBeGreaterThanOrEqual(3); // one embed per chunk
    const before = await vectors();
    const chunkCount = before.size;
    expect(chunkCount).toBeGreaterThanOrEqual(3);

    embedCalls = [];
    // Re-index with ONLY paragraph 2 changed.
    await indexDocument(
      storage,
      { sourcePath: SRC, text: docText("CHANGED-TOKEN-XYZ") },
      { embedFn: countingEmbed },
    );
    // Exactly one chunk re-embedded (the changed one); the rest reused.
    expect(embedCalls.length).toBe(1);

    const after = await vectors();
    // Unchanged chunks keep byte-identical vectors; the changed one differs.
    expect(after.get(0)).toBe(before.get(0));
    expect(after.get(2)).toBe(before.get(2));
    expect(after.get(1)).not.toBe(before.get(1));
  });

  it("re-embeds everything when the embedding model changes", async () => {
    await indexDocument(
      storage,
      { sourcePath: SRC, text: docText() },
      { embedFn: countingEmbed, embeddingModel: "model-a" },
    );
    const chunkCount = (await vectors()).size;
    embedCalls = [];
    await indexDocument(
      storage,
      { sourcePath: SRC, text: docText() }, // identical text
      { embedFn: countingEmbed, embeddingModel: "model-b" }, // but new model
    );
    // Model mismatch invalidates reuse — every chunk re-embeds.
    expect(embedCalls.length).toBe(chunkCount);
  });

  it("reuses the chunks a mid-page insertion only shifted", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: docText() }, { embedFn: countingEmbed });
    embedCalls = [];
    // A new section between 1 and 2 moves sections 2 and 3 one index down. Keyed
    // by position they looked changed and were paid for again; keyed by text
    // only the new section is.
    const inserted = [section(1), section(9), section(2), section(3)].join("\n\n");
    await indexDocument(storage, { sourcePath: SRC, text: inserted }, { embedFn: countingEmbed });
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toContain("Section 9");
  });



  it("never reuses a vector from another document", async () => {
    await indexDocument(storage, { sourcePath: SRC, text: docText() }, { embedFn: countingEmbed });
    embedCalls = [];
    // Byte-identical text under a different path is a different document — and
    // possibly a different tenant's — so it pays for its own vectors.
    await indexDocument(storage, { sourcePath: "/notes/other.md", text: docText() }, { embedFn: countingEmbed });
    expect(embedCalls.length).toBe((await vectors()).size);
  });
});
