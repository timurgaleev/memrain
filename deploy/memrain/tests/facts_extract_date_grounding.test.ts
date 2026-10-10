/**
 * Date grounding: the extractor is told when the text was written, a date the
 * model states for a claim is validated, and `valid_from` takes the model's
 * date over the turn's over the page's.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { listFacts } from "../src/core/facts.ts";
import {
  calendarDay,
  hasUnresolvedRelativeDate,
  observationDateLine,
  parseExtractedEventDate,
  resolveValidFrom,
} from "../src/core/llm/date-grounding.ts";
import {
  extractFactsForPage,
  extractFactsFromTurn,
  pageObservationDate,
  parseFactsResponse,
} from "../src/core/facts-extract.ts";
import { runExtractConversationFacts } from "../src/commands/extract-conversation-facts.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-dates-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-sonnet-4-6-v1:0";
const NOW = new Date("2026-10-10T12:00:00Z");

function recording(facts: unknown[]): { fn: SonnetFn; users: string[] } {
  const users: string[] = [];
  const fn: SonnetFn = async (input) => {
    users.push(input.user);
    return { text: JSON.stringify({ facts }), modelId: MODEL, usage: { inputTokens: 10, outputTokens: 10 } };
  };
  return { fn, users };
}

describe("date-grounding helpers", () => {
  it("parses only real days inside the sanity window", () => {
    expect(parseExtractedEventDate("2026-03-02", NOW)).toBe("2026-03-02");
    expect(parseExtractedEventDate("2026-02-30", NOW)).toBeNull();
    expect(parseExtractedEventDate("1899-12-31", NOW)).toBeNull();
    expect(parseExtractedEventDate("2027-10-11", NOW)).toBeNull();
    expect(parseExtractedEventDate("2026-03-02T10:00:00Z", NOW)).toBeNull();
    expect(parseExtractedEventDate("last week", NOW)).toBeNull();
    expect(parseExtractedEventDate(null, NOW)).toBeNull();
  });

  it("reads the day off a timestamp-shaped value", () => {
    expect(calendarDay("2026-08-08T23:59:00Z")).toBe("2026-08-08");
    expect(calendarDay("08/08/2026")).toBeNull();
  });

  it("orders valid_from: extracted, then caller, then nothing", () => {
    expect(resolveValidFrom({ extracted: "2026-08-01", caller: "2026-08-08" }))
      .toEqual({ date: "2026-08-01", source: "extracted" });
    expect(resolveValidFrom({ caller: "2026-08-08" })).toEqual({ date: "2026-08-08", source: "caller" });
    expect(resolveValidFrom({})).toBeNull();
  });

  it("says so when the observation date is unknown", () => {
    expect(observationDateLine("2026-08-08")).toStartWith("Observation date: 2026-08-08 ");
    expect(observationDateLine(null)).toBe("Observation date: unknown (keep relative dates as written).");
  });

  it("spots a relative phrase left unresolved", () => {
    expect(hasUnresolvedRelativeDate("flew to Lisbon last week")).toBe(true);
    expect(hasUnresolvedRelativeDate("flew to Lisbon the week of 2026-03-02")).toBe(false);
  });
});

describe("the extractor", () => {
  it("states the observation date on the first line of the user message", async () => {
    const { fn, users } = recording([]);
    await extractFactsFromTurn("Alice: I flew to Lisbon last week", { sonnetFn: fn, observationDate: "2026-03-09" });
    await extractFactsFromTurn("Alice: I flew to Lisbon last week", { sonnetFn: fn });
    expect(users[0]!.split("\n")[0]).toStartWith("Observation date: 2026-03-09 ");
    expect(users[1]!.split("\n")[0]).toBe("Observation date: unknown (keep relative dates as written).");
  });

  it("keeps a valid stated date and drops a guessed one", () => {
    const r = parseFactsResponse(
      JSON.stringify({
        facts: [
          { fact: "a", kind: "event", entity: "x", valid_from: "2026-03-02" },
          { fact: "b", kind: "event", entity: "x", valid_from: "next spring" },
        ],
      }),
      { now: NOW },
    );
    expect(r.facts.map((f) => f.valid_from)).toEqual(["2026-03-02", undefined]);
  });
});

describe("valid_from on the write paths", () => {
  it("the conversation command prefers the model's date to the turn's", async () => {
    const { fn, users } = recording([
      { fact: "Alice flew to Lisbon the week of 2026-03-02.", kind: "event", entity: "people/alice", valid_from: "2026-03-02" },
      { fact: "Alice likes Lisbon.", kind: "preference", entity: "people/alice" },
    ]);
    await runExtractConversationFacts(storage, {
      text: "[2026-03-09 10:00] Alice: I flew to Lisbon last week and loved it.\n",
      sonnetFn: fn,
      modelId: MODEL,
    });
    expect(users[0]!.split("\n")[0]).toStartWith("Observation date: 2026-03-09 ");
    const rows = await listFacts(storage, "people/alice", { decay: false });
    const byFact = Object.fromEntries(rows.map((r) => [r.fact, r.valid_from]));
    expect(byFact).toEqual({
      "Alice flew to Lisbon the week of 2026-03-02.": "2026-03-02",
      "Alice likes Lisbon.": "2026-03-09",
    });
  });

  it("the page path tells the model the page's own date but never guesses valid_from from it", async () => {
    const body = "Alice said she flew to Lisbon last week and that she loved the city a lot.";
    await putPage(storage, {
      slug: "transcripts/chatgpt/abc-p1",
      type: "conversation",
      markdown_body: body,
      compiled_truth: { date: "2026-03-09" },
      allowAdHocType: true,
    });
    expect(await pageObservationDate(storage, "transcripts/chatgpt/abc-p1", undefined)).toBe("2026-03-09");
    expect(await pageObservationDate(storage, "transcripts/chatgpt/missing", undefined)).toBeNull();

    const { fn, users } = recording([{ fact: "Alice likes Lisbon.", kind: "preference", entity: "people/alice" }]);
    const r = await extractFactsForPage(storage, {
      slug: "transcripts/chatgpt/abc-p1",
      type: "conversation",
      body,
      sonnetFn: fn,
      modelId: MODEL,
    });
    expect(r.factsWritten).toBe(1);
    expect(users[0]!.split("\n")[0]).toStartWith("Observation date: 2026-03-09 ");
    const rows = await listFacts(storage, "people/alice", { decay: false });
    expect(rows[0]!.valid_from).toBeNull();
  });
});
