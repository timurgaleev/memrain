/**
 * MEMRAIN_FACTS_MAX_WINDOWS: a long non-transcript page can get more than one
 * extractor call. Default 1 keeps the historical single window.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  EXTRACT_WINDOW_CHARS,
  extractFactsForPage,
  extractionWindows,
  factsMaxWindows,
} from "../src/core/facts-extract.ts";
import { putPage } from "../src/core/pages.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;
const saved = process.env["MEMRAIN_FACTS_MAX_WINDOWS"];

beforeEach(async () => {
  delete process.env["MEMRAIN_FACTS_MAX_WINDOWS"];
  tmp = mkdtempSync(join(tmpdir(), "memrain-windows-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  if (saved === undefined) delete process.env["MEMRAIN_FACTS_MAX_WINDOWS"];
  else process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = saved;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** ~30K chars of distinct paragraphs, each well under one window. */
const LONG = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(100)}`).join("\n\n");

function counting(): { fn: SonnetFn; users: string[] } {
  const users: string[] = [];
  const fn: SonnetFn = async (input) => {
    users.push(input.user);
    const n = users.length;
    return {
      text: JSON.stringify({ facts: [{ fact: `Claim ${n}.`, kind: "fact", entity: "people/alice" }] }),
      modelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  };
  return { fn, users };
}

describe("factsMaxWindows", () => {
  it("defaults to one and accepts only a positive integer", () => {
    expect(factsMaxWindows(undefined)).toBe(1);
    expect(factsMaxWindows("0")).toBe(1);
    expect(factsMaxWindows("2.5")).toBe(1);
    expect(factsMaxWindows("3")).toBe(3);
  });
});

describe("extractionWindows", () => {
  it("returns the body whole at the default, for transcripts and for a short body", () => {
    expect(extractionWindows("notes/x", LONG, 1)).toEqual([LONG]);
    expect(extractionWindows("transcripts/chatgpt/x-p1", LONG, 4)).toEqual([LONG]);
    expect(extractionWindows("notes/x", "short", 4)).toEqual(["short"]);
  });

  it("cuts at paragraph boundaries into windows no wider than the extractor reads", () => {
    const w = extractionWindows("notes/x", LONG, 10);
    expect(w.length).toBeGreaterThan(1);
    for (const piece of w) {
      expect(piece.length).toBeLessThanOrEqual(EXTRACT_WINDOW_CHARS);
      expect(piece.startsWith("Paragraph ")).toBe(true);
    }
    expect(w.join("\n\n")).toBe(LONG);
  });

  it("stops at the cap", () => {
    expect(extractionWindows("notes/x", LONG, 2)).toHaveLength(2);
  });

  it("hard-cuts a paragraph longer than a window", () => {
    const w = extractionWindows("notes/x", "x".repeat(EXTRACT_WINDOW_CHARS * 2 + 5), 5);
    expect(w.map((p) => p.length)).toEqual([EXTRACT_WINDOW_CHARS, EXTRACT_WINDOW_CHARS, 5]);
  });
});

describe("extractFactsForPage over windows", () => {
  beforeEach(async () => { await putPage(storage, { slug: "notes/long", markdown_body: LONG }); });
  it("accounts for a blank window without reserving or calling a model", async () => {
    const body = " \t\n".repeat(40);
    await putPage(storage, { slug: "notes/long", markdown_body: body });
    const { fn, users } = counting();
    const result = await extractFactsForPage(storage, {
      slug: "notes/long", type: "note", body, sonnetFn: fn, observationDate: null, maxBudgetUsd: 0,
    });
    expect(result).toMatchObject({ windowsRun: 0, spentUsd: 0, truncated_chars: 0, absorbed: null });
    expect(users).toHaveLength(0);
  });

  for (const blocked of ["budget", "gateway"] as const) it(`keeps blank-window coverage when the first paid window stops at ${blocked}`, async () => {
    process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = "2";
    const body = " ".repeat(EXTRACT_WINDOW_CHARS) + "Actual content.";
    await putPage(storage, { slug: "notes/long", markdown_body: body });
    let calls = 0;
    const sonnetFn: SonnetFn = async () => { calls++; throw new Error("gateway unavailable"); };
    const result = await extractFactsForPage(storage, {
      slug: "notes/long", type: "note", body, sonnetFn, observationDate: null,
      maxBudgetUsd: blocked === "budget" ? 0 : 1,
    });
    expect(result.truncated_chars).toBe("Actual content.".length);
    expect(result.windowsRun).toBe(0);
    expect(result.factsWritten).toBe(0);
    expect(result.absorbed).not.toBeNull();
    expect(calls).toBe(blocked === "budget" ? 0 : 1);
  });

  it("skips blank windows without trimming text or expanding the selected range", async () => {
    process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = "3";
    const body = " ".repeat(EXTRACT_WINDOW_CHARS) + "x".repeat(EXTRACT_WINDOW_CHARS)
      + "\t".repeat(EXTRACT_WINDOW_CHARS) + "unread tail";
    await putPage(storage, { slug: "notes/long", markdown_body: body });
    const { fn, users } = counting();
    const result = await extractFactsForPage(storage, {
      slug: "notes/long", type: "note", body, sonnetFn: fn, observationDate: null,
    });
    expect(users).toHaveLength(1);
    expect(users[0]).toContain("x".repeat(EXTRACT_WINDOW_CHARS));
    expect(result.windowsRun).toBe(1);
    expect(result.truncated_chars).toBe("unread tail".length);
  });

  it("makes one call at the default", async () => {
    const { fn, users } = counting();
    const r = await extractFactsForPage(storage, {
      slug: "notes/long", type: "note", body: LONG, sonnetFn: fn, observationDate: null,
    });
    expect(users).toHaveLength(1);
    expect(r.windowsRun).toBe(1);
    expect(r.truncated_chars).toBe(LONG.length - EXTRACT_WINDOW_CHARS);
  });

  it("makes one call per window when raised, and writes every window's facts", async () => {
    process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = "4";
    const { fn, users } = counting();
    const r = await extractFactsForPage(storage, {
      slug: "notes/long", type: "note", body: LONG, sonnetFn: fn, observationDate: null,
    });
    expect(users.length).toBeGreaterThan(1);
    expect(r.windowsRun).toBe(users.length);
    expect(r.truncated_chars).toBe(0);
    expect(r.factsWritten).toBe(users.length);
    expect(users[1]).toContain("Paragraph ");
    expect(users[1]).not.toContain("Paragraph 0:");
  });

  it("stops at the first window the per-write cap refuses", async () => {
    process.env["MEMRAIN_FACTS_MAX_WINDOWS"] = "4";
    const { fn, users } = counting();
    // A worst-case reservation is $0.027 at Sonnet prices; each settled call
    // costs $0.0006, so the second reservation no longer fits.
    const r = await extractFactsForPage(storage, {
      slug: "notes/long", type: "note", body: LONG, sonnetFn: fn, observationDate: null, maxBudgetUsd: 0.0275, modelId: "eu.anthropic.claude-sonnet-4-6",
    });
    expect(users).toHaveLength(1);
    expect(r.windowsRun).toBe(1);
    expect(r.truncated_chars).toBeGreaterThan(0);
    expect(r.factsWritten).toBe(1);
    expect(r.absorbed).toBe("budget_exhausted");
  });
});
