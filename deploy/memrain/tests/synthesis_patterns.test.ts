/**
 * Patterns phase — hermetic (injected SonnetFn, no Bedrock). Covers the
 * insufficient-evidence skip, structured-JSON → pattern-page write, and
 * evidence-slug validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { patternsPhase } from "../src/core/synthesis/patterns.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 200, outputTokens: 80 },
  };
};

async function seedReflections(n: number): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 1; i <= n; i++) {
    const slug = `reflections/2026-06-0${i}`;
    await putPage(storage, {
      slug,
      type: "note",
      title: `Reflection ${i}`,
      markdown_body: `Felt anxious about the deadline again today. Entry ${i}.`,
      source_id: "default",
    });
    slugs.push(slug);
  }
  return slugs;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-patterns-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_PATTERNS;
  delete process.env.MEMRAIN_PATTERNS_BUDGET_USD;
});

describe("patternsPhase", () => {
  it("skips when reflections are below min_evidence", async () => {
    await seedReflections(2); // default minEvidence = 3
    const r = await patternsPhase(storage, { sonnetFn: fakeSonnet("[]") });
    expect(r.ran).toBe(false);
    expect(r.reflectionsConsidered).toBe(2);
  });

  it("writes a pattern page from structured output, citing evidence", async () => {
    const slugs = await seedReflections(3);
    const payload = JSON.stringify([
      {
        topic_slug: "deadline-anxiety",
        title: "Recurring deadline anxiety",
        body: 'You return to deadline stress across several entries. "I will launch a secret moon project".',
        evidence: slugs,
      },
    ]);
    const r = await patternsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.patternsWritten).toBe(1);

    // The prompt must carry the actual reflection content — regression guard for
    // the sanitizeForPrompt `.text` unwrap (a bare object renders "[object Object]").
    expect(lastPrompt).toContain("deadline");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, "patterns/deadline-anxiety");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Recurring deadline anxiety");
    expect(page!.markdown_body).toStartWith("---\nunverified_quotes:");
    expect(page!.markdown_body).toContain("I will launch a secret moon project [unverified]");
    // Evidence wikilinks are appended.
    expect(page!.markdown_body).toContain(`[[${slugs[0]}]]`);
    await putPage(storage, { slug: "patterns/deadline-anxiety", markdown_body: "human edit", written_by: "operator" });
    const held = await patternsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(held.pagesHeld).toBe(1);
    expect(held.patternsWritten).toBe(0);
    expect((await getPage(storage, "patterns/deadline-anxiety"))?.markdown_body).toBe("human edit");
  });

  it("drops a pattern that cites too few DISTINCT valid reflections", async () => {
    const slugs = await seedReflections(3);
    const payload = JSON.stringify([
      {
        topic_slug: "thin",
        title: "Thin pattern",
        body: "only one citation",
        evidence: [slugs[0], slugs[0], "reflections/does-not-exist"],
      },
    ]);
    const r = await patternsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.patternsWritten).toBe(0);
    expect(await getPage(storage, "patterns/thin")).toBeNull();
  });

  it("spends nothing when MEMRAIN_PATTERNS_BUDGET_USD=0 (no Sonnet call)", async () => {
    process.env.MEMRAIN_PATTERNS_BUDGET_USD = "0";
    await seedReflections(3);
    let calls = 0;
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet("[]")(input);
    };
    const r = await patternsPhase(storage, { sonnetFn: counting });
    expect(calls).toBe(0);
    expect(r.ran).toBe(false);
    expect(r.budgetExhausted).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect(r.reason).toContain("budget");
  });
});
