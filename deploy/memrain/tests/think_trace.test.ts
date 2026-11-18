/**
 * runThink's optional trace hook: the steps of one run reported as they
 * happen, in order, with counts and visible slugs only. Without the hook the
 * run is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { runThink, type ThinkTraceEvent } from "../src/core/synthesis/think.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

let tmp: string;
let storage: Storage;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-think-trace-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-haiku-5-5";
const answer = (refs: string[]) => JSON.stringify({
  answer: `The plan is to migrate ${refs.map(r => `[${r}]`).join(" ")}.`,
  citations: refs.map(ref => ({ ref, kind: "page" })),
  gaps: [],
});
const model = (text: string): SonnetFn => async () => ({ text, modelId: MODEL, usage: { inputTokens: 400, outputTokens: 60 } });
const pages = (paths: string[]) => async (): Promise<SearchHit[]> =>
  paths.map((p, i) => ({ chunkId: `c${i}`, documentId: `d${i}`, sourcePath: p, title: p, content: "the plan is to migrate", score: 1, intent: "other" }) as unknown as SearchHit);

describe("runThink onTrace", () => {
  it("reports intent, gather, reserve, model, citations, quote check and settle in that order", async () => {
    const events: ThinkTraceEvent[] = [];
    const r = await runThink(storage, {
      question: "what is the plan?", modelId: MODEL, embedFn: null,
      sonnetFn: model(answer(["page://notes/plan", "page://notes/invented"])),
      pagesFn: pages(["page://notes/plan"]),
      onTrace: e => events.push(e),
    });
    expect(r.synthesis).not.toBeNull();
    expect(events.map(e => e.step)).toEqual([
      "intent", "gather", "gather", "reserve", "model_start", "model_end", "citations", "quote_check", "settle",
    ]);
    const gather = events.find(e => e.step === "gather" && e.note === "pages")!;
    expect(gather).toMatchObject({ count: 1, slugs: ["notes/plan"] });
    expect(events.find(e => e.step === "citations")).toMatchObject({ count: 1, note: "citation_dropped:1" });
    expect(events.find(e => e.step === "settle")!.usd).toBeCloseTo(r.spentUsd, 9);
    expect(JSON.stringify(events)).not.toContain("the plan is to migrate");
  });

  it("a hook that throws never breaks the run", async () => {
    const r = await runThink(storage, {
      question: "what is the plan?", modelId: MODEL, embedFn: null,
      sonnetFn: model(answer(["page://notes/plan"])), pagesFn: pages(["page://notes/plan"]),
      onTrace: () => { throw new Error("listener gone"); },
    });
    expect(r.synthesis?.citations).toEqual([{ ref: "page://notes/plan", kind: "page" }]);
  });

  it("reports a failed model call as model_end with a failure note", async () => {
    const events: ThinkTraceEvent[] = [];
    await runThink(storage, {
      question: "what is the plan?", modelId: MODEL, embedFn: null,
      sonnetFn: async () => { throw new Error("boom"); }, pagesFn: pages(["page://notes/plan"]),
      onTrace: e => events.push(e),
    });
    expect(events.find(e => e.step === "model_end")).toMatchObject({ note: "failed" });
    expect(events.at(-1)!.step).toBe("settle");
  });
});
