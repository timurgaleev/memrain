/**
 * A fake Slack workspace for connector tests: the OAuth v2 token exchange,
 * auth.test, auth.revoke and the Web API methods the Slack adapter and the
 * channel picker read, shaped after the documented responses (HTTP 200 with
 * `ok: false` for application errors). Nothing leaves the process; every
 * request is recorded so a test can assert what was asked.
 *
 * Tokens are assembled at runtime so no token-shaped literal sits in the tree.
 */
import type { FetchFn } from "../../src/core/connectors/client.ts";

type Json = Record<string, unknown>;

export const SLACK_BOT_TOKEN = ["xoxb", "fake", "bot", "token", "for", "tests"].join("-");
export const SLACK_TEAM = { id: "T0FAKETEAM", name: "Example Team" };
export const SLACK_PUBLIC_SCOPE = "channels:history,channels:read,users:read";

export interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { ts: string };
  bot_id?: string;
  files?: Array<{ name?: string }>;
}

export interface SlackChannel {
  name: string;
  is_private?: boolean;
  is_member?: boolean;
}

export interface SlackCall {
  method: string;
  params: URLSearchParams;
  authorization: string | null;
}

export interface SlackWorld {
  channels: Record<string, SlackChannel>;
  /** Top-level messages per channel, as conversations.history lists them. */
  messages: Record<string, SlackMessage[]>;
  /** Replies per `<channel>:<parent ts>`, without the parent. */
  replies?: Record<string, SlackMessage[]>;
  users?: Record<string, { name: string; real_name?: string; is_bot?: boolean; deleted?: boolean }>;
  /** The `scope` the token exchange grants, and auth.test reports in X-OAuth-Scopes. */
  scope?: string;
  /** Answer this method with HTTP 429 and this Retry-After (seconds): `times` times, or every time. */
  rateLimit?: { method: string; retryAfter: string; times?: number };
  /** Answer this many conversations.history reads of a channel's UTC day (YYYY-MM-DD) with an empty, successful page. */
  blankHistory?: { channel: string; day: string; times: number };
  /** List conversations.history this many messages a page, with a next_cursor, instead of all at once. */
  historyPageSize?: number;
  calls: SlackCall[];
}

/** A Slack timestamp for an ISO instant, with a sequence number so two messages never share one. */
export function slackTs(isoTime: string, seq = 0): string {
  return `${Math.floor(Date.parse(isoTime) / 1000)}.${String(seq).padStart(6, "0")}`;
}

function ok(body: Json, headers?: Record<string, string>): Response {
  return Response.json({ ok: true, ...body }, headers ? { headers } : undefined);
}

function fail(error: string): Response {
  return Response.json({ ok: false, error });
}

function window(messages: readonly SlackMessage[], q: URLSearchParams): SlackMessage[] {
  const oldest = Number(q.get("oldest") ?? "0");
  const latest = Number(q.get("latest") ?? `${Number.MAX_SAFE_INTEGER}`);
  // Newest first, as Slack lists history.
  return messages.filter(m => Number(m.ts) >= oldest && Number(m.ts) <= latest).sort((a, b) => Number(b.ts) - Number(a.ts));
}

export function slackFetch(world: SlackWorld): FetchFn {
  return async (raw, init) => {
    const url = new URL(raw);
    const authorization = new Headers(init.headers).get("authorization");
    const form = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    const method = url.pathname.replace(/^\/api\//, "");
    const params = new URLSearchParams(url.searchParams);
    for (const [k, v] of form ?? []) params.set(k, v);
    world.calls.push({ method, params, authorization });
    if (url.origin !== "https://slack.com") return new Response("not found", { status: 404 });

    if (method === "oauth.v2.access") {
      if (params.get("code") !== "fake-slack-code") return fail("invalid_code");
      // An app that has not opted into PKCE in its settings (the setup guide never asks for it).
      if (params.has("code_verifier")) return fail("pkce_not_allowed");
      return ok({
        access_token: SLACK_BOT_TOKEN, token_type: "bot", scope: world.scope ?? SLACK_PUBLIC_SCOPE,
        bot_user_id: "UBOTFAKE01", app_id: "AFAKEAPP01", team: SLACK_TEAM, enterprise: null,
        authed_user: { id: "UOWNER0001" },
      });
    }
    if (authorization !== `Bearer ${SLACK_BOT_TOKEN}`) return fail("invalid_auth");
    const limit = world.rateLimit;
    if (limit?.method === method && (limit.times === undefined || limit.times-- > 0)) {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "retry-after": limit.retryAfter } });
    }
    const scopes = { "x-oauth-scopes": world.scope ?? SLACK_PUBLIC_SCOPE };
    switch (method) {
      case "auth.test":
        return ok({ url: "https://example-team.slack.com/", team: SLACK_TEAM.name, team_id: SLACK_TEAM.id, user: "memrain", user_id: "UBOTFAKE01", bot_id: "BFAKEBOT01" }, scopes);
      case "auth.revoke":
        return ok({ revoked: true });
      case "conversations.info": {
        const id = params.get("channel") ?? "";
        const ch = world.channels[id];
        if (!ch) return fail("channel_not_found");
        return ok({ channel: { id, name: ch.name, is_channel: true, is_private: ch.is_private === true, is_member: ch.is_member !== false, is_archived: false } });
      }
      case "conversations.list": {
        const types = (params.get("types") ?? "public_channel").split(",");
        const channels = Object.entries(world.channels)
          .filter(([, c]) => types.includes(c.is_private ? "private_channel" : "public_channel"))
          .map(([id, c]) => ({ id, name: c.name, is_private: c.is_private === true, is_member: c.is_member !== false, is_archived: false, num_members: 3 }));
        return ok({ channels, response_metadata: { next_cursor: "" } });
      }
      case "conversations.history": {
        const id = params.get("channel") ?? "";
        const ch = world.channels[id];
        if (!ch) return fail("channel_not_found");
        if (ch.is_member === false) return fail("not_in_channel");
        const blank = world.blankHistory;
        const dayStart = Date.parse(`${blank?.day}T00:00:00Z`) / 1000;
        if (blank?.channel === id && Number(params.get("oldest")) === dayStart && blank.times-- > 0) return ok({ messages: [], has_more: false, response_metadata: { next_cursor: "" } });
        const listed = window(world.messages[id] ?? [], params);
        const size = world.historyPageSize;
        if (size === undefined) return ok({ messages: listed, has_more: false, response_metadata: { next_cursor: "" } });
        const from = Number(params.get("cursor") || "0");
        const next = from + size < listed.length ? String(from + size) : "";
        return ok({ messages: listed.slice(from, from + size), has_more: next !== "", response_metadata: { next_cursor: next } });
      }
      case "conversations.replies": {
        const id = params.get("channel") ?? "";
        const ts = params.get("ts") ?? "";
        const parent = (world.messages[id] ?? []).find(m => m.ts === ts);
        if (!parent) return fail("thread_not_found");
        return ok({ messages: [parent, ...(world.replies?.[`${id}:${ts}`] ?? [])], has_more: false, response_metadata: { next_cursor: "" } });
      }
      case "users.info": {
        const id = params.get("user") ?? "";
        const u = world.users?.[id];
        if (!u) return fail("user_not_found");
        return ok({ user: { id, name: u.name, real_name: u.real_name ?? u.name, deleted: u.deleted === true, is_bot: u.is_bot === true, profile: { display_name: u.name, real_name: u.real_name ?? u.name } } });
      }
      default:
        return fail("unknown_method");
    }
  };
}

/** The Web API methods a recorded run called, in order, with their channel when they named one. */
export function slackCalls(world: SlackWorld, method: string): URLSearchParams[] {
  return world.calls.filter(c => c.method === method).map(c => c.params);
}

export type { Json };
