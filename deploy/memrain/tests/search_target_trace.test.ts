/**
 * The target trace behind `memrain search diagnose` (target-trace.ts): the
 * first pipeline stage that no longer held a page, from what each stage
 * actually held.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { TargetTrace, diagnoseObservations, diagnoseTarget } from "../src/core/search/target-trace.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { failingEmbed } from "./rank-flags-fixture.ts";

describe("diagnoseObservations", () => {
  it("names the first stage after the page was held that no longer has it", () => {
    const d = diagnoseObservations([
      { stage: "arm:keyword", present: true, rank: 2 },
      { stage: "arm:vector", present: false },
      { stage: "fused", present: true, rank: 2 },
      { stage: "hydrated", present: true, rank: 2 },
      { stage: "near-duplicate", present: false },
      { stage: "limit", present: false },
    ]);
    expect(d).toMatchObject({ state: "dropped", lost_at: "near-duplicate", last_rank: 2, arms: [{ arm: "keyword", rank: 2 }] });
  });

  it("names the stage that pushed the page below k on a limit cut", () => {
    const d = diagnoseObservations([
      { stage: "arm:keyword", present: true, rank: 1 },
      { stage: "fused", present: true, rank: 1 },
      { stage: "two-pass-rerank", present: true, rank: 4 },
      { stage: "limit", present: false },
    ], 3);
    expect(d).toMatchObject({ state: "dropped", lost_at: "limit", last_rank: 4, pushed_below_k_by: "two-pass-rerank" });
  });

  it("tells not retrieved from fused-out, and returned from reinjected", () => {
    expect(diagnoseObservations([{ stage: "arm:keyword", present: false }, { stage: "fused", present: false }]).state).toBe("not_retrieved");
    expect(diagnoseObservations([{ stage: "arm:keyword", present: true, rank: 40 }, { stage: "fused", present: false }]))
      .toMatchObject({ state: "dropped", lost_at: "fused" });
    expect(diagnoseObservations([{ stage: "fused", present: true, rank: 1 }, { stage: "limit", present: true, rank: 1 }]))
      .toMatchObject({ state: "returned", rank: 1 });
    expect(diagnoseObservations([{ stage: "fused", present: true, rank: 3 }, { stage: "type-diversity", present: false }, { stage: "alias-hop", present: true, rank: 1 }]))
      .toMatchObject({ state: "reinjected", rank: 1 });
  });
});

describe("target trace through hybridSearch", () => {
  let tmp: string;
  let storage: Storage;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-target-trace-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await storage.engine().query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-b', 'other', '__tenant_b__') ON CONFLICT (id) DO NOTHING`,
    );
    // More repeats of the word rank higher in the keyword arm.
    for (const [id, repeats, source] of [["t1", 5, "default"], ["t2", 3, "default"], ["t3", 1, "default"], ["tb", 4, "tenant-b"]] as const) {
      const text = `${Array.from({ length: repeats }, () => "harbor").join(" ")} crane schedule`;
      await writeDocumentTransaction(
        storage,
        { documentId: id, sourcePath: `concepts/${id}`, title: id, frontmatter: {}, embeddingModel: "deterministic-test", sourceId: source },
        [{ text, entities: [], embedding: deterministicEmbed(text) }],
      );
    }
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = async (target: string, k: number, sourceIds?: string[]) => {
    const trace = new TargetTrace();
    await hybridSearch(storage, "harbor crane schedule", {
      embedQuery: failingEmbed, noCache: true, noTelemetry: true, k, traceTarget: trace, ...(sourceIds ? { sourceIds } : {}),
    });
    return diagnoseTarget(storage.engine(), trace, target, { k, ...(sourceIds ? { sourceIds } : {}) });
  };

  // Value: protects=the operator learns a page was retrieved and ranked, then cut by k;
  // fails_when=the trace misses a stage or ranks by chunk instead of page.
  it("reports a page ranked below k as lost at the limit with its last rank", async () => {
    const d = await run("concepts/t3", 1, ["default"]);
    expect(d.state).toBe("dropped");
    expect(d.lost_at).toBe("limit");
    expect(d.last_rank).toBe(3);
    expect(d.arms.map((a) => a.arm)).toContain("keyword");
  });

  it("reports the top page as returned", async () => {
    expect(await run("concepts/t1", 1, ["default"])).toMatchObject({ state: "returned", rank: 1 });
  });

  it("never counts a page outside the caller's sources", async () => {
    const d = await run("concepts/tb", 5, ["default"]);
    expect(d.state).toBe("not_retrieved");
    expect(d.stages.every((s) => !s.present)).toBe(true);
  });
});
