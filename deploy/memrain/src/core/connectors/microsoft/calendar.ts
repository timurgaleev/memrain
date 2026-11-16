/**
 * The Outlook calendar adapter: each selected calendar (the default one, plus
 * the ids in the account's `config.calendars`) is one stream, synced with
 * Graph's calendar view delta (learn.microsoft.com/graph/delta-query-events).
 *
 *   - A round starts with `GET .../calendarView/delta?startDateTime&endDateTime`
 *     over the window: from the first sync's floor (`config.history_days`,
 *     default 90, never past retention), or retention's edge once that is
 *     later, to 90 days ahead. Graph encodes the window into its state tokens,
 *     so every later page and round follow the stored `@odata.nextLink` /
 *     `@odata.deltaLink` as is.
 *   - Between pages, and between runs when a run stops on its item cap, the
 *     cursor is the pass itself (mode, window, next link), so a calendar
 *     larger than one run finishes over several runs. Only the last page's
 *     delta link is a resting point.
 *   - Graph fixes the window when a round starts, so a delta link would never
 *     see past its first horizon. Once a week, and whenever Graph has lost
 *     the round's state (410, or syncStateNotFound and friends), the adapter
 *     re-lists a fresh window; once through, every stored event of the
 *     calendar it did not touch is deleted as gone upstream, under the
 *     engine's mass-delete guard.
 *   - Graph v1.0 documents the calendar view delta for the default calendar
 *     only. Any other selected calendar (one of the owner's own; calendars
 *     others share need Calendars.Read.Shared, which is not asked for) is
 *     listed whole through the plain calendar view at most once an hour, and
 *     reconciled the same way after each listing.
 *   - `@removed` and `isCancelled` report an event deleted upstream; the
 *     engine routes it through the upstream deletion path (a recoverable soft
 *     delete) and its guard. Graph also reports under `@removed` events that
 *     left the window; their pages go too, and come back when a relist sees
 *     them inside it again.
 *   - A calendar view expands a recurring series into occurrences. A series
 *     is still one page, as Google's: an occurrence or exception names its
 *     series, whose master is fetched once per run and rendered with its
 *     occurrences inside the window (`/instances`), never the whole series.
 *     A removed occurrence carries only its own id, so the series page
 *     forgets it on the next change to the series or the weekly relist.
 *   - An online meeting is kept as a flag. Its join link is never stored:
 *     it is dropped from the event and scrubbed from the description.
 *
 * Every request carries `Prefer: outlook.timezone="UTC", odata.maxpagesize=50`
 * and bounds the response body. A delta or list page asks for no more events
 * than one run may store (the engine's `perRun` budget), so a low item cap
 * makes a first sync take more runs instead of replaying its first page. Rate
 * limits (429 with Retry-After) are waited out and retried by the connector
 * client; past its cap the run stops partial and resumes from the same
 * cursor. A selected calendar that answers 404 is one failing item, held
 * after repeated runs, so it neither stops the other calendars nor the
 * deletions they report.
 *
 * Calendar ids name mailboxes' folders, so stream names and item ids carry a
 * hash of the id. Everything in an event is outside text and goes through the
 * shared calendar renderer (render.ts), the same as Google Calendar's.
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { renderCalendarEvent } from "../render.ts";
import { retentionDays } from "../retention.ts";
import { syncItemFromPage } from "../sync-item.ts";
import { shortHash, type CalendarAttendee, type CalendarEvent, type CalendarOccurrence, type ConnectorContext, type Person } from "../model.ts";
import type { ItemBudget, PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import type { AdapterContext } from "../providers.ts";
import { DEFAULT_HISTORY_DAYS, MAX_HISTORY_DAYS, selectedCalendars, type GoogleCalendarEntry } from "../google/calendar.ts";
import { graphGet, graphLinkPath, isGraphPath, isSyncStateLost } from "./graph-client.ts";

/** The account service this adapter syncs. */
export const OUTLOOK_CALENDAR_SERVICE = "outlook_calendar";
/** Largest Graph response body read; past it the page fails instead of filling memory. */
const GRAPH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Events per page; Graph's own default is smaller and its maximum is not documented for calendar views. */
const PAGE_SIZE = 50;
/** Times in UTC, and at most `pageSize` events a page. */
function outlookPrefer(pageSize: number): string {
  return `outlook.timezone="UTC", odata.maxpagesize=${pageSize}`;
}
/** Sent on every Graph request of a calendar account whose page is not sized by the run's budget. */
export const OUTLOOK_PREFER = outlookPrefer(PAGE_SIZE);

const DAY_MS = 86_400_000;
/** How far ahead a round's window, and a series' listed occurrences, reach. */
const FORWARD_DAYS = 90;
const MAX_OCCURRENCES = 500;
const MAX_INSTANCE_PAGES = 10;
const MAX_LIST_PAGES = 10;
const RECONCILE_CLOCK_MARGIN_MS = 5 * 60_000;
const RELIST_EVERY_MS = 7 * DAY_MS;
/** How often a calendar other than the default one, which has no delta, is listed again. */
const LIST_EVERY_MS = 3_600_000;

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

const GRAPH_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?$/;
const UTC_ZONES = new Set(["utc", "etc/utc", "coordinated universal time"]);

/**
 * A Graph dateTimeTimeZone as ISO-8601 UTC (`...Z`), or, for an all-day
 * event, its date. Requests carry `Prefer: outlook.timezone="UTC"`, so any
 * other zone is a response this adapter did not ask for: null, not a guess.
 */
export function graphTime(v: unknown, allDay: boolean): string | null {
  if (v === null || typeof v !== "object") return null;
  const { dateTime, timeZone } = v as Record<string, unknown>;
  if (typeof dateTime !== "string" || typeof timeZone !== "string" || !UTC_ZONES.has(timeZone.trim().toLowerCase())) return null;
  const m = GRAPH_DATETIME.exec(dateTime);
  if (m === null) return null;
  if (allDay) return m[1]!;
  const at = `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  return Number.isFinite(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null;
}

/** A calendar id's stand-in in stream names and item ids. */
function calendarKey(calendarId: string): string {
  return shortHash(`ocal:${calendarId}`);
}

export function outlookCalendarStream(calendarId: string): string {
  return `ocal:${calendarKey(calendarId)}`;
}

function itemKey(calendarId: string, eventId: string): string {
  return `${calendarKey(calendarId)}:${eventId}`;
}

/** The Graph path a calendar's events hang under: the default calendar is `/me`'s own. */
function calendarBase(calendarId: string): string {
  return calendarId === "primary" ? "/v1.0/me" : `/v1.0/me/calendars/${encodeURIComponent(calendarId)}`;
}

function configInt(account: SyncAccount, key: string, min: number, max: number): number | null {
  const v = account.config?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

// ---------------------------------------------------------------------------
// Normalizing a Graph event.

const DAY_CODES: Readonly<Record<string, string>> = {
  sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA",
};
const SET_POS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/**
 * A Graph patternedRecurrence as the RRULE line Google shows for the same
 * series, so both render alike. Null for a pattern it cannot read.
 */
export function recurrenceToRrule(rec: unknown): string[] | null {
  if (!isRecord(rec) || !isRecord(rec.pattern)) return null;
  const p = rec.pattern;
  const interval = intIn(p.interval, 1, 1000);
  if (interval === null) return null;
  const days = Array.isArray(p.daysOfWeek) ? p.daysOfWeek.map(d => (typeof d === "string" ? DAY_CODES[d.toLowerCase()] : undefined)) : [];
  if (days.includes(undefined)) return null;
  const byDay = days.length > 0 ? `BYDAY=${days.join(",")}` : null;
  const parts: string[] = [];
  const freq = (f: string) => {
    parts.push(`FREQ=${f}`);
    if (interval > 1) parts.push(`INTERVAL=${interval}`);
  };
  const setPos = typeof p.index === "string" ? SET_POS[p.index.toLowerCase()] : undefined;
  switch (p.type) {
    case "daily":
      freq("DAILY");
      break;
    case "weekly":
      if (byDay === null) return null;
      freq("WEEKLY");
      parts.push(byDay);
      break;
    case "absoluteMonthly": {
      const day = intIn(p.dayOfMonth, 1, 31);
      if (day === null) return null;
      freq("MONTHLY");
      parts.push(`BYMONTHDAY=${day}`);
      break;
    }
    case "relativeMonthly":
      if (byDay === null || setPos === undefined) return null;
      freq("MONTHLY");
      parts.push(byDay, `BYSETPOS=${setPos}`);
      break;
    case "absoluteYearly": {
      const month = intIn(p.month, 1, 12);
      const day = intIn(p.dayOfMonth, 1, 31);
      if (month === null || day === null) return null;
      freq("YEARLY");
      parts.push(`BYMONTH=${month}`, `BYMONTHDAY=${day}`);
      break;
    }
    case "relativeYearly": {
      const month = intIn(p.month, 1, 12);
      if (month === null || byDay === null || setPos === undefined) return null;
      freq("YEARLY");
      parts.push(`BYMONTH=${month}`, byDay, `BYSETPOS=${setPos}`);
      break;
    }
    default:
      return null;
  }
  const range = isRecord(rec.range) ? rec.range : {};
  if (range.type === "endDate" && typeof range.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(range.endDate)) {
    parts.push(`UNTIL=${range.endDate.replace(/-/g, "")}`);
  } else if (range.type === "numbered") {
    const n = intIn(range.numberOfOccurrences, 1, 100_000);
    if (n !== null) parts.push(`COUNT=${n}`);
  }
  return [`RRULE:${parts.join(";")}`];
}

function person(v: unknown): Person | null {
  if (!isRecord(v) || !isRecord(v.emailAddress)) return null;
  const p = { name: str(v.emailAddress.name), email: str(v.emailAddress.address) };
  return p.name === null && p.email === null ? null : p;
}

/** Graph's answer names in Google's words, so both providers render and loop alike. */
function answerWord(response: unknown): string | null {
  switch (response) {
    case "accepted":
    case "organizer":
      return "accepted";
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    case "none":
    case "notResponded":
      return "needsAction";
    default:
      return null;
  }
}

/**
 * The owner's own answer: Graph keeps it in the event's `responseStatus`, not
 * on the owner's attendee entry (that one is the organizer's view, usually
 * `none`). An organizer who asked for no answer is owed none.
 */
function ownAnswer(ev: Json): string | null {
  if (ev.isOrganizer === true) return "accepted";
  const word = answerWord(isRecord(ev.responseStatus) ? ev.responseStatus.response : undefined);
  if (word === "needsAction" && ev.responseRequested === false) return "not requested";
  return word;
}

function lower(p: Person | null): string {
  return (p?.email ?? "").trim().toLowerCase();
}

function attendees(ev: Json, accountLabel: string): CalendarAttendee[] {
  const own = accountLabel.trim().toLowerCase();
  const mine = ownAnswer(ev);
  const out: CalendarAttendee[] = [];
  let found = false;
  for (const a of Array.isArray(ev.attendees) ? ev.attendees : []) {
    // A room or a piece of equipment is not a participant.
    if (!isRecord(a) || a.type === "resource") continue;
    const p = person(a);
    if (p === null) continue;
    const self = own !== "" && lower(p) === own;
    found ||= self;
    out.push({ ...p, response: self && mine !== null ? mine : answerWord(isRecord(a.status) ? a.status.response : undefined) });
  }
  // Invited through a list or a group: the owner is not listed, but owes an answer all the same.
  const organizer = person(ev.organizer);
  if (!found && own !== "" && ev.isOrganizer !== true && organizer !== null && lower(organizer) !== own && mine !== null) {
    out.push({ name: null, email: accountLabel.trim().toLowerCase(), response: mine });
  }
  return out;
}

const TEAMS_JOIN = /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>]*/gi;

/** The join links an online meeting carries, as given and HTML-escaped. */
function joinUrls(ev: Json): string[] {
  const raw = [isRecord(ev.onlineMeeting) ? str(ev.onlineMeeting.joinUrl) : null, str(ev.onlineMeetingUrl)].filter((u): u is string => u !== null);
  return [...new Set(raw.flatMap(u => [u, u.replace(/&/g, "&amp;")]))].sort((a, b) => b.length - a.length);
}

function description(ev: Json): string | null {
  const content = isRecord(ev.body) ? str(ev.body.content) : null;
  if (content === null) return null;
  let text = content;
  for (const url of joinUrls(ev)) text = text.split(url).join("");
  return text.replace(TEAMS_JOIN, "");
}

function isOnline(ev: Json): boolean {
  return ev.isOnlineMeeting === true || joinUrls(ev).length > 0;
}

/**
 * A Graph event as the provider-neutral shape; null when it has no start in
 * the zone the requests asked for. `accountLabel` is the connected address,
 * whose own answer is read from the event.
 */
export function normalizeOutlookEvent(
  calendarId: string,
  ev: Json,
  accountLabel: string,
  occurrences?: { list: CalendarOccurrence[]; truncated: boolean },
): CalendarEvent | null {
  const id = str(ev.id);
  const allDay = ev.isAllDay === true;
  const start = graphTime(ev.start, allDay);
  if (id === null || start === null) return null;
  const location = isRecord(ev.location) ? str(ev.location.displayName) : null;
  return {
    id: itemKey(calendarId, id),
    iCalUID: str(ev.iCalUId),
    title: str(ev.subject) ?? "",
    description: description(ev),
    location,
    start,
    end: graphTime(ev.end, allDay),
    allDay,
    status: ev.isCancelled === true ? "cancelled" : "confirmed",
    organizer: person(ev.organizer),
    attendees: attendees(ev, accountLabel),
    recurrence: recurrenceToRrule(ev.recurrence),
    ...(isOnline(ev) ? { onlineMeeting: true } : {}),
    ...(occurrences ? { occurrences: occurrences.list, occurrencesTruncated: occurrences.truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// The sync pass.

/**
 * A pass part-way through its pages, stored as the stream's cursor.
 *
 *   full  — a round over a fresh window; `since` is set on a relist and is
 *           when it began, for the reconcile at its end;
 *   delta — a round following the last delta link.
 *
 * `timeMin` is the stream's floor (where the first sync's history window
 * began); `timeMax` the horizon the current round asked for. `link` is the
 * Graph path to request next: a next link mid-round, the delta link at rest
 * (`atRest`), or null before a round's first request. `listedAt` is when the
 * last full round finished, so the weekly relist knows when it is due.
 */
interface PassState {
  v: 1;
  mode: "full" | "delta";
  timeMin: string;
  timeMax: string | null;
  link: string | null;
  atRest: boolean;
  since: string | null;
  listedAt: string | null;
}

function isoOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : undefined;
}

/** The stored cursor as a pass; null for none, or for one this version cannot read. */
export function parseOutlookCursor(cursor: string | null): PassState | null {
  if (cursor === null || !cursor.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1 || (raw.mode !== "full" && raw.mode !== "delta") || typeof raw.atRest !== "boolean") return null;
  const timeMin = isoOrNull(raw.timeMin);
  const timeMax = isoOrNull(raw.timeMax);
  const since = isoOrNull(raw.since);
  const listedAt = isoOrNull(raw.listedAt);
  if (typeof timeMin !== "string" || timeMax === undefined || since === undefined || listedAt === undefined) return null;
  const link = raw.link === null ? null : isGraphPath(raw.link) ? raw.link : undefined;
  if (link === undefined || (raw.mode === "delta" && link === null) || (raw.atRest && (raw.mode !== "delta" || link === null))) return null;
  return { v: 1, mode: raw.mode, timeMin, timeMax, link, atRest: raw.atRest, since, listedAt };
}

function invalid(res: ConnectorResponse, what: string): PageResult {
  return { ok: false, response: { ...res, class: "challenge", body: null, error: `unexpected ${what} response` } };
}

/** Whether an event ended before `lo` (ms); unknown times are kept. */
function endsBefore(ev: Json, lo: number): boolean {
  const allDay = ev.isAllDay === true;
  const t = graphTime(ev.end, allDay) ?? graphTime(ev.start, allDay);
  const at = t === null ? Number.NaN : Date.parse(t);
  return Number.isFinite(at) && at < lo;
}

function version(ev: Json): string | null {
  return str(ev.changeKey) ?? str(ev["@odata.etag"]);
}

class Adapter implements SyncAdapter {
  private readonly calendars: Map<string, string>;
  /** Series already fetched this run: two of its occurrences on different pages fetch it once. */
  private readonly seriesDone = new Set<string>();

  constructor(private readonly account: SyncAccount, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv) {
    this.calendars = new Map(selectedCalendars(account).map(id => [outlookCalendarStream(id), id]));
  }

  streams(): string[] {
    return (this.account.services ?? []).includes(OUTLOOK_CALENDAR_SERVICE) ? [...this.calendars.keys()] : [];
  }

  private retention(): number | null {
    return retentionDays("calendar", configInt(this.account, "retention_days", 0, 100_000), this.env);
  }

  private historyDays(): number {
    const days = configInt(this.account, "history_days", 1, MAX_HISTORY_DAYS) ?? DEFAULT_HISTORY_DAYS;
    const keep = this.retention();
    // Older events would be swept by retention as soon as they were stored.
    return keep === null ? days : Math.min(days, keep);
  }

  private horizon(): string {
    return new Date(this.now() + FORWARD_DAYS * DAY_MS).toISOString();
  }

  /** The earliest time anything of this stream is kept from (ms): the floor, or retention's edge once later. */
  private windowLo(st: PassState): number {
    const floor = Date.parse(st.timeMin);
    const keep = this.retention();
    return keep === null ? floor : Math.max(floor, this.now() - keep * DAY_MS);
  }

  private firstPass(): PassState {
    const timeMin = new Date(this.now() - this.historyDays() * DAY_MS).toISOString();
    return { v: 1, mode: "full", timeMin, timeMax: this.horizon(), link: null, atRest: false, since: null, listedAt: null };
  }

  /** A new round over a fresh window; once through, whatever it did not touch is gone upstream. */
  private relist(st: PassState): PassState {
    // Set early so a touch stamped after a small clock step back still reads as seen.
    const since = new Date(this.now() - RECONCILE_CLOCK_MARGIN_MS).toISOString();
    return { v: 1, mode: "full", timeMin: st.timeMin, timeMax: this.horizon(), link: null, atRest: false, since, listedAt: null };
  }

  private relistDue(st: PassState): boolean {
    return st.atRest && st.listedAt !== null && this.now() - Date.parse(st.listedAt) >= RELIST_EVERY_MS;
  }

  private requestPath(calendarId: string, st: PassState): string {
    if (st.link !== null) return st.link;
    const q = new URLSearchParams({
      startDateTime: new Date(this.windowLo(st)).toISOString(),
      endDateTime: st.timeMax ?? this.horizon(),
    });
    // Graph v1.0 documents the calendar view delta for the default calendar
    // only; any other calendar is listed whole (learn.microsoft.com/graph/api/event-delta).
    return calendarId === "primary"
      ? `/v1.0/me/calendarView/delta?${q.toString()}`
      : `${calendarBase(calendarId)}/calendarView?${q.toString()}`;
  }

  /** A selected calendar Graph says is not there: one failing item, not a stopped run. */
  private calendarGone(calendarId: string): PageResult {
    const item: SyncItem = {
      externalId: `calendar:${calendarKey(calendarId)}`,
      version: null,
      failure: { code: "calendar_not_found", message: "the selected calendar was not found; it may have been deleted or unshared" },
    };
    return { ok: true, items: [item], deletions: [], checkpoint: null, done: true };
  }

  /**
   * Events per delta or list page: never more than one run may store. The
   * size follows the caps, not what is left of today's, so it stays put
   * across a pass's skip-token pages; a page the day's leftover cannot hold
   * is finished whole by the next run.
   */
  private pagePrefer(budget: ItemBudget | undefined): string {
    return outlookPrefer(Math.max(1, Math.min(PAGE_SIZE, budget?.perRun ?? PAGE_SIZE)));
  }

  async page({ client, stream, cursor, budget }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    const calendarId = this.calendars.get(stream);
    if (calendarId === undefined) throw new Error(`outlook calendar adapter has no stream ${stream}`);
    const prefer = this.pagePrefer(budget);
    let st = parseOutlookCursor(cursor) ?? this.firstPass();
    const listed = calendarId !== "primary";
    if (listed && st.link === null && st.listedAt !== null) {
      // A listed calendar rests between passes; within the hour nothing is asked.
      if (this.now() - Date.parse(st.listedAt) < LIST_EVERY_MS) return { ok: true, items: [], deletions: [], checkpoint: null, done: true };
      st = this.relist(st);
    }
    if (this.relistDue(st)) st = this.relist(st);
    let res = await graphGet(client, this.requestPath(calendarId, st), { prefer, maxBytes: GRAPH_MAX_RESPONSE_BYTES });
    if (st.link !== null && isSyncStateLost(res)) {
      st = this.relist(st);
      res = await graphGet(client, this.requestPath(calendarId, st), { prefer, maxBytes: GRAPH_MAX_RESPONSE_BYTES });
    }
    if (res.status === 404 && calendarId !== "primary") return this.calendarGone(calendarId);
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || !Array.isArray(res.body.value)) return invalid(res, "calendar view delta");
    const full = st.mode === "full";
    const lo = this.windowLo(st);

    const items: SyncItem[] = [];
    const deletions = new Set<string>();
    const touchedSeries = new Set<string>();
    for (const ev of (res.body.value as unknown[]).filter(isRecord)) {
      const id = str(ev.id);
      if (id === null) continue;
      if (ev["@removed"] !== undefined) {
        deletions.add(itemKey(calendarId, id));
        continue;
      }
      const master = str(ev.seriesMasterId);
      if (master !== null || ev.type === "occurrence" || ev.type === "exception") {
        if (master !== null) touchedSeries.add(master);
        continue;
      }
      if (ev.type === "seriesMaster") {
        touchedSeries.add(id);
        continue;
      }
      if (ev.isCancelled === true) {
        deletions.add(itemKey(calendarId, id));
        continue;
      }
      if (endsBefore(ev, lo)) continue;
      items.push(this.renderItem(calendarId, ev, version(ev)));
    }
    for (const seriesId of touchedSeries) {
      const key = itemKey(calendarId, seriesId);
      if (deletions.has(key) || this.seriesDone.has(key)) continue;
      this.seriesDone.add(key);
      const out = await this.reloadSeries(client, calendarId, seriesId, lo, st.timeMax ?? this.horizon());
      if (out === null) continue;
      if ("response" in out) return { ok: false, response: out.response };
      if ("deleted" in out) deletions.add(out.deleted);
      else items.push(out);
    }

    const nextRaw = res.body["@odata.nextLink"];
    if (nextRaw !== undefined) {
      const next = graphLinkPath(nextRaw);
      if (next === null) return invalid(res, "calendar view delta (next link off Graph or too long)");
      return { ok: true, items, deletions: [...deletions], checkpoint: JSON.stringify({ ...st, link: next, atRest: false }), done: false };
    }
    const reconcile = full && st.since !== null ? { prefix: `${calendarKey(calendarId)}:`, unseenSince: st.since } : null;
    if (listed) {
      const rest: PassState = { ...st, link: null, atRest: false, since: null, listedAt: new Date(this.now()).toISOString() };
      return { ok: true, items, deletions: [...deletions], checkpoint: JSON.stringify(rest), done: true, ...(reconcile ? { reconcile } : {}) };
    }
    const delta = graphLinkPath(res.body["@odata.deltaLink"]);
    // Without it the next run could only read this last page again.
    if (delta === null) return invalid(res, "calendar view delta (no usable delta link on the last page)");
    const rest: PassState = {
      v: 1, mode: "delta", timeMin: st.timeMin, timeMax: st.timeMax, link: delta, atRest: true, since: null,
      listedAt: full ? new Date(this.now()).toISOString() : st.listedAt,
    };
    return { ok: true, items, deletions: [...deletions], checkpoint: JSON.stringify(rest), done: true, ...(reconcile ? { reconcile } : {}) };
  }

  private renderItem(calendarId: string, ev: Json, ver: string | null, occurrences?: { list: CalendarOccurrence[]; truncated: boolean }): SyncItem {
    const externalId = itemKey(calendarId, str(ev.id) ?? "");
    const label = this.account.accountLabel ?? "";
    const event = normalizeOutlookEvent(calendarId, ev, label, occurrences);
    if (event === null) return { externalId, version: ver, failure: { code: "invalid_event", message: "the event has no start in UTC" } };
    const ctx: ConnectorContext = { service: OUTLOOK_CALENDAR_SERVICE, accountLabel: label };
    try {
      return syncItemFromPage(renderCalendarEvent(ctx, event), ver, { enrich: true });
    } catch (e) {
      // The message can quote event text; only the error's kind is kept.
      return { externalId, version: ver, failure: { code: "render_failed", message: `the event could not be rendered (${e instanceof Error ? e.name : "error"})` } };
    }
  }

  /** A series' page again from its master and its occurrences in the window, or its deletion. */
  private async reloadSeries(
    client: ConnectorClient,
    calendarId: string,
    seriesId: string,
    lo: number,
    hi: string,
  ): Promise<SyncItem | { deleted: string } | { response: ConnectorResponse } | null> {
    const key = itemKey(calendarId, seriesId);
    const base = `${calendarBase(calendarId)}/events/${encodeURIComponent(seriesId)}`;
    const res = await graphGet(client, base, { prefer: OUTLOOK_PREFER, maxBytes: GRAPH_MAX_RESPONSE_BYTES });
    if (res.status === 404 || res.status === 410) return { deleted: key };
    if (res.class !== "ok") {
      if (res.class !== "forbidden") return { response: res };
      return { externalId: key, version: null, failure: { code: "series_unavailable", message: res.error ?? "series unavailable" } };
    }
    if (!isRecord(res.body)) return { response: { ...res, class: "challenge", body: null, error: "unexpected event response" } };
    const master = res.body;
    if (master.isCancelled === true) return { deleted: key };
    const occ = await this.occurrences(client, base, master.isAllDay === true, lo, hi);
    if ("response" in occ) {
      if (occ.response.class !== "forbidden") return occ;
      return { externalId: key, version: null, failure: { code: "instances_unavailable", message: occ.response.error ?? "instances unavailable" } };
    }
    if (occ.list.length === 0 && !occ.truncated && endsBefore(master, lo)) return null;
    const ver = shortHash([version(master) ?? "", ...occ.versions, occ.truncated ? "+" : ""].join("|"));
    return this.renderItem(calendarId, master, ver, { list: occ.list, truncated: occ.truncated });
  }

  private async occurrences(
    client: ConnectorClient,
    base: string,
    allDay: boolean,
    lo: number,
    hi: string,
  ): Promise<{ list: CalendarOccurrence[]; versions: string[]; truncated: boolean } | { response: ConnectorResponse }> {
    const hiMs = Date.parse(hi);
    const list: CalendarOccurrence[] = [];
    const versions: string[] = [];
    let path: string | null = `${base}/instances?${new URLSearchParams({ startDateTime: new Date(lo).toISOString(), endDateTime: hi }).toString()}`;
    for (let page = 0; page < MAX_INSTANCE_PAGES && path !== null; page++) {
      const res = await graphGet(client, path, { prefer: OUTLOOK_PREFER, maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") return { response: res };
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) {
        return { response: { ...res, class: "challenge", body: null, error: "unexpected instances response" } };
      }
      for (const inst of (res.body.value as unknown[]).filter(isRecord)) {
        const start = graphTime(inst.start, allDay);
        const s = start === null ? Number.NaN : Date.parse(start);
        // Graph bounds the expansion already; this keeps the window ours whatever it sends.
        if (!Number.isFinite(s) || s < lo || s >= hiMs || inst.isCancelled === true) continue;
        if (list.length >= MAX_OCCURRENCES) return { list, versions, truncated: true };
        list.push({ start: start!, end: graphTime(inst.end, allDay), status: "confirmed" });
        versions.push(`${str(inst.id) ?? ""}@${version(inst) ?? ""}`);
      }
      const nextRaw = res.body["@odata.nextLink"];
      if (nextRaw === undefined) return { list, versions, truncated: false };
      path = graphLinkPath(nextRaw);
      if (path === null) return { response: { ...res, class: "challenge", body: null, error: "unexpected instances next link" } };
    }
    return { list, versions, truncated: true };
  }
}

export function outlookCalendarAdapter(account: SyncAccount, opts: Partial<AdapterContext> = {}): SyncAdapter {
  return new Adapter(account, opts.now ?? Date.now, opts.env ?? process.env);
}

/**
 * The account's own calendars, its default calendar first, for the owner to
 * pick from. A calendar another user shares is left out: reading it takes
 * Calendars.Read.Shared, which this connector does not ask for
 * (learn.microsoft.com/graph/outlook-get-shared-events-calendars). The name
 * is the owner's (outside text, display only).
 */
export async function listOutlookCalendars(client: ConnectorClient, accountLabel: string): Promise<GoogleCalendarEntry[]> {
  const own = accountLabel.trim().toLowerCase();
  const out: GoogleCalendarEntry[] = [];
  let path: string | null = "/v1.0/me/calendars?$top=100";
  for (let page = 0; page < MAX_LIST_PAGES && path !== null; page++) {
    const res = await graphGet(client, path, { prefer: OUTLOOK_PREFER, maxBytes: GRAPH_MAX_RESPONSE_BYTES });
    if (res.class !== "ok") throw new Error(`calendar list failed: ${res.error ?? res.class}`);
    if (!isRecord(res.body) || !Array.isArray(res.body.value)) throw new Error("calendar list failed: unexpected response");
    for (const c of (res.body.value as unknown[]).filter(isRecord)) {
      const id = str(c.id);
      const owner = isRecord(c.owner) ? (str(c.owner.address) ?? "").trim().toLowerCase() : "";
      if (id === null || (c.isDefaultCalendar !== true && (own === "" || owner !== own))) continue;
      out.push({ id, summary: (str(c.name) ?? id).slice(0, 200), primary: c.isDefaultCalendar === true, accessRole: c.canEdit === true ? "writer" : "reader" });
    }
    const next = res.body["@odata.nextLink"];
    path = next === undefined ? null : graphLinkPath(next);
    if (next !== undefined && path === null) throw new Error("calendar list failed: unexpected next link");
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}
