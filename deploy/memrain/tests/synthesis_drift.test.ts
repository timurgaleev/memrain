/**
 * Drift phase — hermetic (injected SonnetFn, no Bedrock). Covers
 * the no-candidate skip, and the detect → single-LLM-judge → drift-report write
 * with the sanitizeForPrompt `.text` unwrap regression guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { driftPhase } from "../src/core/synthesis/drift.ts";
import { QUARANTINE_KEY } from "../src/core/quarantine.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 400, outputTokens: 100 },
  };
};

/**
 * Seed one take whose source document was re-ingested AFTER the take was made.
 * Returns the take id (BIGSERIAL) so a fake judge can echo it.
 */
async function seedDriftedTake(claim: string, evidence: string): Promise<number> {
  const eng = storage.engine();
  await eng.query(
    `INSERT INTO documents (id, source_path, source_id, updated_at)
     VALUES ('doc1', 'notes/thesis.md', 'default', now())`,
  );
  await eng.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('ck1', 'doc1', 0, $1)`,
    [evidence],
  );
  const { rows } = await eng.query<{ id: number }>(
    `INSERT INTO synth_takes
       (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, generated_at)
     VALUES ('k1', 'doc1', 'h-old', 'v1', $1, 'judgment', 0.5, 'queued', 'm', now() - interval '10 days')
     RETURNING id`,
    [claim],
  );
  return Number(rows[0]!.id);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-drift-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_DRIFT;
  delete process.env.MEMRAIN_DRIFT_BUDGET_USD;
});

describe("driftPhase", () => {
  it("does not re-read a source the content gate quarantined", async () => {
    await seedDriftedTake("The project will ship in Q1.", "The project has been pushed to Q4.");
    await storage.engine().query(`UPDATE documents SET frontmatter = $1::text::jsonb WHERE id = 'doc1'`, [
      JSON.stringify({ [QUARANTINE_KEY]: { patterns: ["test"] } }),
    ]);
    lastPrompt = "";
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet("[]") });
    expect(r.candidatesConsidered).toBe(0);
    expect(lastPrompt).not.toContain("pushed to Q4");
  });

  it("skips when no take has shifted evidence", async () => {
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet("[]") });
    expect(r.ran).toBe(false);
    expect(r.candidatesConsidered).toBe(0);
  });

  it("flags a drifted take and writes a drift report", async () => {
    const id = await seedDriftedTake(
      "The project will ship in Q1.",
      "The project has been pushed to Q4 after the funding round slipped.",
    );
    const payload = JSON.stringify([
      { take_id: id, holds: false, reason: "The source now says Q4, contradicting the Q1 claim." },
    ]);
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.candidatesConsidered).toBe(1);
    expect(r.driftedFlagged).toBe(1);
    expect(r.reportSlug).toBeDefined();

    // Prompt carries the claim + current evidence — regression guard.
    expect(lastPrompt).toContain("ship in Q1");
    expect(lastPrompt).toContain("pushed to Q4");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, r.reportSlug!);
    expect(page).not.toBeNull();
    expect(page!.type).toBe("drift-report");
    expect(page!.markdown_body).toContain("ship in Q1");
  });

  it("spends nothing when MEMRAIN_DRIFT_BUDGET_USD=0 (no Sonnet call)", async () => {
    process.env.MEMRAIN_DRIFT_BUDGET_USD = "0";
    await seedDriftedTake("A claim under review.", "Evidence that has since changed.");
    let calls = 0;
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet("[]")(input);
    };
    const r = await driftPhase(storage, { sonnetFn: counting });
    expect(calls).toBe(0);
    expect(r.budgetExhausted).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect(r.reason).toContain("budget");
  });

  /**
   * The verdict scan must stay linear in the judge's reply length.
   *
   * `parseVerdicts` used `/\[[\s\S]*\]/` to pick the JSON array out of the
   * reply. With no closing bracket the body walked to the end of the text from
   * every `[`: measured at 2 K = 2.5 ms, 4 K = 8.4 ms, 8 K = 23.6 ms,
   * 16 K = 96.6 ms — ratio ~4.0 per doubling. We do not write that text; we
   * only set `maxTokens`, and a provider swap moves that cap without anyone
   * touching the parser. The index form ("first `[` to last `]`") is the same
   * span for one forward and one backward scan.
   *
   * The ceiling is deliberately loose: linear finishes in milliseconds,
   * quadratic needs minutes.
   */
  it("stays linear when the judge returns a 1 MB run of unclosed brackets", async () => {
    await seedDriftedTake("A claim under review.", "Evidence that has since changed.");

    const started = performance.now();
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet("[".repeat(1_000_000)) });
    const elapsed = performance.now() - started;

    // Unparseable, so nothing is flagged — the phase survives the junk reply.
    expect(r.ran).toBe(true);
    expect(r.driftedFlagged).toBe(0);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("still finds the array when the judge wraps it in prose or nests brackets", async () => {
    const id = await seedDriftedTake("Claim A.", "Evidence that changed.");
    const payload =
      "Here are my verdicts:\n" +
      JSON.stringify([{ take_id: id, holds: false, reason: "changed [see note]" }]) +
      "\nLet me know if you need more.";
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.driftedFlagged).toBe(1);
  });

  it("writes no report when the judge says every take still holds", async () => {
    const id = await seedDriftedTake("Claim that still holds.", "Evidence consistent with the claim.");
    const payload = JSON.stringify([{ take_id: id, holds: true, reason: "still supported" }]);
    const r = await driftPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.driftedFlagged).toBe(0);
    expect(r.reportSlug).toBeUndefined();
  });
});
