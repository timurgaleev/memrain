/**
 * The Teams chat adapter: the signed-in user's own 1:1, group and meeting
 * chats (delegated Chat.Read; channel messages are not read), one page per
 * chat and UTC day, drawn by the shared chat-day renderer (render.ts).
 *
 * Graph facts relied on (learn.microsoft.com/graph/api/chat-list and
 * chat-list-messages, v1.0):
 *   - `GET /me/chats` lists the user's chats, at most 50 a page, and expands
 *     `lastMessagePreview`, whose `createdDateTime` says when the chat last
 *     had a new message;
 *   - `GET /chats/{id}/messages` pages a chat's messages, at most 50 a page,
 *     ordered by `lastModifiedDateTime` or `createdDateTime`, descending only;
 *     a `$filter` applies only together with an `$orderby` on the same
 *     property: `lastModifiedDateTime gt|lt`, `createdDateTime lt`.
 *
 * One stream holds the whole account. Its cursor keeps, per chat, a
 * watermark: the newest `lastModifiedDateTime` Graph reported for it. A
 * round lists the chats and queues those whose last message is newer than
 * their watermark (or, with none, newer than the history floor); a list
 * longer than one page's cap carries on from its next link on the following
 * page. Each queued chat is then handled in two steps:
 *
 *   1. detect: the messages modified after the watermark, newest first, name
 *      the days that changed: a new message, an edit, a deletion. On the
 *      first sync the newest message alone fixes the watermark, before any
 *      backfill, so nothing modified during the backfill is missed, and
 *      every day back to the floor is rendered. Past MAX_DETECT_PAGES of
 *      changes, every day back to the floor is rendered again.
 *   2. walk: the messages by creation time, newest first, down to the start
 *      of the oldest changed day. A day is rendered once the walk has seen a
 *      message older than it, so a day page always holds the whole day (a
 *      single day is read on past MAX_WALK_PAGES, up to MAX_DAY_PAGES); a
 *      changed day left with no message is deleted.
 *
 * The watermark moves only when a chat's walk is through. A walk cut short
 * by the run's item budget or MAX_WALK_PAGES keeps `hi`, the start of the
 * oldest day it stored, and the next page resumes with `createdDateTime lt
 * hi`; no message text is ever kept in the cursor.
 *
 * An edit or a deletion is seen when the chat next gets a message, since the
 * listing only shows the last one's time. A chat Graph will not show (left,
 * removed: 403 or 404) is one held item, not a stopped run; a refused chat
 * list stops the run as forbidden with the permission named.
 *
 * Everything in a message is outside text: meeting credentials (join links,
 * passcodes) are removed (meeting-redact.ts) before the shared renderer
 * secret-scans and neutralizes it.
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { redactMeetingCredentials } from "../meeting-redact.ts";
import { htmlToText, renderChatDay } from "../render.ts";
import { retentionDays } from "../retention.ts";
import { syncItemFromPage } from "../sync-item.ts";
import { PROVIDER_USER_ID, shortHash, type ChatMessage, type ConnectorContext } from "../model.ts";
import type { ItemBudget, PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import type { AdapterContext } from "../providers.ts";
import { graphGet, graphLinkPath, isGraphPath } from "./graph-client.ts";

/** The account service this adapter syncs. */
export const TEAMS_CHAT_SERVICE = "teams_chat";
export const TEAMS_CHAT_STREAM = "teams_chats";
/** How far back the first sync reads, unless the account's `history_days` says otherwise. */
export const TEAMS_HISTORY_DAYS = 30;
export const TEAMS_MAX_HISTORY_DAYS = 365;

/** Graph's largest `$top` for chats and chat messages. */
const PAGE_SIZE = 50;
const MAX_CHAT_LIST_PAGES = 20;
const MAX_DETECT_PAGES = 10;
const MAX_WALK_PAGES = 20;
/** A single UTC day is read whole up to this many pages (10,000 messages). */
const MAX_DAY_PAGES = 200;
/** Chats queued in one round; the rest wait for the next round. */
const MAX_QUEUE = 500;
const MAX_ID_CHARS = 512;
const MAX_TOPIC_CHARS = 200;
const GRAPH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[0-9a-f]{16}$/;

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** A Graph timestamp in ms; NaN when it is not one. */
function timeMs(v: unknown): number {
  return typeof v === "string" && v.length <= 64 ? Date.parse(v) : Number.NaN;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function dayOf(ms: number): string {
  return isoOf(ms).slice(0, 10);
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

export function chatKey(chatId: string): string {
  return shortHash(`tchat:${chatId}`);
}

// ---------------------------------------------------------------------------
// Message text.

const EMOJI_RE = /<emoji\b[^>]{0,500}?\salt="([^"<>]{0,40})"[^>]{0,500}>(?:<\/emoji>)?/gi;
const MENTION_RE = /<\/?at\b[^>]{0,200}>/gi;
const ATTACHMENT_RE = /<attachment\b[^>]{0,500}>(?:<\/attachment>)?/gi;

/**
 * A message body as text. HTML goes through the shared converter after
 * Teams' own tags: a mention keeps its name, an emoji its alt text and an
 * attachment (a file, a card, a quoted reply) becomes a marker; the file or
 * card itself is never fetched. Meeting credentials are removed.
 */
export function teamsMessageText(body: unknown): string {
  if (!isRecord(body)) return "";
  const content = typeof body.content === "string" ? body.content : "";
  const text = body.contentType === "html"
    ? htmlToText(content.replace(EMOJI_RE, "$1").replace(MENTION_RE, "").replace(ATTACHMENT_RE, " [attachment]"))
    : content;
  return redactMeetingCredentials(text).text.trim();
}

// ---------------------------------------------------------------------------
// The cursor.

/** A chat waiting in the current round. */
export interface QueuedChat {
  id: string;
  /** `oneOnOne`, `group` or `meeting`. */
  type: string;
  topic: string | null;
  detected: boolean;
  /** The watermark to commit once the chat is through. */
  mark: string | null;
  /** Days whose page is rendered again; null for every day down to `lo`. */
  days: string[] | null;
  /** Start of the oldest day the walk goes down to. */
  lo: string | null;
  /** Where a cut walk resumes: `createdDateTime lt hi`. */
  hi: string | null;
}

export interface TeamsChatState {
  v: 1;
  /** Where the first sync's history began. */
  floor: string;
  /** Per chat (chatKey): the newest lastModifiedDateTime stored. */
  marks: Record<string, string>;
  queue: QueuedChat[];
  /** The chat list's next page while a round is still listing; null once the list is through. */
  listing: string | null;
}

function isoOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : undefined;
}

function parseQueued(raw: unknown): QueuedChat | null {
  if (!isRecord(raw)) return null;
  const { id, type, topic, detected, days } = raw;
  const mark = isoOrNull(raw.mark);
  const lo = isoOrNull(raw.lo);
  const hi = isoOrNull(raw.hi);
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_CHARS || typeof type !== "string" || type.length > 32) return null;
  if (topic !== null && (typeof topic !== "string" || topic.length > MAX_TOPIC_CHARS)) return null;
  if (typeof detected !== "boolean" || mark === undefined || lo === undefined || hi === undefined) return null;
  if (days !== null && (!Array.isArray(days) || days.length > TEAMS_MAX_HISTORY_DAYS + 1 || !days.every(d => typeof d === "string" && DAY_RE.test(d)))) return null;
  if (detected && lo === null && (days === null || days.length > 0)) return null;
  return { id, type, topic: topic as string | null, detected, mark, days: days as string[] | null, lo, hi };
}

/** The stored cursor as a state; null for none, or for one this version cannot read. */
export function parseTeamsChatCursor(cursor: string | null): TeamsChatState | null {
  if (cursor === null || !cursor.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1 || typeof isoOrNull(raw.floor) !== "string" || !isRecord(raw.marks) || !Array.isArray(raw.queue)) return null;
  const marks: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.marks)) {
    if (!KEY_RE.test(k) || typeof isoOrNull(v) !== "string") return null;
    marks[k] = v as string;
  }
  if (raw.queue.length > MAX_QUEUE) return null;
  const queue: QueuedChat[] = [];
  for (const q of raw.queue) {
    const parsed = parseQueued(q);
    if (parsed === null) return null;
    queue.push(parsed);
  }
  const listing = raw.listing ?? null;
  if (listing !== null && !isGraphPath(listing)) return null;
  return { v: 1, floor: raw.floor as string, marks, queue, listing };
}

// ---------------------------------------------------------------------------
// The adapter.

function configInt(account: SyncAccount, key: string, min: number, max: number): number | null {
  const v = account.config?.[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function invalid(res: ConnectorResponse, what: string): PageResult {
  return { ok: false, response: { ...res, class: "challenge", body: null, error: `unexpected ${what} response` } };
}

type Walked =
  | { items: SyncItem[]; deletions: string[]; finished: boolean; hi: string | null }
  | { response: ConnectorResponse };

class ChatAdapter implements SyncAdapter {
  constructor(private readonly account: SyncAccount, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv) {}

  streams(): string[] {
    return (this.account.services ?? []).includes(TEAMS_CHAT_SERVICE) ? [TEAMS_CHAT_STREAM] : [];
  }

  private retention(): number | null {
    return retentionDays("chat", configInt(this.account, "retention_days", 0, 100_000), this.env);
  }

  private historyDays(): number {
    const days = configInt(this.account, "history_days", 1, TEAMS_MAX_HISTORY_DAYS) ?? TEAMS_HISTORY_DAYS;
    const keep = this.retention();
    return keep === null ? days : Math.min(days, keep);
  }

  /** The earliest time anything is kept from: the first sync's floor, or retention's edge once later. */
  private floorMs(state: TeamsChatState): number {
    const keep = this.retention();
    const floor = Date.parse(state.floor);
    return keep === null ? floor : Math.max(floor, this.now() - keep * DAY_MS);
  }

  private selfId(): string | null {
    const v = this.account.config?.[PROVIDER_USER_ID];
    return typeof v === "string" && v !== "" ? v : null;
  }

  async page({ client, cursor, budget }: Parameters<SyncAdapter["page"]>[0]): Promise<PageResult> {
    const state = parseTeamsChatCursor(cursor)
      ?? { v: 1 as const, floor: isoOf(this.now() - this.historyDays() * DAY_MS), marks: {}, queue: [], listing: null };
    if (state.queue.length === 0 || state.listing !== null) {
      const listed = await this.listChats(client, state);
      if ("response" in listed) return { ok: false, response: listed.response };
      return { ok: true, items: [], checkpoint: JSON.stringify(listed), done: listed.listing === null && listed.queue.length === 0 };
    }
    const [head, ...rest] = state.queue as [QueuedChat, ...QueuedChat[]];
    const through = (chat: QueuedChat, items: SyncItem[], deletions: string[] = []): PageResult => {
      const marks = { ...state.marks };
      if (chat.mark !== null) marks[chatKey(chat.id)] = chat.mark;
      return { ok: true, items, deletions, checkpoint: JSON.stringify({ ...state, marks, queue: rest }), done: rest.length === 0 };
    };

    let chat = head;
    if (!chat.detected) {
      const res = await this.detect(client, chat, state);
      if ("response" in res) return this.chatFailed(res.response, chat, through);
      chat = res;
      if (chat.days !== null && chat.days.length === 0) return through(chat, []);
    }
    const walked = await this.walk(client, chat, budget);
    if ("response" in walked) return this.chatFailed(walked.response, chat, through);
    if (walked.finished) return through(chat, walked.items, walked.deletions);
    const queue = [{ ...chat, hi: walked.hi }, ...rest];
    return { ok: true, items: walked.items, deletions: walked.deletions, checkpoint: JSON.stringify({ ...state, queue }), done: false };
  }

  /**
   * A chat Graph will not show any more (403 or 404: the owner left it, or it
   * is gone) is one held item and leaves the queue; anything else ends the
   * run the way the engine reads it.
   */
  private chatFailed(res: ConnectorResponse, chat: QueuedChat, through: (c: QueuedChat, items: SyncItem[]) => PageResult): PageResult {
    if (res.class !== "forbidden" || res.status === 0) return res.class === "ok" ? invalid(res, "chat messages") : { ok: false, response: res };
    const item: SyncItem = {
      externalId: `chat:${chatKey(chat.id)}`,
      version: null,
      failure: { code: "chat_unavailable", message: `Graph did not show the chat's messages (HTTP ${res.status})`, holdNow: true },
    };
    // Asked again only once the chat has a newer message.
    return through({ ...chat, mark: isoOf(this.now()) }, [item]);
  }

  /**
   * Queue the chats with something new since their watermark, MAX_CHAT_LIST_PAGES
   * list pages per stream page: a longer list carries on from its next link on
   * the following page, so no chat past the cap is starved. A fresh round
   * prunes the watermarks older than the floor.
   */
  private async listChats(client: ConnectorClient, state: TeamsChatState): Promise<TeamsChatState | { response: ConnectorResponse }> {
    const floor = this.floorMs(state);
    const fresh = state.listing === null;
    const marks = fresh ? Object.fromEntries(Object.entries(state.marks).filter(([, m]) => Date.parse(m) >= floor)) : state.marks;
    const queue: QueuedChat[] = fresh ? [] : [...state.queue];
    const queued = new Set(queue.map(q => q.id));
    let path: string | null = state.listing ?? `/v1.0/me/chats?$expand=lastMessagePreview&$top=${PAGE_SIZE}`;
    for (let p = 0; p < MAX_CHAT_LIST_PAGES && path !== null && queue.length < MAX_QUEUE; p++) {
      const res = await graphGet(client, path, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") {
        if (res.class !== "forbidden") return { response: res };
        return {
          response: {
            ...res,
            error: `Microsoft Graph refused the Teams chat list (HTTP ${res.status}): the app needs the delegated permission Chat.Read, `
              + "consented for this account; see docs/connectors/MICROSOFT.md, Teams",
          },
        };
      }
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat list response" } };
      for (const c of (res.body.value as unknown[]).filter(isRecord)) {
        const id = str(c.id);
        if (id === null || id.length > MAX_ID_CHARS || queued.has(id)) continue;
        const last = timeMs(isRecord(c.lastMessagePreview) ? c.lastMessagePreview.createdDateTime : undefined);
        if (!Number.isFinite(last) || last < floor) continue;
        const mark = marks[chatKey(id)];
        if (mark !== undefined && last <= Date.parse(mark)) continue;
        // The topic is outside text that reaches the page's title: its meeting credentials go too.
        const topic = str(c.topic) === null ? null : str(redactMeetingCredentials(c.topic as string).text.trim());
        queue.push({
          id, type: (str(c.chatType) ?? "unknown").slice(0, 32), topic: topic === null ? null : topic.slice(0, MAX_TOPIC_CHARS),
          detected: false, mark: null, days: null, lo: null, hi: null,
        });
        queued.add(id);
        if (queue.length >= MAX_QUEUE) break;
      }
      const next = res.body["@odata.nextLink"];
      path = next === undefined ? null : graphLinkPath(next);
      if (next !== undefined && path === null) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat list next link" } };
    }
    // A full queue ends the round's listing; the chats left are queued by the next round.
    return { ...state, marks, queue, listing: queue.length >= MAX_QUEUE ? null : path };
  }

  /** Which days of a chat changed since its watermark, and the watermark to commit after. */
  private async detect(client: ConnectorClient, chat: QueuedChat, state: TeamsChatState): Promise<QueuedChat | { response: ConnectorResponse }> {
    const floor = this.floorMs(state);
    const base = `/v1.0/chats/${enc(chat.id)}/messages?$top=`;
    const order = `&$orderby=${enc("lastModifiedDateTime desc")}`;
    const since = state.marks[chatKey(chat.id)] ?? null;
    const everything = (mark: string | null): QueuedChat => ({ ...chat, detected: true, mark, days: null, lo: isoOf(dayStartMs(dayOf(floor))), hi: null });
    if (since === null) {
      const res = await graphGet(client, `${base}1${order}`, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") return { response: res };
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat messages response" } };
      const newest = (res.body.value as unknown[]).filter(isRecord)[0];
      const t = timeMs(newest?.lastModifiedDateTime);
      return everything(Number.isFinite(t) ? isoOf(t) : null);
    }
    let path: string | null = `${base}${PAGE_SIZE}${order}&$filter=${enc(`lastModifiedDateTime gt ${since}`)}`;
    let mark = Date.parse(since);
    const days = new Set<string>();
    for (let p = 0; path !== null; p++) {
      if (p >= MAX_DETECT_PAGES) return everything(isoOf(mark));
      const res = await graphGet(client, path, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") return { response: res };
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat messages response" } };
      for (const m of (res.body.value as unknown[]).filter(isRecord)) {
        const modified = timeMs(m.lastModifiedDateTime);
        if (Number.isFinite(modified) && modified > mark) mark = modified;
        const created = timeMs(m.createdDateTime);
        if (Number.isFinite(created) && created >= floor && created <= this.now() + DAY_MS) days.add(dayOf(created));
      }
      const next = res.body["@odata.nextLink"];
      path = next === undefined ? null : graphLinkPath(next);
      if (next !== undefined && path === null) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat messages next link" } };
    }
    const sorted = [...days].sort();
    return { ...chat, detected: true, mark: isoOf(mark), days: sorted, lo: sorted.length > 0 ? isoOf(dayStartMs(sorted[0]!)) : null, hi: null };
  }

  /** Walk the chat by creation time from `hi` (or its newest message) down to `lo`, rendering whole days. */
  private async walk(client: ConnectorClient, chat: QueuedChat, budget: ItemBudget | undefined): Promise<Walked> {
    const lo = Date.parse(chat.lo!);
    const order = `&$orderby=${enc("createdDateTime desc")}`;
    let path: string | null = `/v1.0/chats/${enc(chat.id)}/messages?$top=${PAGE_SIZE}${order}`
      + (chat.hi === null ? "" : `&$filter=${enc(`createdDateTime lt ${chat.hi}`)}`);
    const hiMs = chat.hi === null ? Number.POSITIVE_INFINITY : Date.parse(chat.hi);
    const byDay = new Map<string, Json[]>();
    let oldest = Number.POSITIVE_INFINITY;
    let ended = false;
    for (let p = 0; path !== null; p++) {
      // Past MAX_WALK_PAGES the walk stops at the first whole day it holds; a
      // single day longer than that is read on to its start, up to MAX_DAY_PAGES.
      if (p >= MAX_DAY_PAGES || (p >= MAX_WALK_PAGES && byDay.size >= 2)) break;
      const res = await graphGet(client, path, { maxBytes: GRAPH_MAX_RESPONSE_BYTES });
      if (res.class !== "ok") return { response: res };
      if (!isRecord(res.body) || !Array.isArray(res.body.value)) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat messages response" } };
      for (const m of (res.body.value as unknown[]).filter(isRecord)) {
        const created = timeMs(m.createdDateTime);
        if (!Number.isFinite(created) || created >= hiMs) continue;
        oldest = Math.min(oldest, created);
        if (created < lo) {
          ended = true;
          continue;
        }
        const day = dayOf(created);
        const list = byDay.get(day);
        if (list === undefined) byDay.set(day, [m]);
        else list.push(m);
      }
      if (ended) break;
      const next = res.body["@odata.nextLink"];
      if (next === undefined) {
        ended = true;
        break;
      }
      path = graphLinkPath(next);
      if (path === null) return { response: { ...res, class: "challenge", body: null, error: "unexpected chat messages next link" } };
    }

    // Pages that held nothing below `hi`: nothing more to read.
    if (!Number.isFinite(oldest)) ended = true;
    const seen = [...byDay.keys()].sort().reverse();
    let complete = ended ? seen : seen.filter(d => oldest < dayStartMs(d));
    // One day of more than MAX_DAY_PAGES pages: its newest messages are stored rather than none.
    if (!ended && complete.length === 0 && seen.length > 0) complete = [seen.at(-1)!];
    const wanted = chat.days === null ? complete : complete.filter(d => chat.days!.includes(d));
    const room = Math.max(1, budget?.remaining ?? Number.POSITIVE_INFINITY);
    const stored = wanted.slice(0, room);
    const cut = stored.length < wanted.length || !ended;
    // Every day at or above this boundary has been decided this page.
    const boundary = !cut ? lo : stored.length < wanted.length ? dayStartMs(stored.at(-1)!) : dayStartMs(complete.at(-1) ?? dayOf(oldest));

    const items: SyncItem[] = [];
    const deletions: string[] = [];
    for (const day of stored) {
      const item = this.renderDay(chat, day, byDay.get(day) ?? []);
      if (item === null) deletions.push(`${chat.id}:${day}`);
      else items.push(item);
    }
    // A changed day that has no message left: its page goes.
    for (const day of chat.days ?? []) {
      const at = dayStartMs(day);
      if (at >= boundary && at < hiMs && !byDay.has(day)) deletions.push(`${chat.id}:${day}`);
    }
    return { items, deletions, finished: !cut, hi: cut ? isoOf(boundary) : null };
  }

  private toMessage(m: Json, self: string | null): ChatMessage | null {
    if (m.messageType !== "message" || m.deletedDateTime !== null && m.deletedDateTime !== undefined) return null;
    const id = str(m.id);
    const created = timeMs(m.createdDateTime);
    if (id === null || !Number.isFinite(created)) return null;
    const text = teamsMessageText(m.body);
    if (text === "") return null;
    const from = isRecord(m.from) ? m.from : {};
    const userFrom = isRecord(from.user) ? from.user : null;
    const app = isRecord(from.application) ? from.application : null;
    const shown = str(userFrom?.displayName) ?? str(app?.displayName);
    // A display name is outside text too, and lands on the page.
    const name = shown === null ? null : str(redactMeetingCredentials(shown).text.trim());
    const authorId = str(userFrom?.id);
    return {
      id,
      author: { name, email: null },
      ts: isoOf(created),
      text,
      threadId: str(m.replyToId),
      ...(self === null ? {} : { fromSelf: authorId === self }),
      ...(app !== null && userFrom === null ? { bot: true } : {}),
    };
  }

  /** One chat day as a page, or null when no message of the day is left to show. */
  private renderDay(chat: QueuedChat, day: string, raw: Json[]): SyncItem | null {
    const self = this.selfId();
    const messages = raw.map(m => this.toMessage(m, self)).filter((m): m is ChatMessage => m !== null);
    if (messages.length === 0) return null;
    const others = [...new Set(messages.filter(m => m.fromSelf !== true && m.author.name !== null).map(m => m.author.name!))].sort();
    const name = chat.topic ?? (others.length > 0 ? others.slice(0, 3).join(", ") : "Teams chat");
    const version = shortHash([chat.topic ?? "", ...raw.map(m => `${str(m.id) ?? ""}@${str(m.lastModifiedDateTime) ?? ""}`).sort()].join("|"));
    const ctx: ConnectorContext = { service: TEAMS_CHAT_SERVICE, accountLabel: this.account.accountLabel ?? "" };
    try {
      const page = renderChatDay(ctx, {
        workspace: "teams", channelId: chat.id, channelName: name, day, messages, direct: chat.type === "oneOnOne" || chat.type === "group",
      });
      return syncItemFromPage(page, version, { enrich: true });
    } catch (e) {
      // The message can quote chat text; only the error's kind is kept.
      return { externalId: `${chat.id}:${day}`, version, failure: { code: "render_failed", message: `the chat day could not be rendered (${e instanceof Error ? e.name : "error"})` } };
    }
  }
}

export function teamsChatAdapter(account: SyncAccount, opts: Partial<AdapterContext> = {}): SyncAdapter {
  return new ChatAdapter(account, opts.now ?? Date.now, opts.env ?? process.env);
}
