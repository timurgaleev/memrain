/**
 * The Gmail adapter: one stream per account, synced in two lanes that share
 * one cursor.
 *
 *   - The history anchor is taken first: before anything is listed, the
 *     mailbox's current `historyId` comes from `users.getProfile`. Mail that
 *     lands while the backfill runs is newer than the anchor, so the history
 *     feed replays it; nothing between the two is lost.
 *   - The walk drains a time window newest first with `messages.list`: the
 *     history window on the first sync (`config.history_days`, default 90,
 *     never past mail retention), the whole window again when the history id
 *     has expired. Its query leaves out Spam, Trash, drafts and the Promotions
 *     and Social categories. One listing keeps its query and follows its page
 *     tokens; the cursor also keeps the oldest message settled so far, so a
 *     walk whose page token Google no longer takes starts a new listing below
 *     that floor instead of starting over. Listed messages are read per thread.
 *   - The history lane reads `history.list` from the anchor at the start of
 *     every run, current mail before the walk goes on. A record that only
 *     flips UNREAD, STARRED or IMPORTANT is skipped: reading mail must not
 *     cost a thread read. Every other touched thread is read again. A 404 on
 *     the anchor means Google no longer has that history (it keeps it for about
 *     a week): a new anchor is taken and the window is walked again, which
 *     rewrites nothing that did not change. A deletion Google stopped
 *     reporting during that gap is not seen; retention still ages the page out.
 *     (developers.google.com/workspace/gmail/api/guides/sync)
 *
 * Nothing older than the first sync's window floor is ever stored: the
 * floor is kept in the cursor and never moves, and a thread a recent reply
 * brings in keeps only its messages from the floor on.
 *
 * A page of results (a listing page, or the threads one history page touched)
 * is handed to the engine in batches of at most BATCH_THREADS threads, never
 * more than one run may store (MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN): a batch
 * larger than the run cap could never reach its checkpoint, and every run
 * would read it again and stop at the same place.
 *
 * A thread is one page (render.ts renderMailThread), its version the thread's
 * `historyId`. Drafts, spam and trash never reach it. A thread none of whose
 * remaining messages are left once those are dropped, or whose every message is
 * in Promotions or Social, is gone as far as the brain is concerned: when it
 * had a page, the page goes through the upstream deletion path (a recoverable
 * soft delete, under the mass-delete guard). Attachments are receipts only;
 * nothing is downloaded. Every header and body is outside text.
 *
 * Quota: Gmail meters 6,000 units a minute per user; a full thread read costs
 * 120 (developers.google.com/workspace/gmail/api/reference/quota), so the
 * Gmail client is paced by the provider (GMAIL_MIN_SPACING_MS). A rate limit
 * stops the run; the next one resumes from the cursor.
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { renderMailThread } from "../render.ts";
import { retentionDays } from "../retention.ts";
import { syncItemFromPage } from "../sync-item.ts";
import type { ConnectorContext, MailMessage, MailThread } from "../model.ts";
import type { PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import type { AdapterContext } from "../providers.ts";
import { attachmentReceipts, calendarMethod, extractBody, isAutoSubmitted, parseAddress, parseAddressList, partHeader, type GmailMimePart } from "./gmail-mime.ts";

/** The account service this adapter syncs. */
export const GOOGLE_GMAIL_SERVICE = "gmail";
export const GMAIL_STREAM = "gmail";

const DAY_MS = 86_400_000;
export const DEFAULT_MAIL_HISTORY_DAYS = 90;
export const MAX_MAIL_HISTORY_DAYS = 3650;
/** Threads handed to the engine per page at most (fewer when the run cap is lower). */
export const BATCH_THREADS = 50;
const HISTORY_PAGE_SIZE = "100";
const DEFAULT_MAX_ITEMS_PER_RUN = 500;
const MAX_PENDING_THREADS = 1000;
/** A new walk's top: a little past now, so mail stamped by a clock slightly ahead is listed. */
const WALK_TOP_MARGIN_MS = 60_000;
const MAX_CURSOR_FIELD = 4096;
const API = "/gmail/v1/users/me";

/** Labels whose messages are never stored. */
const DROPPED_LABELS = new Set(["SPAM", "TRASH", "DRAFT"]);
/** Categories a thread is left out for when every message carries one. */
const EXCLUDED_CATEGORIES = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]);
/** Label flips that change nothing on the page. */
const VOLATILE_LABELS = new Set(["UNREAD", "STARRED", "IMPORTANT"]);
const LIST_EXCLUSIONS = "-in:spam -in:trash -in:draft -category:promotions -category:social";

type Json = Record<string, unknown>;

/**
 * A walk part-way through its window. `queryFloorMs` is the top of the
 * current listing and stays fixed while its page tokens are followed;
 * `resumeFloorMs` is the oldest listed message settled so far, where a new
 * listing starts when the token is refused.
 */
export interface GmailWalk {
  lowMs: number;
  queryFloorMs: number;
  resumeFloorMs: number;
  pageToken: string | null;
}

/** Threads a history page touched that are still to read, and where the history goes after them. */
export interface GmailPending {
  threads: string[];
  next: { page: string } | { historyId: string };
}

export interface GmailCursor {
  v: 1;
  historyId: string | null;
  /** A history listing part-way through its pages. */
  historyPage: string | null;
  pending: GmailPending | null;
  /** The first sync's window floor (ms): nothing older is stored. */
  floorMs: number | null;
  walk: GmailWalk | null;
}

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function field(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === "string" && v !== "" && v.length <= MAX_CURSOR_FIELD ? v : undefined;
}

function ms(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The stored cursor; null for none, or for one this version cannot read. */
export function parseGmailCursor(cursor: string | null): GmailCursor | null {
  if (cursor === null || cursor === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const historyId = field(raw.historyId);
  const historyPage = field(raw.historyPage);
  if (historyId === undefined || historyPage === undefined) return null;
  const floorMs = raw.floorMs === undefined || raw.floorMs === null ? null : ms(raw.floorMs);
  if (floorMs === null && raw.floorMs !== undefined && raw.floorMs !== null) return null;
  let pending: GmailPending | null = null;
  if (raw.pending !== undefined && raw.pending !== null) {
    const p = raw.pending;
    if (!isRecord(p) || !Array.isArray(p.threads) || p.threads.length > MAX_PENDING_THREADS || !isRecord(p.next)) return null;
    const threads = p.threads.map(field);
    if (threads.some(t => typeof t !== "string")) return null;
    const page = field(p.next.page);
    const hid = field(p.next.historyId);
    if (typeof page === "string") pending = { threads: threads as string[], next: { page } };
    else if (typeof hid === "string") pending = { threads: threads as string[], next: { historyId: hid } };
    else return null;
  }
  let walk: GmailWalk | null = null;
  if (raw.walk !== null) {
    if (!isRecord(raw.walk)) return null;
    const lowMs = ms(raw.walk.lowMs);
    const queryFloorMs = ms(raw.walk.queryFloorMs);
    const resumeFloorMs = ms(raw.walk.resumeFloorMs);
    const pageToken = field(raw.walk.pageToken);
    if (lowMs === null || queryFloorMs === null || resumeFloorMs === null || pageToken === undefined) return null;
    walk = { lowMs, queryFloorMs, resumeFloorMs, pageToken };
  }
  return { v: 1, historyId, historyPage, pending, floorMs, walk };
}

function configInt(account: SyncAccount, key: string, min: number, max: number): number | null {
  const v = account.config?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function invalid(res: ConnectorResponse, what: string): PageResult {
  return { ok: false, response: { ...res, class: "challenge", body: null, error: `unexpected ${what} response` } };
}

interface RawMessage {
  id: string;
  labelIds: string[];
  internalDateMs: number;
  payload: GmailMimePart | undefined;
}

function rawMessage(v: unknown): RawMessage | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const at = Number(v.internalDate);
  if (id === null || !Number.isSafeInteger(at) || at <= 0) return null;
  const labelIds = Array.isArray(v.labelIds) ? v.labelIds.filter((l): l is string => typeof l === "string") : [];
  return { id, labelIds, internalDateMs: at, payload: isRecord(v.payload) ? (v.payload as GmailMimePart) : undefined };
}

/** A Gmail message as the provider-neutral shape. */
export function normalizeGmailMessage(m: RawMessage): MailMessage {
  const p = m.payload;
  const { text, isHtml } = extractBody(p);
  const precedence = partHeader(p, "Precedence").trim().toLowerCase();
  return {
    id: m.id,
    messageIdHeader: str(partHeader(p, "Message-ID").trim()),
    subject: partHeader(p, "Subject"),
    from: parseAddress(partHeader(p, "From")) ?? { name: null, email: null },
    to: parseAddressList(partHeader(p, "To")),
    cc: parseAddressList(partHeader(p, "Cc")),
    date: new Date(m.internalDateMs).toISOString(),
    bodyText: isHtml ? null : text,
    bodyHtml: isHtml ? text : null,
    attachments: attachmentReceipts(p),
    listUnsubscribe: partHeader(p, "List-Unsubscribe") !== "",
    categories: m.labelIds.filter(l => l.startsWith("CATEGORY_")).map(l => l.slice("CATEGORY_".length).toLowerCase()),
    autoSubmitted: isAutoSubmitted(partHeader(p, "Auto-Submitted")),
    precedence: precedence === "" ? null : precedence,
    listId: partHeader(p, "List-Id") !== "",
    sent: m.labelIds.includes("SENT"),
    replyTo: parseAddressList(partHeader(p, "Reply-To"), 10).map(a => a.email).filter((a): a is string => a !== null),
    calendarMethod: calendarMethod(p),
  };
}

/**
 * The thread as the brain keeps it: drafts, spam and trash dropped. Null when
 * nothing is left, or when every remaining message sits in Promotions or Social.
 */
export function normalizeGmailThread(threadId: string, messages: readonly unknown[], floorMs: number | null = null): { thread: MailThread; newestMs: number } | null {
  const kept = messages.map(rawMessage).filter((m): m is RawMessage => m !== null && !m.labelIds.some(l => DROPPED_LABELS.has(l))
    && (floorMs === null || m.internalDateMs >= floorMs));
  if (kept.length === 0 || kept.every(m => m.labelIds.some(l => EXCLUDED_CATEGORIES.has(l)))) return null;
  const labels = [...new Set(kept.flatMap(m => m.labelIds).filter(l => !VOLATILE_LABELS.has(l)))];
  return {
    thread: { threadId, messages: kept.map(normalizeGmailMessage), labels },
    newestMs: Math.max(...kept.map(m => m.internalDateMs)),
  };
}

/** Whether a history record changes anything a page shows. */
function touchesPage(rec: Json): boolean {
  if (Array.isArray(rec.messagesAdded) && rec.messagesAdded.length > 0) return true;
  if (Array.isArray(rec.messagesDeleted) && rec.messagesDeleted.length > 0) return true;
  for (const key of ["labelsAdded", "labelsRemoved"]) {
    const changes = rec[key];
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      const ids = isRecord(c) && Array.isArray(c.labelIds) ? c.labelIds : [];
      if (ids.some(l => typeof l !== "string" || !VOLATILE_LABELS.has(l))) return true;
    }
  }
  return false;
}

/** The thread ids a history page touched, in order, skipping read-state-only records. */
function touchedThreads(records: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const rec of records) {
    if (!isRecord(rec) || !touchesPage(rec)) continue;
    for (const key of ["messages", "messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) {
      const arr = rec[key];
      if (!Array.isArray(arr)) continue;
      for (const m of arr) {
        const tid = isRecord(m) ? str(m.threadId) ?? (isRecord(m.message) ? str(m.message.threadId) : null) : null;
        if (tid !== null) out.add(tid);
      }
    }
  }
  return [...out];
}

type ThreadOutcome =
  | { kind: "item"; item: SyncItem; listedAt: number[] }
  | { kind: "gone"; threadId: string }
  | { kind: "old" }
  | { kind: "stop"; response: ConnectorResponse };

class Adapter implements SyncAdapter {
  constructor(private readonly account: SyncAccount, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv) {}

  streams(): string[] {
    return (this.account.services ?? []).includes(GOOGLE_GMAIL_SERVICE) ? [GMAIL_STREAM] : [];
  }

  private retention(): number | null {
    return retentionDays("mail", configInt(this.account, "retention_days", 0, 100_000), this.env);
  }

  /** The earliest mail this account keeps, in ms: the history window, never past retention. */
  private windowLow(): number {
    const days = configInt(this.account, "history_days", 1, MAX_MAIL_HISTORY_DAYS) ?? DEFAULT_MAIL_HISTORY_DAYS;
    const keep = this.retention();
    return this.now() - (keep === null ? days : Math.min(days, keep)) * DAY_MS;
  }

  /**
   * Threads per page handed to the engine: never more than one run, or one
   * day under the account's item cap, may store. A larger page would stop
   * part-way, keep its checkpoint and replay the same threads every day.
   */
  private batch(): number {
    const n = Number((this.env.MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN ?? "").trim());
    const daily = this.account.itemCapDaily > 0 ? this.account.itemCapDaily : BATCH_THREADS;
    return Math.min(BATCH_THREADS, daily, Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ITEMS_PER_RUN);
  }

  private newWalk(): GmailWalk {
    const top = this.now() + WALK_TOP_MARGIN_MS;
    return { lowMs: this.windowLow(), queryFloorMs: top, resumeFloorMs: top, pageToken: null };
  }

  async page({ client, stream, cursor, page }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    if (stream !== GMAIL_STREAM) throw new Error(`gmail adapter has no stream ${stream}`);
    const st = parseGmailCursor(cursor);
    if (st === null || st.historyId === null) return this.anchor(client, st);
    if (st.pending !== null) return this.pendingPage(client, st, st.pending);
    if (page === 0 || st.historyPage !== null) return this.historyPage(client, st);
    if (st.walk !== null) return this.walkPage(client, st, st.walk);
    return { ok: true, items: [], checkpoint: JSON.stringify(st), done: true };
  }

  /** The history anchor, taken before anything is listed; a walk of the window follows. */
  private async anchor(client: ConnectorClient, st: GmailCursor | null): Promise<PageResult> {
    const res = await client.get(`${API}/profile`);
    if (res.class !== "ok") return { ok: false, response: res };
    const historyId = isRecord(res.body) ? str(res.body.historyId) : null;
    if (historyId === null || historyId.length > MAX_CURSOR_FIELD) return invalid(res, "profile");
    const next: GmailCursor = { v: 1, historyId, historyPage: null, pending: null, floorMs: st?.floorMs ?? this.windowLow(), walk: st?.walk ?? this.newWalk() };
    return { ok: true, items: [], checkpoint: JSON.stringify(next), done: false };
  }

  /** Read up to one batch of `threads`: items, deletions, or the response that stopped it. */
  private async readBatch(client: ConnectorClient, st: GmailCursor, threads: readonly string[]): Promise<{ items: SyncItem[]; deletions: string[] } | { stop: ConnectorResponse }> {
    const items: SyncItem[] = [];
    const deletions: string[] = [];
    for (const tid of threads) {
      const out = await this.readThread(client, st, tid, true);
      if (out.kind === "stop") return { stop: out.response };
      if (out.kind === "gone") deletions.push(out.threadId);
      else if (out.kind === "item") items.push(out.item);
    }
    return { items, deletions };
  }

  /** The cursor once a history page's threads are all read. */
  private afterHistory(st: GmailCursor, next: GmailPending["next"]): { cursor: GmailCursor; done: boolean } {
    if ("page" in next) return { cursor: { ...st, historyPage: next.page, pending: null }, done: false };
    const cursor: GmailCursor = { ...st, historyId: next.historyId, historyPage: null, pending: null };
    return { cursor, done: cursor.walk === null };
  }

  /** The next batch of threads a history page touched. */
  private async pendingPage(client: ConnectorClient, st: GmailCursor, pending: GmailPending): Promise<PageResult> {
    const take = pending.threads.slice(0, this.batch());
    const rest = pending.threads.slice(take.length);
    const read = await this.readBatch(client, st, take);
    if ("stop" in read) return { ok: false, response: read.stop };
    if (rest.length > 0) {
      return { ok: true, ...read, checkpoint: JSON.stringify({ ...st, pending: { threads: rest, next: pending.next } }), done: false };
    }
    const after = this.afterHistory(st, pending.next);
    return { ok: true, ...read, checkpoint: JSON.stringify(after.cursor), done: after.done };
  }

  private async historyPage(client: ConnectorClient, st: GmailCursor): Promise<PageResult> {
    const path = (pageToken: string | null) => {
      const q = new URLSearchParams({ startHistoryId: st.historyId!, maxResults: HISTORY_PAGE_SIZE });
      if (pageToken !== null) q.set("pageToken", pageToken);
      return `${API}/history?${q.toString()}`;
    };
    let res = await client.get(path(st.historyPage));
    if (st.historyPage !== null && res.status === 400) res = await client.get(path(null));
    if (res.status === 404) return this.expired(client, st);
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || (res.body.history !== undefined && !Array.isArray(res.body.history))) return invalid(res, "history");

    const touched = touchedThreads((res.body.history ?? []) as unknown[]);
    if (touched.length > MAX_PENDING_THREADS || touched.some(t => t.length > MAX_CURSOR_FIELD)) return invalid(res, "history (too many threads on one page)");
    const nextPage = str(res.body.nextPageToken);
    if (nextPage !== null && nextPage.length > MAX_CURSOR_FIELD) return invalid(res, "history (page token too long)");
    const historyId = str(res.body.historyId) ?? st.historyId;
    if (historyId === null || historyId.length > MAX_CURSOR_FIELD) return invalid(res, "history (no history id)");
    const next: GmailPending["next"] = nextPage !== null ? { page: nextPage } : { historyId };
    // The threads go through pendingPage in batches the run cap can settle.
    return this.pendingPage(client, { ...st, historyPage: null }, { threads: touched, next });
  }

  /** Google no longer has the history after the anchor: anchor anew and walk the window again. */
  private async expired(client: ConnectorClient, st: GmailCursor): Promise<PageResult> {
    const res = await client.get(`${API}/profile`);
    if (res.class !== "ok") return { ok: false, response: res };
    const historyId = isRecord(res.body) ? str(res.body.historyId) : null;
    if (historyId === null || historyId.length > MAX_CURSOR_FIELD) return invalid(res, "profile");
    // The history after the old anchor is gone, threads it named included.
    const next: GmailCursor = { v: 1, historyId, historyPage: null, pending: null, floorMs: this.floorOf(st), walk: this.newWalk() };
    return { ok: true, items: [], checkpoint: JSON.stringify(next), done: false };
  }

  /** The cursor's floor, or the first sync's window for a cursor written before it was kept. */
  private floorOf(st: GmailCursor): number {
    return st.floorMs ?? this.windowLow();
  }

  private listPath(walk: GmailWalk): string {
    const q = new URLSearchParams({
      maxResults: String(this.batch()),
      q: `after:${Math.floor(walk.lowMs / 1000)} before:${Math.ceil(walk.queryFloorMs / 1000)} ${LIST_EXCLUSIONS}`,
    });
    if (walk.pageToken !== null) q.set("pageToken", walk.pageToken);
    return `${API}/messages?${q.toString()}`;
  }

  private async walkPage(client: ConnectorClient, st: GmailCursor, start: GmailWalk): Promise<PageResult> {
    let walk = start;
    let res = await client.get(this.listPath(walk));
    if (walk.pageToken !== null && res.status === 400) {
      // A page token Google no longer takes: a new listing below what is settled.
      walk = { ...walk, queryFloorMs: walk.resumeFloorMs, pageToken: null };
      res = await client.get(this.listPath(walk));
    }
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || (res.body.messages !== undefined && !Array.isArray(res.body.messages))) return invalid(res, "messages");
    const listed = new Map<string, Set<string>>();
    for (const m of (res.body.messages ?? []) as unknown[]) {
      const id = isRecord(m) ? str(m.id) : null;
      const tid = isRecord(m) ? str(m.threadId) : null;
      if (id === null || tid === null) continue;
      if (!listed.has(tid)) listed.set(tid, new Set());
      listed.get(tid)!.add(id);
    }

    const items: SyncItem[] = [];
    const deletions: string[] = [];
    let oldest = walk.resumeFloorMs;
    for (const [tid, ids] of listed) {
      const out = await this.readThread(client, st, tid, false, ids);
      if (out.kind === "stop") return { ok: false, response: out.response };
      if (out.kind === "gone") deletions.push(out.threadId);
      if (out.kind === "item") {
        items.push(out.item);
        for (const at of out.listedAt) oldest = Math.min(oldest, at);
      }
    }

    const nextPage = str(res.body.nextPageToken);
    if (nextPage !== null && nextPage.length > MAX_CURSOR_FIELD) return invalid(res, "messages (page token too long)");
    const nextWalk: GmailWalk | null = nextPage === null ? null : { ...walk, resumeFloorMs: oldest, pageToken: nextPage };
    const next: GmailCursor = { ...st, walk: nextWalk };
    return { ok: true, items, deletions, checkpoint: JSON.stringify(next), done: nextWalk === null };
  }

  /**
   * Read one thread. `fromHistory` threads older than the window are left
   * alone unless they are gone (a stored page may still need deleting).
   */
  private async readThread(client: ConnectorClient, st: GmailCursor, threadId: string, fromHistory: boolean, listedIds?: Set<string>): Promise<ThreadOutcome> {
    const res = await client.get(`${API}/threads/${encodeURIComponent(threadId)}?format=full`);
    if (res.status === 404) return { kind: "gone", threadId };
    if (res.class !== "ok") return { kind: "stop", response: res };
    if (!isRecord(res.body) || !Array.isArray(res.body.messages)) return { kind: "stop", response: { ...res, class: "challenge", body: null, error: "unexpected thread response" } };
    const version = str(res.body.historyId);
    const messages = res.body.messages as unknown[];
    // An unreadable message must not read as a gone thread: that would delete its page.
    if (messages.length === 0 || messages.some(m => rawMessage(m)?.payload === undefined)) {
      return { kind: "stop", response: { ...res, class: "challenge", body: null, error: "unexpected thread response" } };
    }
    const normalized = normalizeGmailThread(threadId, messages, this.floorOf(st));
    if (normalized === null) return { kind: "gone", threadId };
    if (fromHistory && normalized.newestMs < this.windowLow()) return { kind: "old" };
    const listedAt = listedIds === undefined
      ? []
      : messages.map(rawMessage).filter((m): m is RawMessage => m !== null && listedIds.has(m.id)).map(m => m.internalDateMs);
    const ctx: ConnectorContext = { service: "gmail", accountLabel: this.account.accountLabel ?? "" };
    try {
      return { kind: "item", item: syncItemFromPage(renderMailThread(ctx, normalized.thread), version, { enrich: true }), listedAt };
    } catch (e) {
      // The message can quote mail text; only the error's kind is kept.
      return { kind: "item", item: { externalId: threadId, version, failure: { code: "render_failed", message: `the thread could not be rendered (${e instanceof Error ? e.name : "error"})` } }, listedAt };
    }
  }
}

export function googleGmailAdapter(account: SyncAccount, opts: Partial<AdapterContext> = {}): SyncAdapter {
  return new Adapter(account, opts.now ?? Date.now, opts.env ?? process.env);
}
