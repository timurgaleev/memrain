/**
 * Body timeline parsing -- deterministic, LLM-free, run on every page write
 * (page_put / page_append / page_revert). Three body shapes become
 * timeline_events on the page itself:
 *
 *   - bullets under a `## Timeline` heading: `- YYYY-MM-DD — text`,
 *     `- **YYYY-MM-DD** text`, `- YYYY-MM-DD: text`;
 *   - `### YYYY-MM-DD — title` headers anywhere in the body;
 *   - `[Source: X, YYYY-MM-DD]` inline citations on any other line.
 *
 * Reconciliation is a keyed diff over this page's own rows. Each derived row
 * carries `source_chunk_id = 'body-timeline:<slug>:<hash16>'`, the hash taken
 * over (kind, date, event). A write deletes the page's `body-timeline:` rows
 * whose key is not in the new set and inserts the new set through the mig017
 * chunk index (ON CONFLICT DO NOTHING). An unchanged body therefore keeps every
 * row id, an edited bullet replaces only that row, and manual, recipe, meeting
 * and chronicle rows (other or NULL source_chunk_id) are never touched.
 *
 * On by default; `MEMRAIN_BODY_TIMELINE=0` turns derivation off (and leaves
 * existing derived rows alone).
 */
import { createHash } from "node:crypto";
import { Storage } from "./storage.ts";
import { lockPageSlugs } from "./pages.ts";
import { stripCodeBlocks } from "./links.ts";
import { addTimelineEvent } from "./timeline.ts";
import { isCalendarDate } from "./effective-date.ts";

export type BodyTimelineKind = "bullet" | "header" | "citation";

export interface BodyTimelineEvent {
  kind: BodyTimelineKind;
  /** `YYYY-MM-DD`, a real calendar day. */
  date: string;
  event: string;
  detail: string;
}

export interface BodyTimelineSyncResult {
  /** Events parsed from the current body (after caps and dedup). */
  derived: number;
  /** Rows newly inserted by this write. */
  added: number;
  /** Stale derived rows removed by this write. */
  removed: number;
}

export const BODY_TIMELINE_KEY_PREFIX = "body-timeline:";

/** Same bound as the link extractors: a pathological page cannot make the scan wasteful. */
const MAX_SCAN_LEN = 1_000_000;
/** Longest line handed to a regex; keeps per-line matching cost constant. */
const MAX_LINE_LEN = 4096;
const MAX_EVENT_LEN = 500;
const MAX_DETAIL_LEN = 2000;
const MAX_EVENTS_PER_PAGE = 200;
/** A citation's closing bracket must sit within this many chars of `[Source:`. */
const MAX_CITATION_LEN = 300;
const CITATION_OPEN = "[Source:";

// Both patterns are anchored and every quantifier is bounded, so each match
// costs a constant over a line already capped at MAX_LINE_LEN.
// The text group is not anchored at the end: a longer line keeps its first
// N chars (and cleanEventText caps it again) rather than failing the match.
const BULLET_RE =
  /^\s{0,8}[-*]\s{1,4}(?:\*\*)?(\d{4}-\d{2}-\d{2})(?:\*\*)?\s{0,4}(?:[—–:-]\s{0,4})?(.{1,2000})/;
const HEADER_RE = /^###\s{1,4}(\d{4}-\d{2}-\d{2})\s{0,4}(?:[—–:-]\s{0,4})?(.{1,500})/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function bodyTimelineEnabled(
  env: string | undefined = process.env.MEMRAIN_BODY_TIMELINE,
): boolean {
  return env !== "0";
}

/** Diary interiority never feeds derived stores; same rule as the facts and chronicle fences. */
function isDiaryPage(type: string | undefined, slug: string): boolean {
  const t = (type ?? "").trim().toLowerCase();
  return t === "diary" || t === "journal" || slug.startsWith("life/diary/");
}

/** A real calendar day in 1900-2099; rejects 2026-02-30 instead of rolling it over. */
export function isValidDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  const year = Number(iso.slice(0, 4));
  return year >= 1900 && year <= 2099 && isCalendarDate(iso);
}

const DATED_BULLET_RE = /^\s{0,8}[-*]\s{1,4}(?:\*\*)?\d{4}-\d{2}-\d{2}/;
const DATED_HEADER_RE = /^###\s{1,4}\d{4}-\d{2}-\d{2}/;

/**
 * True for a line that could start or feed a body timeline: a level-1/2
 * `Timeline` heading, a `### YYYY-MM-DD` header, or a bullet that opens with a
 * date. No date-validity check: outside text escapes the shape, valid or not.
 */
export function isTimelineLine(line: string): boolean {
  const level = headingLevel(line);
  if (level === 1 || level === 2) return line.slice(level).trim().toLowerCase() === "timeline";
  return DATED_HEADER_RE.test(line) || DATED_BULLET_RE.test(line);
}

/** Heading level (1-6) of a line, or 0. Counts leading '#' without a regex. */
function headingLevel(line: string): number {
  let n = 0;
  while (n < line.length && n < 7 && line[n] === "#") n++;
  if (n === 0 || n > 6) return 0;
  const next = line[n];
  return next === undefined || next === " " || next === "\t" ? n : 0;
}

interface CitationSpan {
  start: number;
  end: number; // exclusive, past the ']'
  date: string;
  detail: string;
}

/** `[Source: X, YYYY-MM-DD]` spans in one line. The closing-bracket search is
 *  bounded per opener, so a line of unclosed openers stays linear. */
function findCitations(line: string): CitationSpan[] {
  const spans: CitationSpan[] = [];
  let from = 0;
  while (from < line.length) {
    const start = line.indexOf(CITATION_OPEN, from);
    if (start === -1) break;
    const limit = Math.min(line.length, start + MAX_CITATION_LEN);
    let close = -1;
    for (let i = start + CITATION_OPEN.length; i < limit; i++) {
      if (line[i] === "]") {
        close = i;
        break;
      }
    }
    if (close === -1) {
      from = start + CITATION_OPEN.length;
      continue;
    }
    const inner = line.slice(start + 1, close);
    const comma = inner.lastIndexOf(",");
    const date = comma === -1 ? "" : inner.slice(comma + 1).trim();
    if (comma !== -1 && isValidDate(date)) {
      spans.push({
        start,
        end: close + 1,
        date,
        detail: inner.slice(0, comma).trim().slice(0, MAX_DETAIL_LEN),
      });
    }
    from = close + 1;
  }
  return spans;
}

function cleanEventText(s: string): string {
  let t = s.trim();
  if (t.startsWith("- ") || t.startsWith("* ")) t = t.slice(2).trim();
  return t.slice(0, MAX_EVENT_LEN).trim();
}

/**
 * Parse the dated lines of a page body. Code spans and fences are masked first,
 * dates are validated as calendar days, events are capped at 500 chars and
 * deduplicated on (date, event), and at most 200 events are returned.
 *
 * Bullets and headers claim the cap before citations: a vault page usually
 * cites a source on nearly every line of its compiled truth above a trailing
 * `## Timeline`, and those citations must not crowd out the section itself.
 */
export function parseBodyTimeline(body: string): BodyTimelineEvent[] {
  const out: BodyTimelineEvent[] = [];
  const citations: BodyTimelineEvent[] = [];
  const seen = new Set<string>();
  const push = (ev: BodyTimelineEvent): boolean => {
    if (!ev.event) return true;
    const key = `${ev.date}|${ev.event}`;
    if (seen.has(key)) return true;
    seen.add(key);
    out.push(ev);
    return out.length < MAX_EVENTS_PER_PAGE;
  };
  // Held back until the scan ends; more than the cap can never be used.
  const citationSeen = new Set<string>();
  const pushCitation = (ev: BodyTimelineEvent): void => {
    if (!ev.event || citations.length >= MAX_EVENTS_PER_PAGE) return;
    const key = `${ev.date}|${ev.event}`;
    if (citationSeen.has(key)) return;
    citationSeen.add(key);
    citations.push(ev);
  };

  const scannable = stripCodeBlocks(body.slice(0, MAX_SCAN_LEN));
  let inTimeline = false;
  for (const rawLine of scannable.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const level = headingLevel(line);
    if (level > 0) {
      if (level <= 2) {
        inTimeline = level === 2 && line.slice(2).trim().toLowerCase() === "timeline";
        continue;
      }
      if (level === 3) {
        const m = HEADER_RE.exec(line.slice(0, MAX_LINE_LEN));
        if (m && isValidDate(m[1]!)) {
          if (!push({ kind: "header", date: m[1]!, event: cleanEventText(m[2]!), detail: "" })) {
            return out;
          }
          continue;
        }
      }
    }
    if (inTimeline && level === 0) {
      const m = BULLET_RE.exec(line.slice(0, MAX_LINE_LEN));
      if (m && isValidDate(m[1]!)) {
        if (!push({ kind: "bullet", date: m[1]!, event: cleanEventText(m[2]!), detail: "" })) {
          return out;
        }
        continue;
      }
    }
    if (!line.includes(CITATION_OPEN)) continue;
    const spans = findCitations(line);
    if (spans.length === 0) continue;
    let stripped = "";
    let pos = 0;
    for (const s of spans) {
      stripped += line.slice(pos, s.start);
      pos = s.end;
    }
    stripped += line.slice(pos);
    const text = cleanEventText(stripped.replace(/^#{1,6}\s/, ""));
    for (const s of spans) {
      const event = text || s.detail.slice(0, MAX_EVENT_LEN);
      pushCitation({ kind: "citation", date: s.date, event, detail: s.detail });
    }
  }
  for (const ev of citations) {
    if (!push(ev)) break;
  }
  return out;
}

/** Stable row key for one derived event on one page. The detail (a citation's
 *  source label) is part of it, so relabelling a citation replaces its row;
 *  events without one keep the key they always had. */
export function bodyTimelineKey(slug: string, ev: BodyTimelineEvent): string {
  const base = `${ev.kind}|${ev.date}|${ev.event}`;
  const h = createHash("sha256")
    .update(ev.detail ? `${base}|${ev.detail}` : base)
    .digest("hex")
    .slice(0, 16);
  return `${BODY_TIMELINE_KEY_PREFIX}${slug}:${h}`;
}

/**
 * Reconcile the page's body-derived timeline rows with its committed body.
 * Best-effort: a failure is logged and swallowed so it never fails the write.
 * `sourceId` is the page owner's source, stamped on every derived row.
 *
 * Runs under the page's write lock and reads the body there, not from the
 * caller: two writes racing on one page each reconcile after their own commit,
 * and one holding a body read before the other committed would otherwise
 * leave the rows describing a body the page no longer has.
 */
export async function syncBodyTimelineForPage(
  storage: Storage,
  slug: string,
  sourceId?: string,
): Promise<BodyTimelineSyncResult> {
  const empty: BodyTimelineSyncResult = { derived: 0, added: 0, removed: 0 };
  if (!bodyTimelineEnabled()) return empty;
  try {
    return await storage.engine().transaction(async (tx) => {
      await lockPageSlugs(tx, slug);
      const page = await tx.query<{ type: string | null; markdown_body: string | null }>(
        `SELECT type, markdown_body FROM pages WHERE slug = $1 AND deleted_at IS NULL`,
        [slug],
      );
      const row = page.rows[0];
      if (!row) return empty;
      return reconcile(new Storage(tx), slug, row.type ?? undefined, row.markdown_body ?? "", sourceId);
    });
  } catch (e) {
    console.error(`[memrain] body-timeline sync for '${slug}' failed (non-fatal):`, e);
    return empty;
  }
}

async function reconcile(
  storage: Storage,
  slug: string,
  type: string | undefined,
  body: string,
  sourceId: string | undefined,
): Promise<BodyTimelineSyncResult> {
  const result: BodyTimelineSyncResult = { derived: 0, added: 0, removed: 0 };
  // A diary page derives nothing; running the diff with an empty set also
  // drops rows left from before the page became a diary entry.
  const events = isDiaryPage(type, slug) ? [] : parseBodyTimeline(body);
  const keyed = events.map((ev) => ({ ev, key: bodyTimelineKey(slug, ev) }));
  const params: unknown[] = [
    slug,
    `${BODY_TIMELINE_KEY_PREFIX}${slug}:`,
    keyed.map((k) => k.key),
  ];
  // The key prefix alone scopes the diff: a page has one owner, so every row
  // under it is this page's. Scoping by source_id too stranded rows stamped
  // under another one (a re-owned page, a write that carried no source) —
  // undeletable, and their keyed re-insert hits the mig017 index and no-ops.
  // One statement both drops the stale keys and reports the kept ones, so
  // only events new to this body pay for an insert: an append that adds one
  // bullet to a long log page costs one insert, not one per event.
  const diff = await storage.engine().query<{ source_chunk_id: string; stale: boolean }>(
    `WITH del AS (
       DELETE FROM timeline_events
        WHERE slug = $1
          AND starts_with(source_chunk_id, $2)
          AND NOT (source_chunk_id = ANY($3::text[]))
        RETURNING source_chunk_id
     )
     SELECT source_chunk_id, true AS stale FROM del
     UNION ALL
     SELECT source_chunk_id, false AS stale FROM timeline_events
      WHERE slug = $1
        AND source_chunk_id = ANY($3::text[])`,
    params,
  );
  const present = new Set<string>();
  for (const r of diff.rows) {
    if (r.stale) result.removed += 1;
    else present.add(r.source_chunk_id);
  }
  result.derived = keyed.length;
  for (const { ev, key } of keyed) {
    if (present.has(key)) continue;
    try {
      const r = await addTimelineEvent(storage, {
        slug,
        occurred_at: ev.date,
        event: ev.event,
        detail: ev.detail,
        source_label: "body",
        source_chunk_id: key,
        ...(sourceId ? { source_id: sourceId } : {}),
      });
      if (r.inserted) result.added += 1;
    } catch (e) {
      console.error(`[memrain] body-timeline event on '${slug}' skipped (non-fatal):`, e);
    }
  }
  return result;
}
