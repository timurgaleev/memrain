/**
 * P5-C8: the chat's grounding check on a fixture brain with a stub model —
 * deterministic, no judge, no spend. It must pass a model that answers from
 * its evidence, and fail one that invents a sentence, a citation or an answer
 * its memory does not hold.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import {
  CHAT_GROUNDING_QUESTIONS,
  extractiveModel,
  runChatGrounding,
  seedChatGroundingFixture,
} from "../src/eval/chat-grounding.ts";

setDefaultTimeout(180_000);

let tmp: string;
let storage: Storage;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chat-grounding-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seedChatGroundingFixture(storage, deterministicEmbedQuery);
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("chat grounding check", () => {
  it("has 20 questions with the page that answers each, and 5 the fixture cannot answer", () => {
    const answerable = CHAT_GROUNDING_QUESTIONS.filter(q => q.expect !== null);
    expect(answerable).toHaveLength(20);
    expect(new Set(answerable.map(q => q.expect)).size).toBe(20);
    expect(CHAT_GROUNDING_QUESTIONS.filter(q => q.expect === null)).toHaveLength(5);
  });

  it("passes a model that answers only from its evidence and says so when it has none", async () => {
    const r = await runChatGrounding(storage, { model: extractiveModel(), embedQuery: deterministicEmbedQuery });
    expect(r.questions).toBe(25);
    expect(r.citations_in_gather).toBe(1);
    expect(r.grounded).toBe(1);
    expect(r.hit_rate).toBe(1);
    expect(r.refused_when_unanswerable).toBe(1);
    expect(r.failures).toEqual([]);
  });

  it("fails a model that answers what its memory does not hold", async () => {
    const alwaysAnswers: SonnetFn = async (input) => {
      const m = /<page ref="([^"]+)" rank="1"[^>]*>\n([\s\S]*?)\n<\/page>/.exec(input.user);
      const ref = m![1]!;
      const text = JSON.stringify({ answer: `${(m![2] ?? "").split(/(?<=\.)\s/)[0]} [${ref}]`, citations: [{ ref, kind: "page" }], gaps: [] });
      return { text, modelId: "eu.anthropic.claude-haiku-5-5", usage: { inputTokens: 100, outputTokens: 40 } };
    };
    const r = await runChatGrounding(storage, { model: alwaysAnswers, embedQuery: deterministicEmbedQuery });
    expect(r.hit_rate).toBe(1);
    expect(r.refused_when_unanswerable).toBe(0);
    expect(r.failures.filter(f => f.reason.startsWith("answered without evidence"))).toHaveLength(5);
  });

  it("fails a model that adds a sentence its evidence does not hold", async () => {
    const inventing: SonnetFn = async (input) => {
      const resp = await extractiveModel()(input);
      const parsed = JSON.parse(resp.text) as { answer: string };
      return { ...resp, text: JSON.stringify({ ...JSON.parse(resp.text), answer: `${parsed.answer} Volcanic submarines harvest platinum moonbeams.` }) };
    };
    const r = await runChatGrounding(storage, { model: inventing, embedQuery: deterministicEmbedQuery });
    expect(r.grounded).toBeLessThan(0.5);
  });

  it("fails a model that cites a page it was not given", async () => {
    const citingElsewhere: SonnetFn = async (input) => {
      const resp = await extractiveModel()(input);
      const parsed = JSON.parse(resp.text) as { answer: string; citations: Array<{ ref: string; kind: string }> };
      if (parsed.citations.length === 0) return resp;
      const stray = "page://facts/quantum-garden-zz";
      return { ...resp, text: JSON.stringify({ ...parsed, answer: `${parsed.answer} [${stray}]`, citations: [...parsed.citations, { ref: stray, kind: "page" }] }) };
    };
    const r = await runChatGrounding(storage, { model: citingElsewhere, embedQuery: deterministicEmbedQuery });
    // think drops the stray citation before the chat sees it, but the score counts what the model cited.
    expect(r.dropped_citations).toBe(20);
    expect(r.citations_in_gather).toBe(0.5);
  });
});
