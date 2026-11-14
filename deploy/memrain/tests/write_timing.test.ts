/**
 * The per-write latency split. An interactive write (`page_put` and friends)
 * logs one line saying how many chunks it reused versus paid for, and where the
 * paid time went — Bedrock, the inflight-slot wait, the spend ledger. A sweep
 * or reindex passes no label and logs nothing.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { newWriteTiming, noteWriteTiming, runWithWriteTiming } from "../src/core/write-timing.ts";
import { withInflightCap } from "../src/core/llm/gateway.ts";
import { trackedInvoke } from "../src/core/budget.ts";
import { deterministicEmbed } from "./det-embed.ts";

/** A tiny worst case: holds a fraction of a cent against a capped client. */
const SMALL = { input: "x", maxOutputTokens: 0 };

let tmp: string;
let storage: Storage;

const section = (n: number, extra = "") =>
  `## Section ${n}\n\nSection ${n} discusses topic number ${n} in some depth ${extra}. ` +
  `It covers the background, the core argument, and a few supporting details that ` +
  `run long enough to keep this section on its own as a distinct retrievable chunk ` +
  `well past the minimum chunk size floor used by the recursive markdown chunker.`;
const docText = (s2extra = "") => [section(1), section(2, s2extra), section(3)].join("\n\n");

const embedFn = async (text: string) => deterministicEmbed(text);
const contextualLlmFn = async () => ({ text: "situates the chunk", modelId: "fake" });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-write-timing-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function timingLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((line: string) => line.startsWith("[memrain] index-timing"));
}

describe("index timing line", () => {
  it("splits a labelled write into reused and paid chunks", async () => {
    const opts = { embedFn, contextualLlmFn };
    await indexDocument(storage, { sourcePath: "/notes/t.md", text: docText() }, opts);

    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await indexDocument(
        storage,
        { sourcePath: "/notes/t.md", text: docText("now edited") },
        { ...opts, timingLabel: "page_put" },
      );
      const lines = timingLines(log);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line).toContain("op=page_put");
      expect(line).toContain("status=ok");
      expect(line).toContain('path="/notes/t.md"');
      // One section changed: two chunks reuse their stored vectors, one pays for
      // the contextual call and the embed.
      expect(line).toContain("chunks=3");
      expect(line).toContain("reused=2");
      expect(line).toContain("llm_ok=1");
      expect(line).toContain("embeds=1");
      expect(line).toMatch(/ms_total=\d+ ms_bedrock=\d+ ms_slot=\d+ ms_queue=\d+ ms_ledger=\d+ ms_tx=\d+/);
    } finally {
      log.mockRestore();
    }
  });

  it("logs a failed write too, and quotes the path so it cannot split the line", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingEmbed = async () => {
        throw new Error("bedrock down");
      };
      await expect(
        indexDocument(
          storage,
          { sourcePath: "page://evil\nsrc/slug", text: docText() },
          { embedFn: failingEmbed, timingLabel: "page_put" },
        ),
      ).rejects.toThrow("bedrock down");
      const lines = timingLines(log);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("status=error");
      expect(lines[0]).toContain('path="page://evil\\nsrc/slug"');
      expect(lines[0]!.includes("\n")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("stays quiet for an unlabelled index", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await indexDocument(storage, { sourcePath: "/notes/q.md", text: docText() }, { embedFn });
      expect(timingLines(log)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });
});

describe("write timing scope", () => {
  it("accumulates what the paid layers report, and ignores reports outside a scope", async () => {
    noteWriteTiming("sendMs", 1000); // no scope — dropped
    const timing = newWriteTiming();
    const result = await runWithWriteTiming(timing, async () => {
      noteWriteTiming("queueMs", 5);
      await Promise.resolve();
      noteWriteTiming("sendMs", 40);
      noteWriteTiming("sendMs", 2);
      noteWriteTiming("ledgerMs", 3);
      return "done";
    });
    expect(result).toBe("done");
    expect(timing).toEqual({ slotMs: 0, queueMs: 5, sendMs: 42, ledgerMs: 3 });
  });

  it("keeps what was recorded when the scoped work throws", async () => {
    const timing = newWriteTiming();
    await expect(
      runWithWriteTiming(timing, async () => {
        noteWriteTiming("sendMs", 7);
        throw new Error("embed failed");
      }),
    ).rejects.toThrow("embed failed");
    expect(timing.sendMs).toBe(7);
  });

  it("is fed by the paid-call chokepoint", async () => {
    // No ledger engine is wired here, so the ledger work is a no-op; the send
    // time is what must land, or the live split would read zero Bedrock time.
    const timing = newWriteTiming();
    await runWithWriteTiming(timing, () =>
      trackedInvoke({ operation: "embedding", model: "amazon.titan-embed-text-v2:0", worstCase: SMALL }, async () => {
        await new Promise((r) => setTimeout(r, 25));
        return null;
      }),
    );
    expect(timing.sendMs).toBeGreaterThanOrEqual(20);
  });

  it("is fed by the inflight-slot wait", async () => {
    const prev = process.env.MEMRAIN_LLM_MAX_INFLIGHT;
    process.env.MEMRAIN_LLM_MAX_INFLIGHT = "1";
    try {
      let release!: () => void;
      const holder = withInflightCap(() => new Promise<void>((r) => (release = r)));
      const timing = newWriteTiming();
      const waiter = runWithWriteTiming(timing, () => withInflightCap(async () => "got a slot"));
      setTimeout(() => release(), 25);
      await holder;
      expect(await waiter).toBe("got a slot");
      expect(timing.queueMs).toBeGreaterThanOrEqual(20);
    } finally {
      if (prev === undefined) delete process.env.MEMRAIN_LLM_MAX_INFLIGHT;
      else process.env.MEMRAIN_LLM_MAX_INFLIGHT = prev;
    }
  });
});
