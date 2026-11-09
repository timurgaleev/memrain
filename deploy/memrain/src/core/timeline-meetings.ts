/**
 * Timeline extraction from meetings -- deterministic, LLM-free. For each
 * meeting page with a resolvable date, write append-only timeline_events
 * (migration 017) for the meeting itself and for each resolved attendee, so a
 * person's timeline shows the meetings they attended.
 *
 * Two design choices for this brain:
 *   - reads attendees from the meeting's `attendees` / `attended_by`
 *     compiled_truth fields DIRECTLY (self-contained -- does not depend on the
 *     opt-in typed-link `attended` edges being enabled);
 *   - the meeting date is resolved from HIGH-PRECISION sources only (no
 *     `effective_date` column): the explicit `compiled_truth.date` field, else
 *     a `YYYY-MM-DD` embedded in the slug. A free-text body date-mention is
 *     deliberately NOT used -- the first date in a meeting note is often a
 *     referenced/follow-up date, not the meeting's own, and a wrong date fans
 *     out to every attendee on an otherwise-immutable store.
 *
 * OPT-IN (`MEMRAIN_MEETING_TIMELINE=1`, default OFF). The phase is a
 * REPLACE-OWN-PROJECTION: each run first DELETES this meeting's own derived
 * events (those carrying `source_chunk_id='meeting-timeline:<slug>'`) and then
 * re-derives them from the CURRENT frontmatter -- so a corrected date or a
 * removed attendee is reflected, not left as a permanent stale row. It only
 * ever touches its own synthetic rows; user / recipe timeline events (a
 * different or NULL source_chunk_id) are never deleted. Default OFF because a
 * mis-resolved attendee is still a wrong (if self-correcting) entry, so the
 * operator confirms resolution on their vault first.
 *
 * Notes: attendee resolution goes through the slug canonicalizer, so with
 * `MEMRAIN_WIKILINK_CANONICALIZE=0` even exact-slug attendees stop resolving and
 * only the meeting-self event is written. The scan is bounded to the most
 * recently-updated `MAX_MEETINGS` meetings; on a vault larger than that, raise
 * the cap to re-project older meetings.
 */
import type { Storage } from "./storage.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";
import { addTimelineEvent } from "./timeline.ts";
import { extractDates } from "./entities.ts";
import { isJunkEntityName, isJunkEntitySlug } from "./entity-junk.ts";

/** Resolver stages precise enough to attach a meeting to a person's timeline. */
const PRECISE_STAGES: ReadonlySet<string> = new Set([
  "exact",
  "alias",
  "name_variant",
  "exact_tail",
  "prefix",
]);
/** Cap attendees processed per meeting (defence vs a pathological list). */
const MAX_ATTENDEES = 200;
/** Cap meetings scanned per run. */
const MAX_MEETINGS = 5000;
/** Cap event text length (defence vs a pathological title). */
const MAX_TITLE_LEN = 200;

export interface MeetingTimelineResult {
  /** Meeting pages iterated. */
  meetings_scanned: number;
  /** Timeline events (re)written this run (delete-then-derive, so = current set). */
  entries_written: number;
  /** Distinct attendee pages that received an event. */
  attendees_touched: number;
}

export function meetingTimelineEnabled(
  env: string | undefined = process.env.MEMRAIN_MEETING_TIMELINE,
): boolean {
  return env === "1";
}

interface MeetingRow {
  slug: string;
  source_id: string;
  title: string | null;
  compiled_truth: Record<string, unknown> | null;
}

/** A REAL calendar date (not just plausible fields): rejects 2026-02-31 etc.
 *  by requiring the UTC round-trip to print back identically. */
function isRealCalendarDate(iso: string): boolean {
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso;
}

/** First REAL calendar date (1900-2099) in a string, or null. extractDates
 *  gives plausible-field matches; the calendar guard rejects e.g. 2026-02-31,
 *  which JS Date would otherwise normalize to a WRONG day (2026-03-03). */
function firstIsoDate(s: string): string | null {
  for (const d of extractDates(s)) {
    const iso = d.name;
    if (iso && isRealCalendarDate(iso)) return iso;
  }
  return null;
}

/**
 * Resolve a meeting's date from HIGH-PRECISION sources only: the explicit
 * `compiled_truth.date` field (coerced to string so a Date/number value still
 * works), else a `YYYY-MM-DD` embedded in the slug. Returns a bare
 * `YYYY-MM-DD` (the timeline writer normalizes it to a timestamptz), or null.
 *
 * A free-text BODY date-mention is intentionally NOT a source: the first date
 * in a meeting note is frequently a referenced/follow-up date, not the
 * meeting's own, and a wrong date would fan out to every attendee.
 */
export function resolveMeetingDate(
  compiledTruth: Record<string, unknown> | null | undefined,
  slug: string,
): string | null {
  const fromField = compiledTruth?.["date"];
  if (fromField !== undefined && fromField !== null) {
    const fromFieldDate = firstIsoDate(String(fromField));
    if (fromFieldDate) return fromFieldDate;
  }
  return firstIsoDate(slug);
}

/** Normalize the attendees fields to a list of non-empty name strings. */
function attendeeNames(compiledTruth: Record<string, unknown> | null | undefined): string[] {
  if (!compiledTruth) return [];
  const out: string[] = [];
  for (const field of ["attendees", "attended_by"]) {
    const raw = compiledTruth[field];
    if (typeof raw === "string") {
      if (raw.trim()) out.push(raw.trim());
    } else if (Array.isArray(raw)) {
      for (const v of raw) {
        if (typeof v === "string" && v.trim()) out.push(v.trim());
      }
    }
  }
  return out;
}

export async function extractMeetingTimelinePhase(
  storage: Storage,
): Promise<MeetingTimelineResult> {
  const result: MeetingTimelineResult = {
    meetings_scanned: 0,
    entries_written: 0,
    attendees_touched: 0,
  };
  if (!meetingTimelineEnabled()) return result;

  const rows = await storage.engine().query<MeetingRow>(
    `SELECT slug, title, compiled_truth, source_id
       FROM pages
      WHERE type = 'meeting' AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ${MAX_MEETINGS}`,
  );

  const touched = new Set<string>();
  for (const m of rows.rows) {
    result.meetings_scanned += 1;
    const sourceKey = `meeting-timeline:${m.slug}`;

    // REPLACE-OWN-PROJECTION: drop this meeting's prior derived events first, so
    // a corrected date, a removed attendee, or a now-undated meeting leaves no
    // stale row. Scoped to OUR synthetic source_chunk_id -- user/recipe events
    // (different or NULL source_chunk_id) are untouched.
    await storage.engine().query(
      `DELETE FROM timeline_events WHERE source_chunk_id = $1 AND source_id IN ($2, 'default')`,
      [sourceKey, m.source_id],
    );

    const date = resolveMeetingDate(m.compiled_truth, m.slug);
    if (!date || date > new Date().toISOString().slice(0, 10)) continue;
    const title = ((m.title && m.title.trim()) || m.slug).slice(0, MAX_TITLE_LEN);

    // 1. The meeting's own occurrence, on the meeting page.
    await addTimelineEvent(storage, {
      slug: m.slug,
      occurred_at: date,
      event: `Meeting: ${title}`,
      source_chunk_id: sourceKey,
      source_id: m.source_id,
    });
    result.entries_written += 1;

    // 2. One "Attended" event per resolved attendee, on the attendee's page.
    const resolver = makeSlugResolver(storage, m.slug, { sourceIds: [m.source_id] });
    const seen = new Set<string>();
    let processed = 0;
    for (const name of attendeeNames(m.compiled_truth)) {
      if (processed++ >= MAX_ATTENDEES) break;
      if (isJunkEntityName(name)) continue;
      const res = await resolver.resolve(name);
      if (!res.resolved || !PRECISE_STAGES.has(res.stage)) continue;
      const attendee = res.slug;
      if (attendee === m.slug || seen.has(attendee) || isJunkEntitySlug(attendee)) continue;
      seen.add(attendee);
      await addTimelineEvent(storage, {
        slug: attendee,
        occurred_at: date,
        event: `Attended ${title}`,
        source_chunk_id: sourceKey,
        source_id: m.source_id,
      });
      result.entries_written += 1;
      touched.add(attendee);
    }
  }
  result.attendees_touched = touched.size;
  return result;
}
