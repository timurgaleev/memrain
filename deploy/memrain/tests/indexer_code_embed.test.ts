/**
 * Code chunk vectors written by the code indexer: what is embedded, what is
 * reused, what the cap and a failing embedder leave behind. PGLite, offline
 * embedder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { CODE_EMBED_MAX_CHARS, codeEmbeddingInput, EmbedSpendCap } from "../src/core/code-embed.ts";
import { embeddingInputHash } from "../src/core/embedding-input-hash.ts";
import { DEFAULT_MODEL_ID, EMBED_DIMENSIONS } from "../src/core/embedding.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { deterministicEmbed } from "./det-embed.ts";

const dir = mkdtempSync(join(tmpdir(), "tb-indexer-code-embed-"));
let storage: Storage;

const TWO = `export function alpha() { return 1; }
export function beta() { return 2; }
`;

function counting() {
  const inputs: string[] = [];
  const embedFn = async (text: string) => {
    inputs.push(text);
    return deterministicEmbed(text);
  };
  return { inputs, embedFn };
}

function bedrockError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

async function vectorRows(documentId: string) {
  const { rows } = await storage.raw().query<{ content: string; input_hash: string | null; model: string | null }>(
    `SELECT c.content, e.input_hash, e.model
       FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.document_id = $1 ORDER BY c.chunk_index`,
    [documentId],
  );
  return rows;
}

beforeAll(async () => {
  storage = new Storage({ dbPath: dir });
  await storage.init();
});

beforeEach(async () => {
  await storage.raw().exec("DELETE FROM documents");
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("indexCodeDocument embeddings", () => {
  // Value: protects=a code chunk lands with a vector and the input hash the backfill would compute;
  // fails_when=the indexer writes code graph-only again or hashes a different input than codeEmbeddingInput;
  // why_new=code was never embedded before; seam=embedFn (the markdown indexer's seam)
  it("embeds each chunk raw and stamps the input hash of codeEmbeddingInput", async () => {
    const { inputs, embedFn } = counting();
    const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn });
    expect(r.chunks).toBe(2);
    expect(r.embeddings).toBe(2);
    expect(inputs).toEqual(["function alpha() { return 1; }", "function beta() { return 2; }"]);
    for (const row of await vectorRows(r.documentId)) {
      expect(row.model).toBe(DEFAULT_MODEL_ID);
      expect(row.input_hash).toBe(embeddingInputHash({
        model: DEFAULT_MODEL_ID, dimensions: EMBED_DIMENSIONS, tier: "none", input: codeEmbeddingInput(row.content),
      }));
    }
  });

  // Value: protects=re-indexing an unchanged file pays nothing and a one-symbol edit pays for one chunk;
  // fails_when=prior vectors are not reused by text + hash; why_new=the sweep re-indexes every changed file
  // and would otherwise re-pay for the whole file; seam=embedFn
  it("reuses stored vectors: an unchanged re-index makes no call, an edit embeds only the changed chunk", async () => {
    await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn: counting().embedFn });
    const again = counting();
    const same = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn: again.embedFn });
    expect(again.inputs).toEqual([]);
    expect(same.embeddings).toBe(2);
    const edit = counting();
    await indexCodeDocument(storage, {
      sourcePath: "src/two.ts",
      text: TWO.replace("return 2;", "return 3;"),
    }, { embedFn: edit.embedFn });
    expect(edit.inputs).toEqual(["function beta() { return 3; }"]);
  });

  // Value: protects=a passing Bedrock failure never costs the code graph; fails_when=an embed error aborts
  // the write (the file drops out of code_def/code_callers); why_new=new paid call inside the graph write; seam=embedFn
  it("keeps the graph write when the embedder fails, leaving the chunks without a vector", async () => {
    let calls = 0;
    const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, {
      embedFn: async () => {
        calls++;
        throw bedrockError("ThrottlingException");
      },
    });
    expect(r.chunks).toBe(2);
    expect(r.embeddings).toBe(0);
    expect(r.embeddingDeferred).toBe(2);
    // The rest of the file waits instead of retrying the same outage per chunk.
    expect(calls).toBe(1);
  });

  // Value: protects=a failure every call would repeat stops a whole sweep, not just one file;
  // fails_when=each later file pays a failing call again; why_new=sweeps share one cap; seam=embedFn + shared cap
  it("stops the shared run after a failure that would repeat", async () => {
    const cap = new EmbedSpendCap(10);
    let calls = 0;
    const failing = async () => {
      calls++;
      throw bedrockError("AccessDeniedException");
    };
    await indexCodeDocument(storage, { sourcePath: "src/a.ts", text: TWO }, { embedFn: failing, embedCap: cap });
    await indexCodeDocument(storage, { sourcePath: "src/b.ts", text: TWO }, { embedFn: failing, embedCap: cap });
    expect(calls).toBe(1);
    expect(cap.stopReason).toContain("AccessDeniedException");
  });

  // Value: protects=a model refusing one chunk's text skips only that chunk; fails_when=one oversize symbol
  // leaves the rest of the file without vectors; why_new=new; seam=embedFn
  it("skips only the chunk whose text the model refuses", async () => {
    const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, {
      embedFn: async (text) => {
        if (text.includes("alpha")) throw bedrockError("ValidationException", "Input is too long for requested model");
        return deterministicEmbed(text);
      },
    });
    expect(r.embeddings).toBe(1);
    expect(r.embeddingDeferred).toBe(1);
  });

  // Value: protects=the sweep's dollar cap holds before any call is sent; fails_when=a call is made past
  // the cap; why_new=new per-run cap on an unbounded sweep; seam=shared cap
  it("sends nothing past the cap: the chunks land without a vector", async () => {
    const { inputs, embedFn } = counting();
    const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, {
      embedFn,
      embedCap: new EmbedSpendCap(0),
    });
    expect(inputs).toEqual([]);
    expect(r.chunks).toBe(2);
    expect(r.embeddingDeferred).toBe(2);
  });

  // Value: protects=a reviewed rechunk fails instead of writing chunks that lost their vectors;
  // fails_when=requireCompleteEmbeddings is ignored; why_new=rechunk-apply now embeds code; seam=embedFn
  it("fails the write under requireCompleteEmbeddings, keeping the previous chunks", async () => {
    const first = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn: counting().embedFn });
    await expect(indexCodeDocument(storage, {
      sourcePath: "src/two.ts",
      text: TWO.replace("return 2;", "return 3;"),
    }, {
      embedFn: async () => { throw bedrockError("ThrottlingException"); },
      requireCompleteEmbeddings: true,
    })).rejects.toThrow();
    const rows = await vectorRows(first.documentId);
    expect(rows.map((r) => r.content)).toContain("function beta() { return 2; }");
    expect(rows.every((r) => r.input_hash !== null)).toBe(true);
  });

  // Value: protects=a huge symbol is embedded from its head instead of being refused by Titan;
  // fails_when=the input is sent uncapped; why_new=symbols reach 200 KB on this repo; seam=embedFn
  it("caps the embedding input of an oversize chunk", async () => {
    const { inputs, embedFn } = counting();
    const body = `export function big() {\n${"  const x = 1;\n".repeat(3000)}}\n`;
    await indexCodeDocument(storage, { sourcePath: "src/big.ts", text: body }, { embedFn });
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.length).toBe(CODE_EMBED_MAX_CHARS);
  });
});
