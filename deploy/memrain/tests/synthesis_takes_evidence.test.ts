/**
 * G29 takes-pipeline fixes — hermetic (no Bedrock).
 *   - propose idempotency includes prompt_version (a bump re-scans docs)
 *   - existing takes are fed back to the extractor as already-captured
 *   - grade evidence: hybrid search scoped to the take's tenant AND to pages
 *     newer than the take (evidenceFn receives the take's since date)
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  proposeTakesPhase,
  gradeTakesPhase,
  hybridEvidence,
} from "../src/core/synthesis/takes.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-takes-ev-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string, updatedAt?: string): Promise<void> {
  await engine.query(
    `INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)`,
    [id, `/vault/${id}.md`, id],
  );
  if (updatedAt) {
    await engine.query(`UPDATE documents SET updated_at = $2::timestamptz WHERE id = $1`, [
      id,
      updatedAt,
    ]);
  }
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

const fakeLlm = (text: string): LlmFn => async () => ({ text, modelId: "fake-nova" });

describe("propose idempotency includes prompt_version", () => {
  it("re-scans a doc when the prompt version bumps, skips under the same one", async () => {
    await seedDoc("d1", "Y".repeat(500));
    const llm = fakeLlm(`[{"claim_text":"stable claim","kind":"judgment","weight":0.5}]`);
    await proposeTakesPhase(engine, { llmFn: llm, promptVersion: "v1" });
    const same = await proposeTakesPhase(engine, { llmFn: llm, promptVersion: "v1" });
    expect(same.documentsScanned).toBe(0);
    // A prompt bump re-scans the same (doc, hash).
    const bumped = await proposeTakesPhase(engine, { llmFn: llm, promptVersion: "v2" });
    expect(bumped.documentsScanned).toBe(1);
    const { rows } = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM synth_takes`,
    );
    expect(Number(rows[0]?.n)).toBe(2); // one row per prompt version
  });
});

describe("propose feeds existing takes back for dedup", () => {
  it("injects already-captured claims into the extractor prompt", async () => {
    await seedDoc("d1", "Z".repeat(500));
    await proposeTakesPhase(engine, {
      llmFn: fakeLlm(`[{"claim_text":"first claim","kind":"judgment","weight":0.5}]`),
      promptVersion: "v1",
    });
    const prompts: string[] = [];
    const capture: LlmFn = async (input) => {
      prompts.push(input.user);
      return { text: "[]", modelId: "fake-nova" };
    };
    await proposeTakesPhase(engine, { llmFn: capture, promptVersion: "v2" });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("ALREADY CAPTURED");
    expect(prompts[0]).toContain("first claim");
  });
});

describe("grade evidence window + tenancy", () => {
  it("passes the take's generated_at date to the evidence retriever", async () => {
    await engine.query("INSERT INTO documents (id,source_path,source_id) VALUES ('d1','/vault/d1.md','default')");
    await engine.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id, generated_at)
       VALUES ('tk1', 'd1', 'h', 'vX', 'old claim', 'm', '2024-03-15T12:00:00Z')`,
    );
    const seen: Array<{ sourceId?: string; since?: string }> = [];
    const r = await gradeTakesPhase(engine, {
      llmFn: fakeLlm(`{"verdict":"unresolvable","confidence":0.1,"reasoning":"x"}`),
      minAgeDays: 0,
      evidenceFn: async (_claim, sourceId, since) => {
        seen.push({
          ...(sourceId !== undefined ? { sourceId } : {}),
          ...(since !== undefined ? { since } : {}),
        });
        return "no evidence";
      },
    });
    expect(r.takesScanned).toBe(1);
    expect(seen[0]?.since).toBe("2024-03-15");
  });
});

describe("hybridEvidence", () => {
  it("returns only evidence newer than the take's date, tenant-scoped", async () => {
    // Old doc (2020) and new doc (now) with keyword-matching content.
    await seedDoc("old-doc", "the metric target was missed badly in the old world", "2020-01-01T00:00:00Z");
    await seedDoc("new-doc", "the metric target was finally hit this quarter");
    const embedQuery = async () => new Array(1024).fill(0.01) as number[];

    const all = await hybridEvidence(storage, "metric target", { embedQuery });
    expect(all).toContain("new-doc");
    expect(all).toContain("old-doc");

    const recent = await hybridEvidence(storage, "metric target", {
      embedQuery,
      since: "2024-01-01",
    });
    expect(recent).toContain("new-doc");
    expect(recent).not.toContain("old-doc");
  });

  it("reports no evidence when nothing matches", async () => {
    const out = await hybridEvidence(storage, "completely absent phrase", {
      embedQuery: async () => new Array(1024).fill(0.01) as number[],
    });
    expect(out).toContain("No corpus evidence found");
  });
});
