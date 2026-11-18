/**
 * Slack messages into the connector model's ChatDay: one channel, one UTC
 * day, top-level messages with their thread replies. Slack's mrkdwn entities
 * become plain text (mentions by name, channel names, link labels with their
 * target, the three HTML escapes); everything else stays as the author wrote
 * it and is framed as outside text by the shared chat renderer.
 *
 * A day's fingerprint covers what can change its page short of a reply edit:
 * each top-level message's text, edit stamp, subtype, author, files and
 * thread size and latest reply. An unchanged fingerprint means the day is
 * not rebuilt, so its threads are never read.
 */
import { createHash } from "node:crypto";
import type { ChatDay, ChatMessage } from "../model.ts";
import type { SlackApiMessage, SlackChannelInfo, SlackUser } from "./api.ts";

/** Bumped when the page a day renders to changes, so every day in the lookback is rebuilt once. */
const RENDER_VERSION = 1;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Join and leave notices: noise, never a turn. */
const SKIPPED_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);

export function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The UTC day (YYYY-MM-DD) of an instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

/** Epoch seconds at the start of a UTC day. */
export function dayStartSec(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

export function skippedMessage(m: SlackApiMessage): boolean {
  return m.subtype !== undefined && SKIPPED_SUBTYPES.has(m.subtype);
}

/**
 * Slack mrkdwn entities to plain text: user mentions by name, channel and
 * group names, special mentions, and links as `label (target)`; then the three
 * escapes Slack applies to `<`, `>` and `&`. One pass over each `<...>`.
 */
export function slackText(text: string, userName: (id: string) => string): string {
  return text.replace(/<([^<>]{1,2000})>/g, (_whole, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar >= 0 ? inner.slice(0, bar) : inner;
    const label = bar >= 0 ? inner.slice(bar + 1) : null;
    if (target.startsWith("@")) return `@${label ?? userName(target.slice(1))}`;
    if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
    if (target.startsWith("!subteam^")) return label ?? "@group";
    if (target.startsWith("!date^")) return label ?? "";
    if (target.startsWith("!")) return `@${label ?? target.slice(1)}`;
    if (label === null || label === target || label === target.replace(/^mailto:/, "")) return label ?? target;
    return `${label} (${target})`;
  }).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const MENTION_RE = /<@([UW][A-Z0-9]{1,30})(?:\|[^>]*)?>/g;

/** Every user id a set of messages names: their authors and the people they mention. */
export function userIds(messages: readonly SlackApiMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user) ids.add(m.user);
    for (const match of (m.text ?? "").matchAll(MENTION_RE)) ids.add(match[1]!);
  }
  return [...ids];
}

export function dayFingerprint(channel: SlackChannelInfo, messages: readonly SlackApiMessage[]): string {
  const rows = messages.map(m => [
    m.ts, m.subtype ?? "", m.user ?? "", m.text ?? "", m.edited?.ts ?? "", m.reply_count ?? 0, m.latest_reply ?? "",
    (m.files ?? []).map(f => f.name ?? f.title ?? ""), m.bot_profile?.name ?? m.username ?? "",
  ]);
  return createHash("sha256").update(JSON.stringify([RENDER_VERSION, channel.name, channel.isPrivate, rows])).digest("hex").slice(0, 32);
}

function tsIso(ts: string): string {
  return new Date(Math.round(Number(ts) * 1000)).toISOString();
}

function chatMessage(m: SlackApiMessage, users: ReadonlyMap<string, SlackUser>, threadId: string | null): ChatMessage {
  const user = m.user ? users.get(m.user) : undefined;
  const bot = user?.bot === true || (!m.user && m.bot_id !== undefined);
  const name = m.user ? user?.name ?? m.user : m.bot_profile?.name ?? m.username ?? m.bot_id ?? "Unknown";
  const userName = (id: string) => users.get(id)?.name ?? id;
  const files = (m.files ?? []).map(f => `[file: ${(f.name ?? f.title ?? "attachment").replace(/[[\]]/g, " ")}]`);
  const text = m.subtype === "tombstone"
    ? "(message deleted)"
    : [slackText(m.text ?? "", userName), ...files].filter(s => s !== "").join("\n");
  return {
    id: m.ts,
    author: { name: `${name}${user?.deleted ? " (deactivated)" : ""}${bot ? " (bot)" : ""}`, email: null },
    ts: tsIso(m.ts),
    text: m.edited ? `${text} (edited)` : text,
    threadId,
    ...(bot ? { bot: true } : {}),
  };
}

/**
 * One channel day: the day's top-level messages and, after each thread's
 * parent, the replies to it (a reply posted on a later day stays with its
 * thread). A reply also sent to the channel is listed once, where the channel
 * shows it.
 */
export function toChatDay(
  workspace: string,
  channel: SlackChannelInfo,
  day: string,
  messages: readonly SlackApiMessage[],
  replies: ReadonlyMap<string, readonly SlackApiMessage[]>,
  users: ReadonlyMap<string, SlackUser>,
): ChatDay {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (skippedMessage(m)) continue;
    const broadcast = m.subtype === "thread_broadcast";
    out.push(chatMessage(m, users, broadcast ? m.thread_ts ?? null : null));
    if (broadcast) continue;
    for (const r of replies.get(m.ts) ?? []) {
      if (r.subtype === "thread_broadcast" || skippedMessage(r)) continue;
      out.push(chatMessage(r, users, m.ts));
    }
  }
  return { workspace, channelId: channel.id, channelName: channel.name, day, messages: out };
}
