/**
 * The synthetic search bench: a corpus that ships with the code, loaded into a
 * throwaway PGLite brain with the deterministic embedder, and scored through
 * the real hybrid search. No model is called, and the run proves it by reading
 * the spend ledger of its own database.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import {
  benchQrelsPath,
  decoyReport,
  loadBenchQrels,
  openBenchBrain,
  runBench,
  type BenchBrain,
} from "../src/eval/bench/harness.ts";

setDefaultTimeout(120_000);

describe("bench qrels", () => {
  it("every query is tagged, unique, and points at a page that exists in the corpus", () => {
    const qrels = loadBenchQrels();
    const ids = qrels.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    const texts = qrels.queries.map((q) => q.query);
    expect(new Set(texts).size).toBe(texts.length);
    for (const q of qrels.queries) expect(q.tags.length).toBeGreaterThan(0);
    expect(qrels.queries.filter((q) => q.decoy_output !== undefined).length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(benchQrelsPath(), "utf8")).not.toMatch(/@[a-z0-9-]+\.(com|org|net|io)\b/);
  });

  it("a decoy whose wrong answer the scorer accepts is reported as passed", () => {
    const qrels = loadBenchQrels();
    const clean = decoyReport(qrels, 5);
    expect(clean.total).toBeGreaterThanOrEqual(3);
    expect(clean.passed).toEqual([]);
    // A decoy output that contains a relevant page is no longer wrong: the
    // scorer accepts it, and the report must say so.
    const leaky = {
      ...qrels,
      queries: qrels.queries.map((q) => q.decoy_output ? { ...q, decoy_output: [...q.expected_paths] } : q),
    };
    expect(decoyReport(leaky, 5).passed.length).toBe(clean.total);
  });
});

describe("bench brain", () => {
  let brain: BenchBrain;
  beforeAll(async () => {
    brain = await openBenchBrain();
  });
  afterAll(async () => {
    await brain.close();
  });

  it("indexes the vault pages under the default source and the mail under a mailbox source", async () => {
    const r = await brain.storage.engine().query<{ kind: string; n: number }>(
      `SELECT s.kind, count(*)::int AS n FROM documents d JOIN sources s ON s.id = d.source_id
        WHERE d.deleted_at IS NULL GROUP BY s.kind ORDER BY s.kind`,
    );
    const byKind = Object.fromEntries(r.rows.map((row) => [row.kind, row.n]));
    expect(byKind.mailbox).toBeGreaterThanOrEqual(20);
    expect(byKind.vault).toBeGreaterThanOrEqual(50);
  });
});

describe("runBench", () => {
  it("scores every non-decoy query, reports per tag, rejects every decoy and spends nothing", async () => {
    const report = await runBench();
    const qrels = loadBenchQrels();
    expect(report.ok).toBe(true);
    expect(report.queries).toBe(qrels.queries.filter((q) => !q.decoy_output).length);
    expect(report.decoys.passed).toEqual([]);
    expect(report.decoys.total).toBeGreaterThanOrEqual(3);
    expect(report.spend).toEqual({ calls: 0, usd: 0 });
    expect(report.overall.n).toBeGreaterThan(40);
    expect(report.overall.hit_at_5).toBeGreaterThan(0.5);
    expect(report.by_tag["kind:code"]!.n).toBeGreaterThanOrEqual(5);
    expect(report.by_tag["lang:de"]!.n).toBe(5);
    // Every scored query has its ranked pages in the snapshot.
    expect(Object.keys(report.ranked).length).toBe(report.queries);
  });
});
