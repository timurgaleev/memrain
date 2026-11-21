/**
 * The post-fusion ranking pipeline as a list of stages.
 *
 * Everything hybridSearch does between hydrating the fused candidates and
 * trimming to k — the multiplicative boosts, the re-sort, the per-document
 * and type-diversity collapses, the optional paid rerank, the near-duplicate
 * drop and the exact-lookup promotion — is one stage each, run in the order
 * of POST_FUSION_STAGES. A new ranking feature is a new stage: it declares
 * whether it can spend (`costClass`), when it runs (`enabled`) and what it
 * does (`apply`), and the pipeline, the shadow ranker and the bench see it
 * without another edit to hybrid.ts.
 */
import type { Engine } from "../../engine/interface.ts";
import type { BoostablePayload } from "../source-boost.ts";
import type { ChunkPayloadForRerank } from "../two-pass.ts";
import type { ChunkScore } from "../dedup.ts";
import type { SearchProvenance } from "../hit-provenance.ts";
import type { SearchExplain } from "../explain.ts";
import type { Intent } from "../intent.ts";
import type { QuerySuggestions } from "../query-intent.ts";
import type { SearchOptions } from "../hybrid.ts";

export interface HitPayload extends BoostablePayload, ChunkPayloadForRerank {
  provenance?: SearchProvenance;
  /** Live-model content freshness (documents.updated_at), for recency. */
  updated_at?: string | null;
  /** Document frontmatter (documents.frontmatter), for salience. */
  frontmatter?: unknown;
  /** Chunk source language (chunks.language), for the lang filter. */
  language?: string | null;
  /** Chunk symbol kind (chunks.symbol_type), for the symbol_kind filter. */
  symbol_type?: string | null;
  /** Content date COALESCE(effective_date, updated_at), for since/until. */
  effective_date?: string | null;
  /** Where effective_date came from (migration 080); 'fallback' / NULL is a row timestamp. */
  effective_date_source?: string | null;
}

export type Hit = ChunkScore<HitPayload>;

/** The ranking flags a call runs under (ranking-flags.ts), read once per search. */
export interface RankFlags {
  metadataGate: boolean;
  entityTruthSoft: boolean;
  pageFusion: boolean;
  keywordConfidence: boolean;
  exactLookup: boolean;
}

/** What hybridSearch knows when fusion is done; every stage reads from it. */
export interface StageInput {
  engine: Engine;
  /** The trimmed query. */
  query: string;
  intent: Intent;
  opts: Pick<SearchOptions, "detail" | "salience" | "recency" | "walkDepth" | "sourceIds">;
  detailResolved: SearchOptions["detail"];
  suggestions: QuerySuggestions;
  rank: RankFlags;
  k: number;
  structural: boolean;
  graphFloorRatio: number | undefined;
  graphSignalsOn: boolean;
  backlinkBoostOn: boolean;
  rerankWanted: boolean;
  /** Which arms voted, for the metadata-boost gate. */
  votes: { vectorVoted: boolean; lexicalVoted: boolean };
  /** Per-signal attribution, only when the caller asked for explain. */
  explainAcc: Map<string, Partial<SearchExplain>> | null;
}

/** Values every stage would otherwise recompute from the input. */
export interface StageContext extends StageInput {
  skipMetadata: boolean;
  canonical: boolean;
  recencyBoostMode: "off" | "on" | "strong";
  /** Set by the per-page cap: the candidates a per-document cap would have kept (type-diversity basis). */
  typeDiversityBasis?: number;
}

export interface RankStage {
  name: string;
  /** "paid" stages may call a model; the shadow ranker never runs them. */
  costClass: "free" | "paid";
  enabled: (ctx: StageContext) => boolean;
  /** May score in place and return the same array, or return a new one. */
  apply: (hits: Hit[], ctx: StageContext) => Promise<Hit[]>;
}
