/**
 * Timeline events — per-page append-only event log over migrations
 * 017_timeline + 079 (manual dedup, summary/detail split, source label).
 *
 * Writes are append-only with idempotency on
 * (slug, occurred_at, source_chunk_id) for chunk-sourced events and on
 * (slug, occurred_at, event, source_label, source_id) for manual/API events
 * (mig079 — a retried `timeline_add` no longer duplicates).
 *
 * Chunk-keyed provenances that own and replace their rows by source_chunk_id:
 * `meeting-timeline:<slug>` (timeline-meetings.ts) and
 * `body-timeline:<slug>:<hash>` (timeline-body.ts, dated lines in page bodies).
 *
 * No update or delete surface — corrections become new events. A
 * future dream-cycle phase can mark superseded events but it never
 * mutates existing rows.
 */
import type { Storage } from "./storage.ts";
import { validateSlug } from "./pages.ts";
import { guardFields } from "./secret-scan.ts";
import { PageNotFoundError } from "./operation-error.ts";

export interface AddTimelineEventInput {
  slug: string;
  /** ISO-8601 timestamp string OR a Date. */
  occurred_at: string | Date;
  /** One-line summary. */
  event: string;
  /** Longer narrative under the summary (mig079; '' when omitted). */
  detail?: string;
  /** Provenance label — an importer name, 'manual', … (mig079; '' when
   *  omitted). Part of the manual dedup key so distinct provenance survives. */
  source_label?: string;
  source_chunk_id?: string;
  /**
   * Tenant source scope (migration 047). Omitted -> the column DEFAULT
   * 'default' applies, preserving whole-brain behavior.
   */
  source_id?: string;
  /** The authenticated principal behind the write (migration 134); audit-only. */
  written_by_principal?: string;
}

export interface TimelineEventRow {
  id: number;
  slug: string;
  occurred_at: string;
  event: string;
  detail: string;
  source_label: string;
  source_chunk_id: string | null;
  written_at: string;
}

export interface AddTimelineEventResult {
  id: number | null;
  slug: string;
  occurred_at: string;
  /** False when the (slug, occurred_at, source_chunk_id) tuple already existed. */
  inserted: boolean;
}

function normaliseOccurredAt(v: string | Date): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      // The value arrived with the right type and failed to PARSE; a caller
      // discriminating on TypeError would then treat bad data as a programming
      // mistake.
      // eslint-disable-next-line unicorn/prefer-type-error
      throw new Error("occurred_at: invalid Date");
    }
    return v.toISOString();
  }
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("occurred_at must be a non-empty ISO string or Date");
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    // The value arrived with the right type and failed to PARSE; a caller
    // discriminating on TypeError would then treat bad data as a programming
    // mistake.
    // eslint-disable-next-line unicorn/prefer-type-error
    throw new Error(`occurred_at: cannot parse ${JSON.stringify(v)}`);
  }
  return d.toISOString();
}

/**
 * The columns stamped only when set — source_id so its NOT NULL DEFAULT
 * applies otherwise, written_by_principal so an internal write stays NULL —
 * appended to `params` with their placeholders.
 */
function optionalCols(
  params: unknown[],
  sourceId: string | null,
  principal: string | null,
): { cols: string; values: string } {
  let cols = "";
  let values = "";
  for (const [col, value] of [["source_id", sourceId], ["written_by_principal", principal]] as const) {
    if (value === null) continue;
    params.push(value);
    cols += `, ${col}`;
    values += `, $${params.length}`;
  }
  return { cols, values };
}

/**
 * Append an event. Idempotent on (slug, occurred_at, source_chunk_id)
 * — a recipe re-emitting the same event from the same chunk does
 * not create duplicate rows. Returns `inserted: false` in that case.
 */
export async function addTimelineEvent(
  storage: Storage,
  input: AddTimelineEventInput,
): Promise<AddTimelineEventResult> {
  validateSlug(input.slug);
  if (typeof input.event !== "string" || input.event.length === 0) {
    throw new Error("event must be a non-empty string");
  }
  const occurred = normaliseOccurredAt(input.occurred_at);
  const chunkId = input.source_chunk_id ?? null;
  // mig079 columns — NOT NULL DEFAULT '' in the schema; normalize here so the
  // manual dedup key compares deterministically.
  const rawDetail = typeof input.detail === "string" ? input.detail : "";
  const sourceLabel =
    typeof input.source_label === "string" ? input.source_label.trim() : "";
  // Tenant scope (mig047): stamp source_id only when provided so the NOT NULL
  // column's DEFAULT 'default' applies otherwise (never pass NULL).
  const sourceId =
    typeof input.source_id === "string" && input.source_id.length > 0
      ? input.source_id
      : null;

  // Ownership guard: a scoped caller may only append to a page
  // its OWN source owns. The FK slug->pages only asserts the slug exists somewhere
  // (a global PK), so without this a tenant could write timeline events onto
  // another tenant's page. Unscoped callers (source_id absent -> the DEFAULT
  // 'default' tenant) keep the prior behavior.
  if (sourceId !== null) {
    const owns = await storage
      .engine()
      .query(`SELECT 1 FROM pages WHERE slug = $1 AND source_id = $2`, [
        input.slug,
        sourceId,
      ]);
    if (owns.rows.length === 0) {
      throw new PageNotFoundError(input.slug);
    }
  }
  const principal =
    typeof input.written_by_principal === "string" && input.written_by_principal.length > 0
      ? input.written_by_principal
      : null;
  const { event, detail } = await guardFields(
    storage.engine(),
    `timeline:${input.slug}`,
    sourceId,
    `timeline event on '${input.slug}'`,
    { event: input.event, detail: rawDetail },
  );

  // Manual/API events (no chunk id) dedup on the mig079 key: a retried write
  // with identical (slug, time, wording, label, tenant) is a no-op. Distinct
  // provenance (source_label) still coexists — the key was widened for exactly
  // that.
  if (chunkId === null) {
    const params: unknown[] = [input.slug, occurred, event, detail, sourceLabel];
    const extra = optionalCols(params, sourceId, principal);
    const r = await storage.engine().query<{ id: number }>(
      `INSERT INTO timeline_events
         (slug, occurred_at, event, detail, source_label, source_chunk_id${extra.cols})
       VALUES ($1, $2::timestamptz, $3, $4, $5, NULL${extra.values})
       ON CONFLICT (slug, occurred_at, event, source_label, source_id)
         WHERE source_chunk_id IS NULL
         DO NOTHING
       RETURNING id`,
      params,
    );
    return {
      id: r.rows[0]?.id ?? null,
      slug: input.slug,
      occurred_at: occurred,
      inserted: r.rows.length > 0,
    };
  }
  const params: unknown[] = [input.slug, occurred, event, detail, sourceLabel, chunkId];
  const extra = optionalCols(params, sourceId, principal);
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO timeline_events
       (slug, occurred_at, event, detail, source_label, source_chunk_id${extra.cols})
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6${extra.values})
     ON CONFLICT (slug, occurred_at, source_chunk_id)
       WHERE source_chunk_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    params,
  );
  return {
    id: r.rows[0]?.id ?? null,
    slug: input.slug,
    occurred_at: occurred,
    inserted: r.rows.length > 0,
  };
}

export interface ListTimelineOptions {
  /** Inclusive ISO timestamp. */
  since?: string | Date;
  /** Inclusive ISO timestamp. */
  until?: string | Date;
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, events are filtered
   * to `source_id = ANY(...)`. Omitted -> unscoped (whole-brain); `[]` -> nothing.
   */
  sourceIds?: string[];
}

export async function getEntityTimeline(
  storage: Storage,
  slug: string,
  opts: ListTimelineOptions = {},
): Promise<TimelineEventRow[]> {
  validateSlug(slug);
  const params: unknown[] = [slug];
  const where: string[] = ["slug = $1"];
  if (opts.since !== undefined) {
    params.push(normaliseOccurredAt(opts.since));
    where.push(`occurred_at >= $${params.length}::timestamptz`);
  }
  if (opts.until !== undefined) {
    params.push(normaliseOccurredAt(opts.until));
    where.push(`occurred_at <= $${params.length}::timestamptz`);
  }
  if (opts.sourceIds !== undefined) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);
  const r = await storage.engine().query<TimelineEventRow>(
    `SELECT id, slug, occurred_at::text AS occurred_at, event,
            detail, source_label,
            source_chunk_id, written_at::text AS written_at
       FROM timeline_events
       WHERE ${where.join(" AND ")}
       ORDER BY occurred_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}
