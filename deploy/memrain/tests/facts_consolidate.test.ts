/**
 * Item 3 — deterministic consolidate phase: greedy cosine clustering promotes a
 * near-duplicate cluster into one consolidated "take" fact and marks the
 * contributing facts consolidated (never deletes). Offline: embeddings are set
 * directly, no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import {
  consolidateFactsPhase,
  cosineSimilarity,
  clusterFacts,
} from "../src/core/cycle/consolidate-facts.ts";

let tmp: string;
let storage: Storage;

function oneHot(i: number): number[] {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return v;
}

async function seed(
  fact: string,
  embIdx: number,
  opts: { confidence?: number; sourceId?: string } = {},
): Promise<number> {
  const r = await addFact(storage, {
    entity_slug: "people/alice",
    fact,
    confidence: opts.confidence ?? 0.8,
    ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
  });
  await storage
    .engine()
    .query(`UPDATE entity_facts SET embedding = $1::vector WHERE id = $2`, [
      JSON.stringify(oneHot(embIdx)),
      r.id,
    ]);
  return r.id as number;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-consolidate-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("cosineSimilarity / clusterFacts", () => {
  it("computes cosine and degenerates to 0 on length mismatch", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
  });

  it("greedily groups by head similarity above threshold", () => {
    const mk = (id: number, e: number[]) => ({
      id,
      fact: `f${id}`,
      confidence: 0.5,
      // Clustering is embedding-only; kind rides along for the promoted take.
      kind: null,
      embedding: e,
      written_at: "2026-01-01",
    });
    const clusters = clusterFacts(
      [mk(1, [1, 0]), mk(2, [1, 0]), mk(3, [0, 1])],
      0.85,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.map((f) => f.id).sort()).toEqual([1, 2]);
  });
});

describe("consolidateFactsPhase", () => {
  it("promotes a >=2 cluster to a take and marks members consolidated", async () => {
    const a = await seed("Alice prefers tea", 0, { confidence: 0.7 });
    const b = await seed("Alice likes tea", 0, { confidence: 0.9 });
    await seed("Alice moved to Gotham", 5); // distinct cluster of 1

    const res = await consolidateFactsPhase(storage.engine(), {
      minOldestAgeMs: 0, // bypass the age gate for the test
    });
    expect(res.takesWritten).toBe(1);
    expect(res.factsConsolidated).toBe(2);

    // The promoted take uses the highest-confidence member's text.
    const take = await storage.engine().query<{ fact: string; confidence: number }>(
      `SELECT fact, confidence FROM entity_facts
        WHERE written_by = 'facts-consolidate' AND consolidated = true`,
    );
    expect(take.rows).toHaveLength(1);
    expect(take.rows[0]!.fact).toBe("Alice likes tea");
    expect(take.rows[0]!.confidence).toBeCloseTo(0.8); // avg of 0.7 and 0.9

    // Members a,b marked consolidated; the singleton is not. Members are
    // matched by "not the take": they used to be identifiable by a NULL
    // written_by, which is exactly the unattributed row the ledger no longer
    // accepts.
    const marked = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts
        WHERE consolidated = true AND written_by <> 'facts-consolidate'`,
    );
    expect(marked.rows.map((r) => r.id).sort((x, y) => x - y)).toEqual(
      [a, b].sort((x, y) => x - y),
    );
  });

  it("never folds an assistant's suggestion into the operator's take", async () => {
    await seed("Alice prefers tea", 0, { confidence: 0.7 });
    const suggested = await seed("Alice likes tea", 0, { confidence: 0.9 });
    await storage
      .engine()
      .query(`UPDATE entity_facts SET attributed_to = 'assistant' WHERE id = $1`, [suggested]);

    const res = await consolidateFactsPhase(storage.engine(), { minOldestAgeMs: 0, minFactsPerBucket: 2 });
    // One operator fact is left: the bucket is below the cluster floor.
    expect(res.bucketsScanned).toBe(0);
    expect(res.takesWritten).toBe(0);
    const row = await storage
      .engine()
      .query<{ consolidated: boolean }>(`SELECT consolidated FROM entity_facts WHERE id = $1`, [suggested]);
    expect(row.rows[0]!.consolidated).toBe(false);
  });

  it("clusters the operator's facts and leaves the assistant's beside them", async () => {
    const a = await seed("Alice prefers tea", 0, { confidence: 0.7 });
    const b = await seed("Alice likes tea", 0, { confidence: 0.8 });
    const suggested = await seed("Alice should drink tea", 0, { confidence: 0.95 });
    await storage
      .engine()
      .query(`UPDATE entity_facts SET attributed_to = 'assistant' WHERE id = $1`, [suggested]);

    const res = await consolidateFactsPhase(storage.engine(), { minOldestAgeMs: 0, minFactsPerBucket: 2 });
    expect(res.takesWritten).toBe(1);
    expect(res.factsConsolidated).toBe(2);
    const take = await storage.engine().query<{ fact: string }>(
      `SELECT fact FROM entity_facts WHERE written_by = 'facts-consolidate'`,
    );
    // The take restates the best OPERATOR claim, not the assistant's.
    expect(take.rows.map((r) => r.fact)).toEqual(["Alice likes tea"]);
    const marked = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE consolidated = true AND written_by <> 'facts-consolidate'`,
    );
    expect(marked.rows.map((r) => Number(r.id)).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
  });

  it("is idempotent: a second run promotes nothing new", async () => {
    await seed("Alice prefers tea", 0, { confidence: 0.7 });
    await seed("Alice likes tea", 0, { confidence: 0.9 });
    await seed("Alice enjoys tea", 0, { confidence: 0.6 });
    await consolidateFactsPhase(storage.engine(), { minOldestAgeMs: 0 });
    const second = await consolidateFactsPhase(storage.engine(), {
      minOldestAgeMs: 0,
    });
    expect(second.takesWritten).toBe(0);
    expect(second.factsConsolidated).toBe(0);
  });

  it("does not re-mint the take when the same cluster re-forms", async () => {
    await seed("Alice prefers tea", 0, { confidence: 0.7 });
    await seed("Alice likes tea", 0, { confidence: 0.9 });
    await seed("Alice enjoys tea", 0, { confidence: 0.6 });
    await consolidateFactsPhase(storage.engine(), { minOldestAgeMs: 0 });
    // The test above never reaches the take-idempotency guard: once the members
    // are marked, the bucket query no longer sees them and no cluster re-forms.
    // Unmark them — a re-queued member is the case the guard is FOR — so the
    // cluster genuinely re-forms and the phase has to recognize its own take.
    await storage
      .engine()
      .query(
        `UPDATE entity_facts SET consolidated = false, consolidated_at = NULL
          WHERE written_by <> 'facts-consolidate'`,
      );
    const again = await consolidateFactsPhase(storage.engine(), {
      minOldestAgeMs: 0,
    });
    expect(again.takesWritten).toBe(0);
    expect(again.factsConsolidated).toBe(3);
    const takes = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE written_by = 'facts-consolidate'`,
    );
    expect(takes.rows).toHaveLength(1);
  });

  it("honors the age gate: a fresh bucket is skipped", async () => {
    await seed("Alice prefers tea", 0);
    await seed("Alice likes tea", 0);
    await seed("Alice enjoys tea", 0);
    const res = await consolidateFactsPhase(storage.engine(), {
      minOldestAgeMs: 24 * 60 * 60 * 1000, // 24h — freshly-written facts fail it
    });
    expect(res.bucketsSkipped).toBe(1);
    expect(res.takesWritten).toBe(0);
  });

  it("keeps consolidation within a source_id (no cross-tenant take)", async () => {
    for (const id of ["tenant-a", "tenant-b"]) {
      await storage
        .engine()
        .query(
          "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
          [id, `${id}/`],
        );
    }
    await seed("Alice prefers tea", 0, { sourceId: "tenant-a" });
    await seed("Alice likes tea", 0, { sourceId: "tenant-a" });
    await seed("Alice enjoys tea", 0, { sourceId: "tenant-a" });
    await seed("Alice prefers tea", 0, { sourceId: "tenant-b" });
    await seed("Alice likes tea", 0, { sourceId: "tenant-b" });
    const res = await consolidateFactsPhase(storage.engine(), {
      minOldestAgeMs: 0,
    });
    // tenant-a has 3 (>=3) -> processed; tenant-b has 2 (<3) -> its bucket
    // never qualifies. Exactly one take, stamped tenant-a.
    expect(res.takesWritten).toBe(1);
    const take = await storage.engine().query<{ source_id: string }>(
      `SELECT source_id FROM entity_facts WHERE written_by = 'facts-consolidate'`,
    );
    expect(take.rows).toHaveLength(1);
    expect(take.rows[0]!.source_id).toBe("tenant-a");
  });
});
