/**
 * Fact extraction when the model declines a window (a refusal or a content
 * filter): the window is read again in halves and the rest of the page counts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { extractFactsForPage, extractFactsOnDemand, splitDeclinedWindow } from "../src/core/facts-extract.ts";
import { putPage } from "../src/core/pages.ts";
import type { SonnetCallResult, SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;
const saved = process.env["MEMRAIN_FACTS_MAX_WINDOWS"];

beforeEach(async () => {
  delete process.env["MEMRAIN_FACTS_MAX_WINDOWS"];
  tmp = mkdtempSync(join(tmpdir(), "memrain-declined-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  if (saved === undefined) delete process.env["MEMRAIN_FACTS_MAX_WINDOWS"];
  else process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = saved;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-sonnet-4-6";
const QUIET = "Alice reviewed the budget for the quarter and agreed on the plan. ".repeat(10);
const TOUCHY = "SENSITIVE PASSAGE the model will not read. ".repeat(10);

function answer(fact: string): SonnetCallResult {
  return {
    text: JSON.stringify({ facts: [{ fact, kind: "fact", entity: "people/alice" }] }),
    modelId: MODEL, usage: { inputTokens: 100, outputTokens: 20 },
  };
}
const refusal: SonnetCallResult = { text: "", modelId: MODEL, usage: { inputTokens: 100, outputTokens: 0 }, stopReason: "content_filtered" };

/** Refuses any prompt that holds the touchy passage; answers the rest with one fact each. */
function filtering(): { fn: SonnetFn; users: string[] } {
  const users: string[] = [];
  const fn: SonnetFn = async (input) => {
    users.push(input.user);
    return input.user.includes("SENSITIVE PASSAGE") ? refusal : answer(`Claim ${users.length}.`);
  };
  return { fn, users };
}

async function absorbRows(): Promise<string[]> {
  const r = await storage.engine().query<{ summary: string }>(
    "SELECT summary FROM ingest_log WHERE source_type = 'facts:absorb' ORDER BY id",
  );
  return r.rows.map((row) => row.summary);
}

describe("declined windows", () => {
  // Value: protects=one passage the model refuses does not cost the page's other facts; fails_when=a refusal reads as an empty page again.
  it("retries a declined window as two halves and keeps the readable half", async () => {
    const body = `${QUIET}\n\n${TOUCHY}`;
    await putPage(storage, { slug: "notes/mixed", markdown_body: body });
    const { fn, users } = filtering();
    const r = await extractFactsForPage(storage, { slug: "notes/mixed", type: "note", body, sonnetFn: fn, observationDate: null, modelId: MODEL });
    expect(users).toHaveLength(3);
    expect(r.factsWritten).toBe(1);
    expect(r.absorbed).toBeNull();
    expect(r.declinedRanges).toHaveLength(1);
    const range = r.declinedRanges![0]!;
    expect(body.slice(range.start, range.end)).toContain("SENSITIVE PASSAGE");
    const rows = await absorbRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^model_declined: chars \d+-\d+ of \d+/);
    expect(rows[0]).not.toContain("SENSITIVE");
  });

  it("logs a short declined window without splitting it", async () => {
    const body = "SENSITIVE PASSAGE, short.";
    await putPage(storage, { slug: "notes/short", markdown_body: body });
    const { fn, users } = filtering();
    const r = await extractFactsForPage(storage, { slug: "notes/short", type: "note", body, sonnetFn: fn, observationDate: null, modelId: MODEL });
    expect(users).toHaveLength(1);
    expect(r.declinedRanges).toEqual([{ start: 0, end: body.length }]);
  });

  it("stops at the per-write cap instead of paying for the halves", async () => {
    const body = `${QUIET}\n\n${TOUCHY}`;
    await putPage(storage, { slug: "notes/mixed", markdown_body: body });
    const { fn, users } = filtering();
    // One worst-case reservation fits, a second does not.
    const r = await extractFactsForPage(storage, { slug: "notes/mixed", type: "note", body, sonnetFn: fn, observationDate: null, modelId: MODEL, maxBudgetUsd: 0.0722 });
    expect(users).toHaveLength(1);
    expect(r.absorbed).toBe("budget_exhausted");
  });

  // Value: protects=a declined window does not drop the windows after it; fails_when=a refusal ends the page's run.
  it("still reads the windows after a declined one", async () => {
    process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = "2";
    const touchyWindow = Array.from({ length: 30 }, () => TOUCHY).join("\n\n").slice(0, 11_000);
    const body = `${touchyWindow}\n\n${QUIET.repeat(3)}`;
    await putPage(storage, { slug: "notes/two", markdown_body: body });
    const { fn, users } = filtering();
    const r = await extractFactsForPage(storage, { slug: "notes/two", type: "note", body, sonnetFn: fn, observationDate: null, modelId: MODEL });
    expect(users).toHaveLength(4);
    expect(r.factsWritten).toBe(1);
    expect(r.declinedRanges).toHaveLength(2);
    expect(r.absorbed).toBeNull();
  });

  // Value: protects=extract_facts says why a refused text came back empty; fails_when=a refusal reads as a quiet turn.
  it("reports a declined on-demand extraction as model_declined", async () => {
    const { fn } = filtering();
    const r = await extractFactsOnDemand(TOUCHY, { sonnetFn: fn, modelId: MODEL });
    expect(r.facts).toEqual([]);
    expect(r.skipped).toBe("model_declined");
    const quiet = await extractFactsOnDemand(QUIET, { sonnetFn: fn, modelId: MODEL });
    expect(quiet.skipped).toBeUndefined();
  });

  it("splits at the paragraph break nearest the middle", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
    expect(splitDeclinedWindow(text)!.map((h) => h.offset)).toEqual([0, 300]);
    expect(splitDeclinedWindow("too short")).toBeNull();
  });
});
