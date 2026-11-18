/**
 * P5-C8: the chat's grounding check on a fixture brain with a stub model —
 * deterministic, no judge, no spend. It must pass a model that answers from
 * its evidence and fail one that invents a sentence or a citation.
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
  it("has 20 questions, each with the page that answers it", () => {
    expect(CHAT_GROUNDING_QUESTIONS).toHaveLength(20);
    expect(new Set(CHAT_GROUNDING_QUESTIONS.map(q => q.expect)).size).toBe(20);
  });

  it("passes a model that answers only from its evidence", async () => {
    const r = await runChatGrounding(storage, { model: extractiveModel(), embedQuery: deterministicEmbedQuery });
    expect(r.questions).toBe(20);
    expect(r.citations_in_gather).toBe(1);
    expect(r.grounded).toBe(1);
    expect(r.hit_rate).toBeGreaterThanOrEqual(0.9);
    expect(r.failures).toEqual([]);
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
      const stray = "page://facts/quantum-garden-zz";
      return { ...resp, text: JSON.stringify({ ...parsed, answer: `${parsed.answer} [${stray}]`, citations: [...parsed.citations, { ref: stray, kind: "page" }] }) };
    };
    const r = await runChatGrounding(storage, { model: citingElsewhere, embedQuery: deterministicEmbedQuery });
    // think drops the stray citation before the chat sees it: the check still holds.
    expect(r.citations_in_gather).toBe(1);
    expect(r.dropped_citations).toBe(20);
  });
});
