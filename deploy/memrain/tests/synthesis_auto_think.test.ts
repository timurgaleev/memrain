/**
 * Auto-think phase — hermetic (injected SonnetFn + pagesFn, no Bedrock). Covers
 * the no-questions skip, a think-answer → draft-page write, and
 * the [object Object] regression guard on the forwarded think prompt.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { autoThinkPhase } from "../src/core/synthesis/auto-think.ts";
import { runThink } from "../src/core/synthesis/think.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 300, outputTokens: 90 },
  };
};

const fakePages = (content: string): ((q: string, k: number) => Promise<SearchHit[]>) =>
  async () => [
    {
      chunkId: "c1",
      documentId: "d1",
      sourcePath: "notes/roadmap.md",
      title: "Roadmap",
      content,
      score: 1,
      intent: "other",
    } as unknown as SearchHit,
  ];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-autothink-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_AUTO_THINK;
  delete process.env.MEMRAIN_AUTO_THINK_QUESTIONS;
  delete process.env.MEMRAIN_AUTO_THINK_BUDGET_USD;
});

describe("autoThinkPhase", () => {
  it("skips when no questions are configured", async () => {
    const r = await autoThinkPhase(storage, { sonnetFn: fakeSonnet("{}"), questions: [] });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("no questions");
  });

  it("runs a question and persists the answer as a draft page", async () => {
    const answer = JSON.stringify({ answer: 'The roadmap defers auth to Q3. "I will launch a secret moon project".', citations: [], gaps: ["No dated milestone"] });
    const r = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet(answer),
      pagesFn: fakePages("Auth is planned but not yet scheduled on the roadmap."),
      embedFn: null,
      questions: ["What is the status of auth?"],
      cooldownHours: 0,
    });
    expect(r.ran).toBe(true);
    expect(r.draftsWritten).toBe(1);

    // The think prompt forwarded to Sonnet must carry the retrieved page content.
    expect(lastPrompt).toContain("Auth is planned");
    expect(lastPrompt).not.toContain("[object Object]");

    expect((await storage.engine().query<{ written_by_principal: string }>(
      "SELECT written_by_principal FROM page_versions WHERE slug=$1 ORDER BY version_n DESC LIMIT 1", ["drafts/think/what-is-the-status-of-auth"])).rows[0]?.written_by_principal).toBe("operator");
    const page = await getPage(storage, "drafts/think/what-is-the-status-of-auth");
    expect(page).not.toBeNull();
    expect(page!.type).toBe("draft");
    expect(page!.markdown_body).toStartWith("---\nunverified_quotes:");
    expect(page!.markdown_body).toContain("I will launch a secret moon project [unverified]");
    expect(page!.markdown_body).toContain("defers auth to Q3");
    expect(page!.markdown_body).toContain("What is the status of auth?");
  });

  it("does not persist an empty synthesis", async () => {
    const r = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet("not json at all"),
      pagesFn: fakePages("some context"),
      embedFn: null,
      questions: ["A question with no answer"],
      cooldownHours: 0,
    });
    expect(r.draftsWritten).toBe(0);
    expect(await getPage(storage, "drafts/think/a-question-with-no-answer")).toBeNull();
  });

  it("does not persist the extractive fallback of a failed compose", async () => {
    const throttled: SonnetFn = async () => {
      throw Object.assign(new Error("x"), { name: "ThrottlingException" });
    };
    const think = await runThink(storage, {
      question: "A question the model never answered",
      sonnetFn: throttled,
      pagesFn: fakePages("some context"),
      embedFn: null,
    });
    expect(think.synthesis).toBeNull();
    expect(think.fallback?.kind).toBe("extractive");

    const r = await autoThinkPhase(storage, {
      sonnetFn: throttled,
      pagesFn: fakePages("some context"),
      embedFn: null,
      questions: ["A question the model never answered"],
      cooldownHours: 0,
    });
    expect(r.draftsWritten).toBe(0);
    expect(await getPage(storage, "drafts/think/a-question-the-model-never-answered")).toBeNull();
  });

  it("treats an explicit zero budget as spend-nothing (no Sonnet call)", async () => {
    let calls = 0;
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet("{}")(input);
    };
    const r = await autoThinkPhase(storage, {
      sonnetFn: counting,
      pagesFn: fakePages("ctx"),
      embedFn: null,
      questions: ["Zero budget question"],
      cooldownHours: 0,
      budgetUsd: 0,
    });
    expect(calls).toBe(0);
    expect(r.draftsWritten).toBe(0);
    expect(r.spentUsd).toBe(0);
    expect(r.budgetExhausted).toBe(true);
  });

  it("treats MEMRAIN_AUTO_THINK_BUDGET_USD=0 as spend-nothing, invalid as the default", async () => {
    process.env.MEMRAIN_AUTO_THINK_BUDGET_USD = "0";
    let calls = 0;
    const answer = JSON.stringify({ answer: "Paid answer.", citations: [], gaps: [] });
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet(answer)(input);
    };
    const opts = {
      sonnetFn: counting,
      pagesFn: fakePages("ctx"),
      embedFn: null,
      questions: ["Env budget question"],
      cooldownHours: 0,
    };
    const zero = await autoThinkPhase(storage, opts);
    expect(calls).toBe(0);
    expect(zero.budgetExhausted).toBe(true);

    // A non-numeric value still falls back to the paid default.
    process.env.MEMRAIN_AUTO_THINK_BUDGET_USD = "not-a-number";
    const fallback = await autoThinkPhase(storage, opts);
    expect(calls).toBe(1);
    expect(fallback.draftsWritten).toBe(1);
  });

  it("respects the cooldown once a draft exists", async () => {
    const answer = JSON.stringify({ answer: "First pass.", citations: [], gaps: [] });
    const first = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet(answer),
      pagesFn: fakePages("ctx"),
      embedFn: null,
      questions: ["Standing question"],
      cooldownHours: 0,
    });
    expect(first.draftsWritten).toBe(1);

    const second = await autoThinkPhase(storage, {
      sonnetFn: fakeSonnet(answer),
      pagesFn: fakePages("ctx"),
      embedFn: null,
      questions: ["Standing question"],
      cooldownHours: 24,
    });
    expect(second.ran).toBe(false);
    expect(second.reason).toContain("cooldown");
  });
});
