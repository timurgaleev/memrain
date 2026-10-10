/**
 * Conversation facts are anchored in CONVERSATION time, not extraction time:
 * a backfilled transcript's facts carry the day the turn was spoken
 * (`valid_from`), and a transcript with no real date keeps the NULL fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact, listFacts } from "../src/core/facts.ts";
import { runExtractConversationFacts } from "../src/commands/extract-conversation-facts.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-convfacts-"));
  storage = new Storage({ dbPath: join(tmp, "brain.pglite") });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Canned model: echoes the fenced turn back as a single fact about Alice, so
 *  each written row is traceable to the turn it came from. */
const stub: SonnetFn = async (input) => {
  const turn = input.user.match(/<turn>\n([\s\S]*?)\n<\/turn>/)?.[1] ?? "";
  return {
    text: JSON.stringify({
      facts: [
        {
          fact: turn,
          kind: "fact",
          entity: "people/alice",
          confidence: 0.9,
          notability: "medium",
        },
      ],
    }),
    modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
};

describe("runExtractConversationFacts valid_from", () => {
  it("anchors each fact at the turn's own date, not today", async () => {
    const transcript = [
      "**Alice** (2024-03-15 9:00 AM): I moved to Lisbon",
      "**Alice** (2024-03-16 8:00 AM): I started at Acme",
    ].join("\n");
    const report = await runExtractConversationFacts(storage, {
      text: transcript,
      sourceSlug: "chat-log",
      maxBudgetUsd: 1.0,
      sonnetFn: stub,
    });
    expect(report.factsWritten).toBe(2);

    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    const byDate = new Map(rows.map((r) => [r.valid_from, r.fact]));
    expect([...byDate.keys()].sort()).toEqual(["2024-03-15", "2024-03-16"]);
    expect(byDate.get("2024-03-15")).toContain("Lisbon");
    expect(byDate.get("2024-03-16")).toContain("Acme");
    // The write itself still happened now — the two clocks are independent.
    const today = new Date().toISOString().slice(0, 10);
    expect(rows.every((r) => r.written_at.startsWith(today))).toBe(true);
  });

  it("uses the supplied date context for a time-only transcript", async () => {
    await runExtractConversationFacts(storage, {
      text: "[18:37] Alice: I moved to Lisbon",
      dateContext: "2023-11-02",
      maxBudgetUsd: 1.0,
      sonnetFn: stub,
    });
    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_from).toBe("2023-11-02");
  });

  it("leaves valid_from NULL when the transcript carries no real date", async () => {
    await runExtractConversationFacts(storage, {
      text: "[18:37] Alice: I moved to Lisbon",
      maxBudgetUsd: 1.0,
      sonnetFn: stub,
    });
    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    expect(rows).toHaveLength(1);
    // Epoch-anchored parse: asserting 1970 would be worse than asserting nothing.
    expect(rows[0]!.valid_from).toBeNull();
  });
});

describe("runExtractConversationFacts write failures", () => {
  it("counts a fact that failed to write and logs its error class, never its text", async () => {
    await storage.engine().query(
      `ALTER TABLE entity_facts ADD CONSTRAINT test_refuse CHECK (fact NOT LIKE '%secret-plan%')`,
    );
    const logged: string[] = [];
    const prev = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let report;
    try {
      report = await runExtractConversationFacts(storage, {
        text: "[2024-03-15 09:00] Alice: my secret-plan is Lisbon\n[2024-03-15 09:01] Alice: I like tea",
        maxBudgetUsd: 1.0,
        sonnetFn: stub,
      });
    } finally {
      console.error = prev;
    }
    expect(report.factsWritten).toBe(1);
    expect(report.factsFailed).toBe(1);
    expect(logged.join("\n")).toContain("fact write failed");
    expect(logged.join("\n")).not.toContain("secret-plan");
  });
});

describe("addFact valid_from", () => {
  it("stores a plain date and reduces an ISO timestamp to its UTC day", async () => {
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "plain date",
      valid_from: "2024-03-15",
    });
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "iso timestamp",
      // Late-evening UTC: a local-timezone conversion would land on the 16th.
      valid_from: "2024-03-15T23:30:00Z",
    });
    await addFact(storage, {
      entity_slug: "people/alice",
      fact: "garbage date",
      valid_from: "not a date",
    });
    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    const byFact = new Map(rows.map((r) => [r.fact, r.valid_from]));
    expect(byFact.get("plain date")).toBe("2024-03-15");
    expect(byFact.get("iso timestamp")).toBe("2024-03-15");
    expect(byFact.get("garbage date")).toBeNull();
  });
});

/** The dedup key is (entity_slug, fact, source_chunk_id) — it deliberately does
 *  NOT carry `valid_from`, so re-reading a chunk with a better date has to
 *  correct the row on file rather than mint a second one or be swallowed. */
describe("addFact valid_from on a re-emitted chunk fact", () => {
  const emit = (validFrom?: string) =>
    addFact(storage, {
      entity_slug: "people/alice",
      fact: "moved to Lisbon",
      source_chunk_id: "chunk-1",
      ...(validFrom ? { valid_from: validFrom } : {}),
    });

  it("lands a corrected date on the existing row", async () => {
    expect((await emit("2024-03-15")).inserted).toBe(true);
    // Same claim, same chunk: no second row, but the anchor moves.
    expect((await emit("2024-03-16")).inserted).toBe(false);
    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_from).toBe("2024-03-16");
  });

  /**
   * The correction belongs to the insert attempt, not to a statement after it:
   * a crash in between would move the date on a row the same call decided not to
   * touch. A re-emit under another writer takes the ON CONFLICT path (the same
   * writer collapses earlier, on the restatement lookup), and the transaction is
   * rolled back after its callback returned.
   */
  it("rolls the correction back with the insert it belongs to", async () => {
    await emit("2024-03-15");
    const engine = storage.engine();
    const orig = engine.transaction.bind(engine);
    engine.transaction = (async (fn: Parameters<typeof engine.transaction>[0]) => {
      let out: unknown;
      try {
        await orig(async (tx) => {
          out = await fn(tx);
          throw new Error("crash before commit");
        });
      } catch (err) {
        if (!/crash before commit/.test(String(err))) throw err;
      }
      return out;
    }) as typeof engine.transaction;
    try {
      await addFact(storage, {
        entity_slug: "people/alice",
        fact: "moved to Lisbon",
        source_chunk_id: "chunk-1",
        valid_from: "2024-03-16",
        written_by: "another-extractor",
      });
    } finally {
      engine.transaction = orig;
    }
    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_from).toBe("2024-03-15");
  });

  it("keeps the stored date when the re-emit carries none", async () => {
    await emit("2024-03-15");
    await emit();
    const rows = await listFacts(storage, "people/alice", { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_from).toBe("2024-03-15");
  });
});
