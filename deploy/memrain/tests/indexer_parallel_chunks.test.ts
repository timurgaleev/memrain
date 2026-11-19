/**
 * Chunks are situated and embedded in parallel under one write-path ceiling
 * (`MEMRAIN_EMBED_MAX_INFLIGHT`) shared by every concurrent write. Serially, a
 * page paid ~1.3 s of Bedrock per chunk, one after the other.
 *
 * Locks: the ceiling holds (per write and across writes), each chunk keeps its
 * own vector whatever order the calls finish in, and the half-write guard still
 * holds — a hard failure stops new chunks and writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { _resetWriteEmbedSlotsForTests, acquireWriteEmbedSlot } from "../src/core/concurrency.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
let prevWidth: string | undefined;

const section = (n: number) =>
  `## Section ${n}\n\nSection ${n} discusses topic number ${n} in some depth. ` +
  `It covers the background, the core argument, and a few supporting details that ` +
  `run long enough to keep this section on its own as a distinct retrievable chunk ` +
  `well past the minimum chunk size floor used by the recursive markdown chunker.`;
const doc = (n: number) => Array.from({ length: n }, (_, i) => section(i + 1)).join("\n\n");

/** An embedder that records how many calls overlap, with a per-call delay. */
function trackingEmbed(delayFor: (text: string) => number) {
  const state = { active: 0, peak: 0, calls: [] as string[] };
  const fn = async (text: string): Promise<number[]> => {
    state.calls.push(text);
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    await new Promise((r) => setTimeout(r, delayFor(text)));
    state.active--;
    return deterministicEmbed(text);
  };
  return { fn, state };
}

function setWidth(n: number): void {
  process.env.MEMRAIN_EMBED_MAX_INFLIGHT = String(n);
  _resetWriteEmbedSlotsForTests();
}

let quiet: ReturnType<typeof spyOn>;

beforeEach(async () => {
  quiet = spyOn(console, "error").mockImplementation(() => {});
  prevWidth = process.env.MEMRAIN_EMBED_MAX_INFLIGHT;
  tmp = mkdtempSync(join(tmpdir(), "memrain-parallel-chunks-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  quiet.mockRestore();
  if (prevWidth === undefined) delete process.env.MEMRAIN_EMBED_MAX_INFLIGHT;
  else process.env.MEMRAIN_EMBED_MAX_INFLIGHT = prevWidth;
  _resetWriteEmbedSlotsForTests();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function storedVectors(sourcePath: string): Promise<{ content: string; vec: string }[]> {
  const r = await storage.engine().query<{ content: string; vec: string }>(
    `SELECT c.content, e.vector::text AS vec
       FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
      WHERE c.document_id = (SELECT id FROM documents WHERE source_path = $1)
      ORDER BY c.chunk_index`,
    [sourcePath],
  );
  return r.rows;
}

describe("parallel chunk embedding", () => {
  it("overlaps chunks up to the ceiling and no further", async () => {
    setWidth(3);
    const { fn, state } = trackingEmbed(() => 20);
    const r = await indexDocument(storage, { sourcePath: "/p/wide.md", text: doc(8) }, { embedFn: fn, timingLabel: "page_put" });
    expect(r.chunks).toBe(8);
    expect(state.calls).toHaveLength(8);
    expect(state.peak).toBe(3);
  });

  it("runs one at a time at width 1", async () => {
    setWidth(1);
    const { fn, state } = trackingEmbed(() => 5);
    await indexDocument(storage, { sourcePath: "/p/serial.md", text: doc(4) }, { embedFn: fn, timingLabel: "page_put" });
    expect(state.peak).toBe(1);
  });

  it("shares one ceiling across concurrent writes", async () => {
    setWidth(2);
    const { fn, state } = trackingEmbed(() => 20);
    await Promise.all([
      indexDocument(storage, { sourcePath: "/p/a.md", text: doc(4) }, { embedFn: fn }),
      indexDocument(storage, { sourcePath: "/p/b.md", text: doc(4) }, { embedFn: fn }),
    ]);
    expect(state.calls).toHaveLength(8);
    expect(state.peak).toBe(2);
  });

  it("keeps each chunk's own vector when calls finish out of order", async () => {
    setWidth(4);
    // Earlier chunks take LONGER, so completion order is the reverse of chunk order.
    const { fn } = trackingEmbed((text) => {
      const m = /Section (\d+)/.exec(text);
      return 60 - Number(m?.[1] ?? 0) * 10;
    });
    await indexDocument(storage, { sourcePath: "/p/order.md", text: doc(5) }, { embedFn: fn, timingLabel: "page_put" });
    const rows = await storedVectors("/p/order.md");
    expect(rows).toHaveLength(5);
    // pgvector stores float4, so compare within rounding — and require each
    // stored vector to be far from every OTHER chunk's, or a swap would pass.
    const expected = await Promise.all(rows.map((row) => deterministicEmbed(row.content)));
    const gap = (a: number[], b: number[]) => Math.max(...a.map((x, k) => Math.abs(x - b[k]!)));
    rows.forEach((row, i) => {
      const stored = JSON.parse(row.vec) as number[];
      expect(gap(stored, expected[i]!)).toBeLessThan(1e-6);
      expected.forEach((other, j) => {
        if (j !== i) expect(gap(stored, other)).toBeGreaterThan(1e-3);
      });
    });
  });

  it("stops starting chunks after a hard failure and writes nothing", async () => {
    setWidth(1);
    const calls: string[] = [];
    const failing = async (text: string): Promise<number[]> => {
      calls.push(text);
      if (text.includes("Section 2")) throw new Error("bedrock down");
      return deterministicEmbed(text);
    };
    await expect(
      indexDocument(storage, { sourcePath: "/p/fail.md", text: doc(5) }, { embedFn: failing, timingLabel: "page_put" }),
    ).rejects.toThrow("bedrock down");
    // Serial here, so nothing after the failing chunk was started.
    expect(calls.map((c) => /Section (\d+)/.exec(c)?.[1])).toEqual(["1", "2"]);
    const docs = await storage.engine().query(
      `SELECT 1 FROM documents WHERE source_path = '/p/fail.md'`,
    );
    expect(docs.rows).toHaveLength(0);
  });

  it("lets in-flight siblings settle before the failure surfaces", async () => {
    setWidth(3);
    let settled = 0;
    const failing = async (text: string): Promise<number[]> => {
      if (text.includes("Section 1")) throw new Error("bedrock down");
      await new Promise((r) => setTimeout(r, 30));
      settled++;
      return deterministicEmbed(text);
    };
    await expect(
      indexDocument(storage, { sourcePath: "/p/siblings.md", text: doc(6) }, { embedFn: failing, timingLabel: "page_put" }),
    ).rejects.toThrow("bedrock down");
    // Sections 2 and 3 were already in flight beside section 1; they finish
    // before the error propagates, and no fourth chunk ever starts.
    expect(settled).toBe(2);
  });

  it("keeps a background index serial", async () => {
    setWidth(4);
    const { fn, state } = trackingEmbed(() => 10);
    await indexDocument(storage, { sourcePath: "/p/sweep.md", text: doc(5) }, { embedFn: fn });
    expect(state.calls).toHaveLength(5);
    expect(state.peak).toBe(1);
  });

  it("runs the contextual call in parallel too", async () => {
    setWidth(3);
    const llm = { active: 0, peak: 0 };
    const contextualLlmFn = async () => {
      llm.active++;
      llm.peak = Math.max(llm.peak, llm.active);
      await new Promise((r) => setTimeout(r, 20));
      llm.active--;
      return { text: "situates the chunk", modelId: "fake" };
    };
    await indexDocument(
      storage,
      { sourcePath: "/p/ctx.md", text: doc(6) },
      { embedFn: async (t: string) => deterministicEmbed(t), contextualLlmFn, timingLabel: "page_put" },
    );
    expect(llm.peak).toBe(3);
  });

  it("takes no slot for a chunk whose stored vector is reused", async () => {
    setWidth(1);
    const embedFn = async (t: string) => deterministicEmbed(t);
    await indexDocument(storage, { sourcePath: "/p/reuse.md", text: doc(4) }, { embedFn });
    // Hold the only slot: a re-put of identical text must still finish, because
    // every chunk is reused and none of them should wait for a slot.
    const release = await acquireWriteEmbedSlot();
    try {
      const r = await Promise.race([
        indexDocument(storage, { sourcePath: "/p/reuse.md", text: doc(4) }, { embedFn, timingLabel: "page_put" }),
        new Promise<"stuck">((res) => setTimeout(() => res("stuck"), 500)),
      ]);
      expect(r).not.toBe("stuck");
    } finally {
      release();
    }
  });

  it("starts nothing new after a failure, even for a worker that was waiting on a slot", async () => {
    setWidth(2);
    // Another write holds one of the two slots, so this document's second worker
    // queues behind it while the first worker's chunk fails.
    const held = await acquireWriteEmbedSlot();
    const started: string[] = [];
    const failing = async (text: string): Promise<number[]> => {
      started.push(/Section (\d+)/.exec(text)?.[1] ?? "?");
      throw new Error("bedrock down");
    };
    // Subscribe at once: the write rejects as soon as the waiting worker is
    // handed the failed chunk's slot and declines to start chunk 2.
    const outcome = expect(
      indexDocument(
        storage,
        { sourcePath: "/p/contended.md", text: doc(4) },
        { embedFn: failing, timingLabel: "page_put" },
      ),
    ).rejects.toThrow("bedrock down");
    try {
      await outcome;
    } finally {
      held();
    }
    expect(started).toEqual(["1"]);
  });
});
