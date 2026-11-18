/**
 * The Teams meeting transcript adapter: transcripts of the signed-in user's
 * scheduled Teams meetings, one meeting page per transcript (the shared
 * meeting renderer, as Fireflies'), linked to the meeting's calendar event
 * page rather than writing a second one.
 *
 * Graph facts relied on (learn.microsoft.com/graph/api, v1.0, delegated,
 * work or school accounts only):
 *   - transcripts hang off an online meeting id, and the delegated way to the
 *     id is the meeting's join link: `GET /me/onlineMeetings?$filter=
 *     JoinWebUrl eq '<link, URL-encoded>'` (onlinemeeting-get,
 *     OnlineMeetings.Read). The links come from the calendar
 *     (`/me/calendarView`, Calendars.Read): the account-wide listing
 *     (getAllTranscripts) takes application permissions only;
 *   - `GET /me/onlineMeetings/{id}/transcripts` lists a meeting's transcripts
 *     and `.../transcripts/{tid}/content` returns one as WebVTT with
 *     `<v Speaker>` voice tags (onlinemeeting-list-transcripts,
 *     calltranscript-get, OnlineMeetingTranscript.Read.All, which needs an
 *     administrator's consent). It works for the organizer and for users on
 *     the meeting's calendar invite, until the meeting expires; a recurring
 *     meeting shares one join link and lists every occurrence's transcripts;
 *   - a tenant can turn Graph access to transcripts off: every request then
 *     answers 403 `GraphAccessToTranscriptsDisabled`, and no retry helps. It
 *     can also turn speaker attribution off: the WebVTT request answers 403
 *     `SpeakerAttributionNotAllowed`, and the same content without speakers
 *     is read with `Accept: application/vnd.microsoft.graph.transcript+text`.
 *
 * Each pass reads the calendar from the last scanned time less a 48-hour
 * lookback (a transcript is ready only after its meeting) to now, or from the
 * history floor on the first pass, one day per stream page; the cursor's
 * `pos` moves a day at a time, and `scannedTo` to the run's start once the
 * last day is through. A transcript belongs to the day it was started in,
 * and is found through the meetings that start in that day or the day
 * before (so a meeting that ran past midnight is covered); a transcript
 * started later than that after its meeting's start, by reusing an old join
 * link, is not found. Meeting ids and transcript lists are asked for once
 * per run. A day listing more events than MAX_EVENT_PAGES, or a meeting
 * listing more transcripts than MAX_TRANSCRIPT_PAGES, fails loudly instead of
 * being stored in part. A transcript without an `endDateTime` is still being
 * written and waits for a later run; one already stored at the same times,
 * or held by the engine, is not fetched again; one whose content has no cue
 * fails and is read again. A page cut by the item budget lists the same day
 * again.
 *
 * The meeting page's compiled truth names the calendar event page
 * (`calendar_event`, the slug the Outlook calendar adapter of the same
 * Microsoft account writes, keyed by the event's iCalUID, or its series
 * master's for an occurrence) and `event_dedupe_key`, and its body links it
 * with a wikilink. A tenant that turned transcripts off ends the run as
 * forbidden with that code; a meeting Graph will not show is one held item.
 *
 * Everything a transcript holds is outside text: meeting credentials are
 * removed from the title, every name and every line before the shared
 * renderer secret-scans and neutralizes it.
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { redactMeetingCredentials } from "../meeting-redact.ts";
import { renderMeeting, type RenderedConnectorPage } from "../render.ts";
import { retentionDays } from "../retention.ts";
import { syncItemFromPage } from "../sync-item.ts";
import { DELETION_STATES, getItem, settledItemVersions } from "../sync-store.ts";
import { accountRef, shortHash, type ConnectorContext, type MeetingSentence, type Person } from "../model.ts";
import type { Engine } from "../../engine/interface.ts";
import type { PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import type { AdapterContext } from "../providers.ts";
import { graphTime } from "./calendar.ts";
import { graphGet, graphInnerErrorCode, graphLinkPath } from "./graph-client.ts";
import { TEAMS_HISTORY_DAYS, TEAMS_MAX_HISTORY_DAYS } from "./teams-chat.ts";

/** The account service this adapter syncs. */
export const TEAMS_TRANSCRIPTS_SERVICE = "teams_transcripts";
export const TEAMS_TRANSCRIPTS_STREAM = "teams_transcripts";
export const TRANSCRIPTS_DISABLED = "GraphAccessToTranscriptsDisabled";
export const SPEAKERS_NOT_ALLOWED = "SpeakerAttributionNotAllowed";
export const UNATTRIBUTED_FORMAT = "application/vnd.microsoft.graph.transcript+text";

const LOOKBACK_MS = 48 * 3_600_000;
const DAY_MS = 86_400_000;
/** The calendar is read one slice of this length per stream page. */
const SLICE_MS = DAY_MS;
const PAGE_SIZE = 50;
/** Pages of one listing: two days of the calendar (a slice and the day before it), 1,000 events each. */
const MAX_EVENT_PAGES = 40;
const MAX_TRANSCRIPT_PAGES = 20;
/** A transcript body past this is not read: no meeting produces one. */
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const GRAPH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A turn longer than this starts a new line: the renderer keeps 4000 characters per line. */
const MAX_TURN_CHARS = 3_000;
const MAX_PARTICIPANTS = 200;
/** A transcript may start this long before its occurrence's scheduled start (a meeting opened early). */
const OCCURRENCE_SLACK_MS = 15 * 60_000;
const TEAMS_JOIN_RE = /^https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\//i;
const CALENDAR_SELECT = "id,iCalUId,subject,start,end,isAllDay,isCancelled,isOnlineMeeting,onlineMeeting,organizer,attendees,type,seriesMasterId";

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function timeMs(v: unknown): number {
  return typeof v === "string" && v.length <= 64 ? Date.parse(v) : Number.NaN;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** A name or title is outside text that lands on the page: its meeting credentials go too. */
function redacted(v: string): string {
  return redactMeetingCredentials(v).text.trim();
}

// ---------------------------------------------------------------------------
// WebVTT.

// Graph may write a cue before the transcript's zero point with a negative offset.
const CUE_TIME_RE = /^\s*-?(?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+/;
const VOICE_RE = /^<v(?:\.[^\s>]{0,40})?\s+([^>]{1,200})>/;
const TAG_RE = /<\/?[a-z][^<>]{0,200}>/gi;

/**
 * A WebVTT transcript as speaker turns: each cue's `<v Name>` voice tag names
 * its speaker, other inline tags go, and consecutive cues of one speaker join
 * into one turn up to MAX_TURN_CHARS. The unattributed format has the same
 * cues without voice tags and without the `WEBVTT` header, so cues are found
 * by their timing line alone. Linear in the text: line splits and bounded
 * patterns only.
 */
export function parseVtt(text: string): MeetingSentence[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: MeetingSentence[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CUE_TIME_RE.test(lines[i]!)) continue;
    const payload: string[] = [];
    for (i++; i < lines.length && lines[i]!.trim() !== ""; i++) payload.push(lines[i]!.trim());
    const joined = payload.join(" ");
    const voice = VOICE_RE.exec(joined);
    const speaker = voice ? voice[1]!.trim() : "";
    const said = joined.replace(TAG_RE, "").replace(/\s+/g, " ").trim();
    if (said === "") continue;
    const last = out.at(-1);
    if (last !== undefined && last.speaker === speaker && last.text.length + said.length < MAX_TURN_CHARS) {
      out[out.length - 1] = { speaker, text: `${last.text} ${said}` };
    } else {
      out.push({ speaker, text: said });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The calendar side: which meetings had a Teams join link, and their pages.

interface OnlineEvent {
  joinUrl: string;
  subject: string;
  start: number;
  end: number | null;
  /** The event's own iCalUID, or null when it is an occurrence (its series' is looked up). */
  iCalUID: string | null;
  seriesMasterId: string | null;
  people: Person[];
}

function person(v: unknown): Person | null {
  if (!isRecord(v) || !isRecord(v.emailAddress)) return null;
  const p = { name: str(v.emailAddress.name), email: str(v.emailAddress.address) };
  return p.name === null && p.email === null ? null : p;
}

function onlineEvent(ev: Json): OnlineEvent | null {
  if (ev.isCancelled === true) return null;
  const join = isRecord(ev.onlineMeeting) ? str(ev.onlineMeeting.joinUrl) : null;
  if (join === null || join.length > 2048 || !TEAMS_JOIN_RE.test(join)) return null;
  const allDay = ev.isAllDay === true;
  const start = Date.parse(graphTime(ev.start, allDay) ?? "");
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(graphTime(ev.end, allDay) ?? "");
  const occurrence = ev.type === "occurrence" || ev.type === "exception";
  const people = [person(ev.organizer), ...(Array.isArray(ev.attendees) ? ev.attendees.filter(a => !isRecord(a) || a.type !== "resource").map(person) : [])];
  return {
    joinUrl: join,
    subject: str(ev.subject) ?? "",
    start,
    end: Number.isFinite(end) ? end : null,
    iCalUID: occurrence ? null : str(ev.iCalUId),
    seriesMasterId: occurrence ? str(ev.seriesMasterId) : null,
    people: people.filter((p): p is Person => p !== null),
  };
}

/** The page the Outlook calendar adapter of this Microsoft account writes for an event (render.ts renderCalendarEvent). */
export function calendarEventSlug(accountLabel: string, iCalUID: string): string {
  return `calendar/${accountRef(accountLabel, "microsoft")}/${shortHash(`ical:${iCalUID}`)}`;
}

/** Name the calendar event page on the meeting page: in its truth, and as a wikilink under its heading. */
function linkCalendarEvent(page: RenderedConnectorPage, slug: string, iCalUID: string): RenderedConnectorPage {
  const lines = page.body.split("\n");
  const at = lines.findIndex(l => l.startsWith("Meeting · "));
  lines.splice(at + 1, 0, "", `Calendar event: [[${slug}]]`);
  return {
    ...page,
    body: lines.join("\n"),
    truth: { ...page.truth, calendar_event: slug, event_dedupe_key: shortHash(`ical:${iCalUID}`) },
  };
}

// ---------------------------------------------------------------------------
// The adapter.

/**
 * `scannedTo`: where the last whole pass ended (null before the first one).
 * `pos`: where the pass under way resumes, one day slice at a time; null
 * between passes.
 */
interface TranscriptState {
  v: 1;
  scannedTo: string | null;
  pos: string | null;
}

function parseCursor(cursor: string | null): TranscriptState | null {
  if (cursor === null || !cursor.startsWith("{")) return null;
  try {
    const raw = JSON.parse(cursor) as unknown;
    if (!isRecord(raw) || raw.v !== 1) return null;
    const scannedTo = raw.scannedTo ?? null;
    const pos = raw.pos ?? null;
    if (scannedTo !== null && !Number.isFinite(timeMs(scannedTo))) return null;
    if (pos !== null && !Number.isFinite(timeMs(pos))) return null;
    return { v: 1, scannedTo: scannedTo as string | null, pos: pos as string | null };
  } catch {
    return null;
  }
}

function configInt(account: SyncAccount, key: string, min: number, max: number): number | null {
  const v = account.config?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** Graph's answer when the tenant turned transcripts off: the run stops, saying so. */
function transcriptsDisabled(res: ConnectorResponse): ConnectorResponse {
  return {
    ...res,
    class: "forbidden",
    error: `Microsoft Graph refused meeting transcripts for the whole organization (${TRANSCRIPTS_DISABLED}): `
      + "a Teams administrator has to allow Graph API access to transcripts; see docs/connectors/MICROSOFT.md, Teams",
  };
}

function badBody(res: ConnectorResponse, what: string): ConnectorResponse {
  return { ...res, class: "challenge", body: null, error: `unexpected ${what} response` };
}

/** A meeting or transcript Graph will not show: one held item, so the other meetings go on. */
function unavailable(externalId: string, res: ConnectorResponse, what: string, version: string | null = null): SyncItem {
  return { externalId, version, failure: { code: `${what}_unavailable`, message: `Graph did not show the ${what} (HTTP ${res.status})`, holdNow: true } };
}

/** A response that ends the run (a rate limit, a server error, a lost credential), as opposed to one meeting's refusal. */
function endsRun(res: ConnectorResponse): boolean {
  return res.class !== "forbidden" || res.status === 0 || graphInnerErrorCode(res) === TRANSCRIPTS_DISABLED;
}

class TranscriptsAdapter implements SyncAdapter {
  /** Fixed once per run, so every page of a window asks the same question. */
  private readonly runAt: number;
  private readonly masters = new Map<string, string | null>();
  /** Per run: neighbouring days list the same meetings, which are asked about once. */
  private readonly meetingIds = new Map<string, { id: string | null }>();
  private readonly transcriptLists = new Map<string, { list: Transcript[]; truncated: boolean }>();

  constructor(
    private readonly account: SyncAccount,
    now: () => number,
    private readonly env: NodeJS.ProcessEnv,
    private readonly engine: Engine | undefined,
  ) {
    this.runAt = now();
  }

  streams(): string[] {
    return (this.account.services ?? []).includes(TEAMS_TRANSCRIPTS_SERVICE) ? [TEAMS_TRANSCRIPTS_STREAM] : [];
  }

  private floorMs(): number {
    const keep = retentionDays("meeting", configInt(this.account, "retention_days", 0, 100_000), this.env);
    const days = configInt(this.account, "history_days", 1, TEAMS_MAX_HISTORY_DAYS) ?? TEAMS_HISTORY_DAYS;
    return this.runAt - (keep === null ? days : Math.min(days, keep)) * DAY_MS;
  }

  async page({ client, cursor, budget }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    const st = parseCursor(cursor);
    const floor = this.floorMs();
    const start = st?.pos != null
      ? Math.max(floor, Date.parse(st.pos))
      : st?.scannedTo != null ? Math.max(floor, Date.parse(st.scannedTo) - LOOKBACK_MS) : floor;
    const passDone = { ok: true as const, items: [], checkpoint: JSON.stringify({ v: 1, scannedTo: new Date(this.runAt).toISOString(), pos: null }), done: true };
    if (start >= this.runAt) return passDone;
    // One day at a time, so no listing cap can step over a meeting. A
    // transcript belongs to the day it was started in; its meeting may have
    // begun the day before (a late meeting, a long one).
    const end = Math.min(start + SLICE_MS, this.runAt);
    const listed = await this.onlineEvents(client, start - DAY_MS, end);
    if ("response" in listed) return { ok: false, response: listed.response };

    const byLink = new Map<string, OnlineEvent[]>();
    for (const ev of listed) byLink.set(ev.joinUrl, [...(byLink.get(ev.joinUrl) ?? []), ev]);
    const room = budget?.remaining ?? Number.POSITIVE_INFINITY;
    const items: SyncItem[] = [];
    let cut = false;
    /** Room for one more item; false once the page is full. */
    const fits = (): boolean => {
      cut ||= items.length >= room;
      return !cut;
    };
    for (const [joinUrl, occurrences] of byLink) {
      if (cut) break;
      const meetingKey = `meeting:${shortHash(`tmeet:${joinUrl}`)}`;
      const meeting = await this.meetingId(client, joinUrl);
      if ("response" in meeting) {
        if (endsRun(meeting.response)) return { ok: false, response: meeting.response };
        if (!(await this.held(meetingKey, null)) && fits()) items.push(unavailable(meetingKey, meeting.response, "meeting"));
        continue;
      }
      if (meeting.id === null) continue;
      const transcripts = await this.transcripts(client, meeting.id);
      if ("response" in transcripts) {
        const res = transcripts.response;
        if (graphInnerErrorCode(res) === TRANSCRIPTS_DISABLED) return { ok: false, response: transcriptsDisabled(res) };
        if (endsRun(res)) return { ok: false, response: res };
        if (!(await this.held(meetingKey, null)) && fits()) items.push(unavailable(meetingKey, res, "meeting"));
        continue;
      }
      if (transcripts.truncated) {
        // Not stored in part: the item fails, and is held after repeated runs, rather than skip transcripts unseen.
        if (!(await this.held(meetingKey, null)) && fits()) {
          items.push({ externalId: meetingKey, version: null, failure: { code: "transcript_list_truncated", message: `the meeting lists more than ${MAX_TRANSCRIPT_PAGES} pages of transcripts` } });
        }
        continue;
      }
      // A recurring meeting lists every occurrence's transcripts: only those started in this day are due here.
      const due = transcripts.list.filter(t => t.created >= start && t.created < end && t.created >= floor);
      const settled = this.engine === undefined ? new Map<string, string>()
        : await settledItemVersions(this.engine, this.account.id, due.map(t => t.externalId));
      for (const t of due) {
        if (settled.get(t.externalId) === t.version || await this.held(t.externalId, t.version)) continue;
        if (!fits()) break;
        const item = await this.transcriptItem(client, meeting.id, t, occurrenceOf(t, occurrences));
        if ("response" in item) return { ok: false, response: item.response };
        items.push(item);
      }
    }
    // Cut by the budget: the same slice is listed again, and what was stored is skipped.
    if (cut) return { ok: true, items, checkpoint: null, done: false };
    if (end >= this.runAt) return { ...passDone, items };
    return { ok: true, items, checkpoint: JSON.stringify({ v: 1, scannedTo: st?.scannedTo ?? null, pos: new Date(end).toISOString() }), done: false };
  }

  /**
   * The calendar's Teams meetings that start in [from, to), by start. A
   * listing longer than MAX_EVENT_PAGES ends the run instead of skipping the
   * rest of the slice.
   */
  private async onlineEvents(client: ConnectorClient, from: number, to: number): Promise<OnlineEvent[] | { response: ConnectorResponse }> {
    const q = `startDateTime=${enc(new Date(from).toISOString())}&endDateTime=${enc(new Date(to).toISOString())}`;
    let path: string | null = `/v1.0/me/calendarView?${q}&$select=${CALENDAR_SELECT}&$top=${PAGE_SIZE}`;
    const out: OnlineEvent[] = [];
    for (let p = 0; path !== null; p++) {
      const res = await graphGet(client, path, { prefer: `outlook.timezone="UTC", odata.maxpagesize=${PAGE_SIZE}`, maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") {
        if (res.class !== "forbidden") return { response: res };
        return {
          response: {
            ...res,
            error: `Microsoft Graph refused the calendar (HTTP ${res.status}): Teams transcripts find meetings through it and need `
              + "the delegated permission Calendars.Read; see docs/connectors/MICROSOFT.md, Teams",
          },
        };
      }
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: badBody(res, "calendar view") };
      for (const ev of (res.body.value as unknown[]).filter(isRecord)) {
        const o = onlineEvent(ev);
        // The view also returns meetings that began before `from`; they are not this listing's.
        if (o !== null && o.start >= from && o.start < to) out.push(o);
      }
      const next = res.body["@odata.nextLink"];
      path = next === undefined ? null : graphLinkPath(next);
      if (next !== undefined && path === null) return { response: badBody(res, "calendar view next link") };
      if (path !== null && p + 1 >= MAX_EVENT_PAGES) {
        return { response: { ...res, class: "challenge", body: null, error: `the calendar lists more than ${MAX_EVENT_PAGES * PAGE_SIZE} events in two days` } };
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /**
   * Whether the engine holds this item at this version for now: it would skip
   * it, and still count it against the run's items, so it is not sent again.
   */
  private async held(externalId: string, version: string | null): Promise<boolean> {
    if (this.engine === undefined) return false;
    const row = await getItem(this.engine, this.account.id, externalId);
    return row !== null && row.external_version === version && row.held_reason !== null && !DELETION_STATES.includes(row.held_reason)
      && row.held_until !== null && row.held_until.getTime() > this.runAt;
  }

  private async meetingId(client: ConnectorClient, joinUrl: string): Promise<{ id: string | null } | { response: ConnectorResponse }> {
    const known = this.meetingIds.get(joinUrl);
    if (known !== undefined) return known;
    const found = await this.lookUpMeeting(client, joinUrl);
    if (!("response" in found)) this.meetingIds.set(joinUrl, found);
    return found;
  }

  private async lookUpMeeting(client: ConnectorClient, joinUrl: string): Promise<{ id: string | null } | { response: ConnectorResponse }> {
    // The link itself goes URL-encoded inside the OData literal (onlinemeeting-get), a quote included.
    const literal = enc(joinUrl).replace(/'/g, "%27");
    const res = await graphGet(client, `/v1.0/me/onlineMeetings?$filter=${enc(`JoinWebUrl eq '${literal}'`)}`, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
    // A meeting of another organization, or one Graph no longer has: nothing to read.
    if (res.status === 404) return { id: null };
    if (res.class !== "ok") return { response: res };
    if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: badBody(res, "online meeting") };
    const first = (res.body.value as unknown[]).find(isRecord);
    const id = first === undefined ? null : str(first.id);
    return { id: id !== null && id.length <= 1024 ? id : null };
  }

  private async transcripts(client: ConnectorClient, meetingId: string): Promise<{ list: Transcript[]; truncated: boolean } | { response: ConnectorResponse }> {
    const known = this.transcriptLists.get(meetingId);
    if (known !== undefined) return known;
    const listed = await this.listTranscripts(client, meetingId);
    if (!("response" in listed)) this.transcriptLists.set(meetingId, listed);
    return listed;
  }

  private async listTranscripts(client: ConnectorClient, meetingId: string): Promise<{ list: Transcript[]; truncated: boolean } | { response: ConnectorResponse }> {
    let path: string | null = `/v1.0/me/onlineMeetings/${enc(meetingId)}/transcripts`;
    const list: Transcript[] = [];
    for (let p = 0; path !== null; p++) {
      if (p >= MAX_TRANSCRIPT_PAGES) return { list, truncated: true };
      const res = await graphGet(client, path, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") return { response: res };
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: badBody(res, "transcript list") };
      for (const t of (res.body.value as unknown[]).filter(isRecord)) {
        const id = str(t.id);
        const created = timeMs(t.createdDateTime);
        const end = timeMs(t.endDateTime);
        // Still being written: a later run reads it whole.
        if (id === null || id.length > 1024 || !Number.isFinite(created) || !Number.isFinite(end)) continue;
        list.push({ id, created, end, externalId: `transcript:${shortHash(`${meetingId}:${id}`)}`, version: `${new Date(created).toISOString()}|${new Date(end).toISOString()}` });
      }
      const next = res.body["@odata.nextLink"];
      path = next === undefined ? null : graphLinkPath(next);
      if (next !== undefined && path === null) return { response: badBody(res, "transcript list next link") };
    }
    return { list, truncated: false };
  }

  /** The WebVTT text, read without speakers when the tenant keeps them out. */
  private async content(client: ConnectorClient, meetingId: string, transcriptId: string): Promise<{ text: string } | { response: ConnectorResponse }> {
    const base = `/v1.0/me/onlineMeetings/${enc(meetingId)}/transcripts/${enc(transcriptId)}/content`;
    let res = await graphGet(client, `${base}?$format=${enc("text/vtt")}`, { text: true, maxBytes: MAX_CONTENT_BYTES });
    if (res.class === "forbidden" && graphInnerErrorCode(res) === SPEAKERS_NOT_ALLOWED) {
      res = await graphGet(client, base, { text: true, accept: UNATTRIBUTED_FORMAT, maxBytes: MAX_CONTENT_BYTES });
    }
    if (res.class !== "ok" || typeof res.body !== "string") return { response: res.class === "ok" ? badBody(res, "transcript content") : res };
    return { text: res.body };
  }

  /**
   * The iCalUID the calendar page of an event is keyed by: its own, or its
   * series master's. A master Graph does not have (404, 403) has none; any
   * other failure ends the run, so a transcript is never stored without the
   * link only a passing outage kept from it.
   */
  private async eventICalUID(client: ConnectorClient, ev: OnlineEvent): Promise<{ uid: string | null } | { response: ConnectorResponse }> {
    if (ev.iCalUID !== null) return { uid: ev.iCalUID };
    if (ev.seriesMasterId === null) return { uid: null };
    const known = this.masters.get(ev.seriesMasterId);
    if (known !== undefined) return { uid: known };
    const res = await graphGet(client, `/v1.0/me/events/${enc(ev.seriesMasterId)}?$select=iCalUId`, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
    if (res.class !== "ok" && endsRun(res)) return { response: res };
    const uid = res.class === "ok" && isRecord(res.body) ? str(res.body.iCalUId) : null;
    this.masters.set(ev.seriesMasterId, uid);
    return { uid };
  }

  private async transcriptItem(client: ConnectorClient, meetingId: string, t: Transcript, ev: OnlineEvent): Promise<SyncItem | { response: ConnectorResponse }> {
    const got = await this.content(client, meetingId, t.id);
    if ("response" in got) {
      const res = got.response;
      if (graphInnerErrorCode(res) === TRANSCRIPTS_DISABLED) return { response: transcriptsDisabled(res) };
      if (endsRun(res)) return { response: res };
      // At the transcript's own version, so the held check before the next fetch matches it.
      return unavailable(t.externalId, res, "transcript", t.version);
    }
    const linked = await this.eventICalUID(client, ev);
    if ("response" in linked) return linked;
    const sentences = parseVtt(got.text).map(s => ({ speaker: redacted(s.speaker), text: redactMeetingCredentials(s.text).text }));
    if (sentences.length === 0 && got.text.trim() !== "") {
      // Not settled on an empty page: the next run reads it again, and repeated failures hold it.
      return { externalId: t.externalId, version: t.version, failure: { code: "invalid_transcript", message: "the transcript content has no cue this reader understands" } };
    }
    const speakers = [...new Set(sentences.map(s => s.speaker).filter(s => s !== ""))];
    const people = ev.people.map(p => ({ name: p.name === null ? null : redacted(p.name), email: p.email }));
    const named = new Set(people.map(p => (p.name ?? "").trim().toLowerCase()));
    const participants = [...people, ...speakers.filter(s => !named.has(s.toLowerCase())).map(name => ({ name, email: null }))].slice(0, MAX_PARTICIPANTS);
    const label = this.account.accountLabel ?? "";
    const ctx: ConnectorContext = { service: TEAMS_TRANSCRIPTS_SERVICE, accountLabel: label };
    const start = Math.abs(t.created - ev.start) < DAY_MS ? ev.start : t.created;
    try {
      let page = renderMeeting(ctx, {
        id: t.externalId,
        title: redactMeetingCredentials(ev.subject).text,
        start: new Date(start).toISOString(),
        end: new Date(t.end).toISOString(),
        participants,
        summary: null,
        actionItems: [],
        sentences,
      });
      if (linked.uid !== null) page = linkCalendarEvent(page, calendarEventSlug(label, linked.uid), linked.uid);
      return syncItemFromPage(page, t.version, { enrich: true });
    } catch (e) {
      // The message can quote transcript text; only the error's kind is kept.
      return { externalId: t.externalId, version: t.version, failure: { code: "render_failed", message: `the transcript could not be rendered (${e instanceof Error ? e.name : "error"})` } };
    }
  }
}

interface Transcript {
  id: string;
  created: number;
  end: number;
  externalId: string;
  version: string;
}

/**
 * The occurrence a transcript was made in: the latest one of `occurrences`
 * (sorted by start, never empty) that had begun, give or take
 * OCCURRENCE_SLACK_MS, when the transcript started; else the first.
 */
function occurrenceOf(t: Transcript, occurrences: readonly OnlineEvent[]): OnlineEvent {
  for (let i = occurrences.length - 1; i >= 0; i--) {
    if (occurrences[i]!.start - OCCURRENCE_SLACK_MS <= t.created) return occurrences[i]!;
  }
  return occurrences[0]!;
}

export function teamsTranscriptsAdapter(account: SyncAccount, opts: Partial<AdapterContext> = {}): SyncAdapter {
  return new TranscriptsAdapter(account, opts.now ?? Date.now, opts.env ?? process.env, opts.engine);
}
