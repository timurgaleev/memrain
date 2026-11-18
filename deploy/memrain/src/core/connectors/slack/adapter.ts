/**
 * The Slack adapter: each channel on the account's allowlist
 * (`config.channels`) is one stream, stored as one page per channel per UTC
 * day through the shared chat renderer.
 *
 *   - A stream's cursor is the last day whose read finished
 *     (`{"v":1,"through":"YYYY-MM-DD"}`). A run starts SLACK_LOOKBACK_DAYS
 *     before it, so edits, deletions and new replies to recent threads
 *     converge, and reads each day up to today with one
 *     `conversations.history` window per day. The first sync starts
 *     `config.history_days` (default 14) days back.
 *   - A day's version is its fingerprint (text.ts) and the UTC day its
 *     threads were last read. A day whose version equals the one its stored
 *     page settled at costs that one history read: its threads are not read
 *     and nothing is written. A changed day, and once a day every day in the
 *     lookback, reads `conversations.replies` for its threads and is rendered
 *     again whole, so an edited or deleted thread reply (which leaves the
 *     top-level messages as they were) converges within a day.
 *   - A stored day with no messages left upstream is reported deleted; the
 *     engine soft-deletes its page past the mass-delete guard.
 *   - User names come from `users.info`, cached per account for a day in this
 *     process, so a run asks once per person at most.
 *   - A channel the bot cannot read (not invited, not found), a private
 *     channel the account was not granted, and a direct conversation are each
 *     held as one failing item for the channel, so the other channels still
 *     sync; the hold is cleared once the channel reads again.
 *   - A channel taken off the allowlist is simply not read: its pages stay.
 *   - Slack's rate limits are the connector client's: a 429 is waited out up
 *     to its cap, past it the run ends partial and resumes from the cursor.
 *
 * Coverage limit: a reply to a thread that started before the lookback is not
 * seen unless it was also sent to the channel.
 */
import type { Engine } from "../../engine/interface.ts";
import type { ConnectorClient, ConnectorResponse } from "../client.ts";
import { renderChatDay } from "../render.ts";
import { syncItemFromPage } from "../sync-item.ts";
import { settledItemVersions } from "../sync-store.ts";
import type { ItemBudget, PageResult, SyncAccount, SyncAdapter, SyncItem } from "../sync-engine.ts";
import { channelHistory, conversationInfo, threadReplies, userInfo, type SlackApiMessage, type SlackChannelInfo, type SlackResult, type SlackUser } from "./api.ts";
import { addDays, dayFingerprint, dayStartSec, isDay, skippedMessage, toChatDay, userIds, utcDay } from "./text.ts";

export const SLACK_SERVICE = "slack";
export const SLACK_PRIVATE_SERVICE = "slack_private";
/** Days before the last finished one that every run reads again. */
export const SLACK_LOOKBACK_DAYS = 3;
export const DEFAULT_SLACK_HISTORY_DAYS = 14;
export const MAX_SLACK_HISTORY_DAYS = 365;
export const MAX_SLACK_CHANNELS = 100;
/** Days one page call reads, at most; the engine commits the cursor after each. */
const DAYS_PER_PAGE = 7;
const CHANNEL_ID_RE = /^[CG][A-Z0-9]{2,30}$/;
const USER_CACHE_TTL_MS = 86_400_000;
const USER_CACHE_MAX = 5000;

export function slackStream(channelId: string): string {
  return `slack:${channelId}`;
}

export function isSlackChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_RE.test(value);
}

/** The allowlist as stored: valid channel ids, each once, at most MAX_SLACK_CHANNELS. */
export function selectedChannels(account: Pick<SyncAccount, "config">): string[] {
  const raw = account.config?.["channels"];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isSlackChannelId))].slice(0, MAX_SLACK_CHANNELS);
}

export function slackHistoryDays(account: Pick<SyncAccount, "config">): number {
  const v = account.config?.["history_days"];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_SLACK_HISTORY_DAYS ? v : DEFAULT_SLACK_HISTORY_DAYS;
}

export function parseSlackCursor(raw: string | null): { through: string } | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { v?: unknown; through?: unknown };
    return v?.v === 1 && isDay(v.through) ? { through: v.through } : null;
  } catch {
    return null;
  }
}

const dayItemId = (channel: string, day: string) => `${channel}:${day}`;
/** The item a channel the run cannot read is held under. */
export const channelAccessItemId = (channel: string) => `${channel}:access`;

/** Names per `<account>:<user>`, shared by the runs of this process. */
const userCache = new Map<string, { user: SlackUser | null; at: number }>();

export function _resetSlackUserCacheForTesting(): void {
  userCache.clear();
}

interface AdapterOptions {
  now?: () => number;
  engine?: Engine;
}

class Adapter implements SyncAdapter {
  private readonly infos = new Map<string, SlackChannelInfo>();

  constructor(private readonly account: SyncAccount, private readonly now: () => number, private readonly engine: Engine | null) {}

  streams(account: SyncAccount): string[] {
    return selectedChannels(account).map(slackStream);
  }

  async page(ctx: { client: ConnectorClient; account: SyncAccount; stream: string; cursor: string | null; page: number; budget?: ItemBudget }): Promise<PageResult> {
    const channelId = ctx.stream.slice("slack:".length);
    const info = await this.channel(ctx.client, channelId);
    if ("failure" in info) return info.failure;

    const today = utcDay(this.now());
    const parsed = parseSlackCursor(ctx.cursor);
    const through = parsed === null ? null : parsed.through > today ? today : parsed.through;
    const start = through === null
      ? addDays(today, 1 - slackHistoryDays(this.account))
      : ctx.page === 0 ? addDays(through, -SLACK_LOOKBACK_DAYS) : addDays(through, 1);
    const days: string[] = [];
    for (let d = start; d <= today && days.length < DAYS_PER_PAGE; d = addDays(d, 1)) days.push(d);
    if (days.length === 0) return { ok: true, items: [], checkpoint: null, done: true };

    const settled = this.engine === null ? new Map<string, string>()
      : await settledItemVersions(this.engine, this.account.id, days.map(d => dayItemId(channelId, d)));
    const remaining = ctx.budget?.remaining ?? Number.POSITIVE_INFINITY;
    const items: SyncItem[] = [];
    const deletions: string[] = [];
    let last: string | null = null;
    for (const day of days) {
      if (items.length >= remaining) break;
      const history = await channelHistory(ctx.client, channelId, dayStartSec(day), dayStartSec(addDays(day, 1)));
      if (!history.ok) {
        if (history.channelUnavailable) return this.unavailable(channelId, history.channelUnavailable);
        return { ok: false, response: history.response };
      }
      const id = dayItemId(channelId, day);
      const messages = history.body.filter(m => !skippedMessage(m));
      if (messages.length === 0) {
        if (settled.has(id)) deletions.push(id);
        last = day;
        continue;
      }
      const version = `${dayFingerprint(info, messages)}@${today}`;
      if (settled.get(id) !== version) {
        const item = await this.renderDay(ctx.client, info, day, messages, version);
        if ("response" in item) return item;
        items.push(item);
      }
      last = day;
    }
    return {
      ok: true,
      items,
      deletions,
      checkpoint: last === null ? null : JSON.stringify({ v: 1, through: last }),
      done: last === today,
    };
  }

  /** The channel's info, once per run; a channel that cannot be synced is one held failure. */
  private async channel(client: ConnectorClient, channelId: string): Promise<SlackChannelInfo | { failure: PageResult }> {
    const known = this.infos.get(channelId);
    if (known) return known;
    const res = await conversationInfo(client, channelId);
    if (!res.ok) {
      if (res.channelUnavailable) return { failure: this.unavailable(channelId, res.channelUnavailable) };
      return { failure: { ok: false, response: res.response } };
    }
    const info = res.body;
    if (info.isDirect) return { failure: this.unavailable(channelId, "direct_conversation") };
    if (info.isPrivate && !(this.account.services ?? []).includes(SLACK_PRIVATE_SERVICE)) {
      return { failure: this.unavailable(channelId, "private_channel_not_granted") };
    }
    if (!info.isMember) return { failure: this.unavailable(channelId, "not_in_channel") };
    await this.clearAccessHold(channelId);
    this.infos.set(channelId, info);
    return info;
  }

  private unavailable(channelId: string, code: string): PageResult {
    const message = {
      not_in_channel: "the bot is not in this channel; invite it there with /invite @<your app>",
      channel_not_found: "Slack does not find this channel; it was deleted, or it is private and the bot was not invited",
      private_channel_not_granted: "this channel is private; reconnect with private channels ticked to read it",
      direct_conversation: "direct messages are not synced",
    }[code] ?? code;
    // Held at once: nothing changes until the owner acts, and the other channels go on.
    return {
      ok: true,
      items: [{ externalId: channelAccessItemId(channelId), version: code, failure: { code: `slack_${code}`, message, holdNow: true } }],
      checkpoint: null,
      done: true,
    };
  }

  /** A channel that reads again lets go of the hold its earlier failure left. */
  private async clearAccessHold(channelId: string): Promise<void> {
    if (this.engine === null) return;
    await this.engine.query(
      `DELETE FROM connector_items WHERE account_id = $1 AND external_id = $2 AND page_slug IS NULL`,
      [this.account.id, channelAccessItemId(channelId)],
    );
  }

  private async renderDay(client: ConnectorClient, info: SlackChannelInfo, day: string, messages: SlackApiMessage[], version: string): Promise<SyncItem | { ok: false; response: ConnectorResponse }> {
    const replies = new Map<string, SlackApiMessage[]>();
    for (const m of messages) {
      if ((m.reply_count ?? 0) === 0 || m.subtype === "thread_broadcast") continue;
      const res = await threadReplies(client, info.id, m.ts);
      if (!res.ok) return { ok: false, response: res.response };
      replies.set(m.ts, res.body);
    }
    const users = await this.users(client, userIds([...messages, ...[...replies.values()].flat()]));
    if (!users.ok) return { ok: false, response: users.response };
    const id = dayItemId(info.id, day);
    try {
      const page = renderChatDay(
        { service: "slack", accountLabel: this.account.accountLabel ?? "" },
        toChatDay(this.account.accountLabel ?? "", info, day, messages, replies, users.body),
      );
      return syncItemFromPage(page, version, { enrich: true });
    } catch (e) {
      return { externalId: id, version, failure: { code: "render_failed", message: e instanceof Error ? e.message.slice(0, 200) : "render failed" } };
    }
  }

  private async users(client: ConnectorClient, ids: readonly string[]): Promise<SlackResult<Map<string, SlackUser>>> {
    const out = new Map<string, SlackUser>();
    const now = this.now();
    for (const id of ids) {
      const key = `${this.account.id}:${id}`;
      const hit = userCache.get(key);
      if (hit && now - hit.at < USER_CACHE_TTL_MS) {
        if (hit.user) out.set(id, hit.user);
        continue;
      }
      const res = await userInfo(client, id);
      if (!res.ok) return res;
      if (userCache.size >= USER_CACHE_MAX) userCache.delete(userCache.keys().next().value!);
      userCache.set(key, { user: res.body, at: now });
      if (res.body) out.set(id, res.body);
    }
    return { ok: true, body: out };
  }
}

export function slackAdapter(account: SyncAccount, opts: AdapterOptions = {}): SyncAdapter {
  return new Adapter(account, opts.now ?? Date.now, opts.engine ?? null);
}
