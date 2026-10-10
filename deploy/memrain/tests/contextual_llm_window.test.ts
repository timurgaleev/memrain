/**
 * The per-chunk contextual LLM tier carries a bounded window of the document.
 *
 * Without a window, each call carried the document cut to its head, so a chunk
 * deep in a long note was situated against text that did not contain it, and
 * the budget's flat input price was only an upper bound while the prompt stayed
 * under the long-context line. The window keeps the chunk's surroundings, holds
 * the prompt to `MEMRAIN_CONTEXTUAL_LLM_DOC_MAX_CHARS`, and is shared by
 * neighbouring chunks so the cached document prefix still gets reused.
 * No live Bedrock: the model is an injected fake that records its prompt.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CONTEXTUAL_LLM_DOC_MAX_CHARS_FLAG,
  DEFAULT_DOC_MAX_CHARS,
  MAX_DOC_MAX_CHARS,
  contextualLlmDocMaxChars,
  generateChunkContext,
  windowDocument,
} from "../src/core/search/contextual-llm.ts";
import type { LlmCallInput, LlmFn } from "../src/core/llm/haiku.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[CONTEXTUAL_LLM_DOC_MAX_CHARS_FLAG];
  delete process.env[CONTEXTUAL_LLM_DOC_MAX_CHARS_FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[CONTEXTUAL_LLM_DOC_MAX_CHARS_FLAG];
  else process.env[CONTEXTUAL_LLM_DOC_MAX_CHARS_FLAG] = saved;
});

function recordingLlm(): { fn: LlmFn; seen: LlmCallInput[] } {
  const seen: LlmCallInput[] = [];
  const fn: LlmFn = async (input) => {
    seen.push(input);
    return { text: "Situated.", modelId: "eu.anthropic.claude-haiku-fake" };
  };
  return { fn, seen };
}

/** A long document of numbered sentences — every slice of it is unique. */
function longDoc(chars: number): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `Sentence ${i} of the long note. `;
  return s.slice(0, chars);
}

describe("contextualLlmDocMaxChars", () => {
  it("defaults, clamps, and ignores junk", () => {
    expect(contextualLlmDocMaxChars(undefined)).toBe(DEFAULT_DOC_MAX_CHARS);
    expect(contextualLlmDocMaxChars("abc")).toBe(DEFAULT_DOC_MAX_CHARS);
    expect(contextualLlmDocMaxChars("-5")).toBe(DEFAULT_DOC_MAX_CHARS);
    expect(contextualLlmDocMaxChars("10000000")).toBe(MAX_DOC_MAX_CHARS);
    expect(contextualLlmDocMaxChars("8000")).toBe(8000);
  });
});

describe("windowDocument", () => {
  it("passes a document that fits through whole", () => {
    expect(windowDocument("short doc", "short", 100)).toBe("short doc");
  });

  it("keeps a deep chunk inside its window, with text on both sides", () => {
    const doc = longDoc(200_000);
    const chunk = doc.slice(150_000, 151_000);
    const w = windowDocument(doc, chunk, 20_000);
    expect(w).toContain(chunk);
    expect(w.length).toBeLessThanOrEqual(20_000 + 2 * 4);
    const at = w.indexOf(chunk);
    expect(at).toBeGreaterThan(5_000);
    expect(w.length - (at + chunk.length)).toBeGreaterThan(5_000);
    expect(w.startsWith("[…]\n")).toBe(true);
    expect(w.endsWith("\n[…]")).toBe(true);
  });

  it("gives neighbouring chunks the same window, so the cached prefix is reused", () => {
    const doc = longDoc(200_000);
    const a = windowDocument(doc, doc.slice(100_000, 100_800), 20_000);
    const b = windowDocument(doc, doc.slice(100_800, 101_600), 20_000);
    expect(a).toBe(b);
  });

  it("falls back to the head when the chunk is not in the document", () => {
    const doc = longDoc(50_000);
    const w = windowDocument(doc, "not in there", 10_000);
    expect(w.startsWith(doc.slice(0, 1000))).toBe(true);
    expect(w.endsWith("\n[…]")).toBe(true);
  });
});

describe("generateChunkContext windows the document it sends", () => {
  it("sends the deep chunk's surroundings, not the document's head", async () => {
    const doc = longDoc(200_000);
    const chunk = doc.slice(150_000, 151_000);
    const { fn, seen } = recordingLlm();
    await generateChunkContext(doc, chunk, { llmFn: fn });
    const user = seen[0]!.user;
    const docPart = user.slice(0, user.indexOf("</document>"));
    expect(docPart).toContain(chunk);
    expect(docPart).not.toContain(doc.slice(0, 200));
    expect(docPart.length).toBeLessThanOrEqual(DEFAULT_DOC_MAX_CHARS + 64);
  });

  it("honours the env window", async () => {
    process.env[CONTEXTUAL_LLM_DOC_MAX_CHARS_FLAG] = "8000";
    const doc = longDoc(100_000);
    const { fn, seen } = recordingLlm();
    await generateChunkContext(doc, doc.slice(50_000, 50_500), { llmFn: fn, cacheDocument: true });
    expect(seen[0]!.cachePrefix!.length).toBeLessThanOrEqual(8000 + 64);
  });
});
