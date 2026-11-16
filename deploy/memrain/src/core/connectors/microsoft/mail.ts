/**
 * The Outlook mail adapter (Microsoft Graph): one stream per synced folder,
 * each a chain of delta rounds, and one page per conversation.
 *
 *   - Folders are named by their well-known names: Inbox and Sent Items by
 *     default (`config.folders` may add Archive). Junk, Deleted Items, Drafts
 *     and every other folder are never synced, and a message sitting in one of
 *     them is left out of its conversation. Each folder is resolved to its id
 *     once per run (GET /me/mailFolders/{name}).
 *   - A folder's first round is a messages delta filtered to the history window
 *     (`receivedDateTime ge`, the only filter delta takes; `config.history_days`,
 *     default 90, never past mail retention), selecting only what grouping
 *     needs. Graph pages it with `@odata.nextLink`; each link is the stream's
 *     checkpoint, so a round cut short resumes where it stopped. The last page
 *     hands over an `@odata.deltaLink`, and every later run starts from it.
 *     (learn.microsoft.com/graph/delta-query-messages)
 *   - A filtered delta returns at most 5,000 messages (same page), so a
 *     folder with more inside the window would come back short. Once the
 *     first round ends, one backfill pass lists the folder's messages over
 *     the same floor (the plain list has no such cap; conversation ids only,
 *     1,000 a page) and reads each conversation not stored yet. The delta
 *     link waits until the backfill is through.
 *   - A changed message names its conversation; the conversation is read whole
 *     (`$filter=conversationId eq …`, bodies as text, attachments expanded to
 *     name, type and size only) and rendered by the same MailThread renderer as
 *     Gmail. A delta entry that names no conversation (a property flip Graph
 *     reports on its own) reads nothing: it cannot change a page.
 *   - An `@removed` entry names a message that left the folder, deleted or
 *     moved. Ids are immutable (`Prefer: IdType="ImmutableId"` on every
 *     request), so a moved message is looked up to find its conversation,
 *     which is read again: rendered without it, or, when nothing of the
 *     conversation is left in the synced folders, handed to the engine's
 *     upstream deletion (a recoverable soft delete, under the mass-delete
 *     guard). A purged message Graph can no longer look up (404) is found in
 *     the account's stored items instead: an item's version carries a short
 *     hash of every message id it rendered, so the conversation that held the
 *     message is read again all the same.
 *   - A delta token Graph no longer holds (410, syncStateNotFound) starts a
 *     new first round over the window; unchanged conversations rewrite
 *     nothing. A deletion Graph stopped reporting during that gap is not seen.
 *
 * Nothing older than the first sync's window floor is ever stored: the floor
 * is kept in the cursor and never moves.
 *
 * Size: a conversation response past OUTLOOK_MAIL_MAX_CONVERSATION_BYTES (or
 * more than MAX_CONVERSATION_PAGES pages of messages) is not read into memory;
 * the conversation becomes a failed item held at once with the reason
 * `too_large`, never treated as gone.
 *
 * Throttling: Outlook allows 10,000 requests per 10 minutes and four
 * concurrent requests per app and mailbox (learn.microsoft.com/graph/
 * throttling-limits); one run reads serially, paced by the client, and a 429
 * or 503 is waited out per its Retry-After or stops the run with its cursor
 * kept.
 *
 * Every header and body is outside text written by whoever sent the mail.
 */
import { createHash } from "node:crypto";
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { renderMailThread } from "../render.ts";
import { retentionDays } from "../retention.ts";
import { syncItemFromPage } from "../sync-item.ts";
import { ownAddresses, shortHash, type ConnectorContext, type MailAttachment, type MailMessage, type MailThread, type Person } from "../model.ts";
import type { Engine } from "../../engine/interface.ts";
import type { AdapterContext, ProviderService } from "../providers.ts";
import type { PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import { GMAIL_MIME_LIMITS, isAutoSubmitted } from "../google/gmail-mime.ts";
import { graphGet, graphLinkPath, isSyncStateLost, preferHeader } from "./graph-client.ts";

/** The account service this adapter syncs. */
export const OUTLOOK_MAIL_SERVICE = "outlook_mail";
/** What the service asks for: read-only mail, into a mailbox source. */
export const outlookMailService: ProviderService = { scopes: ["Mail.Read"], sourceKinds: ["mailbox"] };

export const DEFAULT_OUTLOOK_FOLDERS: readonly string[] = ["inbox", "sentitems"];
/** Folders an account may sync; Junk, Deleted Items, Drafts and Outbox never. */
export const OUTLOOK_SYNCABLE_FOLDERS: readonly string[] = ["inbox", "sentitems", "archive"];
const SENT_FOLDER = "sentitems";
const STREAM_PREFIX = "outlook_mail:";

const DAY_MS = 86_400_000;
export const DEFAULT_OUTLOOK_HISTORY_DAYS = 90;
const MAX_HISTORY_DAYS = 3650;
/** Messages per delta page and conversations per engine batch, at most. */
export const OUTLOOK_BATCH = 50;
const DEFAULT_MAX_ITEMS_PER_RUN = 500;
/** A conversation response larger than this is not read; the conversation is held instead. */
export const OUTLOOK_MAIL_MAX_CONVERSATION_BYTES = 10 * 1024 * 1024;
const CONVERSATION_PAGE_SIZE = 50;
const MAX_CONVERSATION_PAGES = 10;
const MAX_DELTA_ENTRIES = 1000;
const MAX_PENDING = 2000;
const MAX_ID_CHARS = 500;
const MAX_HEADERS = 200;
const MAX_HEADER_CHARS = 2000;
const MAX_CATEGORIES = 25;
const MAX_REPLY_TO = 10;
const MAX_RECIPIENTS = 100;
const API = "/v1.0/me";

const DELTA_SELECT = "conversationId,receivedDateTime,parentFolderId";
/** Messages per backfill listing page: conversation ids only, so Graph's largest page. */
const BACKFILL_PAGE = 1000;
const MESSAGE_SELECT = [
  "conversationId", "parentFolderId", "receivedDateTime", "sentDateTime", "isDraft", "subject", "from", "sender",
  "toRecipients", "ccRecipients", "replyTo", "body", "internetMessageId", "internetMessageHeaders", "categories", "changeKey",
].join(",");
const ATTACHMENT_EXPAND = "attachments($select=name,contentType,size,isInline)";

/** Graph's meeting message types as the iCalendar METHOD the loop detector reads. */
const MEETING_METHOD: Readonly<Record<string, string>> = {
  "#microsoft.graph.eventMessageRequest": "REQUEST",
  "#microsoft.graph.eventMessageResponse": "REPLY",
  // The base type carries cancellations; requests and responses have their own.
  "#microsoft.graph.eventMessage": "CANCEL",
};

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, max = MAX_ID_CHARS): string | null {
  return typeof v === "string" && v !== "" && v.length <= max ? v : null;
}

export function outlookMailStream(folder: string): string {
  return `${STREAM_PREFIX}${folder}`;
}

/** Conversations a delta page touched that are still to read, and where the round goes after them. */
export interface OutlookMailPending {
  conversations: string[];
  /** Messages that left the folder; each is looked up for its conversation. */
  removed: string[];
  link: string;
  linkKind: "next" | "delta";
}

export interface OutlookMailCursor {
  v: 1;
  /** The first sync's window floor (ms): nothing older is stored. */
  floorMs: number;
  /** Where the next request goes: a nextLink inside a round, the deltaLink between rounds, null before the first. */
  link: string | null;
  linkKind: "next" | "delta" | null;
  pending: OutlookMailPending | null;
  /** The round in progress is the first over the window (its delta was filtered, so capped). */
  firstRound?: true;
  /** The next page of the backfill listing that follows a first round. */
  backfill?: string;
}

function linkField(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  return graphLinkPath(`https://graph.microsoft.com${v}`) === v ? v : undefined;
}

function idList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_PENDING) return null;
  const out = v.map(x => str(x));
  return out.every((x): x is string => x !== null) ? out : null;
}

/** The stored cursor; null for none, or for one this version cannot read. */
export function parseOutlookMailCursor(cursor: string | null): OutlookMailCursor | null {
  if (cursor === null || cursor === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const floorMs = raw.floorMs;
  if (typeof floorMs !== "number" || !Number.isSafeInteger(floorMs) || floorMs < 0) return null;
  const link = linkField(raw.link);
  const linkKind = raw.linkKind;
  if (link === undefined || !(linkKind === null || linkKind === "next" || linkKind === "delta") || (link === null) !== (linkKind === null)) return null;
  if (raw.firstRound !== undefined && raw.firstRound !== true) return null;
  const backfill = raw.backfill === undefined ? undefined : linkField(raw.backfill);
  if (backfill === null) return null;
  if (raw.backfill !== undefined && backfill === undefined) return null;
  let pending: OutlookMailPending | null = null;
  if (raw.pending !== null && raw.pending !== undefined) {
    const p = raw.pending;
    if (!isRecord(p)) return null;
    const conversations = idList(p.conversations);
    const removed = idList(p.removed);
    const plink = linkField(p.link);
    if (conversations === null || removed === null || typeof plink !== "string" || (p.linkKind !== "next" && p.linkKind !== "delta")) return null;
    pending = { conversations, removed, link: plink, linkKind: p.linkKind };
  }
  return { v: 1, floorMs, link, linkKind, pending, ...(raw.firstRound === true ? { firstRound: true as const } : {}), ...(backfill !== undefined ? { backfill } : {}) };
}

function person(v: unknown): Person | null {
  const e = isRecord(v) && isRecord(v.emailAddress) ? v.emailAddress : null;
  if (e === null) return null;
  const rawAddress = typeof e.address === "string" ? e.address.trim().toLowerCase() : "";
  const email = rawAddress.includes("@") && !/\s/.test(rawAddress) ? rawAddress : null;
  const rawName = typeof e.name === "string" ? e.name.trim() : "";
  // Graph repeats the address as the name when there is none; Gmail reads that as no name.
  const name = rawName === "" || rawName.toLowerCase() === rawAddress ? null : rawName;
  if (name === null && email === null) return null;
  return { name, email };
}

function people(v: unknown, max = MAX_RECIPIENTS): Person[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).map(person).filter((p): p is Person => p !== null);
}

/** The internet headers, lowercased name to first value, bounded. */
function headerMap(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(v)) return out;
  for (const h of v.slice(0, MAX_HEADERS)) {
    if (!isRecord(h) || typeof h.name !== "string" || typeof h.value !== "string") continue;
    const name = h.name.trim().toLowerCase();
    if (!out.has(name)) out.set(name, h.value.slice(0, MAX_HEADER_CHARS));
  }
  return out;
}

function attachments(v: unknown): MailAttachment[] {
  if (!Array.isArray(v)) return [];
  const out: MailAttachment[] = [];
  for (const a of v) {
    // An inline image is part of the body's layout, not something attached.
    if (!isRecord(a) || a.isInline === true) continue;
    const name = typeof a.name === "string" && a.name.trim() !== "" ? a.name.slice(0, 300) : "(unnamed)";
    const mime = (typeof a.contentType === "string" && a.contentType !== "" ? a.contentType : "application/octet-stream").split(";")[0]!.trim().toLowerCase().slice(0, 120);
    const size = typeof a.size === "number" && Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : 0;
    out.push({ name, mime, size });
    if (out.length >= GMAIL_MIME_LIMITS.attachments) break;
  }
  return out;
}

function receivedMs(m: Json): number | null {
  const at = Date.parse(typeof m.receivedDateTime === "string" ? m.receivedDateTime : typeof m.sentDateTime === "string" ? m.sentDateTime : "");
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** A Graph message as the provider-neutral shape. `sentFolderIds` are the Sent Items folder's ids. */
export function normalizeOutlookMessage(m: Json, sentFolderIds: ReadonlySet<string>): MailMessage {
  const headers = headerMap(m.internetMessageHeaders);
  const body = isRecord(m.body) ? m.body : {};
  const content = typeof body.content === "string" ? body.content : "";
  const isHtml = typeof body.contentType === "string" && body.contentType.toLowerCase() === "html";
  const precedence = (headers.get("precedence") ?? "").trim().toLowerCase();
  const at = receivedMs(m);
  const odataType = typeof m["@odata.type"] === "string" ? m["@odata.type"] : "";
  return {
    id: String(m.id),
    messageIdHeader: str(typeof m.internetMessageId === "string" ? m.internetMessageId.trim() : null, 1000),
    subject: typeof m.subject === "string" ? m.subject : "",
    from: person(m.from) ?? person(m.sender) ?? { name: null, email: null },
    to: people(m.toRecipients),
    cc: people(m.ccRecipients),
    date: new Date(at ?? 0).toISOString(),
    bodyText: isHtml ? null : content,
    bodyHtml: isHtml ? content : null,
    attachments: attachments(m.attachments),
    listUnsubscribe: headers.has("list-unsubscribe"),
    categories: Array.isArray(m.categories)
      ? m.categories.slice(0, MAX_CATEGORIES).filter((c): c is string => typeof c === "string" && c !== "").map(c => c.toLowerCase().slice(0, 100))
      : [],
    autoSubmitted: isAutoSubmitted(headers.get("auto-submitted") ?? ""),
    precedence: precedence === "" ? null : precedence,
    listId: headers.has("list-id"),
    sent: typeof m.parentFolderId === "string" && sentFolderIds.has(m.parentFolderId),
    replyTo: people(m.replyTo, MAX_REPLY_TO).map(p => p.email).filter((a): a is string => a !== null),
    calendarMethod: MEETING_METHOD[odataType] ?? null,
  };
}

export interface ConversationFolders {
  /** Ids of the synced folders: a message elsewhere is left out. */
  included: ReadonlySet<string>;
  /** Ids of Sent Items, when it is synced. */
  sent: ReadonlySet<string>;
  /** The first sync's window floor (ms); older messages are left out. */
  floorMs: number | null;
}

/** A message's mark in its conversation's version: found again once Graph has purged it. */
export function outlookMessageRef(id: string): string {
  return shortHash(`outlook-message:${id}`);
}

/**
 * The conversation as the brain keeps it: drafts and messages outside the
 * synced folders dropped. Null when nothing is left. The version moves when a
 * kept message is added, removed or changed, and names every kept message
 * (outlookMessageRef).
 */
export function normalizeOutlookConversation(conversationId: string, raws: readonly unknown[], folders: ConversationFolders): { thread: MailThread; newestMs: number; version: string } | null {
  const kept = raws.filter((m): m is Json => isRecord(m) && str(m.id) !== null && m.isDraft !== true
    && typeof m.parentFolderId === "string" && folders.included.has(m.parentFolderId)
    && receivedMs(m) !== null && (folders.floorMs === null || receivedMs(m)! >= folders.floorMs));
  if (kept.length === 0) return null;
  kept.sort((a, b) => receivedMs(a)! - receivedMs(b)!);
  const labels = [...new Set(kept.flatMap(m => (Array.isArray(m.categories) ? m.categories.filter((c): c is string => typeof c === "string" && c !== "") : [])))];
  const digest = createHash("sha256")
    .update(kept.map(m => `${String(m.id)}:${typeof m.changeKey === "string" ? m.changeKey : ""}:${String(m.parentFolderId)}`).join("\n"))
    .digest("hex")
    .slice(0, 24);
  const version = `${digest}:${kept.map(m => outlookMessageRef(String(m.id))).join(".")}`;
  return {
    thread: { threadId: conversationId, messages: kept.map(m => normalizeOutlookMessage(m, folders.sent)), labels },
    newestMs: Math.max(...kept.map(m => receivedMs(m)!)),
    version,
  };
}

function configInt(account: SyncAccount, key: string, min: number, max: number): number | null {
  const v = account.config?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** The account's folders: the configured syncable ones, or Inbox and Sent Items. */
export function outlookFolders(account: SyncAccount): string[] {
  const raw = account.config?.folders;
  const named = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string").map(f => f.trim().toLowerCase()) : [];
  const allowed = [...new Set(named.filter(f => OUTLOOK_SYNCABLE_FOLDERS.includes(f)))];
  return allowed.length > 0 ? allowed : [...DEFAULT_OUTLOOK_FOLDERS];
}

function invalid(res: ConnectorResponse, what: string): PageResult {
  return { ok: false, response: { ...res, class: "challenge", body: null, error: `unexpected ${what} response` } };
}

function stopWith(res: ConnectorResponse, what: string): ConnectorResponse {
  return { ...res, class: "challenge", body: null, error: `unexpected ${what} response` };
}

/** A Graph date literal: whole seconds, UTC. */
function graphDate(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

type ConversationOutcome =
  | { kind: "item"; item: SyncItem }
  | { kind: "gone" }
  | { kind: "old" }
  | { kind: "stop"; response: ConnectorResponse };

interface ResolvedFolders {
  ids: Map<string, string>;
  folders: ConversationFolders;
}

class Adapter implements SyncAdapter {
  private resolved: ResolvedFolders | null = null;

  constructor(
    private readonly account: SyncAccount,
    private readonly now: () => number,
    private readonly env: NodeJS.ProcessEnv,
    private readonly engine: Engine | null,
  ) {}

  /** The stored conversations whose last version rendered `messageId` (normally one). */
  private async storedConversationsOf(messageId: string): Promise<string[]> {
    if (this.engine === null) return [];
    const r = await this.engine.query<{ external_id: string }>(
      `SELECT external_id FROM connector_items
        WHERE account_id = $1 AND deleted_upstream_at IS NULL AND external_version IS NOT NULL
          AND strpos(external_version, $2) > 0
        ORDER BY external_id LIMIT 5`,
      [this.account.id, `${outlookMessageRef(messageId)}`],
    );
    return r.rows.map(row => row.external_id);
  }

  streams(): string[] {
    return (this.account.services ?? []).includes(OUTLOOK_MAIL_SERVICE) ? outlookFolders(this.account).map(outlookMailStream) : [];
  }

  private windowLow(): number {
    const days = configInt(this.account, "history_days", 1, MAX_HISTORY_DAYS) ?? DEFAULT_OUTLOOK_HISTORY_DAYS;
    const keep = retentionDays("mail", configInt(this.account, "retention_days", 0, 100_000), this.env);
    return this.now() - (keep === null ? days : Math.min(days, keep)) * DAY_MS;
  }

  /** Conversations per batch: never more than one run, or one day under the item cap, may store. */
  private batch(): number {
    const n = Number((this.env.MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN ?? "").trim());
    const daily = this.account.itemCapDaily > 0 ? this.account.itemCapDaily : OUTLOOK_BATCH;
    return Math.min(OUTLOOK_BATCH, daily, Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ITEMS_PER_RUN);
  }

  private prefer(textBody = false): string {
    return preferHeader({ maxPageSize: textBody ? CONVERSATION_PAGE_SIZE : this.batch(), textBody, immutableIds: true });
  }

  /** Every synced folder's id, once per run; a folder the mailbox lacks (no Archive) is left out. */
  private async folders(client: ConnectorClient): Promise<ResolvedFolders | ConnectorResponse> {
    if (this.resolved !== null) return this.resolved;
    const ids = new Map<string, string>();
    for (const name of outlookFolders(this.account)) {
      const res = await graphGet(client, `${API}/mailFolders/${name}?$select=id`, { prefer: this.prefer() });
      if (res.status === 404) continue;
      if (res.class !== "ok") return res;
      const id = isRecord(res.body) ? str(res.body.id) : null;
      if (id === null) return stopWith(res, "mail folder");
      ids.set(name, id);
    }
    const sent = ids.get(SENT_FOLDER);
    this.resolved = { ids, folders: { included: new Set(ids.values()), sent: new Set(sent === undefined ? [] : [sent]), floorMs: null } };
    return this.resolved;
  }

  private initialPath(folder: string): string {
    const filter = encodeURIComponent(`receivedDateTime ge ${graphDate(this.windowLow())}`);
    return `${API}/mailFolders/${folder}/messages/delta?$select=${DELTA_SELECT}&$filter=${filter}`;
  }

  private backfillPath(folder: string, floorMs: number): string {
    const filter = encodeURIComponent(`receivedDateTime ge ${graphDate(floorMs)}`);
    return `${API}/mailFolders/${folder}/messages?$select=conversationId&$filter=${filter}&$top=${BACKFILL_PAGE}`;
  }

  /** Of `ids`, the conversations this account has not stored. */
  private async notStored(ids: readonly string[]): Promise<string[]> {
    if (this.engine === null || ids.length === 0) return [...ids];
    const r = await this.engine.query<{ external_id: string }>(
      `SELECT external_id FROM connector_items WHERE account_id = $1 AND deleted_upstream_at IS NULL AND external_id = ANY($2::text[])`,
      [this.account.id, [...ids]],
    );
    const stored = new Set(r.rows.map(row => row.external_id));
    return ids.filter(id => !stored.has(id));
  }

  /** One page of the backfill listing: queue the conversations it names that are not stored yet. */
  private async backfillPage(client: ConnectorClient, st: OutlookMailCursor & { backfill: string }, folders: ConversationFolders): Promise<PageResult> {
    const res = await graphGet(client, st.backfill, { prefer: preferHeader({ immutableIds: true }) });
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || !Array.isArray(res.body.value) || res.body.value.length > BACKFILL_PAGE) return invalid(res, "messages list");
    const rawNext = res.body["@odata.nextLink"];
    const next = rawNext === undefined ? null : graphLinkPath(rawNext);
    if (rawNext !== undefined && next === null) return invalid(res, "messages list next link");
    const ids = [...new Set((res.body.value as unknown[]).map(m => (isRecord(m) ? str(m.conversationId) : null)).filter((c): c is string => c !== null))];
    const { backfill: _done, ...rest } = st;
    const after: OutlookMailCursor = next === null ? rest : { ...rest, backfill: next };
    const pending: OutlookMailPending = { conversations: await this.notStored(ids), removed: [], link: st.link!, linkKind: st.linkKind! };
    return this.drain(client, after, pending, folders);
  }

  async page({ client, stream, cursor, page }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    if (!stream.startsWith(STREAM_PREFIX)) throw new Error(`outlook mail adapter has no stream ${stream}`);
    const folder = stream.slice(STREAM_PREFIX.length);
    if (!outlookFolders(this.account).includes(folder)) throw new Error(`outlook mail adapter has no stream ${stream}`);
    const resolved = await this.folders(client);
    if (!("ids" in resolved)) return { ok: false, response: resolved };
    if (!resolved.ids.has(folder)) return { ok: true, items: [], checkpoint: null, done: true };

    const st: OutlookMailCursor = parseOutlookMailCursor(cursor) ?? { v: 1, floorMs: this.windowLow(), link: null, linkKind: null, pending: null };
    const folders: ConversationFolders = { ...resolved.folders, floorMs: st.floorMs };
    if (st.pending !== null) return this.drain(client, st, st.pending, folders);
    if (st.backfill !== undefined && st.link !== null) return this.backfillPage(client, { ...st, backfill: st.backfill }, folders);
    // One delta round per run: the round that just ended is not asked again.
    if (st.linkKind === "delta" && page > 0) return { ok: true, items: [], checkpoint: JSON.stringify(st), done: true };

    const res = await graphGet(client, st.link ?? this.initialPath(folder), { prefer: this.prefer() });
    if (isSyncStateLost(res)) {
      // Graph dropped the round's state: a new first round over the window.
      if (st.link === null) return { ok: false, response: res };
      return { ok: true, items: [], checkpoint: JSON.stringify({ ...st, link: null, linkKind: null, pending: null }), done: false };
    }
    if (res.class !== "ok") return { ok: false, response: res };
    if (!isRecord(res.body) || !Array.isArray(res.body.value) || res.body.value.length > MAX_DELTA_ENTRIES) return invalid(res, "messages delta");
    const next = graphLinkPath(res.body["@odata.nextLink"]);
    const delta = graphLinkPath(res.body["@odata.deltaLink"]);
    if ((next === null) === (delta === null)) return invalid(res, "messages delta (no single next or delta link)");

    const conversations = new Set<string>();
    const removed = new Set<string>();
    for (const entry of res.body.value) {
      if (!isRecord(entry)) continue;
      const id = str(entry.id);
      if (entry["@removed"] !== undefined) {
        if (id !== null) removed.add(id);
        continue;
      }
      const conv = str(entry.conversationId);
      if (conv !== null) conversations.add(conv);
    }
    const pending: OutlookMailPending = { conversations: [...conversations], removed: [...removed], link: (next ?? delta)!, linkKind: next !== null ? "next" : "delta" };
    // A round that starts over the window is a first round; its end hands over to the backfill.
    const { firstRound: _first, backfill: _old, ...base } = st;
    const first = st.link === null || st.firstRound === true;
    const round: OutlookMailCursor = !first ? base : next !== null ? { ...base, firstRound: true } : { ...base, backfill: this.backfillPath(folder, Math.max(st.floorMs, this.windowLow())) };
    return this.drain(client, round, pending, folders);
  }

  /** Look the removed messages up, then read up to one batch of conversations. */
  private async drain(client: ConnectorClient, st: OutlookMailCursor, start: OutlookMailPending, folders: ConversationFolders): Promise<PageResult> {
    const queue = [...start.conversations];
    for (const id of start.removed) {
      const res = await graphGet(client, `${API}/messages/${encodeURIComponent(id)}?$select=conversationId`, { prefer: this.prefer() });
      if (res.status === 404) {
        // Purged: Graph no longer names its conversation, the stored items still do.
        for (const conv of await this.storedConversationsOf(id)) if (!queue.includes(conv)) queue.unshift(conv);
        continue;
      }
      if (res.class !== "ok") return { ok: false, response: res };
      const conv = isRecord(res.body) ? str(res.body.conversationId) : null;
      if (conv !== null && !queue.includes(conv)) queue.unshift(conv);
    }
    const take = queue.slice(0, this.batch());
    const rest = queue.slice(take.length);
    const items: SyncItem[] = [];
    const deletions: string[] = [];
    for (const conv of take) {
      const out = await this.readConversation(client, conv, folders);
      if (out.kind === "stop") return { ok: false, response: out.response };
      if (out.kind === "gone") deletions.push(conv);
      if (out.kind === "item") items.push(out.item);
    }
    if (rest.length > 0) {
      const pending: OutlookMailPending = { ...start, conversations: rest, removed: [] };
      return { ok: true, items, deletions, checkpoint: JSON.stringify({ ...st, pending }), done: false };
    }
    const after: OutlookMailCursor = { ...st, link: start.link, linkKind: start.linkKind, pending: null };
    return { ok: true, items, deletions, checkpoint: JSON.stringify(after), done: start.linkKind === "delta" && after.backfill === undefined };
  }

  private conversationPath(conversationId: string): string {
    const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
    return `${API}/messages?$filter=${filter}&$select=${MESSAGE_SELECT}&$expand=${encodeURIComponent(ATTACHMENT_EXPAND)}&$top=${CONVERSATION_PAGE_SIZE}`;
  }

  private async readConversation(client: ConnectorClient, conversationId: string, folders: ConversationFolders): Promise<ConversationOutcome> {
    const tooLarge = (): ConversationOutcome => ({
      kind: "item",
      item: { externalId: conversationId, version: null, failure: { code: "too_large", message: `the conversation is larger than ${OUTLOOK_MAIL_MAX_CONVERSATION_BYTES / (1024 * 1024)} MiB and was not read`, holdNow: true } },
    });
    const messages: unknown[] = [];
    let budget = OUTLOOK_MAIL_MAX_CONVERSATION_BYTES;
    let path: string | null = this.conversationPath(conversationId);
    for (let pageNo = 0; path !== null; pageNo++) {
      if (pageNo >= MAX_CONVERSATION_PAGES || budget <= 0) return tooLarge();
      const res = await graphGet(client, path, { prefer: this.prefer(true), maxBytes: budget });
      if (res.tooLarge === true) return tooLarge();
      if (res.class !== "ok") return { kind: "stop", response: res };
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { kind: "stop", response: stopWith(res, "conversation") };
      // An unreadable message must not read as a gone conversation: that would delete its page.
      if (res.body.value.some(m => !isRecord(m) || str(m.id) === null)) return { kind: "stop", response: stopWith(res, "conversation") };
      budget -= Buffer.byteLength(JSON.stringify(res.body.value));
      messages.push(...res.body.value);
      const nextRaw = res.body["@odata.nextLink"];
      path = nextRaw === undefined ? null : graphLinkPath(nextRaw);
      if (nextRaw !== undefined && path === null) return { kind: "stop", response: stopWith(res, "conversation (next link)") };
    }
    const normalized = normalizeOutlookConversation(conversationId, messages, folders);
    if (normalized === null) return { kind: "gone" };
    if (normalized.newestMs < this.windowLow()) return { kind: "old" };
    const label = this.account.accountLabel ?? "";
    const ctx: ConnectorContext = { service: "outlook_mail", accountLabel: label, ownAddresses: ownAddresses(label, this.account.config) };
    try {
      return { kind: "item", item: syncItemFromPage(renderMailThread(ctx, normalized.thread), normalized.version, { enrich: true }) };
    } catch (e) {
      // The message can quote mail text; only the error's kind is kept.
      return { kind: "item", item: { externalId: conversationId, version: normalized.version, failure: { code: "render_failed", message: `the conversation could not be rendered (${e instanceof Error ? e.name : "error"})` } } };
    }
  }
}

export function outlookMailAdapter(account: SyncAccount, opts: Partial<AdapterContext> = {}): SyncAdapter {
  return new Adapter(account, opts.now ?? Date.now, opts.env ?? process.env, opts.engine ?? null);
}
