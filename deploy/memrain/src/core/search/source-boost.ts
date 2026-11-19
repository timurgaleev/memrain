/**
 * Source-boost — multiply RRF score by a per-source weight.
 *
 * Default weights:
 *   vault   : 1.0   (canonical)
 *   memory  : 0.7   (machine-generated, less authoritative)
 *   webhook : 0.5   (high-volume, likely transient)
 *
 * Weights live in code rather than the DB so the wiring stays
 * simple; future + may move them to the sources row if it's
 * worth the operational config surface.
 */
import type { ChunkScore } from "./dedup.ts";
import type { SourceKind } from "../sources.ts";

// Default weights cover every value of SourceKind. If a new kind is
// added to sources.ts without being weighted here, applySourceBoost
// would multiply by undefined → NaN → unstable ordering. The
// Record<SourceKind, number> type makes the typechecker fail on that
// omission at compile time.
const DEFAULT_WEIGHTS: Record<SourceKind, number> = {
  vault: 1.0,
  memory: 0.7,
  webhook: 0.5,
  mailbox: 0.6,
  calendar: 0.6,
  transcript: 0.65,
  // Code chunkers register their source with `kind: "code"`; without
  // this entry the multiplier would be NaN and code hits would sort
  // unpredictably (typically last) after RRF + boost.
  code: 0.85,
  // Issue and pull-request pages mirrored by the GitHub connector.
  github: 0.75,
  // Connector chat days and meeting pages weigh like mail and transcripts.
  chat: 0.6,
  meeting: 0.65,
  other: 0.8,
};

export interface SourceBoostOptions {
  /** Map source_id → weight. Falls back to per-kind default. */
  perSourceId?: Record<string, number>;
  /** Map kind → weight. Falls back to DEFAULT_WEIGHTS. */
  perKind?: Partial<Record<SourceKind, number>>;
}

export interface BoostablePayload {
  source_id: string | null;
  source_kind: SourceKind | null;
}

export function applySourceBoost<T extends BoostablePayload>(
  hits: readonly ChunkScore<T>[],
  opts: SourceBoostOptions = {},
): ChunkScore<T>[] {
  const perId = opts.perSourceId ?? {};
  const perKind = { ...DEFAULT_WEIGHTS, ...(opts.perKind ?? {}) };
  return hits.map((h) => {
    const id = h.payload?.source_id ?? null;
    const kind = h.payload?.source_kind ?? null;
    const w = id !== null && id in perId
      ? perId[id]!
      : kind !== null
      ? perKind[kind]!
      : 1.0;
    return { ...h, score: h.score * w };
  });
}
