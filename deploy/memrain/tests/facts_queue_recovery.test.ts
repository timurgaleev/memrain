import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getFactsQueue, __resetFactsQueueForTests } from "../src/core/facts-queue.ts";
import * as extraction from "../src/core/facts-extract.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { getIngestLog } from "../src/core/ingest-log.ts";
import { backfillEnabled } from "../src/core/cycle/conversation-facts-backfill.ts";
import { selectTickPhases } from "../src/recipes/cycle.ts";

describe("fact recovery scheduling", () => {
  it("inherits extraction's opt-in unless backfill was explicitly disabled", () => {
    expect(backfillEnabled(undefined, "1")).toBe(true);
    expect(backfillEnabled(undefined, "0")).toBe(false);
    expect(backfillEnabled("0", "1")).toBe(false);
    expect(backfillEnabled("1", "0")).toBe(true);
  });
  it("runs bounded recovery once per day outside quiet hours and honors skips", () => {
    const opts = { inQuiet: false, synthEnabled: false, factsBackfillEnabled: true, skipPhases: new Set<string>() };
    expect(selectTickPhases(opts)).toContain("conversation-facts-backfill");
    expect(selectTickPhases({ ...opts, ranTodayUtc: new Set(["conversation-facts-backfill"]) })).not.toContain("conversation-facts-backfill");
    expect(selectTickPhases({ ...opts, inQuiet: true })).not.toContain("conversation-facts-backfill");
    expect(selectTickPhases({ ...opts, skipPhases: new Set(["conversation-facts-backfill"]) })).not.toContain("conversation-facts-backfill");
  });
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact queue recovery ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("records dropped and interrupted writes durably through the dispatch hooks", async () => {
    __resetFactsQueueForTests();
    const queue = getFactsQueue({ cap: 1 });
    const saved = process.env.MEMRAIN_FACTS_EXTRACTION;
    const mirror = process.env.MEMRAIN_PAGE_MIRROR_SYNC;
    process.env.MEMRAIN_FACTS_EXTRACTION = "1";
    process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0";
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const extract = spyOn(extraction, "extractFactsForPage").mockImplementation(async () => {
      await blocked;
      return { factsWritten: 0, factsSkipped: 0, factsFailed: 0, spentUsd: 0, absorbed: null, windowsRun: 0, junkSkipped: 0, truncated_chars: 0 };
    });
    const write = async (name: string) => {
      const result = await dispatchTool(db.storage, { name: "page_put", arguments: { slug: `notes/recovery-${name}`, type: "note", markdown_body: "Alice reviewed the new project budget and agreed to deliver the first phase next March. ".repeat(2) } });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    };
    try {
      await write("active");
      await write("overflow");
      await write("pending");
      expect(queue.getCounters().dropped_overflow).toBe(1);
      await queue.shutdown();
      await write("after-shutdown");
      await queue.shutdown();
      const rows = await getIngestLog(db.storage.engine(), { source_type: "facts:absorb", limit: 20 });
      const reasons = Object.fromEntries(rows.map(row => [row.source_ref, row.summary!.split(":")[0]]));
      expect(reasons).toEqual({ "notes/recovery-active": "queue_shutdown", "notes/recovery-overflow": "queue_overflow", "notes/recovery-pending": "queue_shutdown", "notes/recovery-after-shutdown": "queue_shutdown" });
      expect(rows).toHaveLength(4);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(queue.pendingCount()).toBe(0);
    } finally {
      release();
      await blocked;
      extract.mockRestore();
      __resetFactsQueueForTests();
      if (saved === undefined) delete process.env.MEMRAIN_FACTS_EXTRACTION; else process.env.MEMRAIN_FACTS_EXTRACTION = saved;
      if (mirror === undefined) delete process.env.MEMRAIN_PAGE_MIRROR_SYNC; else process.env.MEMRAIN_PAGE_MIRROR_SYNC = mirror;
    }
  });
});
