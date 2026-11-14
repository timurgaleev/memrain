/**
 * Fireflies: meeting transcripts read through the Fireflies GraphQL API with
 * the owner's API key, rendered as meeting pages.
 *
 * Provider facts this module relies on (docs.fireflies.ai, read 2026-11-14):
 *   - one endpoint, POST https://api.fireflies.ai/graphql, the key sent as
 *     `Authorization: Bearer <key>` (fundamentals/authorization);
 *   - errors come back in an `errors` array, each with a `code` and
 *     `extensions.status`, often inside an HTTP 200 (fundamentals/errors,
 *     miscellaneous/error-codes); a bad key is `auth_failed`;
 *   - `transcripts(fromDate, toDate, limit, skip)` filters on creation time,
 *     at most 50 per call, paged by `skip` (graphql-api/query/transcripts);
 *     `transcript(id)` answers `object_not_found` for a transcript that is
 *     gone or no longer shared with the key's owner;
 *   - `date` is epoch milliseconds, `duration` minutes, `summary.action_items`
 *     and `keywords` single strings, `topics_discussed` a list, a sentence's
 *     `start_time` a string (schema/transcript, schema/summary, schema/sentence);
 *   - the key error is not on the error-codes page; it is answered as
 *     `auth_failed`, with a 200, 401 or 500 status, so all three are read;
 *   - `user` without an id describes the key's owner (graphql-api/query/user);
 *   - limits are per key: 30 requests a minute and 500 a day on the free plan
 *     (Pro 60 and 5,000; Business and Enterprise no daily cap), the daily count
 *     resetting at 00:00 UTC; a refusal is HTTP 429 with Retry-After
 *     (fundamentals/limits).
 *
 * The key is read-only by nature (Fireflies has no scoped keys); this module
 * only ever sends queries, never a mutation.
 *
 * Everything a transcript holds is outside text from whoever spoke in the
 * meeting. It is rendered by the shared meeting renderer (untrusted frame,
 * secret scan, neutralized) and never acted on.
 */
import { createHash } from "node:crypto";
import type { ConnectorClient, ConnectorResponse, FetchFn } from "./client.ts";
import type { Engine } from "../engine/interface.ts";
import type { MeetingSentence, MeetingTranscript, Person } from "./model.ts";
import type { ApiKeyProvider } from "./providers.ts";
import { renderMeeting } from "./render.ts";
import type { PageResult, SyncAccount, SyncAdapter, SyncItem } from "./sync-engine.ts";
import { syncItemFromPage } from "./sync-item.ts";
import { liveItemIds, settledItemVersions } from "./sync-store.ts";
import type { ResponseClass } from "./types.ts";

export const FIREFLIES_PROVIDER_ID = "fireflies";
export const FIREFLIES_SERVICE = "fireflies";
export const FIREFLIES_API_ORIGIN = "https://api.fireflies.ai";
export const FIREFLIES_GRAPHQL_PATH = "/graphql";

/** 30 a minute on the free plan, so one request every two seconds fits every plan. */
export const FIREFLIES_MIN_SPACING_MS = 2_000;
/** The free plan's daily allowance; a paid plan has more, and a refusal is still handled as a rate limit. */
export const FIREFLIES_DAILY_QUOTA = 500;

/** Transcripts listed per call; well under the provider's 50, so one page of fetches stays short. */
export const LIST_PAGE_SIZE = 25;
/** Ids listed per call when reconciling deletions: the provider's maximum. */
export const ID_PAGE_SIZE = 50;
/** First sync reads this far back. */
export const BACKFILL_DAYS = 90;
/**
 * Each incremental run re-lists this window before its cursor: a transcript is
 * created at the meeting's time but processed (and summarized) later, so a
 * pure created-after cursor would step over it.
 */
export const LOOKBACK_MS = 48 * 60 * 60_000;
/** Deletions are reconciled at most this often; listing every id costs requests. */
export const RECONCILE_EVERY_MS = 24 * 60 * 60_000;
/** Transcripts probed for deletion per run; the rest wait for the next reconcile. */
export const MAX_DELETE_PROBES = 50;
/** A turn longer than this starts a new one: the renderer keeps 4000 characters per line. */
export const MAX_TURN_CHARS = 3_000;

const MAX_PARTICIPANTS = 200;
const MAX_ACTION_ITEMS = 200;
const VERIFY_TIMEOUT_MS = 15_000;
const MAX_VERIFY_BODY = 64 * 1024;
const CODE_RE = /^[a-z_]{1,64}$/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+$/;
const UNNAMED_SPEAKER_RE = /^speaker(?: \d{1,4})?$/i;

export const STREAM_TRANSCRIPTS = "transcripts";
export const STREAM_RECONCILE = "transcripts.reconcile";

const USER_QUERY = "query FirefliesUser { user { email name } }";
const LIST_QUERY = `query FirefliesTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
    id title date duration organizer_email participants meeting_info { summary_status }
  }
}`;
const IDS_QUERY = `query FirefliesTranscriptIds($limit: Int, $skip: Int) {
  transcripts(limit: $limit, skip: $skip) { id }
}`;
const TRANSCRIPT_QUERY = `query FirefliesTranscript($id: String!) {
  transcript(id: $id) {
    id title date dateString duration organizer_email participants
    meeting_attendees { displayName email name }
    speakers { id name }
    sentences { index speaker_name text raw_text start_time }
    summary { overview short_summary action_items keywords topics_discussed }
    meeting_info { summary_status }
  }
}`;
const EXISTS_QUERY = `query FirefliesTranscriptExists($id: String!) { transcript(id: $id) { id } }`;

// ---------------------------------------------------------------------------
// GraphQL over the connector client.

export type GraphqlResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: ConnectorResponse; code: string | null };

const AUTH_CODES = new Set(["auth_failed", "unauthenticated", "unauthorized", "invalid_api_key"]);
const FORBIDDEN_CODES = new Set([
  "forbidden", "paid_required", "not_in_team", "require_elevated_privilege", "account_cancelled", "feature_disabled",
]);

interface GraphqlError {
  code: string | null;
  status: number | null;
}

function firstError(body: unknown): GraphqlError | null {
  if (body === null || typeof body !== "object") return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const e = errors[0] as { code?: unknown; extensions?: { code?: unknown; status?: unknown } } | null;
  const raw = e?.code ?? e?.extensions?.code;
  const status = Number(e?.extensions?.status);
  return {
    code: typeof raw === "string" && CODE_RE.test(raw) ? raw : null,
    status: Number.isInteger(status) ? status : null,
  };
}

function classOf(err: GraphqlError): { class: ResponseClass; reauth?: true } {
  if ((err.code !== null && AUTH_CODES.has(err.code)) || err.status === 401) return { class: "auth_required", reauth: true };
  if (err.code === "too_many_requests" || err.status === 429) return { class: "rate_limited" };
  if ((err.code !== null && FORBIDDEN_CODES.has(err.code)) || err.status === 403) return { class: "forbidden" };
  // object_not_found is the caller's to read; invalid arguments, timeouts and
  // internal errors may pass on the next run.
  return { class: "server_error" };
}

function failure(err: GraphqlError, status: number): GraphqlResult<never> {
  const cls = classOf(err);
  return {
    ok: false,
    code: err.code,
    response: {
      class: cls.class,
      status,
      body: null,
      next: null,
      // Built from the code only: provider messages can quote meeting text.
      error: `Fireflies error ${err.code ?? "unrecognised"} (${cls.class})`,
      ...(cls.reauth ? { reauth: true } : {}),
    },
  };
}

/** Run one GraphQL query; errors in a 200 body are classified like HTTP failures. */
export async function firefliesQuery<T>(client: ConnectorClient, query: string, variables: Record<string, unknown>): Promise<GraphqlResult<T>> {
  const res = await client.post(FIREFLIES_GRAPHQL_PATH, { query, variables });
  if (res.class !== "ok") {
    // A refusal the client could not renew its way past already says reconnect.
    if (res.reauth) return { ok: false, response: res, code: null };
    const err = firstError(res.errorBody);
    if (err !== null && classOf(err).class === "auth_required") return failure(err, res.status);
    return { ok: false, response: res, code: err?.code ?? null };
  }
  const err = firstError(res.body);
  if (err !== null) return failure(err, res.status);
  const data = (res.body as { data?: unknown } | null)?.data;
  if (data === null || data === undefined || typeof data !== "object") {
    return { ok: false, code: null, response: { class: "server_error", status: res.status, body: null, next: null, error: "Fireflies answer has no data" } };
  }
  return { ok: true, data: data as T };
}

// ---------------------------------------------------------------------------
// The key check when the owner saves a key.

export type FirefliesKeyErrorCode = "key_rejected" | "provider_unavailable" | "identity";

export class FirefliesKeyError extends Error {
  constructor(readonly code: FirefliesKeyErrorCode) {
    super({
      key_rejected: "Fireflies refused the API key",
      provider_unavailable: "Fireflies could not be reached to check the API key; try again",
      identity: "Fireflies did not say which account the API key belongs to",
    }[code]);
    this.name = "FirefliesKeyError";
  }
}

/** Ask Fireflies who owns `apiKey`; the owner's email becomes the account label. */
export async function verifyFirefliesKey(ctx: { fetch: FetchFn; apiKey: string }): Promise<string> {
  let res: Response;
  let text: string;
  try {
    res = await ctx.fetch(`${FIREFLIES_API_ORIGIN}${FIREFLIES_GRAPHQL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${ctx.apiKey}` },
      body: JSON.stringify({ query: USER_QUERY, variables: {} }),
      redirect: "manual",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new FirefliesKeyError("provider_unavailable");
  }
  let body: unknown = null;
  if (text.length <= MAX_VERIFY_BODY) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  const err = firstError(body);
  if (res.status === 401 || (err !== null && classOf(err).class === "auth_required")) throw new FirefliesKeyError("key_rejected");
  if (!res.ok || err !== null) throw new FirefliesKeyError(res.status === 403 || err?.status === 403 ? "key_rejected" : "provider_unavailable");
  const email = (body as { data?: { user?: { email?: unknown } } } | null)?.data?.user?.email;
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim()) || email.length > 320) throw new FirefliesKeyError("identity");
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Normalizing a transcript.

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function email(v: unknown): string | null {
  const s = str(v);
  return s !== null && s.length <= 320 && EMAIL_RE.test(s) ? s.toLowerCase() : null;
}

function startOf(t: Raw): string {
  const fromString = typeof t.dateString === "string" ? Date.parse(t.dateString) : Number.NaN;
  const fromEpoch = typeof t.date === "number" ? t.date : typeof t.date === "string" ? Number(t.date) : Number.NaN;
  const at = Number.isFinite(fromString) ? fromString : fromEpoch;
  if (!Number.isFinite(at) || at <= 0) throw new Error("Fireflies transcript has no usable date");
  return new Date(at).toISOString();
}

function clock(seconds: unknown): string | null {
  // The schema types start_time as a String of seconds; answers also carry a number.
  const s = typeof seconds === "number" ? seconds : typeof seconds === "string" && seconds.trim() !== "" ? Number(seconds) : Number.NaN;
  if (!Number.isFinite(s) || s < 0) return null;
  const total = Math.floor(s);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Consecutive sentences of one speaker as one turn, labelled with when it began. */
function turns(sentences: unknown): MeetingSentence[] {
  if (!Array.isArray(sentences)) return [];
  const rows = sentences
    .filter((s): s is Raw => s !== null && typeof s === "object")
    .map((s, i) => ({ s, i, index: typeof s.index === "number" ? s.index : i }))
    .sort((a, b) => a.index - b.index || a.i - b.i);
  const out: MeetingSentence[] = [];
  let speaker = "";
  let at: string | null = null;
  let text = "";
  const flush = () => {
    if (text !== "") out.push({ speaker: at === null ? speaker : `${speaker} (${at})`, text });
    text = "";
  };
  for (const { s } of rows) {
    const line = str(s.text) ?? str(s.raw_text);
    if (line === null) continue;
    const who = str(s.speaker_name) ?? "Speaker";
    if (who !== speaker) {
      flush();
      speaker = who;
      at = clock(s.start_time);
    }
    // A turn that would outgrow the limit continues as a new turn; a single
    // sentence past it is cut into pieces.
    for (let i = 0; i < line.length; i += MAX_TURN_CHARS) {
      const piece = line.slice(i, i + MAX_TURN_CHARS);
      if (text !== "" && text.length + 1 + piece.length > MAX_TURN_CHARS) {
        flush();
        at = clock(s.start_time);
      }
      text = text === "" ? piece : `${text} ${piece}`;
    }
  }
  flush();
  return out;
}

function participants(t: Raw): Person[] {
  const out: Person[] = [];
  const byEmail = new Set<string>();
  const byName = new Set<string>();
  const add = (name: string | null, mail: string | null) => {
    if (out.length >= MAX_PARTICIPANTS) return;
    if (mail !== null) {
      if (byEmail.has(mail)) return;
      byEmail.add(mail);
    } else {
      if (name === null || byName.has(name.toLowerCase())) return;
    }
    if (name !== null) byName.add(name.toLowerCase());
    out.push({ name, email: mail });
  };
  for (const a of Array.isArray(t.meeting_attendees) ? t.meeting_attendees : []) {
    if (a === null || typeof a !== "object") continue;
    const r = a as Raw;
    add(str(r.displayName) ?? str(r.name), email(r.email));
  }
  // Fireflies sometimes joins several addresses into one entry.
  for (const p of Array.isArray(t.participants) ? t.participants : []) {
    if (typeof p !== "string") continue;
    for (const part of p.split(/[,;]/)) {
      const mail = email(part);
      if (mail !== null) add(null, mail);
    }
  }
  const organizer = email(t.organizer_email);
  if (organizer !== null) add(null, organizer);
  for (const s of Array.isArray(t.speakers) ? t.speakers : []) {
    if (s === null || typeof s !== "object") continue;
    const name = str((s as Raw).name);
    // "Speaker 2" names nobody; as a participant it would only seed a wanted people/ entry.
    if (name !== null && !UNNAMED_SPEAKER_RE.test(name)) add(name, null);
  }
  return out;
}

function listText(v: unknown): string | null {
  if (Array.isArray(v)) {
    const items = v.map(str).filter((x): x is string => x !== null);
    return items.length ? items.join(", ") : null;
  }
  return str(v);
}

function summaryOf(raw: unknown): { summary: string | null; actionItems: string[] } {
  if (raw === null || typeof raw !== "object") return { summary: null, actionItems: [] };
  const s = raw as Raw;
  const parts: string[] = [];
  const overview = str(s.overview) ?? str(s.short_summary);
  if (overview) parts.push(overview);
  const topics = listText(s.topics_discussed);
  if (topics) parts.push(`Topics: ${topics}`);
  const keywords = listText(s.keywords);
  if (keywords) parts.push(`Keywords: ${keywords}`);
  const actionItems: string[] = [];
  const items = Array.isArray(s.action_items) ? s.action_items.join("\n") : (str(s.action_items) ?? "");
  for (const line of items.split(/\r?\n/)) {
    let item = line.trim().replace(/^[-*•]\s+/, "").trim();
    const bold = /^\*\*(.+)\*\*$/.exec(item);
    if (bold) item = `${bold[1]!.trim()}:`;
    if (item !== "" && actionItems.length < MAX_ACTION_ITEMS) actionItems.push(item);
  }
  return { summary: parts.length ? parts.join("\n\n") : null, actionItems };
}

/** A Fireflies `transcript` object as the shared meeting shape. Throws when it has no id or date. */
export function normalizeTranscript(raw: unknown): MeetingTranscript {
  if (raw === null || typeof raw !== "object") throw new Error("Fireflies transcript is not an object");
  const t = raw as Raw;
  const id = str(t.id);
  if (id === null || id.length > 200) throw new Error("Fireflies transcript has no id");
  const start = startOf(t);
  const minutes = typeof t.duration === "number" ? t.duration : Number.NaN;
  const end = Number.isFinite(minutes) && minutes > 0 ? new Date(Date.parse(start) + Math.round(minutes * 60_000)).toISOString() : null;
  const { summary, actionItems } = summaryOf(t.summary);
  return {
    id,
    title: str(t.title) ?? "",
    start,
    end,
    participants: participants(t),
    summary,
    actionItems,
    sentences: turns(t.sentences),
  };
}

/**
 * What a listing says about a transcript, hashed. Fireflies has no update
 * time, so a change of title, time, length, people or summary status is what
 * tells a run to fetch the transcript again; the summary arriving after the
 * meeting moves the status.
 */
export function transcriptVersion(listed: Raw, refreshDay: number | null = null): string {
  const people = Array.isArray(listed.participants) ? listed.participants.filter((p): p is string => typeof p === "string").sort() : [];
  const status = (listed.meeting_info as Raw | null | undefined)?.summary_status;
  const fields = [listed.title ?? null, listed.date ?? null, listed.duration ?? null, listed.organizer_email ?? null, people, status ?? null];
  const basis = JSON.stringify(refreshDay === null ? fields : [...fields, refreshDay]);
  return createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The sync adapter.

interface ListedTranscript extends Raw {
  id: string;
}

function timeOf(value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * The reconcile cursor: the time of the last complete reconcile, or, while a
 * cycle has more unlisted transcripts than one run may probe, that time plus
 * the last id probed (`{"at":…,"probe_after":…}`), which keeps it due.
 */
function reconcileState(cursor: string | null): { at: number | null; probeAfter: string | null } {
  if (cursor === null) return { at: null, probeAfter: null };
  if (!cursor.startsWith("{")) return { at: timeOf(cursor), probeAfter: null };
  try {
    const v = JSON.parse(cursor) as { at?: unknown; probe_after?: unknown };
    return {
      at: typeof v.at === "string" ? timeOf(v.at) : null,
      probeAfter: typeof v.probe_after === "string" && v.probe_after !== "" ? v.probe_after : null,
    };
  } catch {
    return { at: null, probeAfter: null };
  }
}

function rowsOf(data: { transcripts?: unknown }): unknown[] {
  return Array.isArray(data.transcripts) ? data.transcripts : [];
}

function idOf(row: unknown): string | null {
  const id = row !== null && typeof row === "object" ? (row as Raw).id : null;
  return typeof id === "string" && id !== "" && id.length <= 200 ? id : null;
}

/**
 * Two streams per account:
 *
 *   - `transcripts`: the listing over a creation-date window, fetching only
 *     the transcripts whose listed version is not already stored. The window
 *     starts BACKFILL_DAYS back on the first run and LOOKBACK_MS before the
 *     cursor afterwards, and ends when the run started; the cursor moves to
 *     that end only once every page of the window is settled.
 *   - `transcripts.reconcile`: at most once per RECONCILE_EVERY_MS, every id
 *     the key can see is listed; a stored transcript missing from that list
 *     is probed by id, and only an `object_not_found` answer reports it
 *     deleted. A listing that merely misses an item deletes nothing, and the
 *     engine's mass-delete guard holds a large batch for the owner.
 */
export function firefliesAdapter(account: SyncAccount, ctx: { engine: Engine; now: () => number }): SyncAdapter {
  if (!account.accountLabel) throw new Error(`Fireflies account ${account.id} has no label`);
  const render = { service: "fireflies", accountLabel: account.accountLabel } as const;
  // Fixed once per run, so every page of a window asks the same question.
  const runAt = ctx.now();
  const seenIds = new Set<string>();

  /**
   * The listing says nothing about an edited sentence or summary. While a
   * transcript is young enough to sit in the lookback window, the UTC day joins
   * its version, so it is read again once a day; after that only a listed
   * field changing brings it back.
   */
  const refreshDayOf = (t: Raw): number | null => {
    const created = typeof t.date === "number" ? t.date : Number.NaN;
    return Number.isFinite(created) && runAt - created < LOOKBACK_MS ? Math.floor(runAt / 86_400_000) : null;
  };

  /** The item to store, null when the transcript is gone, or the response that ends the stream. */
  async function fetchItem(client: ConnectorClient, id: string, version: string): Promise<SyncItem | ConnectorResponse | null> {
    const got = await firefliesQuery<{ transcript: unknown }>(client, TRANSCRIPT_QUERY, { id });
    if (!got.ok) {
      // Gone between the listing and the fetch: the reconcile decides that.
      if (got.code === "object_not_found") return null;
      const cls = got.response.class;
      if (cls === "auth_required" || cls === "forbidden" || cls === "rate_limited") return got.response;
      return { externalId: id, version, failure: { code: got.code ?? cls, message: got.response.error ?? "Fireflies fetch failed" } };
    }
    try {
      const meeting = normalizeTranscript(got.data.transcript);
      if (meeting.id !== id) throw new Error("Fireflies answered with another transcript");
      return syncItemFromPage(renderMeeting(render, meeting), version, { enrich: true });
    } catch (e) {
      return { externalId: id, version, failure: { code: "invalid_transcript", message: e instanceof Error ? e.message : "unreadable transcript" } };
    }
  }

  async function transcriptsPage(client: ConnectorClient, cursor: string | null, page: number): Promise<PageResult> {
    const since = timeOf(cursor);
    const fromDate = new Date(since === null ? runAt - BACKFILL_DAYS * 86_400_000 : since - LOOKBACK_MS).toISOString();
    const toDate = new Date(runAt).toISOString();
    const res = await firefliesQuery<{ transcripts?: unknown }>(client, LIST_QUERY, { fromDate, toDate, limit: LIST_PAGE_SIZE, skip: page * LIST_PAGE_SIZE });
    if (!res.ok) return { ok: false, response: res.response };
    const rows = rowsOf(res.data);
    const listed = rows.filter((t): t is ListedTranscript => idOf(t) !== null);
    const versions = new Map(listed.map(t => [t.id, transcriptVersion(t, refreshDayOf(t))]));
    const settled = await settledItemVersions(ctx.engine, account.id, [...versions.keys()]);
    const items: SyncItem[] = [];
    for (const [id, version] of versions) {
      if (settled.get(id) === version) continue;
      const item = await fetchItem(client, id, version);
      if (item === null) continue;
      if ("class" in item) return { ok: false, response: item };
      items.push(item);
    }
    const done = rows.length < LIST_PAGE_SIZE;
    return { ok: true, items, checkpoint: done ? toDate : null, done };
  }

  async function reconcilePage(client: ConnectorClient, cursor: string | null, page: number): Promise<PageResult> {
    const state = reconcileState(cursor);
    if (state.probeAfter === null && state.at !== null && runAt - state.at < RECONCILE_EVERY_MS) {
      return { ok: true, items: [], checkpoint: cursor, done: true };
    }
    const res = await firefliesQuery<{ transcripts?: unknown }>(client, IDS_QUERY, { limit: ID_PAGE_SIZE, skip: page * ID_PAGE_SIZE });
    if (!res.ok) return { ok: false, response: res.response };
    const rows = rowsOf(res.data);
    for (const row of rows) {
      const id = idOf(row);
      if (id !== null) seenIds.add(id);
    }
    if (rows.length >= ID_PAGE_SIZE) return { ok: true, items: [], checkpoint: null, done: false };

    // A cycle that needs several runs resumes after the last id it probed. Sorted
    // here, not by the database, whose collation need not agree with `>`.
    const after = state.probeAfter;
    const missing = (await liveItemIds(ctx.engine, account.id))
      .filter(id => !seenIds.has(id) && (after === null || id > after))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const batch = missing.slice(0, MAX_DELETE_PROBES);
    const deletions: string[] = [];
    for (const id of batch) {
      const probe = await firefliesQuery<{ transcript: unknown }>(client, EXISTS_QUERY, { id });
      if (probe.ok) continue;
      if (probe.code !== "object_not_found") return { ok: false, response: probe.response };
      deletions.push(id);
    }
    const checkpoint = missing.length <= MAX_DELETE_PROBES
      ? new Date(runAt).toISOString()
      : JSON.stringify({ at: state.at === null ? null : new Date(state.at).toISOString(), probe_after: batch.at(-1)! });
    return { ok: true, items: [], deletions, checkpoint, done: true };
  }

  return {
    streams: () => [STREAM_TRANSCRIPTS, STREAM_RECONCILE],
    page: async ({ client, stream, cursor, page }) => {
      if (stream === STREAM_TRANSCRIPTS) return transcriptsPage(client, cursor, page);
      if (stream === STREAM_RECONCILE) return reconcilePage(client, cursor, page);
      throw new Error(`unknown Fireflies stream ${stream}`);
    },
  };
}

/** The Fireflies provider: an API key the owner pastes, read-only by nature. */
export function firefliesProvider(): ApiKeyProvider {
  return {
    id: FIREFLIES_PROVIDER_ID,
    services: { [FIREFLIES_SERVICE]: { scopes: [], sourceKinds: ["meeting"] } },
    verifyKey: verifyFirefliesKey,
    sync: {
      apiOrigin: FIREFLIES_API_ORIGIN,
      limits: { minSpacingMs: FIREFLIES_MIN_SPACING_MS, dailyQuota: FIREFLIES_DAILY_QUOTA },
      adapter: firefliesAdapter,
    },
  };
}
