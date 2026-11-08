import type { DegradedReason } from "./search/search-meta.ts";

export type GatherFailure = DegradedReason | "pages_failed" | "page_dates_failed" | "graph_failed"
  | "takes_keyword_failed" | "takes_vector_failed" | "take_embedding_failed" | "anchors_failed"
  | "trajectory_failed" | "trajectory_timeout" | "calibration_failed"
  | "entity_lookup_failed" | "alias_lookup_failed";
export type OnGatherFailure = (reason: GatherFailure) => void;

/** Static stage codes only; never include database messages or corpus counts. */
export function gatherDiagnostics() {
  const reasons = new Set<GatherFailure>();
  return {
    note: (reason: GatherFailure): void => { reasons.add(reason); },
    fields: (): { gather_degraded?: GatherFailure[] } => reasons.size > 0
      ? { gather_degraded: [...reasons].sort() } : {},
  };
}
