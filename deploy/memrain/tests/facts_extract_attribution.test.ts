/**
 * Speaker attribution (mig130): the extractor records who asserted a claim,
 * the ledger keeps one speaker's claim apart from another's, and an
 * assistant's suggestion never stands in for the user's own claim.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact, listFacts } from "../src/core/facts.ts";
import { recallFact } from "../src/core/facts-recall.ts";
import {
  extractFactsFromTurn,
  parseFactsResponse,
  writeExtractedFacts,
} from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-attribution-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-sonnet-4-6-v1:0";

describe("parseFactsResponse reads the speaker", () => {
  it("keeps user / assistant / other and drops anything else", () => {
    const r = parseFactsResponse(
      JSON.stringify({
        facts: [
          { fact: "a", kind: "fact", entity: "x", attributed_to: "assistant" },
          { fact: "b", kind: "fact", entity: "x", attributed_to: "User" },
          { fact: "c", kind: "fact", entity: "x", attributed_to: "other" },
          { fact: "d", kind: "fact", entity: "x", attributed_to: "the model" },
          { fact: "e", kind: "fact", entity: "x", attributed_to: null },
        ],
      }),
    );
    expect(r.facts.map((f) => f.attributed_to)).toEqual([
      "assistant",
      "user",
      "other",
      undefined,
      undefined,
    ]);
  });
});

describe("the extractor prompt", () => {
  it("asks for the speaker in a static system block", async () => {
    const systems: string[] = [];
    const fn: SonnetFn = async (input) => {
      systems.push(input.system);
      return { text: '{"facts":[]}', modelId: MODEL, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await extractFactsFromTurn("User: I prefer tea", { sonnetFn: fn, observationDate: "2026-01-02" });
    await extractFactsFromTurn("Claude: try green tea", { sonnetFn: fn, observationDate: "2026-05-06" });
    expect(systems[0]).toContain('"attributed_to"');
    expect(systems[0]).toContain("Assistant recommended");
    // Byte-identical across turns and dates, so the prompt cache holds.
    expect(systems[1]).toBe(systems[0]!);
  });
});

describe("the claim identity includes the speaker", () => {
  it("an assistant's identical claim does not refresh the user's row", async () => {
    const user = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Use Postgres for the ledger.",
      written_by: "facts-extract",
      attributed_to: "user",
    });
    const assistant = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Use Postgres for the ledger.",
      written_by: "facts-extract",
      attributed_to: "assistant",
    });
    expect(user.inserted).toBe(true);
    expect(assistant.inserted).toBe(true);
    expect(assistant.id).not.toBe(user.id);

    // The same speaker restating it is still a refresh, not a twin.
    const again = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Use Postgres for the ledger.",
      written_by: "facts-extract",
      attributed_to: "assistant",
    });
    expect(again).toMatchObject({ id: assistant.id, inserted: false });

    const rows = await listFacts(storage, "people/alice", { decay: false });
    expect(rows.map((r) => r.attributed_to).sort()).toEqual(["assistant", "user"]);
    expect((await recallFact(storage, user.id!))?.attributed_to).toBe("user");
  });

  it("stores an unknown speaker as NULL, and a NULL claim matches only NULL", async () => {
    const a = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Likes tea.",
      attributed_to: "narrator",
    });
    const b = await addFact(storage, { entity_slug: "people/alice", fact: "Likes tea." });
    expect(b).toMatchObject({ id: a.id, inserted: false });
    const rows = await listFacts(storage, "people/alice", { decay: false });
    expect(rows.map((r) => r.attributed_to)).toEqual([null]);
  });

  it("a speaker's claim adopts the legacy row with no speaker instead of duplicating it", async () => {
    const legacy = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Prefers Postgres.",
      written_by: "facts-extract",
    });
    const user = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Prefers Postgres.",
      written_by: "facts-extract",
      attributed_to: "user",
    });
    expect(user).toMatchObject({ id: legacy.id, inserted: false });
    // The other speaker stays apart: the adopted row now belongs to the user.
    const assistant = await addFact(storage, {
      entity_slug: "people/alice",
      fact: "Prefers Postgres.",
      written_by: "facts-extract",
      attributed_to: "assistant",
    });
    expect(assistant.inserted).toBe(true);
    const rows = await listFacts(storage, "people/alice", { decay: false });
    expect(rows.map((r) => r.attributed_to).sort()).toEqual(["assistant", "user"]);
  });

  it("keeps one chunk's user and assistant claims apart, and a re-emit dates only its own row", async () => {
    const base = { entity_slug: "people/alice", fact: "Ship on Friday.", source_chunk_id: "c1" };
    const user = await addFact(storage, { ...base, written_by: "w1", attributed_to: "user", valid_from: "2026-01-01" });
    const assistant = await addFact(storage, { ...base, written_by: "w2", attributed_to: "assistant", valid_from: "2026-01-01" });
    expect(user.inserted).toBe(true);
    expect(assistant.inserted).toBe(true);
    expect(assistant.id).not.toBe(user.id);

    // A re-emit of the assistant's claim under a third writer hits the chunk
    // tuple: it corrects the assistant row's date and leaves the user's alone.
    const again = await addFact(storage, { ...base, written_by: "w3", attributed_to: "assistant", valid_from: "2026-02-02" });
    expect(again.inserted).toBe(false);
    const rows = await listFacts(storage, "people/alice", { decay: false });
    const byWho = Object.fromEntries(rows.map((r) => [r.attributed_to, r.valid_from]));
    expect(byWho).toEqual({ user: "2026-01-01", assistant: "2026-02-02" });
  });

  it("a speaker's chunk claim adopts a legacy row from the same chunk", async () => {
    const base = { entity_slug: "people/alice", fact: "Ship on Monday.", source_chunk_id: "c2" };
    const legacy = await addFact(storage, { ...base, written_by: "old-extractor" });
    const user = await addFact(storage, { ...base, written_by: "facts-extract", attributed_to: "user" });
    expect(user).toMatchObject({ id: legacy.id, inserted: false });
    const rows = await listFacts(storage, "people/alice", { decay: false });
    expect(rows.map((r) => r.attributed_to)).toEqual(["user"]);
  });

  it("refuses a speaker outside the CHECK set at the column", async () => {
    await expect(
      storage.engine().query(
        `INSERT INTO entity_facts (entity_slug, fact, attributed_to) VALUES ('people/x', 'f', 'robot')`,
      ),
    ).rejects.toThrow();
  });
});

describe("writeExtractedFacts", () => {
  it("writes each fact's speaker through to the ledger", async () => {
    const w = await writeExtractedFacts(
      storage,
      [
        {
          fact: "Assistant recommended pgvector.",
          kind: "belief",
          entity: "people/alice",
          confidence: 0.8,
          notability: "medium",
          attributed_to: "assistant",
        },
        {
          fact: "Alice prefers Postgres.",
          kind: "preference",
          entity: "people/alice",
          confidence: 0.9,
          notability: "high",
        },
      ],
      { writtenBy: "facts-extract" },
    );
    expect(w.written).toBe(2);
    const rows = await listFacts(storage, "people/alice", { decay: false, order: "recency" });
    const byFact = Object.fromEntries(rows.map((r) => [r.fact, r.attributed_to]));
    expect(byFact).toEqual({
      "Assistant recommended pgvector.": "assistant",
      "Alice prefers Postgres.": null,
    });
  });
});
