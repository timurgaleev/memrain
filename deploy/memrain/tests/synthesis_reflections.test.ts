/**
 * Reflections phase — hermetic (injected SonnetFn, no Bedrock). Covers
 * transcript → reflection-page write with evidence citation, the
 * sanitizeForPrompt `.text` unwrap regression guard, and the anti-loop
 * exclusion that keeps synthesis-written pages out of the facts-backfill
 * selector (paid synthetic recursion).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { reflectionsPhase } from "../src/core/synthesis/reflections.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { QUARANTINE_KEY } from "../src/core/quarantine.ts";

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

// A body long enough (>= 200 chars) to clear the transcript floor.
function transcriptBody(i: number): string {
  return (
    `Entry ${i}: spent the afternoon turning the deadline over in my head, ` +
    "weighing whether to ask for more time or push through the weekend. " +
    "Kept circling back to the same knot of anxiety about letting the team down."
  );
}

async function seedTranscripts(n: number): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 1; i <= n; i++) {
    const slug = `notes/journal-2026-06-0${i}`;
    await putPage(storage, {
      slug,
      type: "note",
      title: `Journal ${i}`,
      markdown_body: transcriptBody(i),
      source_id: "default",
    });
    slugs.push(slug);
  }
  return slugs;
}

/** A quarantined search mirror for page `slug`, as the content gate leaves one. */
async function quarantineMirror(slug: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO documents (id, source_path, title, frontmatter) VALUES ($1, $2, 't', $3::text::jsonb)`,
    [`held-${slug}`, `page://${slug}`, JSON.stringify({ [QUARANTINE_KEY]: { patterns: ["test"] } })],
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-reflections-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_REFLECTIONS;
  delete process.env.MEMRAIN_REFLECTIONS_BUDGET_USD;
});

describe("reflectionsPhase", () => {
  it("leaves a transcript the content gate quarantined out of the prompt", async () => {
    const slugs = await seedTranscripts(3);
    await quarantineMirror(slugs[0]!);
    await reflectionsPhase(storage, { sonnetFn: fakeSonnet("[]") });
    expect(lastPrompt).toContain("Entry 2:");
    expect(lastPrompt).not.toContain("Entry 1:");
  });

  it("writes a reflection page from structured output, citing transcripts", async () => {
    const slugs = await seedTranscripts(3);
    const payload = JSON.stringify([
      {
        topic_slug: "deadline-anxiety",
        title: "Recurring deadline anxiety",
        body: `The deadline keeps pulling my focus, see [[${slugs[0]}]].`,
        evidence: slugs,
      },
    ]);
    const r = await reflectionsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.reflectionsWritten).toBe(1);

    // The prompt must carry the actual transcript prose — regression guard for
    // the sanitizeForPrompt `.text` unwrap (a bare object renders "[object Object]").
    expect(lastPrompt).toContain("deadline");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, "reflections/deadline-anxiety");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Recurring deadline anxiety");
    expect(page!.markdown_body).toContain(`[[${slugs[0]}]]`);
  });

  it("drops a reflection that cites no valid transcript slug", async () => {
    await seedTranscripts(3);
    const payload = JSON.stringify([
      {
        topic_slug: "phantom",
        title: "Phantom reflection",
        body: "cites nothing real",
        evidence: ["notes/does-not-exist"],
      },
    ]);
    const r = await reflectionsPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.reflectionsWritten).toBe(0);
    expect(await getPage(storage, "reflections/phantom")).toBeNull();
  });

  it("spends nothing when MEMRAIN_REFLECTIONS_BUDGET_USD=0 (no Sonnet call)", async () => {
    process.env.MEMRAIN_REFLECTIONS_BUDGET_USD = "0";
    await seedTranscripts(3);
    let calls = 0;
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet("[]")(input);
    };
    const r = await reflectionsPhase(storage, { sonnetFn: counting });
    expect(calls).toBe(0);
    expect(r.ran).toBe(false);
    expect(r.budgetExhausted).toBe(true);
    expect(r.reflectionsWritten).toBe(0);
    expect(r.reason).toContain("budget");
  });

  /**
   * The JSON-array salvage must stay linear in reply length. Unbounded,
   * `/\[[\s\S]*\]/` re-scanned to the end of the reply from every `[`: a 16 K
   * run of `[` measured 97 ms through this phase, ratio 3.76-4.25 on a
   * doubling (quadratic). The span is now bounded by REFLECTIONS_MAX_TOKENS,
   * and this holds that bound in place. The ceiling is loose on purpose —
   * linear finishes in about a second, quadratic needs half a minute.
   */
  it("stays linear when the model answers with a 250 K run of brackets", async () => {
    await seedTranscripts(3);
    const started = performance.now();
    const r = await reflectionsPhase(storage, { sonnetFn: fakeSonnet("[".repeat(250_000)) });
    const elapsed = performance.now() - started;
    expect(r.ran).toBe(true);
    // Nothing parses out of that reply — the proof the scan did the work.
    expect(r.reflectionsWritten).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("anti-loop: synthesis pages excluded from facts-backfill", () => {
  it("does not consider reflections/ or patterns/ pages", async () => {
    // One real transcript (eligible) plus two synthesis-written pages that must
    // be skipped, so we never pay to re-derive our own output.
    await putPage(storage, {
      slug: "notes/real-transcript",
      type: "note",
      markdown_body: transcriptBody(1),
    });
    await putPage(storage, {
      slug: "reflections/deadline-anxiety",
      type: "note",
      markdown_body: transcriptBody(2),
      written_by: "reflection",
    });
    await putPage(storage, {
      slug: "patterns/deadline-anxiety",
      type: "note",
      markdown_body: transcriptBody(3),
      written_by: "patterns",
    });

    const noFacts: SonnetFn = async () => ({
      text: JSON.stringify({ facts: [] }),
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: noFacts });
    expect(r.ran).toBe(true);
    // Only the real transcript is eligible; the two synthesis pages are excluded.
    expect(r.pagesConsidered).toBe(1);
  });
});
