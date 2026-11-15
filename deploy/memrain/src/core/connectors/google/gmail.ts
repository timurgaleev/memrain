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
import { attachmentReceipts, extractBody, isAutoSubmitted, parseAddress, parseAddressList, partHeader, type GmailMimePart } from "./gmail-mime.ts";

/** The account service this adapter syncs. */
export const GOOGLE_GMAIL_SERVICE = "gmail";
export const GMAIL_STREAM = "gmail";

const DAY_MS = 86_400_000;
export const DEFAULT_MAIL_HISTORY_DAYS = 90;
export const MAX_MAIL_HISTORY_DAYS = 3650;
const LIST_PAGE_SIZE = "100";
const HISTORY_PAGE_SIZE = "100";
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

export interface GmailCursor {
  v: 1;
  historyId: string | null;
  /** A history listing part-way through its pages. */
  historyPage: string | null;
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
  return { v: 1, historyId, historyPage, walk };
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
  };
}

/**
 * The thread as the brain keeps it: drafts, spam and trash dropped. Null when
 * nothing is left, or when every remaining message sits in Promotions or Social.
 */
export function normalizeGmailThread(threadId: string, messages: readonly unknown[]): { thread: MailThread; newestMs: number } | null {
  const kept = messages.map(rawMessage).filter((m): m is RawMessage => m !== null && !m.labelIds.some(l => DROPPED_LABELS.has(l)));
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

  private newWalk(): GmailWalk {
    const top = this.now() + WALK_TOP_MARGIN_MS;
    return { lowMs: this.windowLow(), queryFloorMs: top, resumeFloorMs: top, pageToken: null };
  }

  async page({ client, stream, cursor, page }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    if (stream !== GMAIL_STREAM) throw new Error(`gmail adapter has no stream ${stream}`);
    const st = parseGmailCursor(cursor);
    if (st === null || st.historyId === null) return this.anchor(client, st);
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
    const next: GmailCursor = { v: 1, historyId, historyPage: null, walk: st?.walk ?? this.newWalk() };
    return { ok: true, items: [], checkpoint: JSON.stringify(next), done: false };
  }

  private async historyPage(client: ConnectorClient, st: GmailCursor): Promise<PageResult> {
    const path = (pageToken: string | null) => {
      const q = new URLSearchParams({ startHistoryId: st.historyId!, maxResults: HISTORY_PAGE_SIZE });
      if (pageToken !== null) q.set("pageToken", pageToken);
      return `${API}/history?${q.toString()}`;
    };
    let res = await client.get(path(st.historyPage));
    if (st.historyPage !== null && res.status === 400) res = await client.get(path(null));
    if (res.status === 404) return this.expired(client);
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || (res.body.history !== undefined && !Array.isArray(res.body.history))) return invalid(res, "history");

    const items: SyncItem[] = [];
    const deletions: string[] = [];
    for (const tid of touchedThreads((res.body.history ?? []) as unknown[])) {
      const out = await this.readThread(client, tid, true);
      if (out.kind === "stop") return { ok: false, response: out.response };
      if (out.kind === "gone") deletions.push(out.threadId);
      else if (out.kind === "item") items.push(out.item);
    }
    const nextPage = str(res.body.nextPageToken);
    if (nextPage !== null) {
      if (nextPage.length > MAX_CURSOR_FIELD) return invalid(res, "history (page token too long)");
      return { ok: true, items, deletions, checkpoint: JSON.stringify({ ...st, historyPage: nextPage }), done: false };
    }
    const historyId = str(res.body.historyId) ?? st.historyId;
    if (historyId === null || historyId.length > MAX_CURSOR_FIELD) return invalid(res, "history (no history id)");
    const next: GmailCursor = { ...st, historyId, historyPage: null };
    return { ok: true, items, deletions, checkpoint: JSON.stringify(next), done: next.walk === null };
  }

  /** Google no longer has the history after the anchor: anchor anew and walk the window again. */
  private async expired(client: ConnectorClient): Promise<PageResult> {
    const res = await client.get(`${API}/profile`);
    if (res.class !== "ok") return { ok: false, response: res };
    const historyId = isRecord(res.body) ? str(res.body.historyId) : null;
    if (historyId === null || historyId.length > MAX_CURSOR_FIELD) return invalid(res, "profile");
    const next: GmailCursor = { v: 1, historyId, historyPage: null, walk: this.newWalk() };
    return { ok: true, items: [], checkpoint: JSON.stringify(next), done: false };
  }

  private listPath(walk: GmailWalk): string {
    const q = new URLSearchParams({
      maxResults: LIST_PAGE_SIZE,
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
      const out = await this.readThread(client, tid, false, ids);
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
  private async readThread(client: ConnectorClient, threadId: string, fromHistory: boolean, listedIds?: Set<string>): Promise<ThreadOutcome> {
    const res = await client.get(`${API}/threads/${encodeURIComponent(threadId)}?format=full`);
    if (res.status === 404) return { kind: "gone", threadId };
    if (res.class !== "ok") return { kind: "stop", response: res };
    if (!isRecord(res.body) || !Array.isArray(res.body.messages)) return { kind: "stop", response: { ...res, class: "challenge", body: null, error: "unexpected thread response" } };
    const version = str(res.body.historyId);
    const messages = res.body.messages as unknown[];
    const normalized = normalizeGmailThread(threadId, messages);
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
