/**
 * Claude Code paste blocks: pasted text is someone else's words, so fact
 * extraction never reads it as the speaker's own claim.
 */
import { describe, expect, it } from "bun:test";
import { isPasteOnly, stripPastedContent } from "../src/core/transcripts/pasted-content.ts";
import { extractFactsFromTurn } from "../src/core/facts-extract.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const PASTE = '<pasted_content id="2830">\nHi, we moved the launch to November. Alex\n</pasted_content id="2830">';

describe("stripPastedContent", () => {
  it("removes a closed block and keeps the words around it apart", () => {
    const r = stripPastedContent(`Can you reply to this?${PASTE}Thanks`);
    expect(r).toEqual({ text: "Can you reply to this? Thanks", stripped: 1 });
  });

  it("removes every block in a turn", () => {
    const r = stripPastedContent(`a ${PASTE} b ${PASTE} c`);
    expect(r.stripped).toBe(2);
    expect(r.text).not.toContain("launch");
  });

  it("removes an unclosed harness-shaped paste to the end", () => {
    const r = stripPastedContent('See below <pasted_content id="9">\nsecret plans that never close');
    expect(r).toEqual({ text: "See below  ", stripped: 1 });
  });

  it("leaves a malformed or unclosed non-harness tag as text", () => {
    const odd = "talking about <pasted_content> tags in general";
    expect(stripPastedContent(odd)).toEqual({ text: odd, stripped: 0 });
    const multi = "a <pasted_content\nid=1>b";
    expect(stripPastedContent(multi)).toEqual({ text: multi, stripped: 0 });
  });

  it("returns text without a tag untouched", () => {
    expect(stripPastedContent("plain")).toEqual({ text: "plain", stripped: 0 });
  });

  it("stays linear on a long run of opening tags", () => {
    const time = (s: string) => {
      const t0 = performance.now();
      stripPastedContent(s);
      return performance.now() - t0;
    };
    // Well-formed but never-closed, non-harness openers: each one used to be
    // able to rescan the whole tail looking for a close.
    for (const unit of ["<pasted_content ", "<pasted_content x>", "<pasted_content x></pasted_content"]) {
      expect(time(unit.repeat(100_000))).toBeLessThan(1000);
    }
  });
});

describe("isPasteOnly", () => {
  it("is true only for a turn that is nothing but pastes", () => {
    expect(isPasteOnly(`  ${PASTE}\n`)).toBe(true);
    expect(isPasteOnly(`reply to this ${PASTE}`)).toBe(false);
    expect(isPasteOnly("no paste here")).toBe(false);
    expect(isPasteOnly("")).toBe(false);
  });
});

describe("the extractor never sees pasted text", () => {
  it("strips it before the model is called", async () => {
    const users: string[] = [];
    const fn: SonnetFn = async (input) => {
      users.push(input.user);
      return { text: '{"facts":[]}', modelId: "eu.anthropic.claude-sonnet-4-6-v1:0", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await extractFactsFromTurn(`User: please answer this email ${PASTE}`, { sonnetFn: fn });
    expect(users[0]).toContain("please answer this email");
    expect(users[0]).not.toContain("November");
    expect(users[0]).not.toContain("pasted_content");
  });
});
