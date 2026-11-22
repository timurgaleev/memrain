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
import {
  _setVectorCacheBytesForTests,
  CODE_EMBED_MAX_BYTES,
  codeEmbedCap,
  codeEmbeddingInput,
  EmbedSpendCap,
  readVectorIndexBudget,
} from "../src/core/code-embed.ts";
import { embeddingInputHash } from "../src/core/embedding-input-hash.ts";
import { DEFAULT_MODEL_ID, EMBED_DIMENSIONS } from "../src/core/embedding.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { registerSource } from "../src/core/sources.ts";
import { deterministicEmbed } from "./det-embed.ts";

const dir = mkdtempSync(join(tmpdir(), "tb-indexer-code-embed-"));
let storage: Storage;

const TWO = `export function alpha() { return 1; }
export function beta() { return 2; }
`;
/** The input the indexer sends for one of TWO's functions. */
const inputOf = (body: string, name: string, sourcePath = "src/two.ts") =>
  codeEmbeddingInput({ text: body, sourcePath, language: "typescript", symbolType: "function", symbolName: name });

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

const savedMaxUsd = process.env.MEMRAIN_CODE_EMBED_MAX_USD;

beforeAll(async () => {
  storage = new Storage({ dbPath: dir });
  await storage.init();
  // Code embedding is off by default; these tests turn it on unless they say otherwise.
  process.env.MEMRAIN_CODE_EMBED_MAX_USD = "1";
});

beforeEach(async () => {
  await storage.raw().exec("DELETE FROM documents");
});

afterAll(async () => {
  if (savedMaxUsd === undefined) delete process.env.MEMRAIN_CODE_EMBED_MAX_USD;
  else process.env.MEMRAIN_CODE_EMBED_MAX_USD = savedMaxUsd;
  _setVectorCacheBytesForTests(undefined);
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("indexCodeDocument embeddings", () => {
  // Value: protects=a code chunk lands with a vector and the input hash the backfill would compute;
  // fails_when=the indexer writes code graph-only again or hashes a different input than codeEmbeddingInput;
  // why_new=code was never embedded before; seam=embedFn (the markdown indexer's seam)
  it("embeds each chunk under its header and stamps the input hash of codeEmbeddingInput", async () => {
    const { inputs, embedFn } = counting();
    const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn });
    expect(r.chunks).toBe(2);
    expect(r.embeddings).toBe(2);
    expect(inputs).toEqual([
      "[TypeScript] src/two.ts function alpha\n\nfunction alpha() { return 1; }",
      "[TypeScript] src/two.ts function beta\n\nfunction beta() { return 2; }",
    ]);
    const rows = await vectorRows(r.documentId);
    expect(rows.map((row) => row.input_hash)).toEqual(inputs.map((input) => embeddingInputHash({
      model: DEFAULT_MODEL_ID, dimensions: EMBED_DIMENSIONS, tier: "none", input,
    })));
    for (const row of rows) expect(row.model).toBe(DEFAULT_MODEL_ID);
  });

  // Value: protects=a plain-words question can match a function through its doc comment, its name, file and
  // class; fails_when=the vector is built from the bare body again (a JS/TS doc comment sits outside it);
  // why_new=code vectors lacked every signal but the body; seam=embedFn
  it("puts the doc comment, the symbol and its class in the input; an edit above it keeps the vector", async () => {
    const src = [
      "export class Repo {",
      "  /** Persist the record and flush the write-ahead log. */",
      "  save(): void { flush(); }",
      "}",
      "",
    ].join("\n");
    const { inputs, embedFn } = counting();
    await indexCodeDocument(storage, { sourcePath: "/opt/checkout/app/src/core/repo.ts", text: src }, { embedFn });
    const save = inputs.find((input) => input.includes("method save"))!;
    expect(save).toBe(
      "[TypeScript] app/src/core/repo.ts method save (in Repo)\n\n" +
        "/** Persist the record and flush the write-ahead log. */\nsave(): void { flush(); }",
    );
    // Lines added above the class move every line number; the input carries none, so nothing is re-embedded.
    const again = counting();
    await indexCodeDocument(storage, {
      sourcePath: "/opt/checkout/app/src/core/repo.ts",
      text: `\n\n\n${src}`,
    }, { embedFn: again.embedFn });
    expect(again.inputs).toEqual([]);
  });

  // Value: protects=a fresh install, a config reset or a new tenant pays for no code vector until the operator
  // opts in; fails_when=MEMRAIN_CODE_EMBED_MAX_USD falls back to a non-zero default (the default that let a
  // sweep overload the 1 GB RDS); why_new=code embedding default flipped to off; seam=env + embedFn
  it("embeds nothing when MEMRAIN_CODE_EMBED_MAX_USD is unset", async () => {
    delete process.env.MEMRAIN_CODE_EMBED_MAX_USD;
    try {
      const { inputs, embedFn } = counting();
      const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn });
      expect(inputs).toEqual([]);
      expect(r.chunks).toBe(2);
      expect(r.embeddings).toBe(0);
    } finally {
      process.env.MEMRAIN_CODE_EMBED_MAX_USD = "1";
    }
  });

  // Value: protects=a sweep never grows the vector index past the database cache, whatever its dollar cap;
  // fails_when=codeEmbedCap ignores the index budget and a sweep embeds every chunk; why_new=the code backfill
  // overloaded the 1 GB RDS; seam=cache bytes + embedFn
  it("stops embedding once the vector index would outgrow the database cache", async () => {
    const budget = await readVectorIndexBudget(storage.engine());
    const rowBytes = (budget.vectorBytes + 640) * 1.1;
    // Room for exactly one more vector beyond what is stored.
    _setVectorCacheBytesForTests(Math.floor(rowBytes * (budget.rows + 1.5)));
    try {
      const cap = await codeEmbedCap(storage.engine());
      const { inputs, embedFn } = counting();
      const r = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text: TWO }, { embedFn, embedCap: cap });
      expect(inputs.length).toBe(1);
      expect(r.embeddings).toBe(1);
      expect(r.embeddingDeferred).toBe(1);
      expect(cap.stopReason).toContain("shared_buffers");
    } finally {
      _setVectorCacheBytesForTests(undefined);
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
    expect(edit.inputs).toEqual([inputOf("function beta() { return 3; }", "beta")]);
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
    expect(Buffer.byteLength(inputs[0]!, "utf8")).toBe(CODE_EMBED_MAX_BYTES);
  });

  // Value: protects=dense text (CJK, hex, base64) stays under Titan's token limit, which a character cap
  // did not; fails_when=the cut counts characters instead of bytes or splits a code point; why_new=review
  // finding on the 16k-character cut; seam=none
  it("cuts dense text by bytes, on a code point boundary", () => {
    const head = "[Code] x\n\n"; // 10 bytes
    const cjk = codeEmbeddingInput({ text: "漢".repeat(10_000), sourcePath: "x" }); // 3 bytes each
    expect(Buffer.byteLength(cjk, "utf8")).toBeLessThanOrEqual(CODE_EMBED_MAX_BYTES);
    expect(cjk).toBe(head + "漢".repeat(Math.floor((CODE_EMBED_MAX_BYTES - 10) / 3)));
    const emoji = codeEmbeddingInput({ text: "a" + "\u{1F600}".repeat(5_000), sourcePath: "x" }); // 4 bytes, a surrogate pair each
    expect(Buffer.byteLength(emoji, "utf8")).toBeLessThanOrEqual(CODE_EMBED_MAX_BYTES);
    expect(emoji).toBe(head + "a" + "\u{1F600}".repeat(Math.floor((CODE_EMBED_MAX_BYTES - 11) / 4)));
  });

  // Value: protects=a file the write's owner fence refuses pays for no vector; fails_when=embedding runs
  // before the ownership check, so a refused file re-pays every sweep; why_new=review finding; seam=embedFn
  it("refuses a file owned by another source before embedding anything", async () => {
    const { inputs, embedFn } = counting();
    const first = await indexCodeDocument(storage, { sourcePath: "src/owned.ts", text: TWO });
    await registerSource(storage.raw(), { id: "src-b", kind: "code", pathPrefix: "/elsewhere/" });
    await storage.raw().query("UPDATE documents SET source_id = 'src-b' WHERE id = $1", [first.documentId]);
    await expect(indexCodeDocument(storage, { sourcePath: "src/owned.ts", text: TWO, expectOwner: "src-a" }, { embedFn }))
      .rejects.toThrow();
    expect(inputs).toEqual([]);
  });
});
