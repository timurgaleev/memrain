/**
 * The Slack Web API methods the connector reads, over the fixed-origin
 * connector client (https://slack.com, bot token in the Authorization header
 * only, never in a query string).
 *
 * Slack answers application errors inside HTTP 200 bodies (`ok: false` with
 * an `error` code). `slackGet` turns them into the client's response classes:
 * a token Slack no longer accepts is `auth_required` with `reauth` (only the
 * owner can fix it), a missing scope or a refusal is `forbidden`, `ratelimited`
 * is `rate_limited`, and a channel the bot cannot read (not invited, or not
 * found) is reported apart so the run can hold that one channel and go on. An
 * HTTP 429 never gets here: the client waits out its Retry-After up to its cap
 * and reports `rate_limited` past it.
 */
import type { ConnectorClient, ConnectorResponse } from "../client.ts";

export const SLACK_API_ORIGIN = "https://slack.com";
/** Messages per history or replies page, Slack's documented maximum. */
const PAGE_LIMIT = 200;
/** Cursor pages one listing may walk: 25 pages of 200, 5,000 messages. */
const MAX_PAGES = 25;
/** Channels the picker lists, at most. */
const MAX_CHANNELS = 2000;

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type"]);
const DENIED_ERRORS = new Set(["missing_scope", "access_denied", "no_permission", "team_access_not_granted", "ekm_access_denied", "org_login_required"]);
const CHANNEL_ERRORS = new Set(["not_in_channel", "channel_not_found"]);
const ERROR_CODE_RE = /^[a-z_]{1,64}$/;

export type SlackResult<T> =
  | {
    ok: true;
    body: T;
    /** A listing that stopped at MAX_PAGES with more left: the body holds part of it. */
    capped?: true;
  }
  | {
    ok: false;
    response: ConnectorResponse;
    /** Slack's own error code, when it answered `ok: false`. */
    slackError?: string;
    channelUnavailable?: "not_in_channel" | "channel_not_found";
  };

function failed(cls: ConnectorResponse["class"], error: string, extra: Partial<ConnectorResponse> = {}): ConnectorResponse {
  return { class: cls, status: 200, body: null, next: null, error, ...extra };
}

/** One GET of a Web API method, its `ok: false` mapped onto the client's classes. */
export async function slackGet<T>(client: ConnectorClient, method: string, params: Record<string, string>): Promise<SlackResult<T>> {
  const res = await client.get(`/api/${method}?${new URLSearchParams(params).toString()}`, { maxBytes: 16 * 1024 * 1024 });
  if (res.class !== "ok") return { ok: false, response: res };
  const body = res.body as { ok?: unknown; error?: unknown; needed?: unknown } | null;
  if (body?.ok === true) return { ok: true, body: body as T };
  const raw = typeof body?.error === "string" ? body.error : "";
  // Slack's codes are lower-case words; anything else is not echoed.
  const code = ERROR_CODE_RE.test(raw) ? raw : "unknown_error";
  if (AUTH_ERRORS.has(code)) {
    return { ok: false, slackError: code, response: failed("auth_required", `slack refused the token (${code}); reconnect the account`, { status: 401, reauth: true }) };
  }
  if (DENIED_ERRORS.has(code)) {
    const needed = typeof body?.needed === "string" && /^[a-z:._,]{1,200}$/.test(body.needed) ? ` (needs ${body.needed})` : "";
    return { ok: false, slackError: code, response: failed("forbidden", `slack refused ${method} (${code})${needed}`, { status: 403 }) };
  }
  if (CHANNEL_ERRORS.has(code)) {
    return { ok: false, slackError: code, response: failed("forbidden", `slack ${method}: ${code}`, { status: 403 }), channelUnavailable: code as "not_in_channel" | "channel_not_found" };
  }
  if (code === "ratelimited") return { ok: false, slackError: code, response: failed("rate_limited", `slack rate limited ${method}`, { status: 429 }) };
  return { ok: false, slackError: code, response: failed("server_error", `slack ${method} failed (${code})`) };
}

/** A message as conversations.history and conversations.replies list it (the fields the connector reads). */
export interface SlackApiMessage {
  ts: string;
  type?: string;
  subtype?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { ts?: string };
  files?: Array<{ name?: string; title?: string }>;
  bot_id?: string;
  bot_profile?: { name?: string };
  username?: string;
}

export interface SlackChannelInfo {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
  /** A direct or group-direct conversation: never synced. */
  isDirect: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const TS_RE = /^\d{1,12}\.\d{1,9}$/;

/**
 * Every page of a cursor listing. Past MAX_PAGES a listing fails, unless
 * `capped` keeps what those pages held: a channel day or thread that long is
 * stored in part rather than failing on every run and holding its cursor.
 */
async function paged<T>(client: ConnectorClient, method: string, params: Record<string, string>, field: string, capped = false): Promise<SlackResult<T[]>> {
  const out: T[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await slackGet<Record<string, unknown> & { response_metadata?: { next_cursor?: unknown } }>(
      client, method, { ...params, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
    if (!res.ok) return res;
    const items = res.body[field];
    if (!Array.isArray(items)) return { ok: false, response: failed("challenge", `slack ${method} answered without ${field}`) };
    out.push(...items as T[]);
    const next = res.body.response_metadata?.next_cursor;
    cursor = typeof next === "string" ? next : "";
    if (cursor === "") return { ok: true, body: out };
  }
  if (capped) return { ok: true, body: out, capped: true };
  return { ok: false, response: failed("challenge", `slack ${method} listed more than ${MAX_PAGES} pages`) };
}

function messages(res: SlackResult<SlackApiMessage[]>, method: string): SlackResult<SlackApiMessage[]> {
  if (!res.ok) return res;
  // A message without a timestamp is a changed API, not something to store half of.
  if (res.body.some(m => typeof m?.ts !== "string" || !TS_RE.test(m.ts))) {
    return { ok: false, response: failed("challenge", `slack ${method} listed a message without a timestamp`) };
  }
  return res;
}

export async function conversationInfo(client: ConnectorClient, channel: string): Promise<SlackResult<SlackChannelInfo>> {
  const res = await slackGet<{ channel?: Record<string, unknown> }>(client, "conversations.info", { channel });
  if (!res.ok) return res;
  const raw = res.body.channel;
  const id = str(raw?.id);
  if (!raw || id === null) return { ok: false, response: failed("challenge", "slack conversations.info answered without a channel") };
  return {
    ok: true,
    body: {
      id,
      name: str(raw.name) ?? id,
      isPrivate: raw.is_private === true,
      // Slack leaves is_member out for a channel the bot cannot see into; only an explicit false means "not invited".
      isMember: raw.is_member !== false,
      isArchived: raw.is_archived === true,
      isDirect: raw.is_im === true || raw.is_mpim === true,
    },
  };
}

/** Top-level messages with oldest <= ts < latest (epoch seconds), oldest first; past MAX_PAGES, the newest that many pages hold. */
export async function channelHistory(client: ConnectorClient, channel: string, oldest: number, latest: number): Promise<SlackResult<SlackApiMessage[]>> {
  const res = messages(await paged<SlackApiMessage>(client, "conversations.history",
    { channel, oldest: oldest.toFixed(6), latest: latest.toFixed(6), inclusive: "true" }, "messages", true), "conversations.history");
  if (!res.ok) return res;
  const at = (m: SlackApiMessage) => Number(m.ts);
  const body = res.body.filter(m => at(m) >= oldest && at(m) < latest).sort((a, b) => at(a) - at(b));
  return { ok: true, body, ...(res.capped ? { capped: true as const } : {}) };
}

/** A thread's replies, oldest first, without its parent; past MAX_PAGES, the oldest that many pages hold. */
export async function threadReplies(client: ConnectorClient, channel: string, threadTs: string): Promise<SlackResult<SlackApiMessage[]>> {
  const res = messages(await paged<SlackApiMessage>(client, "conversations.replies", { channel, ts: threadTs }, "messages", true), "conversations.replies");
  if (!res.ok) return res;
  const body = res.body.filter(m => m.ts !== threadTs).sort((a, b) => Number(a.ts) - Number(b.ts));
  return { ok: true, body, ...(res.capped ? { capped: true as const } : {}) };
}

export interface SlackUser {
  name: string;
  bot: boolean;
  deleted: boolean;
}

/** One user's display name; a user Slack no longer knows is null, never an error. */
export async function userInfo(client: ConnectorClient, user: string): Promise<SlackResult<SlackUser | null>> {
  const res = await slackGet<{ user?: Record<string, unknown> }>(client, "users.info", { user });
  if (!res.ok) {
    if (res.slackError === "user_not_found") return { ok: true, body: null };
    return res;
  }
  const u = res.body.user;
  if (!u) return { ok: true, body: null };
  const profile = (u.profile ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    body: {
      name: str(profile.real_name) ?? str(u.real_name) ?? str(profile.display_name) ?? str(u.name) ?? user,
      bot: u.is_bot === true,
      deleted: u.deleted === true,
    },
  };
}

export interface SlackChannelEntry {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/**
 * The channels the bot can list, for the channel picker: public ones, and
 * private ones it was invited to when `includePrivate`. Archived channels and
 * direct messages are left out.
 */
export async function listChannels(client: ConnectorClient, includePrivate: boolean): Promise<SlackResult<SlackChannelEntry[]>> {
  const res = await paged<Record<string, unknown>>(client, "conversations.list",
    { types: includePrivate ? "public_channel,private_channel" : "public_channel", exclude_archived: "true" }, "channels");
  if (!res.ok) return res;
  const out: SlackChannelEntry[] = [];
  for (const c of res.body) {
    const id = str(c?.id);
    if (id === null || c.is_archived === true || c.is_im === true || c.is_mpim === true) continue;
    out.push({ id, name: str(c.name) ?? id, isPrivate: c.is_private === true, isMember: c.is_member === true });
    if (out.length >= MAX_CHANNELS) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, body: out };
}
