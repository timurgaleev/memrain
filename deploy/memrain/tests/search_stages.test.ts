/**
 * The post-fusion pipeline as a list of stages (core/search/stages). The
 * ranking itself is pinned by the bench snapshot and the search suites; this
 * file pins the contract the shadow ranker and future stages lean on: the
 * order, which stages can spend, and that a stage runs only when enabled.
 */
import { describe, expect, it } from "bun:test";
import { POST_FUSION_STAGES, paidStageEnabled, runPostFusionStages } from "../src/core/search/stages/pipeline.ts";
import type { Hit, StageInput } from "../src/core/search/stages/types.ts";
import { classifyQuerySuggestions } from "../src/core/search/query-intent.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const noDb = {
  query: async () => {
    throw new Error("this stage set must not touch the database");
  },
} as unknown as Engine;

function input(overrides: Partial<StageInput> = {}): StageInput {
  const query = "ledger reconciliation";
  return {
    engine: noDb,
    query,
    intent: "topic",
    opts: {},
    detailResolved: "medium",
    suggestions: classifyQuerySuggestions(query),
    rank: { metadataGate: false, entityTruthSoft: false, pageFusion: false, keywordConfidence: false, exactLookup: false },
    k: 5,
    structural: false,
    graphFloorRatio: undefined,
    graphSignalsOn: false,
    backlinkBoostOn: false,
    rerankWanted: false,
    votes: { vectorVoted: true, lexicalVoted: true },
    explainAcc: null,
    ...overrides,
  };
}

const hit = (id: string, score: number, kind: "vault" | "mailbox"): Hit => ({
  chunkId: `${id}_c0`,
  documentId: id,
  score,
  payload: { content: `${id} text`, title: id, sourcePath: `/${id}.md`, source_id: kind, source_kind: kind, frontmatter: {} },
});

describe("post-fusion stages", () => {
  it("run in a fixed order, and only the two-pass rerank can spend", () => {
    expect(POST_FUSION_STAGES.map((s) => s.name)).toEqual([
      "compiled-truth", "source", "recency-salience-title", "mattering", "graph-signals", "backlink",
      "exact-match", "alias-resolved", "sort", "feedback", "per-document", "type-diversity", "two-pass-rerank",
      "near-duplicate", "exact-lookup",
    ]);
    expect(POST_FUSION_STAGES.filter((s) => s.costClass === "paid").map((s) => s.name)).toEqual(["two-pass-rerank"]);
    expect(paidStageEnabled(input())).toBe(false);
    expect(paidStageEnabled(input({ rerankWanted: true }))).toBe(true);
  });

  it("re-sorts after the source weights, so a mailbox hit falls behind a written page", async () => {
    // The metadata gate stands the alias-resolved lookup down; nothing else
    // enabled here reads the database.
    const out = await runPostFusionStages(
      [hit("mail", 1.0, "mailbox"), hit("note", 0.9, "vault")],
      input({ rank: { ...input().rank, metadataGate: true }, votes: { vectorVoted: true, lexicalVoted: false } }),
    );
    expect(out.map((h) => h.documentId)).toEqual(["note", "mail"]);
  });
});
