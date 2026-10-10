/**
 * Life Chronicle — shared types for the timeline reads and the per-entity
 * dimensional ontology. The timeline surfaces project event pages
 * (life/events/…) into `timeline_events`; the ontology rides `entity_facts`
 * (dimension/value/value_hash/dim_status from migration 097).
 */

/**
 * One projected timeline row: a `timeline_events` row joined to its depth page
 * (the meeting/transcript it came from) and, for an event projection, to the
 * event page that carries the structured `event` block + kind.
 */
export interface ChronicleTimelineRow {
  /** YYYY-MM-DD at UTC — the projection date. */
  date: string;
  summary: string;
  detail: string;
  /** Depth page slug (the rich page the row belongs to). */
  slug: string;
  /** Event page slug when this is an event projection, else null. */
  event_slug: string | null;
  /** event.kind from the event page frontmatter (null for a bare row). */
  kind: string | null;
}

/**
 * Why the extractor refused a proposed event before writing it:
 *   - `future_dated`: dated after the depth page's own day (or after today) —
 *     a plan, follow-up or scheduled item, not something that happened.
 *   - `date_imprecise`: `when` names only a year or a month ("2024",
 *     "2026-03"); the timeline stores days, so pinning it to the first of the
 *     month or year would invent one.
 */
export type ChronicleDropReason = "future_dated" | "date_imprecise";
export type ChronicleDropCounts = Partial<Record<ChronicleDropReason, number>>;

export interface ChronicleTimelineOpts {
  /** getTimelineForDate: expand to the ISO week (Mon–Sun) containing `date`. */
  week?: boolean;
  /** Filter event projections by `event.kind`. */
  kind?: string;
  limit?: number;
  /** Untrusted caller → drop rows whose depth OR event page is diary/journal
   *  (type or life/diary/ slug), so interiority never leaks via the timeline. */
  excludeDiary?: boolean;
  /** Required tenant read scope — no unscoped default (see chronicle.ts). */
  sourceIds: readonly string[];
}

export interface LastSeenResult {
  entity_slug: string;
  /** Most recent timeline date the entity appears in (own page or an event's
   *  `who`). NULL when never seen. */
  last_date: string | null;
  /** The most recent event page slug involving the entity, if the last hit was
   *  an event projection. */
  last_event_slug: string | null;
  /** Whole days between last_date and `asof` (default today). NULL when never. */
  days_ago: number | null;
}

// ── Per-entity dimensional ontology ────────────────────────────────────────
// An observation is a sourced, confidence-weighted, bi-temporal claim that an
// entity has dimension=value (e.g. role=advisor). Supersession/validity/
// visibility are inherited from the entity_facts lifecycle columns.

export interface OntologyObservationInput {
  entitySlug: string;
  dimension: string;
  value: string;
  /** 0..1; default 0.7. */
  confidence?: number;
  /** Provenance — written to entity_facts.source_slug (the dedup + read key).
   *  Null for a manually-entered claim with no source page. */
  source_slug?: string | null;
  /** Bi-temporal validity. DATE granularity (day). null valid_from = -infinity;
   *  null valid_until = open/current. */
  validFrom?: string | null;
  validTo?: string | null;
  visibility?: "private" | "world";
  /** Novel/LLM-proposed dimensions land 'quarantined' (excluded from reads). */
  status?: "active" | "quarantined";
}

export interface OntologyMergeResult {
  action: "inserted" | "corroborated" | "superseded_prior" | "noop";
  factId: number | null;
  supersededId: number | null;
  /** True when a backdated observation was recorded as a closed historical row
   *  without rewriting the current value (out-of-order arrival). */
  conflict?: boolean;
}

export interface OntologyValue {
  dimension: string;
  value: string;
  confidence: number;
  source_slug: string | null;
  valid_from: string | null;
  valid_to: string | null;
  /** 'active' | 'quarantined'. */
  status: string;
  fact_id: number;
}

export interface OntologyDimensionStat {
  dimension: string;
  entities: number;
  observations: number;
}

export interface OntologyConflict {
  entity_slug: string;
  dimension: string;
  values: {
    value: string;
    source_slug: string | null;
    confidence: number;
    fact_id: number;
  }[];
}

export interface OntologyReadOpts {
  asof?: string;
  minConfidence?: number;
  includeQuarantined?: boolean;
  /** Untrusted caller → restrict to visibility='world' rows (private never
   *  fetched). Fail-closed: the default (false) returns the operator's full set. */
  worldOnly?: boolean;
  /** Required tenant read scope — no unscoped default. */
  sourceIds: readonly string[];
}
