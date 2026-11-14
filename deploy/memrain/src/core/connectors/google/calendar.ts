/**
 * The Google Calendar adapter: each selected calendar (primary, plus the ids
 * in the account's `config.calendars`) is one stream, synced with the Calendar
 * v3 incremental protocol.
 *
 *   - First pass: `events.list` with `timeMin` = now minus the history window
 *     (`config.history_days`, default 90, never past the calendar retention
 *     window), `showDeleted=true`, `singleEvents=false`, paged by
 *     `nextPageToken`. Only the last page carries `nextSyncToken`.
 *   - Later passes send the stored token as `syncToken` with the same query
 *     minus `timeMin`: Google refuses `timeMin`, `timeMax` and `updatedMin`
 *     next to a sync token.
 *   - Between pages, and between runs when a run stops on its item cap, the
 *     cursor is the pass itself (mode, window, page token), so a calendar
 *     larger than one run finishes over several runs instead of starting over
 *     each time. A stored page token Google no longer takes (400/410) restarts
 *     that pass.
 *   - 410 GONE on a sync token means Google wants the local copy wiped and a
 *     full sync. Instead of wiping, the calendar is listed again over the
 *     whole retention window (`timeMin` filters on an event's end, the same
 *     time retention keys on), and once the relisting is through, every stored
 *     event of this calendar it did not touch is deleted as gone upstream,
 *     under the same mass-delete guard. Pages that are still there match by
 *     content, so nothing is duplicated.
 *     (developers.google.com/workspace/calendar/api/guides/sync)
 *   - `status: cancelled` reports an event deleted upstream; the engine routes
 *     it through the hard-delete path and its mass-delete guard.
 *   - A recurring series is one page. Its occurrences are expanded by Google
 *     (`events.instances`) inside the retention window and a 90-day horizon
 *     only, never the whole, possibly endless, series. A changed or cancelled
 *     single occurrence re-renders its series page instead of making a page
 *     of its own.
 *   - Working-location entries are not meetings and are not stored.
 *
 * Rate limits (429, and 403 rateLimitExceeded / userRateLimitExceeded) are
 * waited out and retried by the connector client; past its cap the run stops
 * partial and the next slot resumes from the same cursor. A selected calendar
 * that answers 404 (deleted, or no longer shared) is one failing item, held
 * after repeated runs, so it neither stops the other calendars nor the
 * deletions they report.
 *
 * Calendar ids can be someone's address, so stream names and item ids carry a
 * hash of the id, never the id itself. Everything in an event is outside text
 * and goes through the shared calendar renderer (render.ts).
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { renderCalendarEvent } from "../render.ts";
import { retentionDays } from "../retention.ts";
import { syncItemFromPage } from "../runtime.ts";
import { shortHash, type CalendarAttendee, type CalendarEvent, type CalendarOccurrence, type ConnectorContext, type Person } from "../model.ts";
import type { PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import type { AdapterContext } from "../providers.ts";

export const GOOGLE_API_ORIGIN = "https://www.googleapis.com";
/** The account service this adapter syncs. */
export const GOOGLE_CALENDAR_SERVICE = "calendar";

const DAY_MS = 86_400_000;
const PAGE_SIZE = "250";
const DEFAULT_HISTORY_DAYS = 90;
const MAX_HISTORY_DAYS = 3650;
/** How far ahead a series' occurrences are listed. */
const FORWARD_DAYS = 90;
const MAX_OCCURRENCES = 500;
const MAX_INSTANCE_PAGES = 10;
const MAX_CALENDARS = 20;
const MAX_CALENDAR_ID = 1024;
const MAX_LIST_PAGES = 10;
const SKIPPED_EVENT_TYPES = new Set(["workingLocation"]);
const READABLE_ROLES = new Set(["reader", "writer", "owner"]);

type Json = Record<string, unknown>;

/** A calendar id's stand-in in stream names and item ids. */
function calendarKey(calendarId: string): string {
  return shortHash(`gcal:${calendarId}`);
}

export function calendarStream(calendarId: string): string {
  return `gcal:${calendarKey(calendarId)}`;
}

function itemKey(calendarId: string, eventId: string): string {
  return `${calendarKey(calendarId)}:${eventId}`;
}

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** primary, then the account's selected calendars, de-duplicated and bounded. */
export function selectedCalendars(account: SyncAccount): string[] {
  const out = ["primary"];
  const raw = account.config?.["calendars"];
  if (Array.isArray(raw)) {
    for (const id of raw) {
      // eslint-disable-next-line no-control-regex
      if (typeof id !== "string" || id === "" || id.length > MAX_CALENDAR_ID || /[\u0000-\u001F\u007F]/.test(id)) continue;
      if (!out.includes(id)) out.push(id);
      if (out.length >= MAX_CALENDARS) break;
    }
  }
  return out;
}

function configInt(account: SyncAccount, key: string, min: number, max: number): number | null {
  const v = account.config?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/**
 * A pass part-way through its pages, stored as the stream's cursor. Google's
 * own sync tokens are opaque strings that never start with `{`, so a stored
 * cursor is one or the other.
 *
 *   full  — listing a window from `timeMin`; `since` is set on a relisting
 *           after a 410 and is when it began, for the reconcile at its end;
 *   delta — reading the changes after sync token `token`.
 */
interface PassState {
  v: 1;
  mode: "full" | "delta";
  timeMin: string | null;
  token: string | null;
  pageToken: string | null;
  since: string | null;
}

const MAX_CURSOR_FIELD = 4096;

function cursorField(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === "string" && v !== "" && v.length <= MAX_CURSOR_FIELD ? v : undefined;
}

/** The stored cursor as a pass; null for none, or for one this version cannot read. */
export function parsePassCursor(cursor: string | null): PassState | null {
  if (cursor === null || cursor === "") return null;
  if (!cursor.startsWith("{")) return { v: 1, mode: "delta", timeMin: null, token: cursor, pageToken: null, since: null };
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1 || (raw.mode !== "full" && raw.mode !== "delta")) return null;
  const timeMin = cursorField(raw.timeMin);
  const token = cursorField(raw.token);
  const pageToken = cursorField(raw.pageToken);
  const since = cursorField(raw.since);
  if (timeMin === undefined || token === undefined || pageToken === undefined || since === undefined) return null;
  if (raw.mode === "full" ? timeMin === null || Number.isNaN(Date.parse(timeMin)) : token === null) return null;
  if (since !== null && Number.isNaN(Date.parse(since))) return null;
  return { v: 1, mode: raw.mode, timeMin, token, pageToken, since };
}

interface Window {
  timeMin: string;
  timeMax: string;
}

function invalid(res: ConnectorResponse, what: string): PageResult {
  return { ok: false, response: { ...res, class: "challenge", body: null, error: `unexpected ${what} response` } };
}

function when(v: unknown): { at: string; allDay: boolean } | null {
  if (!isRecord(v)) return null;
  const dateTime = str(v.dateTime);
  if (dateTime !== null) return { at: dateTime, allDay: false };
  const date = str(v.date);
  return date === null ? null : { at: date, allDay: true };
}

function status(v: unknown): CalendarEvent["status"] {
  return v === "tentative" || v === "cancelled" ? v : "confirmed";
}

function person(v: unknown): Person | null {
  if (!isRecord(v)) return null;
  const p = { name: str(v.displayName), email: str(v.email) };
  return p.name === null && p.email === null ? null : p;
}

function attendees(v: unknown): CalendarAttendee[] {
  if (!Array.isArray(v)) return [];
  const out: CalendarAttendee[] = [];
  for (const a of v) {
    // A room or a piece of equipment is not a participant.
    if (!isRecord(a) || a.resource === true) continue;
    const p = person(a);
    if (p !== null) out.push({ ...p, response: str(a.responseStatus) });
  }
  return out;
}

/** A Google event as the provider-neutral shape; null when it has no start. */
export function normalizeGoogleEvent(calendarId: string, ev: Json, occurrences?: { list: CalendarOccurrence[]; truncated: boolean }): CalendarEvent | null {
  const id = str(ev.id);
  const start = when(ev.start);
  if (id === null || start === null) return null;
  const end = when(ev.end);
  const recurrence = Array.isArray(ev.recurrence) ? ev.recurrence.filter((r): r is string => typeof r === "string") : [];
  return {
    id: itemKey(calendarId, id),
    iCalUID: str(ev.iCalUID),
    title: str(ev.summary) ?? "",
    description: str(ev.description),
    location: str(ev.location),
    start: start.at,
    end: end?.at ?? null,
    allDay: start.allDay,
    status: status(ev.status),
    organizer: person(ev.organizer),
    attendees: attendees(ev.attendees),
    recurrence: recurrence.length > 0 ? recurrence : null,
    ...(occurrences ? { occurrences: occurrences.list, occurrencesTruncated: occurrences.truncated } : {}),
  };
}

class Adapter implements SyncAdapter {
  private readonly calendars: Map<string, string>;

  constructor(private readonly account: SyncAccount, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv) {
    this.calendars = new Map(selectedCalendars(account).map(id => [calendarStream(id), id]));
  }

  streams(): string[] {
    return (this.account.services ?? []).includes(GOOGLE_CALENDAR_SERVICE) ? [...this.calendars.keys()] : [];
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

  private occurrenceWindow(): Window {
    const past = this.retention() ?? MAX_HISTORY_DAYS;
    const now = this.now();
    return { timeMin: new Date(now - past * DAY_MS).toISOString(), timeMax: new Date(now + FORWARD_DAYS * DAY_MS).toISOString() };
  }

  /** A new full pass over the first-sync window. */
  private firstPass(): PassState {
    const timeMin = new Date(this.now() - this.historyDays() * DAY_MS).toISOString();
    return { v: 1, mode: "full", timeMin, token: null, pageToken: null, since: null };
  }

  /**
   * The relisting a 410 asks for: the whole retention window, so whatever it
   * does not touch is gone upstream. With retention off nothing bounds what is
   * stored, so nothing can be reconciled and the first-sync window is listed
   * again instead.
   */
  private relist(): PassState {
    const keep = this.retention();
    if (keep === null) return this.firstPass();
    const now = this.now();
    return { v: 1, mode: "full", timeMin: new Date(now - keep * DAY_MS).toISOString(), token: null, pageToken: null, since: new Date(now).toISOString() };
  }

  private listPath(calendarId: string, st: PassState): string {
    const q = new URLSearchParams({ maxResults: PAGE_SIZE, showDeleted: "true", singleEvents: "false" });
    if (st.mode === "full") q.set("timeMin", st.timeMin!);
    else q.set("syncToken", st.token!);
    if (st.pageToken !== null) q.set("pageToken", st.pageToken);
    return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`;
  }

  /** A selected calendar Google says is not there: one failing item, not a stopped run. */
  private calendarGone(calendarId: string): PageResult {
    const item: SyncItem = {
      externalId: `calendar:${calendarKey(calendarId)}`,
      version: null,
      failure: { code: "calendar_not_found", message: "the selected calendar was not found; it may have been deleted or unshared" },
    };
    return { ok: true, items: [item], deletions: [], checkpoint: null, done: true };
  }

  async page({ client, stream, cursor }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    const calendarId = this.calendars.get(stream);
    if (calendarId === undefined) throw new Error(`google calendar adapter has no stream ${stream}`);
    let st = parsePassCursor(cursor) ?? this.firstPass();
    let res = await client.get(this.listPath(calendarId, st));
    if (st.pageToken !== null && (res.status === 400 || res.status === 410)) {
      // A page token Google no longer takes: that pass starts over.
      st = { ...st, pageToken: null };
      res = await client.get(this.listPath(calendarId, st));
    }
    if (st.mode === "delta" && res.status === 410) {
      st = this.relist();
      res = await client.get(this.listPath(calendarId, st));
    }
    if (res.status === 404 && calendarId !== "primary") return this.calendarGone(calendarId);
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || (res.body.items !== undefined && !Array.isArray(res.body.items))) return invalid(res, "events");
    const events = ((res.body.items ?? []) as unknown[]).filter(isRecord);

    const items: SyncItem[] = [];
    const deletions = new Set<string>();
    const rendered = new Set<string>();
    const touchedSeries = new Set<string>();
    for (const ev of events) {
      const id = str(ev.id);
      if (id === null) continue;
      const seriesId = str(ev.recurringEventId);
      if (seriesId !== null) {
        touchedSeries.add(seriesId);
        continue;
      }
      if (ev.status === "cancelled") {
        deletions.add(itemKey(calendarId, id));
        continue;
      }
      if (typeof ev.eventType === "string" && SKIPPED_EVENT_TYPES.has(ev.eventType)) continue;
      if (Array.isArray(ev.recurrence) && ev.recurrence.length > 0) {
        rendered.add(id);
        const item = await this.seriesItem(client, calendarId, ev);
        if ("response" in item) return { ok: false, response: item.response };
        items.push(item);
        continue;
      }
      items.push(this.renderItem(calendarId, ev, typeof ev.etag === "string" ? ev.etag : null));
    }
    for (const seriesId of touchedSeries) {
      if (rendered.has(seriesId) || deletions.has(itemKey(calendarId, seriesId))) continue;
      const out = await this.reloadSeries(client, calendarId, seriesId);
      if (out === null) continue;
      if ("response" in out) return { ok: false, response: out.response };
      if ("deleted" in out) deletions.add(out.deleted);
      else items.push(out);
    }

    const nextPage = str(res.body.nextPageToken);
    if (nextPage !== null) {
      if (nextPage.length > MAX_CURSOR_FIELD) return invalid(res, "events (page token too long)");
      return { ok: true, items, deletions: [...deletions], checkpoint: JSON.stringify({ ...st, pageToken: nextPage }), done: false };
    }
    const syncToken = str(res.body.nextSyncToken);
    // Without it the next run could only read this last page again.
    if (syncToken === null || syncToken.startsWith("{")) return invalid(res, "events (no sync token on the last page)");
    const reconcile = st.mode === "full" && st.since !== null ? { prefix: `${calendarKey(calendarId)}:`, unseenSince: st.since } : null;
    return { ok: true, items, deletions: [...deletions], checkpoint: syncToken, done: true, ...(reconcile ? { reconcile } : {}) };
  }

  private renderItem(calendarId: string, ev: Json, version: string | null, occurrences?: { list: CalendarOccurrence[]; truncated: boolean }): SyncItem {
    const externalId = itemKey(calendarId, str(ev.id) ?? "");
    const event = normalizeGoogleEvent(calendarId, ev, occurrences);
    if (event === null) return { externalId, version, failure: { code: "invalid_event", message: "the event has no start" } };
    const ctx: ConnectorContext = { service: "google_calendar", accountLabel: this.account.accountLabel ?? "" };
    try {
      return syncItemFromPage(renderCalendarEvent(ctx, event), version, { enrich: true });
    } catch (e) {
      // The message can quote event text; only the error's kind is kept.
      return { externalId, version, failure: { code: "render_failed", message: `the event could not be rendered (${e instanceof Error ? e.name : "error"})` } };
    }
  }

  /** A series master rendered with its occurrences inside the window. */
  private async seriesItem(client: ConnectorClient, calendarId: string, master: Json): Promise<SyncItem | { response: ConnectorResponse }> {
    const id = str(master.id)!;
    const occ = await this.occurrences(client, calendarId, id);
    if ("response" in occ) {
      if (occ.response.class !== "forbidden") return occ;
      return { externalId: itemKey(calendarId, id), version: null, failure: { code: "instances_unavailable", message: occ.response.error ?? "instances unavailable" } };
    }
    const version = shortHash([typeof master.etag === "string" ? master.etag : "", ...occ.versions, occ.truncated ? "+" : ""].join("|"));
    return this.renderItem(calendarId, master, version, { list: occ.list, truncated: occ.truncated });
  }

  /** Fetch a series whose occurrence changed: its page again, or its deletion. */
  private async reloadSeries(
    client: ConnectorClient,
    calendarId: string,
    seriesId: string,
  ): Promise<SyncItem | { deleted: string } | { response: ConnectorResponse } | null> {
    const res = await client.get(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(seriesId)}`);
    if (res.status === 404 || res.status === 410) return { deleted: itemKey(calendarId, seriesId) };
    if (res.class !== "ok") {
      if (res.class !== "forbidden") return { response: res };
      return { externalId: itemKey(calendarId, seriesId), version: null, failure: { code: "series_unavailable", message: res.error ?? "series unavailable" } };
    }
    if (!isRecord(res.body)) return { response: { ...res, class: "challenge", body: null, error: "unexpected event response" } };
    if (res.body.status === "cancelled") return { deleted: itemKey(calendarId, seriesId) };
    if (typeof res.body.eventType === "string" && SKIPPED_EVENT_TYPES.has(res.body.eventType)) return null;
    return this.seriesItem(client, calendarId, res.body);
  }

  private async occurrences(
    client: ConnectorClient,
    calendarId: string,
    seriesId: string,
  ): Promise<{ list: CalendarOccurrence[]; versions: string[]; truncated: boolean } | { response: ConnectorResponse }> {
    const window = this.occurrenceWindow();
    const lo = Date.parse(window.timeMin);
    const hi = Date.parse(window.timeMax);
    const list: CalendarOccurrence[] = [];
    const versions: string[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_INSTANCE_PAGES; page++) {
      const q = new URLSearchParams({ timeMin: window.timeMin, timeMax: window.timeMax, maxResults: PAGE_SIZE });
      if (pageToken !== null) q.set("pageToken", pageToken);
      const res = await client.get(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(seriesId)}/instances?${q.toString()}`);
      if (res.class !== "ok") return { response: res };
      if (!isRecord(res.body) || (res.body.items !== undefined && !Array.isArray(res.body.items))) {
        return { response: { ...res, class: "challenge", body: null, error: "unexpected instances response" } };
      }
      for (const inst of ((res.body.items ?? []) as unknown[]).filter(isRecord)) {
        const start = when(inst.start);
        const s = start === null ? Number.NaN : Date.parse(start.at);
        // Google bounds the expansion already; this keeps the window ours whatever it sends.
        if (!Number.isFinite(s) || s < lo || s >= hi || inst.status === "cancelled") continue;
        if (list.length >= MAX_OCCURRENCES) return { list, versions, truncated: true };
        list.push({ start: start!.at, end: when(inst.end)?.at ?? null, status: status(inst.status) });
        versions.push(`${str(inst.id) ?? ""}@${typeof inst.etag === "string" ? inst.etag : ""}`);
      }
      pageToken = str(res.body.nextPageToken);
      if (pageToken === null) return { list, versions, truncated: false };
    }
    return { list, versions, truncated: true };
  }
}

export function googleCalendarAdapter(account: SyncAccount, opts: Partial<AdapterContext> = {}): SyncAdapter {
  return new Adapter(account, opts.now ?? Date.now, opts.env ?? process.env);
}

export interface GoogleCalendarEntry {
  id: string;
  /** The calendar's name as its owner set it: outside text, for display only. */
  summary: string;
  primary: boolean;
  accessRole: string;
}

/**
 * The calendars the account can read events of, primary first, for the owner
 * to pick from. Busy-only calendars carry no event details and are left out.
 */
export async function listGoogleCalendars(client: ConnectorClient): Promise<GoogleCalendarEntry[]> {
  const out: GoogleCalendarEntry[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = new URLSearchParams({ minAccessRole: "reader", maxResults: PAGE_SIZE });
    if (pageToken !== null) q.set("pageToken", pageToken);
    const res = await client.get(`/calendar/v3/users/me/calendarList?${q.toString()}`);
    if (res.class !== "ok") throw new Error(`calendar list failed: ${res.error ?? res.class}`);
    if (!isRecord(res.body)) throw new Error("calendar list failed: unexpected response");
    for (const c of (Array.isArray(res.body.items) ? res.body.items : []).filter(isRecord)) {
      const id = str(c.id);
      const role = str(c.accessRole);
      if (id === null || role === null || !READABLE_ROLES.has(role) || c.deleted === true) continue;
      out.push({ id, summary: (str(c.summary) ?? id).slice(0, 200), primary: c.primary === true, accessRole: role });
    }
    pageToken = str(res.body.nextPageToken);
    if (pageToken === null) break;
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}
