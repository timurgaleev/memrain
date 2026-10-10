/**
 * Item 2 — conversation-facts backfill cycle phase. Default-OFF; when driven
 * with an injected fake Sonnet it extracts facts from prose pages that have no
 * facts-extract facts yet, and skips them once they do (idempotency without a
 * schema watermark).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  conversationFactsBackfillPhase,
  backfillEnabled,
} from "../src/core/cycle/conversation-facts-backfill.ts";
import { FACTS_EXTRACT_VERSION } from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { ingestSessions } from "../src/core/transcripts/ingest.ts";
import type { TranscriptSession } from "../src/core/transcripts/types.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;

const LONG_BODY =
  "Met Alice today. She confirmed she prefers tea and is moving to Gotham " +
  "next month to lead the Acme rollout.";

function fakeSonnet(): SonnetFn {
  return async () => ({
    text: JSON.stringify({
      facts: [
        {
          fact: "prefers tea",
          kind: "preference",
          entity: "people/alice",
          confidence: 0.8,
          notability: "medium",
        },
      ],
    }),
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 30 },
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-backfill-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("backfillEnabled", () => {
  it("is OFF by default", () => {
    expect(backfillEnabled(undefined)).toBe(false);
    expect(backfillEnabled("1")).toBe(true);
  });
});

describe("conversationFactsBackfillPhase", () => {
  it("backfills an eligible page then skips it on re-run", async () => {
    await putPage(storage, {
      slug: "notes/alice-sync",
      type: "note",
      markdown_body: LONG_BODY,
    });
    // An entity page must be ineligible (wrong type) — it should be ignored.
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      markdown_body: LONG_BODY,
    });

    const first = await conversationFactsBackfillPhase(storage, {
      sonnetFn: fakeSonnet(),
    });
    expect(first.ran).toBe(true);
    expect(first.pagesConsidered).toBe(1); // only the note, not the person page
    expect(first.pagesProcessed).toBe(1);
    expect(first.factsWritten).toBe(1);

    // Re-run: the note now has a facts-extract fact, so it is no longer considered.
    const second = await conversationFactsBackfillPhase(storage, {
      sonnetFn: fakeSonnet(),
    });
    expect(second.pagesConsidered).toBe(0);
    expect(second.factsWritten).toBe(0);
  });

  it("stops at the brain-wide page cap", async () => {
    for (let i = 0; i < 3; i++) {
      await putPage(storage, {
        slug: `notes/n${i}`,
        type: "note",
        markdown_body: LONG_BODY,
      });
    }
    const r = await conversationFactsBackfillPhase(storage, {
      sonnetFn: fakeSonnet(),
      maxPages: 2,
    });
    expect(r.pagesConsidered).toBe(2);
    expect(r.pagesProcessed).toBe(2);
  });
});

describe("zero-yield memo (facts_backfill_scans)", () => {
  function countingSonnet(text: () => string): { fn: SonnetFn; calls: () => number } {
    let n = 0;
    return {
      fn: async () => {
        n += 1;
        return {
          text: text(),
          modelId: "eu.anthropic.claude-sonnet-4-6",
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
      calls: () => n,
    };
  }
  const EMPTY = () => JSON.stringify({ facts: [] });

  async function scanRows(): Promise<{ source_id: string; slug: string; extractor_version: string }[]> {
    const r = await storage.engine().query<{ source_id: string; slug: string; extractor_version: string }>(
      "SELECT source_id, slug, extractor_version FROM facts_backfill_scans ORDER BY source_id, slug",
    );
    return r.rows;
  }

  it("memoizes a zero-yield page so the next run makes no model call", async () => {
    await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    const m = countingSonnet(EMPTY);

    const first = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
    expect(first.zeroYieldRecorded).toBe(1);
    expect(first.errors).toEqual([]);
    expect(await scanRows()).toEqual([
      { source_id: "default", slug: "notes/quiet", extractor_version: FACTS_EXTRACT_VERSION },
    ]);

    const second = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
    expect(second.pagesConsidered).toBe(0);
    expect(second.zeroYieldRecorded).toBe(0);
  });

  it("re-opens a memoized page once its body changes", async () => {
    await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    const m = countingSonnet(EMPTY);
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);

    await putPage(storage, {
      slug: "notes/quiet",
      type: "note",
      markdown_body: `${LONG_BODY} Later she also mentioned the Q3 budget review.`,
    });
    const third = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(2);
    expect(third.zeroYieldRecorded).toBe(1);
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(2);
  });

  it("never memoizes an unreadable answer, so it is retried", async () => {
    await putPage(storage, { slug: "notes/garbled", type: "note", markdown_body: LONG_BODY });
    const m = countingSonnet(() => "I could not find any structured facts here, sorry.");

    const first = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(first.zeroYieldRecorded).toBe(0);
    expect(first.errors.map((e) => e.message)).toEqual(["extraction absorbed: parse_failure"]);
    expect(await scanRows()).toEqual([]);

    const callsAfterFirst = m.calls();
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBeGreaterThan(callsAfterFirst);
  });

  it("a memo under another source does not suppress the page", async () => {
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      ["tenant_b", "__tenant_b__"],
    );
    const put = await putPage(storage, {
      slug: "notes/shared-name",
      type: "note",
      markdown_body: LONG_BODY,
      source_id: "tenant_b",
    });
    await storage.engine().query(
      `INSERT INTO facts_backfill_scans (source_id, slug, content_hash, extractor_version, outcome)
       VALUES ('default', 'notes/shared-name', $1, $2, 'zero_yield')`,
      [put.content_hash, FACTS_EXTRACT_VERSION],
    );
    const m = countingSonnet(EMPTY);
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
    expect(r.zeroYieldRecorded).toBe(1);
    expect((await scanRows()).map((row) => row.source_id)).toEqual(["default", "tenant_b"]);
  });

  it("watermarks a page that yields facts as extracted, not as zero-yield", async () => {
    const put = await putPage(storage, { slug: "notes/alice-sync", type: "note", markdown_body: LONG_BODY });
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: fakeSonnet() });
    expect(r.factsWritten).toBe(1);
    expect(r.zeroYieldRecorded).toBe(0);
    const rows = await storage.engine().query<{ outcome: string; content_hash: string }>(
      "SELECT outcome, content_hash FROM facts_backfill_scans",
    );
    expect(rows.rows).toEqual([{ outcome: "extracted", content_hash: put.content_hash }]);
  });

  it("re-covers an extracted page once its body changes", async () => {
    await putPage(storage, { slug: "notes/alice-sync", type: "note", markdown_body: LONG_BODY });
    let calls = 0;
    const sonnet: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet()(input);
    };
    await conversationFactsBackfillPhase(storage, { sonnetFn: sonnet });
    expect((await conversationFactsBackfillPhase(storage, { sonnetFn: sonnet })).pagesConsidered).toBe(0);
    expect(calls).toBe(1);

    // The facts from the old body are still there; the edit alone re-opens it.
    await putPage(storage, {
      slug: "notes/alice-sync",
      type: "note",
      markdown_body: `${LONG_BODY} She also signed off the Q3 hiring plan.`,
    });
    const third = await conversationFactsBackfillPhase(storage, { sonnetFn: sonnet });
    expect(third.pagesConsidered).toBe(1);
    expect(calls).toBe(2);
    expect((await conversationFactsBackfillPhase(storage, { sonnetFn: sonnet })).pagesConsidered).toBe(0);
  });

  it("still treats an unwatermarked page with an on-write fact as covered", async () => {
    await putPage(storage, { slug: "notes/alice-sync", type: "note", markdown_body: LONG_BODY });
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, source_slug, source_id, written_by)
       VALUES ('people/alice', 'prefers tea', 'notes/alice-sync', 'default', 'facts-extract')`,
    );
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: fakeSonnet() });
    expect(r.pagesConsidered).toBe(0);
  });

  it("a memo from another extractor version does not suppress the page", async () => {
    const put = await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    await storage.engine().query(
      `INSERT INTO facts_backfill_scans (source_id, slug, content_hash, extractor_version, outcome)
       VALUES ('default', 'notes/quiet', $1, '0', 'zero_yield')`,
      [put.content_hash],
    );
    const m = countingSonnet(EMPTY);
    await conversationFactsBackfillPhase(storage, { sonnetFn: m.fn });
    expect(m.calls()).toBe(1);
  });

  it("never memoizes a page whose extracted facts all failed to write", async () => {
    await putPage(storage, { slug: "notes/alice-sync", type: "note", markdown_body: LONG_BODY });
    const engine = storage.engine();
    const realQuery = engine.query.bind(engine);
    const spy = spyOn(engine, "query").mockImplementation(((sql: string, params?: unknown[]) => {
      if (/INSERT INTO entity_facts/i.test(sql)) {
        return Promise.reject(new Error("connection reset"));
      }
      return realQuery(sql, params);
    }) as typeof engine.query);
    let first;
    try {
      first = await conversationFactsBackfillPhase(storage, { sonnetFn: fakeSonnet() });
    } finally {
      spy.mockRestore();
    }
    expect(first.factsWritten).toBe(0);
    expect(first.zeroYieldRecorded).toBe(0);
    expect(first.errors.map((e) => e.message)).toEqual(["1 extracted fact(s) failed to write"]);
    expect(await scanRows()).toEqual([]);

    const second = await conversationFactsBackfillPhase(storage, { sonnetFn: fakeSonnet() });
    expect(second.pagesProcessed).toBe(1);
    expect(second.factsWritten).toBe(1);
  });

  it("the migration is idempotent across a second init", async () => {
    await putPage(storage, { slug: "notes/quiet", type: "note", markdown_body: LONG_BODY });
    await conversationFactsBackfillPhase(storage, { sonnetFn: countingSonnet(EMPTY).fn });
    await storage.close();
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    expect((await scanRows()).length).toBe(1);
  });
});

describe("imported transcripts", () => {
  it("backfills a part written by transcript ingest, then memoizes it when empty", async () => {
    const t0 = Date.parse("2026-04-02T08:00:00Z");
    const session: TranscriptSession = {
      format: "chatgpt",
      id: "tea",
      title: "Tea talk",
      startedAt: t0,
      messages: [
        { id: "m0", role: "user", speaker: "User", text: LONG_BODY, ts: t0 },
        { id: "m1", role: "assistant", speaker: "ChatGPT", text: "Noted, tea and Gotham.", ts: t0 + 1000 },
      ],
    };
    const ingested = await ingestSessions(storage, [session], {
      sourceId: "default",
      embedFn: async (t: string) => deterministicEmbed(t),
    });
    expect(ingested.parts_written).toBe(1);

    let calls = 0;
    const sonnetFn: SonnetFn = async () => {
      calls += 1;
      return {
        text: JSON.stringify({ facts: [] }),
        modelId: "eu.anthropic.claude-sonnet-4-6",
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    };
    const first = await conversationFactsBackfillPhase(storage, { sonnetFn });
    expect(calls).toBe(1);
    expect(first.zeroYieldRecorded).toBe(1);
    const memo = await storage.engine().query<{ slug: string }>("SELECT slug FROM facts_backfill_scans");
    expect(memo.rows.map((r) => r.slug)).toEqual(["transcripts/chatgpt/tea-p1"]);

    await conversationFactsBackfillPhase(storage, { sonnetFn });
    expect(calls).toBe(1);
  });
});
