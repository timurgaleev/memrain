/**
 * MEMRAIN_OWNER_ENTITY: a first-person claim the operator makes as `User` in a
 * first-party transcript lands on the owner's entity instead of being dropped.
 * Unset, nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { listFacts } from "../src/core/facts.ts";
import { isOwnerSpeaker, resolveOwnerEntity } from "../src/core/facts-owner.ts";
import {
  extractFactsForPage,
  writeExtractedFacts,
  type ExtractedFact,
} from "../src/core/facts-extract.ts";
import { runExtractConversationFacts } from "../src/commands/extract-conversation-facts.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;
const saved = process.env["MEMRAIN_OWNER_ENTITY"];

beforeEach(async () => {
  delete process.env["MEMRAIN_OWNER_ENTITY"];
  tmp = mkdtempSync(join(tmpdir(), "memrain-owner-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  if (saved === undefined) delete process.env["MEMRAIN_OWNER_ENTITY"];
  else process.env["MEMRAIN_OWNER_ENTITY"] = saved;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-sonnet-4-6-v1:0";

const OWNER_CLAIM: ExtractedFact = {
  fact: "Prefers Postgres over MySQL.",
  kind: "preference",
  entity: null,
  confidence: 0.9,
  notability: "high",
  attributed_to: "user",
};

function stub(facts: unknown[]): SonnetFn {
  return async () => ({
    text: JSON.stringify({ facts }),
    modelId: MODEL,
    usage: { inputTokens: 10, outputTokens: 10 },
  });
}

describe("resolveOwnerEntity", () => {
  it("is null when unset or blank", () => {
    expect(resolveOwnerEntity(undefined)).toBeNull();
    expect(resolveOwnerEntity("  ")).toBeNull();
  });
  it("returns a valid slug, lowercased", () => {
    expect(resolveOwnerEntity("People/Robin")).toBe("people/robin");
  });
  it("refuses a slug the ledger would refuse, and a placeholder page", () => {
    expect(resolveOwnerEntity("not a slug!")).toBeNull();
    expect(resolveOwnerEntity("unknown")).toBeNull();
  });
});

describe("isOwnerSpeaker", () => {
  it("matches only the labels a first-party importer gives the operator", () => {
    expect(isOwnerSpeaker("User")).toBe(true);
    expect(isOwnerSpeaker("me")).toBe(true);
    expect(isOwnerSpeaker("Speaker 2")).toBe(false);
    expect(isOwnerSpeaker("Claude")).toBe(false);
    expect(isOwnerSpeaker("Username")).toBe(false);
  });
});

describe("writeExtractedFacts with an owner entity", () => {
  it("unset: the entity-less claim is skipped exactly as before", async () => {
    const w = await writeExtractedFacts(storage, [OWNER_CLAIM], { firstParty: true });
    expect(w).toMatchObject({ written: 0, skipped: 1 });
  });

  it("set: a first-party user claim with no entity lands on the owner", async () => {
    process.env["MEMRAIN_OWNER_ENTITY"] = "people/robin";
    const w = await writeExtractedFacts(storage, [OWNER_CLAIM], { firstParty: true });
    expect(w.written).toBe(1);
    const rows = await listFacts(storage, "people/robin", { decay: false });
    expect(rows.map((r) => [r.fact, r.attributed_to])).toEqual([
      ["Prefers Postgres over MySQL.", "user"],
    ]);
  });

  it("set: never for a batch the caller did not call first-party", async () => {
    process.env["MEMRAIN_OWNER_ENTITY"] = "people/robin";
    const w = await writeExtractedFacts(storage, [OWNER_CLAIM], {});
    expect(w).toMatchObject({ written: 0, skipped: 1 });
  });

  it("set: never for an assistant claim or one with no speaker", async () => {
    process.env["MEMRAIN_OWNER_ENTITY"] = "people/robin";
    const w = await writeExtractedFacts(
      storage,
      [
        { ...OWNER_CLAIM, attributed_to: "assistant" },
        { ...OWNER_CLAIM, fact: "No speaker.", attributed_to: undefined },
      ],
      { firstParty: true },
    );
    expect(w).toMatchObject({ written: 0, skipped: 2 });
  });
});

describe("the callers decide what is first-party", () => {
  it("the conversation command maps `User` turns, not diarised speakers", async () => {
    const report = await runExtractConversationFacts(storage, {
      text:
        "[2026-08-08 10:00] User: I prefer Postgres over MySQL.\n" +
        "[2026-08-08 10:01] Speaker 2: I prefer Postgres over MySQL.\n",
      sonnetFn: stub([{ ...OWNER_CLAIM }]),
      modelId: MODEL,
      ownerEntity: "people/robin",
    });
    expect(report.factsWritten).toBe(1);
    expect(report.factsSkipped).toBe(1);
    const rows = await listFacts(storage, "people/robin", { decay: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_from).toBe("2026-08-08");
  });

  it("the page path maps on transcripts/ pages only", async () => {
    process.env["MEMRAIN_OWNER_ENTITY"] = "people/robin";
    const body = "User: I prefer Postgres over MySQL, and I have for years now. ".repeat(3);
    const transcript = await extractFactsForPage(storage, {
      slug: "transcripts/claude-code/s1-p1",
      type: "conversation",
      body,
      sonnetFn: stub([{ ...OWNER_CLAIM }]),
      modelId: MODEL,
      observationDate: null,
    });
    expect(transcript.factsWritten).toBe(1);
    const note = await extractFactsForPage(storage, {
      slug: "notes/someone-elses-chat",
      type: "note",
      body,
      sonnetFn: stub([{ ...OWNER_CLAIM, fact: "Another claim." }]),
      modelId: MODEL,
      observationDate: null,
    });
    expect(note.factsWritten).toBe(0);
  });
});
