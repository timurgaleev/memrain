/**
 * `memrain embed --code`: the code run of the embedding backfill. Offline
 * embedder, PGLite. Covers the corpus split (prose runs never touch code, code
 * runs never touch prose), the dry-run price, the dollar cap and resuming, and
 * that a backfilled vector is one the code indexer then reuses.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import { codeEmbeddingInput } from "../src/core/code-embed.ts";
import { embeddingInputHash } from "../src/core/embedding-input-hash.ts";
import { DEFAULT_MODEL_ID, EMBED_DIMENSIONS } from "../src/core/embedding.ts";
import { worstCaseUsd } from "../src/core/budget.ts";
import { runEmbed } from "../src/commands/embed.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));
// Three code chunks of equal length, so one call's worst case prices them all.
const CODE_CHUNKS = ["function alpha() { return 1; }", "function bravo() { return 2; }", "function gamma() { return 3; }"];

let tmp: string;
let storage: Storage;

async function vectorCount(documentId: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = $1",
    [documentId],
  );
  return r.rows[0]?.n ?? 0;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-embed-code-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_code", sourcePath: "/src/x.ts", title: "x.ts", frontmatter: { kind: "code", language: "typescript" } },
    CODE_CHUNKS.map((text) => ({ text, entities: [] })),
  );
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_note", sourcePath: "/notes/a.md", title: "a", frontmatter: {}, embeddingModel: "det" },
    [{ text: "a prose chunk about retrieval", entities: [] }],
  );
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("runEmbedBackfill kind code", () => {
  // Value: protects=the automatic prose fills (embed-gaps, plain `memrain embed`) never pay for code;
  // fails_when=the default candidate set starts including code; why_new=code is now embeddable; seam=embed
  it("a prose run leaves code alone and a code run leaves prose alone", async () => {
    await runEmbedBackfill(storage.engine(), { embed: detEmbed });
    expect(await vectorCount("doc_code")).toBe(0);
    expect(await vectorCount("doc_note")).toBe(1);
    await storage.engine().query("DELETE FROM embeddings");
    const r = await runEmbedBackfill(storage.engine(), { kind: "code", embed: detEmbed, maxUsd: 1 });
    expect(r.embedded).toBe(3);
    expect(await vectorCount("doc_code")).toBe(3);
    expect(await vectorCount("doc_note")).toBe(0);
  });

  // Value: protects=the operator sees count and cost before paying; fails_when=the dry run writes or
  // reports no price; why_new=new command; seam=none
  it("prices the run in a dry run and writes nothing", async () => {
    const r = await runEmbedBackfill(storage.engine(), { kind: "code", dryRun: true });
    expect(r.candidates).toBe(3);
    const bytes = CODE_CHUNKS.reduce((n, t) => n + Buffer.byteLength(t), 0);
    expect(r.bytes).toBe(bytes);
    const perCall = worstCaseUsd({ operation: "embedding", model: DEFAULT_MODEL_ID, worstCase: { input: CODE_CHUNKS[0]!, maxOutputTokens: 0 } })!;
    expect(r.costUpperBoundUsd).toBeCloseTo(perCall * 3, 12);
    expect(r.estimatedUsd!).toBeLessThan(r.costUpperBoundUsd!);
    expect(await vectorCount("doc_code")).toBe(0);
    // A limited run is priced for the chunks it would take, not the whole corpus.
    const limited = await runEmbedBackfill(storage.engine(), { kind: "code", dryRun: true, limit: 1 });
    expect(limited.candidates).toBe(1);
    expect(limited.bytes).toBe(Buffer.byteLength(CODE_CHUNKS[0]!));
    expect(limited.costUpperBoundUsd).toBeCloseTo(perCall, 12);
  });

  // Value: protects=the cap is a hard ceiling checked before each call, and a capped run resumes;
  // fails_when=a call is sent past the cap or the stop loses what landed; why_new=new cap; seam=embed
  it("stops cleanly at the cap and a re-run continues", async () => {
    const perCall = worstCaseUsd({ operation: "embedding", model: DEFAULT_MODEL_ID, worstCase: { input: CODE_CHUNKS[0]!, maxOutputTokens: 0 } })!;
    let calls = 0;
    const embed = async (t: string) => {
      calls++;
      return deterministicEmbed(t);
    };
    const first = await runEmbedBackfill(storage.engine(), { kind: "code", embed, maxUsd: perCall * 1.5, concurrency: 4 });
    expect(first.capReached).toBe(true);
    expect(first.embedded).toBe(1);
    expect(calls).toBe(1);
    expect(first.reservedUsd!).toBeLessThanOrEqual(perCall * 1.5);
    const second = await runEmbedBackfill(storage.engine(), { kind: "code", embed, maxUsd: 1 });
    expect(second.capReached).toBe(false);
    expect(second.embedded).toBe(2);
    const third = await runEmbedBackfill(storage.engine(), { kind: "code", embed, maxUsd: 1 });
    expect(third.candidates).toBe(0);
    expect(calls).toBe(3);
  });

  // Value: protects=a backfilled code vector is one the indexer reuses, so the next sweep pays nothing;
  // fails_when=backfill and indexer embed different inputs or hash differently; why_new=new; seam=embed
  it("writes the input hash the code indexer computes, so a re-index reuses the vector", async () => {
    const text = "export function alpha() { return 1; }\nexport function bravo() { return 2; }\n";
    const doc = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text });
    expect(doc.embeddings).toBe(0); // no AWS in tests: the indexer embeds nothing on its own
    await runEmbedBackfill(storage.engine(), { kind: "code", embed: detEmbed, maxUsd: 1 });
    const { rows } = await storage.engine().query<{ content: string; input_hash: string }>(
      "SELECT c.content, e.input_hash FROM chunks c JOIN embeddings e ON e.chunk_id = c.id WHERE c.document_id = $1",
      [doc.documentId],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.input_hash).toBe(embeddingInputHash({
        model: DEFAULT_MODEL_ID, dimensions: EMBED_DIMENSIONS, tier: "none", input: codeEmbeddingInput(row.content),
      }));
    }
    let calls = 0;
    const again = await indexCodeDocument(storage, { sourcePath: "src/two.ts", text }, {
      embedFn: async (t) => {
        calls++;
        return deterministicEmbed(t);
      },
    });
    expect(calls).toBe(0);
    expect(again.embeddings).toBe(2);
  });

  // Value: protects=a code run never deletes prose vectors through the signature swap;
  // fails_when=MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE reaches a code run; why_new=Codex plan review; seam=env
  it("ignores the signature-swap switch", async () => {
    await storage.engine().query(
      `INSERT INTO embeddings (chunk_id, vector, model, embedding_signature)
       SELECT id, $1::vector, 'old-model', 'old-model:1024' FROM chunks WHERE document_id = 'doc_note'`,
      [JSON.stringify(deterministicEmbed("x"))],
    );
    const saved = process.env.MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE;
    process.env.MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE = "1";
    try {
      const r = await runEmbedBackfill(storage.engine(), { kind: "code", embed: detEmbed, maxUsd: 1 });
      expect(r.signatureStale).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE;
      else process.env.MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE = saved;
    }
    expect(await vectorCount("doc_note")).toBe(1);
    await expect(runEmbedBackfill(storage.engine(), { kind: "code", forceReembed: true, embed: detEmbed })).rejects.toThrow();
  });
});

describe("memrain embed --code flags", () => {
  // Value: protects=no paid code run without an explicit dollar cap; fails_when=--apply runs uncapped;
  // why_new=new command; seam=none (refused before storage opens)
  it("refuses an uncapped or contradictory code run", async () => {
    expect(await runEmbed({ code: true, apply: true })).toBe(1);
    expect(await runEmbed({ code: true, apply: true, maxUsd: 0 })).toBe(1);
    expect(await runEmbed({ code: true, apply: true, maxUsd: Number.NaN })).toBe(1);
    expect(await runEmbed({ code: true, apply: true, dryRun: true, maxUsd: 1 })).toBe(1);
    expect(await runEmbed({ code: true, all: true })).toBe(1);
    expect(await runEmbed({ code: true, stale: true })).toBe(1);
    expect(await runEmbed({ code: true, slugs: ["a"] })).toBe(1);
    expect(await runEmbed({ apply: true, maxUsd: 1 })).toBe(1);
  });
});
