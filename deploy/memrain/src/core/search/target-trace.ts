/**
 * "Where did this page get lost?" — a per-call trace of one target page
 * through the search pipeline, for `memrain search diagnose`.
 *
 * hybridSearch records the chunk ids each stage held (every retrieval arm,
 * the fused window, hydrate, each post-fusion stage, the alias hop, time
 * scope, the k trim, the token budget and return sizing) on a TargetTrace the
 * caller passes in. `diagnoseTarget` maps those ids to pages once, ranks the
 * target page in each list and names the first stage that no longer held it.
 * It reports the boundary a page fell at, never a cause it did not see: a
 * stage that only re-orders shows up as a rank change, and a stage that did
 * not run is absent rather than guessed.
 *
 * Normal searches pay nothing: hybridSearch only touches the trace when one
 * is set, and nothing outside the operator CLI sets one.
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { pageKeyFor } from "./page-fusion.ts";
import { slugCandidatesForPath } from "./page-slug.ts";

export class TargetTrace {
  readonly observations: Array<{ stage: string; ids: readonly string[] }> = [];

  observe(stage: string, ids: readonly string[]): void {
    this.observations.push({ stage, ids: [...ids] });
  }
}

export interface StageRank {
  stage: string;
  present: boolean;
  /** 1-based page rank in that stage's list, when present. */
  rank?: number;
}

export interface TargetDiagnosis {
  /**
   * `reinjected`: returned, but some stage between retrieval and the end did
   * not hold it (an arm found it and the fused window missed it, or a stage
   * dropped it) before a later stage put it back. `target_ambiguous`: the
   * target names pages in more than one source; pass `source:slug`.
   */
  state: "returned" | "reinjected" | "dropped" | "not_retrieved" | "target_ambiguous";
  /** For `target_ambiguous`: the sources holding the target. */
  sources?: string[];
  /** 1-based page rank in what the caller got back. */
  rank?: number;
  /** Arms that retrieved the page, with its page rank in each list. */
  arms: Array<{ arm: string; rank: number }>;
  lost_at?: string;
  why?: string;
  /** Rank the page held at the last stage that had it. */
  last_rank?: number;
  /** For a k cut: the stage that moved the page from inside k to below it. */
  pushed_below_k_by?: string;
  stages: StageRank[];
}

/** True when a document source_path denotes the target slug or path. */
export function pathMatchesTarget(sourcePath: string, sourceId: string | null | undefined, target: string): boolean {
  if (sourcePath === target) return true;
  return slugCandidatesForPath(sourcePath, sourceId ?? null).includes(target);
}

const WHY: Record<string, string> = {
  fused: "ranked below the fused candidate window (3 x k, at least 20)",
  hydrated: "removed at hydrate: a hidden or deleted page, outside the source scope, a page filter or a search-exclude prefix",
  "per-document": "the per-page cap kept other rows",
  "type-diversity": "the type-diversity cap: too many results of this page's type",
  "near-duplicate": "near-duplicate text of a higher-ranked page",
  "exact-lookup": "removed at the exact-lookup promotion",
  limit: "ranked below k",
  "token-budget": "the token budget filled before it",
  "adaptive-return": "adaptive return sizing trimmed it",
};

const isArm = (stage: string): boolean => stage.startsWith("arm:");

/** Turn per-stage presence into one state. Pure. */
export function diagnoseObservations(stages: readonly StageRank[], k?: number): TargetDiagnosis {
  const arms = stages.filter((s) => isArm(s.stage) && s.present).map((s) => ({ arm: s.stage.slice(4), rank: s.rank! }));
  const steps = stages.filter((s) => !isArm(s.stage));
  const base = { arms, stages: [...stages] };
  const last = steps.at(-1);
  if (last?.present) {
    // Retrieved by an arm, any stage missing it means a later one put it back.
    const firstSeen = arms.length > 0 ? 0 : steps.findIndex((s) => s.present);
    const gap = steps.slice(firstSeen).some((s) => !s.present);
    return { ...base, state: gap ? "reinjected" : "returned", rank: last.rank! };
  }
  const firstSeen = steps.findIndex((s) => s.present);
  if (firstSeen < 0) {
    if (arms.length === 0) return { ...base, state: "not_retrieved" };
    const lost = steps[0]?.stage;
    return { ...base, state: "dropped", ...(lost ? { lost_at: lost, why: WHY[lost] ?? `removed at ${lost}` } : {}) };
  }
  const lostIdx = steps.findIndex((s, i) => i > firstSeen && !s.present);
  const lost = steps[lostIdx]!;
  const held = steps[lostIdx - 1]!;
  const out: TargetDiagnosis = {
    ...base,
    state: "dropped",
    lost_at: lost.stage,
    why: WHY[lost.stage] ?? `removed at ${lost.stage}`,
    last_rank: held.rank!,
  };
  if (lost.stage === "limit" && k !== undefined) {
    for (let i = lostIdx - 1; i > 0; i--) {
      const now = steps[i]!;
      const before = steps[i - 1]!;
      if (now.present && before.present && now.rank! > k && before.rank! <= k) {
        out.pushed_below_k_by = now.stage;
        break;
      }
    }
  }
  return out;
}

/**
 * Rank the target in every recorded stage and diagnose. Chunk ids resolve to
 * pages under the caller's source scope only, so a row reached outside it
 * never counts as the target.
 */
export async function diagnoseTarget(
  engine: Engine,
  trace: TargetTrace,
  target: string,
  opts: { sourceIds?: readonly string[]; k?: number } = {},
): Promise<TargetDiagnosis> {
  const ids = [...new Set(trace.observations.flatMap((o) => o.ids))];
  const params: unknown[] = [ids];
  const scope = andSourceScope("d.source_id", opts.sourceIds, params);
  const rows = ids.length === 0 ? [] : (await engine.query<{ id: string; document_id: string; source_path: string; source_id: string | null }>(
    `SELECT c.id, c.document_id, d.source_path, d.source_id
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])${scope}`,
    params,
  )).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (opts.sourceIds === undefined || opts.sourceIds.length > 1) {
    const sources = [...new Set(rows.filter((r) => pathMatchesTarget(r.source_path, r.source_id, target)).map((r) => r.source_id ?? "default"))].sort();
    if (sources.length > 1) return { state: "target_ambiguous", sources, arms: [], stages: [] };
  }
  const stages = trace.observations.map(({ stage, ids: list }): StageRank => {
    const pages = new Set<string>();
    for (const id of list) {
      const row = byId.get(id);
      if (!row) continue;
      const page = pageKeyFor(row.source_path, row.source_id, String(row.document_id));
      if (pages.has(page)) continue;
      pages.add(page);
      if (pathMatchesTarget(row.source_path, row.source_id, target)) return { stage, present: true, rank: pages.size };
    }
    return { stage, present: false };
  });
  return diagnoseObservations(stages, opts.k);
}
