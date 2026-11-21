/**
 * Life Chronicle timeline reads + event projection.
 *
 * Event pages (life/events/…) project one row into `timeline_events` via
 * migration 096's `event_slug` column and its (event_slug, UTC-date) unique
 * key, so re-projection is an UPDATE not a duplicate. The read surfaces window
 * over the UTC calendar date of `occurred_at` and join the projecting event
 * page for its `event.kind` (stored in compiled_truth) and soft-delete state.
 *
 * Every read REQUIRES an explicit tenant scope (sourceIds) — there is no
 * unscoped default, so a caller can never sweep the whole brain by accident.
 */
import { ownerOnlyLineageSql } from "./owner-only.ts";
import type { Storage } from "./storage.ts";
import { finalizeLastSeen } from "./chronicle/last-seen.ts";
import { guardFields } from "./secret-scan.ts";
import type {
  ChronicleTimelineRow,
  ChronicleTimelineOpts,
  LastSeenResult,
} from "./chronicle/types.ts";
import { flagRowAt } from "./write-gate-rows.ts";

/** Enforce the mandatory tenant scope. Returns the scope array or throws. */
function requireScope(sourceIds: readonly string[] | undefined): string[] {
  if (!sourceIds || sourceIds.length === 0) {
    throw new Error("chronicle read requires an explicit sourceIds scope");
  }
  return [...sourceIds];
}

/**
 * Tenant scope predicate keyed on the TIMELINE ROW's own source_id (not just
 * the depth page's) — a row whose source_id differs from its page's would
 * otherwise leak across tenants. Also asserts the depth page (and event page,
 * when present) share that source, so a cross-source projection is invisible to
 * BOTH tenants. `$n` binds the scope text[].
 */
function scopeClause(n: number): string {
  return (
    `te.source_id = ANY($${n}::text[])` +
    `\n      AND p.source_id = te.source_id` +
    `\n      AND (te.event_slug IS NULL OR ep.source_id = te.source_id)`
  );
}

// The projected columns, shared by every windowed read. `date` is the UTC
// calendar day of the event; `summary`/`detail` come off the timeline row;
// `kind` is read from the projecting event page's compiled_truth.
const ROW_SELECT = `
  (te.occurred_at AT TIME ZONE 'UTC')::date::text AS date,
  te.event AS summary,
  te.detail,
  te.slug,
  te.event_slug,
  ep.compiled_truth->'event'->>'kind' AS kind`;

const ROW_JOINS = `
  FROM timeline_events te
  JOIN pages p ON p.slug = te.slug AND p.deleted_at IS NULL
  LEFT JOIN pages ep ON ep.slug = te.event_slug
  WHERE (te.event_slug IS NULL OR ep.deleted_at IS NULL)`;

// Drop any row whose DEPTH page (p) or EVENT page (ep) is diary interiority —
// either type diary/journal or a life/diary/ slug. Static (no bound param), so
// callers append it only when excludeDiary is set. A manual timeline_add can
// attach a row to a diary page, so the depth-page check is the load-bearing one.
const DIARY_EXCLUSION = `
      AND p.type NOT IN ('diary','journal') AND p.slug NOT LIKE 'life/diary/%'
      AND (te.event_slug IS NULL
           OR (ep.type NOT IN ('diary','journal') AND ep.slug NOT LIKE 'life/diary/%'))
      AND ${ownerOnlyLineageSql("timeline", "te.id")}`;

/** Events on a single UTC day, or the ISO week containing it when opts.week. */
export async function getTimelineForDate(
  storage: Storage,
  dateISO: string,
  opts: ChronicleTimelineOpts,
): Promise<ChronicleTimelineRow[]> {
  const scope = requireScope(opts.sourceIds);
  const day = `(te.occurred_at AT TIME ZONE 'UTC')::date`;
  const params: unknown[] = [dateISO];
  let window: string;
  if (opts.week) {
    window =
      `${day} >= date_trunc('week', $1::date)::date ` +
      `AND ${day} <= (date_trunc('week', $1::date) + interval '6 days')::date`;
  } else {
    window = `${day} = $1::date`;
  }
  params.push(scope);
  let sql = `SELECT ${ROW_SELECT} ${ROW_JOINS}
      AND ${window}
      AND ${scopeClause(params.length)}`;
  if (opts.kind) {
    params.push(opts.kind);
    sql += ` AND ep.compiled_truth->'event'->>'kind' = $${params.length}`;
  }
  if (opts.excludeDiary) sql += DIARY_EXCLUSION;
  const limit = clampLimit(opts.limit, 200);
  params.push(limit);
  sql += ` ORDER BY te.occurred_at ASC, te.id ASC LIMIT $${params.length}`;
  const r = await storage.engine().query<ChronicleTimelineRow>(sql, params);
  return r.rows;
}

/** Events at or after `sinceISO`. */
export async function getSince(
  storage: Storage,
  sinceISO: string,
  opts: ChronicleTimelineOpts,
): Promise<ChronicleTimelineRow[]> {
  const scope = requireScope(opts.sourceIds);
  const params: unknown[] = [sinceISO, scope];
  let sql = `SELECT ${ROW_SELECT} ${ROW_JOINS}
      AND (te.occurred_at AT TIME ZONE 'UTC')::date >= $1::date
      AND ${scopeClause(2)}`;
  if (opts.kind) {
    params.push(opts.kind);
    sql += ` AND ep.compiled_truth->'event'->>'kind' = $${params.length}`;
  }
  if (opts.excludeDiary) sql += DIARY_EXCLUSION;
  const limit = clampLimit(opts.limit, 20, 50);
  params.push(limit);
  sql += ` ORDER BY te.occurred_at ASC, te.id ASC LIMIT $${params.length}`;
  const r = await storage.engine().query<ChronicleTimelineRow>(sql, params);
  return r.rows;
}

/** Same month+day in prior years ("on this day"), most recent first. */
export async function getOnThisDay(
  storage: Storage,
  targetISO: string,
  opts: ChronicleTimelineOpts,
): Promise<ChronicleTimelineRow[]> {
  const scope = requireScope(opts.sourceIds);
  const target = `(te.occurred_at AT TIME ZONE 'UTC')`;
  const params: unknown[] = [targetISO, scope];
  const limit = clampLimit(opts.limit, 50, 50);
  params.push(limit);
  const sql = `SELECT ${ROW_SELECT} ${ROW_JOINS}
      AND EXTRACT(MONTH FROM ${target}) = EXTRACT(MONTH FROM $1::date)
      AND EXTRACT(DAY FROM ${target}) = EXTRACT(DAY FROM $1::date)
      AND ${target}::date < $1::date
      AND ${scopeClause(2)}${opts.excludeDiary ? DIARY_EXCLUSION : ""}
      ORDER BY te.occurred_at DESC, te.id ASC LIMIT $3`;
  const r = await storage.engine().query<ChronicleTimelineRow>(sql, params);
  return r.rows;
}

/**
 * Most recent day an entity was seen — either its own page has a timeline row,
 * or an event page's `who` array references it (exact slug, or wikilink
 * substring). Finalized to a days_ago via the shared finalizer.
 */
export async function getLastSeen(
  storage: Storage,
  entity: string,
  opts: { asof?: string; excludeDiary?: boolean; sourceIds: readonly string[] },
): Promise<LastSeenResult> {
  const scope = requireScope(opts.sourceIds);
  const like = `%${entity}%`;
  const params: unknown[] = [entity, like, scope];
  // "Last seen" is a PAST relation, but the chronicle legitimately stores
  // future events (a scheduled call, a planned milestone). Without an upper
  // bound one of those becomes the answer and finalizeLastSeen clamps the
  // negative delta to days_ago: 0 — the entity reads as seen today. Bound to
  // <= asof/today, mirroring getOnThisDay's `< target`.
  let seenThrough = "current_date";
  if (opts.asof) {
    params.push(opts.asof);
    seenThrough = `$${params.length}::date`;
  }
  const sql = `
    SELECT (te.occurred_at AT TIME ZONE 'UTC')::date::text AS last_date,
           te.event_slug AS last_event_slug
    FROM timeline_events te
    JOIN pages p ON p.slug = te.slug AND p.deleted_at IS NULL
    LEFT JOIN pages ep ON ep.slug = te.event_slug
    WHERE (te.event_slug IS NULL OR ep.deleted_at IS NULL)
      AND (te.occurred_at AT TIME ZONE 'UTC')::date <= ${seenThrough}
      AND ${scopeClause(3)}${opts.excludeDiary ? DIARY_EXCLUSION : ""}
      AND (
        p.slug = $1
        OR (ep.slug IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(ep.compiled_truth->'event'->'who') = 'array'
                 THEN ep.compiled_truth->'event'->'who' ELSE '[]'::jsonb END
          ) AS w(name)
          WHERE w.name = $1 OR w.name LIKE $2
        ))
      )
    ORDER BY te.occurred_at DESC, te.id DESC
    LIMIT 1`;
  const r = await storage.engine().query<{
    last_date: string | null;
    last_event_slug: string | null;
  }>(sql, params);
  const row = r.rows[0];
  return finalizeLastSeen(entity, row?.last_date ?? null, row?.last_event_slug ?? null, opts.asof);
}

export interface UpsertEventProjectionInput {
  depthSlug: string;
  eventSlug: string;
  /** UTC calendar day (YYYY-MM-DD) — the projection date. Used for occurred_at
   *  only when `occurredAt` is not given (back-compat: midnight of this day). */
  dateISO: string;
  /** Full normalized event timestamp (ISO). Preferred: preserves intra-day time
   *  so same-day events order by real time, not insertion order. Its UTC date
   *  must equal dateISO so the projection dedup key stays stable. */
  occurredAt?: string;
  summary: string;
  detail?: string;
  sourceId: string;
}

/**
 * Project an event page into `timeline_events` (or update the existing
 * projection). Both the depth page and the event page are looked up
 * source-scoped, so a projection can never straddle tenants; when either is
 * missing (or owned by another source) nothing is written and `projected` is
 * false. Idempotent on (event_slug, UTC calendar day) — the mig096 partial
 * unique index — so a re-run updates in place rather than duplicating.
 */
export async function upsertEventProjection(
  storage: Storage,
  input: UpsertEventProjectionInput,
): Promise<{ projected: boolean }> {
  // occurred_at is pinned to UTC midnight of the projection day so the
  // (event_slug, (occurred_at AT TIME ZONE 'UTC')::date) key is deterministic
  // regardless of the connection's session timezone.
  //
  // source_label is PER-EVENT ('chronicle:event:<eventSlug>') so two distinct
  // event pages that share a depth page, day, and summary land distinct rows
  // under mig079's manual-dedup index (slug, occurred_at, event, source_label,
  // source_id) WHERE source_chunk_id IS NULL — otherwise the second insert trips
  // that index (which the ON CONFLICT target doesn't infer) and the extract job
  // retry-loops on a unique_violation.
  const occurredAt = input.occurredAt ?? `${input.dateISO}T00:00:00Z`;
  const { summary, detail } = await guardFields(
    storage.engine(),
    `chronicle:${input.eventSlug}`,
    input.sourceId,
    `chronicle event '${input.eventSlug}'`,
    { summary: input.summary, detail: input.detail ?? "" },
  );
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO timeline_events
       (slug, occurred_at, event, detail, source_label, event_slug, source_id)
     SELECT dp.slug, $3::timestamptz, $4, $5, 'chronicle:event:' || ep.slug, ep.slug, $6
       FROM pages dp, pages ep
      WHERE dp.slug = $1 AND dp.source_id = $6
        AND ep.slug = $2 AND ep.source_id = $6
     ON CONFLICT (source_id, event_slug, ((occurred_at AT TIME ZONE 'UTC')::date))
       WHERE event_slug IS NOT NULL
     DO UPDATE SET event = EXCLUDED.event, detail = EXCLUDED.detail,
                   slug = EXCLUDED.slug, source_label = EXCLUDED.source_label,
                   occurred_at = EXCLUDED.occurred_at
     RETURNING id`,
    [
      input.depthSlug,
      input.eventSlug,
      occurredAt,
      summary,
      detail,
      input.sourceId,
    ],
  );
  const id = r.rows[0]?.id;
  if (id !== undefined) {
    await flagRowAt(storage.engine(), {
      table: "timeline_events",
      targetId: id,
      fields: [{ field: "event", text: summary }, { field: "detail", text: detail }],
    }, { event: id });
  }
  return { projected: r.rows.length > 0 };
}

function clampLimit(limit: number | undefined, dflt: number, max = 1000): number {
  if (typeof limit === "number" && limit >= 1 && limit <= max) return Math.floor(limit);
  return dflt;
}
